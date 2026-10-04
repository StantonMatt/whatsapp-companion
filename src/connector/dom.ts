import { readDraft, composerProvablyEmpty } from './draft';
export { readDraft } from './draft';
import { messageDirection, fallbackDirection, ownElements, quoteSelector, peerFromMessageId } from './message-direction';
export { peerFromMessageId } from './message-direction';
import { StickerReadiness } from '../core/sticker-readiness';
import type { StickerAuthorization } from '../shared/sticker-transfer';
import { StickerTransferConnector } from './sticker-transfer';
import { stickerImageState } from './sticker-image-state';
import { composerStyle } from './composer-style';
import { StickerPickerLayout } from './sticker-picker-layout';
import { captureStickerPicker } from './sticker-picker-capture';
import { Navigation } from './navigation';
import { MAX_STICKER_BYTES } from '../shared/sticker-limits';
import { readChatTitle } from '../shared/chat-title';
import type { Snapshot, Message } from '../shared/model';
import { snapshotKey, suggestionKey } from '../core/suggestions';
import type { RemoteCommand, RemoteEvent, AccountSafetyReason } from '../shared/connector';

const textSelector = '.selectable-text.copyable-text, [data-testid="msg-text"], [data-testid="selectable-text"]';
function visible(element: Element | null): boolean {
  if (!element) return false;
  const bounds = element.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return false;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden') return false;
  }
  return true;
}
// Only inspect account UI containers, never message bodies, QR contents or
// exception text. The only data crossing IPC is an allowlisted reason.
export function accountSafetyReason(doc: Document): AccountSafetyReason {
  const warnings = '[role="dialog"], [role="alertdialog"], [role="alert"], [role="banner"], [data-testid="popup-contents"], [data-testid="banner"], [data-testid="account-warning"], [data-testid="account-restriction"]';
  const phrases = /\b(?:temporarily banned|unusual activity|banned from using whatsapp|account (?:(?:is|was|has been)(?: temporarily)? )?(?:restricted|banned|suspended|blocked)|cuenta (?:(?:esta|fue|ha sido|se ha)(?: temporalmente)? )?(?:restringida|suspendida|bloqueada|baneada)|conta (?:(?:esta|foi)(?: temporariamente)? )?(?:restrita|banida|suspensa|bloqueada))\b/i;
  const noticeText = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (!(node instanceof Element)) return '';
    if (node.matches('[data-id], [data-testid="msg-container"], [role="textbox"], script, style, [hidden], [aria-hidden="true"]')) return '';
    const css = getComputedStyle(node);
    if (css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse' || css.contentVisibility === 'hidden') return '';
    return [...node.childNodes].map(noticeText).join(' ');
  };
  for (const node of doc.querySelectorAll(warnings)) {
    if (node.closest('[data-id], [data-testid="msg-container"], [role="textbox"]') || !visible(node)) continue;
    const text = noticeText(node).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
    if (phrases.test(text)) return 'account-warning';
  }
  const login = '[data-testid="qrcode"], [data-testid="qr-code"], [data-testid="login-qr-code"], [data-testid="link-device"], [data-testid="logged-out"], .landing-wrapper, [data-ref]';
  for (const node of doc.querySelectorAll(login)) {
    if (node.closest('[data-id]') || !visible(node)) continue;
    if (node.hasAttribute('data-ref') && !node.querySelector('canvas, img')) continue;
    return 'logged-out';
  }
  return null;
}
function senderLabel(node: HTMLElement): string | undefined {
  const author = ownElements(node, '[data-testid="author"]')[0];
  const label = author ? readDraft(author) : ownElements(node, '[data-pre-plain-text]').map(el => /^\[[^\]]+\]\s*(.+):\s*$/.exec(el.getAttribute('data-pre-plain-text') ?? '')?.[1]).find(Boolean);
  return label?.trim().slice(0, 150) || undefined;
}
function messageAttachment(node: HTMLElement): Message['attachment'] {
  // Observe media type only. Never fetch URLs, upload bytes or mistake avatars/emoji for photos.
  // A document's preview belongs to the file card, not a separate photo message.
  if (ownElements(node, '[data-testid="document-thumb"]').length) return 'document';
  if (ownElements(node, '[data-testid="sticker-container"]').length) return 'sticker';
  if (ownElements(node, '[data-testid="ptt-status"], [data-icon="ptt-status"], audio').length) return 'audio';
  if (ownElements(node, 'video, [data-testid="video-thumb"], [data-testid="video-content"]').length) return 'video';
  if (ownElements(node, '[data-testid="image-thumb"]').length) return 'image';
  return undefined;
}
function attachmentName(node: HTMLElement): string | undefined {
  // Read only the visible filename, not the preview, download URL or localized action title.
  return ownElements(node, '[data-testid="document-thumb"] span[dir="auto"]')[0]?.textContent?.trim().slice(0, 255) || undefined;
}
function messageText(node: HTMLElement) {
  const text = ownElements(node, textSelector).filter(n => !n.parentElement?.closest(textSelector));
  const emoji = ownElements(node, 'img[alt], [data-plain-text]').filter(n => !n.closest(textSelector) &&
    !n.parentElement?.closest('[data-plain-text]') && !n.closest('[data-testid="author"], [data-testid*="thumb"], [data-testid="sticker-container"], [data-testid*="reaction"]') &&
    // Emoji text only: photo/document alt labels are not message bodies.
    /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\ufe0f?\u20e3/u.test(n.getAttribute('data-plain-text') || n.getAttribute('alt') || '') &&
    /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[\u200d\ufe0e\ufe0f\u20e3\s0-9#*])+$/u.test(n.getAttribute('data-plain-text') || n.getAttribute('alt') || ''));
  return [...text, ...emoji].sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1).map(n => readDraft(n)).join('\n').slice(0, 4000);
}
function quotedMessage(node: HTMLElement): Message['quoted'] {
  const quote = node.querySelector<HTMLElement>(quoteSelector);
  if (!quote) return undefined;
  const sender = senderLabel(quote), attachment = messageAttachment(quote), name = attachmentName(quote);
  return { text: messageText(quote), ...(sender ? { sender } : {}), ...(attachment ? { attachment } : {}), ...(name ? { attachmentName: name } : {}) };
}
export function caretAtEnd(editor: HTMLElement): boolean {
  const selection = editor.ownerDocument.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed || !editor.contains(selection.anchorNode)) return false;
  if (!readDraft(editor)) return true; // Empty paragraph + BR is a contenteditable placeholder.
  const terminalPlaceholder = (node: Node): boolean => {
    if (!(node instanceof Element) || node.tagName !== 'BR') return false;
    while (node !== editor) {
      for (let next = node.nextSibling; next; next = next.nextSibling) {
        if (next.nodeType !== 3 || next.textContent?.replace(/\u200b/g, '')) return false;
      }
      if (!node.parentNode) return false;
      node = node.parentNode;
    }
    return true;
  };
  const hasContent = (node: Node): boolean => {
    if (node.nodeType === 3) return Boolean(node.textContent?.replace(/\u200b/g, ''));
    if (!(node instanceof Element)) return false;
    if (node.tagName === 'BR') return !terminalPlaceholder(node);
    if (['DIV', 'P', 'LI', 'IMG', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT'].includes(node.tagName.toUpperCase())) return true;
    return [...node.childNodes].some(hasContent);
  };
  let node = selection.anchorNode!;
  if (node.nodeType === 3) { if (node.textContent?.slice(selection.anchorOffset).replace(/\u200b/g, '')) return false; }
  else if ([...node.childNodes].slice(selection.anchorOffset).some(hasContent)) return false;
  // Traverse original following siblings, not cloned empty ancestors of the caret.
  while (node !== editor) {
    let next = node.nextSibling;
    while (next) { if (hasContent(next)) return false; next = next.nextSibling; }
    if (!node.parentNode) return false;
    node = node.parentNode;
  }
  return true;
}
const svgNS = 'http://www.w3.org/2000/svg';
const refinements: Record<string, string> = {
  Shorter: 'Make the draft shorter.', Longer: 'Make the draft longer.', Warmer: 'Make the draft warmer.', Funnier: 'Make the draft funnier.',
  'More formal': 'Make the draft more formal.', 'More casual': 'Make the draft more casual.', 'More direct': 'Make the draft more direct.',
  'Fix spelling': 'Fix spelling, grammar and punctuation in the draft without changing its tone or meaning.', 'Add emoji': 'Add a few fitting emoji to the draft.'
};
export class DomConnector {
  private stickerTransfer?: StickerTransferConnector;
  private stickerPickerLayout?: StickerPickerLayout;
  private navigation?: Navigation;
  private composingEditor: HTMLElement | null = null;
  private get composing() { return Boolean(this.composingEditor && this.composingEditor === this.editor()); }
  private revision = 0;
  private activityGeneration = 0;
  private editRevision = 0;
  private identity = '';
  private conversationVisible = false;
  private root: Element | null = null;
  private editorRoot: Element | null = null;
  private selectedChat: Element | null = null;
  private observedMessages = new Map<string, Message>();
  private stableSince = 0;
  private composerStableSince = 0;
  private lastKey = '';
  private lastContentKey = '';
  private lastAccountSafety: AccountSafetyReason | undefined;
  private popupMode: 'refine' | 'notice' = 'notice';
  private pending?: Extract<RemoteCommand, { type: 'refining' | 'thinking' }>;
  private fallbackDots?: HTMLElement;
  private dotsTimer?: ReturnType<typeof setInterval>;
  private loadingStatus!: HTMLElement;
  private announcedRequests = new Set<string>();
  private suggestion?: Extract<RemoteCommand, { type: 'suggestion' }>;
  private replacement?: { command: Extract<RemoteCommand, { type: 'suggestion' }>; editor: HTMLElement; originalRange?: Range };
  private dismissedKey?: string;
  private dismissedIds = new Set<string>();
  private popupRequest?: { id: string };
  private hiddenPlaceholder?: { element: HTMLElement; visibility: string; priority: string };
  private host!: HTMLElement;
  private ghost!: HTMLElement;
  private popup!: HTMLElement;
  private button!: HTMLButtonElement;
  private observer?: MutationObserver;
  private timer?: ReturnType<typeof setInterval>;
  private stickerSources = new Map<string, string>();
  private failedSources = new Set<string>();
  private indexing = false;
  private inserting = false;
  private dispatch?: { command: Extract<RemoteCommand, { type: 'autoSend' }>; before: Snapshot; editor: HTMLElement };
  constructor(private doc: Document, private emit: (event: RemoteEvent) => void, private authorizeAutomatic: (nonce: string) => Promise<boolean> = async () => false, private authorizeSticker: (nonce: string | StickerAuthorization) => Promise<boolean> = async () => false) {}
  editor() { return this.doc.querySelector<HTMLElement>('#main footer [contenteditable="true"][role="textbox"], #main [data-testid="conversation-compose-box-input"][contenteditable="true"]'); }
  read(): Snapshot {
    const main = this.doc.querySelector('#main');
    const editor = this.editor();
    if (this.composingEditor !== editor) this.composingEditor = null;
    const emptyComposer = composerProvablyEmpty(editor, this.composing);
    const draft = emptyComposer ? '' : editor ? readDraft(editor) : '';
    const title = main?.querySelector('header [data-testid="conversation-info-header-chat-title"]');
    const name = readChatTitle(title ?? main?.querySelector('header [title]') ?? main?.querySelector('header')).slice(0, 1024);
    const selected = this.doc.querySelector('#pane-side [aria-selected="true"]');
    const nodes = [...(main?.querySelectorAll<HTMLElement>('[data-id]') ?? [])].filter(n => !n.closest(quoteSelector) && (peerFromMessageId(n.dataset.id ?? '') || (/^[A-Za-z0-9_-]{6,150}$/.test(n.dataset.id ?? '') && n.dataset.testid === `conv-msg-${n.dataset.id}`)));
    const peers = [...new Set(nodes.map(n => peerFromMessageId(n.dataset.id!)).filter((id): id is string => id !== null))];
    const chatId = peers.length === 1 ? peers[0] : null;
    const identity = `${name}|${chatId}`;
    const conversationVisible = visible(main);
    const conversationChanged = main !== this.root || identity !== this.identity || selected !== this.selectedChat || conversationVisible !== this.conversationVisible;
    if (conversationChanged || editor !== this.editorRoot) {
      this.revision++; this.composerStableSince = Date.now();
      if (conversationChanged) this.stableSince = Date.now();
      this.identity = identity; this.root = main; this.editorRoot = editor; this.selectedChat = selected;
      this.conversationVisible = conversationVisible;
      this.observedMessages.clear();
    }
    // WhatsApp replaces offscreen modern bubbles with empty height placeholders when resizing.
    // Recognise them before inferring direction so geometry never relabels or overwrites them.
    const placeholder = (node: HTMLElement) => !peerFromMessageId(node.dataset.id!) && !node.querySelector('[data-testid="msg-container"]') &&
      messageDirection(node) === null && !messageText(node) && !messageAttachment(node) && !senderLabel(node) && !quotedMessage(node);
    const directions = new Map<HTMLElement, boolean | null>();
    nodes.forEach((node, index) => {
      const explicit = messageDirection(node);
      const previous = nodes[index - 1];
      const outgoing = explicit ?? (placeholder(node) ? this.observedMessages.get(node.dataset.id!.slice(0, 250))?.outgoing ?? null
        : main instanceof HTMLElement ? fallbackDirection(node, main, previous && { node: previous, direction: directions.get(previous) ?? null }) : null);
      directions.set(node, outgoing);
    });
    const messages: Message[] = nodes.slice(-30).map(node => {
      const attachment = messageAttachment(node), name = attachmentName(node), sender = senderLabel(node), quoted = quotedMessage(node);
      const explicit = messageDirection(node), outgoing = directions.get(node) ?? null;
      const message: Message = { id: node.dataset.id!.slice(0, 250),
        text: messageText(node),
        outgoing, ...(explicit === null && outgoing !== null ? { directionFallback: true as const } : {}), ...(sender ? { sender } : {}), ...(attachment ? { attachment } : {}), ...(name ? { attachmentName: name } : {}), ...(quoted ? { quoted } : {}) };
      // Keep only previously observed content in this chat; mounted edits/deletions still replace it.
      if (placeholder(node)) return this.observedMessages.get(message.id) ?? message;
      this.observedMessages.set(message.id, message);
      while (this.observedMessages.size > 100) this.observedMessages.delete(this.observedMessages.keys().next().value!);
      return message;
    });
    let atBottom = false;
    let container: HTMLElement | null = nodes.at(-1)?.parentElement ?? null;
    // Only grant automatic sending while a measurable message viewport is at the bottom.
    while (container && container !== main) {
      if (container.scrollHeight > container.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(container).overflowY)) { atBottom = container.scrollHeight - container.clientHeight - container.scrollTop < 80; break; }
      container = container.parentElement;
    }
    if (!container || container === main) {
      const last = nodes.at(-1)?.getBoundingClientRect(), footer = editor?.getBoundingClientRect();
      atBottom = Boolean(last && footer && last.height > 0 && last.bottom <= footer.top && last.top > 0);
    }
    const conversationOpen = Boolean(conversationVisible && peers.length <= 1 && (chatId || (title && selected && nodes.length)) && name && Date.now() - this.stableSince >= 500);
    const snapshot: Snapshot = { chatId, name, conversationOpen, kind: chatId ? chatId.endsWith('@g.us') ? 'group' : 'direct' : nodes.some(n => ownElements(n, '[data-testid="author"]').length) ? 'group' : 'unknown', messages,
      draft: draft.slice(0, 8000), draftIssue: draft.length > 8000 ? 'too-long' : !emptyComposer && (draft.includes('\ufffc') || editor?.querySelector('[contenteditable="false"]:not(img)') || (editor && !draft)) ? 'unsupported' : null,
      composing: this.composing, focused: Boolean(editor && this.doc.hasFocus() && this.doc.activeElement === editor), caretAtEnd: Boolean(editor && caretAtEnd(editor)),
      ready: conversationOpen && visible(editor) && Date.now() - this.composerStableSince >= 500,
      atBottom, revision: String(this.revision), activity: this.activityGeneration, editRevision: this.editRevision };
    const preparation = this.stickerTransfer?.preparation(snapshot);
    if (preparation) snapshot.stickerPreparation = preparation;
    return snapshot;
  }
  start() {
    this.stickerPickerLayout = new StickerPickerLayout(this.doc);
    this.stickerTransfer = new StickerTransferConnector(this.doc, () => this.read(), this.stickerSources, this.emit, nonce => this.authorizeSticker(nonce), request => this.authorizeSticker(request));
    this.navigation = new Navigation(this.doc, this.navigationEvent);
    this.host = this.doc.createElement('div'); this.host.id = 'companion-overlay';
    this.host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646';
    const shadow = this.host.attachShadow({ mode: 'closed' });
    const style = this.doc.createElement('style');
    style.textContent = composerStyle;
    this.ghost = this.doc.createElement('div'); this.ghost.className = 'ghost'; this.ghost.setAttribute('aria-hidden', 'true');
    this.popup = this.doc.createElement('div'); this.popup.className = 'popup'; this.popup.hidden = true;
    this.popup.setAttribute('role', 'dialog'); this.popup.setAttribute('aria-label', 'Refine reply');
    this.button = this.doc.createElement('button'); this.button.className = 'trigger'; this.button.textContent = '✦'; this.button.title = 'Suggest reply'; this.button.setAttribute('aria-label', 'Suggest reply');
    this.button.setAttribute('aria-haspopup', 'dialog'); this.button.setAttribute('aria-expanded', 'false');
    this.button.addEventListener('click', event => { if (event.isTrusted) {
      if (this.pending?.origin === 'auto') {
        if (this.read().draft.trim()) { this.dismissPopup(); this.openPopup(); }
      }
      else if (this.pending) { this.dismissPopup(); this.editor()?.focus(); }
      else if (!this.popup.hidden && this.popupMode === 'refine') { this.hidePopup(); this.editor()?.focus(); }
      else this.openPopup();
    } });
    this.loadingStatus = this.doc.createElement('div'); this.loadingStatus.className = 'sr-status';
    this.loadingStatus.setAttribute('role', 'status'); this.loadingStatus.setAttribute('aria-live', 'polite');
    shadow.append(style, this.ghost, this.loadingStatus, this.popup, this.button); this.doc.documentElement.append(this.host);
    this.doc.addEventListener('scroll', this.scroll, true);
    this.doc.addEventListener('input', this.scroll, true);
    this.doc.defaultView?.addEventListener('resize', this.resize);
    this.doc.addEventListener('keydown', this.keydown, true);
    this.doc.addEventListener('beforeinput', this.beforeInput, true);
    this.doc.addEventListener('pointerdown', this.pointer, true);
    this.doc.addEventListener('wheel', this.activity, { capture: true, passive: true });
    this.doc.addEventListener('compositionstart', this.compositionStart, true);
    this.doc.addEventListener('compositionend', this.compositionEnd, true);
    this.doc.addEventListener('selectionchange', this.selectionChanged);
    this.observer = new MutationObserver(() => this.refresh());
    this.observer.observe(this.doc.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-id', 'data-icon', 'data-testid', 'class', 'title', 'contenteditable', 'aria-selected'] });
    this.timer = setInterval(() => { this.refresh(); void this.indexStickers(); }, 350);
    this.refresh();
  }
  stop() {
    this.stickerPickerLayout?.stop();
    this.stickerTransfer?.stop();
    this.composingEditor = null;
    this.clear();
    this.dispatch = undefined;
    this.observer?.disconnect(); clearInterval(this.timer); this.host.remove(); this.navigation?.stop();
    this.doc.removeEventListener('scroll', this.scroll, true);
    this.doc.removeEventListener('input', this.scroll, true);
    this.doc.defaultView?.removeEventListener('resize', this.resize);
    this.doc.removeEventListener('keydown', this.keydown, true); this.doc.removeEventListener('beforeinput', this.beforeInput, true);
    this.doc.removeEventListener('pointerdown', this.pointer, true); this.doc.removeEventListener('compositionstart', this.compositionStart, true);
    this.doc.removeEventListener('wheel', this.activity, true);
    this.doc.removeEventListener('compositionend', this.compositionEnd, true); this.doc.removeEventListener('selectionchange', this.selectionChanged);
  }
  private selectionChanged = () => this.refresh();
  private scroll = () => this.syncGhostScroll();
  private resize = () => this.refresh();
  private navigationEvent = (event: RemoteEvent) => {
    // Invalidate queued commands synchronously, before main can return a clear.
    if (event.type === 'cancelAuto' || event.type === 'navigate') this.takeover();
    this.emit(event);
  };
  private takeover(editing = false) {
    this.restoreReplacementSelection();
    this.activityGeneration++;
    if (editing) { this.editRevision++; this.clear(); if (this.popupMode === 'notice') this.hidePopup(); }
    this.emit({ type: 'activity', editing });
  }
  private activity = (event: Event) => { if (event.isTrusted && !this.inserting) this.takeover(); };
  private beforeInput = (event: Event) => {
    if (event.isTrusted && !this.inserting) this.takeover(event.target instanceof Node && Boolean(this.editor()?.contains(event.target)));
  };
  private pointer = (event: Event) => {
    if (!event.isTrusted) return;
    if (!event.composedPath().includes(this.host) && !this.navigation?.contains(event)) this.hidePopup();
    const send = event.target instanceof Element ? event.target.closest('#main footer button, #main footer [role="button"]') : null;
    if (this.pending && send?.querySelector('[data-icon="send"]')) this.takeover(true);
    else this.activity(event);
  };
  private compositionStart = (event: Event) => {
    const editor = this.editor();
    if (event.target instanceof Node && editor?.contains(event.target)) { this.composingEditor = editor; this.takeover(true); this.refresh(); }
  };
  private compositionEnd = (event: Event) => {
    if (event.target instanceof Node && this.composingEditor?.contains(event.target)) { this.composingEditor = null; this.refresh(); }
  };
  private keydown = (event: KeyboardEvent) => {
    if (!event.isTrusted || event.isComposing || this.composing || event.keyCode === 229) return;
    const editor = this.editor();
    if (event.key === 'Escape' && (editor?.contains(event.target as Node) || event.composedPath().includes(this.host)) && (this.pending || this.suggestion || !this.popup.hidden)) {
      event.preventDefault(); event.stopImmediatePropagation(); this.dismissPopup(); editor?.focus(); return;
    }
    if (event.target !== editor && !editor?.contains(event.target as Node)) {
      if (!['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) this.takeover();
      return;
    }
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && this.suggestion && editor && caretAtEnd(editor)) {
      if (suggestionKey(this.read()) !== this.suggestion.key) { this.clear(); return; }
      event.preventDefault(); event.stopImmediatePropagation();
      this.acceptSuggestion(); return;
    }
    if (!['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) this.takeover(event.key === 'Enter');
  };
  private insert(text: string, replace: boolean) {
    const editor = this.editor(); if (!editor) return false;
    editor.focus();
    const selection = this.doc.getSelection(); const range = this.doc.createRange();
    range.selectNodeContents(editor); if (!replace) range.collapse(false);
    selection?.removeAllRanges(); selection?.addRange(range);
    return this.insertAtSelection(text);
  }
  private insertAtSelection(text: string) {
    this.inserting = true;
    try { return this.doc.execCommand('insertText', false, text); } catch { return false; } finally { this.inserting = false; }
  }
  private async replaceDraft(command: Extract<RemoteCommand, { type: 'suggestion' }>) {
    const editor = this.editor();
    // Keep the revision pending while the user works in search or another field.
    // A provider response must never move their keyboard focus to the composer.
    if (!editor || this.replacement || this.doc.activeElement !== editor || !this.doc.hasFocus()) return;
    this.hidePopup();
    const selection = this.doc.getSelection(), range = this.doc.createRange();
    const originalRange = selection?.rangeCount && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode) ? selection.getRangeAt(0).cloneRange() : undefined;
    const replacement = this.replacement = { command, editor, originalRange };
    range.selectNodeContents(editor); selection?.removeAllRanges(); selection?.addRange(range);
    const activity = this.activityGeneration;
    // WhatsApp's editor reconciles native selection asynchronously. Inserting in
    // the same turn can be silently reverted, even when execCommand returns true.
    await new Promise(resolve => setTimeout(resolve, 50));
    if (this.replacement !== replacement) return;
    const snapshot = this.read();
    if (this.suggestion !== command || editor !== this.editor() || activity !== this.activityGeneration || command.key !== suggestionKey(snapshot) || !snapshot.ready || !snapshot.focused || snapshot.composing || snapshot.draftIssue || !this.wholeDraftSelected(editor)) {
      if (this.suggestion === command) this.clear();
      return;
    }
    this.applySuggestion(command, () => this.insertAtSelection(command.text));
    if (this.replacement === replacement) this.replacement = undefined;
  }
  private wholeDraftSelected(editor: HTMLElement) {
    const selection = this.doc.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return false;
    // The native editor can normalize range endpoints into text nodes. Compare
    // serialized content, including emoji, rather than exact DOM boundaries.
    const selected = this.doc.createElement('div'); selected.append(selection.getRangeAt(0).cloneContents());
    return readDraft(selected) === readDraft(editor);
  }
  private restoreReplacementSelection() {
    const replacement = this.replacement; this.replacement = undefined;
    if (!replacement) return;
    if (this.suggestion === replacement.command) this.suggestion = undefined;
    const { editor, originalRange } = replacement, selection = this.doc.getSelection();
    // Before native typing, deletion or caret navigation, undo our temporary
    // select-all. Cancelling only the async insertion would lose the user's draft.
    if (editor === this.editor() && this.doc.activeElement === editor && originalRange && editor.contains(originalRange.startContainer) && editor.contains(originalRange.endContainer) && this.wholeDraftSelected(editor)) {
      selection?.removeAllRanges(); selection?.addRange(originalRange);
    }
  }
  private acceptSuggestion() {
    const suggestion = this.suggestion, snapshot = this.read();
    if (!suggestion || suggestion.key !== suggestionKey(snapshot) || !snapshot.ready || snapshot.composing || snapshot.draftIssue) return;
    if (suggestion.replace && snapshot.draft.trim()) { void this.replaceDraft(suggestion); return; }
    this.applySuggestion(suggestion, () => this.insert(suggestion.text, suggestion.replace));
  }
  private applySuggestion(command: Extract<RemoteCommand, { type: 'suggestion' }>, insert: () => boolean) {
    const selection = this.doc.getSelection();
    const originalRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
    const success = insert();
    if (!success) {
      // Stop automatic replacement before notifying main (which may synchronously
      // publish recovery). Restore the caret before the next native keystroke.
      this.clear();
      if (originalRange && !command.replace && originalRange.startContainer.isConnected && originalRange.endContainer.isConnected) {
        selection?.removeAllRanges(); selection?.addRange(originalRange);
      }
    }
    this.hidePopup();
    // Acknowledge after the native edit, before activity publishes another snapshot.
    if (command.id) this.emit({ type: 'applied', key: command.key, suggestionId: command.id, ...(!success ? { success: false } : {}) });
    this.takeover(success);
    if (!success) this.refresh();
  }

  private hidePopup() { this.popupRequest = undefined; this.popup.hidden = true; this.button.setAttribute('aria-expanded', 'false'); this.updateTrigger(); }
  private dismissPopup() {
    const request = this.pending ? { id: this.pending.requestId } : !this.popup.hidden ? this.popupRequest : undefined;
    const offer = request ? undefined : this.suggestion;
    const id = request?.id ?? offer?.id;
    if (id) {
      this.dismissedIds.add(id);
      if (offer?.requestId) this.dismissedIds.add(offer.requestId);
      while (this.dismissedIds.size > 50) this.dismissedIds.delete(this.dismissedIds.values().next().value!);
    } else this.dismissedKey = offer?.key ?? suggestionKey(this.read());
    // Clear locally before main can synchronously publish a newer item.
    this.clear(); this.hidePopup();
    this.emit({ type: 'dismiss', ...(request ? { requestId: request.id } : offer?.id ? { suggestionId: offer.id, key: offer.key } : {}) });
    this.takeover();
  }
  private popupShell(mode: typeof this.popupMode, title: string) {
    this.popupRequest = undefined; this.popupMode = mode; this.popup.replaceChildren(); this.popup.className = `popup ${mode}`;
    this.popup.hidden = false; this.popup.setAttribute('aria-label', title); this.button.setAttribute('aria-expanded', 'true');
    const header = this.doc.createElement('div'); header.className = 'popup-header';
    const label = this.doc.createElement('span'); label.textContent = title;
    const close = this.doc.createElement('button'); close.className = 'close'; close.textContent = '×'; close.setAttribute('aria-label', 'Close reply assistance');
    close.addEventListener('click', event => { if (!event.isTrusted) return; this.dismissPopup(); this.editor()?.focus(); });
    header.append(label, close); this.popup.append(header);
  }
  private clear() {
    this.restoreReplacementSelection();
    this.fallbackDots?.remove(); this.fallbackDots = undefined;
    this.pending = undefined; clearInterval(this.dotsTimer); this.dotsTimer = undefined;
    this.loadingStatus.textContent = '';
    this.suggestion = undefined; this.ghost.textContent = ''; this.ghost.classList.remove('loading');
    if (this.hiddenPlaceholder) {
      const { element, visibility, priority } = this.hiddenPlaceholder;
      if (visibility) element.style.setProperty('visibility', visibility, priority); else element.style.removeProperty('visibility');
      this.hiddenPlaceholder = undefined;
    }
    this.updateTrigger();
  }
  private stickerReadiness = new StickerReadiness();
  private refresh() {
    const reason = accountSafetyReason(this.doc);
    if (reason !== this.lastAccountSafety) {
      this.lastAccountSafety = reason;
      this.emit({ type: 'accountSafety', reason });
    }
    this.stickerPickerLayout?.refresh();
    const snapshot = this.read(), key = snapshotKey(snapshot);
    this.navigation?.refresh(this.stickerReadiness.present(snapshot, snapshot.stickerPreparation).ready);
    const dark = this.navigation?.theme !== 'light';
    for (const [key, value] of Object.entries(dark ? { background: '#161717', surface: '#242626', ink: '#e9edef', muted: '#9babae', line: '#373b3c', hover: '#2e2f2f' } : { background: '#fff', surface: '#f0f2f5', ink: '#111b21', muted: '#667781', line: '#d9e3df', hover: '#e9edef' })) this.host.style.setProperty(`--${key}`, value);
    const contentKey = suggestionKey(snapshot);
    if (key !== this.lastKey && !(this.dispatch && this.dispatchMatches(this.dispatch, snapshot))) {
      this.lastKey = key;
      if ((this.suggestion && this.suggestion.key !== contentKey) || (this.pending && this.pending.key !== contentKey)) this.clear();
      if (contentKey !== this.lastContentKey) this.hidePopup();
      this.lastContentKey = contentKey;
      this.emit({ type: 'snapshot', snapshot });
    }
    const editor = this.editor(), rect = editor?.getBoundingClientRect();
    this.button.hidden = !snapshot.ready; this.updateTrigger(snapshot);
    if (rect && editor) {
      this.button.style.left = `${Math.max(12, rect.right - 30)}px`; this.button.style.top = `${rect.top - 29}px`;
      this.popup.style.left = `${Math.max(8, Math.min(rect.right - 296, this.doc.documentElement.clientWidth - 304))}px`; this.popup.style.bottom = `${this.doc.documentElement.clientHeight - rect.top + 36}px`;
      this.popup.style.maxHeight = `${Math.max(80, rect.top - 44)}px`;
      const css = getComputedStyle(editor);
      Object.assign(this.ghost.style, { left: `${rect.left + editor.clientLeft}px`, top: `${rect.top + editor.clientTop}px`, width: `${editor.clientWidth}px`, height: `${editor.clientHeight}px`, fontFamily: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight, fontStyle: css.fontStyle, letterSpacing: css.letterSpacing, lineHeight: css.lineHeight, padding: css.padding, direction: css.direction, textAlign: css.textAlign });
      this.syncGhostScroll();
    }
    if (snapshot.focused && snapshot.draft.trim() && this.suggestion?.replace && !this.replacement) void this.replaceDraft(this.suggestion);
  }
  private openPopup() {
    const snapshot = this.read(), key = suggestionKey(snapshot);
    const suggested = this.suggestion?.key === key ? this.suggestion : undefined;
    const hasText = Boolean(snapshot.draft.trim() || suggested);
    if (suggested?.replace && snapshot.draft.trim()) this.clear();
    this.takeover();
    const request = (instruction?: string, operation?: 'translate' | 'retry') => {
      if (suggestionKey(this.read()) !== key) { this.hidePopup(); return; }
      this.dismissedKey = undefined;
      this.hidePopup();
      const editor = this.editor();
      if (editor) { editor.focus(); const range = this.doc.createRange(); range.selectNodeContents(editor); range.collapse(false); const selection = this.doc.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
      this.refresh(); this.emit({ type: 'request', instruction, ...(operation ? { operation } : {}), key, ...(instruction && !snapshot.draft.trim() && suggested?.id ? { suggestionId: suggested.id } : {}) });
    };
    if (!hasText) {
      request(); return;
    }
    this.popupShell('refine', snapshot.draft.trim() ? 'Refine draft' : 'Refine suggestion');
    const row = this.doc.createElement('div'); row.className = 'actions';
    let translating = false;
    for (const label of [...Object.keys(refinements), 'Translate…']) {
      const b = this.doc.createElement('button'); b.className = 'action'; b.textContent = label;
      b.addEventListener('click', e => {
        if (!e.isTrusted) return;
        if (label === 'Translate…') { translating = true; instruction.value = ''; instruction.placeholder = 'Language, e.g. Spanish'; instruction.setAttribute('aria-label', 'Translation language'); apply.disabled = true; instruction.focus(); }
        else request(refinements[label]);
      }); row.append(b);
    }
    const field = this.doc.createElement('div'); field.className = 'instruction';
    const instruction = this.doc.createElement('input'); instruction.placeholder = 'Ask for a change…'; instruction.setAttribute('aria-label', 'Refinement instruction'); instruction.maxLength = 950;
    const apply = this.doc.createElement('button'); apply.className = 'apply'; apply.setAttribute('aria-label', 'Apply instruction'); apply.disabled = true;
    const icon = this.doc.createElementNS(svgNS, 'svg'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    const path = this.doc.createElementNS(svgNS, 'path'); path.setAttribute('fill', 'currentColor'); path.setAttribute('d', 'M2.01 21 23 12 2.01 3 2 10l15 2-15 2z');
    icon.append(path); apply.append(icon);
    const submit = () => { const text = instruction.value.trim(); if (text) request(translating ? `Translate the draft to ${text}.` : text, translating ? 'translate' : undefined); };
    instruction.addEventListener('input', () => { apply.disabled = !instruction.value.trim(); });
    apply.addEventListener('click', e => { if (e.isTrusted) submit(); });
    instruction.addEventListener('keydown', e => { if (e.isTrusted && e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); e.stopPropagation(); submit(); } });
    field.append(instruction, apply); this.popup.append(row, field); instruction.focus();
  }
  command(command: RemoteCommand) {
    if (command.type === 'snapshot') { this.dismissedKey = undefined; this.refresh(); this.emit({ type: 'snapshot', snapshot: this.read(), nonce: command.nonce }); return; }
    if (command.type === 'captureStickerPickerLayout') { this.emit({ type: 'stickerPickerLayout', nonce: command.nonce, result: captureStickerPicker(this.doc) }); return; }
    if (command.type === 'makeSticker') { void this.stickerTransfer?.make(command, command.image); return; }
    if (command.type === 'prepareSticker') { void this.stickerTransfer?.prepare(command); return; }
    if (command.type === 'sendSticker') { void this.stickerTransfer?.send(command, command.expiresAt); return; }
    if (command.type === 'cancelSticker') { this.stickerTransfer?.cancel(); return; }
    if (command.type === 'chrome') { this.navigation?.update(command.panel, command.pending); this.stickerPickerLayout?.update(command.panelBounds ?? null, command.panel === 'chat' ? 'right' : 'left'); return; }
    if (command.type === 'clear') { this.dispatch = undefined; this.clear(); if (this.popupMode === 'notice') this.hidePopup(); return; }
    if (command.type === 'notice') {
      if ((command.requestId && this.dismissedIds.has(command.requestId)) || (command.retryKey && command.retryKey !== suggestionKey(this.read()))) return;
      if (this.pending) this.clear();
      this.popupShell('notice', 'Reply assistance');
      if (command.requestId) this.popupRequest = { id: command.requestId };
      const text = this.doc.createElement('div'); text.className = 'notice-text'; text.textContent = command.text; text.setAttribute('role', 'status'); this.popup.append(text);
      if (command.retryKey) {
        const retry = this.doc.createElement('button'); retry.className = 'action'; retry.textContent = 'Try again';
        retry.addEventListener('click', event => {
          if (!event.isTrusted || command.retryKey !== suggestionKey(this.read())) return;
          this.dismissedKey = undefined; this.hidePopup();
          const editor = this.editor();
          if (editor) { editor.focus(); const range = this.doc.createRange(); range.selectNodeContents(editor); range.collapse(false); const selection = this.doc.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
          this.refresh();
          this.emit({ type: 'request', operation: 'retry', key: command.retryKey });
        }); this.popup.append(retry);
      }
      return;
    }
    if (command.type === 'refining' || command.type === 'thinking') {
      if (command.key !== suggestionKey(this.read()) || this.dismissedIds.has(command.requestId)) return;
      // Compatible re-publication must not restart animation or re-announce status.
      if (this.pending?.requestId === command.requestId && this.pending.key === command.key && this.pending.type === command.type && this.pending.origin === command.origin) return;
      const snapshot = this.read();
      if (snapshot.composing || snapshot.draftIssue || !snapshot.ready) return;
      this.clear(); this.hidePopup(); this.pending = command;
      this.ghost.classList.add('loading'); this.hidePlaceholder(snapshot.draft);
      const prefix = this.doc.createElement('span'); prefix.textContent = snapshot.draft; prefix.style.visibility = 'hidden';
      const dots = this.doc.createElement('span'); dots.className = 'dots';
      if (snapshot.draft && !/\s$/.test(snapshot.draft)) dots.classList.add('gap');
      const periods = Array.from({ length: 3 }, () => { const period = this.doc.createElement('i'); period.textContent = '.'; return period; });
      dots.append(...periods);
      this.fallbackDots = this.doc.createElement('span'); this.fallbackDots.className = 'dots dots-fallback';
      this.fallbackDots.setAttribute('aria-hidden', 'true'); this.fallbackDots.hidden = true;
      const fallbackPeriods = periods.map(period => period.cloneNode(true) as HTMLElement);
      this.fallbackDots.append(...fallbackPeriods); this.button.before(this.fallbackDots);
      const motion = this.doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)');
      let step = 1;
      const render = () => {
        const count = motion?.matches ? 3 : step;
        periods.forEach((period, index) => {
          period.style.opacity = fallbackPeriods[index].style.opacity = index < count ? '1' : '0';
        });
        this.syncGhostScroll();
      };
      this.ghost.append(prefix, dots); render();
      this.dotsTimer = setInterval(() => { step = step % 3 + 1; render(); }, 400);
      if (!this.announcedRequests.has(command.requestId)) {
        this.announcedRequests.add(command.requestId);
        while (this.announcedRequests.size > 50) this.announcedRequests.delete(this.announcedRequests.values().next().value!);
        this.loadingStatus.textContent = command.type === 'refining' ? 'Refining' : 'Suggesting a reply';
      }
      this.updateTrigger(snapshot); return;
    }
    if (command.type === 'suggestion') {
      const editor = this.editor(), s = this.read();
      const reason = command.key !== suggestionKey(s) ? 'key' : (command.id ? this.dismissedIds.has(command.id) || Boolean(command.requestId && this.dismissedIds.has(command.requestId)) : command.key === this.dismissedKey) ? 'dismissed' : this.composing ? 'composition' : s.draftIssue ? 'draft' : !s.ready || !editor ? 'unready' : 'displayed';
      if (reason !== 'displayed' || !editor) {
        if (command.id) this.emit({ type: 'displayAck', suggestionId: command.id, key: command.key, reason });
        return;
      }
      this.clear(); this.suggestion = command; this.ghost.replaceChildren();
      if (this.popupMode === 'notice') this.hidePopup();
      // An explicit refinement edits a written draft directly. Empty composers
      // keep the revised reply as ghost text, so Enter can never send it unseen.
      if (command.replace && s.draft.trim()) {
        if (command.id) this.emit({ type: 'displayAck', suggestionId: command.id, key: command.key, reason: 'displayed' });
        void this.replaceDraft(command); return;
      }
      this.hidePlaceholder(s.draft);
      if (!command.replace) { const prefix = this.doc.createElement('span'); prefix.textContent = s.draft; prefix.style.visibility = 'hidden'; this.ghost.append(prefix); }
      const suffix = this.doc.createElement('span'); suffix.textContent = command.text; this.ghost.append(suffix); this.syncGhostScroll(); this.updateTrigger(s);
      if (command.id) this.emit({ type: 'displayAck', suggestionId: command.id, key: command.key, reason: 'displayed' });
      return;
    }
    if (command.type === 'autoSend') {
      void this.sendAutomatic(command); return;
    }
    if (command.type === 'locateSticker') {
      const image = [...this.doc.images].find(img => stickerImageState(img) === 'ready' && this.stickerSources.get(img.currentSrc || img.src) === command.id && img.checkVisibility({ visibilityProperty: true }) && img.getBoundingClientRect().width > 0);
      if (image) { image.scrollIntoView({ block: 'center' }); image.animate([{ outline: '4px solid #24ae85' }, { outline: '4px solid transparent' }], { duration: 1800 }); }
      this.emit({ type: 'stickerLocated', nonce: command.nonce, found: Boolean(image) });
    }
  }
  private updateTrigger(snapshot = this.read()) {
    const cancels = this.pending?.origin === 'user';
    const label = cancels ? 'Cancel' : snapshot.draft.trim() ? 'Refine draft' : this.suggestion ? 'Refine suggestion' : 'Suggest reply';
    this.button.title = label; this.button.setAttribute('aria-label', label);
    this.button.setAttribute('aria-haspopup', cancels || (!snapshot.draft.trim() && !this.suggestion) ? 'false' : 'dialog');
  }
  private hidePlaceholder(draft: string) {
    const editor = this.editor();
    if (draft || !editor) return;
    const label = editor.getAttribute('aria-placeholder');
    const placeholder = [...(editor.parentElement?.children ?? [])].find(el => el !== editor && el instanceof HTMLElement && el.getAttribute('aria-hidden') === 'true' && label && el.textContent?.trim() === label) as HTMLElement | undefined;
    if (placeholder) {
      this.hiddenPlaceholder = { element: placeholder, visibility: placeholder.style.getPropertyValue('visibility'), priority: placeholder.style.getPropertyPriority('visibility') };
      placeholder.style.setProperty('visibility', 'hidden', 'important');
    }
  }
  private syncGhostScroll() {
    const editor = this.editor();
    if (!editor || (!this.suggestion && !this.pending)) return;
    this.ghost.scrollTop = editor.scrollTop; this.ghost.scrollLeft = editor.scrollLeft;
    if (this.pending) { this.positionDots(); return; }
    // If the suffix wraps below the viewport, reveal it in the overlay without moving the actual caret.
    const suffix = this.ghost.lastElementChild?.getBoundingClientRect(), viewport = this.ghost.getBoundingClientRect();
    if (suffix && suffix.top >= viewport.bottom) this.ghost.scrollTop += suffix.top - viewport.top - 10;
  }
  private positionDots() {
    const dots = this.ghost.querySelector<HTMLElement>('.dots'), fallback = this.fallbackDots;
    if (!dots || !fallback) return;
    // Measure every period, including the transparent animation steps, so the
    // indicator never changes position while cycling. Visibility preserves layout.
    const viewport = this.ghost.getBoundingClientRect();
    const periods = [...dots.children].map(period => period.getBoundingClientRect());
    const clipped = periods.some(rect => rect.right > viewport.right || rect.left < viewport.left ||
      rect.top < viewport.top || rect.bottom > viewport.bottom);
    dots.style.visibility = clipped ? 'hidden' : 'visible'; fallback.hidden = !clipped;
    if (clipped) {
      const trigger = this.button.getBoundingClientRect();
      Object.assign(fallback.style, { left: `${trigger.left - 6}px`, top: `${trigger.top + trigger.height / 2}px`,
        fontFamily: this.ghost.style.fontFamily, fontSize: this.ghost.style.fontSize,
        fontWeight: this.ghost.style.fontWeight, fontStyle: this.ghost.style.fontStyle,
        lineHeight: this.ghost.style.lineHeight });
    }
  }
  private dispatchMatches(attempt: NonNullable<DomConnector['dispatch']>, snapshot: Snapshot): boolean {
    return this.dispatch === attempt && this.editor() === attempt.editor && !snapshot.draftIssue && snapshot.draft === attempt.command.text &&
      snapshotKey({ ...snapshot, draft: attempt.before.draft, focused: attempt.before.focused, caretAtEnd: attempt.before.caretAtEnd, atBottom: attempt.before.atBottom, ready: attempt.before.ready }) === attempt.command.key;
  }
  private async sendAutomatic(command: Extract<RemoteCommand, { type: 'autoSend' }>) {
    const before = this.read(), editor = this.editor();
    let sent = false;
    const attempt = editor ? { command, before, editor } : undefined;
    try {
      if (!Number.isFinite(command.expiresAt) || Date.now() >= command.expiresAt || !attempt || !before.chatId || !before.ready || !before.atBottom || before.draft || before.draftIssue || before.composing || command.key !== snapshotKey(before)) return;
      this.dispatch = attempt;
      if (!this.insert(command.text, true)) return;
      const deadline = Math.min(command.expiresAt, Date.now() + 2000);
      // React may mount/enable Send after the insertion event. Recheck authority during that wait.
      while (Date.now() < deadline && this.dispatchMatches(attempt, this.read())) {
        const send = this.doc.querySelector<HTMLElement>('#main footer [data-icon="send"]')?.closest<HTMLElement>('button, [role="button"]');
        const current = this.read();
        if (current.ready && current.atBottom && send && send.getBoundingClientRect().height > 0 && !send.hasAttribute('disabled') && send.getAttribute('aria-disabled') !== 'true' && Date.now() < deadline) {
          if (!await this.authorizeAutomatic(command.nonce)) break;
          const authorized = this.read();
          if (Date.now() < deadline && this.dispatchMatches(attempt, authorized) && authorized.ready && authorized.atBottom && send.isConnected && send === this.doc.querySelector('#main footer [data-icon="send"]')?.closest('button, [role="button"]') && send.getBoundingClientRect().height > 0 && !send.hasAttribute('disabled') && send.getAttribute('aria-disabled') !== 'true') { send.click(); sent = true; }
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    } catch {
      // A failed authorization channel cannot grant a send or trigger a retry.
    } finally {
      if (this.dispatch === attempt) this.dispatch = undefined;
      this.emit({ type: 'result', nonce: command.nonce, sent });
      this.refresh();
    }
  }
  private async indexStickers() {
    if (this.indexing) return; this.indexing = true;
    try {
      const candidates = [...this.doc.querySelectorAll<HTMLImageElement>('img[data-testid*="sticker"], [data-testid*="sticker"] img, img[alt*="sticker" i], img[alt*="pegatina" i], img[alt*="figurinha" i]')]
        .filter(img => {
          const src = img.currentSrc || img.src;
          return stickerImageState(img) === 'ready' && !this.stickerSources.has(src) && !this.failedSources.has(src);
        }).slice(0, 150);
      for (const img of candidates) {
        const src = img.currentSrc || img.src;
        if (stickerImageState(img) !== 'ready' || this.stickerSources.has(src) || this.failedSources.has(src)) continue;
        try {
          const response = await fetch(src, { signal: AbortSignal.timeout(5000) });
          const blob = await response.blob();
          if (blob.size > MAX_STICKER_BYTES || blob.type !== 'image/webp') { this.failedSources.add(src); continue; }
          const bytes = await blob.arrayBuffer();
          const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
          const image = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); });
          this.stickerSources.set(src, id); this.emit({ type: 'sticker', image });
        } catch { this.failedSources.add(src); }
      }
    } finally { this.indexing = false; }
  }
}
