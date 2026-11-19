import { randomUUID } from 'node:crypto';
import { emptySnapshot, defaultAuto, type Snapshot, type Status, type AutoPatch, type AutoPermission, type Provider, type ChatKind, type Preferences } from '../shared/model';
import type { Connector, displayAckSchema } from '../shared/connector';
import type { z } from 'zod';
import { resolveSettings } from '../core/settings';
import { SuggestionGate, snapshotKey, suggestionKey, isLinkOnlyDraft } from '../core/suggestions';
import { autoDecision, autoSendExpiry } from '../core/auto-reply';
import { learnStyle, styleFor } from '../core/style';
import { savedEffort } from '../core/model-policy';
import { generate, buildPrompt, ProviderError } from './providers';
import { countDecision, type DecisionReason, type RequestReason } from './request-counts';
import type { Store } from './store';
import type { Vault } from './vault';

type RequestSource = { key?: string; suggestionId?: string; operation?: 'translate' | 'retry' };
type InlineRequest = { operation: 'suggest' | 'continuation' | 'refine' | 'translate'; instruction?: string;
  draft: string; composerDraft: string; contextKey: string | undefined; reason: RequestReason };
type Offer = { id: string; key: string; text: string; replace: boolean; displayAttempts?: number; displayed?: boolean };
type RequestOrigin = 'user' | 'auto';
type Live = { origin: RequestOrigin; id: string; signature: string; controller: AbortController; request?: InlineRequest; offer?: Offer; error?: string;
  due?: number; run?: () => void; running?: boolean; awaitingSnapshot?: boolean;
  deferred?: { text: string; replace: boolean } | { error: string } };
type ConversationRecord = { kind: ChatKind; profile: string | null; generation: number; output: string; configuration: string };
type CacheEntry = { text: string } | { dismissed: true };

