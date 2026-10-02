import type { Snapshot } from './model';

export type StickerTarget = Pick<Snapshot, 'chatId' | 'name' | 'revision'>;
export type StickerSend = { id: string; nonce: string; name: string; state: 'finding' | 'sending' | 'sent' | 'missing' | 'failed' | 'cancelled'; reason?: 'chat-changed' };
export type StickerTicket = { id: string; nonce: string; target: StickerTarget };
export function sameStickerChat(target: StickerTarget, snapshot: Snapshot) {
  return snapshot.ready && !snapshot.composing && target.revision === snapshot.revision && target.chatId === snapshot.chatId && target.name === snapshot.name;
}
