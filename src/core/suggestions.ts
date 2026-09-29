import type { Snapshot } from '../shared/model';

// IPC validation may reorder object properties. Compare semantic fields in a fixed order.
function messagesForKey(s: Snapshot) {
  return s.messages.map(m => [m.id, m.text, m.outgoing, m.sender ?? null, m.attachment ?? null,
    m.quoted ? [m.quoted.sender ?? null, m.quoted.text, m.quoted.attachment ?? null] : null]);
}

export function snapshotKey(s: Snapshot): string {
  return JSON.stringify([s.chatId, s.name, s.revision, s.activity, s.editRevision, s.ready, s.atBottom, s.composing, s.focused, s.caretAtEnd, s.draft, s.draftIssue, messagesForKey(s)]);
}
// Inline drafts survive navigation and focus; automatic sends still use the full snapshot.
export function suggestionKey(s: Snapshot): string {
  return JSON.stringify([s.chatId, s.name, s.revision, s.editRevision, s.ready, s.composing, s.draft, s.draftIssue, messagesForKey(s)]);
}
export function suggestionContext(s: Snapshot): string {
  return JSON.stringify([s.chatId, s.name, s.revision, s.editRevision, s.draft, messagesForKey(s)]);
}
export class SuggestionGate {
  private generation = 0;
  private controller?: AbortController;
  cancel() { this.generation++; this.controller?.abort(); }
  begin(snapshot: Snapshot, automatic = false) {
    this.cancel(); this.controller = new AbortController();
    return { generation: this.generation, key: automatic ? snapshotKey(snapshot) : suggestionKey(snapshot), automatic, signal: this.controller.signal };
  }
  current(ticket: ReturnType<SuggestionGate['begin']>, snapshot: Snapshot) {
    return ticket.generation === this.generation && !ticket.signal.aborted && ticket.key === (ticket.automatic ? snapshotKey(snapshot) : suggestionKey(snapshot));
  }
}
