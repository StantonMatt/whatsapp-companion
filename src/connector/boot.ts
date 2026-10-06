import type { BootObservation } from '../shared/boot';

// Fixed structural selectors only. Never read page text, QR data, URLs or account attributes.
const shell = '#pane-side, [data-testid="chat-list"], [data-testid="side-panel"], [data-testid="main-navigation"], nav [data-navbar-item]';
const login = '[data-testid="qrcode"], [data-testid="qr-code"], [data-testid="login-qr-code"], [data-testid="link-device"], [data-testid="logged-out"], .landing-wrapper, [data-testid="link-device-phone-number-code-screen"], [data-ref] canvas';
const blocked = '[data-testid="alert-phone"], [data-testid="alert-computer"], [data-testid="account-banned"], [data-testid="account-warning"], [data-testid="account-restriction"], [data-testid="startup-error"]';
function present(doc: Document, selector: string) {
  const view = doc.defaultView;
  if (!view) return null;
  for (const element of doc.querySelectorAll<HTMLElement>(selector)) {
    let ancestor: HTMLElement | null = element;
    for (let depth = 0; ancestor && depth < 32; depth++, ancestor = ancestor.parentElement) {
      const style = view.getComputedStyle(ancestor);
      if (ancestor.hidden || ancestor.getAttribute('aria-hidden') === 'true' ||
          (ancestor.tagName === 'DIALOG' && !ancestor.hasAttribute('open')) ||
          style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') break;
    }
    // Treat deeper trees conservatively without unbounded ancestor walks.
    if (ancestor) continue;
    const bounds = element.getBoundingClientRect();
    if (bounds.width > 0 && bounds.height > 0) return element;
  }
  return null;
}
export function classifyBoot(doc: Document): BootObservation {
  const base = { visible: doc.visibilityState === 'visible', online: doc.defaultView?.navigator.onLine !== false, progress: null };
  if (present(doc, blocked)) return { ...base, phase: 'blocked' };
  if (present(doc, login)) return { ...base, phase: 'login' };
  if (present(doc, shell)) return { ...base, phase: 'shell' };
  const splash = present(doc, '#initial_startup, [data-testid="startup-screen"]');
  if (!splash) return { ...base, phase: 'unknown' };
  const progress = splash.querySelector('progress, [role="progressbar"]');
  const value = Number(progress?.getAttribute(progress.tagName === 'PROGRESS' ? 'value' : 'aria-valuenow'));
  const maximum = Number(progress?.getAttribute(progress.tagName === 'PROGRESS' ? 'max' : 'aria-valuemax') ?? (progress?.tagName === 'PROGRESS' ? 1 : 100));
  const hasValue = progress?.hasAttribute(progress.tagName === 'PROGRESS' ? 'value' : 'aria-valuenow');
  return { ...base, phase: 'splash', progress: hasValue && Number.isFinite(value) && Number.isFinite(maximum) && maximum > 0 ? Math.floor(Math.max(0, Math.min(1, value / maximum)) * 10) : null };
}

export const BOOT_MAX_DEFERRAL_MS = 20_000;
export const BOOT_UNKNOWN_GRACE_MS = 5000;

// Give an early, unrecognized document time to render its startup markers.
// A hard deadline keeps changed WhatsApp markup from disabling features.
export class BootDetector {
  private timer?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private activated = false;
  private startedAt = 0;
  private completeObserved = false;
  constructor(private doc: Document, private heartbeat: (observation: BootObservation) => void, private activate: (reason: 'phase' | 'timeout') => void, private intervalMs = 2000) {}
  start() {
    if (this.timer !== undefined) return;
    this.startedAt = performance.now();
    this.completeObserved = false;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (!this.activated) this.deadline = setTimeout(() => this.tick(true), BOOT_MAX_DEFERRAL_MS);
    this.tick();
  }
  private tick(expired = false) {
    const observation = classifyBoot(this.doc);
    const complete = this.doc.readyState === 'complete';
    const unknownReady = complete && this.completeObserved && performance.now() - this.startedAt >= BOOT_UNKNOWN_GRACE_MS;
    this.completeObserved = complete;
    const recognized = observation.phase === 'shell' || observation.phase === 'login' || observation.phase === 'blocked';
    if (!this.activated && (recognized || (observation.phase === 'unknown' && unknownReady) || expired)) {
      this.activated = true;
      clearTimeout(this.deadline); this.deadline = undefined;
      this.activate(expired ? 'timeout' : 'phase');
    }
    this.heartbeat(observation);
  }
  stop() { clearInterval(this.timer); clearTimeout(this.deadline); this.timer = this.deadline = undefined; }
}
