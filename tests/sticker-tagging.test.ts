import { afterEach, expect, test, vi } from 'vitest';
import { actionSchema, initialState, preferencesSchema, type State, type Sticker, type Status } from '../src/shared/model';
import { applyStickerTags, parseStickerTags, requestStickerTags, StickerTagQueue, stickerTagPrompt } from '../src/main/sticker-tagging';
import { ProviderError, type GenerateInput } from '../src/main/providers';
import { StatusCache, statusUpdate } from '../src/core/status';
import { setPreferences } from '../src/core/settings';
const group = '550e8400-e29b-41d4-a716-446655440000';
const terms = 'happy, feliz, smile, sonrisa, cartoon, dibujo, thanks, gracias, greeting, saludo, animated, animado';
const output = JSON.stringify({ searchTerms: terms, groups: ['Favorites'] });
const sticker = (n: number): Sticker => ({ id: n.toString(16).padStart(64, '0'), searchTerms: '', groups: [], kind: 'static', size: 12, firstSeen: n, lastSeen: n });
function setup(count = 6, options: Partial<ConstructorParameters<typeof StickerTagQueue>[0]> = {}) {
  let state = initialState(); state.global.aiFeatures = true; state.stickers = Array.from({ length: count }, (_, i) => sticker(i + 1)); state.stickerGroups = [{ id: group, name: 'Favorites' }];
  const dispatch = options.dispatch ?? vi.fn(async () => output), publish = vi.fn();
  const queue = new StickerTagQueue({ state: () => state, update: mutate => { const next = structuredClone(state); mutate(next); state = next; }, key: () => 'secret-key', images: async () => [{ mime: 'image/png', data: 'AAAA' }], dispatch, publish, ...options });
  queues.push(queue);
  return { queue, dispatch, publish, get state() { return state; }, mutate: (mutate: (s: State) => void) => { mutate(state); } };
}
const queues: StickerTagQueue[] = [];
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
afterEach(() => { queues.splice(0).forEach(q => q.close()); vi.useRealTimers(); });
test('strict output validation, existing groups only, and bounded terms', () => {
  const groups = [{ id: group, name: 'Favorites' }];
  expect(parseStickerTags(output, groups)).toEqual({ searchTerms: terms, groups: [group] });
  for (const value of ['{"searchTerms":"cat","groups":[]}', output.replace('Favorites', 'Invented'), output.replace('}', ',"send":true}'), '```json\n' + output + '\n```']) expect(() => parseStickerTags(value, groups)).toThrow();
  expect(parseStickerTags(JSON.stringify({ searchTerms: Array(10).fill('x'.repeat(500)).join(', '), groups: [] }), groups).searchTerms.length).toBe(4000);
});
test('tag prompt excludes all conversation records and uses five bounded tag examples', () => {
  const s = initialState(); s.stickers = Array.from({ length: 10 }, (_, i) => ({ ...sticker(i), searchTerms: `tag${i}` }));
  s.conversations['private contact'] = ['a'.repeat(64)]; s.profiles.private = { description: 'private messages', samples: 5, source: 'observed', updatedAt: 1 };
  const prompt = stickerTagPrompt(s, s.stickers[0], 'existing terms');
  expect(JSON.parse(prompt.input)).toMatchObject({ currentTerms: 'existing terms', tagStyleExamples: ['tag0', 'tag1', 'tag2', 'tag3', 'tag4'] });
  expect(JSON.stringify(prompt)).not.toMatch(/private contact|private messages/);
});
test('fill-only and add-only results preserve user terms and removed groups', () => {
  const env = setup(2); env.mutate(s => { s.stickers[1].searchTerms = 'manual'; });
  expect(applyStickerTags(env.state, env.state.stickers[1].id, { searchTerms: terms, groups: [group] })).toBe(false);
  expect(env.state.stickers[1].searchTerms).toBe('manual');
  env.mutate(s => { s.stickers[0].groups = [group]; });
  expect(applyStickerTags(env.state, env.state.stickers[0].id, { searchTerms: terms, groups: ['gone'] })).toBe(true);
  expect(env.state.stickers[0].groups).toEqual([group]);
});
test('three concurrent requests share the queue, Stop aborts active and pending, late responses cannot save', async () => {
  const pending: { request: GenerateInput; resolve(text: string): void }[] = [];
  const dispatch = vi.fn((request: GenerateInput) => new Promise<string>(resolve => pending.push({ request, resolve })));
  const env = setup(6, { dispatch }); env.queue.enqueue(env.state.stickers.map(s => s.id)); await settle();
  expect(pending).toHaveLength(3); expect(Object.values(env.queue.items).filter(s => s.state === 'working')).toHaveLength(3);
  pending[0].resolve(output); await settle(); expect(pending).toHaveLength(4); expect(env.state.stickers[0].searchTerms).toBe(terms);
  env.queue.stop(); expect(pending.slice(1).every(p => p.request.signal?.aborted)).toBe(true);
  pending.slice(1).forEach(p => p.resolve(output)); await settle(); expect(env.state.stickers.filter(s => s.searchTerms)).toHaveLength(1); expect(env.queue.progress?.state).toBe('stopped');
});
test('retry runs only failed stickers and maintains saved successes', async () => {
  let call = 0; const dispatch = vi.fn(async () => { if (++call === 2) throw new Error('bad output'); return output; });
  const env = setup(3, { dispatch }); env.queue.enqueue(env.state.stickers.map(s => s.id)); await settle();
  expect(env.queue.progress).toMatchObject({ state: 'partial', tagged: 2, failed: 1 });
  env.queue.retry(); await settle(); expect(dispatch).toHaveBeenCalledTimes(4); expect(env.state.stickers.every(s => s.searchTerms)).toBe(true);
});
test('blocking retries exclude a withdrawn request that is still settling', async () => {
  const pending: { resolve(text: string): void; reject(error: Error): void }[] = [];
  const dispatch = vi.fn(() => pending.length < 3
    ? new Promise<string>((resolve, reject) => pending.push({ resolve, reject })) : Promise.resolve(output));
  const env = setup(3, { dispatch }), ids = env.state.stickers.map(s => s.id);
  env.queue.enqueue(ids); await settle();
  env.queue.remove(ids[0]);
  pending[1].reject(new ProviderError('quota', false, 'quota')); await settle();
  expect(env.queue.progress).toMatchObject({ state: 'blocked', failed: 2 });
  env.queue.retry(); await settle();
  pending[0].resolve(output); pending[2].resolve(output); await settle();
  expect(dispatch).toHaveBeenCalledTimes(5);
  expect(env.state.stickers[0].searchTerms).toBe('');
  expect(env.state.stickers.slice(1).every(s => s.searchTerms === terms)).toBe(true);
  expect(env.queue.progress).toMatchObject({ state: 'done', failed: 0, tagged: 2 });
});
test('a success awaiting finally cleanup cannot become a phantom blocked failure', async () => {
  let keyAvailable = true, blocked = false;
  const env = setup(2, { key: () => keyAvailable ? 'key' : undefined, publish: () => {
    if (!blocked && env.queue.items[env.state.stickers[0].id]?.state === 'done') {
      blocked = true; keyAvailable = false;
      // Publish runs before the successful job releases its active slot.
      env.queue.enqueue([env.state.stickers[1].id]);
    }
  } });
  env.queue.enqueue([env.state.stickers[0].id]); await settle();
  expect(env.queue.progress).toMatchObject({ state: 'blocked', tagged: 1, failed: 1 });
  expect(env.queue.items[env.state.stickers[0].id]?.state).toBe('done');
  keyAvailable = true; env.queue.retry(); await settle();
  expect(env.dispatch).toHaveBeenCalledTimes(2);
  expect(env.queue.progress).toMatchObject({ state: 'done', tagged: 1, failed: 0 });
  env.queue.retry(); await settle(); expect(env.dispatch).toHaveBeenCalledTimes(2);
});
test('retry applies current draft exclusions even after results were dismissed', async () => {
  let fail = true;
  const env = setup(2, { dispatch: vi.fn(async () => { if (fail) throw new Error('failed'); return output; }) });
  const ids = env.state.stickers.map(s => s.id);
  env.queue.enqueue(ids); await settle(); env.queue.dismiss();
  expect(env.queue.items).toEqual({}); fail = false;
  // The draft snapshot protects a candidate even if its text-edit notification was missed.
  env.queue.retry([ids[0]]); await settle();
  expect(env.dispatch).toHaveBeenCalledTimes(3);
  expect(env.state.stickers[0].searchTerms).toBe(''); expect(env.state.stickers[1].searchTerms).toBe(terms);
  env.queue.retry(); await settle(); expect(env.dispatch).toHaveBeenCalledTimes(3);
  env.queue.enqueue([ids[0]]); await settle();
  expect(env.state.stickers[0].searchTerms).toBe(terms);
});
test('pending work rechecks persisted terms at dispatch without waiting for observe', async () => {
  const pending: ((text: string) => void)[] = [];
  const env = setup(4, { dispatch: vi.fn(() => new Promise<string>(resolve => pending.push(resolve))) });
  env.queue.enqueue(env.state.stickers.map(s => s.id)); await settle();
  env.mutate(s => { s.stickers[3].searchTerms = 'saved manually'; });
  pending.forEach(resolve => resolve(output)); await settle();
  expect(env.dispatch).toHaveBeenCalledTimes(3);
  expect(env.state.stickers[3].searchTerms).toBe('saved manually');
  expect(env.queue.progress).toMatchObject({ state: 'done', completed: 4, tagged: 3, failed: 0 });
});
test('retry prunes deleted and persisted candidates without waiting for observe', async () => {
  const env = setup(2, { dispatch: vi.fn(async () => { throw new Error('failed'); }) });
  env.queue.enqueue(env.state.stickers.map(s => s.id)); await settle();
  env.mutate(s => { s.stickers[0].searchTerms = 'manual'; s.stickers.pop(); });
  env.queue.retry(); await settle();
  expect(env.dispatch).toHaveBeenCalledTimes(2); expect(env.queue.progress).toBeNull();
});
test('automatic additions never re-admit withdrawn stickers; a fresh explicit action can', async () => {
  const env = setup(0);
  env.mutate(s => { s.global.automaticStickerTags = true; }); env.queue.observe();
  const next = sticker(1); env.queue.remove(next.id);
  env.mutate(s => { s.stickers.push(next); }); env.queue.observe(); await settle();
  expect(env.dispatch).not.toHaveBeenCalled();
  env.queue.enqueue([next.id]); await settle(); expect(env.dispatch).toHaveBeenCalledTimes(1);
});
test('retrying a published failure waits for cleanup without losing its retry slot', async () => {
  let fail = true, retried = false;
  const env = setup(1, { dispatch: vi.fn(async () => { if (fail) { fail = false; throw new Error('failed'); } return output; }), publish: () => {
    if (!retried && env.queue.items[env.state.stickers[0].id]?.state === 'failed') {
      retried = true; env.queue.retry();
    }
  } });
  env.queue.enqueue([env.state.stickers[0].id]); await settle();
  expect(env.dispatch).toHaveBeenCalledTimes(2);
  expect(env.queue.progress).toMatchObject({ state: 'done', total: 1, completed: 1, tagged: 1, failed: 0 });
});
test('provider backoff revalidates persisted terms before automatically resuming a request', async () => {
  const env = setup(1, { dispatch: vi.fn(async () => { throw new ProviderError('429', true, 'rate-limit'); }), wait: async () => {
    env.mutate(s => { s.stickers[0].searchTerms = 'saved during backoff'; });
  } });
  env.queue.enqueue([env.state.stickers[0].id]); await settle();
  expect(env.dispatch).toHaveBeenCalledTimes(1);
  expect(env.queue.progress).toMatchObject({ state: 'done', completed: 1, tagged: 0, failed: 0 });
  env.queue.retry(); await settle(); expect(env.dispatch).toHaveBeenCalledTimes(1);
});
test('blocking errors erase invalid pending tiles without making them retryable', async () => {
  const pending: { resolve(text: string): void; reject(error: Error): void }[] = [];
  const env = setup(4, { dispatch: vi.fn(() => new Promise<string>((resolve, reject) => pending.push({ resolve, reject }))) });
  const ids = env.state.stickers.map(s => s.id);
  env.queue.enqueue(ids); await settle(); env.mutate(s => { s.stickers[3].searchTerms = 'manual'; });
  pending[0].reject(new ProviderError('quota', false, 'quota')); await settle();
  expect(env.queue.items[ids[3]]).toBeUndefined();
  expect(env.queue.progress).toMatchObject({ state: 'blocked', failed: 3 });
  pending.slice(1).forEach(p => p.resolve(output)); await settle();
});
test('retry actions require a validated current draft exclusion snapshot', () => {
  const id = sticker(1).id;
  expect(actionSchema.parse({ type: 'retryStickerTags', excludedIds: [id] })).toEqual({ type: 'retryStickerTags', excludedIds: [id] });
  expect(actionSchema.safeParse({ type: 'retryStickerTags' }).success).toBe(false);
  expect(actionSchema.safeParse({ type: 'retryStickerTags', excludedIds: ['not a sticker'] }).success).toBe(false);
});
test('automatic work preserves unresolved failures and retrying during it replaces their outcomes', async () => {
  vi.useFakeTimers();
  const pending: { request: GenerateInput; resolve(text: string): void }[] = [];
  let fail = true;
  const env = setup(2, { dispatch: vi.fn((request: GenerateInput) => {
    if (fail) { fail = false; return Promise.reject(new Error('failed')); }
    return new Promise<string>(resolve => pending.push({ request, resolve }));
  }) });
  const ids = env.state.stickers.map(s => s.id);
  env.mutate(s => { s.global.automaticStickerTags = true; }); env.queue.observe();
  env.queue.enqueue(ids); await settle(); pending[0].resolve(output); await settle();
  expect(env.queue.progress).toMatchObject({ state: 'partial', total: 2, tagged: 1, failed: 1 });
  env.mutate(s => { s.stickers.push(sticker(3)); }); env.queue.observe(); await settle();
  expect(env.queue.progress).toMatchObject({ state: 'running', total: 3, completed: 2, tagged: 1, failed: 1 });
  expect(env.queue.items[ids[0]].state).toBe('failed');
  env.queue.retry(); await settle();
  expect(env.queue.progress).toMatchObject({ state: 'running', total: 3, completed: 1, tagged: 1, failed: 0 });
  expect(pending).toHaveLength(3);
  pending.slice(1).forEach(p => p.resolve(output)); await settle();
  expect(env.state.stickers.every(s => s.searchTerms)).toBe(true);
  expect(env.queue.progress).toMatchObject({ state: 'done', total: 3, tagged: 3, failed: 0 });
  await vi.advanceTimersByTimeAsync(3000); expect(env.queue.progress).toBeNull();
});
test('successful automatic work retains the failed result and retry path after completion', async () => {
  vi.useFakeTimers(); let fail = true;
  const env = setup(1, { dispatch: vi.fn(async () => { if (fail) { fail = false; throw new Error('failed'); } return output; }) });
  env.mutate(s => { s.global.automaticStickerTags = true; }); env.queue.observe();
  env.queue.enqueue([env.state.stickers[0].id]); await settle();
  env.mutate(s => { s.stickers.push(sticker(2)); }); env.queue.observe(); await settle();
  expect(env.queue.progress).toMatchObject({ state: 'partial', total: 2, tagged: 1, failed: 1 });
  await vi.advanceTimersByTimeAsync(3000);
  expect(env.queue.progress?.state).toBe('partial');
  env.queue.retry(); await settle();
  expect(env.dispatch).toHaveBeenCalledTimes(3); expect(env.state.stickers.every(s => s.searchTerms)).toBe(true);
  expect(env.queue.progress).toMatchObject({ state: 'done', total: 1, tagged: 1, failed: 0 });
});
test('new manual batches retain other failures, but deleted or manually tagged failures are withdrawn', async () => {
  let fail = true;
  const env = setup(3, { dispatch: vi.fn(async () => { if (fail) throw new Error('failed'); return output; }) });
  const ids = env.state.stickers.map(s => s.id);
  env.queue.enqueue(ids.slice(0, 2)); await settle(); fail = false;
  env.queue.enqueue([ids[2]]); await settle();
  expect(env.queue.progress).toMatchObject({ state: 'partial', tagged: 1, failed: 2 });
  env.mutate(s => { s.stickers[0].searchTerms = 'manual'; s.stickers.splice(1, 1); }); env.queue.observe();
  expect(env.queue.items[ids[0]]).toBeUndefined(); expect(env.queue.items[ids[1]]).toBeUndefined();
  env.queue.retry(); await settle(); expect(env.dispatch).toHaveBeenCalledTimes(3);
});
test('editor suggestions leave the completed batch dismissal timer running', async () => {
  vi.useFakeTimers(); const env = setup(2);
  env.queue.enqueue([env.state.stickers[0].id]); await settle();
  expect(env.queue.progress?.state).toBe('done');
  await vi.advanceTimersByTimeAsync(2000);
  env.queue.suggest(env.state.stickers[1].id, 'editor', ''); await settle();
  await vi.advanceTimersByTimeAsync(1000);
  expect(env.queue.progress).toBeNull(); expect(env.queue.items[env.state.stickers[1].id].state).toBe('suggested');
});
test('typing and deletion withdraw active jobs before their responses; automatic captures only new ids', async () => {
  const pending: ((text: string) => void)[] = [];
  const env = setup(3, { dispatch: vi.fn(() => new Promise<string>(resolve => pending.push(resolve))) });
  env.queue.enqueue(env.state.stickers.map(s => s.id)); await settle();
  env.queue.remove(env.state.stickers[0].id); env.mutate(s => { s.stickers[0].searchTerms = 'user draft'; s.stickers.splice(1, 1); }); env.queue.observe();
  pending.forEach(resolve => resolve(output)); await settle(); expect(env.state.stickers[0].searchTerms).toBe('user draft'); expect(env.state.stickers).toHaveLength(2);
  env.mutate(s => { s.global.automaticStickerTags = true; }); env.queue.observe(); await settle(); expect(pending).toHaveLength(3);
  env.mutate(s => { s.stickers.push(sticker(9)); }); env.queue.observe(); await settle(); expect(pending).toHaveLength(4);
});
test('blocking errors pause automatic tagging; toggling or manual success resumes without processing missed backlog', async () => {
  const env = setup(1, { dispatch: vi.fn(async () => { throw new ProviderError('quota', false, 'quota'); }) });
  env.mutate(s => { s.global.automaticStickerTags = true; }); env.queue.observe(); env.mutate(s => { s.stickers.push(sticker(2)); }); env.queue.observe(); await settle();
  expect(env.queue.pause).toBe('quota'); expect(env.queue.progress?.state).toBe('blocked');
  env.mutate(s => { s.stickers.push(sticker(3)); }); env.queue.observe(); await settle(); expect(env.dispatch).toHaveBeenCalledTimes(1);
  env.mutate(s => { s.global.automaticStickerTags = false; }); env.queue.observe(); env.mutate(s => { s.global.automaticStickerTags = true; }); env.queue.observe();
  expect(env.queue.pause).toBeNull(); expect(env.dispatch).toHaveBeenCalledTimes(1);
});
test('no key dispatches nothing and default/patch schemas preserve old settings and global-only permissions', async () => {
  const env = setup(2, { key: () => undefined }); env.queue.enqueue(env.state.stickers.map(s => s.id)); await settle();
  expect(env.dispatch).not.toHaveBeenCalled(); expect(env.queue.progress?.error).toBe('no-key');
  const { automaticStickerTags: _removed, ...old } = initialState().global;
  expect(preferencesSchema.parse(old).automaticStickerTags).toBe(false);
  expect(actionSchema.parse({ type: 'preferences', scope: 'global', patch: { tone: 'friendly' } })).toMatchObject({ patch: { tone: 'friendly' } });
  expect(actionSchema.safeParse({ type: 'preferences', scope: '123@c.us', patch: { automaticStickerTags: true } }).success).toBe(false);
  expect(() => setPreferences(env.state, '123@c.us', { automaticStickerTags: true })).toThrow();
});
test('rate limits back off silently within bounds and invalid JSON is repaired once', async () => {
  const request: GenerateInput = { provider: 'openai', model: 'gpt-6-luna', key: 'key', system: 'tags', input: '{}', signal: new AbortController().signal };
  let count = 0; const dispatch = vi.fn(async () => { if (++count <= 2) throw new ProviderError('429', true, 'rate-limit'); return count === 3 ? '{bad' : output; });
  const wait = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
  await expect(requestStickerTags(request, [{ id: group, name: 'Favorites' }], dispatch, wait)).resolves.toMatchObject({ searchTerms: terms });
  expect(wait.mock.calls.map(args => args[0])).toEqual([1000, 2000]); expect(dispatch).toHaveBeenCalledTimes(4);
  const always = vi.fn(async () => { throw new ProviderError('429', true, 'rate-limit'); });
  await expect(requestStickerTags(request, [], always, wait)).rejects.toThrow('429'); expect(always).toHaveBeenCalledTimes(4);
});
test('editor uses the shared queue but returns a draft without saving or batch progress', async () => {
  const env = setup(1); const id = env.state.stickers[0].id;
  env.queue.suggest(id, '550e8400-e29b-41d4-a716-446655440003', 'old text'); await settle();
  expect(env.queue.items[id]).toMatchObject({ state: 'suggested', suggestion: { searchTerms: terms, groups: [group] } }); expect(env.state.stickers[0].searchTerms).toBe(''); expect(env.queue.progress).toBeNull();
});
test('status sends item deltas and reconstructs removed items without resending the library', () => {
  const env = setup(1); const id = env.state.stickers[0].id;
  const base: Status = { sequence: 1, state: env.state, runtimePaused: false, chat: { chatId: null, name: '', kind: 'direct', ready: false, canSendSticker: false }, keys: { openai: false, anthropic: false }, secureStorage: false, fixture: true, message: '', pending: null, stickerTags: { [id]: { state: 'queued' } } };
  const next: Status = { ...base, sequence: 2, stickerTags: { [id]: { state: 'working' } } }; const cache = new StatusCache(); cache.accept(statusUpdate(base));
  const delta = statusUpdate(next, base.state, base); expect(delta.state).toBeUndefined(); expect(delta.stickerTags).toBeUndefined(); expect(delta.stickerTagChanges?.upsert[id].state).toBe('working');
  expect(cache.accept(delta)?.stickerTags?.[id].state).toBe('working');
  expect(cache.accept(statusUpdate({ ...next, sequence: 3, stickerTags: {} }, next.state, next))?.stickerTags).toEqual({});
});
test('replacement suggestions wait for the cancelled request slot; typing removes both pending and stale work', async () => {
  const requests: { request: GenerateInput; resolve(text: string): void }[] = [];
  const env = setup(1, { dispatch: vi.fn((request: GenerateInput) => new Promise<string>(resolve => requests.push({ request, resolve }))) });
  const id = env.state.stickers[0].id;
  env.queue.suggest(id, 'one', 'first'); await settle();
  env.queue.suggest(id, 'two', 'second'); await settle(); expect(requests).toHaveLength(1); expect(requests[0].request.signal?.aborted).toBe(true);
  env.queue.remove(id); requests[0].resolve(output); await settle(); expect(requests).toHaveLength(1); expect(env.queue.items[id]).toBeUndefined();
});
test('manual success resumes a paused automatic queue without tagging an old backlog', async () => {
  let failed = true;
  const env = setup(1, { dispatch: vi.fn(async () => { if (failed) throw new ProviderError('offline', true, 'offline'); return output; }) });
  env.mutate(s => { s.global.automaticStickerTags = true; }); env.queue.observe();
  env.mutate(s => { s.stickers.push(sticker(2)); }); env.queue.observe(); await settle(); expect(env.queue.pause).toBe('offline');
  failed = false; env.queue.enqueue([env.state.stickers[0].id]); await settle(); expect(env.queue.pause).toBeNull();
  env.mutate(s => { s.stickers.push(sticker(3)); }); env.queue.observe(); await settle();
  expect(env.state.stickers[1].searchTerms).toBe(''); expect(env.state.stickers[2].searchTerms).toBe(terms);
});
test('backoff cancellation exits before dispatching another image request', async () => {
  vi.useFakeTimers(); const controller = new AbortController();
  const dispatch = vi.fn(async () => { throw new ProviderError('429', true, 'rate-limit'); });
  const result = requestStickerTags({ provider: 'openai', model: 'gpt-6-luna', key: 'key', system: 'tag', input: '{}', signal: controller.signal }, [], dispatch);
  const rejection = expect(result).rejects.toThrow('Cancelled'); await settle(); controller.abort(); await rejection; await vi.runAllTimersAsync(); expect(dispatch).toHaveBeenCalledTimes(1);
});
test('unavailable OS keyring sends nothing and offers key settings', async () => {
  const env = setup(1, { key: () => { throw new Error('keyring locked'); } });
  env.queue.enqueue([env.state.stickers[0].id]); await settle();
  expect(env.dispatch).not.toHaveBeenCalled(); expect(env.queue.progress?.error).toBe('no-key');
});

