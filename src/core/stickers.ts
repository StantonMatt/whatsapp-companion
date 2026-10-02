import type { State, Sticker } from '../shared/model';
const normalize = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
export function searchStickers(stickers: Sticker[], query: string) {
  const terms = query.match(/"[^"]+"|\S+/g)?.map(x => normalize(x.replace(/^"|"$/g, ''))) ?? [];
  return stickers.filter(s => terms.every(term => normalize(s.searchTerms).includes(term))).sort((a, b) => b.lastSeen - a.lastSeen);
}
export function upsertSticker(stickers: Sticker[], sticker: Sticker) {
  const existing = stickers.find(x => x.id === sticker.id);
  if (existing) { existing.image = sticker.image; existing.lastSeen = sticker.lastSeen; if (sticker.fingerprint) existing.fingerprint = sticker.fingerprint; }
  else if (stickers.length < 2000 && stickers.reduce((total, s) => total + s.image.length, sticker.image.length) <= 50_000_000) stickers.push(sticker);
}
export function forgetSticker(state: State, id: string) {
  state.stickers = state.stickers.filter(s => s.id !== id);
  state.forgottenStickers = [...state.forgottenStickers.filter(hash => hash !== id), id].slice(-5000);
}
