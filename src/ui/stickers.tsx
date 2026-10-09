import { SparkIcon, TagDots, TagStrip, providerName, tagErrorMessage, tagSettingsError } from './sticker-tagging';
import { StickerGroupToggles, useStickerGroups } from './sticker-groups';
import { stickerURL } from '../shared/sticker-url';
import React, { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Panel, Status, Sticker } from '../shared/model';
import type { StickerSend } from '../shared/sticker-transfer';
import { useStickerViewport } from './sticker-grid';
import type { Act } from './index';
import { BackIcon, EditIcon, TrashIcon } from './icons';

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

type Exit = 'done' | 'panel' | 'settings' | 'chat' | 'providers';
type Editor = { id: string; prompt?: { next: string | null; exit?: Exit } };
type Draft = Editor & { text: string };
type DeleteQuestion = { kind: 'bar'; ids: string[]; from?: string; auto?: string } | { kind: 'editor'; id: string };
type FocusTarget = { id: string; button: 'tile' | 'offer' | 'last' } | 'search'
  | 'delete-keep' | 'delete-trigger'
  | { id: string; field: 'textarea' | 'keep' | 'delete-keep' | 'delete-trigger'; open?: boolean; scroll?: boolean };

export function Stickers({ status, act, navigation, openProviders }: { status: Status; act: Act; navigation?: React.RefObject<((panel: Panel) => void) | null>; openProviders?: () => void }) {
  const [broken, setBroken] = useState(() => new Set<string>());
  const [imageRevisions, setImageRevisions] = useState(() => new Map<string, number>());
  const [query, setQuery] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [columns, setColumns] = useState(3);
  const [deleteQuestion, setDeleteQuestion] = useState<DeleteQuestion | null>(null);
  const deleteQuestionRef = useRef(deleteQuestion); deleteQuestionRef.current = deleteQuestion;
  const [deleting, setDeleting] = useState(false);
  const deleteLock = useRef(false);
  const pendingDelete = useRef<{ ids: string[]; disappeared: Set<string> } | null>(null);
  const [deletedNotice, setDeletedNotice] = useState('');
  const [deletionSequence, setDeletionSequence] = useState(0);
  const [drafts, setDrafts] = useState(() => new Map<string, string>());
  const untaggedIds = useMemo(() => new Set(status.state.stickers.filter(s => !s.searchTerms.trim()).map(s => s.id)), [status.state.stickers]);
  const [untaggedSnapshot, setUntaggedSnapshot] = useState<Set<string> | null>(null);
  const [tagConfirmation, setTagConfirmation] = useState<string[] | null>(null);
  const [suggesting, setSuggesting] = useState<{ id: string; nonce: string; before: string; observed?: boolean } | null>(null);
  const suggestionRequest = useRef(suggesting); suggestionRequest.current = suggesting;
  const [suggestions, setSuggestions] = useState(() => new Map<string, { before: string; groups: string[] }>());
  const editRevisions = useRef(new Map<string, number>());
  const revise = (id: string) => editRevisions.current.set(id, (editRevisions.current.get(id) ?? 0) + 1);
  const groupAct: Act = async action => {
    if (action.type === 'stickerGroupMembership') revise(action.id);
    if (action.type === 'bulkStickerGroupMembership') action.stickerIds.forEach(revise);
    return act(action);
  };
  const confirmationButton = useRef<HTMLButtonElement>(null);
  const confirmationOrigin = useRef<HTMLElement | null>(null);
  const confirmationRestore = useRef(false);
  const closeConfirmation = () => { setTagConfirmation(null); confirmationRestore.current = true; };
  const filterChanged = (untagged = false) => {
    queryRevision.current++; locating.current = null; setFocus(null); dismissDelete(); setTagConfirmation(null);
    setUntaggedSnapshot(untagged ? new Set(untaggedIds) : null);
  };
  const eligible = (sticker: Sticker) => !sticker.searchTerms.trim() && !drafts.has(sticker.id) && !suggestions.has(sticker.id) && suggesting?.id !== sticker.id && !['working', 'queued'].includes(status.stickerTags?.[sticker.id]?.state ?? '')
    && !(status.stickerTagging?.state === 'running' && status.stickerTags?.[sticker.id]?.state === 'failed');
  const startTags = (ids: string[]) => { dismissDelete(); groups.closePopover(); if (ids.length > 20) { confirmationOrigin.current = document.activeElement as HTMLElement; setTagConfirmation(ids); } else if (ids.length) void act({ type: 'tagStickers', ids }); };
  const groups = useStickerGroups(status.state, groupAct, editMode, () => { dismissDelete(); setTagConfirmation(null); }, {
    untaggedActive: !!untaggedSnapshot,
    showUntagged: !!untaggedSnapshot || untaggedIds.size > 0,
    filterChanged, eligible, start: startTags, running: status.stickerTagging?.state === 'running',
    confirmation: tagConfirmation && <div className="sticker-select-bar" role="group" aria-label={`Tag ${tagConfirmation.length} stickers with ${providerName(status.state.provider)}?`}>
      <span>Tag {tagConfirmation.length} stickers with {providerName(status.state.provider)}?</span>
      <button ref={confirmationButton} className="primary" onClick={() => {
        const ids = tagConfirmation.filter(id => status.state.stickers.some(sticker => sticker.id === id && eligible(sticker)));
        if (ids.length) void act({ type: 'tagStickers', ids });
        closeConfirmation();
      }}>Tag</button><button className="quiet" onClick={closeConfirmation}>Cancel</button>
    </div>
  });
  useLayoutEffect(() => {
    if (tagConfirmation) confirmationButton.current?.focus();
    else if (confirmationRestore.current) {
      confirmationRestore.current = false;
      const origin = confirmationOrigin.current;
      (origin?.isConnected && origin !== document.body && !origin.matches(':disabled') ? origin : groups.barElement.current?.querySelector<HTMLElement>('.tag-ai, .tag-untagged, .select-all:not(:disabled)') ?? search.current)?.focus();
    }
  }, [tagConfirmation]);
  const [busyNotice, setBusyNotice] = useState('');
  const [dismissedStop, setDismissedStop] = useState<number | null>(null);
  const countId = useId();
  const [editor, setEditor] = useState<Editor | null>(null);
  // Filtering may hide an editor without discarding its sticker's unsaved text.
  // Every editor/panel exit goes through requestClose, including main's rail/menu requests.
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
  useEffect(() => {
    const request = suggestionRequest.current;
    if (!request) return;
    const item = status.stickerTags?.[request.id];
    if (item?.nonce === request.nonce) request.observed = true;
    if (!item && request.observed) { suggestionRequest.current = null; setSuggesting(null); return; }
    if (item?.nonce !== request.nonce || (item.state !== 'suggested' && item.state !== 'failed')) return;
    suggestionRequest.current = null; setSuggesting(null);
    if (item.state === 'suggested' && item.suggestion && all.some(s => s.id === request.id)) {
      revise(request.id);
      setDrafts(current => new Map(current).set(request.id, item.suggestion!.searchTerms));
      setSuggestions(current => new Map(current).set(request.id, {
        before: current.get(request.id)?.before ?? request.before,
        groups: item.suggestion!.groups.filter(id => !all.find(s => s.id === request.id)!.groups.includes(id))
      }));
    }
  }, [status.stickerTags, all]);
  useLayoutEffect(() => {
    if (untaggedSnapshot) setUntaggedSnapshot(current => {
      if (!current) return current;
      const added = all.filter(s => !s.searchTerms.trim() && !current.has(s.id));
      return added.length ? new Set([...current, ...added.map(s => s.id)]) : current;
    });
    // Once membership is saved (by bulk actions or elsewhere), it is no longer
    // a proposal that a later Save may silently restore.
    setSuggestions(current => {
      const next = new Map(current); let changed = false;
      for (const [id, suggestion] of current) {
        const sticker = all.find(s => s.id === id);
        if (!sticker) { next.delete(id); changed = true; continue; }
        const groups = suggestion.groups.filter(group => !sticker.groups.includes(group) && status.state.stickerGroups.some(g => g.id === group));
        if (groups.length !== suggestion.groups.length) { next.set(id, { ...suggestion, groups }); changed = true; }
      }
      return changed ? next : current;
    });
  }, [all, status.state.stickerGroups, untaggedSnapshot]);
  useEffect(() => () => {
    const pending = suggestionRequest.current;
    if (pending) void act({ type: 'removeStickerTag', id: pending.id });
  }, []);
  useEffect(() => { if (!editMode) { setUntaggedSnapshot(null); setTagConfirmation(null); } }, [editMode]);
  useLayoutEffect(() => {
    const pending = pendingDelete.current;
    if (pending) for (const id of pending.ids) if (!all.some(sticker => sticker.id === id)) pending.disappeared.add(id);
  }, [all]);
  // Status updates preserve order, so a send/lookup never moves a card under the pointer. A new query refreshes the lastSeen order.
  const order = useRef<{ query: string; ids: string[] }>({ query, ids: [] });
  const ordered = useMemo(() => {
    const byId = new Map(all.map(sticker => [sticker.id, sticker]));
    const known = new Set(query === order.current.query ? order.current.ids : []);
    const added = all.filter(sticker => !known.has(sticker.id)).sort((a, b) => b.lastSeen - a.lastSeen);
    order.current = { query, ids: [...order.current.ids.filter(id => known.has(id) && byId.has(id)), ...added.map(sticker => sticker.id)] };
    return order.current.ids.map(id => byId.get(id)!);
  }, [all, query]);
  const searchText = useRef(new Map<string, { source: string; normalized: string }>());
  const indexed = useMemo(() => {
    const next = new Map<string, { source: string; normalized: string }>();
    const entries = ordered.map(sticker => {
      const cached = searchText.current.get(sticker.id);
      const text = cached?.source === sticker.searchTerms ? cached : { source: sticker.searchTerms, normalized: normalizeSearch(sticker.searchTerms) };
      next.set(sticker.id, text);
      return { sticker, text: text.normalized };
    });
    searchText.current = next;
    return entries;
  }, [ordered]);
  const stickers = useMemo(() => {
    const terms = query.match(/"[^"]+"|\S+/g)?.map(term => normalizeSearch(term.replace(/^"|"$/g, ''))) ?? [];
    return indexed.filter(({ sticker, text }) => (!groups.filter || sticker.groups.includes(groups.filter)) && (!untaggedSnapshot || untaggedSnapshot.has(sticker.id) || !sticker.searchTerms.trim()) && terms.every(term => text.includes(term))).map(entry => entry.sticker);
  }, [indexed, query, groups.filter, untaggedSnapshot]);
  const visibleIds = useMemo(() => new Set(stickers.map(sticker => sticker.id)), [stickers]);
  const visible = useRef(visibleIds); visible.current = visibleIds;

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
  const latest = useRef({ editor, drafts, all, message, stickers }); latest.current = { editor, drafts, all, message, stickers };
  useEffect(() => {
    if (deleteQuestion?.kind === 'bar' && (deleteQuestion.ids.length !== groups.selected.size || deleteQuestion.ids.some(id => !groups.selected.has(id)))) dismissDelete();
  }, [groups.selected, deleteQuestion]);
  useEffect(() => { if (!editMode) dismissDelete(); }, [editMode]);
  // One detail row at a time: an open editor defers a message for another card.
  const visibleEditing = editing && visible.current.has(editing.id) ? editing : null;
  const editorQuestionVisible = !!visibleEditing && !visibleEditing.prompt && editMode;
  useLayoutEffect(() => {
    if (deleteQuestion?.kind === 'editor' && (!editorQuestionVisible || deleteQuestion.id !== visibleEditing?.id)) dismissDelete();
  }, [deleteQuestion, editorQuestionVisible, visibleEditing?.id]);
  const detailId = visibleEditing?.id ?? (editing?.prompt ? null : message?.id);
  const detailIndex = stickers.findIndex(s => s.id === detailId);
  const viewport = useStickerViewport(grid, stickers.length, columns, detailIndex, editMode);
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
  useLayoutEffect(() => { grid.current?.closest<HTMLElement>('.panel')?.scrollTo({ top: 0 }); viewport.refresh(); }, [query, groups.filter]);
  useEffect(() => { if (!busy && status.chat.stickerSendBlockedReason !== 'busy') setBusyNotice(''); }, [busy?.nonce, busy?.state, status.chat.stickerSendBlockedReason]);
  useEffect(() => { if (local && live?.nonce === local.nonce) setLocal(null); }, [local, live?.nonce]);
  useEffect(() => {
    setEditor(current => current && !all.some(s => s.id === current.id) ? null : current);
    setDrafts(current => {
      const saved = new Map(all.map(s => [s.id, s.searchTerms]));
      const retained = new Map([...current].filter(([id, text]) => saved.has(id) && (saved.get(id) !== text || saving.current.has(id) || suggestions.has(id))));
      // Changed saved terms never overwrite a user's draft; equal terms need no draft.
      return retained.size === current.size ? current : retained;
    });
  }, [all, suggestions]);
  useEffect(() => { if (stale) setHidden(send!.nonce); }, [stale]);
  // New send activity takes over the live region. Hiding/expiring an old result,
  // cancelling a deleted sticker's send, or clearing a busy warning must not
  // erase a later deletion announcement.
  useEffect(() => { if (send && all.some(sticker => sticker.id === send.id)) setDeletedNotice(''); }, [send?.nonce, send?.state]);
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
    // Mount an offscreen focus target before consuming the explicit action.
    if (typeof target !== 'string' && viewport.reveal(stickers.findIndex(sticker => sticker.id === target.id))) return;
    setFocus(null);
    const row = grid.current?.querySelector<HTMLElement>('.sticker-detail');
    const card = typeof target !== 'string' ? grid.current?.querySelector<HTMLElement>(`[data-sticker="${target.id}"]`) : null;
    const fallback = card?.querySelector<HTMLElement>('.sticker-art') ?? search.current;
    const element = (typeof target === 'string' ? target === 'search' ? search.current : groups.barElement.current?.querySelector<HTMLElement>(`.${target}`)
      : 'field' in target ? editing?.id === target.id ? row?.querySelector<HTMLElement>(target.field === 'textarea' ? 'textarea' : target.field === 'keep' ? '.discard button' : `.${target.field}`) : null
      : target.button === 'offer' ? row?.querySelector<HTMLElement>('.msg button')
      : target.button === 'last' ? [...(card?.querySelectorAll<HTMLElement>('button') ?? [])].at(-1)
      : card?.querySelector<HTMLElement>('.sticker-art')) ?? fallback;
    element?.focus({ preventScroll: typeof target !== 'string' && 'field' in target && !!target.open });
    if (element && typeof target !== 'string' && 'field' in target) {
      if (target.open && element instanceof HTMLTextAreaElement) element.setSelectionRange(element.value.length, element.value.length);
      if (target.scroll) row?.scrollIntoView({ block: 'nearest' });
    }
  }, [focus, viewport.first, viewport.last]);
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
    if (busy || status.chat.stickerSendBlockedReason === 'busy') { setDeletedNotice(''); setBusyNotice('Wait for the current sticker'); return false; }
    if (sendBlocked || !status.chat.destinationToken) return false;
    setBusyNotice(''); setDeletedNotice('');
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
  const cancelSuggestion = (id: string, notify = true) => {
    if (suggestionRequest.current?.id !== id) return;
    suggestionRequest.current = null; setSuggesting(null); if (notify) void act({ type: 'removeStickerTag', id });
  };
  const discardSuggestion = (id: string) => {
    const suggestion = suggestions.get(id);
    if (!suggestion) return;
    revise(id);
    setDrafts(current => {
      const next = new Map(current);
      if (suggestion.before === all.find(sticker => sticker.id === id)?.searchTerms) next.delete(id);
      else next.set(id, suggestion.before);
      return next;
    });
    setSuggestions(current => { const next = new Map(current); next.delete(id); return next; });
    void act({ type: 'removeStickerTag', id });
  };
  const clearDraft = (id: string) => {
    cancelSuggestion(id);
    setSuggestions(current => { const next = new Map(current); next.delete(id); return next; });
    setDrafts(current => { if (!current.has(id)) return current; const next = new Map(current); next.delete(id); return next; });
  };
  function dismissDelete() {
    if (deleteQuestion?.kind === 'bar' && deleteQuestion.auto) groups.removeSelection(deleteQuestion.auto);
    setDeleteQuestion(null);
  }
  const keepDelete = () => {
    if (!deleteQuestion || deleteLock.current) return;
    dismissDelete();
    if (deleteQuestion.kind === 'editor') setFocus({ id: deleteQuestion.id, field: 'delete-trigger' });
    else {
      setFocus(deleteQuestion.from ? { id: deleteQuestion.from, button: 'tile' } : 'delete-trigger');
    }
  };
  const askDelete = (from?: string) => {
    if (deleteLock.current) return;
    // Reopening the same question keeps ownership of its temporary selection
    // and the original return-focus target, including through the trash action.
    if (deleteQuestion?.kind === 'bar') { setFocus('delete-keep'); return; }
    groups.closePopover();
    const ids = all.filter(sticker => groups.selected.has(sticker.id)).map(sticker => sticker.id);
    const auto = !ids.length ? from : undefined;
    if (auto) { groups.toggleSelection(auto); ids.push(auto); }
    if (!ids.length) return;
    editorSession.current++;
    setDeleteQuestion({ kind: 'bar', ids, from, auto });
    setFocus('delete-keep');
  };
  const remove = async (ids: string[], single = false) => {
    if (deleteLock.current) return;
    deleteLock.current = true; setDeleting(true);
    const source = document.activeElement;
    editorSession.current++;
    const selectionRevision = groups.selectionRevision.current, question = deleteQuestion;
    const deletedEditor = grid.current?.querySelector('.sticker-detail');
    const request = { ids, disappeared: new Set<string>() }; pendingDelete.current = request;
    const removed = new Set(ids), at = stickers.findIndex(sticker => removed.has(sticker.id));
    setDeletedNotice(''); setBusyNotice('');
    let ok = false;
    try { ok = await act(single ? { type: 'forgetSticker', id: ids[0] } : { type: 'forgetStickers', ids }); }
    finally { pendingDelete.current = null; deleteLock.current = false; setDeleting(false); }
    if (!ok) return;
    setDeletedNotice(`${ids.length} sticker${ids.length === 1 ? '' : 's'} deleted`);
    setDeletionSequence(sequence => sequence + 1);
    // An identity removed and reindexed before this acknowledgement belongs to
    // a new library visit. Preserve its newer editor/draft as well.
    for (const id of request.disappeared) if (latest.current.all.some(sticker => sticker.id === id)) removed.delete(id);
    // Cleanup belongs to deleted identities, not to whichever editor is now open.
    const active = document.activeElement;
    const activeTile = active?.closest<HTMLElement>('[data-sticker]')?.dataset.sticker;
    const inDeletedEditor = !!active?.closest('.sticker-detail') && !!latest.current.editor && removed.has(latest.current.editor.id);
    const onRemovedControl = !!active && (!active.isConnected && (active === source || deletedEditor?.contains(active)) || !!activeTile && removed.has(activeTile) || inDeletedEditor);
    if (latest.current.message && removed.has(latest.current.message.id)) setHidden(latest.current.message.nonce);
    // Confirming deletion explicitly discards that sticker's draft, never a surviving sticker's.
    for (const id of removed) { clearDraft(id); saving.current.delete(id); }
    if (locating.current && removed.has(locating.current.id)) locating.current = null;
    setEditor(current => current && removed.has(current.id) ? null : current);
    if (deleteQuestionRef.current === question) setDeleteQuestion(null);
    groups.completeDeletion(selectionRevision);
    const after = latest.current.stickers.filter(sticker => !removed.has(sticker.id));
    const next = after[at] ?? after.at(-1);
    const onConfirmation = active?.closest('.sticker-select-bar[aria-label], .actions.confirm');
    if (active === source || onConfirmation && deleteQuestionRef.current === question || onRemovedControl || !active || active === document.body) setFocus(next ? { id: next.id, button: 'tile' } : 'search');
  };
  const open = (id: string) => {
    dismissDelete();
    editorSession.current++;
    locating.current = null;
    // Opening any editor withdraws an offer to send; a plain failure follows its own card into the editor.
    if (message && (message.id !== id || offer(message))) setHidden(message.nonce);
    setEditor({ id });
    setFocus({ id, field: 'textarea', open: true, scroll: true });
  };
  const leave = (exit: Exit) => {
    groups.reset(); setEditMode(false);
    if (exit === 'providers' && openProviders) openProviders();
    else if (exit !== 'done') void act({ type: 'panel', panel: exit === 'panel' ? null : exit === 'providers' ? 'settings' : exit });
  };
  const finish = (closing: string, next: string | null, returnFocus = true, exit?: Exit) => {
    editorSession.current++;
    locating.current = null;
    clearDraft(closing);
    if (status.stickerTags?.[closing]?.nonce) void act({ type: 'removeStickerTag', id: closing });
    if (latest.current.message?.id === closing) setHidden(latest.current.message.nonce);
    if (exit) leave(exit);
    if (next && all.some(s => s.id === next)) open(next);
    else { setEditor(current => current?.id === closing ? null : current); if (returnFocus) setFocus({ id: closing, button: 'tile' }); }
  };
  const requestClose = (next: string | null, exit?: Exit) => {
    dismissDelete();
    editorSession.current++;
    if (editing) cancelSuggestion(editing.id);
    if (!editing) { if (exit) leave(exit); return; }
    locating.current = null;
    if (editingSticker && (editing.text !== editingSticker.searchTerms || suggestions.has(editing.id))) { setEditor({ id: editing.id, prompt: { next, exit } }); setFocus({ id: editing.id, field: 'keep', scroll: true }); }
    else finish(editing.id, next, true, exit);
  };
  const keep = () => {
    editorSession.current++;
    // A detached prompt must lead back to an editable, visible draft.
    if (editing && !visible.current.has(editing.id)) { filterChanged(); setQuery(''); groups.showAll(); }
    setEditor(current => current && { id: current.id });
    if (editing) setFocus({ id: editing.id, field: 'textarea', scroll: true });
  };
  useLayoutEffect(() => {
    if (navigation) navigation.current = panel => { if (panel !== 'stickers') requestClose(null, panel ?? 'panel'); };
    return () => { if (navigation) navigation.current = null; };
  });
  const toggle = (id: string) => { if (editing) requestClose(editing.id === id ? null : id); else open(id); };

  const escape = useRef<() => boolean>(() => false);
  escape.current = () => {
    if (tagConfirmation) { closeConfirmation(); return true; }
    if (suggesting) { cancelSuggestion(suggesting.id); return true; }
    if (deleteQuestion && (deleteQuestion.kind === 'bar' ? editMode : editorQuestionVisible)) { keepDelete(); return true; }
    if (groups.closePopover()) return true;
    if (document.activeElement === search.current && query) { filterChanged(); setQuery(''); return true; }
    if (editing?.prompt) { keep(); return true; }
    if (visibleEditing) { requestClose(null); return true; }
    if (groups.cancelInline()) return true;
    if (groups.clearSelection(true)) return true;
    if (editMode) { requestClose(null, 'done'); return true; }
    // Also guard a draft if a panel-level Escape reaches us outside edit mode.
    if (editing && editingSticker && editing.text !== editingSticker.searchTerms) { requestClose(null, 'panel'); return true; }
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
    if (editing && editingSticker && (visibleEditing || editing.prompt)) return <StickerEditor key={`editor-${editing.id}`} col={col} detached={!visibleEditing} sticker={editingSticker} groupControls={<StickerGroupToggles groups={status.state.stickerGroups} sticker={editingSticker} act={groupAct} membershipChanged={() => revise(editing.id)} suggested={suggestions.get(editing.id)?.groups.filter(id => !editingSticker.groups.includes(id))} dropSuggested={id => setSuggestions(current => {
      const next = new Map(current), suggestion = next.get(editing.id); if (suggestion) next.set(editing.id, { ...suggestion, groups: suggestion.groups.filter(group => group !== id) }); return next;
    })}/>} draft={editing} location={status.stickerLocation} message={message?.id === editing.id ? message : null} retry={retry} sendBlocked={sendBlocked}
      suggested={suggestions.has(editing.id)} tagBusy={suggesting?.id === editing.id || ['working', 'queued'].includes(status.stickerTags?.[editing.id]?.state ?? '')} tagQueued={!suggesting && ['working', 'queued'].includes(status.stickerTags?.[editing.id]?.state ?? '')}
      tagError={status.stickerTags?.[editing.id]?.error} provider={status.stickerTags?.[editing.id]?.provider ?? status.state.provider}
      tagSettings={() => requestClose(null, 'providers')} discardSuggestion={() => discardSuggestion(editing.id)}
      suggest={() => {
        if (suggestionRequest.current?.id === editing.id) { cancelSuggestion(editing.id); return; }
        if (['working', 'queued'].includes(status.stickerTags?.[editing.id]?.state ?? '')) return;
        const request = { id: editing.id, nonce: crypto.randomUUID(), before: suggestions.get(editing.id)?.before ?? editing.text };
        revise(editing.id);
        suggestionRequest.current = request; setSuggesting(request);
        void act({ type: 'suggestStickerTags', id: request.id, nonce: request.nonce, searchTerms: editing.text }).then(ok => { if (!ok && suggestionRequest.current === request) { suggestionRequest.current = null; setSuggesting(null); } });
      }}
      change={text => {
        revise(editing.id);
        cancelSuggestion(editing.id, false); void act({ type: 'removeStickerTag', id: editing.id });
        setDrafts(current => {
          const next = new Map(current);
          if (text === editingSticker.searchTerms && !saving.current.has(editing.id) && !suggestions.has(editing.id)) next.delete(editing.id); else next.set(editing.id, text);
          return next;
        });
        setEditor({ id: editing.id });
      }} close={() => requestClose(null)} keep={keep} discard={() => finish(editing.id, editing.prompt?.next ?? null, true, editing.prompt?.exit)}
      save={async () => {
        const source = document.activeElement;
        const session = editorSession.current, revision = queryRevision.current, editRevision = editRevisions.current.get(editing.id);
        const { id, text } = editing;
        const beforeGroups = editingSticker.groups;
        const addedGroups = suggestions.get(id)?.groups ?? [];
        const expectedGroups = [...new Set([...beforeGroups, ...addedGroups])];
        const request = Symbol(); saving.current.set(id, request);
        const ok = await act({ type: 'sticker', id, searchTerms: text, ...(suggestions.has(id) ? { addGroups: suggestions.get(id)!.groups } : {}) });
        const currentRequest = saving.current.get(id) === request;
        if (currentRequest) saving.current.delete(id);
        if (!ok || !currentRequest) return;
        const current = latest.current;
        const currentText = current.drafts.get(id) ?? current.all.find(s => s.id === id)?.searchTerms;
        const currentGroups = current.all.find(s => s.id === id)?.groups ?? [];
        const sameGroups = (groups: string[]) => groups.length === currentGroups.length && groups.every(group => currentGroups.includes(group));
        // Allow this Save's own published additions, but never close over other
        // membership changes or a later text/group/suggestion revision.
        if (currentText === text && (sameGroups(beforeGroups) || sameGroups(expectedGroups)) && current.editor?.id === id && editorSession.current === session && queryRevision.current === revision && editRevisions.current.get(id) === editRevision) {
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
      deleting={deleting} confirmDelete={deleteQuestion?.kind === 'editor' && deleteQuestion.id === editing.id}
      askDelete={() => {
        if (deleteLock.current) return;
        dismissDelete();
        editorSession.current++;
        groups.closePopover(); setDeleteQuestion({ kind: 'editor', id: editing.id }); setFocus({ id: editing.id, field: 'delete-keep' });
      }} keepDelete={keepDelete} forget={() => void remove([editing.id], true)}/>;
    if (message) return <div key={`message-${message.nonce}`} className="sticker-detail sticker-message" role="region" aria-label="Send result" style={{ '--col': col } as React.CSSProperties}>
      <MessageBody message={message} retry={retry} sendBlocked={sendBlocked} dismiss={() => dismiss(message.id)}/>
    </div>;
    return null;
  };

  // Stable tile handlers read the latest panel state, including send permissions.
  // Editor/group input changes therefore never invalidate healthy tile props.
  const tileActions = useRef({ click: (_event: React.MouseEvent, _id: string) => {}, select: (_id: string) => {}, image: (_id: string, _ok: boolean) => {}, cancel });
  tileActions.current = {
    click: (event, id) => {
      if (!editMode && (busy || status.chat.stickerSendBlockedReason === 'busy')) { start(event, id); return; }
      if (editMode) { if (event.ctrlKey || event.metaKey) groups.toggleSelection(id); else toggle(id); return; }
      if (broken.has(id)) { setImageRevisions(previous => new Map(previous).set(id, (previous.get(id) ?? 0) + 1)); return; }
      start(event, id);
    },
    select: groups.toggleSelection,
    image: (id, ok) => setBroken(previous => {
      if (previous.has(id) === !ok) return previous;
      const next = new Set(previous); if (ok) next.delete(id); else next.add(id); return next;
    }), cancel
  };
  const handlers = useMemo<TileHandlers>(() => ({
    click: (event, id) => tileActions.current.click(event, id),
    select: id => tileActions.current.select(id),
    image: (id, ok) => tileActions.current.image(id, ok),
    cancel: () => tileActions.current.cancel()
  }), []);
  const navigate = (event: React.KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const button = event.target as HTMLElement;
    const detailRow = button.closest('.sticker-detail');
    if (detailRow && event.key === 'Tab' && detailIndex >= 0) {
      const controls = [...detailRow.querySelectorAll<HTMLElement>(':is(button, input, textarea):not(:disabled)')];
      const edge = button === controls[event.shiftKey ? 0 : controls.length - 1];
      const rowEnd = Math.min(detailIndex - detailIndex % columns + columns - 1, stickers.length - 1);
      const next = event.shiftKey ? rowEnd : rowEnd + 1;
      if (edge && next < stickers.length && !grid.current?.querySelector(`[data-sticker="${stickers[next].id}"]`)) {
        event.preventDefault(); setFocus({ id: stickers[next].id, button: event.shiftKey ? 'last' : 'tile' });
      }
      return;
    }
    if (!button.matches('.sticker-art, .sticker-pick, .cancel-send')) return;
    const index = stickers.findIndex(sticker => sticker.id === button.closest<HTMLElement>('[data-sticker]')?.dataset.sticker);
    if (editMode && (event.key === 'Delete' || event.key === 'Backspace') && button.matches('.sticker-art, .sticker-pick')) {
      event.preventDefault(); askDelete(stickers[index].id); return;
    }
    const step = event.key === 'ArrowDown' ? columns : event.key === 'ArrowUp' ? -columns : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step) {
      const next = Math.max(0, Math.min(stickers.length - 1, index + step));
      event.preventDefault(); setFocus({ id: stickers[next].id, button: 'tile' });
    } else if (event.key === 'Tab') {
      // Preserve native tab order within a card/detail. Bridge only a window edge.
      const direction = event.shiftKey ? -1 : 1, next = index + direction;
      const siblings = [...button.closest<HTMLElement>('[data-sticker]')!.querySelectorAll<HTMLElement>('button')];
      const edge = button === siblings[event.shiftKey ? 0 : siblings.length - 1];
      const detailBetween = detailIndex >= 0 && (event.shiftKey ? Math.floor(next / columns) : Math.floor(index / columns)) === Math.floor(detailIndex / columns) && (event.shiftKey ? next % columns === columns - 1 : (index + 1) % columns === 0);
      if (edge && !detailBetween && next >= 0 && next < stickers.length && !grid.current?.querySelector(`[data-sticker="${stickers[next].id}"]`)) {
        event.preventDefault(); setFocus({ id: stickers[next].id, button: event.shiftKey ? 'last' : 'tile' });
      }
    }
  };
  const gridContent = useMemo(() => {
    const nodes: React.ReactNode[] = [];
    const detailRow = detailIndex < 0 ? -1 : Math.floor(detailIndex / columns);
    let skipped = 0;
    const flush = (key: number) => {
      if (skipped) nodes.push(<div key={`space-${key}`} className="sticker-spacer" aria-hidden="true" style={{ height: skipped * viewport.stride - 8 }}/>);
      skipped = 0;
    };
    for (let row = 0; row < viewport.rows; row++) {
      if (row >= viewport.first && row < viewport.last) {
        flush(row);
        for (let i = row * columns; i < Math.min((row + 1) * columns, stickers.length); i++) {
          const sticker = stickers[i];
          nodes.push(<StickerTile key={sticker.id} sticker={sticker} handlers={handlers} editMode={editMode} selected={groups.selected.has(sticker.id)} attached={detailId === sticker.id} expanded={visibleEditing?.id === sticker.id}
            tagState={status.stickerTags?.[sticker.id]?.state} imageBroken={broken.has(sticker.id)} imageRevision={imageRevisions.get(sticker.id) ?? 0} feedback={shown?.id === sticker.id ? shown.state : null} sentName={shown?.id === sticker.id ? shown.name : ''}
            busyState={busy?.id === sticker.id ? busy.state : null} canCancel={cancellable(busy) && busy?.id === sticker.id}
            tileDisabled={!broken.has(sticker.id) && !editMode && !busy && (!status.chat.canSendSticker || !status.chat.destinationToken) && status.chat.stickerSendBlockedReason !== 'busy'}/>);
        }
      } else skipped++;
      if (row === detailRow) { flush(row + 1); nodes.push('detail'); }
    }
    flush(viewport.rows);
    return nodes;
  }, [stickers, columns, viewport.first, viewport.last, viewport.rows, viewport.stride, detailIndex, detailId, handlers, editMode, groups.selected,
    visibleEditing?.id, broken, imageRevisions, shown?.id, shown?.state, shown?.name, busy?.id, busy?.state,
    status.chat.canSendSticker, status.chat.destinationToken, status.chat.stickerSendBlockedReason, status.stickerTags]);

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
        <button className="back" data-preserve-auto="" aria-label="Close panel" onClick={() => requestClose(null, 'panel')}><BackIcon/></button>
        <h1>Stickers</h1>
        <div className="sticker-search" style={{ '--count-width': `${count.length}ch` } as React.CSSProperties}>
          <input ref={search} className="search" aria-label="Search stickers" aria-describedby={countId} placeholder="Search" value={query} onChange={e => { filterChanged(); setQuery(e.target.value); }}/>
          <span className="count" aria-hidden="true">{count}</span><span className="sr-only" id={countId}>{all.length} stickers indexed</span>
        </div>
        <button className={`sticker-mode${editMode ? ' mode-done' : ''}`} aria-label={editMode ? undefined : 'Edit stickers'} title={editMode ? undefined : 'Edit stickers'} onClick={() => editMode ? requestClose(null, 'done') : setEditMode(true)}>{editMode ? 'Done' : <EditIcon/>}</button>
      </div>
      {groups.header}
      <TagStrip status={status} act={act} settings={() => requestClose(null, 'providers')} retry={() => void act({ type: 'retryStickerTags', excludedIds: [...new Set([...drafts.keys(), ...suggestions.keys(), ...(suggesting ? [suggesting.id] : [])])] })}/>
      {strip && <p className="sticker-strip"><span>{strip}</span></p>}
      {stopReason && dismissedStop !== stopAt && <p className="sticker-strip warn" role="status"><span>Direct sending turned off: {stopReasons[stopReason]} Stickers go through WhatsApp’s editor again. <a href="#ai-settings" onClick={e => { e.preventDefault(); requestClose(null, 'settings'); }}>AI settings</a></span><button className="icon-close" aria-label="Dismiss direct-send notice" onClick={() => setDismissedStop(stopAt)}>×</button></p>}
    </header>
    <div className="panel-body sticker-body" data-mode={editMode ? 'edit' : 'normal'}>
      {status.pending && <div className="pending"><b>Scheduled reply</b><p>{status.pending.text}</p><p>After {new Date(status.pending.due).toLocaleTimeString()}</p><button onClick={() => void act({ type: 'cancelAuto' })}>Cancel and pause</button></div>}
      <p className="sr-only" aria-live="polite" aria-atomic="true">{deletedNotice ? <span key={deletionSequence}>{deletedNotice}</span> : busyNotice || (shown ? announcement(shown) : '')}</p>
      {!stickers.length && <div className="empty"><span aria-hidden="true">▧</span><p>{groupName ? `${query ? 'No matches' : 'No stickers'} in ${groupName}` : query ? 'No matching stickers' : 'Your stickers will appear here'}</p>{groups.filter ? <button onClick={groups.showAll}>{query ? 'Search all groups' : 'Show all groups'}</button> : query ? <small>Try another word or phrase.</small> : !status.state.hasForgotten && !deletionSequence && <small>Open WhatsApp’s sticker picker and select Favorites. Wait for your stickers to load.</small>}</div>}
      <div className="sticker-grid" ref={grid} style={{ '--cols': columns } as React.CSSProperties} onKeyDown={navigate}>
        {gridContent.map(node => node === 'detail' ? detail(detailIndex) : node)}
        {editing?.prompt && !visibleEditing && detail(0)}
      </div>
    </div>
    {groups.bar(stickers, { confirming: deleteQuestion?.kind === 'bar', discardingDraft: deleteQuestion?.kind === 'bar' && deleteQuestion.ids.some(id => drafts.has(id) && drafts.get(id) !== all.find(sticker => sticker.id === id)?.searchTerms), busy: deleting, open: () => askDelete(), keep: keepDelete, remove: () => { if (deleteQuestion?.kind === 'bar') void remove(deleteQuestion.ids); } })}
  </>;
}

const normalizeSearch = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
type TileHandlers = { click: (event: React.MouseEvent, id: string) => void; select: (id: string) => void; image: (id: string, ok: boolean) => void; cancel: () => void };
const StickerTile = memo(function StickerTile({ sticker, handlers, editMode, selected, attached, expanded, imageBroken, imageRevision, feedback, sentName, busyState, canCancel, tileDisabled, tagState }: {
  tagState?: import('../shared/model').StickerTagItem['state']; sticker: Sticker; handlers: TileHandlers; editMode: boolean; selected: boolean; attached: boolean; expanded: boolean; imageBroken: boolean; imageRevision: number;
  feedback: StickerSend['state'] | null; sentName: string; busyState: StickerSend['state'] | null; canCancel: boolean; tileDisabled: boolean;
}) {
  const own = feedback;
  const ownBusy = busyState;
  const name = sticker.searchTerms.slice(0, 120) || 'Sticker without search terms';
  const label = ownBusy ? 'Sending sticker…' : tagState === 'working' ? 'Tagging…' : tagState === 'failed' ? 'Couldn’t tag' : editMode ? name : own === 'sent' ? `Sent to ${sentName}` : own === 'cancelled' ? 'Cancelled' : imageBroken ? 'Image unavailable. Retry' : name;
  return <div className="sticker" role="group" data-sticker={sticker.id} aria-label={sticker.searchTerms.slice(0, 120) || 'Sticker without search terms'} data-selected={selected ? '' : undefined} data-attached={attached ? '' : undefined}>
    <button className={`sticker-art${!sticker.searchTerms.trim() ? ' untagged' : ''}`} aria-label={label} title={sticker.searchTerms || undefined}
      data-tag={tagState} aria-expanded={editMode ? expanded : undefined} aria-disabled={tileDisabled || undefined} data-busy={ownBusy ? '' : undefined} data-sent={own === 'sent' ? '' : undefined} data-cancelled={own === 'cancelled' ? '' : undefined} data-broken={imageBroken || undefined}
      onClick={e => handlers.click(e, sticker.id)}>
      <img key={`${sticker.id}-${imageRevision}`} src={stickerURL(sticker.id)} loading="lazy" decoding="async" alt="" draggable={false} onError={() => handlers.image(sticker.id, false)} onLoad={() => handlers.image(sticker.id, true)}/>
      {imageBroken && !ownBusy && own !== 'sent' && own !== 'cancelled' && <span className="sticker-overlay broken" aria-hidden="true"><svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" strokeWidth="1.6" d="M4 5.5h16v13H4zM4 15l4.5-4.5 3.5 3.5 2.5-2.5L20 17"/></svg><b>Retry</b></span>}
      {ownBusy && <span className="sticker-overlay" aria-hidden="true"><span className="spinner"/>Sending…</span>}
      {own === 'sent' && <span className="sticker-overlay" aria-hidden="true"><span className="done"><CheckIcon/></span>Sent</span>}
      {own === 'cancelled' && <span className="sticker-overlay muted" aria-hidden="true">Cancelled</span>}
      {!ownBusy && tagState === 'working' && <span className="sticker-overlay" aria-hidden="true"><TagDots/></span>}
      {!ownBusy && tagState === 'done' && <span className="sticker-overlay" aria-hidden="true"><span className="done"><CheckIcon/></span></span>}
      {tagState === 'failed' && <span className="mark" aria-hidden="true">!</span>}
      {(own === 'failed' || own === 'missing') && <span className="mark" aria-hidden="true">!</span>}
    </button>
    {editMode && <button className="sticker-pick" role="checkbox" aria-checked={selected} aria-label={`Select ${name}`} onClick={() => handlers.select(sticker.id)}><CheckIcon/></button>}
    {canCancel && <button className="cancel-send" aria-label="Cancel sending" title="Cancel sending" onClick={handlers.cancel}>×</button>}
  </div>;
});

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

function StickerEditor({ col, detached, sticker, groupControls, draft, location, message, retry, sendBlocked, change, close, keep, discard, save, locate, forget, confirmDelete, deleting, askDelete, keepDelete, suggested, tagBusy, tagQueued, tagError, provider, suggest, tagSettings, discardSuggestion }: {
  suggested: boolean; tagBusy: boolean; tagQueued: boolean; tagError?: import('../shared/model').StickerTagError; provider: import('../shared/model').Provider;
  suggest(): void; tagSettings(): void; discardSuggestion(): void;
  col: number; detached: boolean; sticker: Sticker; groupControls: React.ReactNode; draft: Draft; location: Status['stickerLocation']; message: StickerSend | null;
  retry: (event: React.MouseEvent, send: StickerSend, original?: boolean) => void;
  sendBlocked: boolean;
  change: (text: string) => void; close: () => void; keep: () => void; discard: () => void;
  save: () => void; locate: () => void; forget: () => void; confirmDelete: boolean; deleting: boolean; askDelete: () => void; keepDelete: () => void;
}) {
  const id = useId();
  const result = location?.id === sticker.id ? location.state : null;
  return <div className="sticker-detail" data-detached={detached || undefined} style={{ '--col': col } as React.CSSProperties} role="region" aria-label="Search terms">
    <div className="detail-head"><label htmlFor={id}>Search terms</label><div className="detail-tools"><button className="detail-ai" aria-disabled={tagQueued || undefined} aria-label={tagQueued ? 'Tagging…' : tagBusy ? 'Stop suggestion' : 'Suggest search terms'} title={tagQueued ? 'Tagging…' : tagBusy ? 'Stop suggestion' : 'Suggest search terms'} onClick={suggest}>{tagBusy ? <TagDots/> : <SparkIcon/>}</button><button className="icon-close" aria-label="Close" title="Close" onClick={close}>×</button></div></div>
    {/* Closing the editor clears the message, so it has no Dismiss of its own here. */}
    {message && <div className="sticker-message inline"><MessageBody message={message} retry={retry} sendBlocked={sendBlocked}/></div>}
    <p className="sr-only" aria-live="polite" aria-atomic="true">{tagError ? tagErrorMessage(tagError, provider) : ''}</p>
    {tagError && <div className="sticker-message inline"><span className="mark" aria-hidden="true">!</span><div className="msg"><p>{tagErrorMessage(tagError, provider)}</p><button onClick={tagSettingsError(tagError) ? tagSettings : suggest}>{tagSettingsError(tagError) ? 'AI settings' : 'Try again'}</button></div></div>}
    <textarea data-suggested={suggested || undefined} id={id} value={draft.text} maxLength={4000} rows={4} onChange={e => change(e.target.value)} placeholder="happy, feliz, good morning, buenos días"/>
    {!draft.prompt && groupControls}
    {draft.prompt
      ? <div className="discard" role="group" aria-label="Discard changes?"><span aria-hidden="true">Discard changes?</span><button onClick={keep}>Keep editing</button><button className="quiet" onClick={discard}>Discard</button></div>
      : confirmDelete ? <div className="actions confirm" role="group" aria-label="Delete this sticker?"><span>Delete this sticker?{draft.text !== sticker.searchTerms && ' Unsaved changes will be discarded.'}</span><button className="primary" aria-busy={deleting || undefined} aria-disabled={deleting || undefined} onClick={forget}>Delete</button><button className="quiet delete-keep" disabled={deleting} onClick={keepDelete}>Keep</button></div>
      : suggested ? <div className="actions"><button className="primary" onClick={save}>Save</button><button className="quiet" onClick={discardSuggestion}>Discard</button></div>
      : <div className="actions"><button className="primary" disabled={draft.text === sticker.searchTerms} onClick={save}>Save</button><button onClick={locate}>Locate in WhatsApp</button><button className="icon-btn delete-trigger" aria-label="Delete sticker" title="Delete sticker" onClick={askDelete}><TrashIcon/></button></div>}
    {result && !draft.prompt && !confirmDelete && <p className="sticker-location" role="status">{locationMessages[result]}</p>}
  </div>;
}
