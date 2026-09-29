import type { RemoteEvent } from '../shared/connector';
import type { Snapshot } from '../shared/model';
import { MAX_STICKER_BYTES } from '../shared/sticker-limits';
import { sameStickerChat, STICKER_DRAG_TYPE, STICKER_DRAG_PREFIX, type StickerTicket } from '../shared/sticker-transfer';

const pickerSelector = '[data-testid="expressions-panel"]';
const visible = (e: HTMLElement) => e.checkVisibility({ visibilityProperty: true }) && e.getBoundingClientRect().width > 0;
type Match = { image: HTMLImageElement; button: HTMLElement; source: string };

// DOM-only adapter. No stores, WhatsApp internal modules, file imports or re-encoding.
export class StickerTransferConnector {
  private verified = new Map<string, string>();
  private armed?: StickerTicket;
  private armExpires = 0;
  private prepared?: StickerTicket & Match;
  private controller?: AbortController;
  private host: HTMLElement;
  private hint: HTMLElement;
  private hideTimer?: ReturnType<typeof setTimeout>;
  private sendGeneration = 0;
  constructor(private doc: Document, private read: () => Snapshot, private hashes: Map<string, string>, private emit: (event: RemoteEvent) => void, private authorize: (nonce: string) => Promise<boolean> = async () => false) {
    this.host = doc.createElement('div'); this.host.id = 'companion-sticker-drop';
    this.host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483644';
    const shadow = this.host.attachShadow({ mode: 'closed' });
    const style = doc.createElement('style');
    style.textContent = '.hint{position:fixed;border:2px dashed #21c063;border-radius:14px;background:#103b2bed;color:#fff;display:grid;place-items:center;font:16px system-ui;pointer-events:none;box-sizing:border-box}.hint[hidden]{display:none}';
    this.hint = doc.createElement('div'); this.hint.className = 'hint'; this.hint.textContent = 'Drop to preview sticker'; this.hint.hidden = true;
    shadow.append(style, this.hint); doc.documentElement.append(this.host);
    doc.addEventListener('dragenter', this.over, true); doc.addEventListener('dragover', this.over, true); doc.addEventListener('drop', this.drop, true);
    doc.addEventListener('dragend', this.hide, true);
  }
  arm(ticket: StickerTicket) { this.cancel(); if (sameStickerChat(ticket.target, this.read())) { this.armed = ticket; this.armExpires = Date.now() + 30_000; } }
  cancel() { this.sendGeneration++; this.controller?.abort(); this.controller = undefined; this.armed = undefined; this.prepared = undefined; this.hide(); }
  stop() { this.cancel(); this.doc.removeEventListener('dragenter', this.over, true); this.doc.removeEventListener('dragover', this.over, true); this.doc.removeEventListener('drop', this.drop, true); this.doc.removeEventListener('dragend', this.hide, true); this.host.remove(); }
  private hide = () => { clearTimeout(this.hideTimer); this.hint.hidden = true; };
  private insideChat(event: DragEvent) {
    const main = this.doc.querySelector('#main');
    return event.target instanceof Element && main?.contains(event.target) && !event.target.closest('header');
  }
  private over = (event: DragEvent) => {
    if (Date.now() >= this.armExpires) this.armed = undefined;
    if (!event.isTrusted || !event.dataTransfer || !(event.dataTransfer.types.includes(STICKER_DRAG_TYPE) || (this.armed && event.dataTransfer.types.includes('text/plain')))) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!this.armed || !sameStickerChat(this.armed.target, this.read()) || !this.insideChat(event)) { event.dataTransfer.dropEffect = 'none'; this.hide(); return; }
    event.dataTransfer.dropEffect = 'copy';
    const main = this.doc.querySelector('#main')!.getBoundingClientRect();
    const header = this.doc.querySelector('#main header')?.getBoundingClientRect();
    const top = header?.bottom ?? main.top;
    Object.assign(this.hint.style, { left: `${main.left + 12}px`, top: `${top + 12}px`, width: `${Math.max(0, main.width - 24)}px`, height: `${Math.max(0, main.bottom - top - 24)}px` });
    this.hint.hidden = false; clearTimeout(this.hideTimer); this.hideTimer = setTimeout(this.hide, 250);
  };
  private drop = (event: DragEvent) => {
    if (!event.isTrusted || !event.dataTransfer || !(event.dataTransfer.types.includes(STICKER_DRAG_TYPE) || event.dataTransfer.getData('text/plain').startsWith(STICKER_DRAG_PREFIX))) return;
    event.preventDefault(); event.stopImmediatePropagation(); this.hide();
    const ticket = Date.now() < this.armExpires ? this.armed : undefined; this.armed = undefined;
    if (!ticket || (event.dataTransfer.getData(STICKER_DRAG_TYPE) || event.dataTransfer.getData('text/plain').replace(STICKER_DRAG_PREFIX, '')) !== ticket.nonce || !sameStickerChat(ticket.target, this.read()) || !this.insideChat(event)) return;
    // Refresh main's chat identity before it evaluates this drop.
    this.emit({ type: 'snapshot', snapshot: this.read() });
    this.emit({ type: 'stickerDrop', nonce: ticket.nonce });
  };
  private picker() { return this.doc.querySelector<HTMLElement>(pickerSelector); }
  private valid(ticket: StickerTicket, signal: AbortSignal) { return !signal.aborted && sameStickerChat(ticket.target, this.read()); }
  private async wait(ticket: StickerTicket, signal: AbortSignal, ms: number) {
    await new Promise<void>(resolve => { const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); }; const timer = setTimeout(finish, ms); signal.addEventListener('abort', finish, { once: true }); });
    if (!this.valid(ticket, signal)) throw new Error('Cancelled');
  }
  private images() { return [...(this.picker()?.querySelectorAll<HTMLImageElement>('[data-testid="sticker-item"] img') ?? [])].filter(img => visible(img)); }
  private buttonFor(image: HTMLImageElement) {
    const button = image.closest<HTMLElement>('button, [role="button"]');
    // Never activate a message bubble, a pack tab, a store button or a media Send control.
    return button && this.picker()?.contains(button) && button.contains(image.closest('[data-testid="sticker-item"]')) && visible(button) && button.getAttribute('aria-disabled') !== 'true' && !button.hasAttribute('disabled') ? button : undefined;
  }
  private async find(ticket: StickerTicket, signal: AbortSignal): Promise<Match | undefined> {
    for (const image of this.images()) {
      if (!this.valid(ticket, signal)) throw new Error('Cancelled');
      const source = image.currentSrc || image.src;
      if (!source.startsWith('blob:') && !source.startsWith('data:image/webp;')) continue;
      let hash = this.hashes.get(source) ?? this.verified.get(source);
      if (!hash) {
        try {
          const response = await fetch(source, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
          const blob = await response.blob();
          if (blob.type !== 'image/webp' || blob.size > MAX_STICKER_BYTES) continue;
          const bytes = await blob.arrayBuffer();
          hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
          this.verified.set(source, hash);
          if (this.verified.size > 2000) this.verified.delete(this.verified.keys().next().value!);
        } catch { continue; }
      }
      const button = this.buttonFor(image);
      if (hash === ticket.id && button && image.isConnected && source === (image.currentSrc || image.src)) return { image, button, source };
    }
  }
  private scrollContainer(): HTMLElement | undefined {
    // Virtualized grids temporarily remove every image while scrolling. Find the
    // viewport itself rather than depending on an image still being mounted.
    return [...(this.picker()?.querySelectorAll<HTMLElement>('*') ?? [])].find(node =>
      node.clientHeight > 100 && node.scrollHeight > node.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(node).overflowY));
  }
  private async waitForImages(ticket: StickerTicket, signal: AbortSignal) {
    // A virtual row can exist before WhatsApp has downloaded/decrypted its image.
    // Scrolling past those placeholders would incorrectly report a missing sticker.
    for (let attempt = 0; attempt < 25; attempt++) {
      const viewport = this.scrollContainer()?.getBoundingClientRect();
      const images = this.images().filter(image => {
        const rect = image.getBoundingClientRect();
        return !viewport || (rect.bottom > viewport.top && rect.top < viewport.bottom);
      });
      if (images.length && images.every(image => image.complete && image.naturalWidth && /^(blob:|data:image\/webp;)/.test(image.currentSrc || image.src))) return;
      await this.wait(ticket, signal, 200);
    }
  }
  async prepare(ticket: StickerTicket) {
    this.cancel(); const controller = new AbortController(); this.controller = controller;
    const signal = controller.signal;
    const deadline = setTimeout(() => controller.abort(), 60_000);
    let match: Match | undefined;
    try {
      if (!this.valid(ticket, signal)) return;
      if (!this.picker()) {
        const open = this.doc.querySelector<HTMLElement>('#main footer [aria-label="Emojis, GIFs, Stickers"], #main footer [aria-label="Emojis, GIF y stickers"]');
        if (!open || !visible(open)) return;
        open.click();
        for (let i = 0; i < 20 && !this.picker(); i++) await this.wait(ticket, signal, 100);
      }
      const stickerTab = this.picker()?.querySelector<HTMLElement>('[data-testid="expressions-btn-sticker"]');
      if (stickerTab && stickerTab.getAttribute('aria-selected') !== 'true') { stickerTab.click(); await this.wait(ticket, signal, 200); }
      // Search the currently open pack first, then favorites and recents. No store purchases/downloads.
      for (const category of [null, 'panel-starred', 'panel-recent']) {
        const settleUntil = Date.now() + 3000;
        if (!this.valid(ticket, signal)) return;
        if (category) {
          const tab = this.picker()?.querySelector<HTMLElement>(`[data-testid="${category}"]`);
          if (!tab || !visible(tab)) continue;
          tab.click(); await this.wait(ticket, signal, 400);
        }
        for (let i = 0; i < 100 && !this.images().length; i++) await this.wait(ticket, signal, 150);
        await this.waitForImages(ticket, signal);
        match = await this.find(ticket, signal); if (match) break;
        let scroll = this.scrollContainer();
        if (scroll) scroll.scrollTop = 0;
        for (let page = 0; page < 40; page++) {
          await this.wait(ticket, signal, page ? 500 : 100);
          await this.waitForImages(ticket, signal);
          match = await this.find(ticket, signal); if (match) break;
          scroll = scroll?.isConnected ? scroll : this.scrollContainer();
          if (!scroll || scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2) {
            // Give the last virtualized row a chance to mount/decode before declaring a miss.
            await this.wait(ticket, signal, 500); match = await this.find(ticket, signal); if (match) break;
            scroll = this.scrollContainer() ?? scroll;
            // Favorites can first expose a small cached batch, then expand. A
            // temporarily short grid is not evidence that the collection ended.
            if (Date.now() < settleUntil || (scroll && scroll.scrollTop + scroll.clientHeight < scroll.scrollHeight - 2)) continue;
            break;
          }
          scroll.scrollTop += Math.max(100, scroll.clientHeight * .7);
        }
        if (match) break;
      }
      if (match && this.valid(ticket, signal)) { match.image.scrollIntoView({ block: 'center' }); this.prepared = { ...ticket, ...match }; }
    } catch { /* A cancelled/changed/unavailable picker cannot grant sending permission. */ }
    finally {
      clearTimeout(deadline);
      if (this.controller === controller) {
        this.controller = undefined;
        this.emit({ type: 'stickerPrepared', nonce: ticket.nonce, found: Boolean(this.prepared && this.valid(ticket, signal)) });
      }
    }
  }
  async send(ticket: StickerTicket, expiresAt: number) {
    const prepared = this.prepared; this.prepared = undefined;
    const generation = this.sendGeneration;
    let clicked = false;
    const valid = () => generation === this.sendGeneration && Date.now() < expiresAt && prepared && ticket.id === prepared.id && ticket.nonce === prepared.nonce && sameStickerChat(prepared.target, this.read()) && sameStickerChat(ticket.target, this.read()) && prepared.image.isConnected && (prepared.image.currentSrc || prepared.image.src) === prepared.source && (this.hashes.get(prepared.source) ?? this.verified.get(prepared.source)) === ticket.id && this.buttonFor(prepared.image) === prepared.button;
    try {
      if (valid() && await this.authorize(ticket.nonce) && valid()) {
        // Main revalidates confirmation/cancellation before the only native sticker activation.
        prepared!.button.click(); clicked = true;
      }
    } catch {
      // Lost authorization cannot trigger a click or retry.
    }
    this.emit({ type: 'stickerSent', nonce: ticket.nonce, clicked });
  }
}
