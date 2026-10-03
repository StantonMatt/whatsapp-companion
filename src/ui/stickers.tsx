import { StickerGroupToggles, useStickerGroups } from './sticker-groups';
import { stickerURL } from '../shared/sticker-url';
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
  : send.sent === 'not-sent' ? 'Couldn’t send the sticker. Nothing was sent.'
  : send.sent === 'confirmed' ? 'Sticker sent.'
  : 'Couldn’t confirm the sticker was sent. Check the chat before sending it again.';
// Only these rows offer a new send: an animated miss (Send still / Try again) and a maker failure that sent nothing (Try again).
// A result that may have been sent never offers one.
const offer = (send: StickerSend) => send.state === 'missing' ? { label: 'Send still', primary: true, still: true }
  : noEditor(send) ? { label: 'Try again', primary: false, still: send.route === 'maker' && send.animated } : null;
const announcement = (send: StickerSend) => inFlight(send) ? 'Sending sticker…' : send.reason === 'draft' ? sendMessage(send) : ({
  sent: `Sent to ${send.name}`, missing: 'Animated version not loaded. Send still?', cancelled: 'Cancelled',
  failed: noEditor(send) ? 'WhatsApp didn’t open its sticker editor' : send.sent === 'not-sent' ? 'Nothing was sent' : send.sent === 'confirmed' ? 'Sticker sent' : 'Couldn’t confirm the sticker was sent'
} as Record<StickerSend['state'], string>)[send.state];
const RESULT_MS = 1500;
const inFlight = (send: StickerSend | null) => send?.state === 'finding' || send?.state === 'preparing' || send?.state === 'sending';
// Before WhatsApp's own Send is clicked, the send can still be called off.
const cancellable = (send: StickerSend | null) => send?.state === 'finding' || send?.state === 'preparing';

const CheckIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" d="m5.5 12.5 4.2 4.2 8.8-9.2"/></svg>;

type Exit = 'done' | 'panel' | 'settings';
type Editor = { id: string; prompt?: { next: string | null; exit?: Exit } };
type Draft = Editor & { text: string };
type FocusTarget = { id: string; button: 'tile' | 'offer' } | 'search'
  | { id: string; field: 'textarea' | 'keep'; open?: boolean; scroll?: boolean };

