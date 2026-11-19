import { defaults, type State, type Scope, type Preferences, type ChatKind, type DirectStickerDisabledReason } from '../shared/model';

export function resolveSettings(state: State, _kind: ChatKind, chatId?: string | null) {
  // Legacy kind defaults remain on disk but all chats now inherit directly from global.
  const values = { ...state.global, ...(chatId ? state.chats[chatId] : {}), aiFeatures: state.global.aiFeatures, directStickerSend: state.global.directStickerSend, automaticStickerTags: state.global.automaticStickerTags };
  const sources = Object.fromEntries(Object.keys(defaults).map(key => [key,
    chatId && Object.hasOwn(state.chats[chatId] ?? {}, key) ? 'conversation' : 'global'
  ])) as Record<keyof Preferences, string>;
  return { values, sources };
}
export function setPreferences(state: State, scope: Scope, patch: Partial<Preferences>) {
  if (scope !== 'global' && (patch.aiFeatures !== undefined || patch.directStickerSend !== undefined || patch.automaticStickerTags !== undefined)) throw new Error('Direct sticker sending is a global setting.');
  if (scope === 'global') {
    Object.assign(state[scope], patch);
    if (patch.aiFeatures === false) for (const rules of Object.values(state.auto)) rules.paused = true;
    if (patch.directStickerSend === true) {
      delete state.global.directStickerDisabledReason;
      delete state.global.directStickerDisabledAt;
    }
  }
  else state.chats[scope] = { ...state.chats[scope], ...patch };
}
export function stopDirectStickerSending(state: State, reason: DirectStickerDisabledReason, at = Date.now()) {
  if (!state.global.directStickerSend) return;
  state.global.directStickerSend = false;
  state.global.directStickerDisabledReason = reason;
  state.global.directStickerDisabledAt = at;
}
export function resetPreferences(state: State, scope: Scope) {
  if (scope === 'global') state.global = { ...defaults, aiFeatures: state.global.aiFeatures };
  else delete state.chats[scope];
}
export function resetStylePreferences(state: State, chatId: string) {
  const overrides = state.chats[chatId];
  if (!overrides) return;
  delete overrides.style; delete overrides.learnFromSent;
  if (!Object.keys(overrides).length) delete state.chats[chatId];
}
