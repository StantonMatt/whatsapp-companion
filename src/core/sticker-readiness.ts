import type { Snapshot } from '../shared/model';

const SETTLING_MS = 800;

/** Presentation only: an owned maker may temporarily remove the composer.
 * Send authorization must always use the original, unsmoothed snapshot. */
export class StickerReadiness {
  private destination?: Snapshot;
  private owner?: string;
  private settlingUntil = 0;
  get settlingDeadline() { return this.settlingUntil; }
  present(snapshot: Snapshot, owner: string | undefined, now = Date.now()): Snapshot {
    const previous = this.destination;
    const same = snapshot.conversationOpen && previous && previous.chatId === snapshot.chatId && previous.name === snapshot.name &&
      (snapshot.settingsId === undefined || previous.settingsId === undefined || previous.settingsId === snapshot.settingsId) &&
      (snapshot.chatId != null || snapshot.messages.some(message => previous.messages.some(old => old.id === message.id)));
    if (!same) { this.owner = undefined; this.settlingUntil = 0; this.destination = snapshot.conversationOpen && snapshot.ready ? snapshot : undefined; return snapshot; }
    if (owner) { this.owner = owner; this.settlingUntil = 0; }
    else if (this.owner) { this.owner = undefined; this.settlingUntil = now + SETTLING_MS; }
    if (now >= this.settlingUntil) this.settlingUntil = 0;
    if (snapshot.ready) this.destination = { ...snapshot, settingsId: snapshot.settingsId === undefined ? previous.settingsId : snapshot.settingsId };
    if (!snapshot.ready && (owner || now < this.settlingUntil)) return { ...snapshot, ready: true, settingsId: snapshot.settingsId === undefined ? previous.settingsId : snapshot.settingsId };
    return snapshot;
  }
}
