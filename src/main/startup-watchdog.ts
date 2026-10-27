import { bootHeartbeatSchema, type BootObservation, type BootSession } from '../shared/boot';

export const startupThresholds = { splashMs: 60_000, stalledMs: 30_000, assetFailureMs: 5000, spacingMs: 120_000, heartbeatGapMs: 6000 };
export type StartupThresholds = typeof startupThresholds;
export type WatchdogDecision = 'observing' | 'gated' | 'unknown' | 'progress' | 'waiting' | 'spacing' | 'exhausted' | 'reload';
export class StartupWatchdog {
  private session?: BootSession;
  private previous?: BootObservation;
  private splashSince?: number;
  private changedAt = 0;
  private lastHeartbeat?: number;
  private lastReload?: number;
  private assetFailureSince?: number;
  private assetProgress?: number | null;
  reloads = 0;
  constructor(private thresholds: StartupThresholds = startupThresholds) {}
  navigate(session: BootSession) {
    this.session = session; this.resetObservations();
  }
  resetObservations() { this.previous = undefined; this.splashSince = undefined; this.lastHeartbeat = undefined; this.assetFailureSince = undefined; this.assetProgress = undefined; }
  accept(raw: unknown, now: number, gates: { visible: boolean; closing: boolean; busy?: boolean }): { observation: BootObservation; decision: WatchdogDecision } | undefined {
    const parsed = bootHeartbeatSchema.safeParse(raw);
    if (!parsed.success || !this.session || parsed.data.nonce !== this.session.nonce || parsed.data.generation !== this.session.generation) return;
    const { phase, progress, visible, online, structure, chatListReady, assetFailed, assetFailureKind } = parsed.data;
    const observation = { phase, progress, visible, online, ...(chatListReady !== undefined ? { chatListReady } : {}), ...(structure ? { structure } : {}),
      ...(assetFailed !== undefined ? { assetFailed } : {}), ...(assetFailureKind ? { assetFailureKind } : {}) };
    if (this.lastHeartbeat !== undefined && now - this.lastHeartbeat > this.thresholds.heartbeatGapMs) this.resetObservations();
    this.lastHeartbeat = now;
    if (phase === 'splash' && assetFailed && !gates.closing && !gates.busy && online) {
      const changed = this.assetFailureSince === undefined || this.assetProgress !== progress;
      if (changed) this.assetFailureSince = now;
      this.assetProgress = progress;
      let decision: WatchdogDecision;
      if (this.reloads >= 2) decision = 'exhausted';
      else if (now - this.assetFailureSince! < this.thresholds.assetFailureMs) decision = changed ? 'progress' : 'waiting';
      else if (this.lastReload !== undefined && now - this.lastReload < this.thresholds.spacingMs) decision = 'spacing';
      else { decision = 'reload'; this.reloads++; this.lastReload = now; this.resetObservations(); }
      return { observation, decision };
    }
    this.assetFailureSince = undefined; this.assetProgress = undefined;
    if (!gates.visible || gates.closing || gates.busy || !visible || !online) {
      this.splashSince = undefined; this.previous = undefined; this.changedAt = now;
      return { observation, decision: 'gated' };
    }
    if (phase !== 'splash') {
      this.splashSince = undefined; this.previous = observation; this.changedAt = now;
      return { observation, decision: phase === 'unknown' ? 'unknown' : 'observing' };
    }
    const changed = !this.previous || this.previous.phase !== phase || this.previous.progress !== progress;
    if (this.splashSince === undefined) this.splashSince = now;
    if (changed) this.changedAt = now;
    this.previous = observation;
    let decision: WatchdogDecision;
    if (this.reloads >= 2) decision = 'exhausted';
    else if (now - this.splashSince < this.thresholds.splashMs || now - this.changedAt < this.thresholds.stalledMs) decision = changed ? 'progress' : 'waiting';
    else if (this.lastReload !== undefined && now - this.lastReload < this.thresholds.spacingMs) decision = 'spacing';
    else { decision = 'reload'; this.reloads++; this.lastReload = now; this.resetObservations(); }
    return { observation, decision };
  }
}
