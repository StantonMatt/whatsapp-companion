import type { State, Status, StatusUpdate, ControlsState } from '../shared/model';

const projections = new WeakMap<State, ControlsState>();
function controlsState(state: State): ControlsState {
  let projected = projections.get(state);
  if (!projected) {
    const { conversations: _anchors, ledger: _ledger, forgottenStickers: _forgotten, stickers, ...settings } = state;
    projected = { ...settings, hasForgotten: _forgotten.length > 0, stickers: stickers.map(({ fingerprint: _fingerprint, ...sticker }) => sticker) };
    projections.set(state, projected);
  }
  return projected;
}
const equal = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export function statusUpdate(status: Status, previous?: State, previousStatus?: Status): StatusUpdate {
  const { state, sequence, stickerShield, stickerTags, ...transient } = status;
  const update: StatusUpdate = { sequence };
  for (const key of Object.keys(transient) as (keyof typeof transient)[]) {
    if (!previousStatus || !equal(transient[key], previousStatus[key])) Object.assign(update, { [key]: transient[key] });
  }
  if (!previousStatus) update.stickerTags = stickerTags;
  else {
    const before = previousStatus.stickerTags ?? {}, after = stickerTags ?? {};
    const upsert = Object.fromEntries(Object.entries(after).filter(([id, item]) => !equal(item, before[id])));
    const removed = Object.keys(before).filter(id => !after[id]);
    if (Object.keys(upsert).length || removed.length) update.stickerTagChanges = { upsert, removed };
  }
  const oldShield = previousStatus?.stickerShield;
  const sameShield = stickerShield === oldShield || (stickerShield && oldShield &&
    stickerShield.nonce === oldShield.nonce && stickerShield.image === oldShield.image &&
    equal(stickerShield.bounds, oldShield.bounds) && equal(stickerShield.panel, oldShield.panel));
  if (!previousStatus || !sameShield) {
    if (stickerShield && oldShield?.nonce === stickerShield.nonce && oldShield.image === stickerShield.image) {
      const { image: _image, ...shield } = stickerShield; update.stickerShield = shield;
    } else update.stickerShield = stickerShield;
  }
  if (!previous) { update.state = controlsState(state); return update; }
  if (state === previous) return update;
  const { stickers, ...settings } = controlsState(state), { stickers: oldStickers, ...oldSettings } = controlsState(previous);
  const settingsChanges: Partial<ControlsState> = {};
  for (const key of Object.keys(settings) as (keyof typeof settings)[]) {
    if (!equal(settings[key], oldSettings[key])) Object.assign(settingsChanges, { [key]: settings[key] });
  }
  if (Object.keys(settingsChanges).length) update.state = settingsChanges;
  const old = new Map(oldStickers.map(s => [s.id, s]));
  const upsert = stickers.filter(s => {
    const before = old.get(s.id); old.delete(s.id);
    return !before || s.kind !== before.kind || s.size !== before.size || s.searchTerms !== before.searchTerms ||
      s.firstSeen !== before.firstSeen || s.lastSeen !== before.lastSeen || s.groups.length !== before.groups.length ||
      s.groups.some((id, index) => id !== before.groups[index]);
  });
  const removed = [...old.keys()];
  if (upsert.length || removed.length) update.stickerChanges = { upsert, removed };
  return update;
}

// History belongs to the current controls consumer, including its shield image.
// A new consumer must receive a complete status before any smaller deltas.
export class StatusPublisher {
  private previous?: Status;
  constructor(private readonly deliver: (update: StatusUpdate) => void) {}
  reset() { this.previous = undefined; }
  next(status: Status): StatusUpdate | undefined {
    const update = statusUpdate(status, this.previous?.state, this.previous);
    if (Object.keys(update).length <= 1) return undefined;
    // Suppressed updates and one-shot statusUpdate reads cannot establish
    // history. A failed send also leaves the consumer's baseline intact.
    this.deliver(update);
    this.previous = status;
    return update;
  }
}

// Reconstruct the legacy UI shape locally; its main-only fields are empty.
// This keeps existing controls helpers working without sending private records.
export class StatusCache {
  private current?: Status;
  private pending: StatusUpdate[] = [];
  accept(update: StatusUpdate): Status | undefined {
    const complete = update.state && 'stickers' in update.state;
    if (!this.current && !complete) { this.pending.push(update); return undefined; }
    if (complete) {
      if (!this.current || update.sequence >= this.current.sequence) {
        // Unprojected complete statuses are accepted for local callers as well.
        const state = update.state as State;
        const reconstructed = 'ledger' in state ? state : { ...update.state, conversations: {}, ledger: {}, forgottenStickers: [] } as State;
        this.current = { ...update, state: reconstructed } as Status;
      }
      const pending = this.pending; this.pending = [];
      pending.sort((a, b) => a.sequence - b.sequence).forEach(next => this.accept(next));
    } else if (this.current && update.sequence >= this.current.sequence) {
      const { state, stickerChanges, stickerShield, stickerTagChanges, ...transient } = update;
      let next = state ? { ...this.current.state, ...state } : this.current.state;
      if (stickerChanges) {
        const stickers = new Map(next.stickers.map(s => [s.id, s]));
        stickerChanges.removed.forEach(id => stickers.delete(id));
        stickerChanges.upsert.forEach(s => stickers.set(s.id, s));
        next = { ...next, stickers: [...stickers.values()] };
      }
      const shield = stickerShield === undefined ? this.current.stickerShield : stickerShield === null ? null :
        stickerShield.image !== undefined ? stickerShield as Status['stickerShield'] :
          this.current.stickerShield?.nonce === stickerShield.nonce ? { ...this.current.stickerShield, ...stickerShield } : null;
      const tags = { ...(transient.stickerTags ?? this.current.stickerTags ?? {}) };
      if (stickerTagChanges) {
        stickerTagChanges.removed.forEach(id => delete tags[id]); Object.assign(tags, stickerTagChanges.upsert);
      }
      this.current = { ...this.current, ...transient, state: next, stickerShield: shield, ...(stickerTagChanges ? { stickerTags: tags } : {}) };
    }
    return this.current;
  }
}
