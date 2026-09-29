import type { Snapshot } from '../shared/model';
import { sameStickerChat, type StickerPreview, type StickerTicket } from '../shared/sticker-transfer';

// Manual sending has its own one-use permission. Model output, incoming content,
// finding a sticker, and dropping it can never grant permission to click Send.
export class StickerTransfer {
  preview: StickerPreview | null = null;
  private ticket?: StickerTicket & { scope: string; expires: number };
  private authorized = false;
  begin(id: string, nonce: string, snapshot: Snapshot, now = Date.now()) {
    this.cancel();
    const scope = snapshot.settingsId ?? snapshot.chatId;
    if (!snapshot.ready || snapshot.composing || !scope) throw new Error('Open a conversation before dragging a sticker.');
    this.ticket = { id, nonce, scope, expires: now + 30_000, target: { name: snapshot.name, chatId: snapshot.chatId, revision: snapshot.revision } };
    return this.ticket;
  }
  private current(snapshot: Snapshot, now: number) {
    return this.ticket && now < this.ticket.expires && sameStickerChat(this.ticket.target, snapshot) && this.ticket.scope === (snapshot.settingsId ?? snapshot.chatId);
  }
  drop(nonce: string, snapshot: Snapshot, now = Date.now()): StickerTicket | undefined {
    if (this.preview || this.ticket?.nonce !== nonce || !this.current(snapshot, now)) return;
    this.ticket.expires = now + 5 * 60_000;
    this.preview = { id: this.ticket.id, nonce, name: this.ticket.target.name, state: 'finding' };
    return this.ticket;
  }
  prepared(nonce: string, found: boolean, snapshot: Snapshot, now = Date.now()) {
    if (this.preview?.nonce !== nonce || this.preview.state !== 'finding' || !this.current(snapshot, now)) return;
    this.preview = { ...this.preview, state: found ? 'ready' : 'missing' };
  }
  confirm(nonce: string, snapshot: Snapshot, now = Date.now()): StickerTicket {
    if (this.preview?.nonce !== nonce || this.preview.state !== 'ready' || !this.current(snapshot, now)) throw new Error('This sticker preview is no longer current. Drag the sticker into the chat again.');
    this.preview = { ...this.preview, state: 'sending' };
    this.ticket!.expires = Math.min(this.ticket!.expires, now + 5000);
    return this.ticket!;
  }
  authorize(nonce: string, snapshot: Snapshot, now = Date.now()): boolean {
    if (this.authorized || this.preview?.nonce !== nonce || this.preview.state !== 'sending' || !this.current(snapshot, now)) return false;
    this.authorized = true; return true;
  }
  result(nonce: string, clicked: boolean) {
    if (this.preview?.nonce !== nonce || this.preview.state !== 'sending') return;
    if (clicked) this.cancel(); else { this.preview = { ...this.preview, state: 'failed' }; this.ticket = undefined; }
  }
  observe(snapshot: Snapshot, now = Date.now()) {
    if (this.ticket && !this.current(snapshot, now)) { this.cancel(); return true; }
    return false;
  }
  cancel() { this.ticket = undefined; this.preview = null; this.authorized = false; }
}
