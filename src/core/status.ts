import type { State, Status, StatusUpdate } from '../shared/model';

export function statusUpdate(status: Status, previous?: State): StatusUpdate {
  if (!previous) return status;
  const { state, ...transient } = status;
  if (state === previous) return transient;
  const { stickers, ...settings } = state;
  const old = new Map(previous.stickers.map(s => [s.id, s]));
  const upsert = stickers.filter(s => {
    const before = old.get(s.id); old.delete(s.id);
    return !before || s.image !== before.image || s.searchTerms !== before.searchTerms || s.lastSeen !== before.lastSeen || s.firstSeen !== before.firstSeen
      || s.fingerprint?.hash !== before.fingerprint?.hash || s.fingerprint?.pixels !== before.fingerprint?.pixels || s.fingerprint?.animated !== before.fingerprint?.animated;
  });
  const removed = [...old.keys()];
  return { ...transient, state: settings, ...(upsert.length || removed.length ? { stickerChanges: { upsert, removed } } : {}) };
}

// IPC carries the durable state only when it changes; subscribers still receive a complete snapshot.
export class StatusCache {
  private current?: Status;
  private pending: StatusUpdate[] = [];
  accept(update: StatusUpdate): Status | undefined {
    const complete = update.state && 'stickers' in update.state;
    if (!this.current && !complete) {
      this.pending.push(update);
      return undefined;
    }
    if (complete) {
      if (!this.current || update.sequence >= this.current.sequence) this.current = update as Status;
      const pending = this.pending; this.pending = [];
      pending.sort((a, b) => a.sequence - b.sequence).forEach(next => this.accept(next));
    } else if (this.current && update.sequence >= this.current.sequence) {
      const { state, stickerChanges, ...transient } = update;
      let next = state ? { ...state, stickers: this.current.state.stickers } : this.current.state;
      if (stickerChanges) {
        const stickers = new Map(next.stickers.map(s => [s.id, s]));
        stickerChanges.removed.forEach(id => stickers.delete(id));
        stickerChanges.upsert.forEach(s => stickers.set(s.id, s));
        next = { ...next, stickers: [...stickers.values()] };
      }
      this.current = { ...this.current, ...transient, state: next };
    }
    return this.current;
  }
}
