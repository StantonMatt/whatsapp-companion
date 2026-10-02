import type { RemoteEvent } from '../shared/connector';
import type { Snapshot } from '../shared/model';
import { MAX_STICKER_BYTES, MAX_STICKER_DATA_URL_LENGTH } from '../shared/sticker-limits';
import { STICKER_PICKER_LOOKUP_MS, STICKER_MAKER_PREPARATION_MS, STICKER_MAKER_CONFIRMATION_MS, sameStickerChat, sameStickerPreparation, type StickerAuthorization, type StickerTicket, type StickerMakerDetail, type StickerLookupDiagnostics } from '../shared/sticker-transfer';
import { messageDirection, ownElements, quoteSelector } from './message-direction';
import { stickerImageState } from './sticker-image-state';
import { composerProvablyEmpty } from './draft';

const pickerSelector = '[data-testid="expressions-panel"]';
const triggerSelector = '#main footer [aria-label="Emojis, GIFs, Stickers"], #main footer [aria-label="Emojis, GIF y stickers"]';
const visible = (e: HTMLElement) => e.checkVisibility({ visibilityProperty: true }) && e.getBoundingClientRect().width > 0;
const makerLabels = {
  attach: /^\s*(?:attach|adjuntar|anexar)\s*$/i,
  sticker: /^\s*(?:new sticker|nuevo sticker|nueva pegatina|nova figurinha)\s*$/i,
  send: /^(?:send|enviar)\b/i,
  close: /^\s*(?:close|cancel|cerrar|cancelar|fechar)\s*$/i,
  cancel: /^\s*(?:cancel|cancelar)\s*$/i,
  discard: /^\s*(?:discard|descartar)\s*$/i
};
const stickerItemIcon = '[data-icon="sticker"], [data-icon="ic-sticker"], [data-icon="sticker-create"]';
type MakerLayer = { layer: HTMLElement; close: HTMLElement; sends: HTMLElement[]; loading: boolean };
type MakerOwnership = {
  ticket: StickerTicket; main: Element; selected: Element | null; title: Element | null; messageIds: Set<string>; composer: Element | null;
  baseline: Set<Element>; sourceBaseline: Set<string>; image: string; deadline: number;
  // opening -> waiting (file assigned) -> owned (native route/file proved); invalid is
  // irreversible and permits only cleanup of the recorded instance -> finished.
  state: 'opening' | 'waiting' | 'owned' | 'invalid' | 'finished'; invalidReason?: 'cancelled' | 'chat-changed';
  assigned: boolean; file?: File; editor?: MakerLayer & { source: string; nativeMarker?: Element; evidenceLost?: boolean }; attach: HTMLElement; menu?: HTMLElement; discoverMenu?: () => HTMLElement | undefined;
  observer?: MutationObserver; proofs: Map<string, boolean | Promise<void>>; proofController: AbortController;
  draftBlocked?: boolean; cleanup?: { editor: HTMLElement; promise: Promise<boolean> };
};
type Match = { image: HTMLImageElement; button: HTMLElement; source: string };
type CategoryEndState = { scroll?: HTMLElement; content?: HTMLElement; height: number; viewportHeight: number; position: number; images: { image: HTMLImageElement; source: string }[] };
type CategoryProgress = {
  position: number; incomplete: boolean; sawMountedRow: boolean; activatedAt: number; stableSince: number;
  pendingSince?: number; endState?: CategoryEndState; movement?: { scroll: HTMLElement; from: number };
};
type MessageBaseline = { ids: Set<string>; rows: HTMLElement[]; frontier: Set<string>; frontierRow?: HTMLElement; rejected: Set<string>; rejectedRows: WeakSet<HTMLElement> };
const messageSelector = '[data-id], [data-testid^="conv-msg-"], [data-testid="grouped-sticker-item"]';
const categoryBudget = 2000, settleWindow = 800, pendingRowWait = 1500;
// A cold empty category gets an initial mount window before its quiet window.
// Explicit loading and pending images stay queued through the lookup cap.
const initialMountGrace = 600, populatedSettleWindow = 1500, maxScrollSteps = 40;
const diagnosticElapsed = (startedAt: number, maximum = 120_000) => Math.min(maximum, Math.max(0, Date.now() - startedAt));

