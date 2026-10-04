import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { modelIdSchema, providerSchema, type Provider } from '../shared/model';
import { atomicWrite } from './store';

export const requestReasons = ['open/revisit', 'incoming message', 'draft continuation', 'explicit suggest', 'refine', 'translate', 'retry', 'auto reply', 'connection test', 'model list'] as const;
export type RequestReason = typeof requestReasons[number];
export type RequestOutcome = 'completed' | 'error' | 'timeout' | 'aborted';
export type RequestMetadata = { provider: Provider; model: string; reason: RequestReason; method: 'POST' | 'GET' };
const count = z.number().int().nonnegative().safe();
const rowSchema = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), provider: providerSchema,
  model: z.union([modelIdSchema, z.literal('')]), reason: z.enum(requestReasons), method: z.enum(['POST', 'GET']),
  dispatched: count, completed: count, error: count, timeout: count, aborted: count }).strict();
const fileSchema = z.object({ version: z.literal(1), counts: z.array(rowSchema).max(10000) }).strict();
type Row = z.infer<typeof rowSchema>;
function localDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Aggregate dispatch telemetry only. Never accept prompts, keys, chat IDs or request bodies. */
export class RequestCounts {
  private rows = new Map<string, Row>();
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private closed = false;
  readonly path: string;
  constructor(directory: string, private now = () => new Date()) {
    this.path = join(directory, 'request-counts.json');
    try {
      if (existsSync(this.path) && statSync(this.path).size <= 4 * 1024 * 1024) {
        const parsed = fileSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
        chmodSync(this.path, 0o600);
        for (const row of parsed.counts) this.rows.set(this.rowKey(row), row);
      }
    } catch { console.warn('Request counts could not be loaded; starting fresh aggregate counts.'); }
    this.prune();
  }
  private rowKey(row: Pick<Row, 'day' | 'provider' | 'model' | 'reason' | 'method'>) {
    return JSON.stringify([row.day, row.provider, row.model, row.reason, row.method]);
  }
  private prune() {
    const cutoff = this.now(); cutoff.setDate(cutoff.getDate() - 29);
    const oldest = localDay(cutoff), today = localDay(this.now());
    for (const [key, row] of this.rows) if (row.day < oldest || row.day > today) { this.rows.delete(key); this.dirty = true; }
    while (this.rows.size > 10000) { this.rows.delete(this.rows.keys().next().value!); this.dirty = true; }
  }
  begin(metadata: RequestMetadata): (outcome: RequestOutcome) => void {
    // Construct an allowlisted record rather than spreading an input object.
    const row = rowSchema.parse({ day: localDay(this.now()), provider: metadata.provider, model: metadata.model,
      reason: metadata.reason, method: metadata.method, dispatched: 0, completed: 0, error: 0, timeout: 0, aborted: 0 });
    const key = this.rowKey(row), existing = this.rows.get(key) ?? row;
    existing.dispatched++; this.rows.set(key, existing); this.schedule();
    let finished = false;
    return outcome => {
      if (finished) return; finished = true;
      existing[outcome]++; this.schedule();
    };
  }
  private schedule() {
    this.dirty = true; this.prune();
    if (!this.closed && !this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; this.flush(); if (this.dirty) this.schedule(); }, 30000);
      this.timer.unref?.();
    }
  }
  flush() {
    this.prune();
    if (!this.dirty) return;
    try { atomicWrite(this.path, JSON.stringify({ version: 1, counts: [...this.rows.values()] }, null, 2), undefined, 'request-counts'); this.dirty = false; }
    catch { console.warn('Request counts could not be saved; retrying on the next batch.'); }
  }
  close() { clearTimeout(this.timer); this.timer = undefined; this.closed = true; this.flush(); }
}

let counter: RequestCounts | undefined;
export function useRequestCounts(value?: RequestCounts) { counter = value; }
/** Called immediately around a real fetch dispatch, including response validation. */
export async function countedDispatch<T>(metadata: RequestMetadata, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted(); // A cancelled timer or preflight is not an HTTP dispatch.
  const finish = counter?.begin(metadata);
  const aborted = () => finish?.(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'aborted');
  signal.addEventListener('abort', aborted, { once: true });
  try { const result = await operation(); finish?.(signal.aborted ? signal.reason?.name === 'TimeoutError' ? 'timeout' : 'aborted' : 'completed'); return result; }
  catch (error) { if (signal.aborted) aborted(); else finish?.('error'); throw error; }
  finally { signal.removeEventListener('abort', aborted); }
}
