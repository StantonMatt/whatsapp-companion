import type { Sticker } from '../shared/model';
const normalize = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
export function searchStickers(stickers: Sticker[], query: string) {
  const terms = query.match(/"[^"]+"|\S+/g)?.map(x => normalize(x.replace(/^"|"$/g, ''))) ?? [];
  return stickers.filter(s => terms.every(term => normalize(s.searchTerms).includes(term))).sort((a, b) => b.lastSeen - a.lastSeen);
}
export function upsertSticker(stickers: Sticker[], sticker: Sticker) {
  const existing = stickers.find(x => x.id === sticker.id);
  if (existing) { existing.image = sticker.image; existing.lastSeen = sticker.lastSeen; }
  else if (stickers.length < 2000 && stickers.reduce((total, s) => total + s.image.length, sticker.image.length) <= 50_000_000) stickers.push(sticker);
}
