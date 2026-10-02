import { readDraft, composerProvablyEmpty } from './draft';
export { readDraft } from './draft';
import { messageDirection, ownElements, quoteSelector, peerFromMessageId } from './message-direction';
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
  return ownElements(node, textSelector).filter(n => !n.parentElement?.closest(textSelector)).map(n => readDraft(n)).join('\n').slice(0, 4000);
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
  private popupMode: 'refine' | 'notice' | 'pending' = 'notice';
  private suggestion?: Extract<RemoteCommand, { type: 'suggestion' }>;
  private replacement?: { command: Extract<RemoteCommand, { type: 'suggestion' }>; editor: HTMLElement; originalRange?: Range };
  private dismissedKey?: string;
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
    const name = (title?.textContent ?? main?.querySelector('header [title]')?.getAttribute('title') ?? main?.querySelector('header')?.textContent ?? '').trim().slice(0, 150);
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
    const messages: Message[] = nodes.slice(-30).map(node => {
      const attachment = messageAttachment(node), name = attachmentName(node), sender = senderLabel(node), quoted = quotedMessage(node);
      const message: Message = { id: node.dataset.id!.slice(0, 250),
        text: messageText(node),
        outgoing: messageDirection(node), ...(sender ? { sender } : {}), ...(attachment ? { attachment } : {}), ...(name ? { attachmentName: name } : {}), ...(quoted ? { quoted } : {}) };
      // WhatsApp replaces offscreen modern bubbles with empty height placeholders when resizing.
      // Keep only previously observed content in this chat; mounted edits/deletions still replace it.
      if (!peerFromMessageId(message.id) && !node.querySelector('[data-testid="msg-container"]') && !message.text && message.outgoing === null && !attachment && !sender && !quoted) return this.observedMessages.get(message.id) ?? message;
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
    this.button = this.doc.createElement('button'); this.button.className = 'trigger'; this.button.textContent = '✦'; this.button.title = 'Suggest or refine reply'; this.button.setAttribute('aria-label', 'Suggest or refine reply');
    this.button.setAttribute('aria-haspopup', 'dialog'); this.button.setAttribute('aria-expanded', 'false');
    this.button.addEventListener('click', event => { if (event.isTrusted) {
      if (!this.popup.hidden && this.popupMode === 'pending') { this.dismissPopup(); this.editor()?.focus(); }
      else if (!this.popup.hidden && this.popupMode === 'refine') { this.hidePopup(); this.editor()?.focus(); }
      else this.openPopup();
    } });
    shadow.append(style, this.ghost, this.popup, this.button); this.doc.documentElement.append(this.host);
    this.doc.addEventListener('keydown', this.keydown, true);
    this.doc.addEventListener('beforeinput', this.beforeInput, true);
    this.doc.addEventListener('pointerdown', this.pointer, true);
    this.doc.addEventListener('wheel', this.activity, { capture: true, passive: true });
    this.doc.addEventListener('compositionstart', this.compositionStart, true);
    this.doc.addEventListener('compositionend', this.compositionEnd, true);
    this.doc.addEventListener('selectionchange', this.selectionChanged);
    this.observer = new MutationObserver(() => this.refresh());
    this.observer.observe(this.doc.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-id', 'title', 'contenteditable', 'aria-selected'] });
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
    this.doc.removeEventListener('keydown', this.keydown, true); this.doc.removeEventListener('beforeinput', this.beforeInput, true);
    this.doc.removeEventListener('pointerdown', this.pointer, true); this.doc.removeEventListener('compositionstart', this.compositionStart, true);
    this.doc.removeEventListener('wheel', this.activity, true);
    this.doc.removeEventListener('compositionend', this.compositionEnd, true); this.doc.removeEventListener('selectionchange', this.selectionChanged);
  }
  private selectionChanged = () => this.refresh();
  private navigationEvent = (event: RemoteEvent) => {
    // Invalidate queued commands synchronously, before main can return a clear.
    if (event.type === 'cancelAuto' || event.type === 'navigate') this.takeover();
    this.emit(event);
  };
  private takeover(editing = false) {
    this.restoreReplacementSelection();
    this.activityGeneration++;
    if (editing) { this.editRevision++; this.clear(); if (this.popupMode === 'pending') this.hidePopup(); }
    this.emit({ type: 'activity', editing });
  }
  private activity = (event: Event) => { if (event.isTrusted && !this.inserting) this.takeover(); };
  private beforeInput = (event: Event) => {
    if (event.isTrusted && !this.inserting) this.takeover(event.target instanceof Node && Boolean(this.editor()?.contains(event.target)));
  };
  private pointer = (event: Event) => {
    if (!event.isTrusted) return;
    if (!event.composedPath().includes(this.host) && !this.navigation?.contains(event) && this.popupMode !== 'pending') this.hidePopup();
    this.activity(event);
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
    if (event.key === 'Escape' && (editor?.contains(event.target as Node) || event.composedPath().includes(this.host)) && (this.suggestion || !this.popup.hidden)) {
      this.dismissedKey = suggestionKey(this.read());
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
    try { return this.doc.execCommand('insertText', false, text); } finally { this.inserting = false; }
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
    this.replacement = undefined;
    this.takeover(true);
    this.insertAtSelection(command.text);
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
    this.takeover(true); this.hidePopup(); this.insert(suggestion.text, suggestion.replace);
  }
  private hidePopup() { this.popup.hidden = true; this.button.setAttribute('aria-expanded', 'false'); }
  private dismissPopup() {
    this.dismissedKey = suggestionKey(this.read()); this.takeover(); this.clear(); this.hidePopup(); this.emit({ type: 'dismiss' });
  }
  private popupShell(mode: typeof this.popupMode, title: string) {
    this.popupMode = mode; this.popup.replaceChildren(); this.popup.className = `popup ${mode}`;
    this.popup.hidden = false; this.popup.setAttribute('aria-label', title); this.button.setAttribute('aria-expanded', 'true');
    const header = this.doc.createElement('div'); header.className = 'popup-header';
    const label = this.doc.createElement('span'); label.textContent = title;
    const close = this.doc.createElement('button'); close.className = 'close'; close.textContent = '×'; close.setAttribute('aria-label', 'Close reply assistance');
    close.addEventListener('click', event => { if (!event.isTrusted) return; if (mode === 'refine') this.hidePopup(); else this.dismissPopup(); this.editor()?.focus(); });
    header.append(label, close); this.popup.append(header);
  }
  private clear() {
    this.restoreReplacementSelection();
    this.suggestion = undefined; this.ghost.textContent = '';
    if (this.hiddenPlaceholder) {
      const { element, visibility, priority } = this.hiddenPlaceholder;
      if (visibility) element.style.setProperty('visibility', visibility, priority); else element.style.removeProperty('visibility');
      this.hiddenPlaceholder = undefined;
    }
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
    for (const [key, value] of Object.entries(dark ? { background: '#161717', surface: '#242626', ink: '#e9edef', muted: '#9babae', line: '#373b3c', hover: '#2a3942' } : { background: '#fff', surface: '#f0f2f5', ink: '#111b21', muted: '#667781', line: '#d9e3df', hover: '#e9edef' })) this.host.style.setProperty(`--${key}`, value);
    const contentKey = suggestionKey(snapshot);
    if (key !== this.lastKey && !(this.dispatch && this.dispatchMatches(this.dispatch, snapshot))) {
      this.lastKey = key;
      if (this.suggestion && this.suggestion.key !== contentKey) this.clear();
      if (contentKey !== this.lastContentKey) this.hidePopup();
      this.lastContentKey = contentKey;
      this.emit({ type: 'snapshot', snapshot });
    }
    const editor = this.editor(), rect = editor?.getBoundingClientRect();
    this.button.hidden = !snapshot.ready;
    if (rect && editor) {
      this.button.style.left = `${Math.max(12, rect.right - 30)}px`; this.button.style.top = `${rect.top - 29}px`;
      this.popup.style.left = `${Math.max(8, Math.min(rect.right - 272, this.doc.documentElement.clientWidth - 280))}px`; this.popup.style.bottom = `${this.doc.documentElement.clientHeight - rect.top + 36}px`;
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
    const hasText = Boolean(snapshot.draft.trim() || suggested?.id);
    if (suggested?.replace && snapshot.draft.trim()) this.clear();
    this.takeover(); this.popupShell('refine', hasText ? snapshot.draft.trim() ? 'Refine draft' : 'Refine suggestion' : 'Reply assistance');
    const request = (instruction?: string) => {
      if (suggestionKey(this.read()) !== key) { this.hidePopup(); return; }
      this.dismissedKey = undefined;
      this.hidePopup();
      const editor = this.editor();
      if (editor) { editor.focus(); const range = this.doc.createRange(); range.selectNodeContents(editor); range.collapse(false); const selection = this.doc.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
      this.refresh(); this.emit({ type: 'request', instruction, key, ...(instruction && !snapshot.draft.trim() && suggested?.id ? { suggestionId: suggested.id } : {}) });
    };
    if (!hasText) {
      const suggest = this.doc.createElement('button'); suggest.className = 'action'; suggest.textContent = 'Suggest reply';
      suggest.addEventListener('click', event => { if (event.isTrusted) request(); }); this.popup.append(suggest); suggest.focus(); return;
    }
    const row = this.doc.createElement('div'); row.className = 'actions';
    let translating = false;
    for (const label of ['Shorter', 'Warmer', 'More direct', 'Translate…']) {
      const b = this.doc.createElement('button'); b.className = 'action'; b.textContent = label;
      b.addEventListener('click', e => {
        if (!e.isTrusted) return;
        if (label === 'Translate…') { translating = true; instruction.value = ''; instruction.placeholder = 'Language, e.g. Spanish'; instruction.setAttribute('aria-label', 'Translation language'); apply.disabled = true; instruction.focus(); }
        else request(`Make the draft ${label.toLowerCase()}.`);
      }); row.append(b);
    }
    const field = this.doc.createElement('div'); field.className = 'instruction';
    const instruction = this.doc.createElement('input'); instruction.placeholder = 'Ask for a change…'; instruction.setAttribute('aria-label', 'Refinement instruction'); instruction.maxLength = 950;
    const apply = this.doc.createElement('button'); apply.className = 'apply'; apply.textContent = '↑'; apply.setAttribute('aria-label', 'Apply instruction'); apply.disabled = true;
    const submit = () => { const text = instruction.value.trim(); if (text) request(translating ? `Translate the draft to ${text}.` : text); };
    instruction.addEventListener('input', () => { apply.disabled = !instruction.value.trim(); });
    apply.addEventListener('click', e => { if (e.isTrusted) submit(); });
    instruction.addEventListener('keydown', e => { if (e.isTrusted && e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); e.stopPropagation(); submit(); } });
    field.append(instruction, apply); this.popup.append(row, field); instruction.focus();
  }
  command(command: RemoteCommand) {
    if (command.type === 'captureStickerPickerLayout') { this.emit({ type: 'stickerPickerLayout', nonce: command.nonce, result: captureStickerPicker(this.doc) }); return; }
    if (command.type === 'makeSticker') { void this.stickerTransfer?.make(command, command.image); return; }
    if (command.type === 'prepareSticker') { void this.stickerTransfer?.prepare(command); return; }
    if (command.type === 'sendSticker') { void this.stickerTransfer?.send(command, command.expiresAt); return; }
    if (command.type === 'cancelSticker') { this.stickerTransfer?.cancel(); return; }
    if (command.type === 'chrome') { this.navigation?.update(command.panel, command.pending); this.stickerPickerLayout?.update(command.panelBounds ?? null, command.panel === 'chat' ? 'right' : 'left'); return; }
    if (command.type === 'clear') { this.dispatch = undefined; this.clear(); if (this.popupMode === 'pending') this.hidePopup(); return; }
    if (command.type === 'notice') {
      if (command.retryKey && command.retryKey !== suggestionKey(this.read())) return;
      this.popupShell('notice', 'Reply assistance'); const text = this.doc.createElement('div'); text.className = 'notice-text'; text.textContent = command.text; text.setAttribute('role', 'status'); this.popup.append(text);
      if (command.retryKey) {
        const retry = this.doc.createElement('button'); retry.className = 'action'; retry.textContent = 'Try again';
        retry.addEventListener('click', event => {
          if (!event.isTrusted || command.retryKey !== suggestionKey(this.read())) return;
          this.dismissedKey = undefined; this.hidePopup();
          const editor = this.editor();
          if (editor) { editor.focus(); const range = this.doc.createRange(); range.selectNodeContents(editor); range.collapse(false); const selection = this.doc.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
          this.refresh();
          this.emit({ type: 'request', key: command.retryKey });
        }); this.popup.append(retry);
      }
      return;
    }
    if (command.type === 'refining') {
      if (command.key !== suggestionKey(this.read()) || command.key === this.dismissedKey) return;
      this.clear(); this.popupShell('pending', 'Refining');
      const progress = this.doc.createElement('div'); progress.className = 'pending-text'; progress.setAttribute('role', 'status');
      const spinner = this.doc.createElement('span'); spinner.className = 'spinner'; spinner.setAttribute('aria-hidden', 'true');
      progress.append(spinner, 'Working on your text…'); this.popup.append(progress); return;
    }
    if (command.type === 'suggestion') {
      const editor = this.editor(), s = this.read();
      if (command.key !== suggestionKey(s) || command.key === this.dismissedKey || !s.ready || s.draftIssue || !editor || this.composing) return;
      this.clear(); this.suggestion = command; this.ghost.replaceChildren();
      if (this.popupMode === 'pending' || this.popupMode === 'notice') this.hidePopup();
      // An explicit refinement edits a written draft directly. Empty composers
      // keep the revised reply as ghost text, so Enter can never send it unseen.
      if (command.replace && s.draft.trim()) { void this.replaceDraft(command); return; }
      if (!s.draft) {
        const label = editor.getAttribute('aria-placeholder');
        const placeholder = [...(editor.parentElement?.children ?? [])].find(el => el !== editor && el instanceof HTMLElement && el.getAttribute('aria-hidden') === 'true' && label && el.textContent?.trim() === label) as HTMLElement | undefined;
        if (placeholder) {
          this.hiddenPlaceholder = { element: placeholder, visibility: placeholder.style.getPropertyValue('visibility'), priority: placeholder.style.getPropertyPriority('visibility') };
          placeholder.style.setProperty('visibility', 'hidden', 'important');
        }
      }
      if (!command.replace) { const prefix = this.doc.createElement('span'); prefix.textContent = s.draft; prefix.style.visibility = 'hidden'; this.ghost.append(prefix); }
      const suffix = this.doc.createElement('span'); suffix.textContent = command.text; this.ghost.append(suffix); this.syncGhostScroll();
      if (!this.popup.hidden && this.popupMode === 'refine' && !this.popup.querySelector('input') && command.id) this.openPopup();
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
  private syncGhostScroll() {
    const editor = this.editor();
    if (!editor || !this.suggestion) return;
    this.ghost.scrollTop = editor.scrollTop; this.ghost.scrollLeft = editor.scrollLeft;
    // If the suffix wraps below the viewport, reveal it in the overlay without moving the actual caret.
    const suffix = this.ghost.lastElementChild?.getBoundingClientRect(), viewport = this.ghost.getBoundingClientRect();
    if (suffix && suffix.top >= viewport.bottom) this.ghost.scrollTop += suffix.top - viewport.top - 10;
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
