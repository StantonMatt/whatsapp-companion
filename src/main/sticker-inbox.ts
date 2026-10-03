import type { Sticker, DiscoveredSticker } from '../shared/model';
import { upsertSticker } from '../core/stickers';
import { fingerprintSticker, nearSticker, type StickerFingerprint, type StickerPixels } from './sticker-fingerprint';
import type { Store } from './store';
import { MAX_LIBRARY_BYTES, MAX_LIBRARY_STICKERS, MAX_PENDING_STICKER_CHARS } from '../shared/sticker-limits';
import { InvalidStickerError, storedSticker } from './sticker-bytes';

// Coalesce discovery into bounded transactions instead of copying/fsyncing the library per image.
export class StickerInbox {
  private itemErrors = new Map<string, string>();
  get issue(): string | undefined {
    return [...this.itemErrors.values()].find(message => message === "Couldn't save new stickers")
      ?? (this.pendingOverflow ? "Couldn't save new stickers" : undefined)
      ?? (this.itemErrors.size || this.store.state.stickers.length >= MAX_LIBRARY_STICKERS || this.store.state.stickers.reduce((total, s) => total + s.size, 0) >= MAX_LIBRARY_BYTES ? 'Sticker library is full' : undefined);
  }
  private reportedIssue?: string;
  private reportIssue() {
    const issue = this.issue;
    if (issue !== this.reportedIssue) { this.reportedIssue = issue; this.failed(issue); }
  }
  private pending = new Map<string, DiscoveredSticker>();
  // Five automatic attempts per hash, with exponential backoff. Exhausted
  // observations remain bounded by intake limits; an explicit flush can retry.
  private retries = new Map<string, { attempts: number; after: number }>();
  private bytes = 0;
  private pendingOverflow = false;
  private timer?: ReturnType<typeof setTimeout>;
  private timerAt = Infinity;
  private flushing?: Promise<boolean>;
  private closed = false;
  private closing?: Promise<void>;
  private exactOnly = false;
  private decodeAbort = new AbortController();
  // Includes decode failures so an unsupported old image is tried only once per
  // session. At most the current library and bounded pending batch are cached.
  private fingerprints = new Map<string, StickerFingerprint | undefined>();
  constructor(private store: Store, private changed: () => void, private failed: (message?: string) => void, private decode?: StickerPixels) {}
  discard(id: string) {
    this.removePending(id);
    this.fingerprints.delete(id);
    this.itemErrors.delete(id);
    // Rejected observations no longer own an error after library removal
    // frees capacity. Keep failures for surviving indexed/pending items.
    for (const failedId of this.itemErrors.keys()) if (!this.pending.has(failedId) && !this.store.state.stickers.some(s => s.id === failedId)) this.itemErrors.delete(failedId);
    this.pendingOverflow = false;
    this.reportIssue();
    this.schedule();
  }
  private removePending(id: string) {
    this.bytes -= this.pending.get(id)?.image.length ?? 0; this.pending.delete(id);
    this.retries.delete(id);
  }
  add(sticker: DiscoveredSticker) {
    if (this.closed || this.store.state.forgottenStickers.includes(sticker.id)) return;
    const bytes = this.bytes - (this.pending.get(sticker.id)?.image.length ?? 0) + sticker.image.length;
    if (bytes > MAX_PENDING_STICKER_CHARS || (!this.pending.has(sticker.id) && this.pending.size >= MAX_LIBRARY_STICKERS)) {
      this.pendingOverflow = true; this.reportIssue(); void this.flush(false); return;
    }
    // Fingerprints are main-owned, never accepted from discovery input.
    const { fingerprint: _ignored, ...observation } = sticker;
    this.pending.set(sticker.id, observation); this.bytes = bytes;
    this.schedule();
  }
  private schedule() {
    if (this.closed) return;
    const after = Math.min(...[...this.pending.keys()].map(id => this.retries.get(id)?.after ?? Date.now() + 500));
    if (this.timer && this.timerAt <= after) return;
    clearTimeout(this.timer); this.timer = undefined; this.timerAt = after;
    if (Number.isFinite(after)) this.timer = setTimeout(() => { void this.flush(false); }, Math.max(0, after - Date.now()));
  }
  flush(retryNow = true): Promise<boolean> {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.flushing) return this.flushing;
    this.flushing = this.applyBatch(retryNow).finally(() => { this.flushing = undefined; this.schedule(); });
    return this.flushing;
  }
  close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer); this.timer = undefined;
    return this.closing ??= this.drain();
  }
  private async drain(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        this.exactOnly = true;
        this.decodeAbort.abort();
        // Persist all remaining intake synchronously, without fingerprints.
        // The interrupted async batch cannot later migrate or overwrite it.
        const batch = [...this.pending.values()];
        this.commitBatch(batch, batch);
        resolve();
      }, 3000);
    });
    try {
      await Promise.race([deadline, (async () => {
        await this.flush();
        // A failed running batch must not block fresh observations queued
        // behind it. Drain those too, without retrying failed items in a loop.
        while (!this.exactOnly && [...this.pending.keys()].some(id => !this.retries.has(id))) await this.flush(false);
      })()]);
    } finally { clearTimeout(timer); }
  }
  private async fingerprint(sticker: Sticker | DiscoveredSticker): Promise<StickerFingerprint | undefined> {
    if (sticker.fingerprint) return sticker.fingerprint;
    if (this.fingerprints.has(sticker.id)) return this.fingerprints.get(sticker.id);
    let fingerprint: StickerFingerprint | undefined;
    try {
      if (this.decode) {
        const observation = 'image' in sticker ? sticker : { ...sticker, image: this.store.readSticker(sticker.id).image };
        fingerprint = await fingerprintSticker(observation, this.decode, this.decodeAbort.signal);
      }
    }
    catch { /* Unsupported/invalid images retain exact-hash indexing only. */ }
    if (this.exactOnly) return undefined;
    this.fingerprints.set(sticker.id, fingerprint);
    return fingerprint;
  }
  private async applyBatch(retryNow: boolean): Promise<boolean> {
    for (const id of this.itemErrors.keys()) if (!this.pending.has(id) && !this.store.state.stickers.some(s => s.id === id)) this.itemErrors.delete(id);
    if (!this.pending.size) { this.pendingOverflow = false; this.reportIssue(); return true; }
    const batch = [...this.pending.values()].filter(sticker => retryNow || (this.retries.get(sticker.id)?.after ?? 0) <= Date.now());
    if (!batch.length) return false;
    if (this.exactOnly) return this.commitBatch(batch, batch);
    const migrations = new Map<string, StickerFingerprint>();
    const observations: DiscoveredSticker[] = [];
    // Decode lazily, serially, outside Store.update. Fingerprint backfill
    // leaves controls/Forget responsive; storage migration finishes at startup.
    for (const sticker of batch) {
      if (!this.pending.has(sticker.id) || this.store.state.forgottenStickers.includes(sticker.id)) continue;
      const current = this.store.state.stickers;
      const existing = current.find(s => s.id === sticker.id);
      if (existing) { observations.push(sticker); continue; }
      const fingerprint = await this.fingerprint(sticker);
      if (this.exactOnly) return true;
      if (fingerprint) {
        for (const candidate of [...current, ...observations]) {
          const value = await this.fingerprint(candidate);
          if (this.exactOnly) return true;
          if (value && !candidate.fingerprint) migrations.set(candidate.id, value);
        }
      }
      observations.push({ ...sticker, ...(fingerprint ? { fingerprint } : {}) });
    }
    return this.commitBatch(batch, observations, migrations);
  }
  private commitBatch(batch: DiscoveredSticker[], observations: DiscoveredSticker[], migrations = new Map<string, StickerFingerprint>()): boolean {
    const permanent = new Set<string>(), transient = new Set<string>();
    const capacity = new Set<string>();
    let saved = false;
    try {
      // Use the latest state after asynchronous decoding. Forget, edits and
      // concurrent settings writes must not be overwritten by a stale snapshot.
      const eligible = observations.filter(sticker => this.pending.has(sticker.id) && !this.store.state.forgottenStickers.includes(sticker.id));
      if (eligible.length || migrations.size) this.store.update(state => {
        for (const sticker of state.stickers) {
          const fingerprint = migrations.get(sticker.id);
          if (fingerprint) sticker.fingerprint = fingerprint;
        }
        for (const sticker of eligible) {
          try {
            const size = storedSticker(sticker.image, sticker.id).bytes.length;
            const exact = state.stickers.find(s => s.id === sticker.id);
            const duplicate = !exact && sticker.fingerprint && state.stickers.find(s => {
              if (!s.fingerprint || !nearSticker(sticker.fingerprint!, s.fingerprint)) return false;
              try {
                // Includes additions in this batch, which are not in Store.state yet.
                const verified = this.store.stickerFiles.read(s.id);
                return verified.bytes.length === s.size && verified.animated === (s.kind === 'animated');
              } catch { return false; }
            });
            if (duplicate) duplicate.lastSeen = Math.max(duplicate.lastSeen, sticker.lastSeen);
            else {
              if (!exact && (state.stickers.length >= MAX_LIBRARY_STICKERS || state.stickers.reduce((total, s) => total + s.size, size) > MAX_LIBRARY_BYTES)) { capacity.add(sticker.id); permanent.add(sticker.id); continue; }
              // Blobs are durable and re-verified before the manifest references them.
              const metadata = this.store.stickerFiles.write(sticker, true);
              if (exact) { exact.size = metadata.size; exact.kind = metadata.kind; }
              upsertSticker(state.stickers, metadata);
            }
          } catch (error) {
            (error instanceof InvalidStickerError ? permanent : transient).add(sticker.id);
          }
        }
      });
      saved = true;
    } catch {
      // The manifest failed: even blobs successfully written above must stay
      // pending until their references are durably saved. Invalid items do not.
      for (const sticker of batch) if (!permanent.has(sticker.id)) transient.add(sticker.id);
    }
    for (const sticker of batch) {
      if (transient.has(sticker.id) || permanent.has(sticker.id)) this.itemErrors.set(sticker.id, capacity.has(sticker.id) ? 'Sticker library is full' : "Couldn't save new stickers");
      else this.itemErrors.delete(sticker.id);
      if (transient.has(sticker.id)) {
        if (!this.pending.has(sticker.id)) continue;
        const attempts = (this.retries.get(sticker.id)?.attempts ?? 0) + 1;
        this.retries.set(sticker.id, { attempts, after: attempts >= 5 ? Infinity : Date.now() + 1000 * 2 ** (attempts - 1) });
      } else if (this.pending.get(sticker.id) === sticker) this.removePending(sticker.id);
    }
    // Cache only surviving library entries (including failed decodes).
    const ids = new Set(this.store.state.stickers.map(s => s.id));
    for (const id of this.fingerprints.keys()) if (!ids.has(id)) this.fingerprints.delete(id);
    this.pendingOverflow = false;
    this.reportIssue();
    if (saved && (observations.length || migrations.size)) this.changed();
    return saved && !transient.size;
  }
}
