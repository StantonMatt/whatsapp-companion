import type { Snapshot } from '../shared/model';
import type { StickerTicket } from '../shared/sticker-transfer';
import { directResolveSchema, directSendSchema, type DirectDetail, type DirectFailure } from '../shared/direct-sticker';
import type { StickerTransfer } from '../core/sticker-transfer';
import { directStickerScript } from './direct-sticker-page';
import type { StickerSendDiagnostics } from './sticker-send-diagnostics';

// Main owns the grant, one-attempt latch, kill switch and outcome deadline.
// Main-world execution has no dependency on the remote preload's command API.
export class DirectStickerSender {
  constructor(private options: {
    transfer: StickerTransfer; snapshot: () => Snapshot; enabled: () => boolean;
    execute: (script: string) => Promise<unknown>; publish: () => void; diagnostics: StickerSendDiagnostics;
  }) {}
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
    };
    const fallback = (code: DirectFailure, detail?: DirectDetail | null) => {
      // Availability is the only reason to fall back; both destination and the
      // kill switch must still be valid, and no upload/send may have started.
      if (!['modules-missing', 'module-shape', 'version-missing', 'chat-unavailable'].includes(code)) { abort(code); return; }
      if (!o.enabled()) { abort('disabled'); return; }
      const next = t.fallbackDirect(ticket.nonce, o.snapshot(), fallbackRoute);
      log(next ? 'fallback' : 'not-sent', next ? code : 'chat-changed', next ? detail : null);
      if (!next) t.directResult(ticket.nonce, 'not-sent', 'chat-changed');
      return next;
    };
    try {
      if (!t.directCurrent(ticket.nonce, o.snapshot(), o.enabled())) { abort(o.enabled() ? 'chat-changed' : 'disabled'); return; }
      const raw = await this.execute(directStickerScript({ phase: 'resolve', nonce: ticket.nonce, deadline: Date.now() + 2500 }), 3000);
      const resolved = directResolveSchema.safeParse(raw);
      if (!resolved.success || resolved.data.nonce !== ticket.nonce) { abort('invalid-result'); return; }
      fingerprint = resolved.data.fingerprint;
      if (!t.directCurrent(ticket.nonce, o.snapshot(), o.enabled())) { abort(o.enabled() ? 'chat-changed' : 'disabled'); return; }
      if (resolved.data.status === 'unavailable') return fallback(resolved.data.code, resolved.data.detail);
      if (!t.bindDirect(ticket.nonce, resolved.data.destination, o.snapshot(), o.enabled())) { abort('destination-mismatch'); return; }
      log('resolved', 'none'); phase = 'send'; started = Date.now();
      // Serialize/bound arguments before consuming the only send attempt.
      const args = { phase: 'send' as const, nonce: ticket.nonce, deadline: Date.now() + 25_000, destination: resolved.data.destination,
        fingerprint: resolved.data.fingerprint, base64: image.slice('data:image/webp;base64,'.length), expectedHash: ticket.id };
      const script = directStickerScript(args);
      const bound = t.attemptDirect(ticket.nonce, o.snapshot(), o.enabled());
      if (!bound) { abort(o.enabled() ? 'chat-changed' : 'disabled'); return; }
      dispatched = true; o.publish();
      const sent = directSendSchema.safeParse(await this.execute(script, 30_000));
      if (!sent.success || sent.data.nonce !== ticket.nonce || (sent.data.status !== 'unavailable' && sent.data.fingerprint !== null && sent.data.fingerprint !== fingerprint) ||
        (sent.data.outcome === 'confirmed' && sent.data.to !== bound.directDestination.wid)) { abort('invalid-result'); return; }
      if (sent.data.status === 'unavailable') { dispatched = false; fingerprint = sent.data.fingerprint; return fallback(sent.data.code, sent.data.detail); }
      log(sent.data.outcome, sent.data.code, sent.data.detail);
      t.directResult(ticket.nonce, sent.data.outcome, sent.data.code === 'chat-changed' ? 'chat-changed' : undefined);
    } catch (error) {
      abort(error instanceof Error && error.message === 'timeout' ? 'timeout' : 'page-error');
    } finally { o.publish(); }
  }
}
