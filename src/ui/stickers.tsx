import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Status, Sticker } from '../shared/model';
import type { StickerSend } from '../shared/sticker-transfer';
import { searchStickers } from '../core/stickers';
import type { Act } from './index';

const locationMessages = {
  looking: 'Looking in WhatsApp…',
  found: 'Highlighted in WhatsApp. Nothing was sent.',
  missing: 'This sticker isn’t loaded in WhatsApp. Open a chat and its sticker picker, select Favorites, then wait for it to load and try again.',
  unavailable: 'WhatsApp did not respond. Wait for it to finish loading, then try again.'
};
const noEditor = (send: StickerSend) => send.state === 'failed' && send.reason === 'editor-unavailable' && send.sent === 'not-sent';
const sendMessage = (send: StickerSend) => send.state === 'missing' ? 'WhatsApp doesn’t have the animated version loaded.'
  : send.reason === 'draft' && send.detail === 'draft-appeared' && send.sent === 'unknown' ? 'Couldn’t confirm the sticker was sent. Check the chat before sending again.'
  : send.reason === 'draft' ? 'Send or clear your draft first, then send the sticker.'
  : noEditor(send) ? 'WhatsApp didn’t open its sticker editor. Nothing was sent.'
  : send.sent === 'confirmed' ? 'Sticker sent.'
  : 'Couldn’t confirm the sticker was sent. Check the chat before sending it again.';
// Only these rows offer a new send: an animated miss (Send still) and a maker failure that sent nothing (Try again).
// A result that may have been sent never offers one.
const offer = (send: StickerSend) => send.state === 'missing' ? { label: 'Send still', primary: true, still: true }
  : noEditor(send) ? { label: 'Try again', primary: false, still: send.route === 'maker' && send.animated } : null;
const announcement = (send: StickerSend) => inFlight(send) ? 'Sending sticker…' : send.reason === 'draft' ? sendMessage(send) : ({
  sent: `Sent to ${send.name}`, missing: 'Animated version not loaded. Send still?', cancelled: 'Cancelled',
  failed: noEditor(send) ? 'WhatsApp didn’t open its sticker editor' : send.sent === 'confirmed' ? 'Sticker sent' : 'Couldn’t confirm the sticker was sent'
} as Record<StickerSend['state'], string>)[send.state];
const COLUMNS = 3;
const RESULT_MS = 1500;
const inFlight = (send: StickerSend | null) => send?.state === 'finding' || send?.state === 'preparing' || send?.state === 'sending';
// Before WhatsApp's own Send is clicked, the send can still be called off.
const cancellable = (send: StickerSend | null) => send?.state === 'finding' || send?.state === 'preparing';

const SendIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3.4 20.4 21.5 12 3.4 3.6v6.5L15.2 12 3.4 13.9z"/></svg>;
const EditIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" d="M4.5 19.5h3.8L19.1 8.7a2 2 0 0 0 0-2.8l-1-1a2 2 0 0 0-2.8 0L4.5 15.7z"/><path stroke="currentColor" strokeWidth="1.9" d="m13.8 6.4 3.8 3.8"/></svg>;
const CheckIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" d="m5.5 12.5 4.2 4.2 8.8-9.2"/></svg>;

type Editor = { id: string; prompt?: { next: string | null } };
type Draft = Editor & { text: string };
type FocusTarget = { id: string; button: 'send' | 'edit' | 'offer' } | 'search'
  | { id: string; field: 'textarea' | 'keep'; open?: boolean; scroll?: boolean };

