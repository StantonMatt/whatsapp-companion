import { createHash, randomUUID } from 'node:crypto';
import type { Snapshot } from '../shared/model';
import type { Store } from './store';

// Modern WhatsApp exposes opaque message IDs, not a conversation identifier.
// Recognize an observed conversation through overlap, never names, text or participants.
// These IDs scope local preferences/style ONLY. They cannot authorize a send.
export class Conversations {
  constructor(private store: Store) {}
  identify(snapshot: Snapshot): string | null {
    if (!snapshot.conversationOpen) return null;
    if (snapshot.chatId) return snapshot.chatId;
    const anchors = [...new Set(snapshot.messages.map(m => m.id).filter(id => /^[A-Za-z0-9_-]{6,150}$/.test(id)))].map(id => createHash('sha256').update(id).digest('hex'));
    if (!anchors.length) return null;
    const wanted = new Set(anchors);
    const matches = Object.entries(this.store.state.conversations).filter(([, saved]) => saved.some(id => wanted.has(id)));
    // Mixed/transitional DOM snapshots must never merge two private profiles.
    if (matches.length > 1) return null;
    if (!matches.length && Object.keys(this.store.state.conversations).length >= 2000) return null;
    const id = matches[0]?.[0] ?? `local:${randomUUID()}`;
    const saved = matches[0]?.[1] ?? [];
    if (anchors.some(anchor => !saved.includes(anchor))) {
      this.store.update(state => { state.conversations[id] = [...saved.filter(anchor => !wanted.has(anchor)), ...anchors].slice(-200); });
    }
    return id;
  }
}
