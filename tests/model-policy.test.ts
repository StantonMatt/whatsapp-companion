import { test, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentTextModels, reasoningLevels, savedEffort, setReasoning } from '../src/core/model-policy';
import { initialState, actionSchema, type ReasoningEffort } from '../src/shared/model';
import { Store } from '../src/main/store';
import { generate } from '../src/main/providers';
import { ProviderCheck } from '../src/main/provider-check';

const options = (...ids: string[]) => ids.map(id => ({ id, name: id }));
test('current text catalog excludes legacy, specialty, fine-tuned and duplicate snapshot choices', () => {
  const models = options('gpt-4o', 'gpt-5', 'gpt-5.6', 'gpt-6-astra', 'gpt-6-astra-2026-06-01', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-luna-preview', 'gpt-6-sol-codex', 'gpt-6-luna-audio', 'gpt-6-astra-pro', 'gpt-image-1', 'gpt-realtime', 'text-embedding-3-small', 'ft:gpt-6-luna:org:custom');
  expect(currentTextModels('openai', models)).toEqual(options('gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'));
});
test('catalog reflects account access, skips shutdown models and keeps only the newest available snapshot when no alias exists', () => {
  expect(currentTextModels('openai', [...options('gpt-6-luna-2026-05-18', 'gpt-6-luna-2026-06-01'), { id: 'gpt-6-astra', name: 'Astra', shutdown_date: '2026-10-01' }])).toEqual(options('gpt-6-luna-2026-06-01'));
  expect(currentTextModels('openai', options('gpt-4o'))).toEqual([]);
});
test('Anthropic shows only the current general text lineup, including Haiku snapshots', () => {
  expect(currentTextModels('anthropic', options('claude-sonnet-4-6', 'claude-opus-4-6', 'claude-3-5-haiku', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001')))
    .toEqual(options('claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'));
});
test('reasoning validates model-specific ranges and preserves independent model settings', () => {
  const state = initialState();
  expect(savedEffort(state)).toBe('none');
  setReasoning(state, 'openai', 'gpt-6-luna', 'medium');
  setReasoning(state, 'openai', 'gpt-6-sol', 'max');
  setReasoning(state, 'anthropic', 'claude-sonnet-5-5', 'high');
  expect(savedEffort(state)).toBe('medium');
  expect(savedEffort(state, 'openai', 'gpt-6-sol')).toBe('max');
  expect(savedEffort(state, 'openai', 'gpt-6-astra')).toBe('low');
  expect(savedEffort(state, 'anthropic', 'claude-sonnet-5-5')).toBe('high');
  expect(() => setReasoning(state, 'openai', 'gpt-6-astra', 'none')).toThrow('not supported');
  expect(() => setReasoning(state, 'anthropic', 'claude-haiku-4-5', 'high')).toThrow('not supported');
  expect(reasoningLevels('openai', 'gpt-6-luna-2026-05-18')).toContain('none');
  expect(actionSchema.safeParse({ type: 'reasoning', provider: 'openai', model: 'gpt-6-luna', effort: 'unlimited' }).success).toBe(false);
  expect(state.auto).toEqual({}); expect(state.global.suggestions).toBe(false);
});
test('old saved files gain reasoning defaults without losing selections and custom efforts survive restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-reasoning-'));
  try {
    const { reasoning: _oldMissing, ...old } = initialState(); old.models.openai = 'gpt-4o';
    writeFileSync(join(dir, 'companion.json'), JSON.stringify(old));
    const store = new Store(dir); expect(store.state.models.openai).toBe('gpt-4o'); expect(store.state.reasoning).toEqual({ openai: {}, anthropic: {} });
    store.update(s => setReasoning(s, 'openai', 'gpt-6-luna', 'high'));
    expect(savedEffort(new Store(dir).state, 'openai', 'gpt-6-luna')).toBe('high');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test.each(['none', 'low', 'medium', 'high', 'xhigh', 'max'] as ReasoningEffort[])('OpenAI transmits selected %s effort with room for reasoning', async effort => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }] })));
  await generate({ provider: 'openai', model: 'gpt-6-luna', key: 'synthetic', system: 'Reply', input: 'Hello', effort }, fetcher);
  const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
  expect(body.reasoning).toEqual({ effort }); expect(body.store).toBe(false);
  expect(body.max_output_tokens).toBe(effort === 'none' ? 1200 : effort === 'low' ? 4096 : effort === 'medium' ? 8192 : effort === 'high' ? 16384 : 32768);
});
test('Anthropic uses output_config effort, omitting unsupported settings for Haiku', async () => {
  for (const model of ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001']) {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'Hello' }] })));
    await generate({ provider: 'anthropic', model, key: 'synthetic', system: 'Reply', input: 'Hello', effort: 'xhigh' }, fetcher);
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(body.output_config).toEqual(model.includes('sonnet') ? { effort: 'xhigh' } : undefined);
    expect(body.reasoning).toBeUndefined(); expect(body.thinking).toBeUndefined();
  }
});
test('connection checks use the selected effort', async () => {
  const generator = vi.fn(async () => 'Connected');
  const check = new ProviderCheck(generator);
  await check.run({ provider: 'openai', model: 'gpt-6-luna', key: 'synthetic', effort: 'high' });
  expect(generator).toHaveBeenCalledWith(expect.objectContaining({ effort: 'high' }));
});

test('Sol 6.1 is offered only when available, with one alias or newest dated snapshot', () => {
  expect(currentTextModels('openai', options('gpt-6.1-sol', 'gpt-6.1-sol-2026-09-29', 'gpt-6.1-sol-preview', 'gpt-6.1-sol-codex', 'gpt-6.1-sol-audio', 'gpt-6-sol')))
    .toEqual(options('gpt-6.1-sol', 'gpt-6-sol'));
  expect(currentTextModels('openai', options('gpt-6.1-sol-2026-09-28', 'gpt-6.1-sol-2026-09-29'))).toEqual(options('gpt-6.1-sol-2026-09-29'));
  expect(currentTextModels('openai', options('gpt-6-luna'))).toEqual(options('gpt-6-luna'));
});
test('Sol 6.1 has its own saved reasoning range without none and sends the correct API ID', async () => {
  const state = initialState(); state.models.openai = 'gpt-6-sol';
  setReasoning(state, 'openai', 'gpt-6-sol', 'none');
  expect(savedEffort(state, 'openai', 'gpt-6.1-sol')).toBe('low');
  expect(reasoningLevels('openai', 'gpt-6.1-sol-2026-09-29')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  expect(() => setReasoning(state, 'openai', 'gpt-6.1-sol', 'none')).toThrow('not supported');
  setReasoning(state, 'openai', 'gpt-6.1-sol', 'max');
  expect(savedEffort(state)).toBe('none'); expect(state.models.openai).toBe('gpt-6-sol');
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }] })));
  await generate({ provider: 'openai', model: 'gpt-6.1-sol', key: 'synthetic', system: 'Reply', input: 'Hello', effort: 'none' }, fetcher);
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ model: 'gpt-6.1-sol', reasoning: { effort: 'low' } });
});