test.each(['success', 'quota'] as const)('batch completion ignores a delayed editor that later returns %s', async outcome => {
  vi.useFakeTimers();
  const pending: { resolve(text: string): void; reject(error: Error): void; request: GenerateInput }[] = [];
  const env = setup(2, { dispatch: vi.fn(request => new Promise<string>((resolve, reject) => pending.push({ request, resolve, reject }))) });
  const [batch, editor] = env.state.stickers.map(s => s.id);
  env.queue.enqueue([batch]); env.queue.suggest(editor, 'editor', ''); await settle();
  expect(pending).toHaveLength(2);
  pending[0].resolve(output); await settle();
  expect(env.queue.progress).toMatchObject({ state: 'done', completed: 1, total: 1, tagged: 1, failed: 0 });
  if (outcome === 'quota') pending[1].reject(new ProviderError('quota', false, 'quota'));
  else pending[1].resolve(output);
  await settle();
  expect(env.queue.progress).toMatchObject({ state: 'done', failed: 0 });
  expect(env.queue.items[editor]).toMatchObject({ state: outcome === 'quota' ? 'failed' : 'suggested', provider: 'openai' });
  await vi.advanceTimersByTimeAsync(3000);
  expect(env.queue.progress).toBeNull();
  expect(env.queue.items[editor]?.state).toBe(outcome === 'quota' ? 'failed' : 'suggested');
});
test('editor blocking errors cannot abort a running batch or pause automatic tagging', async () => {
  const pending: { resolve(text: string): void; reject(error: Error): void; request: GenerateInput }[] = [];
  const env = setup(4, { dispatch: vi.fn(request => new Promise<string>((resolve, reject) => pending.push({ request, resolve, reject }))) });
  env.mutate(s => { s.global.automaticStickerTags = true; }); env.queue.observe();
  const ids = env.state.stickers.map(s => s.id);
  env.queue.suggest(ids[0], 'editor', ''); env.queue.enqueue(ids.slice(1)); await settle();
  pending[0].reject(new ProviderError('quota', false, 'quota')); await settle();
  expect(env.queue.pause).toBeNull(); expect(env.queue.progress?.state).toBe('running');
  expect(pending).toHaveLength(4); expect(pending.slice(1).every(p => !p.request.signal?.aborted)).toBe(true);
  pending.slice(1).forEach(p => p.resolve(output)); await settle();
  expect(env.queue.progress).toMatchObject({ state: 'done', tagged: 3, failed: 0 });
});
test('batch blocking errors leave editor suggestions running through shared concurrency', async () => {
  const pending: { resolve(text: string): void; reject(error: Error): void; request: GenerateInput }[] = [];
  const env = setup(3, { dispatch: vi.fn(request => new Promise<string>((resolve, reject) => pending.push({ request, resolve, reject }))) });
  const ids = env.state.stickers.map(s => s.id);
  env.queue.enqueue([ids[0]]); env.queue.suggest(ids[1], 'editor', ''); await settle();
  pending[0].reject(new ProviderError('quota', false, 'quota')); await settle();
  expect(pending[1].request.signal?.aborted).toBe(false);
  env.queue.suggest(ids[2], 'another editor', ''); await settle(); expect(pending).toHaveLength(3);
  pending.slice(1).forEach(p => p.resolve(output)); await settle();
  expect(env.queue.progress).toMatchObject({ state: 'blocked', error: 'quota', failed: 1 });
  expect(env.queue.items[ids[1]].state).toBe('suggested');
});
test.each(['failed', 'quota'] as const)('automatic restart refreshes provider after an OpenAI %s result', async error => {
  const dispatch = vi.fn(async (request: GenerateInput) => { throw error === 'quota' ? new ProviderError('quota', false, 'quota') : new Error('failed'); });
  const env = setup(1, { dispatch });
  env.mutate(s => { s.global.automaticStickerTags = true; }); env.queue.observe();
  env.queue.enqueue([env.state.stickers[0].id]); await settle();
  env.mutate(s => { s.provider = 'anthropic'; }); env.queue.configurationChanged();
  env.mutate(s => { s.stickers.push(sticker(2)); }); env.queue.observe(); await settle();
  expect(dispatch.mock.calls.map(([r]) => r.provider)).toEqual(['openai', 'anthropic']);
  expect(env.queue.progress).toMatchObject({ provider: 'anthropic', failed: 1 });
  expect(env.queue.items[sticker(2).id]).toMatchObject({ provider: 'anthropic', state: 'failed' });
  expect(env.queue.items[sticker(1).id]).toBeUndefined();
});
test.each(['provider', 'key', 'model'] as const)('%s configuration change clears settled editor and batch errors and their retry attribution', async change => {
  let failure = true;
  const env = setup(2, { dispatch: vi.fn(async () => { if (failure) throw new ProviderError('auth', false, 'auth'); return output; }) });
  const ids = env.state.stickers.map(s => s.id);
  env.queue.suggest(ids[0], 'old editor', ''); await settle();
  env.queue.enqueue([ids[1]]); await settle();
  expect(env.queue.items[ids[0]]).toMatchObject({ error: 'auth', provider: 'openai' });
  if (change === 'provider') env.mutate(s => { s.provider = 'anthropic'; });
  if (change === 'model') env.mutate(s => { s.models.openai = 'new-model'; });
  // Key replacement uses this same configurationChanged entry point.
  env.queue.configurationChanged(); failure = false;
  expect(env.queue.items).toEqual({}); expect(env.queue.progress).toBeNull(); expect(env.queue.pause).toBeNull();
  env.queue.retry(); await settle(); expect(env.dispatch).toHaveBeenCalledTimes(2);
  env.queue.suggest(ids[0], 'new editor', ''); await settle();
  expect(env.queue.items[ids[0]]).toMatchObject({ state: 'suggested', provider: env.state.provider });
});
test.each(['partial', 'blocked'] as const)('withdrawing the last %s failure clears terminal progress without losing successful results', async terminal => {
  const env = setup(2, { dispatch: vi.fn(async request => {
    if (request.input.includes('fail')) throw terminal === 'blocked' ? new ProviderError('quota', false, 'quota') : new Error('failed');
    return output;
  }) });
  const ids = env.state.stickers.map(s => s.id);
  env.queue.enqueue([ids[0]]); await settle();
  env.mutate(s => { s.stickerGroups.push({ id: '550e8400-e29b-41d4-a716-446655440001', name: 'fail' }); });
  env.queue.enqueue([ids[1]]); await settle();
  expect(env.queue.progress?.state).toBe(terminal);
  env.queue.remove(ids[1]); expect(env.queue.progress).toBeNull();
  expect(env.state.stickers[0].searchTerms).toBe(terms);
  env.queue.retry(); await settle(); expect(env.dispatch).toHaveBeenCalledTimes(2);
});
test.each(['withdraw', 'delete'] as const)('removing the final failure from mixed results via %s retains a reconciled success strip', async removal => {
  let calls = 0;
  const env = setup(2, { dispatch: vi.fn(async () => { if (++calls === 2) throw new Error('failed'); return output; }) });
  const ids = env.state.stickers.map(s => s.id);
  env.queue.enqueue(ids); await settle();
  expect(env.queue.progress).toMatchObject({ state: 'partial', tagged: 1, failed: 1 });
  if (removal === 'delete') { env.mutate(s => { s.stickers.pop(); }); env.queue.observe(); }
  else env.queue.remove(ids[1]);
  expect(env.queue.progress).toMatchObject({ state: 'done', tagged: 1, failed: 0 });
});
test('exhausted rate limits retain their classification in editor, batch and automatic pause', async () => {
  const env = setup(2, { dispatch: vi.fn(async () => { throw new ProviderError('429', true, 'rate-limit'); }), wait: async () => {} });
  const ids = env.state.stickers.map(s => s.id);
  env.queue.suggest(ids[0], 'editor', ''); await settle();
  expect(env.queue.items[ids[0]]).toMatchObject({ state: 'failed', error: 'rate-limit', provider: 'openai' });
  env.mutate(s => { s.global.automaticStickerTags = true; }); env.queue.observe();
  env.queue.enqueue([ids[1]]); await settle();
  expect(env.dispatch).toHaveBeenCalledTimes(8);
  expect(env.queue.progress).toMatchObject({ state: 'blocked', error: 'rate-limit', provider: 'openai' });
  expect(env.queue.pause).toBe('rate-limit');
});
test('new automatic work reattributes progress while keeping older failure items with their original provider', async () => {
  const dispatch = vi.fn(async (request: GenerateInput) => {
    if (request.provider === 'openai') throw new Error('failed');
    throw new ProviderError('quota', false, 'quota');
  });
  const env = setup(1, { dispatch });
  env.mutate(s => { s.global.automaticStickerTags = true; }); env.queue.observe();
  env.queue.enqueue([sticker(1).id]); await settle();
  expect(env.queue.progress).toMatchObject({ state: 'partial', provider: 'openai' });
  // Exercise restarting retained results independently of configuration cleanup.
  env.mutate(s => { s.provider = 'anthropic'; s.stickers.push(sticker(2)); }); env.queue.observe(); await settle();
  expect(dispatch.mock.calls.map(([r]) => r.provider)).toEqual(['openai', 'anthropic']);
  expect(env.queue.progress).toMatchObject({ state: 'blocked', provider: 'anthropic', failed: 2 });
  expect(env.queue.items[sticker(1).id]).toMatchObject({ state: 'failed', provider: 'openai' });
  expect(env.queue.items[sticker(2).id]).toMatchObject({ state: 'failed', provider: 'anthropic' });
});

