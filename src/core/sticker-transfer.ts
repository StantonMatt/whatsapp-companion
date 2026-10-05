import type { Snapshot } from '../shared/model';
import type { DirectDestination } from '../shared/direct-sticker';
import { matchesDirectDestination } from '../shared/direct-sticker';
import { STICKER_PICKER_WATCHDOG_MS, sameStickerChat, sameStickerPreparation, type StickerSend, type StickerTicket, type StickerRoute, type StickerReason, type StickerMakerDetail, type StickerSendOutcome, type StickerSendBlockedReason } from '../shared/sticker-transfer';

export const canSendSticker = (snapshot: Snapshot) => Boolean(snapshot.conversationOpen && snapshot.name && (snapshot.settingsId ?? snapshot.chatId));
export const composerProvablyEmpty = (snapshot: Snapshot) => snapshot.conversationOpen && snapshot.ready && !snapshot.composing && !snapshot.draftIssue && snapshot.draft === '';
export const stickerRoute = (snapshot: Snapshot, animated: boolean, still?: true, direct = false): StickerRoute =>
  direct ? 'direct' : (animated && !still) || (!still && !composerProvablyEmpty(snapshot)) ? 'picker' : 'maker';

// Only a validated action from the trusted local Send button creates permission.
// Lookup consumes that click's ticket; it cannot create permission of its own.
export class StickerTransfer {
  send: StickerSend | null = null;
  private ticket?: StickerTicket & { scope: string; destinationToken: string; expires: number };
  private authorized = false;
  private pickerQueued = false;
  private disclosed = false;
  private usedNonces = new Set<string>();
  private destinationIdentity?: string;
  private destinationRevision = 0;
  blockedReason(snapshot: Snapshot, cleaning = false): StickerSendBlockedReason | undefined {
    if (cleaning || this.send?.state === 'finding' || this.send?.state === 'preparing' || this.send?.state === 'sending') return 'busy';
    if (!canSendSticker(snapshot)) return 'no-chat';
  }
  destinationToken(snapshot: Snapshot): string {
    if (this.send?.state === 'preparing' && this.disclosed && this.ticket && sameStickerPreparation(this.ticket, snapshot) && this.ticket.scope === (snapshot.settingsId ?? snapshot.chatId)) return this.ticket.destinationToken;
    const identity = JSON.stringify([snapshot.chatId, snapshot.settingsId ?? snapshot.chatId, snapshot.name, snapshot.revision, snapshot.conversationOpen, snapshot.ready, snapshot.composing]);
    if (identity !== this.destinationIdentity) {
      this.destinationIdentity = identity;
      this.destinationRevision++;
    }
    return String(this.destinationRevision);
  }
  requireDestination(token: string, snapshot: Snapshot) {
    if (token !== this.destinationToken(snapshot)) throw new Error('This conversation changed. Choose the sticker action again.');
  }
  begin(id: string, nonce: string, destinationToken: string, snapshot: Snapshot, now = Date.now(), route: StickerRoute = 'picker', animated = true): StickerTicket {
    this.requireDestination(destinationToken, snapshot);
    if (this.blockedReason(snapshot) === 'busy') throw new Error('Wait for the current sticker.');
    if (this.usedNonces.has(nonce)) throw new Error('This sticker send has already been used.');
    const scope = snapshot.settingsId ?? snapshot.chatId;
    if (!scope || !canSendSticker(snapshot)) throw new Error('Open a conversation before sending a sticker.');
    this.usedNonces.add(nonce);
    this.authorized = false; this.disclosed = false; this.pickerQueued = false;
    this.ticket = { id, nonce, scope, destinationToken, expires: now + (route === 'picker' ? STICKER_PICKER_WATCHDOG_MS : 60_000), route, target: { name: snapshot.name, chatId: snapshot.chatId, revision: snapshot.revision } };
    this.send = { id, nonce, name: snapshot.name, route, animated, state: route === 'picker' ? 'finding' : 'preparing' };
    const ticket = this.ticket;
    if (route === 'maker' && !composerProvablyEmpty(snapshot)) this.finish('failed', 'draft', 'draft-present', 'not-sent');
    return ticket;
  }
  private sameTarget(snapshot: Snapshot) {
    return this.ticket && this.ticket.destinationToken === this.destinationToken(snapshot) && (sameStickerChat(this.ticket.target, snapshot) || (this.disclosed && this.send?.state === 'preparing' && sameStickerPreparation(this.ticket, snapshot))) && this.ticket.scope === (snapshot.settingsId ?? snapshot.chatId);
  }
  private current(snapshot: Snapshot, now: number) {
    return this.ticket && now < this.ticket.expires && this.sameTarget(snapshot);
  }
  directCurrent(nonce: string, snapshot: Snapshot, enabled: boolean, now = Date.now()) {
    return enabled && this.send?.route === 'direct' && this.send.nonce === nonce &&
      this.send.state === 'preparing' && !this.authorized && Boolean(this.current(snapshot, now));
  }
  bindDirect(nonce: string, destination: DirectDestination, snapshot: Snapshot, enabled: boolean, now = Date.now()) {
    if (!this.directCurrent(nonce, snapshot, enabled, now) || !matchesDirectDestination(destination, snapshot)) return false;
    this.ticket!.directDestination = { ...destination }; return true;
  }
  attemptDirect(nonce: string, snapshot: Snapshot, enabled: boolean, now = Date.now()) {
    if (!this.directCurrent(nonce, snapshot, enabled, now) || !this.ticket?.directDestination ||
      !matchesDirectDestination(this.ticket.directDestination, snapshot)) return;
    // Consume the only attempt before executeJavaScript, including timeout/failure.
    this.authorized = true;
    this.send = { ...this.send!, state: 'sending' };
    return { ...this.ticket, directDestination: { ...this.ticket.directDestination } };
  }
  fallbackDirect(nonce: string, snapshot: Snapshot, route: 'maker' | 'picker', now = Date.now()) {
    if (this.send?.nonce !== nonce || this.send.route !== 'direct' || !this.ticket || !this.current(snapshot, now)) return;
    // Caller may release the consumed grant only for a validated pre-upload
    // unavailable result. Never reset the nonce's one-use click latch.
    this.authorized = false; this.ticket.directDestination = undefined;
    this.ticket.route = route; this.ticket.expires = now + (route === 'picker' ? STICKER_PICKER_WATCHDOG_MS : 60_000);
    this.send = { ...this.send, route, state: route === 'picker' ? 'finding' : 'preparing' };
    if (route === 'maker' && !composerProvablyEmpty(snapshot)) { this.finish('failed', 'draft', 'draft-present', 'not-sent'); return; }
    return this.ticket;
  }
  directResult(nonce: string, outcome: StickerSendOutcome, reason?: StickerReason) {
    if (this.send?.nonce !== nonce || this.send.route !== 'direct' || !['preparing', 'sending'].includes(this.send.state)) return;
    const confirmed = outcome === 'confirmed' && this.authorized;
    this.finish(confirmed ? 'sent' : 'failed', confirmed ? undefined : reason ?? 'unconfirmed', undefined,
      outcome === 'confirmed' && !confirmed ? 'unknown' : outcome);
  }
  prepared(nonce: string, found: boolean, snapshot: Snapshot, now = Date.now()): StickerTicket | undefined {
    if (this.send?.nonce !== nonce || this.send.state !== 'finding') return;
    if (this.observe(snapshot, now)) return;
    if (!found) { this.pickerMiss(); return; }
    this.send = { ...this.send, state: 'sending' };
    this.ticket!.expires = now + 5000;
    return this.ticket;
  }
  ownsPreparation(snapshot: Snapshot) {
    return Boolean(this.ticket && this.disclosed && this.send?.state === 'preparing' && sameStickerPreparation(this.ticket, snapshot));
  }
  queuePickerSend(nonce: string) {
    if (this.send?.nonce !== nonce || this.send.route !== 'picker' || this.send.state !== 'sending' || !this.ticket || this.pickerQueued) return false;
    // The user-issued command crosses the cancellation boundary before IPC,
    // even if the remote holds it before requesting the final grant.
    this.pickerQueued = true;
    return true;
  }
  pickerSendQueued(nonce: string) {
    return this.send?.nonce === nonce && this.send.route === 'picker' && this.send.state === 'sending' && this.pickerQueued;
  }
  ownsMaker(snapshot: Snapshot) {
    return Boolean(this.ticket && this.disclosed && this.send?.route === 'maker' &&
      (this.send.state === 'preparing' || this.send.state === 'sending') && sameStickerPreparation(this.ticket, snapshot));
  }
  disclose(nonce: string, snapshot: Snapshot, now = Date.now()): boolean {
    if (this.disclosed || this.send?.nonce !== nonce || this.send.state !== 'preparing' || !this.current(snapshot, now)) return false;
    if (!composerProvablyEmpty(snapshot)) { this.finish('failed', 'draft', 'draft-appeared', 'not-sent'); return false; }
    this.disclosed = true; return true;
  }
  clicked(nonce: string) {
    if (this.send?.nonce === nonce && this.send.state === 'preparing' && this.authorized) this.send = { ...this.send, state: 'sending' };
  }
  authorize(nonce: string, snapshot: Snapshot, now = Date.now()): boolean {
    if (this.send?.route === 'direct' || this.authorized || this.send?.nonce !== nonce || (this.send.state !== 'sending' && this.send.state !== 'preparing') || !this.current(snapshot, now)) return false;
    if (this.send.route === 'maker' && (snapshot.draft !== '' || snapshot.draftIssue || snapshot.composing)) {
      this.finish('failed', 'draft', 'draft-appeared', 'not-sent'); return false;
    }
    if (this.send.state === 'preparing' && (!this.disclosed || !sameStickerPreparation(this.ticket!, snapshot))) return false;
    // The remote can activate Send as soon as this grant leaves main. Its
    // clicked notification may arrive after a cancellation or never arrive.
    this.authorized = true;
    this.send = { ...this.send, state: 'sending' };
    return true;
  }
  result(nonce: string, clicked: boolean, confirmed?: boolean, reason?: StickerReason, detail?: StickerMakerDetail) {
    if (this.send?.route === 'direct' || this.send?.nonce !== nonce) return;
    const outcome: StickerSendOutcome = !clicked ? 'not-sent' : reason === 'draft' && detail === 'draft-appeared' ? 'unknown' : confirmed === true ? 'confirmed' : 'unknown';
    if (this.send.state !== 'sending' && this.send.state !== 'preparing') return;
    const sent = outcome === 'confirmed' && this.authorized && reason !== 'draft';
    this.finish(sent ? 'sent' : 'failed', sent ? undefined : reason ?? (this.send.route === 'maker' ? clicked ? 'unconfirmed' : 'editor-unavailable' : 'unconfirmed'), sent ? undefined : detail, outcome);
  }
  timeout(nonce: string) {
    if (this.send?.nonce !== nonce || (this.send.state !== 'finding' && this.send.state !== 'preparing')) return false;
    if (this.send.route === 'direct') this.directResult(nonce, 'not-sent');
    else if (this.send.route === 'picker') this.pickerMiss();
    else this.finish('failed', 'editor-unavailable', 'preparation-timeout', 'not-sent');
    return true;
  }
  private pickerMiss() {
    if (this.send?.animated === false) this.finish('failed', 'draft', 'draft-present', 'not-sent');
    else this.finish('missing');
  }
  observe(snapshot: Snapshot, now = Date.now()) {
    this.destinationToken(snapshot);
    if (this.send?.state !== 'finding' && this.send?.state !== 'preparing') return false;
    if (this.send.route === 'maker' && this.ticket && this.ticket.target.chatId === snapshot.chatId && this.ticket.target.name === snapshot.name &&
      this.ticket.scope === (snapshot.settingsId ?? snapshot.chatId) && (snapshot.draft !== '' || snapshot.draftIssue || snapshot.composing)) {
      this.finish('failed', 'draft', 'draft-appeared', 'not-sent'); return true;
    }
    if (!this.sameTarget(snapshot)) return this.cancel('chat-changed');
    if (!this.current(snapshot, now)) return this.timeout(this.send.nonce);
    return false;
  }
  cancel(reason?: 'chat-changed', detail?: StickerMakerDetail) {
    if (this.send?.state !== 'finding' && this.send?.state !== 'preparing') return false;
    const diagnostic = detail ?? (this.send.route === 'maker' ? reason ?? 'cancelled' : undefined);
    this.send = { ...this.send, state: 'cancelled', ...(reason ? { reason } : {}), ...(diagnostic ? { detail: diagnostic } : {}) };
    this.ticket = undefined; this.authorized = false;
    return true;
  }
  revokeIfNotAuthorized() {
    if (this.authorized || this.pickerQueued) return false;
    if (this.cancel()) return true;
    if (this.send?.route !== 'picker' || this.send.state !== 'sending') return false;
    // Deletion may revoke a prepared picker only before its command is queued.
    this.send = { ...this.send, state: 'cancelled' };
    this.ticket = undefined;
    return true;
  }
  private finish(state: 'sent' | 'failed' | 'missing', reason?: StickerReason, detail?: StickerMakerDetail, sent?: StickerSendOutcome) {
    this.send = { ...this.send!, state, ...(sent ? { sent } : {}), ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) };
    this.ticket = undefined; this.authorized = false;
  }
}
