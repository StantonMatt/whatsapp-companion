import { createHash } from 'node:crypto';
import { countedDispatch } from './request-counts';
import { z } from 'zod';
import { modelIdSchema, type ModelOption, type ModelsResult, type Provider } from '../shared/model';
import { currentTextModels } from '../core/model-policy';

const pageSchema = z.object({
  data: z.array(z.object({ id: modelIdSchema, display_name: z.string().min(1).max(250).optional(), shutdown_date: z.string().nullable().optional() })).max(10000),
  has_more: z.boolean().optional(), last_id: modelIdSchema.nullable().optional()
});
class ModelsError extends Error {}

export async function listModels(provider: Provider, key: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<ModelOption[]> {
  const openai = provider === 'openai';
  const requestSignal = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
  const models = new Map<string, ModelOption & { shutdown_date?: string | null }>();
  const cursors = new Set<string>();
  let after: string | undefined;
  try {
    do {
      const url = new URL(openai ? 'https://api.openai.com/v1/models' : 'https://api.anthropic.com/v1/models');
      if (!openai) { url.searchParams.set('limit', '1000'); if (after) url.searchParams.set('after_id', after); }
      const page = await countedDispatch({ provider, model: '', reason: 'model list', method: 'GET' }, requestSignal, async () => {
        const response = await fetcher(url.toString(), {
          method: 'GET', redirect: 'error', signal: requestSignal,
          headers: openai ? { Authorization: `Bearer ${key}` } : { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
        });
        if (!response.ok) {
          // Error bodies can contain secrets. Only report our own status-specific messages.
          const reason = response.status === 401 ? 'Key rejected or missing model-list access. Check the key and allow read access to Models, then refresh.'
            : response.status === 403 ? 'This key cannot list models. Allow read access to Models in your provider’s key permissions, then refresh.'
            : response.status === 429 ? 'Rate limit reached. Try refreshing later.'
            : 'Unable to load models. Try refreshing later.';
          throw new ModelsError(`Models (${response.status}): ${reason}`);
        }
        const parsed = pageSchema.safeParse(await response.json());
        if (!parsed.success) throw new ModelsError('Models: The provider returned an invalid model list. Try refreshing later.');
        return parsed.data;
      });
      for (const model of page.data) models.set(model.id, { id: model.id, name: model.display_name ?? model.id, shutdown_date: model.shutdown_date });
      if (models.size > 10000) throw new ModelsError('Models: The provider model list is too large.');
      if (openai || !page.has_more) break;
      after = page.last_id ?? undefined;
      if (!after || cursors.has(after) || cursors.size >= 100) throw new ModelsError('Models: The provider returned incomplete pagination. Try refreshing later.');
      cursors.add(after);
    } while (true);
    return currentTextModels(provider, [...models.values()]);
  } catch (error) {
    if (signal?.aborted) throw new ModelsError('Models: Request cancelled.');
    if (requestSignal.aborted) throw new ModelsError('Models: Loading timed out. Check your connection and refresh.');
    if (error instanceof ModelsError) throw error;
    throw new ModelsError('Models: Unable to connect to the provider. Check your network and refresh.');
  }
}

/** Model lists belong to the exact key/request that loaded them, never a newer key. */
export class ModelCatalog {
  private active = new Map<Provider, AbortController>();
  private cache = new Map<string, { expires: number; models: ModelOption[] }>();
  constructor(private loader = listModels, private now = () => Date.now()) {}
  invalidate(provider: Provider) { this.active.get(provider)?.abort(); this.active.delete(provider); for (const id of this.cache.keys()) if (id.startsWith(`${provider}:`)) this.cache.delete(id); }
  async load(provider: Provider, key: string, refresh = false): Promise<ModelsResult> {
    const id = `${provider}:${createHash('sha256').update(key).digest('hex')}`;
    const cached = this.cache.get(id);
    this.active.get(provider)?.abort(); this.active.delete(provider);
    if (!refresh && cached && cached.expires > this.now()) return { models: structuredClone(cached.models) };
    if (refresh) this.cache.delete(id);
    const ticket = new AbortController(); this.active.set(provider, ticket);
    try {
      const models = await this.loader(provider, key, ticket.signal);
      if (this.active.get(provider) !== ticket) return { models: [], cancelled: true };
      this.cache.set(id, { models: structuredClone(models), expires: this.now() + 600000 });
      while (this.cache.size > 10) this.cache.delete(this.cache.keys().next().value!);
      return { models };
    } catch (error) {
      return this.active.get(provider) === ticket
        ? { models: [], error: error instanceof ModelsError ? error.message : 'Unable to load models. Try refreshing.' }
        : { models: [], cancelled: true };
    } finally { if (this.active.get(provider) === ticket) this.active.delete(provider); }
  }
}
