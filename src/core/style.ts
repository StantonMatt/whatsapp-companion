import type { State, Preferences, StyleProfile } from '../shared/model';

// Deliberately extract only aggregate form. Names, phrases, and raw examples are never persisted.
export function learnStyle(examples: string[], source: 'observed' | 'selected', now = Date.now()): StyleProfile | null {
  const samples = examples.map(x => x.trim()).filter(x => x.length >= 3).slice(-100);
  if (samples.length < 5) return null;
  const average = Math.round(samples.reduce((n, x) => n + x.split(/\s+/u).length, 0) / samples.length);
  const rate = (re: RegExp) => Math.round(samples.filter(x => re.test(x)).length / samples.length * 100);
  return { description: `Usually writes about ${average} words per message. ${rate(/[.!?]$/u)}% of messages end with punctuation. ${rate(/\p{Extended_Pictographic}/u)}% include emoji. ${rate(/\n/u)}% use multiple lines. ${rate(/^[a-záéíóúñ]/u)}% start in lowercase. Match vocabulary and language to this conversation; do not invent personal details.`, samples: samples.length, updatedAt: now, source };
}
export function styleFor(state: State, prefs: Preferences, chatId: string | null): { profile?: StyleProfile; fallback: boolean } {
  if (prefs.style === 'off') return { fallback: false };
  if (prefs.style === 'conversation' && chatId && state.profiles[chatId]?.samples >= 5) return { profile: state.profiles[chatId], fallback: false };
  return { profile: state.profiles.general, fallback: prefs.style === 'conversation' };
}