// DOM-only adapter using native picker/maker controls. No private stores,
// WhatsApp internal modules, direct upload API or connector re-encoding.
export class StickerTransferConnector {
  private verified = new Map<string, string>();
  private prepared?: StickerTicket & Match & { messageIds: Set<string>; diagnostics: StickerLookupDiagnostics; startedAt: number };
  private pickerOpenedInSession = false;
  private controller?: AbortController;
  private sendGeneration = 0;
  private sendingGeneration?: number;
  private openedPicker?: { panel: HTMLElement; trigger: HTMLElement };
  private openingPicker?: Promise<void>;
  private openingDeadline = 0;
  private stopped = false;
  constructor(private doc: Document, private read: () => Snapshot, private hashes: Map<string, string>, private emit: (event: RemoteEvent) => void, private authorize: (nonce: string) => Promise<boolean> = async () => false, private authorizeMaker: (request: StickerAuthorization) => Promise<boolean> = async () => false) {}
  cancel() {
    const owned = this.maker;
    // Drain synchronous mounts BEFORE revoking the token. A mount after this
    // point can never become ours, even if the native load was initiated by us.
    if (owned) { this.observeMaker(owned); this.invalidateMaker(owned, 'cancelled'); }
    this.sendGeneration++; this.controller?.abort(); this.controller = undefined;
    this.prepared = undefined; this.closeOpenedPicker(); void this.closeMaker(owned);
  }
  stop() { this.stopped = true; this.cancel(); }
  private maker?: MakerOwnership;
  private destinationMatches(owned: MakerOwnership, snapshot: Snapshot) {
    if (!snapshot.conversationOpen || owned.main !== this.doc.querySelector('#main') || owned.selected !== this.doc.querySelector('#pane-side [aria-selected="true"]') || snapshot.chatId !== owned.ticket.target.chatId || snapshot.name !== owned.ticket.target.name) return false;
    const composer = this.doc.querySelector('#main footer [contenteditable="true"], #main [data-testid="conversation-compose-box-input"]');
    if (composer && composer !== owned.composer) return false;
    // Opaque destinations also require continuous overlap in loaded history.
    return Boolean(snapshot.chatId) || (snapshot.messages.some(m => owned.messageIds.has(m.id)) && !snapshot.messages.some(m => /^(?:true|false)_[\d-]+@(?:c\.us|s\.whatsapp\.net|g\.us|lid)_/.test(m.id)));
  }
  private invalidateMaker(owned: MakerOwnership, reason?: 'cancelled' | 'chat-changed') {
    if (owned.state === 'invalid' || owned.state === 'finished') return;
    owned.state = 'invalid'; owned.invalidReason = reason;
    owned.observer?.disconnect(); owned.proofController.abort();
    if (this.maker === owned) this.controller?.abort();
  }
  preparation(snapshot: Snapshot): string | undefined {
    const owned = this.maker;
    if (!owned || owned.state === 'finished') return;
    if (!this.makerContinuity(owned, owned.observer?.takeRecords() ?? []) || !this.destinationMatches(owned, snapshot)) {
      this.invalidateMaker(owned, 'chat-changed'); return;
    }
    // The token cannot acquire editors after revocation. The cleanup marker
    // may still hold main's input block for an ALREADY proved, connected editor.
    if (owned.state === 'invalid' && !owned.editor?.layer.isConnected) return;
    return owned.assigned ? owned.ticket.nonce : undefined;
  }
  private makerContinuity(owned: MakerOwnership, records: MutationRecord[]) {
    const anchors = [owned.main, owned.selected, owned.title].filter((e): e is Element => Boolean(e));
    return !records.some(record =>
      (record.type === 'childList' && [...record.removedNodes].some(node => anchors.some(anchor => node === anchor || node.contains(anchor)))) ||
      (record.type === 'attributes' && record.target === owned.selected && record.attributeName === 'aria-selected') ||
      (owned.title?.contains(record.target) && (record.type !== 'attributes' || record.attributeName === 'title')));
  }
  private makerSources(layer: ParentNode) {
    return [...new Set([...layer.querySelectorAll<HTMLImageElement>('img')].map(img => img.currentSrc || img.src).filter(src => src.startsWith('blob:') || src.startsWith('data:image/')))];
  }
  private observeMaker(owned: MakerOwnership, records = owned.observer?.takeRecords() ?? []) {
    if (owned.state === 'invalid' || owned.state === 'finished') return;
    // A root/selection that leaves and comes back in one event turn still
    // breaks continuity. Do not rely only on the final DOM/snapshot.
    if (!this.makerContinuity(owned, records)) { this.invalidateMaker(owned, 'chat-changed'); return; }
    const snapshot = this.read();
    if (owned.proofController.signal.aborted) return;
    if (!this.destinationMatches(owned, snapshot)) { this.invalidateMaker(owned, 'chat-changed'); return; }
    owned.menu ??= owned.discoverMenu?.();
    if (!owned.assigned || Date.now() >= owned.deadline || !owned.file) return;
    const editor = this.makerLayer(owned.baseline, true);
    if (!editor) return;
    const sources = this.makerSources(editor.layer).filter(src => !owned.sourceBaseline.has(src));
    if (owned.editor?.layer.isConnected) {
      // Once acquired, this instance keeps its evidence. In particular, a byte
      // proof must not overwrite a native editor's established thumbnail source.
      this.editorEvidence(owned.editor);
      return;
    }
    // A native sticker editor mounted after our authorized assignment, while
    // this token and conversation remain continuous, is also route evidence.
    // WhatsApp can draw/re-encode the file before its original bytes are visible.
    // A canvas alone or an unrelated media draft with a caption is insufficient.
    const nativeMarker = editor.layer.querySelector('[data-testid="crop-rotate-button"]');
    const caption = editor.layer.querySelector('[contenteditable="true"], textarea, input:not([type="file"]):not([type="range"]):not([type="color"])');
    if (nativeMarker && !caption && sources.length <= 1 && (!owned.editor || owned.editor.layer !== editor.layer)) {
      owned.editor = { ...editor, source: sources[0] ?? '', nativeMarker }; owned.state = 'owned'; return;
    }
    // Other editor layouts require the exact assigned image or a blob whose
    // bytes hash to the assigned file before they can authorize any actions.
    const source = sources.find(src => src === owned.image || owned.proofs.get(src) === true);
    if (source) { owned.editor = { ...editor, source }; owned.state = 'owned'; return; }
    for (const source of sources) {
      if (!source.startsWith('blob:') || owned.proofs.has(source)) continue;
      const proof = (async () => {
        let matches = false;
        try {
          const response = await fetch(source, { signal: AbortSignal.any([owned.proofController.signal, AbortSignal.timeout(Math.max(1, owned.deadline - Date.now()))]) });
          const blob = await response.blob();
          if (blob.size <= MAX_STICKER_BYTES) {
            const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
            matches = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('') === owned.ticket.id;
          }
        } catch { /* An unproved/rewritten thumbnail cannot authorize cleanup. */ }
        owned.proofs.set(source, matches);
        // Recheck the token AND the current instance after asynchronous proof.
        // Cancellation can finish cleanup with no editor while this is pending.
        if (matches) this.observeMaker(owned);
      })();
      owned.proofs.set(source, proof);
    }
  }
  private controls(root: ParentNode, word: RegExp, icon?: string, ariaOnly = false) {
    return [...root.querySelectorAll<HTMLElement>('button, [role="button"]')].filter(e => visible(e) && !e.hasAttribute('disabled') && e.getAttribute('aria-disabled') !== 'true' &&
      ((icon && [...e.querySelectorAll(icon)].some(i => i.closest('button, [role="button"]') === e)) || word.test((e.getAttribute('aria-label') ?? (ariaOnly ? '' : e.textContent) ?? '').trim())));
  }
  private makerLayer(baseline: Set<Element>, cleanup = false) {
    // The marker can have zero width while WhatsApp draws the image. The
    // surrounding native controls establish the layer; pixel geometry is not
    // editor readiness. Cleanup also works while the marker itself is hidden.
    const canvases = [...this.doc.querySelectorAll<HTMLElement>('[data-testid="media-editor-canvas"]')].filter(e => !baseline.has(e) && (cleanup || e.checkVisibility({ visibilityProperty: true })));
    if (canvases.length !== 1) return;
    let fallback: MakerLayer | undefined;
    for (let layer = canvases[0].parentElement; layer && layer !== this.doc.body && layer.id !== 'main'; layer = layer.parentElement) {
      // Stop before a conversation/app wrapper could contribute its composer
      // Send. The real editor has no dialog role: its toolbar/canvas and bottom
      // Send row are siblings beneath a plain div.
      if (layer.querySelector('#main, #pane-side, footer, [data-id]')) break;
      if (!visible(layer)) continue;
      // The toolbar's x-viewer/x identify Close; the thumbnail's x-alt is
      // deliberately excluded. Labels cover native controls without an icon.
      const closes = this.controls(layer, makerLabels.close, '[data-icon="x-viewer"], [data-icon="x"]', true);
      if (closes.length !== 1) continue;
      const sends = this.controls(layer, makerLabels.send, '[data-icon="send"], [data-testid="send"], [data-icon="wds-ic-send-filled"], [data-testid="wds-ic-send-filled"]', true).filter(e => e.getAttribute('role') === 'button');
      const editor = { layer, close: closes[0], sends, loading: [...layer.querySelectorAll<HTMLElement>('[data-testid="loading-spinner"]')].some(visible) };
      // Do not stop at the toolbar/canvas ancestor before reaching Send's
      // sibling branch. Still retain ownership of an editor with no Send so
      // failure/cancellation can dismiss it safely.
      fallback = editor;
      if (sends.length) return editor;
    }
    return fallback;
  }
  private composerEmpty() {
    const composers = this.doc.querySelectorAll<HTMLElement>('#main footer [contenteditable="true"], #main [data-testid="conversation-compose-box-input"]');
    try { return composers.length === 1 && composerProvablyEmpty(composers[0], this.read().composing); }
    catch { return false; }
  }
  private editorEvidence(editor: NonNullable<MakerOwnership['editor']>) {
    if (editor.evidenceLost) return false;
    const sources = this.makerSources(editor.layer);
    if (editor.nativeMarker) {
      if (!editor.layer.contains(editor.nativeMarker) || editor.layer.querySelector('[contenteditable="true"], textarea, input:not([type="file"]):not([type="range"]):not([type="color"])')) { editor.evidenceLost = true; return false; }
      // Ownership already proved this native shell under the live token. Its
      // first thumbnail may arrive later and may be re-encoded by WhatsApp.
      // Only that first source can fill the empty slot; replacements cannot.
      if (!editor.source && sources.length === 1) editor.source = sources[0];
      // The captured instance cannot transfer its ownership to a replaced file.
      const valid = editor.source ? sources.length === 1 && sources[0] === editor.source : sources.length === 0;
      if (!valid) editor.evidenceLost = true;
      return valid;
    }
    const valid = sources.length === 1 && sources[0] === editor.source;
    if (!valid) editor.evidenceLost = true;
    return valid;
  }
  private makerAction(owned: NonNullable<typeof this.maker>, action: () => void) {
    if (owned.draftBlocked || !this.composerEmpty()) { owned.draftBlocked = true; return false; }
    action();
    return true;
  }
  private async closeMaker(owned = this.maker): Promise<boolean> {
    if (!owned) return true;
    if (owned.draftBlocked) return false;
    if (owned.menu?.isConnected && owned.attach.isConnected && visible(owned.attach)) {
      // Toggle only the very menu/trigger we opened, never Escape or a new menu.
      if (!this.makerAction(owned, () => owned.attach.click())) return false;
      if (owned.menu.isConnected && visible(owned.menu)) return false;
    }
    const editor = owned.editor;
    // Never cache a successful "no editor" result or rediscover an unowned layer.
    if (!editor) return true;
    if (owned.cleanup?.editor === editor.layer) return owned.cleanup.promise;
    const promise = (async () => {
      if (!editor.layer.isConnected) return true;
      if (!this.editorEvidence(editor)) return false;
      // Refresh controls only INSIDE the positively identified instance.
      const closes = this.controls(editor.layer, makerLabels.close, '[data-icon="x-viewer"], [data-icon="x"]', true);
      if (closes.length !== 1) return false;
      const dialogs = '[role="dialog"], [role="alertdialog"]';
      const baseline = new Map([...this.doc.querySelectorAll<HTMLElement>(dialogs)].map(e => [e, visible(e)]));
      const deadline = Date.now() + 1000;
      if (!this.makerAction(owned, () => closes[0].click())) return false;
      let discarded = false;
      while (true) {
        // If the instance disappeared, a later editor/dialog is not ours.
        if (!editor.layer.isConnected) return true;
        const candidates = [...new Set([...this.doc.querySelectorAll<HTMLElement>(dialogs)].filter(e => visible(e) && !baseline.get(e)).flatMap(dialog => {
          const cancels = this.controls(dialog, makerLabels.cancel);
          const discards = this.controls(dialog, makerLabels.discard).filter(e => !cancels.includes(e));
          return discards.length === 1 && cancels.length === 1 ? [discards[0]] : [];
        }))];
        if (!discarded && candidates.length === 1) {
          if (!this.editorEvidence(editor)) return false;
          if (!this.makerAction(owned, () => candidates[0].click())) return false;
          discarded = true;
        }
        if (!editor.layer.isConnected) return true;
        if (Date.now() >= deadline) return false;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    })().catch(() => false);
    owned.cleanup = { editor: editor.layer, promise };
    return promise;
  }
  private async makerPermission(request: StickerAuthorization, signal: AbortSignal, deadline: number) {
    if (signal.aborted || Date.now() >= deadline) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    const revoked = new Promise<boolean>(resolve => {
      cancel = () => resolve(false);
      timer = setTimeout(cancel, Math.max(1, deadline - Date.now()));
      signal.addEventListener('abort', cancel, { once: true });
    });
    try { return await Promise.race([this.authorizeMaker(request).catch(() => false), revoked]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
  }
  private makerActive = false;
  async make(ticket: StickerTicket, image: string) {
    const startedAt = Date.now();
    const result = (event: Extract<RemoteEvent, { type: 'stickerSent' }>) => this.emit({ ...event, diagnostics: { totalMs: diagnosticElapsed(startedAt), categories: [] } });
    if (this.makerActive) { result({ type: 'stickerSent', nonce: ticket.nonce, clicked: false, confirmed: false, reason: 'editor-unavailable', detail: 'maker-busy' }); return; }
    const initial = this.read(), initialMessageIds = this.messageIdentities();
    if (!this.composerEmpty()) {
      result({ type: 'stickerSent', nonce: ticket.nonce, clicked: false, confirmed: false, reason: 'draft', detail: 'draft-present' }); return;
    }
    this.makerActive = true;
    this.cancel();
    const controller = this.controller = new AbortController(), signal = controller.signal;
    const generation = this.sendGeneration, baseline = new Set(this.doc.querySelectorAll('[data-testid="media-editor-canvas"]'));
    const main = this.doc.querySelector('#main');
    let clicked = false, confirmed = false;
    let detail: StickerMakerDetail = 'maker-error';
    const fail = (code: StickerMakerDetail): never => { detail = code; throw new Error(code); };
    let ownership: typeof this.maker;
    const deadline = Date.now() + STICKER_MAKER_PREPARATION_MS;
    const valid = () => {
      if (ownership) this.observeMaker(ownership);
      const snapshot = this.read();
      return !signal.aborted && generation === this.sendGeneration && ownership?.state !== 'invalid' && (sameStickerChat(ticket.target, snapshot) || sameStickerPreparation(ticket, snapshot));
    };
    const requireActive = () => { if (!valid()) fail(ownership?.invalidReason ?? (signal.aborted ? 'cancelled' : 'chat-changed')); };
    // Observe the transition, rather than treating every menu on the page as ours.
    const menuBaseline = new Map([...this.doc.querySelectorAll<HTMLElement>('[role="menu"], [role="menuitem"]')].map(e => [e, visible(e)]));
    const routeItems = () => [...this.doc.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(e => visible(e) && !menuBaseline.get(e) && !e.closest('#pane-side, #side, nav'));
    const isStickerItem = (e: HTMLElement) => !e.hasAttribute('disabled') && e.getAttribute('aria-disabled') !== 'true' && (Boolean(e.querySelector(stickerItemIcon)) || makerLabels.sticker.test((e.getAttribute('aria-label') ?? e.textContent ?? '').trim()));
    const routeMenu = () => {
      const items = routeItems();
      const stickers = items.filter(isStickerItem);
      const menus = [...new Set((stickers.length === 1 ? stickers : items).map(item => item.closest<HTMLElement>('[role="menu"]') ?? item.parentElement))];
      const menu = menus.length === 1 ? menus[0] : undefined;
      return menu && menu !== this.doc.body && menu.id !== 'main' && (stickers.length === 1 || items.every(e => menu.contains(e))) ? menu : undefined;
    };
    const pause = (until = deadline) => new Promise<void>(resolve => { const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); }; const timer = setTimeout(finish, Math.max(0, Math.min(100, until - Date.now()))); signal.addEventListener('abort', finish, { once: true }); });
    try {
      if (!main) fail('main-not-found');
      if ([...baseline].some(e => visible(e as HTMLElement))) fail('editor-preopen');
      if (!sameStickerChat(ticket.target, initial)) fail('chat-changed');
      const prefix = 'data:image/webp;base64,';
      if (!image.startsWith(prefix) || image.length > MAX_STICKER_DATA_URL_LENGTH) fail('invalid-image');
      detail = 'invalid-image';
      const bytes = Uint8Array.from(atob(image.slice(prefix.length)), c => c.charCodeAt(0));
      if (bytes.length > MAX_STICKER_BYTES || bytes.length < 12 || String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP') fail('invalid-webp');
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
      if (hash !== ticket.id) fail('hash-mismatch');
      requireActive();
      const footer = main!.querySelector('footer');
      const attaches = footer ? this.controls(footer, makerLabels.attach, '[data-icon="ic-attach-file"], [data-testid="ic-attach-file"]') : [];
      if (!attaches.length) fail('attach-not-found');
      if (attaches.length !== 1) fail('attach-ambiguous');
      const controlledMenu = this.doc.getElementById(attaches[0].getAttribute('aria-controls') ?? '');
      if ((controlledMenu && visible(controlledMenu)) || (footer && [...footer.querySelectorAll<HTMLElement>('[role="menu"], [role="menuitem"]')].some(visible))) fail('menu-preopen');
      const owned: MakerOwnership = this.maker = { ticket, main: main!, selected: this.doc.querySelector('#pane-side [aria-selected="true"]'), title: main!.querySelector('header [data-testid="conversation-info-header-chat-title"], header [title]') ?? main!.querySelector('header'), messageIds: new Set(initial.messages.map(m => m.id)), composer: this.doc.querySelector('#main footer [contenteditable="true"], #main [data-testid="conversation-compose-box-input"]'), baseline, sourceBaseline: new Set(this.makerSources(this.doc)), image, deadline, state: 'opening', proofs: new Map(), proofController: new AbortController(), assigned: false, attach: attaches[0], discoverMenu: routeMenu };
      ownership = owned;
      owned.observer = new MutationObserver(records => this.observeMaker(owned, records));
      owned.observer.observe(this.doc.body, { childList: true, subtree: true, attributes: true, characterData: true, attributeFilter: ['aria-selected', 'src', 'title'] });
      detail = 'attach-click-failed';
      attaches[0].click();
      let items: HTMLElement[] = [];
      while (valid() && Date.now() < deadline) {
        owned.menu = routeMenu();
        items = routeItems().filter(isStickerItem);
        if (items.length) break;
        await pause();
      }
      requireActive();
      if (!items.length) fail('item-not-found');
      if (items.length !== 1) fail('item-ambiguous');
      owned.menu = items[0].closest<HTMLElement>('[role="menu"]') ?? owned.menu;
      if (!owned.menu || !owned.menu.contains(items[0])) fail('menu-unavailable');
      const inputBaseline = new Set(this.doc.querySelectorAll<HTMLInputElement>('input[type="file"]'));
      const associated = new Set(items[0].querySelectorAll<HTMLInputElement>('input[type="file"]'));
      // Native New sticker can click a pre-mounted input from its handler.
      // Observe only that synchronous activation; unrelated later clicks cannot
      // grant route association or send permission. Cancel its chooser default
      // while this preparation owns the route; assigning files cannot dismiss
      // a chooser opened with the page's remaining user activation.
      const inputClick = (event: Event) => {
        const input = event.target;
        if (input instanceof HTMLInputElement && input.type === 'file' && input.getAttribute('accept')?.trim() === 'image/*' && this.maker === owned && owned.state === 'opening' && Date.now() < deadline && valid()) {
          associated.add(input);
          event.preventDefault();
        }
      };
      this.doc.addEventListener('click', inputClick, true);
      detail = 'item-click-failed';
      try { items[0].click(); }
      finally { this.doc.removeEventListener('click', inputClick, true); }
      const eligibleInputs = () => [...this.doc.querySelectorAll<HTMLInputElement>('input[type="file"]')].filter(e => e.getAttribute('accept')?.trim() === 'image/*' && (!inputBaseline.has(e) || associated.has(e) || items[0].contains(e)));
      let inputs: HTMLInputElement[] = [];
      while (valid() && Date.now() < deadline) {
        inputs = eligibleInputs();
        if (inputs.length) break;
        await pause();
      }
      requireActive();
      if (!inputs.length) fail('input-not-found');
      if (inputs.length !== 1) fail('input-ambiguous');
      const disclosed = await this.makerPermission({ nonce: ticket.nonce, phase: 'disclose', snapshot: this.read() }, signal, deadline);
      requireActive();
      if (!disclosed) fail('disclose-denied');
      const currentInputs = eligibleInputs();
      if (currentInputs.length > 1) fail('input-ambiguous');
      if (currentInputs.length !== 1 || currentInputs[0] !== inputs[0] || !inputs[0].isConnected) fail('input-changed');
      if ([...this.doc.querySelectorAll('[data-testid="media-editor-canvas"]')].some(canvas => !baseline.has(canvas))) fail('editor-preopen');
      owned.sourceBaseline = new Set(this.makerSources(this.doc));
      // Only now disclose bytes to the page-owned input. This permission cannot
      // authorize Send. The next snapshot marks only this owned transition.
      detail = 'file-assignment-failed';
      if (!this.makerAction(owned, () => {
        owned.assigned = true; owned.state = 'waiting';
        owned.file = new File([bytes], 'sticker.webp', { type: 'image/webp' });
        const dt = new DataTransfer(); dt.items.add(owned.file);
        inputs[0].files = dt.files;
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
      })) fail('draft-appeared');
      let editor: ReturnType<StickerTransferConnector['makerLayer']>;
      while (valid() && Date.now() < deadline) {
        editor = this.makerLayer(baseline);
        if (editor?.layer !== owned.editor?.layer) editor = undefined;
        if (editor?.sends.length === 1 && !editor.loading && owned.editor && this.editorEvidence(owned.editor)) break;
        await pause();
      }
      const requireEditor = () => {
        requireActive();
        if (!editor) fail('editor-timeout');
        const currentEditor = this.makerLayer(baseline);
        if (!currentEditor || currentEditor.layer !== editor!.layer || currentEditor.close !== editor!.close || !owned.editor || !this.editorEvidence(owned.editor)) fail('editor-changed');
        if (currentEditor!.loading) fail('editor-timeout');
        if (currentEditor!.sends.length !== 1) fail('editor-send-ambiguous');
        if (currentEditor!.sends[0] !== editor!.sends[0]) fail('editor-changed');
        if (editor!.layer.querySelector('[contenteditable="true"], textarea, input:not([type="file"]):not([type="range"]):not([type="color"])')) fail('caption-present');
        if (!this.composerEmpty()) { owned.draftBlocked = true; fail('draft-appeared'); }
        if (this.read().stickerPreparation !== ticket.nonce) fail('preparation-lost');
      };
      requireEditor();
      const authorized = await this.makerPermission({ nonce: ticket.nonce, phase: 'send', snapshot: this.read() }, signal, deadline);
      requireEditor();
      if (!authorized) fail('send-denied');
      // Baseline every message identity, including empty virtualization placeholders
      // and individually identified items inside a grouped bubble.
      const before = this.messageBaseline(initialMessageIds);
      for (const message of [...initial.messages, ...this.read().messages]) before.ids.add(message.id);
      const sendStarted = Date.now();
      // Set clicked before invoking page handlers: an exception can leave the
      // outcome uncertain. It must never cause a second activation.
      detail = 'send-click-failed';
      if (!this.makerAction(owned, () => {
        clicked = true;
        try { editor!.sends[0].click(); } finally { this.emit({ type: 'stickerClicked', nonce: ticket.nonce }); }
      })) fail('draft-appeared');
      detail = 'confirm-timeout';
      const confirmationDeadline = sendStarted + STICKER_MAKER_CONFIRMATION_MS;
      while (Date.now() < confirmationDeadline && !signal.aborted) {
        const current = this.read();
        if (current.chatId !== ticket.target.chatId || current.name !== ticket.target.name || owned.main !== this.doc.querySelector('#main') || owned.selected !== this.doc.querySelector('#pane-side [aria-selected="true"]')) { detail = 'chat-changed'; break; }
        if (this.newOutgoingSticker(before)) { confirmed = true; break; }
        await pause(confirmationDeadline);
      }
    } catch { /* Fail closed. No route fallback, Enter, or automatic retry. */ }
    finally {
      // IME/readiness changes can revoke authorization before the action guard
      // runs. Still preserve any newly uncertain draft in the owned chat.
      const current = this.read();
      if (ownership && ownership.main === this.doc.querySelector('#main') && ownership.selected === this.doc.querySelector('#pane-side [aria-selected="true"]') && current.chatId === ticket.target.chatId && current.name === ticket.target.name && !this.composerEmpty()) ownership.draftBlocked = true;
      // Capture only mounts that happened while the token was still valid.
      // Teardown never waits for or adopts an editor after invalidation.
      if (ownership) { this.observeMaker(ownership); this.invalidateMaker(ownership); }
      const changed = !clicked && (ownership?.invalidReason === 'chat-changed' || (ownership ? !this.destinationMatches(ownership, this.read()) : !sameStickerChat(ticket.target, this.read())));
      const cleaned = await this.closeMaker(ownership);
      if (!cleaned && !confirmed) detail = 'editor-cleanup-failed';
      const draftBlocked = ownership?.draftBlocked;
      if (this.maker === ownership) this.maker = undefined;
      if (ownership) { ownership.state = 'finished'; ownership.observer?.disconnect(); ownership.proofController.abort(); }
      this.makerActive = false;
      if (this.controller === controller) this.controller = undefined;
      if (draftBlocked) {
        result({ type: 'stickerSent', nonce: ticket.nonce, clicked, confirmed: false, reason: 'draft', detail: 'draft-appeared' });
      } else if (generation === this.sendGeneration) {
        if (changed) this.emit({ type: 'stickerCancelled', nonce: ticket.nonce, reason: 'chat-changed', detail: 'chat-changed' });
        else result({ type: 'stickerSent', nonce: ticket.nonce, clicked, confirmed, ...(!confirmed ? { reason: clicked ? 'unconfirmed' as const : 'editor-unavailable' as const, detail } : {}) });
      }
    }
  }

  private identityRows() {
    return [...this.doc.querySelectorAll<HTMLElement>(messageSelector.split(', ').map(selector => `#main ${selector}`).join(', '))].filter(row => !row.closest(quoteSelector));
  }
  private messageAliases(row: HTMLElement) {
    return [row.dataset.id, row.dataset.testid?.startsWith('conv-msg-') ? row.dataset.testid.slice(9) : undefined, row.dataset.testid === 'grouped-sticker-item' ? row.id : undefined].filter((id): id is string => Boolean(id));
  }
  private outgoingMessage(row: HTMLElement) {
    const direction = messageDirection(row, row.dataset.id ?? this.messageAliases(row)[0]);
    return direction === true || (direction === null && ownElements(row, '[data-testid="msg-meta"] [data-icon="msg-check"], [data-testid="msg-meta"] [data-icon="msg-dblcheck"]').length > 0);
  }
  private messageIdentities() {
    return new Set(this.identityRows().flatMap(row => this.messageAliases(row)));
  }
  private messageBaseline(previous: Set<string>): MessageBaseline {
    const rows = this.identityRows(), ids = new Set([...previous, ...rows.flatMap(row => this.messageAliases(row))]);
    // Keep content boundaries too: a grouped child must follow an existing
    // wrapper's own sticker, even when that wrapper has no identified children.
    const stickers = [...this.doc.querySelectorAll<HTMLElement>('#main [data-testid="sticker-container"]')].filter(row => !row.closest(quoteSelector));
    const frontierRow = rows.at(-1);
    return { ids, rows: [...rows, ...stickers], frontierRow, frontier: new Set(frontierRow ? this.messageAliases(frontierRow) : []), rejected: new Set(), rejectedRows: new WeakSet() };
  }
  private newOutgoingSticker(baseline: MessageBaseline) {
    const before = baseline.ids;
    // If a remount retains any known alias, every other alias of that same row
    // is also old. Keep that correlation for later attribute-only remounts.
    const rows = this.identityRows();
    let added = true;
    while (added) {
      added = false;
      for (const row of rows) {
        const aliases = this.messageAliases(row);
        for (const known of [before, baseline.frontier, baseline.rejected]) {
          if (aliases.some(id => known.has(id))) for (const id of aliases) if (!known.has(id)) { known.add(id); added = true; }
        }
      }
    }
    const anchors = [...new Set([...baseline.rows.filter(row => row.isConnected), ...rows.filter(row => this.messageAliases(row).some(id => before.has(id)))])];
    const frontierPresent = baseline.frontierRow?.isConnected || (baseline.frontier.size ? rows.some(row => this.messageAliases(row).some(id => baseline.frontier.has(id))) : !before.size);
    const follows = (anchor: HTMLElement, row: HTMLElement) => {
      // Group wrappers precede their individually identified items logically.
      // A new item at the end of an existing group can be a genuine append.
      if (anchor.contains(row) && anchor !== row) return true;
      return !row.contains(anchor) && Boolean(anchor.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING);
    };
    const appended = new Set<HTMLElement>();
    for (const row of rows) {
      const aliases = this.messageAliases(row);
      if (baseline.rows.includes(row) || baseline.rejectedRows.has(row) || aliases.some(id => before.has(id) || baseline.rejected.has(id))) continue;
      // An unidentified grouped item needs its existing content boundary to
      // survive. An absent frontier supplies no evidence either way; wait for
      // it to remount rather than permanently rejecting a smooth-scroll mount.
      if (!frontierPresent || (!aliases.length && !baseline.frontierRow?.isConnected)) continue;
      // Identities mounted above the baseline stay ineligible even if the
      // virtualized list later drops the anchors or moves the history row.
      if (!anchors.every(anchor => follows(anchor, row))) {
        baseline.rejectedRows.add(row);
        for (const id of aliases) baseline.rejected.add(id);
      } else appended.add(row);
    }
    let lastOutgoing: HTMLElement | undefined;
    for (const sticker of this.doc.querySelectorAll<HTMLElement>('#main [data-testid="sticker-container"]')) {
      if (sticker.closest(quoteSelector)) continue;
      const row = sticker.closest<HTMLElement>(messageSelector);
      if (row && this.outgoingMessage(row)) lastOutgoing = row;
    }
    // DOM order, rather than scroll position, establishes the bottom-most
    // outgoing sticker. WhatsApp can still be scrolling, or the user browsing
    // above it, when the genuine message is appended.
    return Boolean(lastOutgoing && appended.has(lastOutgoing));
  }
  private picker() { return this.doc.querySelector<HTMLElement>(pickerSelector); }
  private closeOpenedPicker() {
    const opened = this.openedPicker; this.openedPicker = undefined;
    // Do not toggle a closed/replaced picker, or one the user opened beforehand.
    if (opened && this.picker() === opened.panel && this.doc.querySelector(triggerSelector) === opened.trigger && visible(opened.trigger)) opened.trigger.click();
  }
  private async openPicker(deadline: number) {
    if (this.openingPicker) { this.openingDeadline = Math.max(this.openingDeadline, deadline); return this.openingPicker; }
    if (this.picker()) return;
    const trigger = this.doc.querySelector<HTMLElement>(triggerSelector);
    if (!trigger || !visible(trigger)) return;
    this.openingDeadline = deadline;
    // Opening can mount asynchronously. Finish observing that mount even after
    // cancellation so a late picker is closed, and share it with a newer lookup.
    this.openingPicker = (async () => {
      trigger.click();
      while (!this.stopped && Date.now() < this.openingDeadline && !this.picker() && trigger.isConnected && this.doc.querySelector(triggerSelector) === trigger) await new Promise(resolve => setTimeout(resolve, 100));
      const panel = this.picker();
      if (panel && this.doc.querySelector(triggerSelector) === trigger) this.openedPicker = { panel, trigger };
    })();
    try { await this.openingPicker; }
    finally { this.openingPicker = undefined; if (!this.controller) this.closeOpenedPicker(); }
  }
  private valid(ticket: StickerTicket, signal: AbortSignal) { return !signal.aborted && sameStickerChat(ticket.target, this.read()); }
  private async wait(ticket: StickerTicket, signal: AbortSignal, ms: number) {
    if (!this.valid(ticket, signal)) throw new Error('Cancelled');
    await new Promise<void>(resolve => { const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); }; const timer = setTimeout(finish, ms); signal.addEventListener('abort', finish, { once: true }); });
    if (!this.valid(ticket, signal)) throw new Error('Cancelled');
  }
  private images() { return [...(this.picker()?.querySelectorAll<HTMLImageElement>('[data-testid="sticker-item"] img') ?? [])].filter(img => visible(img)); }
  private buttonFor(image: HTMLImageElement) {
    const button = image.closest<HTMLElement>('button, [role="button"]');
    // Never activate a message bubble, a pack tab, a store button or a media Send control.
    return button && this.picker()?.contains(button) && button.contains(image.closest('[data-testid="sticker-item"]')) && visible(button) && button.getAttribute('aria-disabled') !== 'true' && !button.hasAttribute('disabled') ? button : undefined;
  }
  private async find(ticket: StickerTicket, signal: AbortSignal, deadline: number): Promise<Match | undefined> {
    for (const image of this.images()) {
      if (!this.valid(ticket, signal)) throw new Error('Cancelled');
      if (Date.now() >= deadline) return;
      if (stickerImageState(image) !== 'ready') continue;
      const source = image.currentSrc || image.src;
      if (!source.startsWith('blob:') && !source.startsWith('data:image/webp;')) continue;
      let hash = this.hashes.get(source) ?? this.verified.get(source);
      if (!hash) {
        try {
          const response = await fetch(source, { signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now())))]) });
          if (!this.valid(ticket, signal)) throw new Error('Cancelled');
          const blob = await response.blob();
          if (!this.valid(ticket, signal)) throw new Error('Cancelled');
          if (blob.type !== 'image/webp' || blob.size > MAX_STICKER_BYTES) continue;
          const bytes = await blob.arrayBuffer();
          if (!this.valid(ticket, signal)) throw new Error('Cancelled');
          const digest = await crypto.subtle.digest('SHA-256', bytes);
          if (!this.valid(ticket, signal)) throw new Error('Cancelled');
          hash = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
          this.verified.set(source, hash);
          if (this.verified.size > 2000) this.verified.delete(this.verified.keys().next().value!);
        } catch {
          if (!this.valid(ticket, signal)) throw new Error('Cancelled');
          continue;
        }
      }
      if (!this.valid(ticket, signal)) throw new Error('Cancelled');
      const button = this.buttonFor(image);
      if (Date.now() < deadline && hash === ticket.id && button && image.isConnected && source === (image.currentSrc || image.src) && stickerImageState(image) === 'ready') return { image, button, source };
    }
  }
  private scrollContainer(): HTMLElement | undefined {
    // Virtualized grids temporarily remove every image while scrolling. Find the
    // viewport itself rather than depending on an image still being mounted.
    return [...(this.picker()?.querySelectorAll<HTMLElement>('*') ?? [])].find(node =>
      node.clientHeight > 100 && node.scrollHeight > node.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(node).overflowY));
  }
  private categoryState(scroll?: HTMLElement) {
    const panel = this.picker();
    if (!panel) return { content: undefined, loading: true };
    const containerSelector = '[role="tabpanel"], [role="grid"], [role="list"]';
    const content = scroll ?? (panel.matches(containerSelector) && visible(panel) ? panel : [...panel.querySelectorAll<HTMLElement>(`${containerSelector}, ul, [data-testid="sticker-item"]`)].find(visible));
    const loadingSelector = '[aria-busy="true"], [role="progressbar"], [data-icon*="spinner"], [data-testid*="spinner"], [data-testid*="loading"], [data-testid*="skeleton"], [data-testid*="placeholder"]';
    // The panel also contains navigation. Its presence alone does not prove
    // that the category content has mounted, unlike a list/grid, row or viewport.
    return { content, loading: !content || (panel.matches(loadingSelector) && visible(panel)) || [...panel.querySelectorAll<HTMLElement>(loadingSelector)].some(visible) };
  }
  async prepare(ticket: StickerTicket) {
    const messageIds = this.messageIdentities();
    for (const message of this.read().messages) messageIds.add(message.id);
    this.cancel(); const controller = new AbortController(); this.controller = controller;
    const signal = controller.signal;
    const startedAt = Date.now();
    const cold = !this.pickerOpenedInSession && !this.picker();
    const diagnostics: StickerLookupDiagnostics = { totalMs: 0, categories: [] };
    const trace = (name: StickerLookupDiagnostics['categories'][number]['name']) => {
      const previous = diagnostics.categories.find(entry => entry.name === name);
      if (previous) return previous;
      const entry = { name, activatedMs: diagnosticElapsed(startedAt, STICKER_PICKER_LOOKUP_MS), firstImageMs: null as number | null, settledMs: null as number | null, loadingSeen: false, imagesSeen: 0, found: false };
      diagnostics.categories.push(entry); return entry;
    };
    const observe = (entry: StickerLookupDiagnostics['categories'][number], loading = false) => {
      const images = this.images();
      entry.imagesSeen = Math.min(100_000, Math.max(entry.imagesSeen, images.length));
      if (images.some(image => stickerImageState(image) === 'ready')) entry.firstImageMs ??= diagnosticElapsed(startedAt, STICKER_PICKER_LOOKUP_MS);
      entry.loadingSeen ||= loading || images.some(image => stickerImageState(image) === 'pending');
    };
    const lookupDeadline = startedAt + STICKER_PICKER_LOOKUP_MS;
    const deadline = setTimeout(() => controller.abort(), STICKER_PICKER_LOOKUP_MS);
    let match: Match | undefined;
    try {
      if (!this.valid(ticket, signal)) return;
      await this.openPicker(lookupDeadline);
      if (this.picker()) this.pickerOpenedInSession = true;
      if (!this.picker() || !this.valid(ticket, signal)) return;
      const stickerTab = this.picker()?.querySelector<HTMLElement>('[data-testid="expressions-btn-sticker"]');
      if (stickerTab && stickerTab.getAttribute('aria-selected') !== 'true') { stickerTab.click(); await this.wait(ticket, signal, 200); }
      // Remember only a selected native category control: never guess a pack
      // from its name or activate a store/download control. Favorites/Recent
      // account for most indexed originals, so search them before this pack.
      const panel = this.picker()!;
      const favorites = panel.querySelector<HTMLElement>('[data-testid="panel-starred"]');
      const recent = panel.querySelector<HTMLElement>('[data-testid="panel-recent"]');
      const selectedPacks = [...panel.querySelectorAll<HTMLElement>('button[aria-selected="true"], [role="button"][aria-selected="true"], [role="tab"][aria-selected="true"]')].filter(tab =>
        !tab.contains(favorites) && !tab.contains(recent) && !tab.dataset.testid?.startsWith('expressions-') && !/store/i.test(tab.dataset.testid ?? '') && !tab.querySelector('[data-testid^="expressions-"], [data-testid*="store"]') && !tab.closest('[data-testid="sticker-item"]') && visible(tab));
      const pack = selectedPacks.length === 1 ? selectedPacks[0] : undefined;
      const unfinished = new Set<string | HTMLElement | undefined>();
      const categories: readonly (string | HTMLElement)[] = [
        ...(favorites && visible(favorites) ? ['panel-starred'] : []),
        ...(recent && visible(recent) ? ['panel-recent'] : []),
        ...(pack ? [pack] : [])
      ];
      // A picker with no category navigation still exposes its current grid.
      const searches: (string | HTMLElement | undefined)[] = categories.length ? [...categories] : [undefined];
      const unsearched = new Set(searches);
      const progress = new Map<string | HTMLElement | undefined, CategoryProgress>();
      let active: { category: string | HTMLElement | undefined; tab?: HTMLElement; panel: HTMLElement } | undefined;
      // The mounted grid may belong to a pack with no selected tab we can
      // safely rediscover. Poll pending originals before switching away,
      // while reserving search time for the known native category controls.
      const currentGridDeadline = Math.floor(Math.min(lookupDeadline, Date.now() + Math.min(categoryBudget, (lookupDeadline - Date.now()) / (categories.length + 1))));
      const currentTrace = trace('current');
      do {
        observe(currentTrace, this.categoryState(this.scrollContainer()).loading);
        match = await this.find(ticket, signal, currentGridDeadline);
        currentTrace.found = Boolean(match);
        if (match || !categories.length || pack || !this.images().some(image => stickerImageState(image) === 'pending') || Date.now() >= currentGridDeadline) break;
        await this.wait(ticket, signal, Math.min(100, currentGridDeadline - Date.now()));
      } while (Date.now() < currentGridDeadline);
      if (this.images().some(image => stickerImageState(image) === 'pending') && !pack && categories.length) unfinished.add('current');
      if (!currentTrace.found && !currentTrace.imagesSeen && !currentTrace.loadingSeen) diagnostics.categories.pop();
      for (const category of searches) {
        if (match) break;
        if (!this.valid(ticket, signal)) return;
        if (Date.now() >= lookupDeadline) break;
        const visitStartedAt = Date.now();
        // Incomplete categories return to the queue. Do not let one slow
        // category prevent checking the others, or discard it after its slice.
        // Reserve an equal slice for every still-unsearched category when the
        // picker opens late. After the first pass, unfinished visits rotate.
        const reservedCategories = Math.max(1, unsearched.size);
        unsearched.delete(category);
        const categoryDeadline = Math.floor(Math.min(lookupDeadline, visitStartedAt + Math.min(categoryBudget, (lookupDeadline - visitStartedAt) / reservedCategories)));
        const entry = trace(category === 'panel-starred' ? 'favorites' : category === 'panel-recent' ? 'recent' : category ? 'open-pack' : 'current');
        const tab = typeof category === 'string' ? this.picker()?.querySelector<HTMLElement>(`[data-testid="${category}"]`) ?? undefined : category;
        const previous = progress.get(category);
        const continuous = previous && active && active.category === category && active.tab === tab && active.panel === this.picker() && tab?.getAttribute('aria-selected') !== 'false';
        if (category) {
          if (!tab || !tab.isConnected || !this.picker()?.contains(tab) || !visible(tab)) { unfinished.add(category); continue; }
          if (!continuous) tab.click();
        }
        active = { category, tab, panel: this.picker()! };
        const activatedAt = continuous ? previous.activatedAt : visitStartedAt;
        let scroll = this.scrollContainer();
        let resetScroll = !continuous, scrollSteps = 0, stableSince = continuous ? previous.stableSince : 0, pollDelay = 0;
        let pendingSince = continuous ? previous.pendingSince : undefined, sawMountedRow = previous?.sawMountedRow ?? false, incomplete = previous?.incomplete ?? false, exhausted = false;
        let movement = continuous ? previous.movement : undefined;
        let endState = continuous ? previous.endState : undefined;
        while (Date.now() < categoryDeadline) {
          if (pollDelay) await this.wait(ticket, signal, Math.min(pollDelay, categoryDeadline - Date.now()));
          // One final, synchronous settlement check belongs to this slice.
          // It cannot start another wait, hash, or scroll at the boundary.
          const atBoundary = Date.now() >= categoryDeadline;
          pollDelay = 100;
          // A pending neighbor never hides a ready original, including the row
          // mounted when a user-opened picker is already scrolled down.
          if (!atBoundary) match = await this.find(ticket, signal, categoryDeadline);
          if (!this.valid(ticket, signal)) throw new Error('Cancelled');
          observe(entry);
          if (match) { entry.found = true; break; }
          scroll = scroll?.isConnected ? scroll : this.scrollContainer();
          if (resetScroll) {
            resetScroll = false;
            // Resume a sliced scan instead of repeatedly searching only its
            // first rows. Check the mounted row before restoring the position.
            const position = previous?.position ?? 0;
            if (scroll && scroll.scrollTop !== position) {
              if (Date.now() >= categoryDeadline) break;
              movement = { scroll, from: scroll.scrollTop };
              scroll.scrollTop = position; pollDelay = 400; continue;
            }
          }
          // A stuck/replaced viewport is incomplete, never proof of absence.
          if (movement) {
            if (scroll !== movement.scroll || scroll.scrollTop === movement.from) { movement = undefined; incomplete = true; break; }
            movement = undefined;
          }
          const atEnd = !scroll || scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2;
          const viewport = scroll?.getBoundingClientRect();
          const images = this.images();
          sawMountedRow ||= images.length > 0 || Boolean(this.picker()?.querySelector('[data-testid="sticker-item"]'));
          const rowImages = images.filter(image => {
            const rect = image.getBoundingClientRect();
            return atEnd || !viewport || (rect.bottom > viewport.top && rect.top < viewport.bottom);
          });
          const { content, loading } = this.categoryState(scroll);
          // Visible loading holds exhaustion open through subsequent visits.
          const coldMount = cold && !sawMountedRow && Date.now() - activatedAt < initialMountGrace;
          observe(entry, loading || coldMount);
          if (loading || coldMount) {
            endState = undefined;
            if (atBoundary) break;
            continue;
          }
          const pending = rowImages.some(image => stickerImageState(image) === 'pending') || (!rowImages.length && Boolean(scroll || sawMountedRow));
          if (pending) {
            endState = undefined;
            pendingSince ??= Date.now();
            if (atEnd || Date.now() - pendingSince < pendingRowWait) {
              if (atBoundary) break;
              continue;
            }
            incomplete = true;
            // Skip a stuck virtual row to examine later rows. The incomplete
            // category remains queued even if the rest of its grid settles.
          } else pendingSince = undefined;
          if (atEnd) {
            // Growth/replacement can restart settling, but never extend this
            // visit. An unsettled grid returns after the other categories.
            const state = { scroll, content, height: scroll?.scrollHeight ?? 0, viewportHeight: scroll?.clientHeight ?? 0, position: scroll?.scrollTop ?? 0, images: images.map(image => ({ image, source: image.currentSrc || image.src })) };
            const unchanged = endState && state.scroll === endState.scroll && state.content === endState.content && state.height === endState.height && state.viewportHeight === endState.viewportHeight && state.position === endState.position && state.images.length === endState.images.length && state.images.every((entry, i) => entry.image === endState!.images[i].image && entry.source === endState!.images[i].source);
            if (!unchanged) stableSince = Date.now();
            endState = state;
            // Growth, replacement and loading restart the quiet window. Each
            // switched category gets its own window even if it reuses a list.
            const quietWindow = images.length || sawMountedRow ? populatedSettleWindow : settleWindow;
            if (Date.now() - stableSince >= quietWindow) {
              const currentImages = this.images();
              const currentState = this.categoryState(scroll);
              if (!currentState.loading && currentState.content === content && (this.scrollContainer() ?? scroll) === scroll && (!scroll || (scroll.isConnected && scroll.scrollHeight === state.height && scroll.clientHeight === state.viewportHeight && scroll.scrollTop === state.position)) && currentImages.length === state.images.length && currentImages.every((image, i) => image === state.images[i].image && (image.currentSrc || image.src) === state.images[i].source && stickerImageState(image) !== 'pending')) {
                exhausted = !incomplete;
                entry.settledMs = diagnosticElapsed(startedAt, STICKER_PICKER_LOOKUP_MS);
                break;
              }
              endState = undefined;
            }
          } else {
            endState = undefined;
            if (Date.now() >= categoryDeadline) break;
            if (Date.now() - visitStartedAt >= categoryBudget || scrollSteps >= maxScrollSteps) { incomplete = true; break; }
            movement = { scroll: scroll!, from: scroll!.scrollTop };
            scroll!.scrollTop += Math.max(100, scroll!.clientHeight * .7);
            scrollSteps++; pendingSince = undefined; pollDelay = 400;
          }
          if (atBoundary) break;
        }
        // After completing an incomplete scan, revisit rows skipped while
        // pending. Otherwise preserve progress through a long virtual grid.
        const restart = incomplete && (!scroll || scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2);
        progress.set(category, { position: restart ? 0 : scroll?.scrollTop ?? 0, incomplete: restart ? false : incomplete, sawMountedRow, activatedAt, stableSince, pendingSince, endState: restart ? undefined : endState, movement: restart ? undefined : movement });
        if (restart) active = undefined;
        if (match) break;
        if (exhausted) unfinished.delete(category);
        else { unfinished.add(category); searches.push(category); }
      }
      // Incomplete categories are not proof of absence. Check late ready rows
      // only within the remaining total budget, then report missing so the
      // user can choose Send still.
      while (!match && unfinished.size > 0 && Date.now() < lookupDeadline) {
        await this.wait(ticket, signal, Math.min(100, lookupDeadline - Date.now()));
        match = await this.find(ticket, signal, lookupDeadline);
      }
      if (match && this.valid(ticket, signal)) { match.image.scrollIntoView({ block: 'center' }); this.prepared = { ...ticket, ...match, messageIds, diagnostics, startedAt }; }
    } catch { /* A cancelled/changed/unavailable picker cannot grant sending permission. */ }
    finally {
      clearTimeout(deadline);
      if (this.controller === controller) {
        this.controller = undefined;
        diagnostics.totalMs = diagnosticElapsed(startedAt);
        if (!this.prepared) diagnostics.reason = Date.now() >= lookupDeadline ? 'lookup-cap' : !sameStickerChat(ticket.target, this.read()) ? 'chat-changed' : !this.picker() ? 'picker-unavailable' : 'not-found';
        if (!this.prepared || !this.valid(ticket, signal)) this.closeOpenedPicker();
        this.emit({ type: 'stickerPrepared', nonce: ticket.nonce, found: Boolean(this.prepared && this.valid(ticket, signal)), diagnostics });
      }
    }
  }
  async send(ticket: StickerTicket, expiresAt: number) {
    if (this.sendingGeneration === this.sendGeneration) return;
    this.sendingGeneration = this.sendGeneration;
    const prepared = this.prepared; this.prepared = undefined;
    const generation = this.sendGeneration;
    let clicked = false, confirmed = false;
    const valid = () => generation === this.sendGeneration && Date.now() < expiresAt && prepared && ticket.id === prepared.id && ticket.nonce === prepared.nonce && sameStickerChat(prepared.target, this.read()) && sameStickerChat(ticket.target, this.read()) && prepared.image.isConnected && stickerImageState(prepared.image) === 'ready' && (prepared.image.currentSrc || prepared.image.src) === prepared.source && (this.hashes.get(prepared.source) ?? this.verified.get(prepared.source)) === ticket.id && this.buttonFor(prepared.image) === prepared.button;
    try {
      if (valid() && await this.authorize(ticket.nonce) && valid()) {
        // Main revalidates the one-use ticket before the only native sticker activation.
        const before = this.messageBaseline(prepared!.messageIds);
        for (const message of this.read().messages) before.ids.add(message.id);
        const main = this.doc.querySelector('#main'), selected = this.doc.querySelector('#pane-side [aria-selected="true"]');
        clicked = true;
        try { prepared!.button.click(); } finally { this.emit({ type: 'stickerClicked', nonce: ticket.nonce }); }
        const deadline = Date.now() + STICKER_MAKER_CONFIRMATION_MS;
        while (Date.now() < deadline && generation === this.sendGeneration) {
          const current = this.read();
          if (current.chatId !== ticket.target.chatId || current.name !== ticket.target.name || main !== this.doc.querySelector('#main') || selected !== this.doc.querySelector('#pane-side [aria-selected="true"]')) break;
          if (this.newOutgoingSticker(before)) { confirmed = true; break; }
          await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
        }
      }
    } catch {
      // Lost authorization cannot trigger a click or retry.
    }
    if (generation === this.sendGeneration) this.closeOpenedPicker();
    if (this.sendingGeneration === generation) this.sendingGeneration = undefined;
    this.emit({ type: 'stickerSent', nonce: ticket.nonce, clicked, confirmed, ...(prepared ? { diagnostics: { ...prepared.diagnostics, totalMs: diagnosticElapsed(prepared.startedAt) } } : {}), ...(clicked && !confirmed ? { reason: 'unconfirmed' as const, detail: 'confirm-timeout' as const } : {}) });
  }
}
