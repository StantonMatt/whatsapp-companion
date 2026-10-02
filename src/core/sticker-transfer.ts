import type { Snapshot } from '../shared/model';
import { sameStickerChat, type StickerSend, type StickerTicket } from '../shared/sticker-transfer';

// Only a validated action from the trusted local Send button creates permission.
// Lookup consumes that click's ticket; it cannot create permission of its own.
export class StickerTransfer {
  send: StickerSend | null = null;
  private ticket?: StickerTicket & { scope: string; destinationToken: string; expires: number };
  private authorized = false;
  private usedNonces = new Set<string>();
  private destinationIdentity?: string;
  private destinationRevision = 0;
  destinationToken(snapshot: Snapshot): string {
    const identity = JSON.stringify([snapshot.chatId, snapshot.settingsId ?? snapshot.chatId, snapshot.name, snapshot.revision, snapshot.ready, snapshot.composing]);
    if (identity !== this.destinationIdentity) {
      this.destinationIdentity = identity;
      this.destinationRevision++;
    }
    return String(this.destinationRevision);
  }
  requireDestination(token: string, snapshot: Snapshot) {
    if (token !== this.destinationToken(snapshot)) throw new Error('This conversation changed. Choose the sticker action again.');
  }
  begin(id: string, nonce: string, destinationToken: string, snapshot: Snapshot, now = Date.now()): StickerTicket {
    this.requireDestination(destinationToken, snapshot);
    if (this.send?.state === 'finding' || this.send?.state === 'sending') throw new Error('Wait for the current sticker.');
    if (this.usedNonces.has(nonce)) throw new Error('This sticker send has already been used.');
    const scope = snapshot.settingsId ?? snapshot.chatId;
    if (!snapshot.ready || snapshot.composing || !scope) throw new Error('Open a conversation before sending a sticker.');
    this.usedNonces.add(nonce);
    this.authorized = false;
    this.ticket = { id, nonce, scope, destinationToken, expires: now + 60_000, target: { name: snapshot.name, chatId: snapshot.chatId, revision: snapshot.revision } };
    this.send = { id, nonce, name: snapshot.name, state: 'finding' };
    return this.ticket;
  }
  private sameTarget(snapshot: Snapshot) {
    return this.ticket && this.ticket.destinationToken === this.destinationToken(snapshot) && sameStickerChat(this.ticket.target, snapshot) && this.ticket.scope === (snapshot.settingsId ?? snapshot.chatId);
  }
  private current(snapshot: Snapshot, now: number) {
    return this.ticket && now < this.ticket.expires && this.sameTarget(snapshot);
  }
  prepared(nonce: string, found: boolean, snapshot: Snapshot, now = Date.now()): StickerTicket | undefined {
    if (this.send?.nonce !== nonce || this.send.state !== 'finding') return;
    if (this.observe(snapshot, now)) return;
    if (!found) { this.finish('missing'); return; }
    this.send = { ...this.send, state: 'sending' };
    this.ticket!.expires = now + 5000;
    return this.ticket;
  }
  authorize(nonce: string, snapshot: Snapshot, now = Date.now()): boolean {
    if (this.authorized || this.send?.nonce !== nonce || this.send.state !== 'sending' || !this.current(snapshot, now)) return false;
    this.authorized = true; return true;
  }
  result(nonce: string, clicked: boolean) {
    if (this.send?.nonce !== nonce || this.send.state !== 'sending') return;
    this.finish(clicked && this.authorized ? 'sent' : 'failed');
  }
  timeout(nonce: string) {
    if (this.send?.nonce !== nonce || this.send.state !== 'finding') return false;
    this.finish('missing'); return true;
  }
  observe(snapshot: Snapshot, now = Date.now()) {
    this.destinationToken(snapshot);
    if (this.send?.state !== 'finding') return false;
    if (!this.sameTarget(snapshot)) return this.cancel('chat-changed');
    if (!this.current(snapshot, now)) return this.timeout(this.send.nonce);
    return false;
  }
  cancel(reason?: 'chat-changed') {
    if (this.send?.state !== 'finding') return false;
    this.send = { ...this.send, state: 'cancelled', ...(reason ? { reason } : {}) };
    this.ticket = undefined; this.authorized = false;
    return true;
  }
  private finish(state: 'sent' | 'failed' | 'missing') {
    this.send = { ...this.send!, state };
    this.ticket = undefined; this.authorized = false;
  }
}
