import type { Sticker } from '../shared/model';
import { upsertSticker } from '../core/stickers';
import { fingerprintSticker, nearSticker, type StickerFingerprint, type StickerPixels } from './sticker-fingerprint';
import type { Store } from './store';

// Coalesce discovery into bounded transactions instead of copying/fsyncing the library per image.
export class StickerInbox {
  private pending = new Map<string, Sticker>();
  private bytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private flushing?: Promise<boolean>;
  private closed = false;
  private closing?: Promise<void>;
  private exactOnly = false;
  private decodeAbort = new AbortController();
  // Includes decode failures so an unsupported old image is tried only once per
  // session. At most the current library and bounded pending batch are cached.
  private fingerprints = new Map<string, StickerFingerprint | undefined>();
  constructor(private store: Store, private changed: () => void, private failed: () => void, private decode?: StickerPixels) {}
  discard(id: string) {
    this.removePending(id);
    this.fingerprints.delete(id);
  }
  private removePending(id: string) {
    this.bytes -= this.pending.get(id)?.image.length ?? 0; this.pending.delete(id);
  }
  add(sticker: Sticker) {
    if (this.closed || this.store.state.forgottenStickers.includes(sticker.id)) return;
    const bytes = this.bytes - (this.pending.get(sticker.id)?.image.length ?? 0) + sticker.image.length;
    // Async decoding cannot synchronously empty a 5 MB batch like the previous
    // inbox. Retain a discovery burst up to the library's existing size/count
    // limits so emitted sources aren't lost while legacy images are decoded.
    if (bytes > 50_000_000 || (!this.pending.has(sticker.id) && this.pending.size >= 2000)) { void this.flush(); return; }
    // Fingerprints are main-owned, never accepted from discovery input.
    const { fingerprint: _ignored, ...observation } = sticker;
    this.pending.set(sticker.id, observation); this.bytes = bytes;
    this.schedule();
  }
  private schedule() { this.timer ??= setTimeout(() => { void this.flush(); }, 500); }
  flush(): Promise<boolean> {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.flushing) return this.flushing;
    this.flushing = this.applyBatch().finally(() => { this.flushing = undefined; });
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
        // A running batch may have observations queued behind it.
        do { if (!await this.flush() || this.exactOnly) break; } while (this.pending.size);
      })()]);
    } finally { clearTimeout(timer); }
  }
  private async fingerprint(sticker: Sticker): Promise<StickerFingerprint | undefined> {
    if (sticker.fingerprint) return sticker.fingerprint;
    if (this.fingerprints.has(sticker.id)) return this.fingerprints.get(sticker.id);
    let fingerprint: StickerFingerprint | undefined;
    try { if (this.decode) fingerprint = await fingerprintSticker(sticker, this.decode, this.decodeAbort.signal); }
    catch { /* Unsupported/invalid images retain exact-hash indexing only. */ }
    if (this.exactOnly) return undefined;
    this.fingerprints.set(sticker.id, fingerprint);
    return fingerprint;
  }
  private async applyBatch(): Promise<boolean> {
    if (!this.pending.size) return true;
    const batch = [...this.pending.values()];
    if (this.exactOnly) return this.commitBatch(batch, batch);
    const migrations = new Map<string, StickerFingerprint>();
    const observations: Sticker[] = [];
    // Decode lazily, serially, outside Store.update. Startup never walks images,
    // and controls/Forget remain responsive while a legacy library migrates.
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
  private commitBatch(batch: Sticker[], observations: Sticker[], migrations = new Map<string, StickerFingerprint>()): boolean {
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
          const exact = state.stickers.find(s => s.id === sticker.id);
          const duplicate = !exact && sticker.fingerprint && state.stickers.find(s => s.fingerprint && nearSticker(sticker.fingerprint!, s.fingerprint));
          if (duplicate) duplicate.lastSeen = Math.max(duplicate.lastSeen, sticker.lastSeen);
          else upsertSticker(state.stickers, sticker);
        }
      });
      for (const sticker of batch) {
        if (this.pending.get(sticker.id) === sticker) this.removePending(sticker.id);
      }
      // Cache only surviving library entries (including failed decodes).
      const ids = new Set(this.store.state.stickers.map(s => s.id));
      for (const id of this.fingerprints.keys()) if (!ids.has(id)) this.fingerprints.delete(id);
      if (eligible.length || migrations.size) this.changed();
      if (this.pending.size && !this.closed) this.schedule();
      return true;
    } catch { this.failed(); return false; }
  }
}
