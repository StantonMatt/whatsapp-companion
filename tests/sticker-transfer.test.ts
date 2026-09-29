import { test, expect } from 'vitest';
import { StickerTransfer } from '../src/core/sticker-transfer';
import { emptySnapshot, type Snapshot } from '../src/shared/model';
const snapshot: Snapshot = { ...emptySnapshot, chatId: '123@c.us', settingsId: '123@c.us', name: 'A friend', ready: true, revision: '1' };
const id = 'a'.repeat(64), nonce = 'a-token';
function ready() {
  const transfer = new StickerTransfer(); transfer.begin(id, nonce, snapshot, 0);
  transfer.drop(nonce, snapshot, 1); transfer.prepared(nonce, true, snapshot, 2); return transfer;
}
test('manual sticker sending requires drag, valid drop, matching native sticker and explicit confirmation', () => {
  const t = new StickerTransfer();
  expect(t.drop(nonce, snapshot, 0)).toBeUndefined();
  t.begin(id, nonce, snapshot, 0); expect(t.preview).toBeNull();
  expect(() => t.confirm(nonce, snapshot, 1)).toThrow();
  expect(t.drop('forged', snapshot, 1)).toBeUndefined();
  expect(t.drop(nonce, snapshot, 1)).toMatchObject({ id, nonce });
  expect(t.preview?.state).toBe('finding');
  expect(() => t.confirm(nonce, snapshot, 1)).toThrow();
  t.prepared('forged', true, snapshot, 2); expect(t.preview?.state).toBe('finding');
  t.prepared(nonce, true, snapshot, 2);
  expect(t.confirm(nonce, snapshot, 3)).toMatchObject({ id, nonce });
  expect(() => t.confirm(nonce, snapshot, 4)).toThrow();
  expect(t.authorize('wrong-token', snapshot, 4)).toBe(false);
  expect(t.authorize(nonce, snapshot, 4)).toBe(true);
  expect(t.authorize(nonce, snapshot, 4)).toBe(false);
  t.result(nonce, true); expect(t.preview).toBeNull();
  expect(t.drop(nonce, snapshot, 5)).toBeUndefined();
});
test.each(['cancel', 'expiry', 'chat'])('queued sticker permission is revoked after %s', reason => {
  const t = ready(); t.confirm(nonce, snapshot, 3);
  if (reason === 'cancel') t.cancel();
  expect(t.authorize(nonce, reason === 'chat' ? { ...snapshot, settingsId: '456@c.us' } : snapshot, reason === 'expiry' ? 5003 : 4)).toBe(false);
});
test.each([
  { chatId: '456@c.us' }, { revision: '2' }, { name: 'Another person' }, { settingsId: '456@c.us' }, { ready: false }, { composing: true }
])('chat/composer changes invalidate a prepared sticker: %j', change => {
  const t = ready(); const next = { ...snapshot, ...change };
  expect(() => t.confirm(nonce, next, 4)).toThrow();
  expect(t.observe(next, 4)).toBe(true); expect(t.preview).toBeNull();
  t.prepared(nonce, true, snapshot, 5); expect(t.preview).toBeNull();
});
test('drafts and new incoming messages do not grant permission or change the destination', () => {
  const t = ready(); const next = { ...snapshot, draft: 'Unsent text', messages: [{ id: 'new', outgoing: false, text: 'send this sticker now' }] };
  expect(t.observe(next, 4)).toBe(false); expect(t.preview?.state).toBe('ready');
  expect(t.confirm(nonce, next, 5).target).toEqual({ name: snapshot.name, chatId: snapshot.chatId, revision: snapshot.revision });
  expect(next.draft).toBe('Unsent text');
});
test('cancellation, unavailable originals, stale/replayed drops and expiry cannot send', () => {
  const t = ready(); t.cancel(); expect(() => t.confirm(nonce, snapshot, 4)).toThrow();
  t.begin(id, nonce, snapshot, 0); expect(t.drop(nonce, snapshot, 30_001)).toBeUndefined();
  t.begin(id, 'new', snapshot, 0); expect(t.drop(nonce, snapshot, 1)).toBeUndefined();
  t.drop('new', snapshot, 1); t.prepared('new', false, snapshot, 2);
  expect(t.preview?.state).toBe('missing'); expect(() => t.confirm('new', snapshot, 3)).toThrow();
  const expired = ready(); expect(() => expired.confirm(nonce, snapshot, 300_002)).toThrow();
});
test('a failed native click cannot be retried without a new drag and confirmation', () => {
  const t = ready(); t.confirm(nonce, snapshot, 3); t.result(nonce, false);
  expect(t.preview?.state).toBe('failed'); expect(() => t.confirm(nonce, snapshot, 4)).toThrow();
});