test('AI off rejects manual and automatic tags; turning off aborts the queue and discards late output', async () => {
  let finish!: (text: string) => void;
  const dispatch = vi.fn((request: GenerateInput) => new Promise<string>(resolve => { finish = resolve; }));
  const f = setup(2, { dispatch });
  f.mutate(s => { s.global.aiFeatures = false; s.global.automaticStickerTags = true; });
  f.queue.observe(); f.queue.enqueue([f.state.stickers[0].id]); f.queue.suggest(f.state.stickers[1].id, 'nonce', '');
  await settle(); expect(dispatch).not.toHaveBeenCalled();
  f.mutate(s => { s.global.aiFeatures = true; }); f.queue.observe(); f.queue.enqueue([f.state.stickers[0].id]); await settle();
  expect(dispatch).toHaveBeenCalledTimes(1); const signal = dispatch.mock.calls[0][0].signal!;
  f.mutate(s => { s.global.aiFeatures = false; }); f.queue.observe(); expect(signal.aborted).toBe(true);
  finish(output); await settle(); expect(f.state.stickers.every(s => s.searchTerms === '')).toBe(true);
  f.mutate(s => { s.global.aiFeatures = true; }); f.queue.observe(); await settle(); expect(dispatch).toHaveBeenCalledTimes(1);
  expect(f.state.global.automaticStickerTags).toBe(true);
});
