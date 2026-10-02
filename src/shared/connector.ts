import type { Snapshot, Panel } from './model';
import type { StickerTicket } from './sticker-transfer';
import type { PickerLayoutResult } from './sticker-picker-capture';
// Replaceable boundary. The main process alone owns provider access and send authorization.
export type RemoteCommand =
  | { type: 'captureStickerPickerLayout'; nonce: string }
  | ({ type: 'prepareSticker' } & StickerTicket)
  | ({ type: 'sendSticker'; expiresAt: number } & StickerTicket)
  | { type: 'cancelSticker' }
  | { type: 'chrome'; panel: Panel; pending: boolean; panelBounds?: { left: number; right: number } | null }
  | { type: 'clear' }
  | { type: 'suggestion'; key: string; text: string; replace: boolean; id?: string }
  | { type: 'refining'; key: string }
  | { type: 'autoSend'; key: string; text: string; nonce: string; expiresAt: number }
  | { type: 'locateSticker'; id: string; nonce: string }
  | { type: 'notice'; text: string; retryKey?: string };
export interface Connector {
  send(command: RemoteCommand): void;
  focus(): void;
}
export type RemoteEvent = { type: 'stickerPickerLayout'; nonce: string; result: PickerLayoutResult } | { type: 'stickerPrepared'; nonce: string; found: boolean } | { type: 'stickerSent'; nonce: string; clicked: boolean } | { type: 'stickerLocated'; nonce: string; found: boolean } | { type: 'navigate'; panel: Panel } | { type: 'chrome'; rail: number; listWidth: number; theme: 'dark' | 'light' } | { type: 'cancelAuto' } | { type: 'snapshot'; snapshot: Snapshot } | { type: 'activity'; editing?: boolean } | { type: 'dismiss' } | { type: 'request'; instruction?: string; key?: string; suggestionId?: string } | { type: 'result'; nonce: string; sent: boolean } | { type: 'sticker'; image: string };
