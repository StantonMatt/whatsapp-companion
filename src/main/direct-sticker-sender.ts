import type { Snapshot, DirectStickerDisabledReason } from '../shared/model';
import type { StickerTicket } from '../shared/sticker-transfer';
import { directResolveSchema, directSendSchema, type DirectDetail, type DirectFailure } from '../shared/direct-sticker';
import type { StickerTransfer } from '../core/sticker-transfer';
import { directStickerScript } from './direct-sticker-page';
import type { StickerSendDiagnostics } from './sticker-send-diagnostics';

// Main owns the grant, one-attempt latch, kill switch and outcome deadline.
// Main-world execution has no dependency on the remote preload's command API.
export class DirectStickerSender {
  private invocations: number[] = [];
  private succeeded = false;
  constructor(private options: {
    readSticker?: (id: string) => string; transfer: StickerTransfer; snapshot: () => Snapshot; enabled: () => boolean;
    disable: (reason: DirectStickerDisabledReason) => void;
    execute: (script: string) => Promise<unknown>; publish: () => void; diagnostics: StickerSendDiagnostics;
  }) {}
  private capped() {
    this.invocations = this.invocations.filter(at => at > Date.now() - 60_000);
    return this.invocations.length >= 10;
  }
  private async execute(script: string, timeout: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.options.execute(script),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeout); })
      ]);
    } finally { clearTimeout(timer); }
  }
  async run(ticket: StickerTicket, image: string, fallbackRoute: 'maker' | 'picker'): Promise<StickerTicket | undefined> {
    const o = this.options, t = o.transfer;
    let phase: 'resolve' | 'send' = 'resolve', started = Date.now(), fingerprint: string | null = null, dispatched = false;
    const log = (outcome: 'resolved' | 'fallback' | 'confirmed' | 'not-sent' | 'unknown', code: DirectFailure, detail?: DirectDetail | null) =>
      o.diagnostics.appendDirect({ route: 'direct', phase, elapsedMs: Math.min(120_000, Math.max(0, Date.now() - started)), outcome, code, detail: detail ?? null, fingerprint });
    const abort = (code: DirectFailure) => {
      log(dispatched ? 'unknown' : 'not-sent', code);
      t.directResult(ticket.nonce, dispatched ? 'unknown' : 'not-sent', code === 'chat-changed' || code === 'destination-mismatch' ? 'chat-changed' : undefined);
      if (dispatched) o.disable('send-error');
    };
    const fallback = (code: DirectFailure, detail?: DirectDetail | null) => {
      // Availability or the cap may fall back; both destination and the
      // kill switch must still be valid, and no upload/send may have started.
      if (code === 'module-shape' && this.succeeded) {
        log('not-sent', code, detail); t.directResult(ticket.nonce, 'not-sent'); o.disable('whatsapp-changed'); return;
      }
      if (!['rate-limit', 'modules-missing', 'module-shape', 'version-missing', 'chat-unavailable'].includes(code)) { abort(code); return; }
      if (!o.enabled()) { abort('disabled'); return; }
      const next = t.fallbackDirect(ticket.nonce, o.snapshot(), fallbackRoute);
      log(next ? 'fallback' : 'not-sent', next ? code : 'chat-changed', next ? detail : null);
      if (!next) t.directResult(ticket.nonce, 'not-sent', 'chat-changed');
      return next;
    };
    try {
      if (!t.directCurrent(ticket.nonce, o.snapshot(), o.enabled())) { abort(o.enabled() ? 'chat-changed' : 'disabled'); return; }
      if (this.capped()) return fallback('rate-limit');
      const raw = await this.execute(directStickerScript({ phase: 'resolve', nonce: ticket.nonce, deadline: Date.now() + 2500 }), 3000);
      const resolved = directResolveSchema.safeParse(raw);
      if (!resolved.success || resolved.data.nonce !== ticket.nonce) { abort('invalid-result'); return; }
      fingerprint = resolved.data.fingerprint;
      if (!t.directCurrent(ticket.nonce, o.snapshot(), o.enabled())) { abort(o.enabled() ? 'chat-changed' : 'disabled'); return; }
      if (resolved.data.status === 'unavailable') return fallback(resolved.data.code, resolved.data.detail);
      if (!t.bindDirect(ticket.nonce, resolved.data.destination, o.snapshot(), o.enabled())) { abort('destination-mismatch'); return; }
      log('resolved', 'none'); phase = 'send'; started = Date.now();
      // Resolve may have yielded to Forget or disk changes. Re-read verified bytes before disclosure.
      if (o.readSticker) image = o.readSticker(ticket.id);
      // Serialize/bound arguments before consuming the only send attempt.
      const args = { phase: 'send' as const, nonce: ticket.nonce, deadline: Date.now() + 25_000, destination: resolved.data.destination,
        fingerprint: resolved.data.fingerprint, base64: image.slice('data:image/webp;base64,'.length), expectedHash: ticket.id };
      const script = directStickerScript(args);
      if (this.capped()) return fallback('rate-limit');
      const bound = t.attemptDirect(ticket.nonce, o.snapshot(), o.enabled());
      if (!bound) { abort(o.enabled() ? 'chat-changed' : 'disabled'); return; }
      dispatched = true; o.publish();
      // Count the page-side send invocation, including failures and safe
      // unavailable results. Resolution and native fallback consume no budget.
      this.invocations.push(Date.now());
      const sent = directSendSchema.safeParse(await this.execute(script, 30_000));
      if (!sent.success || sent.data.nonce !== ticket.nonce || (sent.data.status !== 'unavailable' && sent.data.fingerprint !== null && sent.data.fingerprint !== fingerprint) ||
        (sent.data.outcome === 'confirmed' && sent.data.to !== bound.directDestination.wid)) { abort('invalid-result'); return; }
      if (sent.data.status === 'unavailable') { dispatched = false; fingerprint = sent.data.fingerprint; return fallback(sent.data.code, sent.data.detail); }
      log(sent.data.outcome, sent.data.code, sent.data.detail);
      t.directResult(ticket.nonce, sent.data.outcome, sent.data.code === 'chat-changed' ? 'chat-changed' : undefined);
      if (sent.data.outcome === 'confirmed') this.succeeded = true;
      // Every failure after network work starts trips the stop, including
      // destination/availability changes and shape failures on the first send.
      else if (sent.data.phase !== 'pre-upload') o.disable(
        ['module-shape', 'upload-shape', 'key-shape', 'send-shape'].includes(sent.data.code) ? 'whatsapp-changed' : 'send-error');
      else if (sent.data.code === 'module-shape' && this.succeeded) o.disable('whatsapp-changed');
      else if (sent.data.outcome === 'unknown' || (sent.data.code !== 'module-shape' &&
        !['chat-changed', 'disabled', 'destination-mismatch', 'chat-unavailable'].includes(sent.data.code))) o.disable('send-error');
    } catch (error) {
      abort(error instanceof Error && error.message === 'timeout' ? 'timeout' : 'page-error');
    } finally { o.publish(); }
  }
}
