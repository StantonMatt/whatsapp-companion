import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestCounts, requestReasons, useRequestCounts } from '../src/main/request-counts';
import { generate } from '../src/main/providers';
import { listModels, ModelCatalog } from '../src/main/models';
import { ProviderCheck } from '../src/main/provider-check';

let dir: string, counts: RequestCounts;
const request = { provider: 'openai' as const, model: 'gpt-6-luna', key: 'PRIVATE_KEY', system: 'PRIVATE_PROMPT', input: 'PRIVATE_MESSAGE' };
const reply = () => new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'PRIVATE_REPLY' }] }] }));
const read = () => JSON.parse(readFileSync(counts.path, 'utf8')).counts as Array<Record<string, string | number>>;
beforeEach(() => { vi.useFakeTimers(); dir = mkdtempSync(join(tmpdir(), 'companion-counts-')); counts = new RequestCounts(dir); useRequestCounts(counts); });
afterEach(() => { counts.close(); useRequestCounts(); vi.useRealTimers(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

describe('privacy-safe dispatch counts', () => {
  test('records all POST reasons, outcomes and distinct model-list GETs without private inputs', async () => {
    for (const reason of requestReasons.filter(r => r !== 'model list')) await generate({ ...request, reason }, vi.fn(async () => reply()));
    await expect(generate({ ...request, reason: 'explicit suggest' }, vi.fn(async () => new Response('PRIVATE_ERROR', { status: 500 })))).rejects.toThrow();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'gpt-6-luna' }] })));
    const catalog = new ModelCatalog((provider, key, signal) => listModels(provider, key, signal, fetcher));
    await catalog.load('openai', request.key); await catalog.load('openai', request.key);
    counts.flush();
    expect(read().find(r => r.reason === 'explicit suggest')).toMatchObject({ dispatched: 2, completed: 1, error: 1, aborted: 0, timeout: 0 });
    expect(read().find(r => r.reason === 'model list')).toMatchObject({ method: 'GET', model: '', dispatched: 1, completed: 1 });
    expect(read().filter(r => r.method === 'POST')).toHaveLength(10);
    expect(read().find(r => r.reason === 'sticker tagging')).toMatchObject({ method: 'POST', dispatched: 1, completed: 1 });
    const json = readFileSync(counts.path, 'utf8'); expect(json).not.toMatch(/PRIVATE|prompt|input|suggestionKey|chatId|key/i);
    expect(statSync(counts.path).mode & 0o777).toBe(0o600); expect(existsSync(join(dir, 'companion.json'))).toBe(false);
  });
  test('records aborted and timed-out POSTs once, even before a stalled transport settles', async () => {
    const controller = new AbortController();
    let reject!: (error: Error) => void;
    const pending = generate({ ...request, signal: controller.signal }, vi.fn(() => new Promise<Response>((_yes, no) => { reject = no; })));
    controller.abort(); counts.flush(); expect(read()[0]).toMatchObject({ dispatched: 1, aborted: 1 });
    reject(new Error('PRIVATE_ERROR')); await expect(pending).rejects.toThrow('Cancelled');
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_yes, no) => options!.signal!.addEventListener('abort', () => no(new Error('timeout')))));
    const timeoutMock = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const timeout = new AbortController(); setTimeout(() => timeout.abort(new DOMException('Timed out', 'TimeoutError')), ms); return timeout.signal;
    });
    const timedOut = expect(generate(request, fetcher)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30000); await timedOut; timeoutMock.mockRestore(); counts.flush();
    expect(read()[0]).toMatchObject({ dispatched: 2, aborted: 1, timeout: 1, error: 0, completed: 0 });
  });
  test('pre-aborted requests never count or reach the transport', async () => {
    const controller = new AbortController(); controller.abort(); const fetcher = vi.fn(async () => reply());
    await expect(generate({ ...request, signal: controller.signal }, fetcher)).rejects.toThrow('Cancelled');
    counts.flush(); expect(fetcher).not.toHaveBeenCalled(); expect(existsSync(counts.path)).toBe(false);
  });
  test('connection tests set their own reason and paginated model listing counts each GET outcome', async () => {
    const fetcher = vi.fn(async () => reply());
    await new ProviderCheck(input => generate(input, fetcher)).run(request);
    const pages = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'claude-opus-5-5' }], has_more: true, last_id: 'claude-opus-5-5' }))).mockResolvedValueOnce(new Response('PRIVATE_ERROR', { status: 503 }));
    await expect(listModels('anthropic', request.key, undefined, pages)).rejects.toThrow('503'); counts.flush();
    expect(read().find(r => r.reason === 'connection test')).toMatchObject({ dispatched: 1, completed: 1 });
    expect(read().find(r => r.provider === 'anthropic')).toMatchObject({ method: 'GET', dispatched: 2, completed: 1, error: 1 });
  });
  test('batches writes at thirty seconds, flushes on close, reloads and prunes to thirty local days', async () => {
    let now = new Date(2026, 8, 1, 23, 59); counts.close(); counts = new RequestCounts(dir, () => new Date(now)); useRequestCounts(counts);
    await generate(request, vi.fn(async () => reply())); await vi.advanceTimersByTimeAsync(29999); expect(existsSync(counts.path)).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(read()[0].day).toBe('2026-09-01');
    now = new Date(2026, 8, 2); await generate(request, vi.fn(async () => reply())); counts.close(); expect(read()).toHaveLength(2);
    now = new Date(2026, 9, 1); counts = new RequestCounts(dir, () => new Date(now)); useRequestCounts(counts); counts.flush();
    expect(read()).toHaveLength(1); expect(read()[0].day).toBe('2026-09-02');
    const finish = counts.begin({ provider: 'openai', model: request.model, reason: 'retry', method: 'POST' }); finish('completed'); finish('error'); counts.close();
    expect(read().find(r => r.reason === 'retry')).toMatchObject({ dispatched: 1, completed: 1, error: 0 });
    expect(existsSync(`${counts.path}.tmp`)).toBe(false);
  });
  test('malformed or content-bearing stored telemetry cannot be reserialized', () => {
    counts.close(); writeFileSync(counts.path, JSON.stringify({ version: 1, counts: [], prompt: 'PRIVATE_PROMPT' }));
    counts = new RequestCounts(dir); useRequestCounts(counts);
    const finish = counts.begin({ provider: 'openai', model: request.model, reason: 'explicit suggest', method: 'POST' }); finish('completed'); counts.flush();
    expect(readFileSync(counts.path, 'utf8')).not.toContain('PRIVATE');
  });
});