export class Assistant {
  snapshot: Snapshot = emptySnapshot;
  message = 'Open a conversation to use writing assistance.';
  pending: Status['pending'] = null;
  private gate = new SuggestionGate();
  private timer?: ReturnType<typeof setTimeout>;
  private sendTimer?: ReturnType<typeof setTimeout>;
  private baseline?: string;
  private fresh?: { id: string; seenAt: number };
  private seenMessages = new Set<string>();
  private seenCapacityReached = false;
  private runtimePaused = new Set<string>();
  private attempt?: { nonce: string; ticket: ReturnType<SuggestionGate['begin']>; expiresAt: number; reservation: { at: number; messageId: string }; approved: boolean };
  private live?: Live;
  private automatic = false;
  // Memory only: message-derived keys/text must never enter companion.json or telemetry.
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Live>();
  private requested = new Map<string, string>();
  private conversations = new Map<string, ConversationRecord>();
  private configurationGeneration = 0;
  private keyVersions: Record<Provider, number> = { openai: 0, anthropic: 0 };
  private activeConfiguration?: string;
  private refreshNonce?: string;
  private freshAfterTimeout = false;
  private snapshotTimer?: ReturnType<typeof setTimeout>;
  private displayRefresh?: { nonce: string; id: string };
  private admission?: { signature: string; reason: RequestReason };
  private dismissalTargets = new Map<string, { emptyKey?: string; identity: string; draft: string; work: Live }>();
  private decisions = new Map<string, string>();
  private suspended = false;
  private transientId = `document:${randomUUID()}`;
  private recordIdentity(snapshot = this.snapshot) { return this.chatIdentity(snapshot) ?? this.transientId; }
  private decision(reason?: DecisionReason, phase = 'admission', token = this.inlineSignature()) {
    const value = JSON.stringify([token, reason]);
    if (this.decisions.get(phase) === value) return;
    this.decisions.set(phase, value);
    if (reason) countDecision(reason);
  }
  private clearTransient() {
    this.conversations.delete(this.transientId);
    this.requested.delete(this.transientId);
    this.expireCache(this.transientId);
    this.transientId = `document:${randomUUID()}`;
  }
  private normalizeDraft(draft: string) { return draft.replace(/\s+/gu, ' ').trim(); }
  private chatIdentity(snapshot = this.snapshot) { return snapshot.settingsId ?? snapshot.chatId; }
  /** One fingerprint for cache keys and all per-conversation invalidation. */
  private outputConfiguration(snapshot = this.snapshot, learning = false) {
    const state = this.store.state, preferences = resolveSettings(state, snapshot.kind, this.chatIdentity(snapshot)).values;
    const { tone, length, language, emoji, instructions, style, shareContext } = preferences;
    const profile = styleFor(state, preferences, this.chatIdentity(snapshot)).profile?.description ?? null;
    const recordId = this.recordIdentity(snapshot);
    let record = this.conversations.get(recordId);
    if (!record) {
      record = { kind: snapshot.kind, profile, generation: 0, output: '', configuration: '' };
      this.conversations.set(recordId, record);
      while (this.conversations.size > 50) {
        const oldest = this.conversations.keys().next().value!;
        this.conversations.delete(oldest);
        this.requested.delete(oldest); this.expireCache(oldest);
      }
    }
    // Learning preserves existing output identity; every effective edit/new record
    // gets a globally unique generation, so eviction can never revive old work.
    const profileChanged = record.profile !== profile && !learning;
    record.profile = profile; record.kind = snapshot.kind;
    const values = [state.provider, state.models[state.provider], savedEffort(state), this.keyVersions[state.provider],
      tone, length, language, emoji, instructions, style, shareContext, shareContext ? snapshot.kind : null];
    const output = JSON.stringify(values);
    if (!record.generation || profileChanged || output !== record.output) record.generation = ++this.configurationGeneration;
    const configuration = JSON.stringify([...values, record.generation]);
    if (record.configuration && configuration !== record.configuration) this.expireCache(recordId);
    record.output = output; record.configuration = configuration;
    return configuration;
  }
  private emptyKey(snapshot = this.snapshot) {
    const id = this.recordIdentity(snapshot), last = snapshot.messages.at(-1);
    return id && last ? JSON.stringify([id, last.id, last.text, last.outgoing, last.sender ?? null,
      last.attachment ?? null, last.attachmentName ?? null,
      last.quoted ? [last.quoted.sender ?? null, last.quoted.text, last.quoted.attachment ?? null, last.quoted.attachmentName ?? null] : null,
      this.outputConfiguration(snapshot)]) : undefined;
  }
  /** Completion/backoff validation must never insert or touch observation state. */
  private validContext(key: string | undefined) {
    if (!key) return false;
    const parts = JSON.parse(key);
    return this.conversations.get(parts[0])?.configuration === parts.at(-1);
  }
  private expireCache(id: string) {
    for (const key of this.cache.keys()) if (JSON.parse(key)[0] === id) this.cache.delete(key);
  }
  private remember(key: string, entry: CacheEntry) {
    this.cache.delete(key); this.cache.set(key, entry);
    while (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value!);
  }
  private inlineSignature(snapshot = this.snapshot) {
    return JSON.stringify([this.emptyKey(snapshot) ?? [this.recordIdentity(snapshot), this.outputConfiguration(snapshot)], this.normalizeDraft(snapshot.draft)]);
  }
  private matches(request: InlineRequest) {
    return request.contextKey === this.emptyKey() && request.composerDraft === this.snapshot.draft;
  }
  private current(work: Live) {
    return this.store.state.global.aiFeatures && !this.suspended && !this.refreshNonce && this.live === work && !work.controller.signal.aborted && work.signature === this.inlineSignature();
  }
  private owns(work: Live) {
    // Work identity is the ordering token: retired requests cannot dispatch or
    // publish even if their provider ignores abort or the same key is reused.
    return !work.controller.signal.aborted && (this.current(work) ||
      Boolean(work.request?.contextKey && this.inFlight.get(work.request.contextKey) === work));
  }
  private supersedeEmpty(key: string | undefined) {
    if (!key) return;
    const work = this.inFlight.get(key);
    if (!work) return;
    work.controller.abort(); work.run = undefined; work.due = undefined;
    this.inFlight.delete(key);
  }
  private show(work: Live, text: string, replace: boolean) {
    work.error = undefined;
    work.offer = { id: randomUUID(), key: suggestionKey(this.snapshot), text, replace };
    this.sendOffer(work.offer, work);
    this.message = 'Tab to accept · Esc to dismiss';
  }
  private rememberDismissalTarget(id: string, work: Live) {
    if (this.dismissalTargets.has(id)) return;
    const draft = work.request?.composerDraft ?? this.snapshot.draft;
    this.dismissalTargets.set(id, { emptyKey: !draft ? work.request?.contextKey ?? this.emptyKey() : undefined,
      identity: this.recordIdentity(), draft: this.normalizeDraft(draft), work });
    while (this.dismissalTargets.size > 50) this.dismissalTargets.delete(this.dismissalTargets.keys().next().value!);
  }
  private sendOffer(offer: Offer, work: Live) {
    this.rememberDismissalTarget(offer.id, work);
    // Send only protocol fields, never main-owned recovery metadata.
    this.connector.send({ type: 'suggestion', id: offer.id, requestId: work.id, key: offer.key, text: offer.text, replace: offer.replace });
  }
  private sendPending(work: Live) {
    this.rememberDismissalTarget(work.id, work);
    this.connector.send({ type: work.request?.instruction ? 'refining' : 'thinking', key: suggestionKey(this.snapshot), requestId: work.id, origin: work.origin });
  }
  private sendNotice(work: Live, text: string, key = suggestionKey(this.snapshot)) {
    this.rememberDismissalTarget(work.id, work);
    this.connector.send({ type: 'notice', text, retryKey: key, requestId: work.id });
  }
  displayAck(source: z.infer<typeof displayAckSchema>) {
    const offer = this.live?.offer;
    if (!offer || offer.id !== source.suggestionId || offer.key !== source.key || this.suspended || this.refreshNonce) return;
    offer.displayed = source.reason === 'displayed';
    if (offer.displayed) {
      offer.displayAttempts = 0;
      if (this.displayRefresh?.id === offer.id) { this.displayRefresh = undefined; clearTimeout(this.snapshotTimer); }
      this.decision(undefined, 'display', offer.id); this.changed(); return;
    }
    this.decision(`display_rejected_${source.reason}` as DecisionReason, 'display', offer.id);
    // Acknowledgements only recover an existing main-owned result. They cannot
    // request provider work or influence send authorization.
    if (!this.displayRefresh && (offer.displayAttempts ?? 0) < 3) this.recoverDisplay(offer);
    this.changed();
  }
  private recoverDisplay(offer: Offer) {
    clearTimeout(this.snapshotTimer);
    offer.displayAttempts = (offer.displayAttempts ?? 0) + 1;
    const nonce = randomUUID(); this.displayRefresh = { nonce, id: offer.id };
    this.snapshotTimer = setTimeout(() => {
      if (this.live?.offer !== offer || this.displayRefresh?.nonce !== nonce) return;
      this.displayRefresh = undefined;
      if (offer.displayAttempts! < 3) this.recoverDisplay(offer);
      this.changed();
    }, 1000);
    this.connector.send({ type: 'snapshot', nonce });
  }
  private publishLive() {
    const work = this.live;
    if (!work) return;
    if (work.request && (work.running || work.run || work.deferred)) { this.sendPending(work); return; }
    if (work.offer) {
      work.offer.key = suggestionKey(this.snapshot);
      this.sendOffer(work.offer, work);
    }
    if (work.error && work.request)
      this.sendNotice(work, work.error);
  }
  /** Every transition settles the view into scheduled, running, offered, failed,
   * deferred until a snapshot, or empty. A request alone is not pending work. */
  private reconcileLive() {
    const work = this.live;
    if (work && (work.controller.signal.aborted || this.suspended || this.refreshNonce)) {
      this.cancel(); return;
    }
    if (work?.deferred && !work.awaitingSnapshot) {
      const outcome = work.deferred; work.deferred = undefined;
      if (!work.request || !this.matches(work.request)) { this.cancel(); return; }
      if ('text' in outcome) this.show(work, outcome.text, outcome.replace);
      else {
        work.error = outcome.error;
        this.sendNotice(work, outcome.error);
      }
    }
    if (work && !work.running && !work.run && !work.offer && !work.error && !work.deferred) {
      this.cancel(); return;
    }
    if (work?.running || work?.deferred) this.message = 'Thinking…';
    else if (work?.run) this.message = work.request && !work.awaitingSnapshot ? 'Connection interrupted. Retrying suggestion…' : 'Ready';
    else if (work?.error) this.message = work.awaitingSnapshot ? 'Ready' : work.error;
    else if (work?.offer) this.message = work.offer.displayed === false ? 'Ready' : 'Tab to accept · Esc to dismiss';
    else if (/^(Tab to accept|Thinking|Connection interrupted)/.test(this.message)) this.message = 'Ready';
  }
  private changed() { this.reconcileLive(); this.onChanged(); }
  /** Only a main-owned offer may suppress the expected post-insertion draft. */
  applied(source: { key: string; suggestionId: string; success?: boolean }) {
    const offer = this.live?.offer;
    if (!offer || source.suggestionId !== offer.id || source.key !== offer.key || source.key !== suggestionKey(this.snapshot)) return;
    if (source.success === false) {
      this.live!.request ??= { operation: 'suggest', draft: '', composerDraft: this.snapshot.draft, contextKey: this.emptyKey(), reason: 'retry' };
      this.live!.offer = undefined;
      this.live!.error = this.message = 'Could not insert the suggestion. Try again.';
      this.sendNotice(this.live!, this.message, source.key); this.changed(); return;
    }
    this.requested.set(this.recordIdentity(), this.normalizeDraft(offer.replace ? offer.text : this.snapshot.draft + offer.text));
    this.reconcileLive();
  }
  /** One view timer also services detached empty-request backoffs. */
  private armTimer() {
    clearTimeout(this.timer); this.timer = undefined;
    const waiting = [...new Set([this.live, ...this.inFlight.values()])].filter((work): work is Live => Boolean(work?.run && (!work.awaitingSnapshot || [...this.inFlight.values()].includes(work))));
    if (!waiting.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const work of waiting) if (work.run && work.due! <= Date.now()) {
        const run = work.run; work.run = undefined; work.due = undefined;
        if (this.owns(work)) run();
      }
      this.armTimer();
      this.changed();
      this.resumeAdmission();
    }, Math.max(0, Math.min(...waiting.map(work => work.due!)) - Date.now()));
  }
  private schedule(run: () => void, signature: string) {
    this.cancel();
    this.live = { origin: 'auto', id: randomUUID(), signature, controller: new AbortController(), run, due: Date.now() + 1000 };
    this.armTimer();
    this.reconcileLive();
  }
  private abortEmpty(provider?: Provider) {
    for (const [key, work] of this.inFlight) {
      if (provider && JSON.parse(JSON.parse(key).at(-1))[0] !== provider) continue;
      work.controller.abort(); work.run = undefined; this.inFlight.delete(key);
    }
    this.armTimer();
  }
  private observed = new Map<string, { samples: Map<string, string>; hasProfile: boolean }>();
  constructor(private store: Store, private vault: Vault, private connector: Connector, private onChanged: () => void, private fixture: boolean, private generator: typeof generate = generate) { this.activeConfiguration = this.activeConfigurationKey(); }
  cancel(abortEmpty = false) {
    this.admission = undefined;
    if (this.displayRefresh) { clearTimeout(this.snapshotTimer); this.displayRefresh = undefined; }
    const hadLive = Boolean(this.live);
    if (abortEmpty) this.abortEmpty();
    if (this.live && ![...this.inFlight.values()].includes(this.live)) { this.live.controller.abort(); this.live.run = undefined; }
    this.live = undefined;
    this.gate.cancel(); clearTimeout(this.timer); this.timer = undefined; clearTimeout(this.sendTimer);
    this.automatic = false; this.pending = null; this.attempt = undefined;
    this.connector.send({ type: 'clear' });
    if (hadLive || /^(Tab to accept|Thinking|Connection interrupted|Preparing an automatic|Automatic reply queued)/.test(this.message)) this.message = 'Ready';
    this.armTimer();
    this.reconcileLive();
  }
  private activeConfigurationKey(learning = false) {
    return JSON.stringify([this.outputConfiguration(this.snapshot, learning), resolveSettings(this.store.state, this.snapshot.kind, this.chatIdentity()).values.suggestions]);
  }
  /** Local observation is independent of suggestion eligibility and refreshes. */
  private observeStyle() {
    const next = this.snapshot, settingsId = this.chatIdentity(next);
    if (!this.store.state.global.aiFeatures || this.suspended || !next.ready || !settingsId) return;
    const preferences = resolveSettings(this.store.state, next.kind, settingsId).values;
    if (!preferences.learnFromSent || preferences.style !== 'conversation') return;
    const observation = this.observed.get(settingsId) ?? { samples: new Map<string, string>(), hasProfile: false };
    const { samples } = observation;
    next.messages.filter(m => m.outgoing && !m.directionFallback && m.text).forEach(m => samples.set(m.id, m.text));
    while (samples.size > 100) samples.delete(samples.keys().next().value!);
    this.observed.set(settingsId, observation);
    // Explicitly edited/selected profiles are never silently replaced.
    const existing = this.store.state.profiles[settingsId];
    observation.hasProfile = Boolean(existing);
    if (!existing || existing.source === 'observed') {
      const profile = learnStyle([...samples.values()], 'observed');
      if (profile && profile.samples >= (existing?.samples ?? 0) &&
          (profile.samples !== existing?.samples || profile.description !== existing?.description)) {
        this.store.update(s => { s.profiles[settingsId] = profile; });
        this.outputConfiguration(next, true);
      }
    }
    observation.hasProfile = Boolean(this.store.state.profiles[settingsId]);
  }
  reconfigure(options: { keyProvider?: Provider; learning?: boolean; autoRules?: boolean } = {}) {
    if (!this.store.state.global.aiFeatures) {
      this.cancel(true); this.cache.clear(); this.baseline = this.snapshot.messages.at(-1)?.id; this.fresh = undefined;
      this.message = 'Ready'; this.changed(); return;
    }
    if (options.keyProvider) { this.keyVersions[options.keyProvider]++; this.abortEmpty(options.keyProvider); }
    // Invalidate only entries whose effective output settings changed, including
    // inactive chats; changing another chat must not discard this chat's reply.
    for (const [id, record] of this.conversations) {
      if (id.startsWith('document:')) continue;
      const snapshot = { ...emptySnapshot, settingsId: id, kind: record.kind };
      this.outputConfiguration(snapshot, options.learning);
    }
    const activeConfiguration = this.activeConfigurationKey(options.learning);
    const affectsOutput = activeConfiguration !== this.activeConfiguration;
    this.activeConfiguration = activeConfiguration;
    // Retain unloaded samples across unrelated edits. Effective learning settings
    // respect per-chat overrides, so global disable clears only inheriting chats.
    for (const [id, observation] of this.observed) {
      if (!resolveSettings(this.store.state, 'unknown', id).values.learnFromSent ||
          (observation.hasProfile && !this.store.state.profiles[id])) this.observed.delete(id);
    }
    const requiresCancellation = affectsOutput || options.autoRules;
    if (requiresCancellation) {
      if (affectsOutput) this.cancel();
      else this.cancelAutomatic();
      this.baseline = this.snapshot.messages.at(-1)?.id; this.fresh = undefined;
    }
    // Learning writes cannot keep stale automatic work alive or skip refresh.
    try { this.observeStyle(); }
    finally {
      if (affectsOutput) this.refresh();
      this.resumeAdmission();
      this.changed();
    }
  }
  private cancelAutomatic() { if (this.automatic || this.attempt || this.pending) this.cancel(); }
  /** Drop navigation/crash state; never process the old document's snapshot again. */
  suspend() {
    clearTimeout(this.snapshotTimer); this.displayRefresh = undefined;
    this.cancel(true); this.clearTransient(); this.snapshot = emptySnapshot; this.suspended = true; this.refreshNonce = undefined; this.freshAfterTimeout = false;
    this.baseline = undefined; this.fresh = undefined; this.changed();
  }
  refresh(documentLoaded = false) {
    if (this.suspended && !documentLoaded) return;
    this.cancel();
    this.freshAfterTimeout = false;
    clearTimeout(this.snapshotTimer);
    this.refreshNonce = randomUUID();
    this.decision('refresh_pending', 'refresh', this.refreshNonce);
    this.requestRefreshSnapshot(this.refreshNonce, 0);
    this.reconcileLive();
  }
  private requestRefreshSnapshot(nonce: string, attempt: number) {
    // Retry snapshots only. Reuse the nonce so a late acknowledgement of any
    // recovery attempt is still valid; a newer refresh invalidates all of them.
    this.snapshotTimer = setTimeout(() => {
      if (this.refreshNonce !== nonce) return;
      if (attempt < 2) this.requestRefreshSnapshot(nonce, attempt + 1);
      else if (!this.suspended) {
        this.refreshNonce = undefined;
        this.freshAfterTimeout = true;
        this.decision(undefined, 'refresh');
      }
      this.changed();
    }, 1000);
    this.connector.send({ type: 'snapshot', nonce });
  }
  private requireActiveChat(chatId: string) {
    if (chatId !== this.snapshot.chatId || !this.snapshot.ready) throw new Error('Open this conversation before changing its automatic-reply settings.');
  }
  updateAutoRules(chatId: string, patch: AutoPatch) {
    this.requireActiveChat(chatId);
    this.cancelAutomatic();
    try {
      this.store.update(s => {
        const current = s.auto[chatId] ?? defaultAuto;
        s.auto[chatId] = { ...current, ...patch, enabled: current.enabled, paused: current.paused || this.runtimePaused.has(chatId) };
      });
    } finally { this.reconfigure({ autoRules: true }); }
  }
  changeAutoPermission(chatId: string, permission: AutoPermission) {
    this.requireActiveChat(chatId);
    const current = this.store.state.auto[chatId] ?? defaultAuto;
    if (permission === 'resume' && !current.enabled) throw new Error('Enable automatic replies in this chat before resuming.');
    // A repeated enable is not a resume. Only a deliberate permission transition clears takeover.
    const arm = permission === 'resume' || (permission === 'enable' && !current.enabled);
    if (permission === 'pause' || permission === 'disable') this.runtimePaused.add(chatId);
    this.cancelAutomatic();
    try {
      this.store.update(s => {
        s.auto[chatId] = { ...current, enabled: permission === 'disable' ? false : permission === 'enable' ? true : current.enabled,
          paused: arm ? false : permission === 'pause' || permission === 'disable' || current.paused || this.runtimePaused.has(chatId) };
      });
      if (arm) this.runtimePaused.delete(chatId);
    } finally { this.reconfigure({ autoRules: true }); }
  }
  isRuntimePaused() { return Boolean(this.snapshot.chatId && this.runtimePaused.has(this.snapshot.chatId)); }
  dismiss(source?: { suggestionId?: string; key?: string; requestId?: string }) {
    const id = source?.suggestionId ?? source?.requestId;
    const target = id ? this.dismissalTargets.get(id) : undefined;
    // Remote dismissals target only a main-owned item that was actually shown.
    // An unbound notice/menu must never cancel a newer request behind it.
    if (source && !target) return;
    const work = target?.work ?? this.live;
    const key = target ? target.emptyKey : !this.snapshot.draft && this.emptyKey();
    if (key && this.validContext(key)) this.remember(key, { dismissed: true });
    if (target?.draft && target.identity === this.recordIdentity() && target.draft === this.normalizeDraft(this.snapshot.draft)) this.requested.set(target.identity, target.draft);
    else if (!target && this.snapshot.ready && this.snapshot.draft) this.requested.set(this.recordIdentity(), this.normalizeDraft(this.snapshot.draft));
    this.decision('dismissed', 'dismiss', key || target?.draft || this.inlineSignature());
    // Retire detached work too, without touching a genuinely newer live item.
    if (work) {
      work.controller.abort(); work.run = undefined; work.due = undefined;
      for (const [context, pending] of this.inFlight) if (pending === work) this.inFlight.delete(context);
    }
    const current = !source || (source.requestId ? this.live?.id === source.requestId : this.live?.offer?.id === source.suggestionId);
    if (current) {
      // A visible offer can be retained by its pending refinement.
      if (this.live && this.live !== work) {
        this.live.controller.abort();
        for (const [context, pending] of this.inFlight) if (pending === this.live) this.inFlight.delete(context);
      }
      this.cancel();
    } else this.armTimer();
    this.resumeAdmission(); this.changed();
  }
  activity(editing = false) {
    const before = { message: this.message, pending: this.pending, state: this.store.state, paused: this.isRuntimePaused() };
    if (this.automatic || (editing && !this.live?.request)) {
      if (this.live || this.automatic || this.pending || this.attempt || this.admission || this.displayRefresh) this.cancel();
      else this.gate.cancel();
    } else if (editing && this.live && (!this.live.awaitingSnapshot || this.live.offer || this.displayRefresh)) {
      // Hide stale text now; the following snapshot decides whether recovery is
      // compatible. Whitespace input must not lose its backoff or replay.
      this.live.offer = undefined; this.live.awaitingSnapshot = true;
      if (this.displayRefresh) { clearTimeout(this.snapshotTimer); this.displayRefresh = undefined; }
      this.decision('awaiting_snapshot', 'lifecycle');
      this.connector.send({ type: 'clear' }); this.armTimer();
    }
    const id = this.snapshot.chatId;
    if (id && this.store.state.auto[id]?.enabled && !this.store.state.auto[id].paused && !this.runtimePaused.has(id)) {
      this.runtimePaused.add(id); // Safety cannot depend on the disk write succeeding.
      try { this.store.update(s => { s.auto[id].paused = true; }); }
      catch { this.message = 'Automatic replies paused for this session; saving the pause failed. Resume explicitly after fixing local storage.'; this.changed(); return; }
      this.message = 'Automatic replies paused because you took over. Resume in this chat’s settings.';
    }
    this.reconcileLive();
    if (before.message !== this.message || before.pending !== this.pending || before.state !== this.store.state || before.paused !== this.isRuntimePaused()) this.onChanged();
  }
  receive(next: Snapshot, force = false, refreshNonce?: string) {
    try { this.receiveSnapshot(next, force, refreshNonce); }
    finally { this.reconcileLive(); }
  }
  private receiveSnapshot(next: Snapshot, force: boolean, refreshNonce?: string) {
    const displayRecovery = Boolean(this.displayRefresh && refreshNonce === this.displayRefresh.nonce);
    if (displayRecovery) { this.displayRefresh = undefined; clearTimeout(this.snapshotTimer); }
    if (this.suspended || this.refreshNonce) {
      if (!this.refreshNonce || refreshNonce !== this.refreshNonce) return;
      this.refreshNonce = undefined; this.suspended = false; force = true;
      clearTimeout(this.snapshotTimer); this.decision(undefined, 'refresh');
    }
    if (this.freshAfterTimeout) { force = true; this.freshAfterTimeout = false; }
    if (!force && !displayRecovery && !this.live?.awaitingSnapshot && snapshotKey(next) === snapshotKey(this.snapshot) && next.settingsId === this.snapshot.settingsId) return;
    const previous = this.snapshot, previousIdentity = this.recordIdentity();
    const changedChat = previous.chatId !== next.chatId || previous.name !== next.name || previous.revision !== next.revision;
    const switched = changedChat || !previous.ready;
    const recoveringOffer = Boolean(this.live?.offer && (displayRecovery || this.displayRefresh?.id === this.live.offer.id));
    const displayReady = next.ready && !next.composing && !next.draftIssue;
    const compatible = !force && !changedChat && (!switched || this.live?.offer?.displayed === false) && next.conversationOpen &&
      (displayReady || recoveringOffer && previous.draft === next.draft) && this.live?.signature === this.inlineSignature(next);
    if (this.automatic || !compatible) this.cancel();
    else if (this.live?.offer && previous.draft !== next.draft) {
      this.live.offer = undefined; this.connector.send({ type: 'clear' }); this.message = 'Ready';
    }
    if (changedChat || !next.conversationOpen) this.clearTransient();
    this.snapshot = next;
    if (compatible && this.live) {
      const edited = this.live.awaitingSnapshot, deferred = Boolean(this.live.deferred); this.live.awaitingSnapshot = false;
      this.decision(undefined, 'lifecycle');
      this.reconcileLive();
      if (!deferred && displayReady && (displayRecovery || edited || suggestionKey(previous) !== suggestionKey(next))) this.publishLive();
      else if (displayRecovery && this.live.offer && !displayReady && (this.live.offer.displayAttempts ?? 0) < 3) this.recoverDisplay(this.live.offer);
      if (edited) this.armTimer();
    }
    if (previous.draftIssue && !next.draftIssue) this.message = 'Ready';
    if (switched) { this.baseline = next.messages.at(-1)?.id; this.fresh = undefined; this.seenMessages.clear(); this.seenCapacityReached = false; }
    else if (previous.messages.at(-1)?.id !== next.messages.at(-1)?.id) {
      const last = next.messages.at(-1);
      this.fresh = last && last.outgoing === false && !this.seenCapacityReached && !this.seenMessages.has(last.id) ? { id: last.id, seenAt: Date.now() } : undefined;
    }
    for (const message of next.messages) {
      if (this.seenMessages.size < 10000) this.seenMessages.add(message.id);
      else this.seenCapacityReached = true;
    }
    if (!next.ready) { this.decision('composer_unready'); this.changed(); return; }
    // Touch the conversation LRU only on observation, not on settings scans.
    this.outputConfiguration(next);
    const conversationId = this.recordIdentity(next), conversation = this.conversations.get(conversationId);
    if (conversation && conversationId) { this.conversations.delete(conversationId); this.conversations.set(conversationId, conversation); }
    const normalized = this.normalizeDraft(next.draft);
    if (this.requested.get(conversationId) !== normalized || !normalized) this.requested.delete(conversationId);
    if (this.message === 'Open a conversation to use writing assistance.') this.message = 'Ready';
    const settingsId = next.settingsId ?? next.chatId;
    const preferences = resolveSettings(this.store.state, next.kind, settingsId).values;
    try { this.observeStyle(); }
    finally { this.completeSnapshot(next, preferences, previousIdentity !== this.recordIdentity() || !previous.ready ? 'open/revisit' : 'incoming message'); }
  }
  private completeSnapshot(next: Snapshot, preferences: Preferences, reason: RequestReason) {
    if (!this.store.state.global.aiFeatures) { this.changed(); return; }
    const normalized = this.normalizeDraft(next.draft);
    const configuration = this.outputConfiguration(next);
    this.activeConfiguration = JSON.stringify([configuration, preferences.suggestions]);
    if (next.composing || next.draftIssue) { this.decision(next.composing ? 'composing' : 'draft_issue'); if (next.draftIssue) this.message = this.draftIssueMessage(next); this.changed(); return; }
    let decision: DecisionReason | undefined = !preferences.suggestions ? 'suggestions_disabled' : !preferences.shareContext && !normalized ? 'context_disabled' : this.live?.run && !this.live.request ? 'debouncing_unsettled' : undefined;
    const latestIsFresh = this.fresh?.id === next.messages.at(-1)?.id && this.fresh && Date.now() - this.fresh.seenAt < 60000;
    const rules = next.chatId ? this.store.state.auto[next.chatId] : undefined;
    const canAuto = next.chatId && !this.runtimePaused.has(next.chatId) && latestIsFresh && preferences.shareContext && !autoDecision(rules, next, this.store.state.ledger[next.chatId] ?? [], new Date(), this.baseline);
    if (canAuto) {
      this.schedule(() => { void this.request(undefined, true); }, this.inlineSignature()); this.automatic = true;
    } else if (!this.live && preferences.suggestions) {
      if (normalized) {
        if (isLinkOnlyDraft(next.draft)) decision = 'link_only';
        else if (next.focused && next.caretAtEnd && this.requested.get(this.recordIdentity()) !== normalized) {
          decision = 'debouncing_unsettled';
          this.schedule(() => { void this.request(undefined, false, undefined, 0, 'draft continuation'); }, this.inlineSignature());
        }
      } else if (!next.draft && preferences.shareContext) {
        const key = this.emptyKey(), last = next.messages.at(-1), cached = key ? this.cache.get(key) : undefined;
        if (cached && key) {
          this.remember(key, cached);
          if ('text' in cached && last?.outgoing === false) {
            this.live = { origin: 'auto', id: randomUUID(), signature: this.inlineSignature(), controller: new AbortController() };
            this.show(this.live, cached.text, false);
          } else if ('dismissed' in cached) decision = 'dismissed';
        } else if (key && last?.outgoing === false && (last.text.trim() || last.attachment)) {
          const pending = this.inFlight.get(key);
          if (pending) { this.live = pending; pending.awaitingSnapshot = false; this.publishLive(); this.reconcileLive(); this.armTimer(); }
          else if (this.inFlight.size < 5) {
            decision = 'debouncing_unsettled';
            this.schedule(() => { void this.request(undefined, false, undefined, 0, reason); }, this.inlineSignature());
          } else {
            this.admission = { signature: this.inlineSignature(), reason }; decision = 'capacity_full';
          }
        } else decision = last?.outgoing === null ? 'unknown_direction' : last?.outgoing === true ? 'owner_last' : 'unreadable_latest';
      }
    }
    this.decision(decision); this.changed();
  }
  private resumeAdmission() {
    const candidate = this.admission;
    if (!candidate || this.inFlight.size >= 5) return;
    this.admission = undefined;
    if (this.live || this.suspended || this.refreshNonce || !this.snapshot.ready || candidate.signature !== this.inlineSignature()) return;
    const preferences = resolveSettings(this.store.state, this.snapshot.kind, this.chatIdentity()).values;
    this.completeSnapshot(this.snapshot, preferences, candidate.reason);
  }
  async request(instruction?: string, automatic = false, source?: RequestSource, retry = 0, reason?: RequestReason, origin?: RequestOrigin) {
    if (!this.store.state.global.aiFeatures || this.suspended || this.refreshNonce) return;
    const snapshot = this.snapshot, previous = this.live;
    if (source?.key && source.key !== suggestionKey(snapshot)) return;
    const replay = source?.operation === 'retry' && previous?.error ? previous.request : undefined;
    if (source?.operation === 'retry' && source.key && !replay) return;
    if (replay) instruction = replay.instruction;
    if (!snapshot.ready || (automatic && !snapshot.chatId) || snapshot.composing) return;
    if (snapshot.draftIssue) { this.message = this.draftIssueMessage(snapshot); this.connector.send({ type: 'notice', text: this.message }); this.changed(); return; }
    if (!automatic && !instruction && snapshot.draft && (!snapshot.caretAtEnd || (reason === 'draft continuation' && !snapshot.focused))) {
      this.cancel(); this.changed(); return;
    }
    // Only a main-owned offer selected by the visible control substitutes for an empty draft.
    const suggested = !snapshot.draft.trim() && source?.suggestionId && previous?.offer?.id === source.suggestionId && previous.offer.key === suggestionKey(snapshot) ? previous.offer.text : undefined;
    const draft = snapshot.draft.trim() ? snapshot.draft : instruction ? replay?.draft ?? suggested ?? '' : snapshot.draft;
    if (instruction && !draft.trim()) { this.message = 'Write a message or wait for a suggestion, then try again.'; this.connector.send({ type: 'notice', text: this.message }); this.changed(); return; }
    const preferences = resolveSettings(this.store.state, snapshot.kind, this.chatIdentity()).values;
    if (!preferences.shareContext && !draft) { this.message = 'Enable conversation context in Settings → Replies to suggest a reply, or type a draft to refine.'; this.connector.send({ type: 'notice', text: this.message }); this.changed(); return; }
    const request: InlineRequest = { operation: replay?.operation ?? (instruction ? source?.operation === 'translate' ? 'translate' : 'refine' : snapshot.draft.trim() ? 'continuation' : 'suggest'),
      instruction, draft, composerDraft: snapshot.draft, contextKey: this.emptyKey(),
      reason: retry || replay ? 'retry' : automatic ? 'auto reply' : reason ?? (instruction ? source?.operation === 'translate' ? 'translate' : 'refine' : source?.operation === 'retry' ? 'retry' : 'explicit suggest') };
    const emptyKey = !automatic && !snapshot.draft && !instruction && (reason === 'open/revisit' || reason === 'incoming message') ? request.contextKey : undefined;
    // All user actions, including replay, supersede detached work for this
    // context; navigation's ordinary cancel still preserves other chats.
    if (!automatic && reason === undefined && retry === 0) this.supersedeEmpty(request.contextKey);
    if (emptyKey) {
      const pending = this.inFlight.get(emptyKey);
      if (pending) { this.cancel(); this.live = pending; pending.awaitingSnapshot = false; this.publishLive(); this.armTimer(); this.changed(); return; }
      if (this.inFlight.size >= 5) { this.cancel(); this.admission = { signature: this.inlineSignature(), reason: reason! }; this.decision('capacity_full'); this.changed(); return; }
    }
    this.cancel();
    if (this.normalizeDraft(snapshot.draft)) this.requested.set(this.recordIdentity(), this.normalizeDraft(snapshot.draft));
    const work: Live = { origin: origin ?? (automatic || reason === 'draft continuation' || reason === 'incoming message' || reason === 'open/revisit' ? 'auto' : 'user'), id: randomUUID(), signature: this.inlineSignature(), controller: new AbortController(), request, running: true, offer: suggested !== undefined ? previous?.offer : undefined };
    this.live = automatic ? undefined : work; this.automatic = automatic;
    if (emptyKey) this.inFlight.set(emptyKey, work);
    this.decision(undefined);
    const ticket = automatic ? this.gate.begin(snapshot, true) : undefined;
    if (!automatic) this.sendPending(work);
    this.message = automatic ? 'Preparing an automatic reply…' : 'Thinking…'; this.changed();
    const state = this.store.state, prompt = buildPrompt(state, preferences, { ...snapshot, draft }, instruction);
    const input = { provider: state.provider, model: state.models[state.provider], effort: savedEffort(state), ...prompt };
    const run = async (attempt: number): Promise<void> => {
      const alive = () => this.store.state.global.aiFeatures && (emptyKey ? this.inFlight.get(emptyKey) === work && !work.controller.signal.aborted : ticket ? this.gate.current(ticket, this.snapshot) : this.current(work));
      const finish = () => { if (emptyKey && this.inFlight.get(emptyKey) === work) this.inFlight.delete(emptyKey); };
      try {
        if (!alive()) { this.decision('stale_context', 'completion', work.signature); return; }
        work.running = true;
        let text = this.fixture ? instruction ? 'That sounds lovely. See you then!' : snapshot.draft ? ' see you then!' : 'Sounds good, see you then!' : await this.generator({ ...input, key: this.vault.get(input.provider), reason: attempt ? 'retry' : request.reason, signal: ticket?.signal ?? work.controller.signal });
        // Fixture-only latency; desktop checks may lengthen it to observe loading states under load.
        if (this.fixture) await new Promise(resolve => setTimeout(resolve, Number((globalThis as { fixtureGenerationDelayMs?: number }).fixtureGenerationDelayMs) || 200));
        if (!alive()) { this.decision('stale_context', 'completion', work.signature); return; }
        if (!automatic && !this.validContext(request.contextKey) && request.contextKey) { this.decision('stale_context', 'completion', work.signature); finish(); if (this.live === work) this.cancel(); return; }
        if (!snapshot.draft || instruction) text = text.trim();
        // Detached automatic replies may complete off-view. Only incoming-message text is cached, and stale configurations cannot repopulate it.
        if (!automatic && !snapshot.draft && snapshot.messages.at(-1)?.outgoing === false && this.validContext(request.contextKey) && (!emptyKey || !this.cache.has(request.contextKey!)))
          this.remember(request.contextKey!, { text });
        finish();
        work.running = false;
        if (ticket) {
          const rules = this.store.state.auto[snapshot.chatId!] ?? defaultAuto;
          this.pending = { text, due: Date.now() + rules.delaySeconds * 1000 }; this.message = 'Automatic reply queued. Typing or Cancel pauses sending.';
          this.sendTimer = setTimeout(() => this.sendAutomatic(ticket, text), rules.delaySeconds * 1000);
        } else if (this.current(work)) {
          work.offer = undefined; work.error = undefined;
          work.deferred = { text, replace: Boolean(instruction) };
        } else this.decision('stale_context', 'completion', work.signature);
      } catch (error) {
        if (!alive()) { this.decision('stale_context', 'completion', work.signature); return; }
        work.running = false;
        if (emptyKey && this.cache.has(emptyKey)) { finish(); return; }
        const message = error instanceof Error ? error.message : 'Unable to generate a reply.';
        if (!automatic && this.current(work) && work.awaitingSnapshot) {
          finish(); work.offer = undefined; work.error = undefined; work.deferred = { error: message }; return;
        }
        if (!automatic && !instruction && error instanceof ProviderError && error.retryable && attempt < 1) {
          work.due = Date.now() + 2000;
          work.run = () => {
            if (!alive()) return;
            if (emptyKey && (this.cache.has(emptyKey) || !this.validContext(request.contextKey) || !resolveSettings(this.store.state, snapshot.kind, this.chatIdentity(snapshot)).values.suggestions)) { finish(); return; }
            if (!emptyKey && request.operation === 'continuation' && (!this.snapshot.focused || !this.snapshot.caretAtEnd)) {
              work.error = this.message = 'Suggestion interrupted. Try again.';
              this.sendNotice(work, this.message); this.changed(); return;
            }
            // Continuation retries always use the current exact whitespace boundary.
            if (!emptyKey && request.operation === 'continuation') {
              void this.request(undefined, false, undefined, 1, 'retry', work.origin);
            } else void run(attempt + 1);
          };
          this.armTimer(); return;
        }
        finish();
        if (!ticket && !this.current(work)) return;
        if (!automatic) {
          if (!this.matches(request)) { this.cancel(); return; }
          if (work.offer && work.offer.key === suggestionKey(this.snapshot)) this.sendOffer(work.offer, work);
          work.error = message;
          this.sendNotice(work, message);
        } else { this.message = message; this.connector.send({ type: 'notice', text: message }); }
      } finally {
        work.running = false;
        this.changed();
        this.resumeAdmission();
      }
    };
    await run(retry);
  }
  private draftIssueMessage(snapshot: Snapshot) {
    return snapshot.draftIssue === 'too-long' ? 'This draft exceeds 8,000 characters. Shorten it before requesting assistance; your draft is unchanged.' : 'This draft contains a mention or embedded content that cannot be preserved safely. Edit it manually; your draft is unchanged.';
  }
  private sendAutomatic(ticket: ReturnType<SuggestionGate['begin']>, text: string) {
    const s = this.snapshot, id = s.chatId;
    if (!this.store.state.global.aiFeatures || !id || this.runtimePaused.has(id) || !this.gate.current(ticket, s) || !resolveSettings(this.store.state, s.kind, id).values.shareContext || autoDecision(this.store.state.auto[id], s, this.store.state.ledger[id] ?? [], new Date(), this.baseline)) { this.cancel(); this.changed(); return; }
    const expiresAt = autoSendExpiry(this.store.state.auto[id], new Date());
    const reservation = { at: Date.now(), messageId: s.messages.at(-1)!.id };
    // Reserve before dispatch. Failed/ambiguous attempts consume budget and cannot be retried after a crash.
    try { this.store.update(state => { state.ledger[id] = [...(state.ledger[id] ?? []).filter(x => Date.now() - x.at < 86400000 * 2), reservation].slice(-100); }); }
    catch { this.cancel(); this.message = 'Could not persist the send budget. Automatic reply cancelled.'; this.changed(); return; }
    if (Date.now() >= expiresAt) { this.cancel(); this.message = 'Automatic send permission expired. The attempt will not be retried.'; this.changed(); return; }
    this.attempt = { nonce: randomUUID(), ticket, expiresAt, reservation, approved: false }; this.pending = null;
    this.connector.send({ type: 'autoSend', key: ticket.key, text, nonce: this.attempt.nonce, expiresAt });
    this.message = 'Automatic reply dispatched; waiting for composer confirmation.'; this.changed();
  }
  authorizeAutomatic(nonce: string): boolean {
    const attempt = this.attempt, s = this.snapshot, id = s.chatId;
    if (!this.store.state.global.aiFeatures || !attempt || attempt.nonce !== nonce || attempt.approved || Date.now() >= attempt.expiresAt || !id || this.runtimePaused.has(id) || !this.gate.current(attempt.ticket, s) || !resolveSettings(this.store.state, s.kind, id).values.shareContext) return false;
    // Recheck main-owned permission after the renderer finishes waiting for Send.
    // Only this attempt's durable reservation is excluded from budget evaluation.
    const ledger = this.store.state.ledger[id] ?? [];
    const ownReservation = (entry: typeof attempt.reservation) => entry.at === attempt.reservation.at && entry.messageId === attempt.reservation.messageId;
    if (!ledger.some(ownReservation) || autoDecision(this.store.state.auto[id], s, ledger.filter(entry => !ownReservation(entry)), new Date(), this.baseline)) return false;
    attempt.approved = true;
    return true;
  }
  result(nonce: string, sent: boolean) {
    if (nonce !== this.attempt?.nonce) return;
    this.attempt = undefined;
    this.message = sent ? 'Automatic reply submitted to WhatsApp. Delivery is managed by WhatsApp.' : 'Composer changed or send control unavailable. Automatic reply cancelled.';
    this.changed();
  }
}
