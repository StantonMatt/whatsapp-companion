import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiKeyError, defaultAuto, type Status, type Scope, type Preferences, type Provider, type ModelsResult, type AutoPatch, type AutoPermission, type DirectStickerDisabledReason } from '../shared/model';
import { resolveSettings } from '../core/settings';
import { minimumStyleSamples, styleSamples } from '../core/style';
import { reasoningLevels, savedEffort } from '../core/model-policy';
import type { Act } from './index';
import { providerName, tagErrorMessage } from './sticker-tagging';
import { BackIcon, ChevronIcon } from './icons';

export function Settings({ status, act, close, initialTab = null }: { status: Status; act: Act; close: () => void; initialTab?: 'Providers' | null }) {
  const [tab, setTab] = useState<string | null>(initialTab);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (tab) back.current?.focus(); }, [tab]);
  const [aiPending, setAiPending] = useState<{ value: boolean; accepted: boolean } | null>(null);
  const savedAi = status.state.global.aiFeatures, ai = aiPending?.value ?? savedAi;
  useEffect(() => { if (aiPending?.accepted && aiPending.value === savedAi) setAiPending(null); }, [savedAi, aiPending]);
  useEffect(() => { if (!ai) setTab(null); }, [ai]);
  const changeAi = async (value: boolean) => {
    setAiPending({ value, accepted: false });
    const accepted = await act({ type: 'preferences', scope: 'global', patch: { aiFeatures: value } });
    setAiPending(accepted ? { value, accepted: true } : null);
  };
  const scope: Scope = status.panel === 'chat' && status.chat.settingsId ? status.chat.settingsId : 'global';
  const chat = status.panel === 'chat';
  const sections = chat ? ['Replies', 'Style', 'Auto replies'] : ['Replies', 'Providers', 'Style'];
  const descriptions: Record<string, string> = { Replies: 'Suggestions, tone and language', Providers: status.keys.openai || status.keys.anthropic ? 'API keys, model and reasoning' : 'Add an API key', Style: 'Your writing style', 'Auto replies': 'Permission and sending limits' };
  return <>
    <div className="panel-title"><button ref={back} data-preserve-auto="" aria-label={tab ? 'Back to settings' : 'Close panel'} onClick={() => tab ? setTab(null) : close()}><BackIcon/></button><h1>{ai && tab ? tab : chat ? 'Chat AI settings' : 'Settings'}</h1>{tab && <button className="close" data-preserve-auto="" aria-label="Close panel" onClick={close}>×</button>}</div>
    <div className="panel-body">
      {chat && !ai ? <div className="empty"><p>AI features are off</p><button onClick={() => void act({ type: 'panel', panel: 'settings' })}>Open settings</button></div> : !ai || !tab ? <>
        {!chat && <Toggle label="AI features" checked={ai} disabled={aiPending !== null} onChange={value => void changeAi(value)}/>}
        {ai && <>
        <p className="scope-line"><strong title={chat ? status.chat.name : undefined}>{chat ? status.chat.name : 'All conversations'}</strong>{chat && <span>{Object.keys(status.state.chats[scope] ?? {}).length ? 'Custom settings' : 'Uses global settings'}</span>}</p>
        <nav className="settings-list" aria-label="Settings sections">{sections.map(label => <button key={label} aria-label={label} onClick={() => setTab(label)}><span>{label}<small className={label === 'Providers' && !status.keys.openai && !status.keys.anthropic ? 'attention' : undefined}>{descriptions[label]}</small></span><ChevronIcon/></button>)}</nav>
        </>}
        {!chat && <DirectStickerSetting checked={status.state.global.directStickerSend} reason={status.state.global.directStickerDisabledReason} sequence={status.sequence} act={act}/>}
        {!chat && ai && <AutomaticStickerSetting status={status} act={act}/>}
        {chat && ai && <button className="reset-link" onClick={() => void act({ type: 'resetPreferences', scope })}>Reset all to global settings</button>}
      </> : tab === 'Replies' ? <ReplySettings status={status} act={act} scope={scope}/> : tab === 'Providers' ? <Providers status={status} act={act}/> : tab === 'Style' ? <StyleSettings key={status.chat.settingsId ?? 'no-chat'} status={status} act={act} scope={scope === 'global' ? 'general' : scope}/> : <AutoSettings status={status} act={act}/>}
      {!tab && !chat && <div className="footer-actions"><button className="quiet" onClick={() => void act({ type: 'reload' })}>Reload WhatsApp</button></div>}
    </div>
  </>;
}
function AutomaticStickerSetting({ status, act }: { status: Status; act: Act }) {
  const checked = status.state.global.automaticStickerTags;
  const [pending, setPending] = useState<{ value: boolean; revision: number; accepted: boolean } | null>(null);
  const changes = useRef({ value: checked, revision: 0, running: false });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (pending?.accepted && pending.value === checked) setPending(null);
  }, [checked, pending]);
  const change = async (value: boolean) => {
    const input = changes.current;
    input.value = value; input.revision++;
    setPending({ value, revision: input.revision, accepted: false });
    if (input.running) return;
    input.running = true;
    try {
      for (;;) {
        const { value, revision } = input;
        const accepted = await act({ type: 'preferences', scope: 'global', patch: { automaticStickerTags: value } });
        if (revision !== input.revision) {
          if (!accepted || input.value !== value) continue;
          // Coalesce a return to the in-flight value without sending it twice.
          if (mounted.current) setPending({ value, revision: input.revision, accepted: true });
          break;
        }
        if (mounted.current) setPending(accepted ? { value, revision, accepted: true } : null);
        break;
      }
    } finally { input.running = false; }
  };
  const value = pending?.value ?? checked;
  return <><Toggle label="Tag new stickers automatically" checked={value}
    note={value && status.stickerTagPause ? `Paused: ${tagErrorMessage(status.stickerTagPause, status.state.provider).replace(/\.$/, '')}` : undefined}
    onChange={value => void change(value)}/>
    <p className="hint">Sends new sticker images to {providerName(status.state.provider)}.</p>
  </>;
}
function DirectStickerSetting({ checked, reason, sequence, act }: { checked: boolean; reason?: DirectStickerDisabledReason; sequence: number; act: Act }) {
  const [pending, setPending] = useState<{ value: boolean; accepted: boolean; sequence: number } | null>(null);
  useEffect(() => {
    if (pending?.accepted && (pending.value === checked || (!checked && reason && sequence > pending.sequence))) setPending(null);
  }, [checked, reason, sequence, pending]);
  const change = async (directStickerSend: boolean) => {
    // React restores a controlled checkbox at the end of the click. Reflect
    // the request immediately while main persists and publishes the setting.
    setPending({ value: directStickerSend, accepted: false, sequence });
    const accepted = await act({ type: 'preferences', scope: 'global', patch: { directStickerSend } });
    setPending(accepted ? { value: directStickerSend, accepted: true, sequence } : null);
  };
  const reasons: Record<DirectStickerDisabledReason, string> = {
    'logged-out': 'WhatsApp logged out.', 'account-warning': 'WhatsApp showed an account warning.',
    'send-error': 'a direct send failed.', 'whatsapp-changed': 'WhatsApp changed.'
  };
  return <><Toggle label="Send stickers directly (experimental)" checked={pending?.value ?? checked}
    disabled={pending !== null} onChange={value => void change(value)}/>
    {!(pending?.value ?? checked) && reason && <p className="hint">Turned off automatically: {reasons[reason]}</p>}</>;
}
function ReplySettings({ status, act, scope }: { status: Status; act: Act; scope: Scope }) {
  const state = status.state;
  const result = resolveSettings(state, status.chat.kind, scope === 'global' ? null : scope);
  const values = result.values;
  const inherited = (key: keyof Preferences) => scope === 'global' ? undefined : result.sources[key] === 'conversation' ? 'Custom for this chat' : 'Use global setting';
  const patch = (value: Partial<Preferences>) => { void act({ type: 'preferences', scope, patch: value }); };
  return <>
    <Toggle label="Share recent conversation context" checked={values.shareContext} onChange={v => patch({ shareContext: v })} note={inherited('shareContext')}/>
    <p className="hint">When enabled, up to 30 loaded messages from the current chat go to your chosen provider for assistance, including attachment types and visible document filenames. File and image contents are excluded.</p>
    <Toggle label="Inline suggestions" checked={values.suggestions} onChange={v => patch({ suggestions: v })} note={inherited('suggestions')}/>
    
    <Choice label="Tone" value={values.tone} options={['natural', 'friendly', 'professional', 'direct']} note={inherited('tone')} onChange={v => patch({ tone: v as Preferences['tone'] })}/>
    <Choice label="Reply length" value={values.length} options={['brief', 'balanced', 'detailed']} note={inherited('length')} onChange={v => patch({ length: v as Preferences['length'] })}/>
    <Choice label="Emoji" value={values.emoji} options={['match', 'none', 'light']} note={inherited('emoji')} onChange={v => patch({ emoji: v as Preferences['emoji'] })}/>
    <TextSetting key={`${scope}-language-${values.language}`} label="Language" value={values.language} note={inherited('language')} save={value => act({ type: 'preferences', scope, patch: { language: value } })}/>
    <TextSetting key={`${scope}-instructions-${values.instructions}`} label="Custom instructions" value={values.instructions} multiline note={inherited('instructions')} save={value => act({ type: 'preferences', scope, patch: { instructions: value } })}/>
    <button onClick={() => void act({ type: 'resetPreferences', scope })}>{scope === 'global' ? 'Restore initial defaults' : 'Reset all to global settings'}</button>
  </>;
}
function Providers({ status, act }: { status: Status; act: Act }) {
  const [keyRevision, setKeyRevision] = useState(0);
  const provider = status.state.provider;
  return <>
    {!status.secureStorage && <div className="notice" role="alert">Can’t save keys because secure storage is unavailable.{navigator.platform.toLowerCase().includes('linux') ? ' Unlock KWallet or Secret Service.' : ''}<button onClick={() => void act({ type: 'checkSecureStorage' })}>Check again</button></div>}
    {(['openai', 'anthropic'] as const).map(p => <KeySlot key={p} provider={p} status={status} act={act} changed={() => setKeyRevision(value => value + 1)}/>)}
    {(status.keys.openai || status.keys.anthropic || status.fixture) && <div className="card">
      <label className="choice-setting"><span>Provider</span><select value={provider} onChange={e => { const p = e.target.value as Provider; void act({ type: 'provider', provider: p, model: status.state.models[p] }); }}>
        {(['openai', 'anthropic'] as const).map(p => <option key={p} value={p} disabled={!status.keys[p] && !status.fixture}>{providerName(p)}{!status.keys[p] && !status.fixture ? ' · no key' : ''}</option>)}
      </select></label>
      <ModelPicker key={`${provider}-${keyRevision}`} provider={provider} value={status.state.models[provider]} available={status.keys[provider] || status.fixture} act={act}/>
      <ReasoningSlider key={`${provider}-${status.state.models[provider]}`} status={status} act={act}/>
    </div>}
    <p className="hint">API usage is billed by your provider.</p>
  </>;
}
function KeySlot({ provider, status, act, changed }: { provider: Provider; status: Status; act: Act; changed(): void }) {
  const [text, setText] = useState(''), [replacing, setReplacing] = useState(false), [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<'saving' | 'testing' | 'removing' | null>(null);
  const [result, setResult] = useState<{ error?: string; message?: string }>({});
  const input = useRef<HTMLInputElement>(null), keep = useRef<HTMLButtonElement>(null), replace = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<'replace' | 'input' | null>(null);
  const mounted = useRef(true), pending = useRef(false);
  const keyRef = useCallback((node: HTMLInputElement | null) => {
    if (!node && input.current) input.current.value = '';
    input.current = node;
  }, []);
  const saved = status.keys[provider], name = providerName(provider), field = !saved || replacing;
  const model = status.state.models[provider];
  const currentModel = useRef(model); currentModel.current = model;
  useEffect(() => { setResult({}); }, [model, saved]);
  useEffect(() => { if (replacing) input.current?.focus(); }, [replacing]);
  useEffect(() => { if (confirm) keep.current?.focus(); }, [confirm]);
  useEffect(() => {
    const target = focusAfter.current === 'replace' && !field ? replace.current : focusAfter.current === 'input' && field ? input.current : null;
    if (!busy && target && !target.disabled) { target.focus(); focusAfter.current = null; }
  });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (input.current) input.current.value = ''; }; }, []);
  const cancel = () => { if (replacing) focusAfter.current = 'replace'; if (input.current) input.current.value = ''; setText(''); setReplacing(false); setResult({}); };
  const run = async (kind: 'saving' | 'testing' | 'removing') => {
    if (pending.current) return;
    if (kind === 'saving') {
      const error = apiKeyError(provider, text.trim());
      if (error) { setResult({ error }); input.current?.focus(); input.current?.select(); return; }
    }
    pending.current = true; setBusy(kind); setResult({});
    const action = kind === 'saving' ? { type: 'key' as const, provider, key: text.trim() }
      : kind === 'testing' ? { type: 'testProvider' as const, provider } : { type: 'deleteKey' as const, provider };
    let response: { error?: string; message?: string } = {};
    try {
      const ok = await act(action, result => { response = result; });
      if (!mounted.current || kind === 'testing' && currentModel.current !== model) return;
      if (ok) {
        if (kind === 'saving') { cancel(); focusAfter.current = 'replace'; if (saved) changed(); }
        if (kind === 'removing') { cancel(); focusAfter.current = 'input'; setConfirm(false); }
        if (kind === 'testing') setResult({ message: response.message ?? '✓ Connected' });
      } else { setResult({ error: response.error ?? (kind === 'saving' ? 'Couldn’t save the key. Try again.' : 'Provider connection check failed.') }); }
      if (!ok && kind === 'saving') requestAnimationFrame(() => { if (mounted.current) { input.current?.focus(); input.current?.select(); } });
    } finally { pending.current = false; if (mounted.current) setBusy(null); }
  };
  return <div className="key-slot" role="group" aria-label={`${name} API key`} onKeyDown={e => {
    if (e.key === 'Escape' && (confirm || replacing || text)) { e.preventDefault(); e.stopPropagation(); if (confirm) setConfirm(false); else if (!busy) cancel(); }
  }}>
    <div className="key-head">{field ? <label htmlFor={`key-${provider}`}>{name} API key</label> : <span className="key-name">{name} API key</span>}
      {!saved && <a className="key-link" href="#" onClick={e => { e.preventDefault(); void act({ type: 'getKey', provider }); }}>Get key</a>}
    </div>
    {field ? <div className="key-row"><input ref={keyRef} id={`key-${provider}`} type="password" autoComplete="off" spellCheck={false} autoCapitalize="off" placeholder={provider === 'openai' ? 'sk-…' : 'sk-ant-…'} value={text} disabled={!!busy || !status.secureStorage} readOnly={!!busy} aria-invalid={!!result.error || undefined}
      onChange={e => { setText(e.target.value); setResult({}); }} onPaste={e => { e.preventDefault(); setText(e.clipboardData.getData('text').trim()); setResult({}); }}
      onKeyDown={e => { if (e.key === 'Enter' && text.trim() && !busy && status.secureStorage) { e.preventDefault(); void run('saving'); } }}/>
      <button className="primary" disabled={!text.trim() || !!busy || !status.secureStorage} aria-busy={busy === 'saving' || undefined} onClick={() => void run('saving')}>{busy === 'saving' ? 'Saving…' : 'Save'}</button>
      {replacing && <button className="quiet" disabled={!!busy} onClick={cancel}>Cancel</button>}
    </div> : <>
      <div className="key-saved"><span className="dots" aria-hidden="true">••••••••••••••••••••••••</span><span className="saved">✓ Saved</span></div>
      {confirm ? <div className="actions confirm" role="group" aria-label={`Remove the ${name} key?`}><span>Remove the {name} key?</span><button className="primary" disabled={!!busy} onClick={() => void run('removing')}>Remove</button><button ref={keep} className="quiet" disabled={!!busy} onClick={() => setConfirm(false)}>Keep</button></div>
        : <div className="actions"><button disabled={!!busy} aria-busy={busy === 'testing' || undefined} onClick={() => void run('testing')}>{busy === 'testing' ? 'Testing…' : 'Test connection'}</button><button ref={replace} disabled={!!busy || !status.secureStorage} onClick={() => { setResult({}); setReplacing(true); }}>Replace</button><button className="quiet" disabled={!!busy} onClick={() => { setResult({}); setConfirm(true); }}>Remove</button></div>}
    </>}
    {result.error && <p className="key-status error" role="alert">{result.error}</p>}
    {result.message && <p className="key-status ok" role="status">{result.message}</p>}
  </div>;
}
function ModelPicker({ provider, value, available, act }: { provider: Provider; value: string; available: boolean; act: Act }) {
  const [result, setResult] = useState<ModelsResult>({ models: [] });
  const [loading, setLoading] = useState(available);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    setResult({ models: [] }); setLoading(available);
    if (available) void window.companion.models(provider, refresh > 0).then(next => {
      if (current) setResult(next.cancelled ? { models: [], error: 'Model list changed. Refresh to load it again.' } : next);
    }).catch(() => { if (current) setResult({ models: [], error: 'Unable to load models. Try refreshing.' }); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [provider, available, refresh]);
  const listed = result.models.some(model => model.id === value);
  const unlisted = available && !loading && !result.error && !listed;
  return <div className="model-setting">
    <label>Model ID<select value={unlisted ? '' : value} disabled={loading || !available || !result.models.length} aria-busy={loading} onChange={e => void act({ type: 'provider', provider, model: e.target.value })}>
      {!listed && <option disabled value={unlisted ? '' : value}>{unlisted ? 'Choose a current text model' : `${value} (saved)`}</option>}
      {result.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
    </select></label>
    <button disabled={loading || !available} onClick={() => setRefresh(value => value + 1)}>{loading ? 'Loading models…' : 'Refresh models'}</button>
    {result.error ? <p className="notice" role="alert">{result.error}</p>
      : !available ? <p className="hint">Add an API key to load available models.</p>
      : !loading && !result.models.length ? <p className="notice">No current text models available for this key.</p>
      : unlisted ? <p className="notice">Saved model: {value}. Choose a listed model to update it.</p> : null}
  </div>;
}
function ReasoningSlider({ status, act }: { status: Status; act: Act }) {
  const provider = status.state.provider, model = status.state.models[provider];
  const levels = reasoningLevels(provider, model), saved = savedEffort(status.state);
  const [value, setValue] = useState(saved);
  const currentSaved = useRef(saved), local = useRef({ value: saved, revision: 0, committed: 0, acknowledged: 0, pending: 0, dirty: false });
  currentSaved.current = saved;
  const sync = () => {
    const input = local.current;
    // A previous save's status must not replace newer input, even before keyup.
    if (input.committed === input.revision && input.value === currentSaved.current) input.acknowledged = input.revision;
    if (input.committed === input.revision && !input.pending && input.acknowledged === input.revision) input.dirty = false;
    if (!input.dirty) { input.value = currentSaved.current; setValue(input.value); }
  };
  useEffect(sync, [saved]);
  if (!levels.length || !value) return <p className="hint">Reasoning effort is not adjustable for this model.</p>;
  const label = (effort: string) => effort === 'xhigh' ? 'Extra high' : effort[0].toUpperCase() + effort.slice(1);
  const commit = async () => {
    const input = local.current, next = input.value, revision = input.revision;
    if (!next || input.committed === revision) return;
    input.committed = revision;
    input.pending++;
    const accepted = await act({ type: 'reasoning', provider, model, effort: next });
    input.pending--;
    if (!accepted && input.revision === revision) input.dirty = false;
    sync();
  };
  return <div className="reasoning-setting">
    <label><span className="range-label">Reasoning effort<output>{label(value)}</output></span>
      <input aria-label="Reasoning effort" type="range" min="0" max={levels.length - 1} step="1" value={levels.indexOf(value)} aria-valuetext={label(value)}
        onChange={e => { local.current.value = levels[Number(e.target.value)]; local.current.revision++; local.current.dirty = true; setValue(local.current.value); }}
        onPointerUp={() => void commit()} onKeyUp={() => void commit()} onBlur={() => void commit()}/>
      <span className="range-scale" aria-hidden="true"><span>{label(levels[0])}</span><span>{label(levels.at(-1)!)}</span></span>
    </label>
    <p className="hint">Higher effort can take longer and use more tokens.</p>
  </div>;
}
function StyleSettings({ status, act, scope }: { status: Status; act: Act; scope: string }) {
  const [examples, setExamples] = useState('');
  const [busy, setBusy] = useState(false);
  const global = scope === 'general', preferencesScope = global ? 'global' : scope;
  const { values, sources } = resolveSettings(status.state, status.chat.kind, global ? null : scope);
  const inherited = (key: keyof Preferences) => global ? undefined : sources[key] === 'conversation' ? 'Custom for this chat' : 'Use global setting';
  const profile = status.state.profiles[scope], generalProfile = status.state.profiles.general;
  const loaded = status.chat.loadedSentSamples ?? 0;
  const learn = async (examples: string) => {
    setBusy(true);
    try { if (await act({ type: 'learn', scope, examples, ...(!examples.trim() && status.chat.settingsId ? { sourceChatId: status.chat.settingsId } : {}) })) setExamples(''); }
    finally { setBusy(false); }
  };
  const stateText = values.style === 'off' ? 'Style matching is off.'
    : values.style === 'general' ? generalProfile ? 'Using your general style.' : 'No general style saved yet.'
    : global ? 'Each conversation uses its own writing style.'
    : profile ? 'Using the style saved for this chat.'
    : generalProfile ? 'No style learned for this chat yet. Using your general style for now.' : 'No style learned for this chat yet. Replies still use the conversation context you allow.';
  return <>
    <Choice label="Match my writing style" value={values.style} options={['off', 'general', 'conversation']} labels={{ general: 'General style', conversation: global ? 'Match each conversation' : 'This conversation' }} note={inherited('style')} onChange={style => void act({ type: 'preferences', scope: preferencesScope, patch: { style: style as Preferences['style'] } })}/>
    <p className="hint" role="status">{stateText}</p>
    {values.style === 'conversation' && <>
      <Toggle label="Learn automatically from my messages" checked={values.learnFromSent} note={inherited('learnFromSent')} onChange={learnFromSent => void act({ type: 'preferences', scope: preferencesScope, patch: { learnFromSent } })}/>
      <p className="hint">Learns from your sent messages as you open and scroll through chats. Each chat’s style stays separate.{profile && profile.source !== 'observed' && !global ? ' Your saved style is kept until you reset it.' : ''}</p>
    </>}
    {!global && values.style === 'general' ? <p className="hint">Edit your general style in Settings → Style.</p> : <>
      {global && <p className="hint">{values.style === 'conversation' ? 'A general style is optional and can help chats without their own style.' : 'Your general style can be used across conversations.'}</p>}
      <button className="primary" disabled={busy || !status.chat.ready || !status.chat.settingsId || loaded < minimumStyleSamples} onClick={() => void learn('')}>{global ? 'Learn general style from this chat' : 'Learn from this chat'}</button>
      <p className="hint" data-testid="style-history">{status.chat.ready ? `${loaded} sent message${loaded === 1 ? '' : 's'} loaded${loaded < minimumStyleSamples ? ` · ${minimumStyleSamples} needed` : ''}. Scroll up in WhatsApp to load older messages.` : 'Open a conversation to learn from your sent messages.'}</p>
      <p className="hint">Style learning runs on this computer and saves only writing habits.</p>
      {profile && <details className="style-details"><summary>View or edit saved style</summary>
        <p className="hint">{profile.samples} messages · {new Date(profile.updatedAt).toLocaleDateString()}</p>
        <TextSetting key={`${scope}-${profile.updatedAt}`} label="Writing traits" value={profile.description} multiline save={description => act({ type: 'profile', scope, description })}/>
        <button onClick={() => void act({ type: 'resetProfile', scope })}>{global ? 'Reset profile' : 'Reset profile and stop learning'}</button>
      </details>}
      <details className="style-details"><summary>Add examples manually</summary>
        <label>Selected examples<textarea rows={4} value={examples} maxLength={20000} onChange={e => setExamples(e.target.value)} placeholder="Five or more of your messages, one per line"/></label>
        <button disabled={busy || styleSamples(examples.split('\n')).length < minimumStyleSamples} onClick={() => void learn(examples)}>Learn from examples</button>
      </details>
    </>}
    {!global && <button className="quiet" onClick={() => void act({ type: 'resetStylePreferences', scope })}>Use global style settings</button>}
  </>;
}
function AutoSettings({ status, act }: { status: Status; act: Act }) {
  const id = status.chat.chatId;
  const saved = (id && status.state.auto[id]) || defaultAuto;
  const rules = status.runtimePaused ? { ...saved, paused: true } : saved;
  const patch = (change: AutoPatch) => { if (id) void act({ type: 'autoRules', chatId: id, patch: change }); };
  const permission = (value: AutoPermission) => { if (id) void act({ type: 'autoPermission', chatId: id, permission: value }); };
  if (!id || !status.chat.ready) return <p className="notice">Automatic sending is unavailable because this WhatsApp version hides the chat identifier. Your reply and style settings still apply to this conversation.</p>;
  return <>
    <Toggle preserveAuto label="Allow automatic replies in this chat" checked={rules.enabled} onChange={enabled => permission(enabled ? 'enable' : 'disable')}/>
    <p className="hint">Replies only to new text arriving in the open conversation while the latest messages are visible. Context sharing must be enabled. Changing chats, typing, clicking, or opening this panel cancels a queued reply. Restarting the app pauses sending.</p>
    {rules.enabled && <div className="notice">{rules.paused ? 'Paused after user activity' : 'Armed for the next incoming message'}<button data-preserve-auto="" onClick={() => permission(rules.paused ? 'resume' : 'pause')}>{rules.paused ? 'Resume' : 'Pause'}</button></div>}
    <div className="two-columns"><label>From hour<select value={rules.startHour} onChange={e => patch({ startHour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select></label><label>Until hour<select value={rules.endHour} onChange={e => patch({ endHour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select></label></div>
    <p className="hint">Local time. Matching hours mean all day; an end before the start crosses midnight.</p>
    <Choice label="Daily reply limit" value={String(rules.dailyLimit)} options={['1', '3', '5', '10', '20']} onChange={v => patch({ dailyLimit: Number(v) })}/>
    <Choice label="Minimum minutes between replies" value={String(rules.cooldownMinutes)} options={['1', '5', '10', '30', '60']} onChange={v => patch({ cooldownMinutes: Number(v) })}/>
    <Choice label="Cancellation window in seconds" value={String(rules.delaySeconds)} options={['15', '30', '60', '120']} onChange={v => patch({ delaySeconds: Number(v) })}/>
    <p className="hint">Attempts count toward limits, including unconfirmed submissions. Incoming messages and custom instructions cannot grant permission to send.</p>
  </>;
}
function Toggle({ label, checked, onChange, note, preserveAuto, disabled }: { label: string; checked: boolean; onChange: (value: boolean) => void; note?: string; preserveAuto?: boolean; disabled?: boolean }) {
  return <label className="toggle" data-preserve-auto={preserveAuto ? '' : undefined}><span>{label}{note && <small>{note}</small>}</span><input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)}/></label>;
}
function Choice({ label, value, options, onChange, note, labels }: { label: string; value: string; options: string[]; onChange: (value: string) => void; note?: string; labels?: Record<string, string> }) {
  const names: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', match: 'Match conversation', conversation: 'This conversation' };
  return <label className="choice-setting"><span>{label}{note && <small>{note}</small>}</span><select value={value} onChange={e => onChange(e.target.value)}>{options.map(option => <option key={option} value={option}>{labels?.[option] ?? names[option] ?? option[0].toUpperCase() + option.slice(1)}</option>)}</select></label>;
}
function TextSetting({ label, value, save, multiline, note }: { label: string; value: string; save: (value: string) => Promise<boolean>; multiline?: boolean; note?: string }) {
  const [text, setText] = useState(value);
  return <div className="text-setting"><label>{label}{note && <small>{note}</small>}{multiline ? <textarea rows={4} value={text} onChange={e => setText(e.target.value)}/> : <input value={text} onChange={e => setText(e.target.value)}/>}</label><button disabled={text === value} onClick={() => void save(text)}>Save</button></div>;
}
