import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomicWrite, syncSavedDirectory } from './store';
import { pickerLayoutDiagnosticSchema, pickerLayoutEventSchema } from '../shared/sticker-picker-capture';
import type { RemoteCommand } from '../shared/connector';

const envelopeSchema = z.object({ type: z.literal('stickerPickerLayout'), nonce: z.string().uuid(), result: z.unknown() }).strict();
export class PickerDiagnostics {
  private durabilityWarning = false;
  private pending?: { nonce: string; timer: ReturnType<typeof setTimeout> };
  constructor(private options: {
    directory: string; appVersion: string; send: (command: RemoteCommand) => void;
    reveal: (path: string) => void; notify: (message: string) => void;
  }) {}
  // Called only by the trusted application menu, never by an IPC request.
  capture() {
    if (this.pending) return;
    const nonce = randomUUID();
    this.pending = { nonce, timer: setTimeout(() => {
      this.cancel(); this.options.notify('Sticker picker capture timed out. Reload WhatsApp and try again.');
    }, 10_000) };
    this.options.send({ type: 'captureStickerPickerLayout', nonce });
  }
  cancel() { clearTimeout(this.pending?.timer); this.pending = undefined; }
  receive(raw: unknown) {
    if (!this.pending) return;
    const envelope = envelopeSchema.safeParse(raw);
    if (!envelope.success || envelope.data.nonce !== this.pending.nonce) return;
    this.cancel(); // Consume the one-use menu request even if validation fails.
    const event = pickerLayoutEventSchema.safeParse(raw);
    if (!event.success) { this.options.notify('Sticker picker capture was invalid. No diagnostic was saved.'); return; }
    if (event.data.result.status === 'no-picker-open') {
      this.options.notify("Open WhatsApp's sticker picker first, then try again."); return;
    }
    try {
      const diagnostic = pickerLayoutDiagnosticSchema.parse({ ...event.data.result, appVersion: this.options.appVersion });
      const directory = join(this.options.directory, 'diagnostics');
      mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
      const path = join(directory, `sticker-picker-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      if (this.durabilityWarning) this.durabilityWarning = !syncSavedDirectory(directory, undefined, 'picker:retry');
      this.durabilityWarning = !atomicWrite(path, `${JSON.stringify(diagnostic, null, 2)}\n`);
      this.options.reveal(path);
      this.options.notify(`Sticker picker layout saved to:\n${path}`);
    } catch { this.options.notify('Sticker picker capture could not be saved. Check disk space and the data directory.'); }
  }
}
