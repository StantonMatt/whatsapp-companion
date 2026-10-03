import type { State, Sticker } from '../shared/model';
import { MAX_LIBRARY_BYTES, MAX_LIBRARY_STICKERS } from '../shared/sticker-limits';
const normalize = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
export function searchStickers(stickers: Sticker[], query: string, groupId: string | null = null) {
  const terms = query.match(/"[^"]+"|\S+/g)?.map(x => normalize(x.replace(/^"|"$/g, ''))) ?? [];
  return stickers.filter(s => (!groupId || s.groups.includes(groupId)) && terms.every(term => normalize(s.searchTerms).includes(term))).sort((a, b) => b.lastSeen - a.lastSeen);
}
export function upsertSticker(stickers: Sticker[], sticker: Sticker) {
  const existing = stickers.find(x => x.id === sticker.id);
  if (existing) { existing.lastSeen = sticker.lastSeen; if (sticker.fingerprint) existing.fingerprint = sticker.fingerprint; }
  else if (stickers.length < MAX_LIBRARY_STICKERS && stickers.reduce((total, s) => total + s.size, sticker.size) <= MAX_LIBRARY_BYTES) stickers.push(sticker);
  else return false;
  return true;
}
export function forgetSticker(state: State, id: string) {
  state.stickers = state.stickers.filter(s => s.id !== id);
  state.forgottenStickers = [...state.forgottenStickers.filter(hash => hash !== id), id].slice(-5000);
}
