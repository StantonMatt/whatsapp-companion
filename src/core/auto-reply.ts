import type { AutoRules, Snapshot, State } from '../shared/model';

function inPermittedHours(rules: AutoRules, now: Date) {
  const hour = now.getHours();
  return rules.startHour === rules.endHour || (rules.startHour < rules.endHour ? hour >= rules.startHour && hour < rules.endHour : hour >= rules.startHour || hour < rules.endHour);
}

// Main grants a short absolute lease, including any time spent queued in IPC.
export function autoSendExpiry(rules: AutoRules, now: Date): number {
  const issued = now.getTime();
  if (!inPermittedHours(rules, now)) return issued;
  if (rules.startHour === rules.endHour) return issued + 2000;
  const end = new Date(issued);
  end.setHours(rules.endHour, 0, 0, 0);
  if (end.getTime() <= issued) end.setDate(end.getDate() + 1);
  return Math.min(issued + 2000, end.getTime());
}

export function autoDecision(rules: AutoRules | undefined, snapshot: Snapshot, ledger: State['ledger'][string], now: Date, baselineId?: string): string | null {
  if (!rules?.enabled) return 'Disabled';
  if (rules.paused) return 'Paused after user activity';
  if (!snapshot.ready || !snapshot.chatId || !snapshot.atBottom) return 'Conversation not ready at latest messages';
  if (snapshot.draft.length || snapshot.draftIssue || snapshot.composing) return 'User is writing';
  const latest = snapshot.messages.at(-1);
  if (!latest || latest.outgoing !== false || !latest.text.trim() || latest.id === baselineId) return 'No new incoming text';
  if (!inPermittedHours(rules, now)) return 'Outside permitted hours';
  if (ledger.some(x => x.messageId === latest.id)) return 'Already attempted this message';
  if (ledger.filter(x => new Date(x.at).toDateString() === now.toDateString()).length >= rules.dailyLimit) return 'Daily reply limit reached';
  if (ledger.some(x => now.getTime() - x.at < rules.cooldownMinutes * 60000)) return 'Cooldown';
  return null;
}
