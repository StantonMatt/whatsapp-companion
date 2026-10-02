import { afterEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StickerTransfer, stickerRoute } from '../src/core/sticker-transfer';
import { setPreferences, resolveSettings } from '../src/core/settings';
import { emptySnapshot, initialState, actionSchema, stateSchema, type Snapshot, type Status } from '../src/shared/model';
import { StatusCache, statusUpdate } from '../src/core/status';
import { Store } from '../src/main/store';
import { DIRECT_SHAPE, directArgumentsSchema, directDestinationSchema, directResolveSchema, directSendSchema, matchesDirectDestination, type DirectDestination } from '../src/shared/direct-sticker';
import { DirectStickerSender } from '../src/main/direct-sticker-sender';
import { StickerSendDiagnostics } from '../src/main/sticker-send-diagnostics';
import { STICKER_PICKER_LOOKUP_MS } from '../src/shared/sticker-transfer';

const nonce = '550e8400-e29b-41d4-a716-446655440000';
const destination: DirectDestination = { wid: '123@c.us', title: 'A friend', type: 'user' };
const snapshot: Snapshot = { ...emptySnapshot, chatId: destination.wid, settingsId: destination.wid, name: destination.title, conversationOpen: true, ready: true, revision: '1' };
const fingerprint = `${DIRECT_SHAPE}|2.3000.1030000000`;
const bytes = Buffer.alloc(30); bytes.write('RIFF'); bytes.writeUInt32LE(22, 4); bytes.write('WEBP', 8); bytes.write('VP8X', 12); bytes.writeUInt32LE(10, 16);
const id = createHash('sha256').update(bytes).digest('hex'), image = 'data:image/webp;base64,' + bytes.toString('base64');
let directory: string;
afterEach(() => { vi.useRealTimers(); if (directory) rmSync(directory, { recursive: true, force: true }); });
function setup() {
  directory = mkdtempSync(join(tmpdir(), 'direct-sticker-test-'));
  const t = new StickerTransfer(); let current = { ...snapshot }, enabled = true;
  const ticket = t.begin(id, nonce, t.destinationToken(current), current, Date.now(), 'direct', true);
  const execute = vi.fn<(script: string) => Promise<unknown>>();
  const resolved = { nonce, fingerprint, status: 'resolved', destination };
  const sent = { nonce, fingerprint, status: 'finished', code: 'none', outcome: 'confirmed', uploaded: true, attempted: true, ack: 1, type: 'sticker', to: destination.wid };
  execute.mockResolvedValueOnce(resolved).mockResolvedValueOnce(sent);
  const sender = new DirectStickerSender({ transfer: t, snapshot: () => current, enabled: () => enabled, execute, publish: vi.fn(), diagnostics: new StickerSendDiagnostics(directory) });
  return { t, ticket, execute, sender, resolved, sent, change: (next: Partial<Snapshot>) => { current = { ...current, ...next }; t.observe(current); }, disable: () => { enabled = false; } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

test('direct preference defaults false on initial and old persisted data and is strictly global', () => {
  const state = initialState(); expect(state.global.directStickerSend).toBe(false);
  const old = structuredClone(state); delete (old.global as any).directStickerSend;
  expect(stateSchema.parse(old).global.directStickerSend).toBe(false);
  expect(actionSchema.safeParse({ type: 'preferences', scope: 'global', patch: { directStickerSend: true } }).success).toBe(true);
  for (const scope of ['123@c.us', 'local:550e8400-e29b-41d4-a716-446655440000']) {
    for (const directStickerSend of [false, true]) {
      expect(actionSchema.safeParse({ type: 'preferences', scope, patch: { directStickerSend } }).success).toBe(false);
    }
  }
  expect(actionSchema.safeParse({ type: 'preferences', scope: 'global', patch: { directStickerSend: 'yes' } }).success).toBe(false);
  expect(() => setPreferences(state, '123@c.us', { directStickerSend: true })).toThrow('global');
  state.chats['123@c.us'] = { directStickerSend: true };
  expect(resolveSettings(state, 'direct', '123@c.us').values.directStickerSend).toBe(false);
});
test('preference patches preserve omitted fields and direct opt-in survives status deltas and restart', () => {
  directory = mkdtempSync(join(tmpdir(), 'direct-preference-test-'));
  let store = new Store(directory);
  const status = (sequence: number): Status => ({ sequence, state: store.state, runtimePaused: false,
    chat: { ...snapshot, canSendSticker: true }, keys: { openai: false, anthropic: false },
    secureStorage: false, fixture: true, message: '', pending: null });
  const cache = new StatusCache(); let previous = status(1);
  cache.accept(previous);
  for (const enabled of [true, false]) {
    const action = actionSchema.parse({ type: 'preferences', scope: 'global', patch: { directStickerSend: enabled } });
    if (action.type !== 'preferences') throw new Error('Expected preferences');
    expect(action.patch).toEqual({ directStickerSend: enabled });
    store.update(s => setPreferences(s, action.scope, action.patch));
    const next = status(previous.sequence + 1), update = statusUpdate(next, previous.state);
    expect(update.state?.global.directStickerSend).toBe(enabled);
    expect(cache.accept(update)?.state.global.directStickerSend).toBe(enabled);
    previous = next;
    for (const scope of ['global', '123@c.us', 'local:550e8400-e29b-41d4-a716-446655440000']) {
      const unrelated = actionSchema.parse({ type: 'preferences', scope, patch: { tone: 'friendly' } });
      if (unrelated.type !== 'preferences') throw new Error('Expected preferences');
      expect(unrelated.patch).toEqual({ tone: 'friendly' });
      store.update(s => setPreferences(s, unrelated.scope, unrelated.patch));
      expect(store.state.global.directStickerSend).toBe(enabled);
    }
    store = new Store(directory);
    expect(store.state.global.directStickerSend).toBe(enabled);
    expect(store.state.chats['123@c.us']).toEqual({ tone: 'friendly' });
  }
  const empty = actionSchema.parse({ type: 'preferences', scope: 'global', patch: {} });
  if (empty.type !== 'preferences') throw new Error('Expected preferences');
  expect(empty.patch).toEqual({});
});
test('loading legacy sparse preferences defaults only the global direct opt-in', () => {
  const old = initialState(); delete (old.global as Partial<typeof old.global>).directStickerSend;
  old.chats['123@c.us'] = { tone: 'friendly' };
  const loaded = stateSchema.parse(old);
  expect(loaded.global.directStickerSend).toBe(false);
  expect(loaded.direct).toEqual({}); expect(loaded.group).toEqual({});
  expect(loaded.chats['123@c.us']).toEqual({ tone: 'friendly' });
});
test.each([false, true])('routing opt-in is honored for every draft/animation/still combination (%s)', direct => {
  for (const draft of ['', 'Untouched draft']) for (const animated of [false, true]) for (const still of [undefined, true] as const) {
    expect(stickerRoute({ ...snapshot, draft }, animated, still, direct)).toBe(direct ? 'direct' : (animated && !still) || (!still && draft !== '') ? 'picker' : 'maker');
  }
});
test('binding cross-checks names/kinds and treats PN and LID as distinct exact destinations', () => {
  expect(matchesDirectDestination(destination, snapshot)).toBe(true);
  const lid = { ...destination, wid: '777@lid', type: 'lid' as const };
  expect(matchesDirectDestination(lid, { ...snapshot, chatId: '777@lid' })).toBe(true);
  expect(matchesDirectDestination(lid, snapshot)).toBe(false);
  expect(matchesDirectDestination(destination, { ...snapshot, chatId: '123@s.whatsapp.net' })).toBe(true);
  expect(matchesDirectDestination(destination, { ...snapshot, chatId: null, settingsId: 'local:550e8400-e29b-41d4-a716-446655440000' })).toBe(true);
  for (const change of [{ name: 'Other' }, { chatId: '124@c.us' }, { kind: 'group' as const }, { conversationOpen: false }]) expect(matchesDirectDestination(destination, { ...snapshot, ...change })).toBe(false);
  expect(directDestinationSchema.safeParse({ ...destination, type: 'lid' }).success).toBe(false);
});
test('arguments bound actual decoded bytes, hash, nonce and all keys', () => {
  const args = { phase: 'send', nonce, deadline: Date.now() + 25_000, destination, fingerprint, base64: bytes.toString('base64'), expectedHash: id };
  expect(directArgumentsSchema.safeParse(args).success).toBe(true);
  for (const change of [{ base64: Buffer.alloc(1024 * 1024 + 1).toString('base64') }, { expectedHash: 'invalid' }, { nonce: 'bad' }, { extra: 'eval' }, { destination: { ...destination, title: 'x'.repeat(151) } },
    ...[undefined, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1].map(deadline => ({ deadline }))]) expect(directArgumentsSchema.safeParse({ ...args, ...change }).success).toBe(false);
  expect(directArgumentsSchema.safeParse({ ...args, base64: Buffer.alloc(1024 * 1024).toString('base64') }).success).toBe(true);
  expect(directArgumentsSchema.safeParse({ phase: 'resolve', nonce, deadline: Date.now() + 2500 }).success).toBe(true);
  expect(directArgumentsSchema.safeParse({ phase: 'resolve', nonce, deadline: Date.now() + 2500, base64: 'unexpected' }).success).toBe(false);
});
test('result validation rejects contradictory success/fallback, raw extras and oversized values', () => {
  const { sent } = setup(); expect(directSendSchema.safeParse(sent).success).toBe(true);
  for (const change of [{ uploaded: false }, { attempted: false }, { ack: 0 }, { type: 'image' }, { fingerprint: null }, { status: 'unavailable' }, { outcome: 'not-sent' }, { to: 'x'.repeat(101) }, { rawError: 'private' }]) expect(directSendSchema.safeParse({ ...sent, ...change }).success).toBe(false);
  expect(directResolveSchema.safeParse({ nonce, fingerprint: 'unknown-version', status: 'resolved', destination }).success).toBe(false);
});
test('direct send consumes one attempt and bypasses remote authorization; replay/late outcomes cannot overwrite', async () => {
  const s = setup();
  expect(s.t.authorize(nonce, snapshot)).toBe(false);
  expect(await s.sender.run(s.ticket, image, 'picker')).toBeUndefined();
  expect(s.t.send).toMatchObject({ route: 'direct', state: 'sent', sent: 'confirmed' });
  expect(s.execute).toHaveBeenCalledTimes(2);
  expect(s.t.attemptDirect(nonce, snapshot, true)).toBeUndefined();
  await s.sender.run(s.ticket, image, 'picker'); expect(s.execute).toHaveBeenCalledTimes(2);
  s.t.result(nonce, false); s.t.directResult(nonce, 'unknown'); expect(s.t.send?.state).toBe('sent');
  expect(() => s.t.begin(id, nonce, s.t.destinationToken(snapshot), snapshot)).toThrow('already been used');
});
test('main passes absolute page deadlines that expire before its execution timeouts', async () => {
  vi.useFakeTimers();
  const s = setup(), started = Date.now();
  await s.sender.run(s.ticket, image, 'picker');
  const args = s.execute.mock.calls.map(([script]) => JSON.parse(script.slice(script.lastIndexOf(')(') + 2, -1)));
  expect(args).toMatchObject([{ phase: 'resolve', nonce, deadline: started + 2500 }, { phase: 'send', nonce, deadline: started + 25_000 }]);
  expect(vi.getTimerCount()).toBe(0);
});
test.each(['timeout', 'in-flight'] as const)('a page-side %s result never triggers fallback or another execution', async code => {
  const s = setup();
  s.execute.mockReset().mockResolvedValueOnce(s.resolved).mockResolvedValueOnce({ ...s.sent, code, outcome: 'unknown', uploaded: false, attempted: false, ack: null, type: null, to: null });
  expect(await s.sender.run(s.ticket, image, 'picker')).toBeUndefined();
  expect(s.execute).toHaveBeenCalledTimes(2);
  expect(s.t.send).toMatchObject({ route: 'direct', state: 'failed', sent: 'unknown' });
});
test.each(['timeout', 'in-flight'] as const)('a resolve-phase %s cannot fall back into another send route', async code => {
  const s = setup();
  s.execute.mockReset().mockResolvedValueOnce({ nonce, fingerprint: null, status: 'unavailable', code, detail: null });
  expect(await s.sender.run(s.ticket, image, 'picker')).toBeUndefined();
  expect(s.execute).toHaveBeenCalledTimes(1);
  expect(s.t.send).toMatchObject({ route: 'direct', state: 'failed', sent: 'not-sent' });
});
test.each(['maker', 'picker'] as const)('pre-upload missing modules automatically fall back to %s with the same ticket', async route => {
  const s = setup(); s.execute.mockReset().mockResolvedValueOnce({ nonce, fingerprint: null, status: 'unavailable', code: 'modules-missing' });
  expect(await s.sender.run(s.ticket, image, route)).toMatchObject({ nonce, id, route });
  expect(s.execute).toHaveBeenCalledTimes(1); expect(s.t.send?.route).toBe(route);
});
test.each(['resolve', 'send'] as const)('module-shape detail reaches the diagnostics file from %s', async phase => {
  const s = setup(), detail = 'Collections.Chat.getActive/active/models missing';
  const unavailable = { nonce, fingerprint: null, status: 'unavailable', code: 'module-shape', detail };
  s.execute.mockReset();
  if (phase === 'resolve') s.execute.mockResolvedValueOnce(unavailable);
  else s.execute.mockResolvedValueOnce(s.resolved).mockResolvedValueOnce({ ...s.sent, ...unavailable, outcome: 'not-sent', uploaded: false, attempted: false, ack: null, type: null, to: null });
  expect(await s.sender.run(s.ticket, image, 'picker')).toMatchObject({ route: 'picker' });
  const records = readFileSync(join(directory, 'diagnostics', 'sticker-sends.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(records.at(-1)).toMatchObject({ route: 'direct', phase, outcome: 'fallback', code: 'module-shape', detail });
});

test('shape results require a detail and reject arbitrary page text', () => {
  const s = setup();
  const unavailable = { nonce, fingerprint: null, status: 'unavailable', code: 'module-shape' };
  for (const detail of [undefined, null, 'PRIVATE-CHAT-NAME', 'Collections.Chat.get missing: PRIVATE']) {
    expect(directResolveSchema.safeParse({ ...unavailable, detail }).success).toBe(false);
    expect(directSendSchema.safeParse({ ...s.sent, code: 'module-shape', detail, outcome: 'unknown' }).success).toBe(false);
  }
  expect(directResolveSchema.safeParse({ ...unavailable, detail: 'Collections.Chat.get missing' }).success).toBe(true);
});
test('direct fallback leaves IPC time for a cold-picker result at the lookup cap', async () => {
  vi.useFakeTimers();
  const s = setup();
  s.execute.mockReset().mockResolvedValueOnce({ nonce, fingerprint: null, status: 'unavailable', code: 'modules-missing' });
  expect(await s.sender.run(s.ticket, image, 'picker')).toMatchObject({ route: 'picker', nonce });
  await vi.advanceTimersByTimeAsync(STICKER_PICKER_LOOKUP_MS);
  expect(s.t.prepared(nonce, true, snapshot)).toMatchObject({ route: 'picker', nonce });
  expect(s.t.authorize(nonce, snapshot)).toBe(true);
  s.t.result(nonce, true, true);
  expect(s.t.send).toMatchObject({ route: 'picker', state: 'sent', sent: 'confirmed' });
});
test('send-phase shape loss can fall back only before upload/send; uploaded failures never fall back', async () => {
  for (const uploaded of [false, true]) {
    const s = setup(); s.execute.mockReset().mockResolvedValueOnce(s.resolved).mockResolvedValueOnce({ ...s.sent, status: uploaded ? 'finished' : 'unavailable', outcome: 'not-sent', code: 'module-shape', detail: 'Collections.Chat.get missing', uploaded, attempted: false, ack: null, type: null, to: null });
    const fallback = await s.sender.run(s.ticket, image, 'picker');
    expect(Boolean(fallback)).toBe(!uploaded);
    expect(s.t.send).toMatchObject(uploaded ? { route: 'direct', state: 'failed', sent: 'not-sent' } : { route: 'picker', state: 'finding' });
    rmSync(directory, { recursive: true, force: true });
  }
});
test.each(['resolve', 'send'] as const)('kill switch before %s dispatch stops new direct sends', async phase => {
  const s = setup(), held = deferred<unknown>();
  s.execute.mockReset().mockImplementationOnce(() => held.promise);
  if (phase === 'resolve') s.disable();
  const running = s.sender.run(s.ticket, image, 'picker');
  if (phase === 'send') { s.disable(); held.resolve(s.resolved); }
  await running;
  expect(s.execute).toHaveBeenCalledTimes(phase === 'resolve' ? 0 : 1);
  expect(s.t.send).toMatchObject({ state: 'failed', sent: 'not-sent' });
});
test.each([{ name: 'Changed' }, { chatId: '456@c.us', settingsId: '456@c.us' }, { revision: '2' }])('destination change while resolving aborts without upload: %j', async change => {
  const s = setup(), held = deferred<unknown>(); s.execute.mockReset().mockImplementationOnce(() => held.promise);
  const running = s.sender.run(s.ticket, image, 'picker'); s.change(change); held.resolve(s.resolved); await running;
  expect(s.execute).toHaveBeenCalledTimes(1); expect(s.t.send?.state).toBe('cancelled');
});
test('wrong descriptor/title never reaches send and unknown/mismatched model outcomes never fallback', async () => {
  const s = setup(); s.execute.mockReset().mockResolvedValueOnce({ ...s.resolved, destination: { ...destination, wid: '456@c.us' } });
  await s.sender.run(s.ticket, image, 'maker'); expect(s.execute).toHaveBeenCalledTimes(1); expect(s.t.send?.sent).toBe('not-sent');
  for (const change of [{ to: '456@c.us' }, { nonce: '550e8400-e29b-41d4-a716-446655440001' }, { fingerprint: `${DIRECT_SHAPE}|2.3000.1` }, { ack: 0 }]) {
    rmSync(directory, { recursive: true, force: true }); const next = setup(); next.execute.mockReset().mockResolvedValueOnce(next.resolved).mockResolvedValueOnce({ ...next.sent, ...change });
    expect(await next.sender.run(next.ticket, image, 'maker')).toBeUndefined(); expect(next.t.send).toMatchObject({ route: 'direct', state: 'failed', sent: 'unknown' });
  }
});
test('an uncertain send timeout consumes the attempt and ignores a late result after a new click', async () => {
  vi.useFakeTimers(); const s = setup(), held = deferred<unknown>();
  s.execute.mockReset().mockResolvedValueOnce(s.resolved).mockImplementationOnce(() => held.promise);
  const running = s.sender.run(s.ticket, image, 'picker');
  await vi.advanceTimersByTimeAsync(30_001); await running;
  expect(s.t.send).toMatchObject({ state: 'failed', sent: 'unknown' }); expect(s.execute).toHaveBeenCalledTimes(2);
  const newNonce = '550e8400-e29b-41d4-a716-446655440001';
  s.t.begin(id, newNonce, s.t.destinationToken(snapshot), snapshot, Date.now(), 'direct');
  held.resolve(s.sent); await Promise.resolve(); await Promise.resolve();
  expect(s.t.send).toMatchObject({ nonce: newNonce, state: 'preparing' });
  s.t.directResult(nonce, 'confirmed'); expect(s.t.send?.nonce).toBe(newNonce);
});
test('owner-only direct diagnostics contain structural fields and no identifiers/bytes/names', () => {
  setup(); new StickerSendDiagnostics(directory).appendDirect({ route: 'direct', phase: 'send', elapsedMs: 1600, outcome: 'confirmed', code: 'none', fingerprint });
  const path = join(directory, 'diagnostics', 'sticker-sends.log'), text = readFileSync(path, 'utf8');
  expect(statSync(path).mode & 0o777).toBe(0o600); expect(statSync(join(directory, 'diagnostics')).mode & 0o777).toBe(0o700);
  for (const secret of [nonce, destination.wid, destination.title, id, bytes.toString('base64')]) expect(text).not.toContain(secret);
  new StickerSendDiagnostics(directory).appendDirect({ route: 'direct', phase: 'send', elapsedMs: 1, outcome: 'unknown', code: 'page-error', fingerprint, privateName: 'bad' } as any);
  expect(readFileSync(path, 'utf8')).toBe(text);
});

test('a validated version/shape change before upload falls back with its new fingerprint', async () => {
  const s = setup(), nextFingerprint = `${DIRECT_SHAPE}|2.3000.1030000001`;
  s.execute.mockReset().mockResolvedValueOnce(s.resolved).mockResolvedValueOnce({ ...s.sent, fingerprint: nextFingerprint, status: 'unavailable', outcome: 'not-sent', code: 'module-shape', detail: 'fingerprint changed', uploaded: false, attempted: false, ack: null, type: null, to: null });
  expect(await s.sender.run(s.ticket, image, 'picker')).toMatchObject({ route: 'picker', nonce });
  expect(readFileSync(join(directory, 'diagnostics', 'sticker-sends.log'), 'utf8')).toContain(nextFingerprint);
});
