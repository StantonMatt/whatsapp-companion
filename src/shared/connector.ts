import type { Snapshot, Panel } from './model';
import type { StickerTicket } from './sticker-transfer';
// Replaceable boundary. The main process alone owns provider access and send authorization.
export type RemoteCommand =
  | ({ type: 'armStickerDrag' | 'prepareSticker' } & StickerTicket)
  | ({ type: 'sendSticker'; expiresAt: number } & StickerTicket)
  | { type: 'cancelSticker' }
  | { type: 'chrome'; panel: Panel; pending: boolean }
  | { type: 'clear' }
  | { type: 'suggestion'; key: string; text: string; replace: boolean }
  | { type: 'autoSend'; key: string; text: string; nonce: string; expiresAt: number }
  | { type: 'locateSticker'; id: string; nonce: string }
  | { type: 'notice'; text: string };
export interface Connector {
  send(command: RemoteCommand): void;
  focus(): void;
}
export type RemoteEvent = { type: 'stickerDrop'; nonce: string } | { type: 'stickerPrepared'; nonce: string; found: boolean } | { type: 'stickerSent'; nonce: string; clicked: boolean } | { type: 'stickerLocated'; nonce: string; found: boolean } | { type: 'navigate'; panel: Panel } | { type: 'chrome'; rail: number; listWidth: number; theme: 'dark' | 'light' } | { type: 'cancelAuto' } | { type: 'snapshot'; snapshot: Snapshot } | { type: 'activity'; editing?: boolean } | { type: 'dismiss' } | { type: 'request'; instruction?: string } | { type: 'result'; nonce: string; sent: boolean } | { type: 'sticker'; image: string };