export function Stickers({ status, act }: { status: Status; act: Act }) {
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  // Filtering may hide an editor without discarding its sticker's unsaved text.
  // Both states belong to this panel instance, so closing it discards all drafts.
  const [drafts, setDrafts] = useState(() => new Map<string, string>());
  const [local, setLocal] = useState<{ id: string; nonce: string; name: string } | null>(null);
  // A result left over from before the panel opened is not shown again.
  const [hidden, setHidden] = useState(() => status.stickerSend && !inFlight(status.stickerSend) ? status.stickerSend.nonce : null);
  const [flash, setFlash] = useState<string | null>(null);
  // The chat each send from this panel went to. A row offering a new send closes when the chat changes.
  const origin = useRef(new Map<string, Pick<Status['chat'], 'chatId' | 'settingsId' | 'name'>>());
  const grid = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const queryRevision = useRef(0);
  const editorSession = useRef(0);
  const saving = useRef(new Map<string, symbol>());
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const locating = useRef<{ id: string; source: Element | null; state: Status['stickerLocation'] } | null>(null);
  const all = status.state.stickers;
  // The order is fixed while the panel is open, so a send or lookup that updates lastSeen never moves a card from under the pointer.
  const rank = useMemo(() => new Map(searchStickers(all, '').map((s, i) => [s.id, i])), [query]);
  for (const sticker of searchStickers(all, '')) if (!rank.has(sticker.id)) rank.set(sticker.id, rank.size);
  const stickers = searchStickers(all, query).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const visible = useRef(new Set<string>()); visible.current = new Set(stickers.map(s => s.id));

  const live = status.stickerSend ?? null;
  // The card reacts in the same frame as the click, before the desktop process has chosen a route.
  const send: StickerSend | null = local && live?.nonce !== local.nonce ? { ...local, route: 'maker', animated: false, state: 'preparing' } : live;
  const destination = send && origin.current.get(send.nonce);
  // Closing the owned maker restores the composer before its 800 ms readiness
  // window settles. Main temporarily publishes no settings scope during that
  // window; it is not a chat change. A recovered/different scope still closes
  // the offer, and start() requires a recognized destination and a fresh token.
  const stale = !!send && !!offer(send) && (!destination ||
    destination.chatId !== status.chat.chatId || destination.name !== status.chat.name ||
    ((status.chat.ready || status.chat.settingsId != null) && destination.settingsId !== status.chat.settingsId));
  const shown = send && send.nonce !== hidden && !stale ? send : null;
  const busy = inFlight(send) ? send : null;
  const sendBlocked = !!busy || !status.chat.canSendSticker || !status.chat.destinationToken;
  const unavailableLabel = status.chat.stickerSendBlockedReason === 'busy' ? 'Wait for the current sticker'
    : !status.chat.canSendSticker ? 'Open a chat to send' : null;
  const message = shown && (shown.state === 'missing' || shown.state === 'failed') ? shown : null;
  const editingSticker = editor && visible.current.has(editor.id) ? all.find(s => s.id === editor.id) : null;
  const editing: Draft | null = editor && editingSticker ? { ...editor, text: drafts.get(editor.id) ?? editingSticker.searchTerms } : null;
  const latest = useRef({ editor, drafts, all, message }); latest.current = { editor, drafts, all, message };
  // One detail row at a time: an open editor defers a message for another card.
  const detailId = editing?.id ?? message?.id;
  const detailIndex = stickers.findIndex(s => s.id === detailId);
  // Keep the reason visible until dismissed, even if Search hides its row.
  const filteredMessage = message && !visible.current.has(message.id) ? message : null;

  useEffect(() => { if (local && live?.nonce === local.nonce) setLocal(null); }, [local, live?.nonce]);
  useEffect(() => {
    setEditor(current => current && !all.some(s => s.id === current.id) ? null : current);
    setDrafts(current => {
      const saved = new Map(all.map(s => [s.id, s.searchTerms]));
      const retained = new Map([...current].filter(([id, text]) => saved.has(id) && (saved.get(id) !== text || saving.current.has(id))));
      // Changed saved terms never overwrite a user's draft; equal terms need no draft.
      return retained.size === current.size ? current : retained;
    });
  }, [all]);
  useEffect(() => { if (stale) setHidden(send!.nonce); }, [stale]);
  useEffect(() => {
    if (!send || inFlight(send) || send.nonce === hidden || stale) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (send.state === 'sent' || send.state === 'cancelled') timers.push(setTimeout(() => setHidden(send.nonce), RESULT_MS));
    if (!visible.current.has(send.id)) {
      if (send.state === 'sent' || send.state === 'cancelled') { setFlash(announcement(send)); timers.push(setTimeout(() => setFlash(null), RESULT_MS)); }
    }
    // The animated miss moves focus to Send still, unless the user has moved on from this card.
    else if (send.state === 'missing') {
      const card = grid.current?.querySelector(`[data-sticker="${send.id}"]`), active = document.activeElement;
      if (detailId === send.id && (!active || active === document.body || card?.contains(active))) setFocus({ id: send.id, button: 'offer' });
    }
    return () => { timers.forEach(clearTimeout); setFlash(null); };
  }, [send?.nonce, send?.state, send?.reason, send?.detail]);
  useLayoutEffect(() => {
    const target = focus; if (!target) return;
    // Consume each explicit action once, even if its target is filtered out.
    setFocus(null);
    const row = grid.current?.querySelector<HTMLElement>('.sticker-detail');
    const card = target !== 'search' ? grid.current?.querySelector<HTMLElement>(`[data-sticker="${target.id}"]`) : null;
    const fallback = card?.querySelector<HTMLElement>('.edit:not([aria-disabled="true"]), .cancel') ?? card?.querySelector<HTMLElement>('.send') ?? search.current;
    const element = (target === 'search' ? search.current
      : 'field' in target ? editing?.id === target.id ? row?.querySelector<HTMLElement>(target.field === 'textarea' ? 'textarea' : '.discard button') : null
      : target.button === 'offer' ? row?.querySelector<HTMLElement>('.msg button')
      : card?.querySelector<HTMLElement>(target.button === 'send' ? '.send' : '.edit:not([aria-disabled="true"])')) ?? fallback;
    element?.focus({ preventScroll: target !== 'search' && 'field' in target && !!target.open });
    if (element && target !== 'search' && 'field' in target) {
      if (target.open && element instanceof HTMLTextAreaElement) element.setSelectionRange(element.value.length, element.value.length);
      if (target.scroll) row?.scrollIntoView({ block: 'nearest' });
    }
  }, [focus]);
  useLayoutEffect(() => {
    const request = locating.current, location = status.stickerLocation;
    if (!request || location?.id !== request.id || (location.state === request.state?.state && location.id === request.state?.id)) return;
    request.state = location;
    // Only the still-active Locate action may reveal its growing feedback row.
    // Searching, leaving the editor, or a remount never replays this scroll.
    if (editing?.id === request.id && !editing.prompt && request.source?.isConnected && document.activeElement === request.source) {
      grid.current?.querySelector<HTMLElement>('.sticker-detail')?.scrollIntoView({ block: 'nearest' });
    }
    if (location.state !== 'looking') locating.current = null;
  }, [status.stickerLocation?.id, status.stickerLocation?.state]);

  const start = (event: React.MouseEvent, id: string, still = false) => {
    // Only a trusted click or key press on Send, Send still or Try again may authorize a send.
    if (!event.nativeEvent.isTrusted || sendBlocked || !status.chat.destinationToken) return false;
    const nonce = crypto.randomUUID();
    if (send) setHidden(send.nonce);
    origin.current.set(nonce, { chatId: status.chat.chatId, settingsId: status.chat.settingsId, name: status.chat.name });
    setLocal({ id, nonce, name: status.chat.name });
    void act({ type: 'sendSticker', id, nonce, destinationToken: status.chat.destinationToken, ...still && { still: true as const } }).then(ok => { if (!ok) setLocal(current => current?.nonce === nonce ? null : current); });
    return true;
  };
  const retry = (event: React.MouseEvent, sent: StickerSend) => {
    const action = offer(sent);
    if (action && start(event, sent.id, action.still)) setFocus({ id: sent.id, button: 'send' });
  };
  const cancel = () => { void act({ type: 'cancelSticker' }); };
  const dismiss = (id: string) => { if (message) setHidden(message.nonce); setFocus({ id, button: 'send' }); };
  const clearDraft = (id: string) => {
    setDrafts(current => { if (!current.has(id)) return current; const next = new Map(current); next.delete(id); return next; });
  };
  const open = (id: string) => {
    editorSession.current++;
    locating.current = null;
    // Opening any editor withdraws an offer to send; a plain failure follows its own card into the editor.
    if (message && (message.id !== id || offer(message))) setHidden(message.nonce);
    setEditor({ id });
    setFocus({ id, field: 'textarea', open: true, scroll: true });
  };
  const finish = (closing: string, next: string | null, returnFocus = true) => {
    editorSession.current++;
    locating.current = null;
    clearDraft(closing);
    if (latest.current.message?.id === closing) setHidden(latest.current.message.nonce);
    if (next && all.some(s => s.id === next)) open(next);
    else { setEditor(current => current?.id === closing ? null : current); if (returnFocus) setFocus({ id: closing, button: 'edit' }); }
  };
  const requestClose = (next: string | null) => {
    if (!editing) return;
    locating.current = null;
    if (editingSticker && editing.text !== editingSticker.searchTerms) { setEditor({ id: editing.id, prompt: { next } }); setFocus({ id: editing.id, field: 'keep', scroll: true }); }
    else finish(editing.id, next);
  };
  const keep = () => { setEditor(current => current && { id: current.id }); if (editing) setFocus({ id: editing.id, field: 'textarea' }); };
  const toggle = (id: string) => { if (editing) requestClose(editing.id === id ? null : id); else open(id); };

  const escape = useRef<() => boolean>(() => false);
  escape.current = () => {
    if (editing?.prompt) { keep(); return true; }
    if (editing) { requestClose(null); return true; }
    if (cancellable(busy)) { cancel(); return true; }
    if (busy) return true;
    if (message) { dismiss(message.id); return true; }
    return false;
  };
  useEffect(() => {
    // Capture runs before the panel's own Escape, which closes the panel when nothing here handles it.
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && escape.current()) event.preventDefault(); };
    window.addEventListener('keydown', handler, true); return () => window.removeEventListener('keydown', handler, true);
  }, []);

  const detail = (index: number) => {
    const col = index % COLUMNS + 1;
    if (editing && editingSticker) return <StickerEditor key={`editor-${editing.id}`} col={col} sticker={editingSticker} draft={editing} location={status.stickerLocation} message={message?.id === editing.id ? message : null} retry={retry} sendBlocked={sendBlocked}
      change={text => {
        setDrafts(current => {
          const next = new Map(current);
          if (text === editingSticker.searchTerms && !saving.current.has(editing.id)) next.delete(editing.id); else next.set(editing.id, text);
          return next;
        });
        setEditor({ id: editing.id });
      }} close={() => requestClose(null)} keep={keep} discard={() => finish(editing.id, editing.prompt?.next ?? null)}
      save={async () => {
        const source = document.activeElement;
        const session = editorSession.current, revision = queryRevision.current;
        const { id, text } = editing;
        const request = Symbol(); saving.current.set(id, request);
        const ok = await act({ type: 'sticker', id, searchTerms: text });
        const currentRequest = saving.current.get(id) === request;
        if (currentRequest) saving.current.delete(id);
        if (!ok || !currentRequest) return;
        const current = latest.current;
        const currentText = current.drafts.get(id) ?? current.all.find(s => s.id === id)?.searchTerms;
        // A delayed acknowledgement belongs to this submitted text and editor visit.
        if (currentText === text && current.editor?.id === id && editorSession.current === session && queryRevision.current === revision) {
          finish(id, null, document.activeElement === source);
        }
      }}
      locate={() => {
        if (!status.chat.destinationToken) return;
        editorSession.current++;
        const request = { id: editing.id, source: document.activeElement, state: status.stickerLocation };
        locating.current = request;
        void act({ type: 'locateSticker', id: editing.id, destinationToken: status.chat.destinationToken }).then(ok => { if (!ok && locating.current === request) locating.current = null; });
      }}
      forget={async () => {
        const source = document.activeElement;
        const revision = queryRevision.current;
        const session = ++editorSession.current;
        const id = editing.id, at = stickers.findIndex(s => s.id === id), next = stickers[at + 1] ?? stickers[at - 1];
        if (!await act({ type: 'forgetSticker', id })) return;
        if (editorSession.current !== session) return;
        if (latest.current.message?.id === id) setHidden(latest.current.message.nonce);
        clearDraft(id);
        saving.current.delete(id);
        if (locating.current?.id === id) locating.current = null;
        setEditor(current => current?.id === id ? null : current);
        if (queryRevision.current === revision && (document.activeElement === source || (!source?.isConnected && document.activeElement === document.body))) setFocus(next ? { id: next.id, button: 'send' } : 'search');
      }}/>;
    if (message) return <div key={`message-${message.nonce}`} className="sticker-detail sticker-message" style={{ '--col': col } as React.CSSProperties}>
      <MessageBody message={message} retry={retry} sendBlocked={sendBlocked} dismiss={() => dismiss(message.id)}/>
    </div>;
    return null;
  };

  return <>
    <input ref={search} className="search" aria-label="Search stickers" placeholder="Search stickers" value={query} onChange={e => { queryRevision.current++; locating.current = null; setFocus(null); setQuery(e.target.value); }}/>
    {/* A filtered-out send stays explained here, so the dimmed Send buttons have a visible reason. */}
    <p className="hint">{all.length} stickers indexed{unavailableLabel && !busy && ` · ${unavailableLabel}`}{busy && !visible.current.has(busy.id) ? ' · Sending…' : filteredMessage ? ` · ${sendMessage(filteredMessage)}` : flash && ` · ${flash}`}</p>
    <p className="sr-only" aria-live="polite">{shown ? announcement(shown) : ''}</p>
    {!stickers.length && <div className="empty"><span aria-hidden="true">▧</span><p>{query ? 'No matching stickers' : 'Your stickers will appear here'}</p><small>{query ? 'Try another word or phrase.' : 'Open WhatsApp’s sticker picker and select Favorites. Wait for your stickers to load.'}</small></div>}
    {!!stickers.length && <div className="sticker-grid" ref={grid}>{stickers.flatMap((sticker, i) => {
      const own = shown?.id === sticker.id ? shown.state : null;
      const ownBusy = busy?.id === sticker.id ? busy.state : null;
      const sendLabel = ownBusy ? 'Sending sticker…' : unavailableLabel ?? (busy ? 'Wait for the current sticker' : `Send to ${status.chat.name}`);
      const tagged = !!sticker.searchTerms.trim();
      const editLabel = tagged ? 'Edit search terms' : 'Add search terms';
      const expanded = editing?.id === sticker.id;
      const card = <div key={sticker.id} className="sticker" role="group" data-sticker={sticker.id} aria-label={sticker.searchTerms.slice(0, 120) || 'Sticker without search terms'} data-attached={detailId === sticker.id ? '' : undefined}>
        <div className="sticker-art" title={sticker.searchTerms || undefined} data-busy={own && own !== 'missing' && own !== 'failed' ? '' : undefined}>
          <img src={sticker.image} alt="" draggable={false}/>
          {ownBusy && <div className="sticker-overlay" aria-hidden="true"><span className="spinner"/>Sending…</div>}
          {own === 'sent' && <div className="sticker-overlay" aria-hidden="true"><span className="done"><CheckIcon/></span>Sent</div>}
          {own === 'cancelled' && <div className="sticker-overlay muted" aria-hidden="true">Cancelled</div>}
        </div>
        <div className="sticker-actions">
          <button className="send" aria-label={sendLabel} title={sendLabel} aria-disabled={sendBlocked || undefined} onClick={e => { if (!sendBlocked) start(e, sticker.id); }}><SendIcon/></button>
          {ownBusy === 'finding'
            ? <button className="cancel" aria-label="Cancel sending" title="Cancel sending" onClick={cancel}>×</button>
            : <button className={tagged ? 'edit' : 'edit untagged'} aria-label={editLabel} title={editLabel} aria-expanded={expanded} aria-disabled={!!ownBusy || undefined} onClick={() => { if (!ownBusy) toggle(sticker.id); }}><EditIcon/></button>}
        </div>
      </div>;
      const rowEnd = Math.min(detailIndex - detailIndex % COLUMNS + COLUMNS - 1, stickers.length - 1);
      return detailIndex >= 0 && i === rowEnd ? [card, detail(detailIndex)] : [card];
    })}</div>}
  </>;
}

