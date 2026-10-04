import type { Snapshot, Panel } from './model';
import type { StickerTicket, StickerMakerDetail, StickerLookupDiagnostics } from './sticker-transfer';
import type { PickerLayoutResult } from './sticker-picker-capture';
import { z } from 'zod';
export const accountSafetyEventSchema = z.object({
  type: z.literal('accountSafety'), reason: z.enum(['logged-out', 'account-warning']).nullable()
}).strict();
export type AccountSafetyReason = z.infer<typeof accountSafetyEventSchema>['reason'];
export const displayReasons = ['displayed', 'key', 'unready', 'composition', 'draft', 'dismissed'] as const;
export const displayAckSchema = z.object({ type: z.literal('displayAck'), suggestionId: z.string().uuid(), key: z.string().max(1_000_000), reason: z.enum(displayReasons) }).strict();
export const dismissEventSchema = z.object({ type: z.literal('dismiss'), suggestionId: z.string().uuid().optional(), key: z.string().max(1_000_000).optional(), requestId: z.string().uuid().optional() }).strict()
  .refine(value => Boolean(value.key) === Boolean(value.suggestionId) && !(value.suggestionId && value.requestId));
// Replaceable boundary. The main process alone owns provider access and send authorization.
export type RemoteCommand =
  | { type: 'captureStickerPickerLayout'; nonce: string }
  | ({ type: 'makeSticker'; image: string } & StickerTicket)
  | ({ type: 'prepareSticker' } & StickerTicket)
  | ({ type: 'sendSticker'; expiresAt: number } & StickerTicket)
  | { type: 'cancelSticker' }
  | { type: 'chrome'; panel: Panel; pending: boolean; panelBounds?: { left: number; right: number } | null }
  | { type: 'snapshot'; nonce: string }
  // Discard request-bound text and pending/recovery notices together.
  | { type: 'clear' }
  | { type: 'suggestion'; key: string; text: string; replace: boolean; id?: string; requestId?: string }
  | { type: 'refining' | 'thinking'; key: string; requestId: string; origin: 'user' | 'auto' }
  | { type: 'autoSend'; key: string; text: string; nonce: string; expiresAt: number }
  | { type: 'locateSticker'; id: string; nonce: string }
  | { type: 'notice'; text: string; retryKey?: string; requestId?: string };
export interface Connector {
  send(command: RemoteCommand): void;
  focus(): void;
}
export type RemoteEvent = z.infer<typeof accountSafetyEventSchema> | z.infer<typeof displayAckSchema> | z.infer<typeof dismissEventSchema> | { type: 'stickerPickerLayout'; nonce: string; result: PickerLayoutResult } | { type: 'stickerPrepared'; nonce: string; found: boolean; diagnostics?: StickerLookupDiagnostics } | { type: 'stickerCancelled'; nonce: string; reason: 'chat-changed'; detail?: StickerMakerDetail } | { type: 'stickerClicked'; nonce: string } | { type: 'stickerSent'; nonce: string; clicked: boolean; confirmed?: boolean; reason?: 'editor-unavailable' | 'unconfirmed' | 'draft'; detail?: StickerMakerDetail; diagnostics?: StickerLookupDiagnostics } | { type: 'stickerLocated'; nonce: string; found: boolean } | { type: 'navigate'; panel: Panel } | { type: 'chrome'; rail: number; listWidth: number; theme: 'dark' | 'light' } | { type: 'cancelAuto' } | { type: 'snapshot'; snapshot: Snapshot; nonce?: string } | { type: 'activity'; editing?: boolean } | { type: 'applied'; key: string; suggestionId: string; success?: boolean } | { type: 'request'; instruction?: string; operation?: 'translate' | 'retry'; key?: string; suggestionId?: string } | { type: 'result'; nonce: string; sent: boolean } | { type: 'sticker'; image: string };
