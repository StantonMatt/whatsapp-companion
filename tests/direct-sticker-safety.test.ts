import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { StickerTransfer, stickerRoute } from '../src/core/sticker-transfer';
import { StatusCache, statusUpdate } from '../src/core/status';
import { emptySnapshot, type Status } from '../src/shared/model';
import { DIRECT_SHAPE } from '../src/shared/direct-sticker';
import { DirectStickerSafety } from '../src/main/direct-sticker-safety';
import { DirectStickerSender } from '../src/main/direct-sticker-sender';
import { StickerSendDiagnostics } from '../src/main/sticker-send-diagnostics';
import { Store } from '../src/main/store';

const reasons = ['logged-out', 'account-warning', 'send-error', 'whatsapp-changed'] as const;
const nonce = '550e8400-e29b-41d4-a716-446655440000';
const nextNonce = '550e8400-e29b-41d4-a716-446655440001';
const destination = { wid: '123@c.us', title: 'A friend', type: 'user' as const };
const snapshot = { ...emptySnapshot, chatId: destination.wid, settingsId: destination.wid, name: destination.title, conversationOpen: true, ready: true, revision: '1' };
const fingerprint = `${DIRECT_SHAPE}|2.3000.1030000000`;
const bytes = Buffer.alloc(30); bytes.write('RIFF'); bytes.writeUInt32LE(22, 4); bytes.write('WEBP', 8); bytes.write('VP8X', 12); bytes.writeUInt32LE(10, 16);
const id = createHash('sha256').update(bytes).digest('hex'), image = 'data:image/webp;base64,' + bytes.toString('base64');
let directory: string;
afterEach(() => { vi.restoreAllMocks(); if (directory) rmSync(directory, { recursive: true, force: true }); });

function setup() {
  directory = mkdtempSync(join(tmpdir(), 'direct-stop-test-'));
  const store = new Store(directory);
  store.update(s => { s.global.directStickerSend = true; });
  const transfer = new StickerTransfer(), saveFailed = vi.fn();
  const safety = new DirectStickerSafety(store, transfer, saveFailed);
  const ticket = transfer.begin(id, nonce, transfer.destinationToken(snapshot), snapshot, Date.now(), 'direct');
  const status = (sequence: number): Status => ({ sequence, state: safety.state(), runtimePaused: false,
    chat: { ...snapshot, canSendSticker: true }, keys: { openai: false, anthropic: false },
    secureStorage: false, fixture: true, message: '', pending: null });
  return { store, transfer, safety, saveFailed, ticket, status };
}

test.each(reasons)('%s revokes preparation before a failing save and publishes the session stop', reason => {
  const s = setup(), cache = new StatusCache(), before = s.status(1);
  cache.accept(before);
  expect(s.transfer.bindDirect(nonce, destination, snapshot, s.safety.enabled())).toBe(true);
  const update = vi.spyOn(s.store, 'update').mockImplementation(() => {
    expect(s.safety.enabled()).toBe(false);
    expect(s.transfer.send).toMatchObject({ state: 'failed', sent: 'not-sent' });
    throw new Error('disk full');
  });
  expect(() => s.safety.stop(reason, 200)).not.toThrow();
  expect(s.store.state.global.directStickerSend).toBe(true); // The failed Store write preserves its old state.
  expect(s.saveFailed).toHaveBeenCalledExactlyOnceWith();
  const next = s.status(2), delta = statusUpdate(next, before.state);
  expect(cache.accept(delta)?.state.global).toMatchObject({ directStickerSend: false, directStickerDisabledReason: reason, directStickerDisabledAt: 200 });
  expect(s.safety.state()).toBe(next.state); // Unchanged status updates retain the normal delta behavior.
  expect(s.transfer.attemptDirect(nonce, snapshot, s.safety.enabled())).toBeUndefined();
  expect(stickerRoute(snapshot, true, undefined, s.safety.enabled())).toBe('picker');
  expect(stickerRoute(snapshot, false, undefined, s.safety.enabled())).toBe('maker');
  s.safety.stop('send-error', 300);
  expect(update).toHaveBeenCalledTimes(1);
  expect(s.safety.state().global.directStickerDisabledReason).toBe(reason);

  // Failed explicit enables keep the stop; unrelated successful saves and resets do too.
  update.mockImplementation(() => { throw new Error('unwritable'); });
  expect(() => s.safety.preferences('global', { directStickerSend: true })).toThrow('unwritable');
  expect(s.safety.enabled()).toBe(false);
  update.mockRestore();
  s.safety.preferences('global', { tone: 'friendly' });
  s.safety.preferences(snapshot.chatId, { length: 'brief' });
  s.safety.preferences('global', { directStickerSend: false });
  s.safety.reset(snapshot.chatId);
  s.safety.reset('global');
  expect(s.safety.state().global).toMatchObject({ directStickerSend: false, directStickerDisabledReason: reason, directStickerDisabledAt: 200 });
  s.safety.preferences('global', { directStickerSend: true });
  expect(s.safety.enabled()).toBe(true);
  expect(s.safety.state()).toBe(s.store.state);
  expect(s.safety.state().global.directStickerDisabledReason).toBeUndefined();
  expect(s.safety.state().global.directStickerDisabledAt).toBeUndefined();
  expect(new Store(directory).state.global.directStickerSend).toBe(true);
});

