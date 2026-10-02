import { z } from 'zod';
import type { Snapshot } from './model';

// Stable categories finish promptly; loading evidence can use the full cap.
export const STICKER_PICKER_LOOKUP_MS = 15_000;
// Leave IPC delivery time after the connector's cap before main revokes lookup.
export const STICKER_PICKER_WATCHDOG_MS = STICKER_PICKER_LOOKUP_MS + 1000;
export const stickerLookupDiagnosticsSchema = z.object({
  reason: z.enum(['not-found', 'lookup-cap', 'picker-unavailable', 'chat-changed']).optional(),
  totalMs: z.number().int().min(0).max(120_000),
  categories: z.array(z.object({
    name: z.enum(['current', 'favorites', 'recent', 'open-pack']),
    activatedMs: z.number().int().min(0).max(STICKER_PICKER_LOOKUP_MS),
    firstImageMs: z.number().int().min(0).max(STICKER_PICKER_LOOKUP_MS).nullable(),
    settledMs: z.number().int().min(0).max(STICKER_PICKER_LOOKUP_MS).nullable(),
    loadingSeen: z.boolean(), imagesSeen: z.number().int().min(0).max(100_000), found: z.boolean()
  }).strict()).max(4)
}).strict();
export type StickerLookupDiagnostics = z.infer<typeof stickerLookupDiagnosticsSchema>;

// Native maker preparation normally takes 2–4 seconds. Bound a missing or
// unsafe editor to five seconds, separately from post-click confirmation.
export const STICKER_MAKER_PREPARATION_MS = 5000;
// Cancellation may still need the remaining mount window plus Close/Discard.
// Main starts this budget at disclosure, rather than extending it on cancel.
export const STICKER_MAKER_CLEANUP_MS = STICKER_MAKER_PREPARATION_MS + 1000;
// A visible outgoing bubble usually mounts immediately. Leave four seconds
// for delayed rendering; an uncertain result never permits automatic retry.
export const STICKER_MAKER_CONFIRMATION_MS = 4000;
// Confirmation is followed by connector teardown. Main leaves room for the
// final result without assuming activation proves delivery.
export const STICKER_MAKER_WATCHDOG_MS = 8000;

export type StickerRoute = 'maker' | 'picker' | 'direct';
export type StickerSendBlockedReason = 'busy' | 'no-chat';
export type StickerReason = 'chat-changed' | 'editor-unavailable' | 'unconfirmed' | 'draft';
export type StickerSendOutcome = 'confirmed' | 'not-sent' | 'unknown';
// Fixed diagnostic codes only: never page text, identifiers or sticker bytes.
export const stickerMakerDetails = ['maker-busy', 'main-not-found', 'editor-preopen', 'draft-present', 'draft-appeared', 'invalid-image', 'invalid-webp', 'hash-mismatch', 'attach-not-found', 'attach-ambiguous', 'menu-preopen', 'attach-click-failed', 'item-not-found', 'item-ambiguous', 'menu-unavailable', 'item-click-failed', 'input-not-found', 'input-ambiguous', 'input-changed', 'disclose-denied', 'file-assignment-failed', 'editor-timeout', 'editor-cleanup-failed', 'editor-send-ambiguous', 'editor-changed', 'caption-present', 'preparation-lost', 'send-denied', 'send-click-failed', 'confirm-timeout', 'chat-changed', 'cancelled', 'preparation-timeout', 'maker-error'] as const;
export type StickerMakerDetail = typeof stickerMakerDetails[number];
export type StickerTarget = Pick<Snapshot, 'chatId' | 'name' | 'revision'>;
export type StickerSend = { id: string; nonce: string; name: string; route: StickerRoute; animated: boolean; state: 'finding' | 'preparing' | 'sending' | 'sent' | 'missing' | 'failed' | 'cancelled'; sent?: StickerSendOutcome; reason?: StickerReason; detail?: StickerMakerDetail };
export type StickerTicket = { id: string; nonce: string; target: StickerTarget; route?: StickerRoute; directDestination?: { wid: string; type: 'user' | 'group' | 'lid'; title: string } };
export type StickerAuthorization = { nonce: string; phase: 'disclose' | 'send'; snapshot: Snapshot };
export function sameStickerChat(target: StickerTarget, snapshot: Snapshot) {
  // Picker sending does not require a composer; identity and revision still
  // bind activation to the clicked conversation. Maker checks emptiness separately.
  return snapshot.conversationOpen && Boolean(target.name) && target.revision === snapshot.revision && target.chatId === snapshot.chatId && target.name === snapshot.name;
}
export function sameStickerPreparation(ticket: StickerTicket, snapshot: Snapshot) {
  return snapshot.conversationOpen && !snapshot.composing && !snapshot.draftIssue && ticket.target.chatId === snapshot.chatId && ticket.target.name === snapshot.name && snapshot.stickerPreparation === ticket.nonce;
}