export function Stickers({ status, act }: { status: Status; act: Act }) {
  const [broken, setBroken] = useState(() => new Set<string>());
  const [imageRevisions, setImageRevisions] = useState(() => new Map<string, number>());
  const [query, setQuery] = useState('');
  const [editMode, setEditMode] = useState(false);
  const groups = useStickerGroups(status.state, act, editMode);
  const [columns, setColumns] = useState(1);
  const [busyNotice, setBusyNotice] = useState('');
  const [dismissedStop, setDismissedStop] = useState<number | null>(null);
  const countId = useId();
  const [editor, setEditor] = useState<Editor | null>(null);
  // Filtering may hide an editor without discarding its sticker's unsaved text.
  // Both states belong to this panel instance, so closing it discards all drafts.
  const [drafts, setDrafts] = useState(() => new Map<string, string>());
  const [local, setLocal] = useState<{ id: string; nonce: string; name: string } | null>(null);
  // A result left over from before the panel opened is not shown again.
  const [hidden, setHidden] = useState(() => status.stickerSend && !inFlight(status.stickerSend) ? status.stickerSend.nonce : null);
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
  const stickers = searchStickers(all, query, groups.filter).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const visible = useRef(new Set<string>()); visible.current = new Set(stickers.map(s => s.id));

  const live = status.stickerSend ?? null;
  // The card reacts in the same frame as the click, before the desktop process has chosen a route.
  const send: StickerSend | null = local && live?.nonce !== local.nonce ? { ...local, route: 'maker', animated: false, state: 'preparing' } : live;
  const destination = send && origin.current.get(send.nonce);
  // Closing the owned maker restores the composer before its 800 ms readiness
  // window settles. Main temporarily publishes no settings scope during that
  // window; it is not a chat change. A recovered/different scope still closes
  // the offer, and start() requires a recognized destination and a fresh token.
  const stale = !!send && (send.state === 'failed' || send.state === 'missing') && !!destination && (
    destination.chatId !== status.chat.chatId || destination.name !== status.chat.name ||
    ((status.chat.ready || status.chat.settingsId != null) && destination.settingsId !== status.chat.settingsId));
  const shown = send && send.nonce !== hidden && !stale ? send : null;
  const busy = inFlight(send) ? send : null;
  const sendBlocked = !!busy || !status.chat.canSendSticker || !status.chat.destinationToken;
  const unavailableLabel = status.chat.stickerSendBlockedReason === 'busy' ? 'Wait for the current sticker'
    : !status.chat.canSendSticker ? 'Open a chat to send' : null;
  const message = shown && (shown.state === 'missing' || shown.state === 'failed') ? shown : null;
  const editingSticker = editor ? all.find(s => s.id === editor.id) : null;
  const editing: Draft | null = editor && editingSticker ? { ...editor, text: drafts.get(editor.id) ?? editingSticker.searchTerms } : null;
  const latest = useRef({ editor, drafts, all, message }); latest.current = { editor, drafts, all, message };
  // One detail row at a time: an open editor defers a message for another card.
  const visibleEditing = editing && visible.current.has(editing.id) ? editing : null;
  const detailId = visibleEditing?.id ?? (editing?.prompt ? null : message?.id);
  const detailIndex = stickers.findIndex(s => s.id === detailId);
  const lastChat = useRef(status.chat);
  useEffect(() => {
    const previous = lastChat.current;
    if (previous.chatId !== status.chat.chatId || previous.name !== status.chat.name ||
      ((status.chat.ready || status.chat.settingsId != null) && previous.settingsId !== status.chat.settingsId)) {
      if (message) setHidden(message.nonce);
    }
    // A temporary absent scope during maker cleanup is not a chat change.
    if (status.chat.ready || status.chat.settingsId != null || previous.chatId !== status.chat.chatId) lastChat.current = status.chat;
  }, [status.chat.chatId, status.chat.name, status.chat.settingsId, status.chat.ready]);
  // Keep the reason visible until dismissed, even if Search hides its row.
  const filteredMessage = message && !visible.current.has(message.id) ? message : null;

  useLayoutEffect(() => {
    const element = grid.current; if (!element) return;
    const measure = () => {
      const tracks = getComputedStyle(element).gridTemplateColumns.split(/\s+/).filter(track => /^\d+(?:\.\d+)?px$/.test(track));
      setColumns(Math.max(1, tracks.length));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element); window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  useLayoutEffect(() => { grid.current?.closest<HTMLElement>('.panel')?.scrollTo({ top: 0 }); }, [query, groups.filter]);
  useEffect(() => { queryRevision.current++; locating.current = null; setFocus(null); }, [groups.filter]);
  useEffect(() => { if (!busy && status.chat.stickerSendBlockedReason !== 'busy') setBusyNotice(''); }, [busy?.nonce, busy?.state, status.chat.stickerSendBlockedReason]);
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
    // The animated miss moves focus to Send still, unless the user has moved on from this card.
    if (visible.current.has(send.id) && send.state === 'missing') {
      const card = grid.current?.querySelector(`[data-sticker="${send.id}"]`), active = document.activeElement;
      if (detailId === send.id && (!active || active === document.body || card?.contains(active))) setFocus({ id: send.id, button: 'offer' });
    }
    return () => { timers.forEach(clearTimeout); };
  }, [send?.nonce, send?.state, send?.reason, send?.detail]);
  useLayoutEffect(() => {
    const target = focus; if (!target) return;
    // Consume each explicit action once, even if its target is filtered out.
    setFocus(null);
    const row = grid.current?.querySelector<HTMLElement>('.sticker-detail');
    const card = target !== 'search' ? grid.current?.querySelector<HTMLElement>(`[data-sticker="${target.id}"]`) : null;
    const fallback = card?.querySelector<HTMLElement>('.sticker-art') ?? search.current;
    const element = (target === 'search' ? search.current
      : 'field' in target ? editing?.id === target.id ? row?.querySelector<HTMLElement>(target.field === 'textarea' ? 'textarea' : '.discard button') : null
      : target.button === 'offer' ? row?.querySelector<HTMLElement>('.msg button')
      : card?.querySelector<HTMLElement>('.sticker-art')) ?? fallback;
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
    // Native button activation handles click, Enter and Space; synthetic events grant no send permission.
    if (!event.nativeEvent.isTrusted) return false;
    if (busy || status.chat.stickerSendBlockedReason === 'busy') { setBusyNotice('Wait for the current sticker'); return false; }
    if (sendBlocked || !status.chat.destinationToken) return false;
    setBusyNotice('');
    const nonce = crypto.randomUUID();
    if (send) setHidden(send.nonce);
    origin.current.set(nonce, { chatId: status.chat.chatId, settingsId: status.chat.settingsId, name: status.chat.name });
    setLocal({ id, nonce, name: status.chat.name });
    void act({ type: 'sendSticker', id, nonce, destinationToken: status.chat.destinationToken, ...still && { still: true as const } }).then(ok => { if (!ok) setLocal(current => current?.nonce === nonce ? null : current); });
    return true;
  };
  const retry = (event: React.MouseEvent, sent: StickerSend, original = false) => {
    const action = offer(sent);
    if (action && start(event, sent.id, original ? false : action.still)) setFocus({ id: sent.id, button: 'tile' });
  };
  const cancel = () => { void act({ type: 'cancelSticker' }); };
  const dismiss = (id: string) => { if (message) setHidden(message.nonce); setFocus({ id, button: 'tile' }); };
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
  const finish = (closing: string, next: string | null, returnFocus = true, exit?: Exit) => {
    editorSession.current++;
    locating.current = null;
    clearDraft(closing);
    if (latest.current.message?.id === closing) setHidden(latest.current.message.nonce);
    if (exit) { groups.reset(); setEditMode(false); if (exit !== 'done') void act({ type: 'panel', panel: exit === 'panel' ? null : 'settings' }); }
    if (next && all.some(s => s.id === next)) open(next);
    else { setEditor(current => current?.id === closing ? null : current); if (returnFocus) setFocus({ id: closing, button: 'tile' }); }
  };
  const requestClose = (next: string | null, exit?: Exit) => {
    if (!editing) { if (exit) { groups.reset(); setEditMode(false); if (exit !== 'done') void act({ type: 'panel', panel: exit === 'panel' ? null : 'settings' }); } return; }
    locating.current = null;
    if (editingSticker && editing.text !== editingSticker.searchTerms) { setEditor({ id: editing.id, prompt: { next, exit } }); setFocus({ id: editing.id, field: 'keep', scroll: true }); }
    else finish(editing.id, next, true, exit);
  };
  const keep = () => { setEditor(current => current && { id: current.id }); if (editing) setFocus({ id: editing.id, field: 'textarea' }); };
  const toggle = (id: string) => { if (editing) requestClose(editing.id === id ? null : id); else open(id); };

  const escape = useRef<() => boolean>(() => false);
  escape.current = () => {
    if (groups.closePopover()) return true;
    if (document.activeElement === search.current && query) { queryRevision.current++; setQuery(''); return true; }
    if (editing?.prompt) { keep(); return true; }
    if (editing) { requestClose(null); return true; }
    if (groups.cancelInline()) return true;
    if (groups.clearSelection()) return true;
    if (editMode) { groups.reset(); setEditMode(false); return true; }
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
    const col = index % columns + 1;
    if (editing && editingSticker && (visibleEditing || editing.prompt)) return <StickerEditor key={`editor-${editing.id}`} col={col} detached={!visibleEditing} sticker={editingSticker} groupControls={<StickerGroupToggles groups={status.state.stickerGroups} sticker={editingSticker} act={act}/>} draft={editing} location={status.stickerLocation} message={message?.id === editing.id ? message : null} retry={retry} sendBlocked={sendBlocked}
      change={text => {
        setDrafts(current => {
          const next = new Map(current);
          if (text === editingSticker.searchTerms && !saving.current.has(editing.id)) next.delete(editing.id); else next.set(editing.id, text);
          return next;
        });
        setEditor({ id: editing.id });
      }} close={() => requestClose(null)} keep={keep} discard={() => finish(editing.id, editing.prompt?.next ?? null, true, editing.prompt?.exit)}
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
        if (queryRevision.current === revision && (document.activeElement === source || (!source?.isConnected && document.activeElement === document.body))) setFocus(next ? { id: next.id, button: 'tile' } : 'search');
      }}/>;
    if (message) return <div key={`message-${message.nonce}`} className="sticker-detail sticker-message" role="region" aria-label="Send result" style={{ '--col': col } as React.CSSProperties}>
      <MessageBody message={message} retry={retry} sendBlocked={sendBlocked} dismiss={() => dismiss(message.id)}/>
    </div>;
    return null;
  };

  const stopReason = status.state.global.directStickerDisabledReason;
  const stopAt = status.state.global.directStickerDisabledAt ?? 0;
  const stopReasons = { 'logged-out': 'WhatsApp logged out.', 'account-warning': 'WhatsApp showed an account warning.', 'send-error': 'a direct send failed.', 'whatsapp-changed': 'WhatsApp changed.' };
  const strip = [status.stickerLibraryError, unavailableLabel && !busy ? unavailableLabel : null,
    busy && !visible.current.has(busy.id) ? 'Sending…' : filteredMessage ? sendMessage(filteredMessage) : shown && !visible.current.has(shown.id) && (shown.state === 'sent' || shown.state === 'cancelled') ? announcement(shown) : null].filter(Boolean).join(' · ');
  const count = stickers.length < all.length ? `${stickers.length} of ${all.length}` : `${all.length}`;
  const groupName = status.state.stickerGroups.find(group => group.id === groups.filter)?.name;
  return <>
    <header className="sticker-head">
      <div className="sticker-head-row">
        <button className="back" data-preserve-auto="" aria-label="Close panel" onClick={() => requestClose(null, 'panel')}>←</button>
        <h1>Stickers</h1>
        <div className="sticker-search" style={{ '--count-width': `${count.length}ch` } as React.CSSProperties}>
          <input ref={search} className="search" aria-label="Search stickers" aria-describedby={countId} placeholder="Search" value={query} onChange={e => { queryRevision.current++; locating.current = null; setFocus(null); setQuery(e.target.value); }}/>
          <span className="count" aria-hidden="true">{count}</span><span className="sr-only" id={countId}>{all.length} stickers indexed</span>
        </div>
        <button className={`sticker-mode${editMode ? ' mode-done' : ''}`} onClick={() => editMode ? requestClose(null, 'done') : setEditMode(true)}>{editMode ? 'Done' : 'Edit'}</button>
      </div>
      {groups.header}
      {strip && <p className="sticker-strip"><span>{strip}</span></p>}
      {stopReason && dismissedStop !== stopAt && <p className="sticker-strip warn" role="status"><span>Direct sending turned off: {stopReasons[stopReason]} Stickers go through WhatsApp’s editor again. <a href="#ai-settings" onClick={e => { e.preventDefault(); requestClose(null, 'settings'); }}>AI settings</a></span><button className="icon-close" aria-label="Dismiss direct-send notice" onClick={() => setDismissedStop(stopAt)}>×</button></p>}
    </header>
    <div className="panel-body sticker-body" data-mode={editMode ? 'edit' : 'normal'}>
      {status.pending && <div className="pending"><b>Scheduled reply</b><p>{status.pending.text}</p><p>After {new Date(status.pending.due).toLocaleTimeString()}</p><button onClick={() => void act({ type: 'cancelAuto' })}>Cancel and pause</button></div>}
      <p className="sr-only" aria-live="polite">{busyNotice || (shown ? announcement(shown) : '')}</p>
      {!stickers.length && <div className="empty"><span aria-hidden="true">▧</span><p>{groupName ? `${query ? 'No matches' : 'No stickers'} in ${groupName}` : query ? 'No matching stickers' : 'Your stickers will appear here'}</p>{groups.filter ? <button onClick={groups.showAll}>{query ? 'Search all groups' : 'Show all groups'}</button> : <small>{query ? 'Try another word or phrase.' : 'Open WhatsApp’s sticker picker and select Favorites. Wait for your stickers to load.'}</small>}</div>}
      <div className="sticker-grid" ref={grid} style={{ '--cols': columns } as React.CSSProperties}>{stickers.flatMap((sticker, i) => {
        const own = shown?.id === sticker.id ? shown.state : null;
        const ownBusy = busy?.id === sticker.id ? busy.state : null;
        const expanded = visibleEditing?.id === sticker.id;
        const imageBroken = broken.has(sticker.id);
        const name = sticker.searchTerms.slice(0, 120) || 'Sticker without search terms';
        const label = editMode ? name : ownBusy ? 'Sending sticker…' : own === 'sent' ? `Sent to ${shown!.name}` : own === 'cancelled' ? 'Cancelled' : imageBroken ? 'Image unavailable. Retry' : name;
        const tileDisabled = !imageBroken && !editMode && !busy && (!status.chat.canSendSticker || !status.chat.destinationToken) && status.chat.stickerSendBlockedReason !== 'busy';
        const card = <div key={sticker.id} className="sticker" role="group" data-sticker={sticker.id} aria-label={sticker.searchTerms.slice(0, 120) || 'Sticker without search terms'} data-selected={groups.selected.has(sticker.id) ? '' : undefined} data-attached={detailId === sticker.id ? '' : undefined}>
          <button className={`sticker-art${!sticker.searchTerms.trim() ? ' untagged' : ''}`} aria-label={label} title={sticker.searchTerms || undefined}
            aria-expanded={editMode ? expanded : undefined} aria-disabled={tileDisabled || undefined} data-busy={ownBusy ? '' : undefined} data-sent={own === 'sent' ? '' : undefined} data-cancelled={own === 'cancelled' ? '' : undefined} data-broken={imageBroken || undefined}
            onClick={e => {
              if (!editMode && (busy || status.chat.stickerSendBlockedReason === 'busy')) { start(e, sticker.id); return; }
              if (editMode) { if (e.ctrlKey || e.metaKey) groups.toggleSelection(sticker.id); else toggle(sticker.id); return; }
              if (imageBroken) { setImageRevisions(previous => new Map(previous).set(sticker.id, (previous.get(sticker.id) ?? 0) + 1)); return; }
              start(e, sticker.id);
            }}>
            <img key={`${sticker.id}-${imageRevisions.get(sticker.id) ?? 0}`} src={stickerURL(sticker.id)} loading="lazy" alt="" draggable={false} onError={() => setBroken(previous => previous.has(sticker.id) ? previous : new Set(previous).add(sticker.id))} onLoad={() => setBroken(previous => { if (!previous.has(sticker.id)) return previous; const next = new Set(previous); next.delete(sticker.id); return next; })}/>
            {imageBroken && !ownBusy && own !== 'sent' && own !== 'cancelled' && <span className="sticker-overlay broken" aria-hidden="true"><svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" strokeWidth="1.6" d="M4 5.5h16v13H4zM4 15l4.5-4.5 3.5 3.5 2.5-2.5L20 17"/></svg><b>Retry</b></span>}
            {ownBusy && <span className="sticker-overlay" aria-hidden="true"><span className="spinner"/>Sending…</span>}
            {own === 'sent' && <span className="sticker-overlay" aria-hidden="true"><span className="done"><CheckIcon/></span>Sent</span>}
            {own === 'cancelled' && <span className="sticker-overlay muted" aria-hidden="true">Cancelled</span>}
            {(own === 'failed' || own === 'missing') && <span className="mark" aria-hidden="true">!</span>}
          </button>
          {editMode && <button className="sticker-pick" role="checkbox" aria-checked={groups.selected.has(sticker.id)} aria-label={`Select ${name}`} onClick={() => groups.toggleSelection(sticker.id)}><CheckIcon/></button>}
          {cancellable(busy) && busy?.id === sticker.id && <button className="cancel-send" aria-label="Cancel sending" title="Cancel sending" onClick={cancel}>×</button>}
        </div>;
        const rowEnd = Math.min(detailIndex - detailIndex % columns + columns - 1, stickers.length - 1);
        return detailIndex >= 0 && i === rowEnd ? [card, detail(detailIndex)] : [card];
      })}{editing?.prompt && !visibleEditing && detail(0)}</div>
    </div>
    {groups.bar(stickers)}
  </>;
}

