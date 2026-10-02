import { expect, test } from 'vitest';
import { StickerReadiness } from '../src/core/sticker-readiness';
import { StickerTransfer } from '../src/core/sticker-transfer';
import { emptySnapshot } from '../src/shared/model';

const snapshot = { ...emptySnapshot, chatId: '123@c.us', settingsId: '123@c.us', name: 'Alex', conversationOpen: true, ready: true, revision: '1', messages: [{ id: 'history-1', outgoing: false, text: 'Hello' }] };

test.each([snapshot.chatId, null])('owned editor and its composer settling window keep only the verified destination ready (chatId=%s)', chatId => {
  const readiness = new StickerReadiness();
  const initial = { ...snapshot, chatId, settingsId: chatId ?? 'local:alex' };
  expect(readiness.present(initial, undefined, 0)).toBe(initial);
  const editor = { ...initial, ready: false, revision: '2', stickerPreparation: 'owned' };
  expect(readiness.present(editor, 'owned', 100).ready).toBe(true);
  const restored = { ...editor, settingsId: undefined, stickerPreparation: undefined, revision: '3' };
  expect(readiness.present(restored, undefined, 200)).toMatchObject({ ready: true, settingsId: initial.settingsId });
  expect(readiness.present(restored, undefined, 750).ready).toBe(true);
  expect(readiness.present(restored, undefined, 1000).ready).toBe(false);
  expect(editor.ready).toBe(false); // Presentation never mutates authorization input.
});

test.each(['chat', 'scope', 'unrecognized scope', 'name', 'history'])('a genuine %s change immediately ends the presentation hold', change => {
  const readiness = new StickerReadiness();
  const initial = { ...snapshot, chatId: change === 'history' ? null : snapshot.chatId };
  readiness.present(initial, undefined, 0);
  readiness.present({ ...initial, ready: false }, 'owned', 100);
  const next = { ...initial, ready: false,
    ...(change === 'chat' && { chatId: '456@c.us' }),
    ...(change === 'scope' && { settingsId: 'local:other' }),
    ...(change === 'unrecognized scope' && { settingsId: null }),
    ...(change === 'name' && { name: 'Robin' }),
    ...(change === 'history' && { messages: [{ id: 'different-history', outgoing: false, text: 'Hello' }] }) };
  expect(readiness.present(next, undefined, 200)).toBe(next);
  expect(readiness.present({ ...initial, ready: false }, undefined, 300).ready).toBe(false);
});

test('an unowned composer interruption is never held ready', () => {
  const readiness = new StickerReadiness();
  readiness.present(snapshot, undefined, 0);
  expect(readiness.present({ ...snapshot, ready: false }, undefined, 100).ready).toBe(false);
});
test('a hidden conversation immediately ends an owned maker readiness hold', () => {
  const readiness = new StickerReadiness();
  readiness.present(snapshot, undefined, 0);
  readiness.present({ ...snapshot, ready: false }, 'owned', 100);
  const hidden = { ...snapshot, conversationOpen: false, ready: false, stickerPreparation: 'owned' };
  expect(readiness.present(hidden, 'owned', 200)).toBe(hidden);
  expect(readiness.settlingDeadline).toBe(0);
});

test('holding presentation ready cannot authorize a send from the real unavailable snapshot', () => {
  const readiness = new StickerReadiness(), transfer = new StickerTransfer();
  readiness.present(snapshot, undefined, 0);
  const token = transfer.destinationToken(snapshot);
  transfer.begin('a'.repeat(64), 'nonce', token, snapshot, 0, 'maker', false);
  expect(transfer.disclose('nonce', snapshot, 1)).toBe(true);
  const unavailable = { ...snapshot, ready: false, revision: '2' };
  expect(readiness.present(unavailable, 'nonce', 2).ready).toBe(true);
  expect(transfer.authorize('nonce', unavailable, 3)).toBe(false);
});

test('a terminal maker result can remain presented ready while a new send is rejected until the restored composer settles', () => {
  const readiness = new StickerReadiness(), transfer = new StickerTransfer();
  readiness.present(snapshot, undefined, 0);
  transfer.begin('a'.repeat(64), 'first', transfer.destinationToken(snapshot), snapshot, 0, 'maker', false);
  expect(transfer.disclose('first', snapshot, 1)).toBe(true);
  const editor = { ...snapshot, ready: false, revision: '2', stickerPreparation: 'first' };
  expect(readiness.present(editor, 'first', 100).ready).toBe(true);
  expect(transfer.authorize('first', editor, 101)).toBe(true);
  transfer.clicked('first'); transfer.result('first', true, true);
  const restored = { ...snapshot, ready: false, revision: '3' };
  expect(readiness.present(restored, undefined, 200).ready).toBe(true);
  const token = transfer.destinationToken(restored);
  transfer.begin('a'.repeat(64), 'second', token, restored, 201, 'maker', false);
  expect(transfer.send).toMatchObject({ nonce: 'second', state: 'failed', reason: 'draft', detail: 'draft-present' });
  const settled = { ...restored, ready: true };
  readiness.present(settled, undefined, 750);
  expect(() => transfer.begin('a'.repeat(64), 'third', transfer.destinationToken(settled), settled, 751, 'maker', false)).not.toThrow();
  expect(transfer.send).toMatchObject({ nonce: 'third', state: 'preparing' });
});

test('remote previews retain the verified scope until main identifies the next snapshot', () => {
  const readiness = new StickerReadiness();
  readiness.present(snapshot, undefined, 0);
  readiness.present({ ...snapshot, settingsId: undefined }, undefined, 10);
  readiness.present({ ...snapshot, ready: false, settingsId: undefined }, 'owned', 100);
  expect(readiness.present({ ...snapshot, ready: false, settingsId: 'local:other' }, 'owned', 150).ready).toBe(false);
});

test.each(['result', 'cancelled'] as const)('ownership ending through %s expires readiness without another remote snapshot', terminal => {
  const readiness = new StickerReadiness(), transfer = new StickerTransfer();
  readiness.present(snapshot, undefined, 0);
  transfer.begin('a'.repeat(64), 'owned', transfer.destinationToken(snapshot), snapshot, 0, 'maker', false);
  transfer.disclose('owned', snapshot, 1);
  const editor = { ...snapshot, ready: false, stickerPreparation: 'owned' };
  readiness.present(editor, transfer.ownsMaker(editor) ? editor.stickerPreparation : undefined, 100);
  expect(readiness.settlingDeadline).toBe(0);
  if (terminal === 'cancelled') transfer.cancel();
  else { transfer.authorize('owned', editor, 101); transfer.clicked('owned'); transfer.result('owned', true); }
  const owner = transfer.ownsMaker(editor) ? editor.stickerPreparation : undefined;
  expect(readiness.present(editor, owner, 200).ready).toBe(true);
  expect(readiness.settlingDeadline).toBe(1000);
  readiness.present(editor, owner, 700); // Repeated local publishes do not extend the hold.
  expect(readiness.settlingDeadline).toBe(1000);
  expect(readiness.present(editor, owner, readiness.settlingDeadline).ready).toBe(false);
  expect(readiness.settlingDeadline).toBe(0);
  expect(editor.ready).toBe(false);
});
