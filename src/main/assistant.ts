import { randomUUID } from 'node:crypto';
import { emptySnapshot, defaultAuto, type Snapshot, type Status, type AutoPatch, type AutoPermission } from '../shared/model';
import type { Connector } from '../shared/connector';
import { resolveSettings } from '../core/settings';
import { SuggestionGate, snapshotKey, suggestionContext, suggestionKey } from '../core/suggestions';
import { autoDecision, autoSendExpiry } from '../core/auto-reply';
import { learnStyle } from '../core/style';
import { savedEffort } from '../core/model-policy';
import { generate, buildPrompt } from './providers';
import type { Store } from './store';
import type { Vault } from './vault';

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
  private dismissedContext?: string;
  private inlineKey?: string;
  private automatic = false;
  private observed = new Map<string, Map<string, string>>();
  constructor(private store: Store, private vault: Vault, private connector: Connector, private changed: () => void, private fixture: boolean, private generator: typeof generate = generate) {}
  cancel() {
    this.gate.cancel(); clearTimeout(this.timer); clearTimeout(this.sendTimer);
    this.inlineKey = undefined; this.automatic = false;
    this.pending = null; this.attempt = undefined; this.connector.send({ type: 'clear' });
    if (/^(Tab to accept|Thinking|Preparing an automatic|Automatic reply queued)/.test(this.message)) this.message = 'Ready';
  }
  reconfigure() {
    this.cancel(); this.baseline = this.snapshot.messages.at(-1)?.id; this.fresh = undefined;
    this.observed.clear(); this.receive(this.snapshot, true);
  }
  private requireActiveChat(chatId: string) {
    if (chatId !== this.snapshot.chatId || !this.snapshot.ready) throw new Error('Open this conversation before changing its automatic-reply settings.');
  }
  updateAutoRules(chatId: string, patch: AutoPatch) {
    this.requireActiveChat(chatId);
    this.store.update(s => {
      const current = s.auto[chatId] ?? defaultAuto;
      s.auto[chatId] = { ...current, ...patch, enabled: current.enabled, paused: current.paused || this.runtimePaused.has(chatId) };
    });
    this.reconfigure();
  }
  changeAutoPermission(chatId: string, permission: AutoPermission) {
    this.requireActiveChat(chatId);
    const current = this.store.state.auto[chatId] ?? defaultAuto;
    if (permission === 'resume' && !current.enabled) throw new Error('Enable automatic replies in this chat before resuming.');
    // A repeated enable is not a resume. Only a deliberate permission transition clears takeover.
    const arm = permission === 'resume' || (permission === 'enable' && !current.enabled);
    if (permission === 'pause' || permission === 'disable') { this.runtimePaused.add(chatId); this.cancel(); }
    try {
      this.store.update(s => {
        s.auto[chatId] = { ...current, enabled: permission === 'disable' ? false : permission === 'enable' ? true : current.enabled,
          paused: arm ? false : permission === 'pause' || permission === 'disable' || current.paused || this.runtimePaused.has(chatId) };
      });
    } catch (error) { this.changed(); throw error; }
    if (arm) this.runtimePaused.delete(chatId);
    this.reconfigure();
  }
  isRuntimePaused() { return Boolean(this.snapshot.chatId && this.runtimePaused.has(this.snapshot.chatId)); }
  dismiss() { this.cancel(); this.dismissedContext = suggestionContext(this.snapshot); this.changed(); }
  activity(editing = false) {
    if (editing || this.automatic) this.cancel();
    const id = this.snapshot.chatId;
    if (id && this.store.state.auto[id]?.enabled && !this.store.state.auto[id].paused) {
      this.runtimePaused.add(id); // Safety cannot depend on the disk write succeeding.
      try { this.store.update(s => { s.auto[id].paused = true; }); }
      catch { this.message = 'Automatic replies paused for this session; saving the pause failed. Resume explicitly after fixing local storage.'; this.changed(); return; }
      this.message = 'Automatic replies paused because you took over. Resume in this chat’s settings.';
    }
    this.changed();
  }
  receive(next: Snapshot, force = false) {
    if (!force && snapshotKey(next) === snapshotKey(this.snapshot) && next.settingsId === this.snapshot.settingsId) return;
    const previous = this.snapshot;
    const switched = previous.chatId !== next.chatId || previous.name !== next.name || previous.revision !== next.revision || !previous.ready;
    if (previous.settingsId !== next.settingsId || this.automatic || suggestionKey(previous) !== suggestionKey(next)) this.cancel();
    this.snapshot = next;
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
    if (!next.ready) { this.changed(); return; }
    if (this.message === 'Open a conversation to use writing assistance.') this.message = 'Ready';
    const settingsId = next.settingsId ?? next.chatId;
    const preferences = resolveSettings(this.store.state, next.kind, settingsId).values;
    if (settingsId && preferences.learnFromSent && preferences.style === 'conversation') {
      const samples = this.observed.get(settingsId) ?? new Map<string, string>();
      next.messages.filter(m => m.outgoing && m.text).forEach(m => samples.set(m.id, m.text));
      while (samples.size > 100) samples.delete(samples.keys().next().value!);
      this.observed.set(settingsId, samples);
      // Explicitly edited/selected profiles are never silently replaced.
      const existing = this.store.state.profiles[settingsId];
      if (!existing || existing.source === 'observed') {
        const profile = learnStyle([...samples.values()], 'observed');
        if (profile && (profile.samples !== existing?.samples || profile.description !== existing?.description)) this.store.update(s => { s.profiles[settingsId] = profile; });
      }
    }
    if (next.composing || next.draftIssue) { if (next.draftIssue) this.message = this.draftIssueMessage(next); this.changed(); return; }
    const latestIsFresh = this.fresh?.id === next.messages.at(-1)?.id && this.fresh && Date.now() - this.fresh.seenAt < 60000;
    const rules = next.chatId ? this.store.state.auto[next.chatId] : undefined;
    const canAuto = next.chatId && !this.runtimePaused.has(next.chatId) && latestIsFresh && preferences.shareContext && !autoDecision(rules, next, this.store.state.ledger[next.chatId] ?? [], new Date(), this.baseline);
    if (canAuto) { this.cancel(); this.automatic = true; this.timer = setTimeout(() => { void this.request(undefined, true); }, 1000); }
    else if (this.inlineKey !== suggestionKey(next) && this.dismissedContext !== suggestionContext(next) && preferences.suggestions && (next.draft ? next.focused && next.caretAtEnd : preferences.shareContext && next.messages.some(m => m.text.trim() || m.attachment))) {
      this.inlineKey = suggestionKey(next);
      this.timer = setTimeout(() => { void this.request(); }, next.draft ? 250 : 0);
    }
    this.changed();
  }
  async request(instruction?: string, automatic = false) {
    const snapshot = this.snapshot;
    if (!snapshot.ready || (automatic && !snapshot.chatId) || snapshot.composing) return;
    clearTimeout(this.timer); clearTimeout(this.sendTimer); this.pending = null;
    if (snapshot.draftIssue) { this.message = this.draftIssueMessage(snapshot); this.connector.send({ type: 'notice', text: this.message }); this.changed(); return; }
    if (!automatic && snapshot.draft && !snapshot.caretAtEnd) { this.inlineKey = undefined; return; }
    if (instruction && !snapshot.draft.trim()) { this.message = 'Type a draft before refining it.'; this.connector.send({ type: 'notice', text: this.message }); this.changed(); return; }
    const preferences = resolveSettings(this.store.state, snapshot.kind, snapshot.settingsId ?? snapshot.chatId).values;
    if (!preferences.shareContext && !snapshot.draft) { this.message = 'Enable conversation context in AI settings → Replies to suggest a reply, or type a draft to refine.'; this.connector.send({ type: 'notice', text: this.message }); this.changed(); return; }
    const ticket = this.gate.begin(snapshot, automatic);
    this.automatic = automatic; this.inlineKey = automatic ? undefined : ticket.key;
    this.message = automatic ? 'Preparing an automatic reply…' : 'Thinking…'; this.changed();
    try {
      const state = this.store.state;
      const prompt = buildPrompt(state, preferences, snapshot, instruction);
      let text = this.fixture ? instruction ? 'That sounds lovely. See you then!' : snapshot.draft ? ' see you then!' : 'Sounds good, see you then!' : await this.generator({ provider: state.provider, model: state.models[state.provider], effort: savedEffort(state), key: this.vault.get(state.provider), ...prompt, signal: ticket.signal });
      if (this.fixture) await new Promise(resolve => setTimeout(resolve, 200));
      if (!this.gate.current(ticket, this.snapshot)) return;
      // A continuation may complete a word ("Thank" + "s!") or start a new one. Preserve its spacing.
      if (!snapshot.draft || instruction) text = text.trim();
      if (!automatic) { this.connector.send({ type: 'suggestion', text, key: ticket.key, replace: Boolean(instruction) }); this.message = 'Tab to accept · Esc to dismiss'; }
      else {
        const rules = this.store.state.auto[snapshot.chatId!] ?? defaultAuto;
        this.pending = { text, due: Date.now() + rules.delaySeconds * 1000 };
        this.message = 'Automatic reply queued. Typing or Cancel pauses sending.';
        this.sendTimer = setTimeout(() => this.sendAutomatic(ticket, text), rules.delaySeconds * 1000);
      }
      this.changed();
    } catch (error) {
      if (!this.gate.current(ticket, this.snapshot)) return;
      this.message = error instanceof Error ? error.message : 'Unable to generate a reply.';
      this.connector.send({ type: 'notice', text: this.message }); this.changed();
    }
  }
  private draftIssueMessage(snapshot: Snapshot) {
    return snapshot.draftIssue === 'too-long' ? 'This draft exceeds 8,000 characters. Shorten it before requesting assistance; your draft is unchanged.' : 'This draft contains a mention or embedded content that cannot be preserved safely. Edit it manually; your draft is unchanged.';
  }
  private sendAutomatic(ticket: ReturnType<SuggestionGate['begin']>, text: string) {
    const s = this.snapshot, id = s.chatId;
    if (!id || this.runtimePaused.has(id) || !this.gate.current(ticket, s) || !resolveSettings(this.store.state, s.kind, id).values.shareContext || autoDecision(this.store.state.auto[id], s, this.store.state.ledger[id] ?? [], new Date(), this.baseline)) { this.cancel(); this.changed(); return; }
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
    if (!attempt || attempt.nonce !== nonce || attempt.approved || Date.now() >= attempt.expiresAt || !id || this.runtimePaused.has(id) || !this.gate.current(attempt.ticket, s) || !resolveSettings(this.store.state, s.kind, id).values.shareContext) return false;
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
