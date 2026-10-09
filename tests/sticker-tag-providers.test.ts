import { expect, test, vi } from 'vitest';
import { generate, type GenerateInput } from '../src/main/providers';
const request: GenerateInput = { provider: 'openai', model: 'gpt-6-luna', key: 'secret-key', system: 'tag sticker', input: '{"animated":true}', images: [{ mime: 'image/png', data: 'AAAA' }], reason: 'sticker tagging' };
for (const provider of ['openai', 'anthropic'] as const) test(`${provider} image wire format stays at fixed endpoint with redirect refusal`, async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(provider === 'openai' ? { output: [{ type: 'message', content: [{ type: 'output_text', text: 'tags' }] }] } : { content: [{ type: 'text', text: 'tags' }] })));
  expect(await generate({ ...request, provider }, fetcher)).toBe('tags');
  const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit]; const body = JSON.parse(options.body as string);
  expect(url).toBe(provider === 'openai' ? 'https://api.openai.com/v1/responses' : 'https://api.anthropic.com/v1/messages'); expect(options.redirect).toBe('error');
  if (provider === 'openai') expect(body).toMatchObject({ store: false, input: [{ role: 'user', content: [{ type: 'input_text', text: request.input }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }] });
  else expect(body.messages[0].content).toEqual([{ type: 'text', text: request.input }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]);
  expect(options.body).not.toContain(request.key);
});
for (const [status, body, kind] of [[401, 'secret-key', 'auth'], [403, 'permission', 'auth'], [429, '{"code":"insufficient_quota"}', 'quota'], [400, 'Your credit balance is too low', 'quota'], [429, 'rate_limit_exceeded', 'rate-limit'], [400, 'model does not support images', 'no-vision'], [503, 'secret-key', 'offline']] as const) test(`classifies ${status} ${kind} without exposing provider text`, async () => {
  try { await generate(request, vi.fn(async () => new Response(body, { status }))); throw new Error('expected failure'); }
  catch (error) { expect(error).toMatchObject({ kind }); expect((error as Error).message).not.toContain('secret-key'); }
});
test('caller cancellation is preserved and network failure is distinct', async () => {
  const abort = new AbortController(); abort.abort(); const fetcher = vi.fn(async () => { throw new Error('network key'); });
  await expect(generate({ ...request, signal: abort.signal }, fetcher)).rejects.toThrow('Cancelled'); expect(fetcher).not.toHaveBeenCalled();
  await expect(generate(request, fetcher)).rejects.toMatchObject({ kind: 'offline' });
});
test('malformed image requests remain per-sticker failures; auth does not become a quota warning', async () => {
  await expect(generate(request, vi.fn(async () => new Response('invalid image data', { status: 400 })))).rejects.toMatchObject({ kind: 'failed' });
  await expect(generate(request, vi.fn(async () => new Response('quota access permission denied', { status: 401 })))).rejects.toMatchObject({ kind: 'auth' });
});
test('OpenAI image_url model restriction is a blocking vision error', async () => {
  await expect(generate(request, vi.fn(async () => new Response('image_url is only supported by certain models', { status: 400 })))).rejects.toMatchObject({ kind: 'no-vision' });
});