describe('privacy-safe suggestion decision aggregates', () => {
  test('persists only allowlisted day/reason/count rows with batching, reload and owner-only permissions', async () => {
    counts.decision('unknown_direction'); counts.decision('unknown_direction'); counts.decision('display_rejected_key');
    await vi.advanceTimersByTimeAsync(29999); expect(existsSync(counts.decisionsPath)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const json = readFileSync(counts.decisionsPath, 'utf8');
    expect(JSON.parse(json).counts).toEqual([{ day: expect.any(String), reason: 'unknown_direction', count: 2 }, { day: expect.any(String), reason: 'display_rejected_key', count: 1 }]);
    expect(json).not.toMatch(/PRIVATE|prompt|text|chatId|suggestionId|emptyKey|identity/);
    expect(statSync(counts.decisionsPath).mode & 0o777).toBe(0o600); expect(existsSync(counts.path)).toBe(false);
    counts.close(); counts = new RequestCounts(dir); counts.decision('unknown_direction'); counts.close();
    expect(JSON.parse(readFileSync(counts.decisionsPath, 'utf8')).counts[0].count).toBe(3);
  });
  test('rejects content-bearing/unknown reasons and prunes to thirty days', () => {
    expect(() => counts.decision('PRIVATE_MESSAGE' as never)).toThrow();
    counts.close(); writeFileSync(counts.decisionsPath, JSON.stringify({ version: 1, counts: [], text: 'PRIVATE_MESSAGE' }));
    let now = new Date(2026, 8, 1); counts = new RequestCounts(dir, () => new Date(now));
    counts.decision('capacity_full'); counts.flush();
    expect(readFileSync(counts.decisionsPath, 'utf8')).not.toContain('PRIVATE');
    now = new Date(2026, 9, 1); counts.decision('dismissed'); counts.flush();
    expect(JSON.parse(readFileSync(counts.decisionsPath, 'utf8')).counts).toEqual([{ day: '2026-10-01', reason: 'dismissed', count: 1 }]);
  });
});
