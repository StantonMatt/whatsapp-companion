import { defaults, type State, type Scope, type Preferences, type ChatKind } from '../shared/model';

export function resolveSettings(state: State, _kind: ChatKind, chatId?: string | null) {
  // Legacy kind defaults remain on disk but all chats now inherit directly from global.
  const values = { ...state.global, ...(chatId ? state.chats[chatId] : {}) };
  const sources = Object.fromEntries(Object.keys(defaults).map(key => [key,
    chatId && Object.hasOwn(state.chats[chatId] ?? {}, key) ? 'conversation' : 'global'
  ])) as Record<keyof Preferences, string>;
  return { values, sources };
}
export function setPreferences(state: State, scope: Scope, patch: Partial<Preferences>) {
  if (scope === 'global') Object.assign(state[scope], patch);
  else state.chats[scope] = { ...state.chats[scope], ...patch };
}
export function resetPreferences(state: State, scope: Scope) {
  if (scope === 'global') state.global = { ...defaults };
  else delete state.chats[scope];
}
