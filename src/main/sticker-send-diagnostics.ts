import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { StickerLookupDiagnostics, StickerSend } from '../shared/sticker-transfer';

const limit = 256 * 1024;
// Main writes only validated structural timings and local outcome codes.
// No sticker identifier, source, image bytes or destination enters this file.
export class StickerSendDiagnostics {
  constructor(private directory: string) {}
  append(send: StickerSend, diagnostics: StickerLookupDiagnostics) {
    try {
      const directory = join(this.directory, 'diagnostics');
      mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
      const path = join(directory, 'sticker-sends.log');
      const line = JSON.stringify({ timestamp: new Date().toISOString(), route: send.route, animated: send.animated,
        outcome: send.sent ?? 'not-sent', state: send.state, reason: send.reason ?? diagnostics.reason ?? null, detail: send.detail ?? null,
        totalMs: diagnostics.totalMs, categories: diagnostics.categories }) + '\n';
      let size = 0;
      try { size = statSync(path).size; chmodSync(path, 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (size + Buffer.byteLength(line) > limit) { renameSync(path, `${path}.1`); }
      appendFileSync(path, line, { mode: 0o600 }); chmodSync(path, 0o600);
    } catch { console.warn('Sticker send diagnostic could not be saved.'); }
  }
}