test.each(reasons)('%s during resolution prevents dispatch and later direct authorization despite a failing store', async reason => {
  const s = setup();
  let resolve!: (value: unknown) => void;
  const held = new Promise<unknown>(r => { resolve = r; });
  const execute = vi.fn<(script: string) => Promise<unknown>>().mockReturnValueOnce(held);
  const sender = new DirectStickerSender({ transfer: s.transfer, snapshot: () => snapshot, enabled: () => s.safety.enabled(),
    disable: reason => s.safety.stop(reason), execute, publish: vi.fn(), diagnostics: new StickerSendDiagnostics(directory) });
  const running = sender.run(s.ticket, image, 'picker');
  vi.spyOn(s.store, 'update').mockImplementation(() => { throw new Error('disk full'); });
  s.safety.stop(reason);
  resolve({ nonce, fingerprint, status: 'resolved', destination });
  expect(await running).toBeUndefined();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(s.transfer.send).toMatchObject({ route: 'direct', state: 'failed', sent: 'not-sent' });
  // Defense in depth: even a stale direct route cannot acquire a new main grant.
  const ticket = s.transfer.begin(id, nextNonce, s.transfer.destinationToken(snapshot), snapshot, Date.now(), 'direct');
  expect(s.transfer.bindDirect(nextNonce, destination, snapshot, s.safety.enabled())).toBe(false);
  expect(s.transfer.attemptDirect(nextNonce, snapshot, s.safety.enabled())).toBeUndefined();
  expect(await sender.run(ticket, image, 'picker')).toBeUndefined();
  expect(execute).toHaveBeenCalledTimes(1);
});

test.each(['send-failed', 'module-shape'] as const)('a sender %s failure keeps its automatic stop when saving fails', async code => {
  const s = setup();
  const execute = vi.fn<(script: string) => Promise<unknown>>()
    .mockResolvedValueOnce({ nonce, fingerprint, status: 'resolved', destination })
    .mockResolvedValueOnce({ nonce, fingerprint, status: 'finished', phase: 'send-invoked', code, outcome: 'unknown',
      detail: code === 'module-shape' ? 'Collections.Chat.get missing' : null,
      uploaded: true, attempted: true, ack: null, type: null, to: null });
  vi.spyOn(s.store, 'update').mockImplementation(() => { throw new Error('disk full'); });
  const sender = new DirectStickerSender({ transfer: s.transfer, snapshot: () => snapshot, enabled: () => s.safety.enabled(),
    disable: reason => s.safety.stop(reason), execute, publish: vi.fn(), diagnostics: new StickerSendDiagnostics(directory) });
  await sender.run(s.ticket, image, 'picker');
  expect(s.transfer.send).toMatchObject({ route: 'direct', state: 'failed', sent: 'unknown' });
  expect(s.safety.state().global).toMatchObject({ directStickerSend: false, directStickerDisabledReason: code === 'module-shape' ? 'whatsapp-changed' : 'send-error' });
  expect(s.saveFailed).toHaveBeenCalledExactlyOnceWith();
  expect(s.store.state.global.directStickerSend).toBe(true);
});

test.each(['off', 'reset'] as const)('explicit %s revokes before a failed write and requires a successful re-enable', action => {
  const s = setup();
  vi.spyOn(s.store, 'update').mockImplementation(() => {
    expect(s.safety.enabled()).toBe(false);
    expect(s.transfer.send).toMatchObject({ state: 'failed', sent: 'not-sent' });
    throw new Error('disk full');
  });
  expect(() => action === 'off' ? s.safety.preferences('global', { directStickerSend: false }) : s.safety.reset('global')).toThrow('disk full');
  expect(s.safety.state().global.directStickerSend).toBe(false);
  expect(s.saveFailed).toHaveBeenCalledExactlyOnceWith();
  expect(() => s.safety.preferences('global', { directStickerSend: true })).toThrow('disk full');
  expect(s.safety.enabled()).toBe(false);
  vi.restoreAllMocks();
  s.safety.preferences('global', { directStickerSend: true });
  expect(s.safety.enabled()).toBe(true);
});

test.each(reasons)('%s successfully persists the stop and preserves it for the session after reset', reason => {
  const s = setup();
  s.safety.stop(reason, 200);
  expect(new Store(directory).state.global).toMatchObject({ directStickerSend: false, directStickerDisabledReason: reason, directStickerDisabledAt: 200 });
  expect(s.saveFailed).not.toHaveBeenCalled();
  s.safety.reset('global');
  expect(s.safety.state().global.directStickerDisabledReason).toBe(reason);
  expect(s.safety.enabled()).toBe(false);
  s.safety.preferences('global', { directStickerSend: true });
  expect(s.safety.enabled()).toBe(true);
});
