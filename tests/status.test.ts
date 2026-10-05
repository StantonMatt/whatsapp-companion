import { expect, test } from 'vitest';
import { initialState, type Status, type Sticker } from '../src/shared/model';
import { StatusCache, StatusPublisher, statusUpdate } from '../src/core/status';
import { ChromeSync } from '../src/main/chrome-sync';
const status = (sequence = 1): Status => ({ sequence, state: initialState(), runtimePaused: false,
  chat: { chatId: null, name: '', kind: 'direct', ready: false, canSendSticker: false },
  keys: { openai: false, anthropic: false }, secureStorage: false, fixture: true, message: 'Ready', pending: null });
const sticker: Sticker = { id: 'a'.repeat(64), searchTerms: 'cat', groups: [], kind: 'static', size: 24, firstSeen: 1, lastSeen: 1,
  fingerprint: { version: 1, animated: false, hash: 'a'.repeat(16), pixels: 'a'.repeat(288) } };

test('initial and sticker delta omit main-only data and reconstruct a compatible UI shape', () => {
  const initial = status(); initial.state.stickers = [sticker]; initial.state.conversations.private = ['b'.repeat(64)];
  initial.state.ledger.private = [{ at: 1, messageId: 'private' }]; initial.state.forgottenStickers = ['c'.repeat(64)];
  const wire = statusUpdate(initial), cache = new StatusCache();
  for (const field of ['conversations', 'ledger', 'forgottenStickers']) expect(wire.state).not.toHaveProperty(field);
  expect(wire.state?.stickers?.[0]).not.toHaveProperty('fingerprint');
  expect(cache.accept(wire)?.state).toMatchObject({ conversations: {}, ledger: {}, forgottenStickers: [], stickers: [{ searchTerms: 'cat' }] });
  const edited = { ...initial, sequence: 2, state: { ...initial.state, stickers: [{ ...sticker, searchTerms: 'dog' }] } };
  const delta = statusUpdate(edited, initial.state, initial);
  expect(delta.state).toBeUndefined(); expect(delta.stickerChanges?.upsert[0]).not.toHaveProperty('fingerprint');
  expect(cache.accept(delta)?.state.stickers[0].searchTerms).toBe('dog');
});

test('only changed settings/transient fields publish; main-only and fingerprint changes are suppressed', () => {
  const publisher = new StatusPublisher(), initial = status(); initial.state.stickers = [sticker];
  expect(publisher.next(initial)).toBeDefined();
  expect(publisher.next({ ...initial, sequence: 2, chat: { ...initial.chat } })).toBeUndefined();
  const privateChange = { ...initial, sequence: 2, state: { ...initial.state, conversations: { hidden: ['a'.repeat(64)] },
    stickers: [{ ...sticker, fingerprint: { ...sticker.fingerprint!, hash: 'b'.repeat(16) } }] } };
  expect(publisher.next(privateChange)).toBeUndefined();
  const settingsChange = { ...privateChange, state: { ...privateChange.state, global: { ...initial.state.global, tone: 'friendly' as const } } };
  expect(publisher.next(settingsChange)).toEqual({ sequence: 2, state: { global: settingsChange.state.global } });
  expect(publisher.next({ ...settingsChange, sequence: 3, message: 'Thinking' })).toEqual({ sequence: 3, message: 'Thinking' });
});

test('shield bytes cross the publication stream once per nonce and bounds deltas keep the captured image', () => {
  const publisher = new StatusPublisher(), cache = new StatusCache(), initial = status();
  const bounds = { x: 1, y: 0, width: 100, height: 200 };
  const shield = { ...initial, sequence: 2, stickerShield: { nonce: 'one', image: 'large capture', bounds, panel: bounds } };
  cache.accept(publisher.next(initial)!);
  const capture = publisher.next(shield)!; expect(capture.stickerShield?.image).toBe('large capture'); cache.accept(capture);
  const transient = publisher.next({ ...shield, sequence: 3, message: 'Sending' })!;
  expect(transient).not.toHaveProperty('stickerShield'); cache.accept(transient);
  const moved = publisher.next({ ...shield, sequence: 4, message: 'Sending', stickerShield: { ...shield.stickerShield, bounds: { ...bounds, width: 200 } } })!;
  expect(moved.stickerShield).not.toHaveProperty('image'); expect(cache.accept(moved)?.stickerShield).toMatchObject({ image: 'large capture', bounds: { width: 200 } });
  expect(publisher.next({ ...shield, sequence: 5, stickerShield: { ...shield.stickerShield, nonce: 'two' } })?.stickerShield?.image).toBe('large capture');
  expect(publisher.next({ ...shield, sequence: 6, stickerShield: null })?.stickerShield).toBeNull();
});

test('projected initial read reconciles queued smaller deltas and ignores older events', () => {
  const initial = status(), next = { ...initial, sequence: 2, message: 'Thinking', state: { ...initial.state, provider: 'anthropic' as const } };
  const cache = new StatusCache(); expect(cache.accept(statusUpdate(next, initial.state, initial))).toBeUndefined();
  const result = cache.accept(statusUpdate(initial));
  expect(result?.sequence).toBe(2); expect(result?.state.provider).toBe('anthropic'); expect(result?.message).toBe('Thinking');
  expect(cache.accept({ sequence: 1, message: 'stale' })).toBe(result);
});

test('chrome geometry/pending/panel commands deduplicate and a new document resets the cache', () => {
  const sync = new ChromeSync(), command = { type: 'chrome' as const, panel: 'stickers' as const, pending: false, panelBounds: { left: 64, right: 494 } };
  expect(sync.next(command)).toEqual(command); expect(sync.next({ ...command, panelBounds: { ...command.panelBounds } })).toBeUndefined();
  expect(sync.next({ ...command, pending: true })).toBeDefined();
  expect(sync.next({ ...command, panelBounds: { left: 65, right: 495 } })).toBeDefined();
  sync.reset(); expect(sync.next(command)).toBeDefined();
});
