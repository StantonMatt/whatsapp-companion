import { loginExecutable } from './autostart';
import type { StartupDetails, StartupEvent } from './startup-diagnostics';

export const STALL_RELAUNCH_MARKER = '--relaunched-after-stall';
export const remoteLoadThresholds = { stalledMs: 45_000, repeatStalledMs: 60_000, retryMs: [2000, 5000, 15_000, 30_000, 60_000] };
type Options = {
  load: () => void; stop: () => void; closing: () => boolean; visible: () => boolean;
  relaunch: (options: { execPath: string; args: string[] }) => void;
  execPath: string; args: string[]; env: NodeJS.ProcessEnv;
  record: (event: StartupEvent, details: StartupDetails) => void;
};
export class RemoteLoadRecovery {
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stallTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private failed = false;
  private failures = 0;
  private stalls = 0;
  private attempt = 0;
  constructor(private options: Options, private thresholds = remoteLoadThresholds) {}
  navigate(mainFrame: boolean, sameDocument: boolean) {
    if (!mainFrame || this.inactive()) return;
    this.clearRetry();
    if (sameDocument) return;
    this.clearStall(); this.failed = false;
    const marked = this.options.args.includes(STALL_RELAUNCH_MARKER);
    this.stallTimer = setTimeout(() => this.stalled(), marked && this.stalls > 0 ? this.thresholds.repeatStalledMs : this.thresholds.stalledMs);
  }
  commit(httpResponseCode: number) {
    this.clearStall();
    if (!this.failed && httpResponseCode >= 200 && httpResponseCode < 400) this.success();
  }
  domReady() { this.clearStall(); if (!this.failed) this.success(); }
  fail(code: number, mainFrame: boolean, provisional = false) {
    if (!mainFrame || this.inactive()) return;
    this.clearStall();
    if (code === -3) return;
    this.failed = true;
    if (provisional) return;
    this.clearRetry();
    this.failures = Math.min(this.failures + 1, Number.MAX_SAFE_INTEGER);
    this.attempt = Math.min(this.attempt + 1, Number.MAX_SAFE_INTEGER);
    this.options.record('load-failed', { code: Number.isFinite(code) ? Math.max(-1000, Math.min(0, Math.trunc(code))) : 0, attempt: this.attempt });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.inactive()) this.reload();
    }, this.thresholds.retryMs[Math.min(this.failures - 1, this.thresholds.retryMs.length - 1)]);
  }
  close() { this.stopped = true; this.clearRetry(); this.clearStall(); }
  private inactive() { return this.stopped || this.options.closing(); }
  private clearRetry() { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
  private clearStall() { clearTimeout(this.stallTimer); this.stallTimer = undefined; }
  private success() { this.failed = false; this.failures = this.stalls = this.attempt = 0; this.clearRetry(); }
  private reload() { this.options.record('load-retry', { attempt: this.attempt }); this.options.load(); }
  private stalled() {
    this.stallTimer = undefined;
    if (this.inactive()) return;
    this.stalls = Math.min(this.stalls + 1, Number.MAX_SAFE_INTEGER);
    this.attempt = Math.min(this.attempt + 1, Number.MAX_SAFE_INTEGER);
    this.options.record('navigation-stalled', { attempt: this.attempt });
    if (this.stalls >= 2 && !this.options.args.includes(STALL_RELAUNCH_MARKER)) {
      this.close(); this.options.record('relaunch', { attempt: this.attempt });
      this.options.relaunch({ execPath: loginExecutable(this.options.env, this.options.execPath),
        args: [...this.options.args.filter(arg => arg !== '--hidden' || !this.options.visible()), STALL_RELAUNCH_MARKER] });
      return;
    }
    this.options.stop();
    if (!this.inactive()) this.reload();
  }
}