function MessageBody({ message, retry, sendBlocked, dismiss }: { message: StickerSend; retry: (event: React.MouseEvent, send: StickerSend) => void; sendBlocked: boolean; dismiss?: () => void }) {
  const action = offer(message);
  return <>
    <span className="mark" aria-hidden="true">!</span>
    <div className="msg">
      <p>{sendMessage(message)}</p>
      {action && <button className={action.primary ? 'primary' : undefined} aria-disabled={sendBlocked || undefined} onClick={e => { if (!sendBlocked) retry(e, message); }}>{action.label}</button>}
    </div>
    {dismiss && <button className="icon-close" aria-label="Dismiss" title="Dismiss" onClick={dismiss}>×</button>}
  </>;
}

function StickerEditor({ col, sticker, draft, location, message, retry, sendBlocked, change, close, keep, discard, save, locate, forget }: {
  col: number; sticker: Sticker; draft: Draft; location: Status['stickerLocation']; message: StickerSend | null;
  retry: (event: React.MouseEvent, send: StickerSend) => void;
  sendBlocked: boolean;
  change: (text: string) => void; close: () => void; keep: () => void; discard: () => void;
  save: () => void; locate: () => void; forget: () => void;
}) {
  const id = useId();
  const result = location?.id === sticker.id ? location.state : null;
  return <div className="sticker-detail" style={{ '--col': col } as React.CSSProperties} role="region" aria-label="Search terms">
    <div className="detail-head"><label htmlFor={id}>Search terms</label><button className="icon-close" aria-label="Close" title="Close" onClick={close}>×</button></div>
    {/* Closing the editor clears the message, so it has no Dismiss of its own here. */}
    {message && <div className="sticker-message inline"><MessageBody message={message} retry={retry} sendBlocked={sendBlocked}/></div>}
    <textarea id={id} value={draft.text} maxLength={4000} rows={4} onChange={e => change(e.target.value)} placeholder="happy, feliz, good morning, buenos días"/>
    {draft.prompt
      ? <div className="discard" role="group" aria-label="Discard changes?"><span aria-hidden="true">Discard changes?</span><button onClick={keep}>Keep editing</button><button className="quiet" onClick={discard}>Discard</button></div>
      : <div className="actions"><button className="primary" disabled={draft.text === sticker.searchTerms} onClick={save}>Save</button><button onClick={locate}>Locate in WhatsApp</button><button className="quiet" onClick={forget}>Forget</button></div>}
    {result && !draft.prompt && <p className="sticker-location" role="status">{locationMessages[result]}</p>}
  </div>;
}
