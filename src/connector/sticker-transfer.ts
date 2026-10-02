import type { RemoteEvent } from '../shared/connector';
import type { Snapshot } from '../shared/model';
import { MAX_STICKER_BYTES } from '../shared/sticker-limits';
import { sameStickerChat, type StickerTicket } from '../shared/sticker-transfer';
import { stickerImageState } from './sticker-image-state';

const pickerSelector = '[data-testid="expressions-panel"]';
const triggerSelector = '#main footer [aria-label="Emojis, GIFs, Stickers"], #main footer [aria-label="Emojis, GIF y stickers"]';
const visible = (e: HTMLElement) => e.checkVisibility({ visibilityProperty: true }) && e.getBoundingClientRect().width > 0;
type Match = { image: HTMLImageElement; button: HTMLElement; source: string };
const categoryBudget = 20_000, settleWindow = 2000, pendingRowWait = 10_000;
// Give an unmounted/loading category time to appear; an idle rendered empty
// container can start its normal two-second settle window immediately.
const initialMountGrace = 4000, maxScrollSteps = 40;

// DOM-only adapter. No stores, WhatsApp internal modules, file imports or re-encoding.
export class StickerTransferConnector {
  private verified = new Map<string, string>();
  private prepared?: StickerTicket & Match;
  private controller?: AbortController;
  private sendGeneration = 0;
  private sendingGeneration?: number;
  private openedPicker?: { panel: HTMLElement; trigger: HTMLElement };
  private openingPicker?: Promise<void>;
  private openingDeadline = 0;
  private stopped = false;
  constructor(private doc: Document, private read: () => Snapshot, private hashes: Map<string, string>, private emit: (event: RemoteEvent) => void, private authorize: (nonce: string) => Promise<boolean> = async () => false) {}
  cancel() { this.sendGeneration++; this.controller?.abort(); this.controller = undefined; this.prepared = undefined; this.closeOpenedPicker(); }
  stop() { this.stopped = true; this.cancel(); }
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
      if (hash === ticket.id && button && image.isConnected && source === (image.currentSrc || image.src) && stickerImageState(image) === 'ready') return { image, button, source };
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
    const loadingSelector = '[aria-busy="true"], [role="progressbar"], [data-icon*="spinner"], [data-testid*="spinner"], [data-testid*="loading"], [data-testid*="skeleton"]';
    // The panel also contains navigation. Its presence alone does not prove
    // that the category content has mounted, unlike a list/grid, row or viewport.
    return { content, loading: !content || (panel.matches(loadingSelector) && visible(panel)) || [...panel.querySelectorAll<HTMLElement>(loadingSelector)].some(visible) };
  }
  async prepare(ticket: StickerTicket) {
    this.cancel(); const controller = new AbortController(); this.controller = controller;
    const signal = controller.signal;
    const lookupDeadline = Date.now() + 60_000;
    const deadline = setTimeout(() => controller.abort(), 60_000);
    let match: Match | undefined;
    try {
      if (!this.valid(ticket, signal)) return;
      await this.openPicker(lookupDeadline);
      if (!this.picker() || !this.valid(ticket, signal)) return;
      const stickerTab = this.picker()?.querySelector<HTMLElement>('[data-testid="expressions-btn-sticker"]');
      if (stickerTab && stickerTab.getAttribute('aria-selected') !== 'true') { stickerTab.click(); await this.wait(ticket, signal, 200); }
      // Search the currently open pack first, then favorites and recents. No store purchases/downloads.
      let allExhausted = true;
      const categories = [null, 'panel-starred', 'panel-recent'];
      for (const [index, category] of categories.entries()) {
        if (!this.valid(ticket, signal)) return;
        const activatedAt = Date.now();
        // Divide the remaining minute as well, so a slow opening cannot
        // consume the slices reserved for later categories.
        const categoryDeadline = Math.floor(activatedAt + Math.min(categoryBudget, (lookupDeadline - activatedAt) / (categories.length - index)));
        if (category) {
          const tab = this.picker()?.querySelector<HTMLElement>(`[data-testid="${category}"]`);
          if (!tab || !visible(tab)) continue;
          tab.click(); await this.wait(ticket, signal, Math.max(0, Math.min(400, Math.floor((categoryDeadline - Date.now()) / 2))));
        }
        let scroll = this.scrollContainer();
        let resetScroll = true, scrollSteps = 0, stableSince = 0, pollDelay = 100;
        let pendingSince: number | undefined, sawMountedRow = false, incomplete = false, exhausted = false;
        let movement: { scroll: HTMLElement; from: number } | undefined;
        let endState: { scroll?: HTMLElement; content?: HTMLElement; height: number; viewportHeight: number; position: number; images: { image: HTMLImageElement; source: string }[] } | undefined;
        while (Date.now() < categoryDeadline) {
          await this.wait(ticket, signal, Math.min(pollDelay, categoryDeadline - Date.now())); pollDelay = 100;
          // A pending neighbor never hides a ready original, including the row
          // mounted when a user-opened picker is already scrolled down.
          match = await this.find(ticket, signal, categoryDeadline);
          if (!this.valid(ticket, signal)) throw new Error('Cancelled');
          if (match) break;
          scroll = scroll?.isConnected ? scroll : this.scrollContainer();
          if (resetScroll) {
            resetScroll = false;
            if (scroll && scroll.scrollTop > 0) {
              movement = { scroll, from: scroll.scrollTop };
              scroll.scrollTop = 0; pollDelay = 400; continue;
            }
          }
          // A stuck/replaced viewport is incomplete, never proof of absence.
          if (movement) {
            if (scroll !== movement.scroll || scroll.scrollTop === movement.from) { incomplete = true; break; }
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
          // Only positive loading evidence justifies the extended mount grace.
          if (!sawMountedRow && loading && Date.now() - activatedAt < initialMountGrace) { endState = undefined; continue; }
          const pending = loading || rowImages.some(image => stickerImageState(image) === 'pending') || (!rowImages.length && Boolean(scroll || sawMountedRow));
          if (pending) {
            endState = undefined;
            pendingSince ??= Date.now();
            if (Date.now() - pendingSince < pendingRowWait) continue;
            incomplete = true;
            // Skip a stuck virtual row to examine later rows. At the end there
            // is no remaining progress to make, so reserve time for Favorites/Recent.
            if (atEnd) break;
          } else pendingSince = undefined;
          if (atEnd) {
            const state = { scroll, content, height: scroll?.scrollHeight ?? 0, viewportHeight: scroll?.clientHeight ?? 0, position: scroll?.scrollTop ?? 0, images: images.map(image => ({ image, source: image.currentSrc || image.src })) };
            const unchanged = endState && state.scroll === endState.scroll && state.content === endState.content && state.height === endState.height && state.viewportHeight === endState.viewportHeight && state.position === endState.position && state.images.length === endState.images.length && state.images.every((entry, i) => entry.image === endState!.images[i].image && entry.source === endState!.images[i].source);
            if (!unchanged) stableSince = Date.now();
            endState = state;
            // Cached Favorites may expand after 1.5 s. Growth/loading restarts
            // the quiet window, including after the initial-mount grace period.
            if (Date.now() - stableSince >= settleWindow) {
              const currentImages = this.images();
              if (this.categoryState(scroll).content === content && (this.scrollContainer() ?? scroll) === scroll && (!scroll || (scroll.isConnected && scroll.scrollHeight === state.height && scroll.clientHeight === state.viewportHeight && scroll.scrollTop === state.position)) && currentImages.length === state.images.length && currentImages.every((image, i) => image === state.images[i].image && (image.currentSrc || image.src) === state.images[i].source && stickerImageState(image) !== 'pending')) { exhausted = !incomplete; break; }
              endState = undefined;
            }
          } else {
            endState = undefined;
            if (scrollSteps >= maxScrollSteps) { incomplete = true; break; }
            movement = { scroll: scroll!, from: scroll!.scrollTop };
            scroll!.scrollTop += Math.max(100, scroll!.clientHeight * .7);
            scrollSteps++; pendingSince = undefined; pollDelay = 400;
          }
        }
        if (match) break;
        allExhausted &&= exhausted;
      }
      // Only genuinely exhausted categories justify an early miss. Capped,
      // stalled or timed-out categories still keep the global lookup window.
      while (!match && !allExhausted && Date.now() < lookupDeadline) {
        await this.wait(ticket, signal, Math.min(100, lookupDeadline - Date.now()));
        match = await this.find(ticket, signal, lookupDeadline);
      }
      if (match && this.valid(ticket, signal)) { match.image.scrollIntoView({ block: 'center' }); this.prepared = { ...ticket, ...match }; }
    } catch { /* A cancelled/changed/unavailable picker cannot grant sending permission. */ }
    finally {
      clearTimeout(deadline);
      if (this.controller === controller) {
        this.controller = undefined;
        if (!this.prepared || !this.valid(ticket, signal)) this.closeOpenedPicker();
        this.emit({ type: 'stickerPrepared', nonce: ticket.nonce, found: Boolean(this.prepared && this.valid(ticket, signal)) });
      }
    }
  }
  async send(ticket: StickerTicket, expiresAt: number) {
    if (this.sendingGeneration === this.sendGeneration) return;
    this.sendingGeneration = this.sendGeneration;
    const prepared = this.prepared; this.prepared = undefined;
    const generation = this.sendGeneration;
    let clicked = false;
    const valid = () => generation === this.sendGeneration && Date.now() < expiresAt && prepared && ticket.id === prepared.id && ticket.nonce === prepared.nonce && sameStickerChat(prepared.target, this.read()) && sameStickerChat(ticket.target, this.read()) && prepared.image.isConnected && stickerImageState(prepared.image) === 'ready' && (prepared.image.currentSrc || prepared.image.src) === prepared.source && (this.hashes.get(prepared.source) ?? this.verified.get(prepared.source)) === ticket.id && this.buttonFor(prepared.image) === prepared.button;
    try {
      if (valid() && await this.authorize(ticket.nonce) && valid()) {
        // Main revalidates the one-use ticket before the only native sticker activation.
        prepared!.button.click(); clicked = true;
      }
    } catch {
      // Lost authorization cannot trigger a click or retry.
    }
    if (generation === this.sendGeneration) this.closeOpenedPicker();
    if (this.sendingGeneration === generation) this.sendingGeneration = undefined;
    this.emit({ type: 'stickerSent', nonce: ticket.nonce, clicked });
  }
}
