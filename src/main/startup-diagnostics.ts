import { constants } from 'node:fs';
import { mkdir, chmod, lstat, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { bootAssetKindSchema, bootPhaseSchema, bootStructureSchema } from '../shared/boot';

const eventSchema = z.enum(['lock', 'app-ready', 'store-load', 'migration', 'gc', 'window-created', 'tray-created', 'tray-unavailable', 'views-created', 'bounds', 'bounds-rejected', 'controls-loaded', 'remote-navigation', 'dom-ready', 'finish-load', 'detector-ready', 'connector-deferral-expired', 'asset-failure', 'phase', 'visibility', 'progress', 'structure', 'watchdog', 'reload', 'preload-error', 'render-process-gone', 'unresponsive', 'responsive', 'close-requested', 'intake-drained', 'views-destroyed', 'before-quit', 'quit']);
const detailsSchema = z.object({
  durationMs: z.number().finite().min(0).max(86_400_000).optional(),
  acquired: z.boolean().optional(), visible: z.boolean().optional(), online: z.boolean().optional(),
  width: z.number().finite().min(0).max(100_000).optional(), height: z.number().finite().min(0).max(100_000).optional(),
  phase: bootPhaseSchema.optional(), progress: z.number().int().min(0).max(10).nullable().optional(),
  structure: bootStructureSchema.optional(),
  kind: bootAssetKindSchema.optional(),
  generation: z.number().int().nonnegative().optional(), reloads: z.number().int().min(0).max(2).optional(),
  decision: z.enum(['observing', 'gated', 'unknown', 'progress', 'waiting', 'spacing', 'exhausted', 'reload']).optional(),
  reason: z.enum(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction', 'other']).optional(),
  app: z.string().max(40).regex(/^\d+(?:\.\d+)*(?:-[a-z0-9.]+)?$/i).optional(),
  electron: z.string().max(40).regex(/^\d+(?:\.\d+)*(?:-[a-z0-9.]+)?$/i).optional(),
  chromium: z.string().max(40).regex(/^\d+(?:\.\d+)*$/).optional()
}).strict();
export type StartupEvent = z.infer<typeof eventSchema>;
export type StartupDetails = z.infer<typeof detailsSchema>;
export const STARTUP_LOG_LIMIT = 256 * 1024;

// Allowlisted metadata only, ordered asynchronous IO, bounded pending records.
// Append across launches so an interrupted timeline survives the next startup.
export class StartupDiagnostics {
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  private started = performance.now();
  private launch = randomUUID();
  // Only the single-instance lock holder may append or rotate the shared log.
  constructor(private userData: string, private enabled = true) {}
  record(event: StartupEvent, details: StartupDetails = {}) {
    if (!this.enabled) return;
    const parsed = detailsSchema.safeParse(details);
    if (!eventSchema.safeParse(event).success || !parsed.success || this.pending >= 512) return;
    const line = JSON.stringify({ timestamp: new Date().toISOString(), elapsedMs: Math.round(performance.now() - this.started), launch: this.launch, event, ...parsed.data }) + '\n';
    this.pending++;
    this.chain = this.chain.then(() => this.write(line)).catch(() => { /* Diagnostics never block app operation or leak exception text. */ }).finally(() => { this.pending--; });
  }
  flush() { return this.chain; }
  private async write(line: string) {
    const directory = join(this.userData, 'diagnostics');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) return;
    await chmod(directory, 0o700);
    const path = join(directory, 'startup.log');
    let file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const info = await file.stat();
      if (!info.isFile()) return;
      await file.chmod(0o600);
      if (info.size + Buffer.byteLength(line) > STARTUP_LOG_LIMIT) {
        await file.close();
        await rename(path, `${path}.1`);
        file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        await file.chmod(0o600);
      }
      await file.writeFile(line);
    } finally { await file.close().catch(() => {}); }
  }
}
