import { StickerTransferConnector } from './sticker-transfer';
import { StickerPickerLayout } from './sticker-picker-layout';
import { Navigation } from './navigation';
import { MAX_STICKER_BYTES } from '../shared/sticker-limits';
import type { Snapshot, Message } from '../shared/model';
import { snapshotKey, suggestionKey } from '../core/suggestions';
import type { RemoteCommand, RemoteEvent } from '../shared/connector';

export function peerFromMessageId(id: string): string | null {
  return /^(?:true|false)_([\d-]+@(?:c\.us|s\.whatsapp\.net|g\.us|lid))_/.exec(id)?.[1] ?? null;
}
// Quotes are context belonging to another message, never authorship/direction of this one.
const quoteSelector = '[data-testid="quoted-message"], [data-testid="quoted-message-container"], [data-testid="quoted-msg"], [data-testid="reply-context"]';
const textSelector = '.selectable-text.copyable-text, [data-testid="msg-text"], [data-testid="selectable-text"]';
function ownElements(node: HTMLElement, selector: string) {
  return [...node.querySelectorAll<HTMLElement>(selector)].filter(el => {
    const quote = el.closest(quoteSelector);
    return !quote || quote === node;
  });
}
function senderLabel(node: HTMLElement): string | undefined {
  const author = ownElements(node, '[data-testid="author"]')[0];
  const label = author ? readDraft(author) : ownElements(node, '[data-pre-plain-text]').map(el => /^\[[^\]]+\]\s*(.+):\s*$/.exec(el.getAttribute('data-pre-plain-text') ?? '')?.[1]).find(Boolean);
  return label?.trim().slice(0, 150) || undefined;
}
function messageDirection(node: HTMLElement): boolean | null {
  if (peerFromMessageId(node.dataset.id ?? '')) return node.dataset.id!.startsWith('true_');
  if (node.matches('.message-out') || ownElements(node, '[data-icon="tail-out"], [data-testid="tail-out"], .message-out').length) return true;
  if (node.matches('.message-in') || ownElements(node, '[data-icon="tail-in"], [data-testid="tail-in"], .message-in').length) return false;
  const labels = ownElements(node, '[aria-label]').map(el => el.getAttribute('aria-label')?.trim() ?? '');
  if (labels.some(label => /^(You|Tú|Você):$/.test(label))) return true;
  // The visible group-author header identifies another participant, including media without tails.
  if (ownElements(node, '[data-testid="author"]').length) return false;
  // Copy metadata names alone do not establish whether a sender is the account owner.
  return null;
}
function messageAttachment(node: HTMLElement): Message['attachment'] {
  // Observe media type only. Never fetch URLs, upload bytes or mistake avatars/emoji for photos.
  if (ownElements(node, '[data-testid="sticker-container"]').length) return 'sticker';
  if (ownElements(node, '[data-testid="ptt-status"], [data-icon="ptt-status"], audio').length) return 'audio';
  if (ownElements(node, 'video, [data-testid="video-thumb"], [data-testid="video-content"]').length) return 'video';
  if (ownElements(node, '[data-testid="image-thumb"]').length) return 'image';
  return undefined;
}
function messageText(node: HTMLElement) {
  return ownElements(node, textSelector).filter(n => !n.parentElement?.closest(textSelector)).map(n => readDraft(n)).join('\n').slice(0, 4000);
}
function quotedMessage(node: HTMLElement): Message['quoted'] {
  const quote = node.querySelector<HTMLElement>(quoteSelector);
  if (!quote) return undefined;
  const sender = senderLabel(quote), attachment = messageAttachment(quote);
  return { text: messageText(quote), ...(sender ? { sender } : {}), ...(attachment ? { attachment } : {}) };
}
export function readDraft(editor: HTMLElement): string {
  const serialize = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (!(node instanceof Element)) return '';
    const tag = node.tagName.toUpperCase();
    if (tag === 'BR') return '\n';
    if (tag === 'IMG') return node.getAttribute('data-plain-text') || node.getAttribute('alt') || '\ufffc';
    if (['SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT'].includes(tag)) return '\ufffc';
    let text = '';
    for (const child of node.childNodes) {
      const block = child instanceof Element && ['DIV', 'P', 'LI'].includes(child.tagName);
      if (block && text && !text.endsWith('\n')) text += '\n';
      text += serialize(child);
      if (block && child.nextSibling && !text.endsWith('\n')) text += '\n';
    }
    return text || (node.getAttribute('contenteditable') === 'false' ? '\ufffc' : '');
  };
  return serialize(editor).replace(/\u200b/g, '').replace(/\n$/, '');
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
  private root: Element | null = null;
  private editorRoot: Element | null = null;
  private selectedChat: Element | null = null;
  private observedMessages = new Map<string, Message>();
  private stableSince = 0;
  private lastKey = '';
  private lastContentKey = '';
  private popupMode: 'refine' | 'preview' | 'notice' = 'notice';
  private suggestion?: Extract<RemoteCommand, { type: 'suggestion' }>;
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
  constructor(private doc: Document, private emit: (event: RemoteEvent) => void, private authorizeAutomatic: (nonce: string) => Promise<boolean> = async () => false, private authorizeSticker: (nonce: string) => Promise<boolean> = async () => false) {}
  editor() { return this.doc.querySelector<HTMLElement>('#main footer [contenteditable="true"][role="textbox"], #main [data-testid="conversation-compose-box-input"][contenteditable="true"]'); }
  read(): Snapshot {
    const main = this.doc.querySelector('#main');
    const editor = this.editor();
    if (this.composingEditor !== editor) this.composingEditor = null;
    const draft = editor ? readDraft(editor) : '';
    const title = main?.querySelector('header [data-testid="conversation-info-header-chat-title"]');
    const name = (title?.textContent ?? main?.querySelector('header [title]')?.getAttribute('title') ?? main?.querySelector('header')?.textContent ?? '').trim().slice(0, 150);
    const selected = this.doc.querySelector('#pane-side [aria-selected="true"]');
    const nodes = [...(main?.querySelectorAll<HTMLElement>('[data-id]') ?? [])].filter(n => !n.closest(quoteSelector) && (peerFromMessageId(n.dataset.id ?? '') || (/^[A-Za-z0-9_-]{6,150}$/.test(n.dataset.id ?? '') && n.dataset.testid === `conv-msg-${n.dataset.id}`)));
    const peers = [...new Set(nodes.map(n => peerFromMessageId(n.dataset.id!)).filter((id): id is string => id !== null))];
    const chatId = peers.length === 1 ? peers[0] : null;
    const identity = `${name}|${chatId}`;
    if (main !== this.root || identity !== this.identity || editor !== this.editorRoot || selected !== this.selectedChat) {
      this.revision++; this.stableSince = Date.now(); this.identity = identity; this.root = main; this.editorRoot = editor; this.selectedChat = selected;
      this.observedMessages.clear();
    }
    const messages: Message[] = nodes.slice(-30).map(node => {
      const attachment = messageAttachment(node), sender = senderLabel(node), quoted = quotedMessage(node);
      const message: Message = { id: node.dataset.id!.slice(0, 250),
        text: messageText(node),
        outgoing: messageDirection(node), ...(sender ? { sender } : {}), ...(attachment ? { attachment } : {}), ...(quoted ? { quoted } : {}) };
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
    return { chatId, name, kind: chatId ? chatId.endsWith('@g.us') ? 'group' : 'direct' : nodes.some(n => ownElements(n, '[data-testid="author"]').length) ? 'group' : 'unknown', messages,
      draft: draft.slice(0, 8000), draftIssue: draft.length > 8000 ? 'too-long' : draft.includes('\ufffc') || editor?.querySelector('[contenteditable="false"]:not(img)') ? 'unsupported' : null,
      composing: this.composing, focused: Boolean(editor && this.doc.hasFocus() && this.doc.activeElement === editor), caretAtEnd: Boolean(editor && caretAtEnd(editor)),
      ready: Boolean(editor && editor.getBoundingClientRect().height && peers.length <= 1 && (chatId || (title && selected && nodes.length)) && name && Date.now() - this.stableSince >= 500),
      atBottom, revision: String(this.revision), activity: this.activityGeneration, editRevision: this.editRevision };
  }
  start() {
    this.stickerPickerLayout = new StickerPickerLayout(this.doc);
    this.stickerTransfer = new StickerTransferConnector(this.doc, () => this.read(), this.stickerSources, this.emit, this.authorizeSticker);
    this.navigation = new Navigation(this.doc, this.navigationEvent);
    this.host = this.doc.createElement('div'); this.host.id = 'companion-overlay';
    this.host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646';
    const shadow = this.host.attachShadow({ mode: 'closed' });
    const style = this.doc.createElement('style');
    style.textContent = `*{box-sizing:border-box}button,input{font:13px system-ui}button{cursor:pointer;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--ink);padding:7px 10px}button:hover{background:var(--hover)}button:focus-visible,input:focus-visible{outline:2px solid #168468;outline-offset:2px}.ghost{position:fixed;color:#79938b;opacity:.8;overflow:hidden;pointer-events:none;white-space:pre-wrap;overflow-wrap:anywhere}.popup{position:fixed;width:310px;padding:12px;background:var(--background);color:var(--ink);box-shadow:0 6px 30px #0002;border:1px solid var(--line);border-radius:14px;pointer-events:auto;font:13px system-ui}.row{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}input{width:100%;padding:9px;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:8px;margin-bottom:8px}.trigger{position:fixed;pointer-events:auto;padding:4px 9px;color:#21c063}.notice{font:12px system-ui;line-height:1.5}`;
    this.ghost = this.doc.createElement('div'); this.ghost.className = 'ghost'; this.ghost.setAttribute('aria-hidden', 'true');
    this.popup = this.doc.createElement('div'); this.popup.className = 'popup'; this.popup.hidden = true;
    this.popup.setAttribute('role', 'dialog'); this.popup.setAttribute('aria-label', 'Refine reply');
    this.button = this.doc.createElement('button'); this.button.className = 'trigger'; this.button.textContent = '✦'; this.button.title = 'Suggest or refine reply'; this.button.setAttribute('aria-label', 'Suggest or refine reply');
    this.button.addEventListener('click', event => { if (event.isTrusted) this.openPopup(); });
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
    this.activityGeneration++;
    if (editing) { this.editRevision++; this.clear(); if (this.popupMode === 'preview') this.popup.hidden = true; }
    this.emit({ type: 'activity', editing });
  }
  private activity = (event: Event) => { if (event.isTrusted && !this.inserting) this.takeover(); };
  private beforeInput = (event: Event) => {
    if (event.isTrusted && !this.inserting) this.takeover(event.target instanceof Node && Boolean(this.editor()?.contains(event.target)));
  };
  private pointer = (event: Event) => {
    if (!event.isTrusted) return;
    if (!event.composedPath().includes(this.host) && !this.navigation?.contains(event) && this.popupMode !== 'preview') this.popup.hidden = true;
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
      event.preventDefault(); event.stopImmediatePropagation(); this.takeover(); this.clear(); this.popup.hidden = true; this.emit({ type: 'dismiss' }); editor?.focus(); return;
    }
    if (event.target !== editor && !editor?.contains(event.target as Node)) {
      if (!['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) this.takeover();
      return;
    }
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && this.suggestion && editor && caretAtEnd(editor)) {
      if (suggestionKey(this.read()) !== this.suggestion.key) { this.clear(); return; }
      event.preventDefault(); event.stopImmediatePropagation();
      const suggestion = this.suggestion; this.takeover(true); this.insert(suggestion.text, suggestion.replace); return;
    }
    if (!['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) this.takeover(event.key === 'Enter');
  };
  private insert(text: string, replace: boolean) {
    const editor = this.editor(); if (!editor) return false;
    editor.focus();
    const selection = this.doc.getSelection(); const range = this.doc.createRange();
    range.selectNodeContents(editor); if (!replace) range.collapse(false);
    selection?.removeAllRanges(); selection?.addRange(range);
    this.inserting = true;
    try { return this.doc.execCommand('insertText', false, text); } finally { this.inserting = false; }
  }
  private clear() {
    this.suggestion = undefined; this.ghost.textContent = '';
    if (this.hiddenPlaceholder) {
      const { element, visibility, priority } = this.hiddenPlaceholder;
      if (visibility) element.style.setProperty('visibility', visibility, priority); else element.style.removeProperty('visibility');
      this.hiddenPlaceholder = undefined;
    }
  }
  private refresh() {
    this.stickerPickerLayout?.refresh();
    const snapshot = this.read(), key = snapshotKey(snapshot);
    this.navigation?.refresh(snapshot.ready);
    const dark = this.navigation?.theme !== 'light';
    for (const [key, value] of Object.entries(dark ? { background: '#161717', surface: '#242626', ink: '#e9edef', line: '#373b3c', hover: '#2a3942' } : { background: '#fff', surface: '#f0f2f5', ink: '#111b21', line: '#d9e3df', hover: '#e9edef' })) this.host.style.setProperty(`--${key}`, value);
    const contentKey = suggestionKey(snapshot);
    if (key !== this.lastKey && !(this.dispatch && this.dispatchMatches(this.dispatch, snapshot))) {
      this.lastKey = key;
      if (this.suggestion && this.suggestion.key !== contentKey) this.clear();
      if (contentKey !== this.lastContentKey) this.popup.hidden = true;
      this.lastContentKey = contentKey;
      this.emit({ type: 'snapshot', snapshot });
    }
    const editor = this.editor(), rect = editor?.getBoundingClientRect();
    this.button.hidden = !snapshot.ready;
    if (rect && editor) {
      this.button.style.left = `${Math.max(12, rect.right - 30)}px`; this.button.style.top = `${rect.top - 29}px`;
      this.popup.style.left = `${Math.max(8, rect.right - 310)}px`; this.popup.style.bottom = `${this.doc.documentElement.clientHeight - rect.top + 12}px`;
      const css = getComputedStyle(editor);
      Object.assign(this.ghost.style, { left: `${rect.left + editor.clientLeft}px`, top: `${rect.top + editor.clientTop}px`, width: `${editor.clientWidth}px`, height: `${editor.clientHeight}px`, fontFamily: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight, fontStyle: css.fontStyle, letterSpacing: css.letterSpacing, lineHeight: css.lineHeight, padding: css.padding, direction: css.direction, textAlign: css.textAlign });
      this.syncGhostScroll();
    }
  }
  private openPopup() {
    if (this.suggestion?.replace) this.clear();
    this.takeover(); this.popupMode = 'refine'; this.popup.replaceChildren(); this.popup.hidden = false;
    const row = this.doc.createElement('div'); row.className = 'row';
    const request = (instruction?: string) => {
      this.dismissedKey = undefined;
      this.popup.hidden = true;
      const editor = this.editor();
      if (editor) { editor.focus(); const range = this.doc.createRange(); range.selectNodeContents(editor); range.collapse(false); const selection = this.doc.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
      this.refresh(); this.emit({ type: 'request', instruction });
    };
    for (const label of ['Suggest', 'Shorter', 'Warmer', 'More direct', 'Translate']) {
      const b = this.doc.createElement('button'); b.textContent = label;
      b.addEventListener('click', e => {
        if (!e.isTrusted) return;
        if (label === 'Translate') { instruction.value = 'Translate to '; instruction.focus(); }
        else request(label === 'Suggest' ? undefined : `Make the draft ${label.toLowerCase()}.`);
      }); row.append(b);
    }
    const instruction = this.doc.createElement('input'); instruction.placeholder = 'Translate to Spanish, or another instruction…'; instruction.setAttribute('aria-label', 'Refinement instruction'); instruction.maxLength = 1000;
    const apply = this.doc.createElement('button'); apply.textContent = 'Refine draft';
    apply.addEventListener('click', e => { if (e.isTrusted && instruction.value.trim()) request(instruction.value.trim()); });
    instruction.addEventListener('keydown', e => { if (e.isTrusted && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (instruction.value.trim()) request(instruction.value.trim()); } });
    this.popup.append(row, instruction, apply); instruction.focus();
  }
  command(command: RemoteCommand) {
    if (command.type === 'armStickerDrag') { this.stickerTransfer?.arm(command); return; }
    if (command.type === 'prepareSticker') { void this.stickerTransfer?.prepare(command); return; }
    if (command.type === 'sendSticker') { void this.stickerTransfer?.send(command, command.expiresAt); return; }
    if (command.type === 'cancelSticker') { this.stickerTransfer?.cancel(); return; }
    if (command.type === 'chrome') { this.navigation?.update(command.panel, command.pending); this.stickerPickerLayout?.update(command.panelBounds ?? null, command.panel === 'chat' ? 'right' : 'left'); return; }
    if (command.type === 'clear') { this.dispatch = undefined; this.clear(); if (this.popupMode === 'preview') this.popup.hidden = true; return; }
    if (command.type === 'notice') { if (this.suggestion?.replace) this.clear(); this.popupMode = 'notice'; this.popup.textContent = command.text; this.popup.classList.add('notice'); this.popup.hidden = false; return; }
    if (command.type === 'suggestion') {
      const editor = this.editor(), s = this.read();
      if (command.key !== suggestionKey(s) || command.key === this.dismissedKey || !s.ready || s.draftIssue || !editor || this.composing) return;
      this.clear(); this.suggestion = command; this.ghost.replaceChildren();
      if (!s.draft && !command.replace) {
        const label = editor.getAttribute('aria-placeholder');
        const placeholder = [...(editor.parentElement?.children ?? [])].find(el => el !== editor && el instanceof HTMLElement && el.getAttribute('aria-hidden') === 'true' && label && el.textContent?.trim() === label) as HTMLElement | undefined;
        if (placeholder) {
          this.hiddenPlaceholder = { element: placeholder, visibility: placeholder.style.getPropertyValue('visibility'), priority: placeholder.style.getPropertyPriority('visibility') };
          placeholder.style.setProperty('visibility', 'hidden', 'important');
        }
      }
      if (!command.replace) { const prefix = this.doc.createElement('span'); prefix.textContent = s.draft; prefix.style.visibility = 'hidden'; this.ghost.append(prefix); }
      else { this.popupMode = 'preview'; this.popup.textContent = `${command.text}\n\nTab to replace · Esc to dismiss`; this.popup.style.whiteSpace = 'pre-wrap'; this.popup.hidden = false; return; }
      const suffix = this.doc.createElement('span'); suffix.textContent = command.text; this.ghost.append(suffix); this.syncGhostScroll(); return;
    }
    if (command.type === 'autoSend') {
      void this.sendAutomatic(command); return;
    }
    if (command.type === 'locateSticker') {
      const image = [...this.doc.images].find(img => this.stickerSources.get(img.currentSrc || img.src) === command.id && img.checkVisibility({ visibilityProperty: true }) && img.getBoundingClientRect().width > 0);
      if (image) { image.scrollIntoView({ block: 'center' }); image.animate([{ outline: '4px solid #24ae85' }, { outline: '4px solid transparent' }], { duration: 1800 }); }
      this.emit({ type: 'stickerLocated', nonce: command.nonce, found: Boolean(image) });
    }
  }
  private syncGhostScroll() {
    const editor = this.editor();
    if (!editor || !this.suggestion || this.suggestion.replace) return;
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
          return img.complete && img.naturalWidth && (src.startsWith('blob:') || src.startsWith('data:image/webp;')) && !this.stickerSources.has(src) && !this.failedSources.has(src);
        }).slice(0, 150);
      for (const img of candidates) {
        const src = img.currentSrc || img.src;
        if (!img.complete || !img.naturalWidth || this.stickerSources.has(src) || this.failedSources.has(src)) continue;
        if (!src.startsWith('blob:') && !src.startsWith('data:image/webp;')) continue;
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