function MessageBody({ message, retry, sendBlocked, dismiss }: { message: StickerSend; retry: (event: React.MouseEvent, send: StickerSend, original?: boolean) => void; sendBlocked: boolean; dismiss?: () => void }) {
  const action = offer(message);
  return <>
    <span className="mark" aria-hidden="true">!</span>
    <div className="msg">
      <p>{sendMessage(message)}</p>
      {action && <button className={action.primary ? 'primary' : undefined} aria-disabled={sendBlocked || undefined} onClick={e => { if (!sendBlocked) retry(e, message); }}>{action.label}</button>}
      {message.state === 'missing' && <button aria-disabled={sendBlocked || undefined} onClick={e => { if (!sendBlocked) retry(e, message, true); }}>Try again</button>}
    </div>
    {dismiss && <button className="icon-close" aria-label="Dismiss" title="Dismiss" onClick={dismiss}>×</button>}
  </>;
}

function StickerEditor({ col, detached, sticker, groupControls, draft, location, message, retry, sendBlocked, change, close, keep, discard, save, locate, forget }: {
  col: number; detached: boolean; sticker: Sticker; groupControls: React.ReactNode; draft: Draft; location: Status['stickerLocation']; message: StickerSend | null;
  retry: (event: React.MouseEvent, send: StickerSend, original?: boolean) => void;
  sendBlocked: boolean;
  change: (text: string) => void; close: () => void; keep: () => void; discard: () => void;
  save: () => void; locate: () => void; forget: () => void;
}) {
  const id = useId();
  const result = location?.id === sticker.id ? location.state : null;
  return <div className="sticker-detail" data-detached={detached || undefined} style={{ '--col': col } as React.CSSProperties} role="region" aria-label="Search terms">
    <div className="detail-head"><label htmlFor={id}>Search terms</label><button className="icon-close" aria-label="Close" title="Close" onClick={close}>×</button></div>
    {/* Closing the editor clears the message, so it has no Dismiss of its own here. */}
    {message && <div className="sticker-message inline"><MessageBody message={message} retry={retry} sendBlocked={sendBlocked}/></div>}
    <textarea id={id} value={draft.text} maxLength={4000} rows={4} onChange={e => change(e.target.value)} placeholder="happy, feliz, good morning, buenos días"/>
    {!draft.prompt && groupControls}
    {draft.prompt
      ? <div className="discard" role="group" aria-label="Discard changes?"><span aria-hidden="true">Discard changes?</span><button onClick={keep}>Keep editing</button><button className="quiet" onClick={discard}>Discard</button></div>
      : <div className="actions"><button className="primary" disabled={draft.text === sticker.searchTerms} onClick={save}>Save</button><button onClick={locate}>Locate in WhatsApp</button><button className="quiet" onClick={forget}>Forget</button></div>}
    {result && !draft.prompt && <p className="sticker-location" role="status">{locationMessages[result]}</p>}
  </div>;
}
