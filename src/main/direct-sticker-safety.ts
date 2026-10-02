import type { DirectStickerDisabledReason, Preferences, Scope, State } from '../shared/model';
import { resetPreferences, setPreferences, stopDirectStickerSending } from '../core/settings';
import type { StickerTransfer } from '../core/sticker-transfer';
import type { Store } from './store';

// Permission revocation belongs to main and must take effect before any disk write.
export class DirectStickerSafety {
  private stopped?: Pick<State['global'], 'directStickerSend' | 'directStickerDisabledReason' | 'directStickerDisabledAt'>;
  private projected?: { source: State; state: State };
  constructor(private store: Pick<Store, 'state' | 'update'>, private transfer: StickerTransfer, private saveFailed: () => void) {}

  enabled() { return !this.stopped && this.store.state.global.directStickerSend; }

  // Settings must reflect the session stop even when the durable state still enables it.
  state(): State {
    if (!this.stopped) return this.store.state;
    if (this.projected?.source !== this.store.state) {
      this.projected = { source: this.store.state, state: { ...this.store.state, global: { ...this.store.state.global, ...this.stopped } } };
    }
    return this.projected!.state;
  }

  private latch(reason = this.state().global.directStickerDisabledReason, at = this.state().global.directStickerDisabledAt) {
    if (!this.stopped) {
      this.stopped = { directStickerSend: false, directStickerDisabledReason: reason, directStickerDisabledAt: at };
      this.projected = undefined;
    }
    const send = this.transfer.send;
    if (send?.route === 'direct' && send.state === 'preparing') this.transfer.directResult(send.nonce, 'not-sent');
  }

  stop(reason: DirectStickerDisabledReason, at = Date.now()) {
    if (!this.enabled()) return;
    this.latch(reason, at);
    try { this.store.update(s => stopDirectStickerSending(s, reason, at)); }
    catch { this.saveFailed(); } // Keep the stop and its first reason for this session.
  }

  preferences(scope: Scope, patch: Partial<Preferences>) {
    if (scope === 'global' && patch.directStickerSend === false) this.latch();
    try { this.store.update(s => setPreferences(s, scope, patch)); }
    catch (error) {
      if (scope === 'global' && patch.directStickerSend === false) this.saveFailed();
      throw error;
    }
    // A failed enable, unrelated edits, and resets cannot clear a safety stop.
    if (scope === 'global' && patch.directStickerSend === true) {
      this.stopped = undefined; this.projected = undefined;
    }
  }

  reset(scope: Scope) {
    if (scope === 'global') this.latch();
    try { this.store.update(s => resetPreferences(s, scope)); }
    catch (error) {
      if (scope === 'global') this.saveFailed();
      throw error;
    }
  }
}
