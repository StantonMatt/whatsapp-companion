import type { Snapshot } from '../shared/model';

// IPC validation may reorder object properties. Compare semantic fields in a fixed order.
function messagesForKey(s: Snapshot, authorization = false) {
  return s.messages.map(m => [m.id, m.text, m.outgoing, m.sender ?? null, m.attachment ?? null, m.attachmentName ?? null,
    m.quoted ? [m.quoted.sender ?? null, m.quoted.text, m.quoted.attachment ?? null, m.quoted.attachmentName ?? null] : null,
    ...(authorization ? [m.directionFallback ?? false] : [])]);
}

function snapshotFields(s: Snapshot) {
  return [s.chatId, s.name, s.revision, s.activity, s.editRevision, s.conversationOpen, s.ready, s.atBottom, s.composing, s.focused, s.caretAtEnd, s.draft, s.draftIssue, s.stickerPreparation ?? null];
}
function suggestionFields(s: Snapshot) {
  return [s.chatId, s.name, s.revision, s.editRevision, s.conversationOpen, s.ready, s.composing, s.draft, s.draftIssue];
}
export function snapshotKey(s: Snapshot): string {
  // Maker assignment/teardown can leave the composer unchanged. Deliver both
  // ownership transitions even when no other semantic snapshot field changes.
  return JSON.stringify([...snapshotFields(s), messagesForKey(s, true)]);
}
// Inline drafts survive navigation and focus; automatic sends still use the full snapshot.
export function suggestionKey(s: Snapshot): string {
  return JSON.stringify([...suggestionFields(s), messagesForKey(s)]);
}
export function suggestionContext(s: Snapshot): string {
  return JSON.stringify([s.chatId, s.name, s.revision, s.editRevision, s.draft, messagesForKey(s)]);
}
// Connector-owned immutable message arrays only. Public key functions remain
// uncached for mutable IPC/authorization snapshots.
export class SnapshotKeys {
  private messages?: Snapshot['messages'];
  private context = '';
  private authorizationContext = '';
  keys(s: Snapshot) {
    if (s.messages !== this.messages) {
      this.messages = s.messages;
      this.context = JSON.stringify(messagesForKey(s));
      this.authorizationContext = JSON.stringify(messagesForKey(s, true));
    }
    const join = (fields: unknown[], context: string) => `${JSON.stringify(fields).slice(0, -1)},${context}]`;
    return { snapshot: join(snapshotFields(s), this.authorizationContext), suggestion: join(suggestionFields(s), this.context) };
  }
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
