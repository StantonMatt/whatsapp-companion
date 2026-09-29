import { describe, test, expect, vi } from 'vitest';
import { listModels, ModelCatalog } from '../src/main/models';
import { actionSchema, initialState, stateSchema, type ModelOption } from '../src/shared/model';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const key = 'synthetic-key-never-live';

describe('provider model discovery', () => {
  test('OpenAI offers the modern text family and excludes unrelated models; keys stay in request headers', async () => {
    const fetcher = vi.fn(async () => response({ data: [{ id: 'gpt-6-luna' }, { id: 'text-embedding-3-small' }, { id: 'gpt-6-astra' }, { id: 'gpt-6-luna' }, { id: 'gpt-6-sol' }, { id: 'gpt-4o' }, { id: 'gpt-audio' }] }));
    const models = await listModels('openai', key, undefined, fetcher);
    expect(models.map(m => m.id)).toEqual(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']);
    expect(fetcher).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({ method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${key}` } }));
    expect(JSON.stringify(models)).not.toContain(key);
  });
  test('Anthropic loads every page, preserves display names and uses the documented cursor', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }], has_more: true, last_id: 'claude-opus-5-5' }))
      .mockResolvedValueOnce(response({ data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }], has_more: false, last_id: 'claude-sonnet-5-5' }));
    expect(await listModels('anthropic', key, undefined, fetcher)).toEqual([{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }, { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }]);
    expect(fetcher).toHaveBeenNthCalledWith(2, 'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-opus-5-5', expect.objectContaining({ headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, redirect: 'error' }));
  });
  test.each([401, 403, 429, 503])('reports HTTP %i without exposing response bodies', async status => {
    const fetcher = vi.fn(async () => response({ error: `secret ${key}` }, status));
    const result = await new ModelCatalog((provider, credential, signal) => listModels(provider, credential, signal, fetcher)).load('openai', key);
    expect(result.models).toEqual([]); expect(result.error).toContain(String(status)); expect(result.error).not.toContain(key);
    if (status === 403) expect(result.error).toContain('read access to Models');
  });
  test('hides transport and malformed JSON error details', async () => {
    for (const fetcher of [vi.fn(async () => { throw new Error(`Models: ${key}`); }), vi.fn(async () => new Response(key))]) {
      await expect(listModels('openai', key, undefined, fetcher)).rejects.toThrow('Unable to connect');
    }
  });
  test('rejects malformed catalogs and repeated or missing pagination cursors', async () => {
    for (const body of [{ data: [{ id: '<invalid>' }] }, { data: [], has_more: true }, { data: [{ id: 'claude-model' }], has_more: true, last_id: 'claude-model' }]) {
      const fetcher = vi.fn(async () => response(body));
      await expect(listModels('anthropic', key, undefined, fetcher)).rejects.toThrow(/invalid model list|incomplete pagination/);
      expect(fetcher.mock.calls.length).toBeLessThanOrEqual(2);
    }
  });
  test('accepts an empty catalog and preserves saved IDs without listing custom fine-tunes', async () => {
    expect(await listModels('openai', key, undefined, vi.fn(async () => response({ data: [] })))).toEqual([]);
    const model = `ft:gpt-model:organization:${'x'.repeat(110)}`;
    expect(await listModels('openai', key, undefined, vi.fn(async () => response({ data: [{ id: model }] })))).toEqual([]);
    expect(actionSchema.safeParse({ type: 'provider', provider: 'openai', model }).success).toBe(true);
    expect(stateSchema.safeParse({ ...initialState(), models: { ...initialState().models, openai: model } }).success).toBe(true);
  });
  test('passes cancellation to the transport and returns no list after invalidation', async () => {
    let resolve!: (models: ModelOption[]) => void;
    let signal!: AbortSignal;
    const catalog = new ModelCatalog(async (_provider, _key, requestSignal) => { signal = requestSignal!; return new Promise(r => { resolve = r; }); });
    const pending = catalog.load('openai', key); catalog.invalidate('openai');
    expect(signal.aborted).toBe(true); resolve([{ id: 'old-model', name: 'old-model' }]);
    expect(await pending).toEqual({ models: [], cancelled: true });
  });
  test('new requests suppress late old-key results and errors, independently for each provider', async () => {
    for (const failOld of [false, true]) {
      let resolve!: (models: ModelOption[]) => void, reject!: (error: Error) => void;
      const catalog = new ModelCatalog(async (provider, credential) => credential === 'old' ? new Promise((yes, no) => { resolve = yes; reject = no; }) : [{ id: provider, name: provider }]);
      const old = catalog.load('openai', 'old');
      expect(await catalog.load('anthropic', key)).toEqual({ models: [{ id: 'anthropic', name: 'anthropic' }] });
      expect(await catalog.load('openai', key)).toEqual({ models: [{ id: 'openai', name: 'openai' }] });
      if (failOld) reject(new Error('old error')); else resolve([{ id: 'old', name: 'old' }]);
      expect(await old).toEqual({ models: [], cancelled: true });
    }
  });
});
