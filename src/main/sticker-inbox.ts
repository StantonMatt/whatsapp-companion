import type { Sticker } from '../shared/model';
import { upsertSticker } from '../core/stickers';
import type { Store } from './store';

// Coalesce discovery into bounded transactions instead of copying/fsyncing the library per image.
export class StickerInbox {
  private pending = new Map<string, Sticker>();
  private bytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private store: Store, private changed: () => void, private failed: () => void) {}
  discard(id: string) { this.bytes -= this.pending.get(id)?.image.length ?? 0; this.pending.delete(id); }
  add(sticker: Sticker) {
    if (this.bytes + sticker.image.length > 5_000_000 && !this.flush()) return;
    this.bytes -= this.pending.get(sticker.id)?.image.length ?? 0;
    this.pending.set(sticker.id, sticker); this.bytes += sticker.image.length;
    this.timer ??= setTimeout(() => { this.flush(); }, 500);
  }
  flush(): boolean {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.pending.size) return true;
    const current = this.store.state.stickers;
    let remaining = 50_000_000 - current.reduce((total, s) => total + s.image.length, 0);
    let slots = 2000 - current.length;
    const ids = new Set(current.map(s => s.id));
    const batch = [...this.pending.values()].filter(sticker => {
      if (ids.has(sticker.id)) return true;
      if (slots <= 0 || sticker.image.length > remaining) return false;
      slots--; remaining -= sticker.image.length; return true;
    });
    try {
      if (batch.length) this.store.update(s => { for (const sticker of batch) upsertSticker(s.stickers, sticker); });
      this.pending.clear(); this.bytes = 0;
      if (batch.length) this.changed();
      return true;
    } catch { this.failed(); return false; }
  }
}
