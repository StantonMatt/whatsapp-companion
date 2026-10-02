import { appendFileSync, chmodSync, closeSync, constants, fchmodSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { directDetailSchema, directFailureSchema } from '../shared/direct-sticker';
import type { StickerLookupDiagnostics, StickerSend } from '../shared/sticker-transfer';

const limit = 256 * 1024;
const directDiagnosticSchema = z.object({
  route: z.literal('direct'), phase: z.enum(['resolve', 'send']),
  elapsedMs: z.number().int().min(0).max(120_000),
  outcome: z.enum(['resolved', 'fallback', 'confirmed', 'not-sent', 'unknown']),
  code: directFailureSchema,
  detail: directDetailSchema.nullable().optional(),
  fingerprint: z.string().max(180).regex(/^direct-v1:active-get:upload-qpl:key:ephemeral:send-tuple\|\d+(?:\.\d+){2,}$/).nullable()
}).strict().refine(r => r.code !== 'module-shape' || r.detail != null);

// Main writes only validated structural timings and local outcome codes.
// No sticker identifier, source, image bytes or destination enters this file.
export class StickerSendDiagnostics {
  constructor(private directory: string) {}
  append(send: StickerSend, diagnostics: StickerLookupDiagnostics) {
    this.write({ route: send.route, animated: send.animated,
      outcome: send.sent ?? 'not-sent', state: send.state, reason: send.reason ?? diagnostics.reason ?? null, detail: send.detail ?? null,
      totalMs: diagnostics.totalMs, categories: diagnostics.categories });
  }
  appendDirect(raw: z.infer<typeof directDiagnosticSchema>) {
    const value = directDiagnosticSchema.safeParse(raw);
    if (value.success) this.write(value.data);
  }
  private write(value: object) {
    try {
      const directory = join(this.directory, 'diagnostics');
      mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
      const path = join(directory, 'sticker-sends.log');
      const line = JSON.stringify({ timestamp: new Date().toISOString(), ...value }) + '\n';
      let size = 0;
      try { size = statSync(path).size; chmodSync(path, 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (size + Buffer.byteLength(line) > limit) { renameSync(path, `${path}.1`); }
      const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try { fchmodSync(fd, 0o600); appendFileSync(fd, line); }
      finally { closeSync(fd); }
    } catch { console.warn('Sticker send diagnostic could not be saved.'); }
  }
}
