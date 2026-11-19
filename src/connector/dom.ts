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
import { RecorderLayout } from './recorder-layout';
import { captureStickerPicker } from './sticker-picker-capture';
import { Navigation } from './navigation';
import { MAX_STICKER_BYTES } from '../shared/sticker-limits';
import { readChatTitle } from '../shared/chat-title';
import type { Snapshot, Message } from '../shared/model';
import { snapshotKey, suggestionKey, SnapshotKeys } from '../core/suggestions';
import type { RemoteCommand, RemoteEvent, AccountSafetyReason } from '../shared/connector';

const accountWarningSelector = '[role="dialog"], [role="alertdialog"], [role="alert"], [role="banner"], [data-testid="popup-contents"], [data-testid="banner"], [data-testid="account-warning"], [data-testid="account-restriction"]';
const loginSelector = '[data-testid="qrcode"], [data-testid="qr-code"], [data-testid="login-qr-code"], [data-testid="link-device"], [data-testid="logged-out"], .landing-wrapper, [data-ref]';
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
  const warnings = accountWarningSelector;
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
  const login = loginSelector;
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
type MessageContent = Omit<Message, 'id' | 'outgoing' | 'directionFallback'>;
type CachedMessage = { id: string; signature: string; version: number; connected: boolean; content: MessageContent; placeholderCandidate: boolean; message?: Message };
const stickerSelector = 'img[data-testid*="sticker"], [data-testid*="sticker"] img, img[alt*="sticker" i], img[alt*="pegatina" i], img[alt*="figurinha" i]';
const sourceCacheLimit = 1000;
const relevantUI = `#main, #pane-side, [data-navbar-item], [data-testid="expressions-panel"], ${accountWarningSelector}, ${loginSelector}, ${stickerSelector}`;
const svgNS = 'http://www.w3.org/2000/svg';
const refinements: Record<string, string> = {
  Shorter: 'Make the draft shorter.', Longer: 'Make the draft longer.', Warmer: 'Make the draft warmer.', Funnier: 'Make the draft funnier.',
  'More formal': 'Make the draft more formal.', 'More casual': 'Make the draft more casual.', 'More direct': 'Make the draft more direct.',
  'Fix spelling': 'Fix spelling, grammar and punctuation in the draft without changing its tone or meaning.', 'Add emoji': 'Add a few fitting emoji to the draft.'
};
export class DomConnector {
  private stickerTransfer?: StickerTransferConnector;
  private stickerPickerLayout?: StickerPickerLayout;
  private recorderLayout?: RecorderLayout;
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
  private popupKey?: string;
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
  private stopped = false;
  private aiFeatures = false;
  private intakeController = new AbortController();
  private stickersDirty = true;
  private refreshFrame?: number;
  private refreshTimeout?: ReturnType<typeof setTimeout>;
  private settleTimer?: ReturnType<typeof setTimeout>;
  private messageCache = new WeakMap<HTMLElement, CachedMessage>();
  private messageVersions = new WeakMap<HTMLElement, number>();
  private messageContext: Message[] = [];
  private layoutDirty = true;
  private theme?: boolean;
  private navigationReady?: boolean;
  private dotsGeometry?: { clipped: boolean; left?: number; top?: number };
  private snapshotKeys = new SnapshotKeys();
  private inserting = false;
  private dispatch?: { command: Extract<RemoteCommand, { type: 'autoSend' }>; before: Snapshot; editor: HTMLElement };
  constructor(private doc: Document, private emit: (event: RemoteEvent) => void, private authorizeAutomatic: (nonce: string) => Promise<boolean> = async () => false, private authorizeSticker: (nonce: string | StickerAuthorization) => Promise<boolean> = async () => false) {}
  editor() { return this.doc.querySelector<HTMLElement>('#main footer [contenteditable="true"][role="textbox"], #main [data-testid="conversation-compose-box-input"][contenteditable="true"]'); }
  // Public reads are deliberately uncached: commands, acceptance and send
  // authorization must observe current DOM evidence, even before observer delivery.
  read(fresh = true): Snapshot {
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
      this.observedMessages.clear(); this.messageCache = new WeakMap();
    }
    const contents = new Map<HTMLElement, CachedMessage>();
    const content = (node: HTMLElement) => {
      let entry = contents.get(node);
      if (!entry) { entry = this.extractMessage(node, fresh); contents.set(node, entry); }
      return entry;
    };
    const directions = new Map<HTMLElement, boolean | null>();
    const explicitDirections = new Map<HTMLElement, boolean | null>();
    const directionGeometry = new Map<Element, DOMRect>();
    nodes.forEach((node, index) => {
      const explicit = messageDirection(node); explicitDirections.set(node, explicit);
      const previous = nodes[index - 1];
      // External direction evidence is never cached: wrapper classes/IDs,
      // sibling tails/labels/author headers, preceding rows and pane geometry
      // are read again, including when an unchanged bubble is a placeholder.
      const outgoing = explicit ?? (content(node).placeholderCandidate ? this.observedMessages.get(node.dataset.id!.slice(0, 250))?.outgoing ?? null
        : main instanceof HTMLElement ? fallbackDirection(node, main, previous && { node: previous, direction: directions.get(previous) ?? null }, directionGeometry) : null);
      directions.set(node, outgoing);
    });
    let messages: Message[] = nodes.slice(-30).map(node => {
      const entry = content(node), explicit = explicitDirections.get(node) ?? null, outgoing = directions.get(node) ?? null;
      const directionFallback = explicit === null && outgoing !== null;
      const message: Message = !fresh && entry.message?.outgoing === outgoing && Boolean(entry.message.directionFallback) === directionFallback ? entry.message :
        { id: entry.id, ...entry.content, outgoing, ...(directionFallback ? { directionFallback: true as const } : {}) };
      entry.message = message;
      // Virtualized placeholders retain only content already observed in this chat.
      // Real mounted edits/deletions always replace it; direction is reread above.
      if (entry.placeholderCandidate && explicit === null) return this.observedMessages.get(message.id) ?? message;
      this.observedMessages.set(message.id, message);
      while (this.observedMessages.size > 100) this.observedMessages.delete(this.observedMessages.keys().next().value!);
      return message;
    });
    if (messages.length === this.messageContext.length && messages.every((message, index) => message === this.messageContext[index])) messages = this.messageContext;
    else this.messageContext = messages;
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
  private extractMessage(node: HTMLElement, fresh: boolean): CachedMessage {
    const id = node.dataset.id!.slice(0, 250);
    // Text catches edits even before observer delivery; mutation versions catch
    // emoji, quotes, media and structural changes with identical text content.
    const signature = `${node.dataset.id}|${node.childNodes.length}|${node.textContent}`;
    const version = this.messageVersions.get(node) ?? 0;
    const cached = this.messageCache.get(node);
    if (!fresh && cached?.id === id && cached.signature === signature && cached.version === version && cached.connected === node.isConnected) return cached;
    const attachment = messageAttachment(node), name = attachmentName(node), sender = senderLabel(node), quoted = quotedMessage(node), text = messageText(node);
    const content: MessageContent = { text, ...(sender ? { sender } : {}), ...(attachment ? { attachment } : {}), ...(name ? { attachmentName: name } : {}), ...(quoted ? { quoted } : {}) };
    // Cache only evidence inside the bubble. Ancestor quote membership is
    // checked when selecting nodes on every read; internal quote/author edits
    // invalidate content via mutation versions. Whether an empty bubble may
    // retain an observed message also depends on the current explicit direction.
    const placeholderCandidate = !peerFromMessageId(node.dataset.id!) && !node.querySelector('[data-testid="msg-container"]') &&
      !text && !attachment && !sender && !quoted;
    const entry = { id, signature, version, connected: node.isConnected, content, placeholderCandidate };
    this.messageCache.set(node, entry);
    return entry;
  }
  start() {
    this.stopped = false; this.intakeController = new AbortController();
    this.stickerPickerLayout = new StickerPickerLayout(this.doc);
    this.recorderLayout = new RecorderLayout(this.doc);
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
      const intent = this.userIntent();
      const snapshot = this.flushAction();
      if (intent.pending?.origin === 'user') {
        this.dismissPopup(intent.dismissal, snapshot); this.editor()?.focus();
      }
      else if (intent.pending?.origin === 'auto') {
        // Automatic empty-composer work keeps running; return focus so Tab and typing still reach the composer.
        if (snapshot.draft.trim()) { this.dismissPopup(intent.dismissal, snapshot); this.openPopup(intent, snapshot); }
        else this.editor()?.focus();
      }
      else if (intent.popup === 'refine') { this.hidePopup(snapshot); this.editor()?.focus(); }
      else this.openPopup(intent, snapshot);
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
    this.observer = new MutationObserver(records => this.mutations(records));
    this.observer.observe(this.doc.body, { childList: true, subtree: true, characterData: true, attributes: true });
    // Mutation/load events drive discovery. Poll only for changes without DOM
    // records (visibility, layout, focus/readiness and native picker transitions).
    this.timer = setInterval(() => { this.layoutDirty = true; this.refresh(); }, 1000);
    this.doc.addEventListener('load', this.imageLoaded, true);
    this.refresh();
  }
  stop() {
    this.stopped = true; this.intakeController.abort();
    if (this.refreshFrame !== undefined) this.doc.defaultView?.cancelAnimationFrame(this.refreshFrame);
    this.refreshFrame = undefined; clearTimeout(this.settleTimer); this.settleTimer = undefined;
    clearTimeout(this.refreshTimeout); this.refreshTimeout = undefined;
    this.doc.removeEventListener('load', this.imageLoaded, true);
    this.stickerPickerLayout?.stop();
    this.recorderLayout?.stop();
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
  private owned(node: Node) {
    const element = node instanceof Element ? node : node.parentElement;
    return Boolean(element?.closest('#companion-overlay, #companion-navigation, #companion-chat-settings'));
  }
  private mutations(records: MutationRecord[], schedule = true) {
    let relevant = false, traversed = 0, processed = 0;
    const limit = 512;
    const overflow = () => {
      // Reset rather than leave recycled/detached messages cached incorrectly.
      this.messageCache = new WeakMap(); this.layoutDirty = true; this.stickersDirty = true; relevant = true;
    };
    for (const record of records) {
      if (++processed > 200) { overflow(); break; }
      if (this.owned(record.target) || (record.target === this.hiddenPlaceholder?.element && record.attributeName === 'style')) continue;
      const changed: Node[] = [];
      for (const nodes of [record.addedNodes, record.removedNodes]) {
        for (const node of nodes) {
          if (++traversed > limit) break;
          changed.push(node);
        }
        if (traversed > limit) break;
      }
      if (traversed > limit) { overflow(); break; }
      if (record.type === 'childList' && changed.length && changed.every(node => this.owned(node))) continue;
      const element = record.target instanceof Element ? record.target : record.target.parentElement;
      if (!element) continue;
      // Filter before walking descendants. Companion-owned/irrelevant mutations
      // must never trigger subtree invalidation.
      if (element !== this.doc.body && !element.closest(relevantUI) && !element.querySelector(relevantUI) &&
          !changed.some(node => node instanceof Element && (node.matches(relevantUI) || node.querySelector(relevantUI)))) continue;
      if (record.type === 'childList') {
        for (const node of changed) {
          if (!(node instanceof Element)) continue;
          if (node instanceof HTMLElement) this.messageCache.delete(node);
          const walker = this.doc.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
          let descendant: Node | null;
          while ((descendant = walker.nextNode())) {
            if (++traversed > limit) break;
            if (descendant instanceof HTMLElement) this.messageCache.delete(descendant);
          }
          if (traversed > limit) break;
        }
        if (traversed > limit) { overflow(); break; }
      }
      // Observe body to retain portalled picker, warning and login detection, but
      // ignore irrelevant attributes and our own DOM. Bubble attributes are all
      // relevant to extraction (emoji, quotes, media and recycled message nodes).
      const bubble = element.closest<HTMLElement>('#main [data-id]');
      const structural = record.type !== 'attributes';
      const attribute = record.attributeName ?? '';
      if (!bubble && !structural && !/^(?:data-.+|class|style|hidden|title|contenteditable|aria-.+|src|alt)$/.test(attribute)) continue;
      relevant = true;
      for (let node: HTMLElement | null = bubble; node; node = node.parentElement?.closest<HTMLElement>('[data-id]') ?? null) {
        if (++traversed > limit) { overflow(); break; }
        this.messageVersions.set(node, (this.messageVersions.get(node) ?? 0) + 1);
      }
      if (traversed > limit) break;
      if (structural || /^(?:class|style|hidden|contenteditable|aria-.+|data-.+)$/.test(attribute)) this.layoutDirty = true;
      if ((structural || ['src', 'srcset', 'alt', 'data-testid'].includes(attribute)) &&
          ((element.matches(stickerSelector) || element.closest('[data-testid*="sticker"], [data-testid="expressions-panel"]')) ||
          changed.some(node => node instanceof Element && (node.matches(stickerSelector) || node.querySelector(stickerSelector))))) this.stickersDirty = true;
    }
    // Records only dirty caches/layout. Visible work is invalidated by keys in
    // refresh(), after read() resolves retained placeholders and conversation
    // semantics. Raw chrome mutations need not change the suggestion context.
    if (relevant && schedule) this.scheduleRefresh();
  }
  private imageLoaded = (event: Event) => {
    if (event.target instanceof HTMLImageElement && event.target.matches(stickerSelector)) {
      this.stickersDirty = true; this.scheduleRefresh();
    }
  };
  private scheduleRefresh() {
    if (this.stopped || !this.host?.isConnected) return;
    if (this.doc.hidden) {
      // Chromium suspends frames in minimized windows. Batch hidden mutations
      // in a timer turn, including when an earlier visible frame is pending.
      if (this.refreshFrame !== undefined) {
        this.doc.defaultView?.cancelAnimationFrame(this.refreshFrame);
        this.refreshFrame = undefined;
        clearTimeout(this.refreshTimeout); this.refreshTimeout = undefined;
      }
      if (this.refreshTimeout === undefined) this.refreshTimeout = setTimeout(() => this.refresh(), 0);
    } else if (this.refreshTimeout === undefined) {
      // A visible document can also miss a frame; never wait on rAF alone.
      this.refreshTimeout = setTimeout(() => this.refresh(), 100);
      this.refreshFrame = this.doc.defaultView?.requestAnimationFrame(() => this.refresh());
    }
  }
  private selectionChanged = () => this.scheduleRefresh();
  private scroll = (event?: Event) => {
    this.dotsGeometry = undefined;
    if (event?.type === 'input') {
      // Input/fill can precede observer delivery and the next animation frame.
      // Dirty composer layout and its accessible trigger immediately.
      this.layoutDirty = true; this.updateTrigger(); this.scheduleRefresh();
    }
    this.syncGhostScroll();
  };
  private resize = () => { this.layoutDirty = true; this.refresh(); };
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
    const intent = this.userIntent();
    if (!event.composedPath().includes(this.host) && !this.navigation?.contains(event) && intent.popup) this.hidePopup();
    const send = event.target instanceof Element ? event.target.closest('#main footer button, #main footer [role="button"]') : null;
    if (intent.pending && send?.querySelector('[data-icon="send"]')) this.takeover(true);
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
    if (!event.isTrusted) return;
    // Escape and Tab target what is visible before reconciliation, even if
    // refresh clears it or main synchronously republishes a newer item.
    const intent = this.userIntent();
    const wasShown = Boolean(intent.pending || intent.suggestion || intent.popup);
    const snapshot = ['Escape', 'Tab'].includes(event.key) ? this.flushAction() : undefined;
    if (event.isComposing || (snapshot?.composing ?? this.composing) || event.keyCode === 229) return;
    const editor = this.editor();
    if (event.key === 'Escape' && (editor?.contains(event.target as Node) || event.composedPath().includes(this.host)) && wasShown) {
      event.preventDefault(); event.stopImmediatePropagation(); this.dismissPopup(intent.dismissal, snapshot); editor?.focus(); return;
    }
    if (event.target !== editor && !editor?.contains(event.target as Node)) {
      if (!['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) this.takeover();
      return;
    }
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && intent.suggestion && editor && snapshot?.focused && snapshot.caretAtEnd) {
      if (suggestionKey(this.read()) !== intent.suggestion.key) {
        if (this.suggestion === intent.suggestion) this.clear(snapshot);
        return;
      }
      event.preventDefault(); event.stopImmediatePropagation();
      this.acceptSuggestion(intent.suggestion, snapshot); return;
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
      else this.restoreReplacementSelection();
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
  private acceptSuggestion(suggestion = this.userIntent().suggestion, snapshot = this.flushAction()) {
    const current = this.read();
    if (!suggestion || suggestion.key !== suggestionKey(current) || !current.ready || current.composing || current.draftIssue) return;
    // Keep the displayed command's identity, including any active replacement.
    if (suggestion.replace && this.suggestion !== suggestion) return;
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

  private hidePopup(snapshot?: Snapshot) {
    this.popupRequest = undefined; this.popupKey = undefined;
    if (this.popup.hidden) return;
    this.popup.hidden = true; this.button.setAttribute('aria-expanded', 'false'); this.updateTrigger(snapshot);
  }
  private userIntent() {
    return {
      popup: this.popup.hidden ? undefined : this.popupMode,
      pending: this.pending, suggestion: this.suggestion, dismissal: this.dismissalTarget()
    };
  }
  private dismissalTarget() {
    const request = this.pending ? { id: this.pending.requestId } : !this.popup.hidden ? this.popupRequest : undefined;
    const offer = request ? undefined : this.suggestion;
    return { request, offer };
  }
  private dismissPopup(target = this.dismissalTarget(), snapshot = this.flushAction()) {
    const { request, offer } = target;
    const id = request?.id ?? offer?.id;
    if (id) {
      this.dismissedIds.add(id);
      if (offer?.requestId) this.dismissedIds.add(offer.requestId);
      while (this.dismissedIds.size > 50) this.dismissedIds.delete(this.dismissedIds.values().next().value!);
    } else this.dismissedKey = offer?.key ?? suggestionKey(snapshot);
    // Clear locally before main can synchronously publish a newer item.
    this.clear(snapshot); this.hidePopup(snapshot);
    this.emit({ type: 'dismiss', ...(request ? { requestId: request.id } : offer?.id ? { suggestionId: offer.id, key: offer.key } : {}) });
    this.takeover();
  }
  private popupShell(mode: typeof this.popupMode, title: string, key: string) {
    this.popupKey = key; this.popupRequest = undefined; this.popupMode = mode; this.popup.replaceChildren(); this.popup.className = `popup ${mode}`;
    this.popup.hidden = false; this.popup.setAttribute('aria-label', title); this.button.setAttribute('aria-expanded', 'true');
    const header = this.doc.createElement('div'); header.className = 'popup-header';
    const label = this.doc.createElement('span'); label.textContent = title;
    const close = this.doc.createElement('button'); close.className = 'close'; close.textContent = '×'; close.setAttribute('aria-label', 'Close reply assistance');
    close.addEventListener('click', event => {
      if (!event.isTrusted) return;
      const target = this.dismissalTarget();
      const snapshot = this.flushAction();
      this.dismissPopup(target, snapshot); this.editor()?.focus();
    });
    header.append(label, close); this.popup.append(header);
  }
  private clear(snapshot?: Snapshot) {
    const shown = Boolean(this.replacement || this.pending || this.suggestion || this.fallbackDots || this.hiddenPlaceholder || this.ghost.textContent);
    this.restoreReplacementSelection();
    if (!shown) return;
    this.dotsGeometry = undefined;
    this.fallbackDots?.remove(); this.fallbackDots = undefined;
    this.pending = undefined; clearInterval(this.dotsTimer); this.dotsTimer = undefined;
    this.loadingStatus.textContent = '';
    this.suggestion = undefined; this.ghost.textContent = ''; this.ghost.classList.remove('loading');
    if (this.hiddenPlaceholder) {
      const { element, visibility, priority } = this.hiddenPlaceholder;
      if (visibility) element.style.setProperty('visibility', visibility, priority); else element.style.removeProperty('visibility');
      this.hiddenPlaceholder = undefined;
    }
    this.updateTrigger(snapshot);
  }
  private stickerReadiness = new StickerReadiness();
  private flushAction(): Snapshot {
    // Call once after capturing the visible target. Fresh reads write through
    // extraction caches; reconciliation consumes pre-action DOM changes now.
    return this.refresh(false, true) ?? this.read();
  }
  private publishSnapshot(snapshot: Snapshot, key: string, contentKey: string) {
    // A popup belongs to its creation context, not the last publication.
    if (this.popupKey !== undefined && this.popupKey !== contentKey) this.hidePopup(snapshot);
    if (key !== this.lastKey && !(this.dispatch && this.dispatchMatches(this.dispatch, snapshot))) {
      this.lastKey = key;
      if ((this.suggestion && this.suggestion.key !== contentKey) || (this.pending && this.pending.key !== contentKey)) this.clear(snapshot);
      this.lastContentKey = contentKey;
      this.emit({ type: 'snapshot', snapshot });
    }
  }
  private refreshRequest(): Snapshot {
    // Focus/selection/activity can change in the handler body after its one
    // action flush. Publish fresh evidence immediately before the request, using
    // the same reconciliation as refresh without a second action/layout flush.
    this.mutations(this.observer?.takeRecords() ?? [], false);
    const snapshot = this.read();
    this.publishSnapshot(snapshot, snapshotKey(snapshot), suggestionKey(snapshot));
    this.updateTrigger(snapshot);
    return snapshot;
  }
  private refresh(replace = true, fresh = false) {
    if (this.stopped) return;
    if (this.refreshFrame !== undefined) this.doc.defaultView?.cancelAnimationFrame(this.refreshFrame);
    this.refreshFrame = undefined;
    clearTimeout(this.refreshTimeout); this.refreshTimeout = undefined;
    // A synchronous command/manual refresh can precede observer delivery.
    this.mutations(this.observer?.takeRecords() ?? [], false);
    const reason = accountSafetyReason(this.doc);
    if (reason !== this.lastAccountSafety) {
      this.lastAccountSafety = reason;
      this.emit({ type: 'accountSafety', reason });
    }
    const snapshot = this.read(fresh), keys = fresh ? { snapshot: snapshotKey(snapshot), suggestion: suggestionKey(snapshot) } : this.snapshotKeys.keys(snapshot), key = keys.snapshot;
    // Read composer geometry/style before navigation, picker and overlay writes.
    const editor = this.editor(), rect = this.layoutDirty ? editor?.getBoundingClientRect() : undefined;
    const editorStyle = rect && editor ? getComputedStyle(editor) : undefined;
    const css = editorStyle ? Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'padding', 'paddingBottom', 'direction', 'textAlign'].map(property => [property, editorStyle[property as keyof CSSStyleDeclaration]])) : undefined;
    const geometry = rect && editor && css && this.layoutDirty ? {
      rect, clientLeft: editor.clientLeft, clientTop: editor.clientTop, clientWidth: editor.clientWidth, clientHeight: editor.clientHeight,
      css, width: this.doc.documentElement.clientWidth, height: this.doc.documentElement.clientHeight
    } : undefined;
    const navigationReady = this.stickerReadiness.present(snapshot, snapshot.stickerPreparation).ready;
    if (this.layoutDirty || this.navigationReady !== navigationReady) this.navigation?.refresh(navigationReady);
    this.navigationReady = navigationReady;
    if (this.layoutDirty) this.stickerPickerLayout?.refresh();
    if (this.layoutDirty) this.recorderLayout?.refresh();
    const dark = this.navigation?.theme !== 'light';
    if (dark !== this.theme) for (const [key, value] of Object.entries(dark ? { background: '#161717', surface: '#242626', ink: '#e9edef', muted: '#9babae', line: '#373b3c', hover: '#2e2f2f' } : { background: '#fff', surface: '#f0f2f5', ink: '#111b21', muted: '#667781', line: '#d9e3df', hover: '#e9edef' })) this.host.style.setProperty(`--${key}`, value);
    this.theme = dark;
    const contentKey = keys.suggestion;
    this.publishSnapshot(snapshot, key, contentKey);
    this.button.hidden = !this.aiFeatures || !snapshot.ready; this.updateTrigger(snapshot);
    if (geometry && editor) {
      const { rect, css, clientLeft, clientTop, clientWidth, clientHeight, width, height } = geometry;
      this.button.style.left = `${Math.max(12, rect.right - 30)}px`; this.button.style.top = `${rect.top - 29}px`;
      this.popup.style.left = `${Math.max(8, Math.min(rect.right - 296, width - 304))}px`; this.popup.style.bottom = `${height - rect.top + 36}px`;
      this.popup.style.maxHeight = `${Math.max(80, rect.top - 44)}px`;
      Object.assign(this.ghost.style, { left: `${rect.left + clientLeft}px`, top: `${rect.top + clientTop}px`, width: `${clientWidth}px`, height: `${clientHeight}px`, fontFamily: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight, fontStyle: css.fontStyle, letterSpacing: css.letterSpacing, lineHeight: css.lineHeight, padding: css.padding, clipPath: `inset(0 0 ${css.paddingBottom || '0px'} 0)`, direction: css.direction, textAlign: css.textAlign });
      this.dotsGeometry = undefined; this.syncGhostScroll();
    }
    this.layoutDirty = false;
    if (!snapshot.conversationOpen || !snapshot.ready) {
      clearTimeout(this.settleTimer);
      // Preserve the 500 ms stability window without a fast perpetual poll.
      const due = Math.max(this.stableSince, this.composerStableSince) + 500 - Date.now();
      if (due > 0) this.settleTimer = setTimeout(() => { this.layoutDirty = true; this.scheduleRefresh(); }, due);
    }
    if (this.stickersDirty) { this.stickersDirty = false; void this.indexStickers(); }
    if (replace && snapshot.focused && snapshot.draft.trim() && this.suggestion?.replace && !this.replacement) void this.replaceDraft(this.suggestion);
    return snapshot;
  }
  private openPopup(intent = this.userIntent(), snapshot = this.flushAction()) {
    const key = suggestionKey(snapshot);
    const suggested = intent.suggestion?.key === key ? intent.suggestion : undefined;
    const hasText = Boolean(snapshot.draft.trim() || suggested);
    if (suggested?.replace && snapshot.draft.trim()) this.clear();
    this.takeover();
    const request = (instruction?: string, operation?: 'translate' | 'retry') => {
      if (suggestionKey(this.read()) !== key) { this.hidePopup(); return; }
      this.dismissedKey = undefined;
      this.hidePopup();
      const editor = this.editor();
      if (editor) { editor.focus(); const range = this.doc.createRange(); range.selectNodeContents(editor); range.collapse(false); const selection = this.doc.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
      const current = this.refreshRequest();
      if (suggestionKey(current) !== key) return;
      this.emit({ type: 'request', instruction, ...(operation ? { operation } : {}), key: suggestionKey(current), ...(instruction && !snapshot.draft.trim() && suggested?.id ? { suggestionId: suggested.id } : {}) });
    };
    if (!hasText) {
      request(); return;
    }
    this.popupShell('refine', snapshot.draft.trim() ? 'Refine draft' : 'Refine suggestion', key);
    const row = this.doc.createElement('div'); row.className = 'actions';
    let translating = false;
    for (const label of [...Object.keys(refinements), 'Translate…']) {
      const b = this.doc.createElement('button'); b.className = 'action'; b.textContent = label;
      b.addEventListener('click', e => {
        if (!e.isTrusted) return;
        // The clicked option belongs to this visible popup, not any popup
        // main may republish while the composer is flushed.
        const intent = this.userIntent();
        const current = this.flushAction();
        if (intent.popup !== 'refine' || suggestionKey(this.read()) !== key) { this.hidePopup(current); return; }
        if (label === 'Translate…') {
          translating = true; instruction.value = ''; instruction.placeholder = 'Language, e.g. Spanish';
          instruction.setAttribute('aria-label', 'Translation language'); apply.disabled = true; instruction.focus();
        }
        else request(refinements[label]);
      }); row.append(b);
    }
    const field = this.doc.createElement('div'); field.className = 'instruction';
    const instruction = this.doc.createElement('input'); instruction.placeholder = 'Ask for a change…'; instruction.setAttribute('aria-label', 'Refinement instruction'); instruction.maxLength = 950;
    const apply = this.doc.createElement('button'); apply.className = 'apply'; apply.setAttribute('aria-label', 'Apply instruction'); apply.disabled = true;
    const icon = this.doc.createElementNS(svgNS, 'svg'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    const path = this.doc.createElementNS(svgNS, 'path'); path.setAttribute('fill', 'currentColor'); path.setAttribute('d', 'M2.01 21 23 12 2.01 3 2 10l15 2-15 2z');
    icon.append(path); apply.append(icon);
    const submit = (event?: KeyboardEvent) => {
      // Read instruction and translation mode before request flushes the popup.
      const intent = this.userIntent(), text = instruction.value.trim(), translate = translating;
      const current = this.flushAction();
      event?.preventDefault(); event?.stopPropagation();
      if (intent.popup !== 'refine' || suggestionKey(this.read()) !== key) { this.hidePopup(current); return; }
      if (text) request(translate ? `Translate the draft to ${text}.` : text, translate ? 'translate' : undefined);
    };
    instruction.addEventListener('input', () => { apply.disabled = !instruction.value.trim(); });
    apply.addEventListener('click', e => { if (e.isTrusted) submit(); });
    instruction.addEventListener('keydown', e => { if (e.isTrusted && e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { submit(e); } });
    field.append(instruction, apply); this.popup.append(row, field); instruction.focus();
  }
  command(command: RemoteCommand) {
    if (command.type === 'snapshot') { this.dismissedKey = undefined; const snapshot = this.refresh(true, true) ?? this.read(); this.emit({ type: 'snapshot', snapshot, nonce: command.nonce }); return; }
    if (command.type === 'captureStickerPickerLayout') { this.emit({ type: 'stickerPickerLayout', nonce: command.nonce, result: captureStickerPicker(this.doc) }); return; }
    if (command.type === 'makeSticker') { void this.stickerTransfer?.make(command, command.image); return; }
    if (command.type === 'prepareSticker') { void this.stickerTransfer?.prepare(command); return; }
    if (command.type === 'sendSticker') { void this.stickerTransfer?.send(command, command.expiresAt); return; }
    if (command.type === 'cancelSticker') { this.stickerTransfer?.cancel(); return; }
    if (command.type === 'chrome') {
      const changed = this.aiFeatures !== (command.aiFeatures === true);
      this.aiFeatures = command.aiFeatures === true;
      this.navigation?.update(command.panel, command.pending, this.aiFeatures);
      if (changed) {
        if (!this.aiFeatures) { this.dispatch = undefined; this.clear(); this.hidePopup(); }
        this.layoutDirty = true; this.refresh(true);
      }
      this.stickerPickerLayout?.update(command.panelBounds ?? null, command.panel === 'chat' ? 'right' : 'left'); return;
    }
    if (command.type === 'clear') { this.dispatch = undefined; this.clear(); if (this.popupMode === 'notice') this.hidePopup(); return; }
    if (!this.aiFeatures && ['thinking', 'refining', 'suggestion', 'autoSend', 'notice'].includes(command.type)) return;
    if (command.type === 'notice') {
      if ((command.requestId && this.dismissedIds.has(command.requestId)) || (command.retryKey && command.retryKey !== suggestionKey(this.read()))) return;
      if (this.pending) this.clear();
      this.popupShell('notice', 'Reply assistance', command.retryKey ?? suggestionKey(this.read()));
      if (command.requestId) this.popupRequest = { id: command.requestId };
      const text = this.doc.createElement('div'); text.className = 'notice-text'; text.textContent = command.text; text.setAttribute('role', 'status'); this.popup.append(text);
      if (command.retryKey) {
        const retry = this.doc.createElement('button'); retry.className = 'action'; retry.textContent = 'Try again';
        retry.addEventListener('click', event => {
          if (!event.isTrusted) return;
          const intent = this.userIntent(), retryKey = command.retryKey!;
          this.flushAction();
          if (intent.popup !== 'notice' || suggestionKey(this.read()) !== retryKey) return;
          this.dismissedKey = undefined; this.hidePopup();
          const editor = this.editor();
          if (editor) { editor.focus(); const range = this.doc.createRange(); range.selectNodeContents(editor); range.collapse(false); const selection = this.doc.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
          const current = this.refreshRequest();
          if (suggestionKey(current) !== retryKey) return;
          this.emit({ type: 'request', operation: 'retry', key: suggestionKey(current) });
        }); this.popup.append(retry);
      }
      return;
    }
    if (command.type === 'refining' || command.type === 'thinking') {
      const snapshot = this.read();
      if (command.key !== suggestionKey(snapshot) || this.dismissedIds.has(command.requestId)) return;
      // Compatible re-publication must not restart animation or re-announce status.
      if (this.pending?.requestId === command.requestId && this.pending.key === command.key && this.pending.type === command.type && this.pending.origin === command.origin) return;
      if (snapshot.composing || snapshot.draftIssue || !snapshot.ready) return;
      this.clear(snapshot); this.hidePopup(snapshot); this.pending = command;
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
      const render = (measure = false) => {
        const count = motion?.matches ? 3 : step;
        periods.forEach((period, index) => {
          period.style.opacity = fallbackPeriods[index].style.opacity = index < count ? '1' : '0';
        });
        if (measure) this.syncGhostScroll();
      };
      this.ghost.append(prefix, dots); this.dotsGeometry = undefined; render(true);
      let settled = false;
      this.dotsTimer = setInterval(() => { step = step % 3 + 1; if (!settled) this.dotsGeometry = undefined; render(!settled); settled = true; }, 400);
      // Announce only requests the user asked for; automatic dots after every typing pause would be noisy.
      if (command.origin === 'user' && !this.announcedRequests.has(command.requestId)) {
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
      this.clear(s); this.suggestion = command; this.ghost.replaceChildren();
      if (this.popupMode === 'notice') this.hidePopup(s);
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
  private updateTrigger(snapshot?: Pick<Snapshot, 'draft'>) {
    // Button labels only need the composer, never message context or geometry.
    const editor = snapshot ? null : this.editor();
    const draft = snapshot?.draft ?? (editor ? readDraft(editor) : '');
    const cancels = this.pending?.origin === 'user';
    const label = cancels ? 'Cancel' : draft.trim() ? 'Refine draft' : this.suggestion ? 'Refine suggestion' : 'Suggest reply';
    this.button.title = label; this.button.setAttribute('aria-label', label);
    this.button.setAttribute('aria-haspopup', cancels || (!draft.trim() && !this.suggestion) ? 'false' : 'dialog');
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
  private ghostViewport() {
    const rect = this.ghost.getBoundingClientRect();
    // Keep the top padding visible for scrolled text, but exclude the bottom padding.
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom - (parseFloat(this.ghost.style.paddingBottom) || 0) };
  }
  private syncGhostScroll() {
    const editor = this.editor();
    if (!editor || (!this.suggestion && !this.pending)) return;
    this.ghost.scrollTop = editor.scrollTop; this.ghost.scrollLeft = editor.scrollLeft;
    if (this.pending) { this.positionDots(); return; }
    // If the suffix wraps below the viewport, reveal it in the overlay without moving the actual caret.
    const suffix = this.ghost.lastElementChild?.getBoundingClientRect(), viewport = this.ghostViewport();
    if (suffix && suffix.top >= viewport.bottom) this.ghost.scrollTop += suffix.top - viewport.top - 10;
  }
  private positionDots() {
    const dots = this.ghost.querySelector<HTMLElement>('.dots'), fallback = this.fallbackDots;
    if (!dots || !fallback) return;
    // Opacity cycling never changes geometry. Invalidate on layout, input,
    // scroll, resize and new requests, rather than remeasure every animation tick.
    if (!this.dotsGeometry) {
      const viewport = this.ghostViewport();
      const periods = [...dots.children].map(period => period.getBoundingClientRect());
      const clipped = periods.some(rect => rect.right > viewport.right || rect.left < viewport.left ||
        rect.top < viewport.top || rect.bottom > viewport.bottom);
      const trigger = clipped ? this.button.getBoundingClientRect() : undefined;
      this.dotsGeometry = { clipped, ...(trigger ? { left: trigger.left - 6, top: trigger.top + trigger.height / 2 } : {}) };
    }
    const geometry = this.dotsGeometry;
    dots.style.visibility = geometry.clipped ? 'hidden' : 'visible'; fallback.hidden = !geometry.clipped;
    if (geometry.clipped) Object.assign(fallback.style, { left: `${geometry.left}px`, top: `${geometry.top}px`,
      fontFamily: this.ghost.style.fontFamily, fontSize: this.ghost.style.fontSize,
      fontWeight: this.ghost.style.fontWeight, fontStyle: this.ghost.style.fontStyle,
      lineHeight: this.ghost.style.lineHeight });
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
  private trimSources() {
    // Protect currently mounted sources, which are also used by send lookups.
    // The cap covers retained history; active DOM sources may exceed it.
    if (this.stickerSources.size <= sourceCacheLimit && this.failedSources.size <= sourceCacheLimit) return;
    const mounted = new Set([...this.doc.images].map(image => image.currentSrc || image.src));
    for (const source of this.stickerSources.keys()) {
      if (this.stickerSources.size <= sourceCacheLimit) break;
      if (!mounted.has(source)) this.stickerSources.delete(source);
    }
    for (const source of this.failedSources) {
      if (this.failedSources.size <= sourceCacheLimit) break;
      if (!mounted.has(source)) this.failedSources.delete(source);
    }
  }
  private async indexStickers() {
    if (this.stopped) return;
    if (this.indexing) { this.stickersDirty = true; return; } this.indexing = true;
    const controller = this.intakeController;
    this.trimSources();
    try {
      const candidates = [...this.doc.querySelectorAll<HTMLImageElement>(stickerSelector)]
        .filter(img => {
          const src = img.currentSrc || img.src;
          return stickerImageState(img) === 'ready' && !this.stickerSources.has(src) && !this.failedSources.has(src);
        }).slice(0, 150);
      if (candidates.length === 150) this.stickersDirty = true;
      for (const img of candidates) {
        if (controller.signal.aborted) return;
        const src = img.currentSrc || img.src;
        if (stickerImageState(img) !== 'ready' || this.stickerSources.has(src) || this.failedSources.has(src)) continue;
        try {
          const response = await fetch(src, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          if (blob.size > MAX_STICKER_BYTES || blob.type !== 'image/webp') { this.failedSources.add(src); this.trimSources(); continue; }
          const bytes = await blob.arrayBuffer();
          if (controller.signal.aborted) return;
          const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
          if (controller.signal.aborted) return;
          const image = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            const abort = () => { reader.abort(); reject(new Error('Sticker intake stopped')); };
            const cleanup = () => controller.signal.removeEventListener('abort', abort);
            reader.onload = () => { cleanup(); resolve(String(reader.result)); };
            reader.onerror = () => { cleanup(); reject(reader.error); };
            reader.onabort = () => { cleanup(); reject(new Error('Sticker intake stopped')); };
            controller.signal.addEventListener('abort', abort, { once: true });
            try { reader.readAsDataURL(blob); } catch (error) { cleanup(); reject(error); }
          });
          if (controller.signal.aborted) return;
          this.stickerSources.set(src, id); this.trimSources(); this.emit({ type: 'sticker', image });
        } catch { if (controller.signal.aborted) return; this.failedSources.add(src); this.trimSources(); }
        // Yield between work units so a discovery batch cannot monopolize input.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally { this.indexing = false; if (!this.stopped && this.stickersDirty) this.scheduleRefresh(); }
  }
}
