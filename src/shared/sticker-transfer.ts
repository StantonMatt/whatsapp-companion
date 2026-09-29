import type { Snapshot } from './model';

export const STICKER_DRAG_PREFIX = 'whatsapp-companion-sticker:';
export const STICKER_DRAG_TYPE = 'application/x-whatsapp-companion-sticker';
export type StickerTarget = Pick<Snapshot, 'chatId' | 'name' | 'revision'>;
export type StickerPreview = { id: string; nonce: string; name: string; state: 'finding' | 'ready' | 'sending' | 'missing' | 'failed' };
export type StickerTicket = { id: string; nonce: string; target: StickerTarget };
export function sameStickerChat(target: StickerTarget, snapshot: Snapshot) {
  return snapshot.ready && !snapshot.composing && target.revision === snapshot.revision && target.chatId === snapshot.chatId && target.name === snapshot.name;
}
