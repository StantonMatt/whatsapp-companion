import { describe, test, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialState, emptySnapshot, defaultAuto, actionSchema, stickerSchema, type Snapshot } from '../src/shared/model';
import { resolveSettings, setPreferences, resetPreferences } from '../src/core/settings';
import { learnStyle, styleFor } from '../src/core/style';
import { SuggestionGate } from '../src/core/suggestions';
import { autoDecision, autoSendExpiry } from '../src/core/auto-reply';
import { searchStickers, upsertSticker } from '../src/core/stickers';
import { Store } from '../src/main/store';
import { generate, buildPrompt } from '../src/main/providers';
import { Assistant } from '../src/main/assistant';
import { ProviderCheck } from '../src/main/provider-check';
import { setReasoning } from '../src/core/model-policy';
import type { Vault } from '../src/main/vault';
import type { RemoteCommand } from '../src/shared/connector';
import { StatusCache, statusUpdate } from '../src/core/status';

test('larger animated sticker images survive schema validation and tagged persistence', () => {
  const image = `data:image/webp;base64,${Buffer.alloc(966752).toString('base64')}`;
  const sticker = { id: 'b'.repeat(64), image, searchTerms: 'cat, surprised, gato, sorpresa', firstSeen: 1, lastSeen: 1 };
  expect(stickerSchema.safeParse(sticker).success).toBe(true);
  expect(stickerSchema.safeParse({ ...sticker, image: `data:image/webp;base64,${Buffer.alloc(1048580).toString('base64')}` }).success).toBe(false);
  const dir = mkdtempSync(join(tmpdir(), 'companion-large-sticker-'));
  try {
    const store = new Store(dir); store.update(state => upsertSticker(state.stickers, sticker));
    const restored = new Store(dir).state.stickers;
    expect(restored).toEqual([sticker]); expect(searchStickers(restored, 'gato sorpresa')).toEqual([sticker]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
import { StickerInbox } from '../src/main/sticker-inbox';
import type { Status, StatusUpdate } from '../src/shared/model';

const chat = '123@c.us', group = '456@g.us';
const snap = (patch: Partial<Snapshot> = {}): Snapshot => ({ ...emptySnapshot, chatId: chat, name: 'Alex', ready: true, atBottom: true, caretAtEnd: true, messages: [{ id: 'a', text: 'Hello', outgoing: false }], ...patch });
const dirs: string[] = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'companion-test-')); dirs.push(dir); return dir; };
afterEach(() => { vi.useRealTimers(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });

describe('settings inheritance and authorization', () => {
  test('resolves global → conversation per field and exposes sources', () => {
    const state = initialState();
    setPreferences(state, 'global', { tone: 'professional', language: 'Spanish' });
    state.direct.tone = 'friendly'; setPreferences(state, chat, { length: 'detailed' });
    expect(resolveSettings(state, 'direct', chat)).toMatchObject({ values: { tone: 'professional', language: 'Spanish', length: 'detailed' }, sources: { tone: 'global', language: 'global', length: 'conversation' } });
    expect(resolveSettings(state, 'group', group).values.tone).toBe('professional');
    resetPreferences(state, chat); expect(resolveSettings(state, 'direct', chat).values.length).toBe('brief');
    expect(resolveSettings(state, 'direct', chat).values.tone).toBe('professional');
  });
  test('defaults forbid context sharing, learning and automatic replies', () => {
    const state = initialState(); expect(state.global).toMatchObject({ suggestions: false, shareContext: false, style: 'off', learnFromSent: false });
    expect(state.auto).toEqual({}); expect(defaultAuto.enabled).toBe(false);
  });
  test('unidentified chats use global settings without guessing a direct/group scope', () => {
    const state = initialState(); state.direct.tone = 'professional'; state.group.tone = 'friendly'; state.chats[chat] = { instructions: 'Private instruction' };
    expect(resolveSettings(state, 'unknown', null)).toMatchObject({ values: state.global, sources: { tone: 'global', instructions: 'global' } });
  });
  test('rejects permissions hidden in preference payloads and dangerous scopes', () => {
    expect(actionSchema.safeParse({ type: 'preferences', scope: chat, patch: { enabled: true } }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'preferences', scope: '__proto__', patch: {} }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'autoRules', chatId: chat, patch: { delaySeconds: 0 } }).success).toBe(false);
  });
});
describe('style isolation', () => {
  test('extracts only aggregate traits; discards raw facts and examples', () => {
    const profile = learnStyle(['Secret client Acme', 'My PIN is 1234', 'Meeting with Paula', 'A confidential sale', 'The secret is orange'], 'selected')!;
    expect(profile.samples).toBe(5); expect(profile.description).not.toMatch(/Acme|1234|Paula|orange|confidential/);
    expect(learnStyle(['one', 'two'], 'selected')).toBeNull();
  });
  test('sparse conversations fall back only to explicitly approved general traits', () => {
    const state = initialState(); state.profiles[chat] = { description: 'PRIVATE CHAT', samples: 9, source: 'edited', updatedAt: 1 };
    state.profiles.general = { description: 'General punctuation', samples: 5, source: 'edited', updatedAt: 1 };
    expect(styleFor(state, { ...state.global, style: 'conversation' }, group)).toMatchObject({ profile: { description: 'General punctuation' }, fallback: true });
    expect(styleFor(state, { ...state.global, style: 'conversation' }, chat).profile?.description).toBe('PRIVATE CHAT');
    expect(styleFor(state, state.global, chat).profile).toBeUndefined();
  });
  test('prompts include only current chat and selected profile, and respect context opt out', () => {
    const state = initialState(); state.profiles[group] = { description: 'Secret group style', samples: 5, source: 'edited', updatedAt: 1 };
    const p = buildPrompt(state, { ...state.global, style: 'conversation' }, snap({ draft: 'Hello' }));
    expect(p.system).not.toContain('Secret group'); expect(JSON.parse(p.input).context).toEqual([]);
    expect(buildPrompt(state, { ...state.global, shareContext: true }, snap()).input).toContain('contact');
  });
});
describe('stale suggestions', () => {
  test('changing reasoning cancels old work and passes the saved effort to the next suggestion', async () => {
    const store = new Store(directory()); store.update(s => { s.global.shareContext = true; });
    let finish!: (text: string) => void;
    const generator = vi.fn<typeof generate>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue('Current effort reply');
    const commands: RemoteCommand[] = [];
    const assistant = new Assistant(store, { get: () => 'synthetic' } as unknown as Vault, { send: c => commands.push(c), focus() {} }, () => {}, false, generator);
    assistant.receive(snap()); const pending = assistant.request();
    expect(generator.mock.calls[0][0].effort).toBe('none');
    store.update(s => setReasoning(s, 'openai', 'gpt-6-luna', 'high')); assistant.reconfigure();
    expect(generator.mock.calls[0][0].signal?.aborted).toBe(true);
    finish('Old effort reply'); await pending;
    expect(commands.some(command => command.type === 'suggestion')).toBe(false);
    await assistant.request(); expect(generator.mock.calls[1][0].effort).toBe('high');
    expect(commands.some(command => command.type === 'suggestion' && command.text === 'Current effort reply')).toBe(true);
    expect(commands.some(command => command.type === 'autoSend')).toBe(false); assistant.cancel();
  });
  test('image-only context starts a suggestion promptly, marks unseen contents and cannot trigger automatic sending', async () => {
    vi.useFakeTimers(); const store = new Store(directory()); store.update(s => { s.global.suggestions = true; s.global.shareContext = true; s.auto[chat] = { ...defaultAuto, enabled: true, startHour: 0, endHour: 0 }; });
    const generator = vi.fn(async () => 'Thanks for sending that.'), commands: RemoteCommand[] = [];
    const assistant = new Assistant(store, { get: () => 'synthetic' } as unknown as Vault, { send: c => commands.push(c), focus() {} }, () => {}, false, generator);
    const image = snap({ focused: false, caretAtEnd: false, messages: [{ id: 'photo', text: '', outgoing: false, attachment: 'image' }] });
    assistant.receive(image); await vi.advanceTimersByTimeAsync(0);
    expect(generator).toHaveBeenCalledOnce(); expect(commands.some(c => c.type === 'suggestion')).toBe(true);
    expect(autoDecision(store.state.auto[chat], image, [], new Date())).toBe('No new incoming text');
    expect(commands.some(c => c.type === 'autoSend')).toBe(false);
    const prompt = buildPrompt(store.state, store.state.global, image);
    expect(JSON.parse(prompt.input).context).toEqual([{ speaker: 'contact', text: '', attachment: { type: 'image', contents: 'unavailable' } }]);
    expect(prompt.system).toContain('without describing, judging, or inventing');
    expect(JSON.parse(buildPrompt(store.state, { ...store.state.global, shareContext: false }, image).input).context).toEqual([]);
    assistant.cancel();
  });
  test.each([true, false, null])('empty composer suggests regardless of the last author (%s), without granting sending permission', async outgoing => {
    vi.useFakeTimers(); const store = new Store(directory()); store.update(s => { s.global.suggestions = true; s.global.shareContext = true; });
    const commands: RemoteCommand[] = [], assistant = new Assistant(store, {} as Vault, { send: c => commands.push(c), focus() {} }, () => {}, true);
    assistant.receive(snap({ focused: true, messages: [{ id: 'last', text: 'I will let you know.', outgoing }] }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(commands.some(c => c.type === 'suggestion')).toBe(true);
    expect(commands.some(c => c.type === 'autoSend')).toBe(false); expect(assistant.pending).toBeNull();
    const prompt = buildPrompt(store.state, store.state.global, assistant.snapshot);
    expect(prompt.system).toContain('from the account owner'); expect(prompt.system).toContain('do not answer the owner as if you were the contact');
    assistant.cancel();
  });
  test('unidentified live chats can suggest with global context but cannot learn or arm per-chat sending', async () => {
    const store = new Store(directory()); store.update(s => { s.global.shareContext = true; s.global.style = 'conversation'; s.global.learnFromSent = true; s.profiles[chat] = { description: 'PRIVATE PROFILE', samples: 5, updatedAt: 1, source: 'edited' }; });
    const generator = vi.fn(async () => 'A suggestion'), commands: RemoteCommand[] = [];
    const assistant = new Assistant(store, { get: () => 'synthetic' } as unknown as Vault, { send: c => commands.push(c), focus() {} }, () => {}, false, generator);
    assistant.receive(snap({ chatId: null, kind: 'unknown', messages: [{ id: 'ABC123456', text: 'Synthetic question', outgoing: null }] }));
    await assistant.request(); expect(commands.some(c => c.type === 'suggestion')).toBe(true);
    expect(JSON.stringify(generator.mock.calls)).not.toContain('PRIVATE PROFILE');
    expect(JSON.stringify(generator.mock.calls)).toContain('unknown');
    expect(Object.keys(store.state.profiles)).toEqual([chat]);
    expect(() => assistant.changeAutoPermission(chat, 'enable')).toThrow('Open'); assistant.cancel();
  });
  test.each(['chat', 'draft', 'incoming', 'attachment', 'composition', 'editing', 'replacement'])('rejects a result after %s changes', change => {
    const gate = new SuggestionGate(), original = snap(); const ticket = gate.begin(original);
    const next = snap(change === 'chat' ? { chatId: group } : change === 'draft' ? { draft: 'Hi' } : change === 'incoming' ? { messages: [...original.messages, { id: 'b', text: 'New', outgoing: false }] } : change === 'attachment' ? { messages: original.messages.map(m => ({ ...m, attachment: 'image' })) } : change === 'composition' ? { composing: true } : change === 'editing' ? { editRevision: 1 } : { revision: '2' });
    expect(gate.current(ticket, next)).toBe(false);
    gate.cancel(); expect(ticket.signal.aborted).toBe(true);
  });
  test('new requests invalidate old responses even when the draft is identical', () => {
    const gate = new SuggestionGate(), s = snap(), a = gate.begin(s), b = gate.begin(s);
    expect(gate.current(a, s)).toBe(false); expect(gate.current(b, s)).toBe(true);
  });
  test.each([{ activity: 1 }, { focused: true }, { caretAtEnd: false }, { atBottom: false }])('navigation preserves inline suggestions but invalidates send authority: %j', patch => {
    const inline = new SuggestionGate(), sending = new SuggestionGate(), original = snap();
    expect(inline.current(inline.begin(original), snap(patch))).toBe(true);
    expect(sending.current(sending.begin(original, true), snap(patch))).toBe(false);
  });
  test.each([['Thank', 's!'], ['Thanks', ' again!']])('preserves a provider suffix after %s', async (draft, suffix) => {
    const store = new Store(directory()), commands: RemoteCommand[] = [];
    const assistant = new Assistant(store, { get: () => 'synthetic' } as unknown as Vault, { send: c => commands.push(c), focus() {} }, () => {}, false, async () => suffix);
    assistant.receive(snap({ draft, focused: true })); await assistant.request();
    expect(commands.find(c => c.type === 'suggestion')).toMatchObject({ text: suffix }); assistant.cancel();
  });
  test('dismissal survives an activity snapshot without re-requesting the same context', async () => {
    vi.useFakeTimers(); const store = new Store(directory()); store.update(s => { s.global.suggestions = true; });
    const commands: RemoteCommand[] = [], assistant = new Assistant(store, {} as Vault, { send: c => commands.push(c), focus() {} }, () => {}, true);
    assistant.receive(snap({ draft: 'Hello', focused: true })); await vi.advanceTimersByTimeAsync(1500);
    const count = commands.filter(c => c.type === 'suggestion').length;
    assistant.dismiss(); assistant.receive(snap({ draft: 'Hello', focused: true, activity: 1 })); await vi.advanceTimersByTimeAsync(3000);
    expect(commands.filter(c => c.type === 'suggestion')).toHaveLength(count); assistant.cancel();
  });
  test('focus and clicks preserve both an in-flight request and its result without more provider calls', async () => {
    vi.useFakeTimers(); const store = new Store(directory()); store.update(s => { s.global.suggestions = true; s.global.shareContext = true; });
    let finish!: (text: string) => void;
    const generator = vi.fn((_request: Parameters<typeof generate>[0]) => new Promise<string>(resolve => { finish = resolve; })), commands: RemoteCommand[] = [];
    const assistant = new Assistant(store, { get: () => 'synthetic' } as unknown as Vault, { send: c => commands.push(c), focus() {} }, () => {}, false, generator);
    assistant.receive(snap({ focused: false, caretAtEnd: false })); await vi.advanceTimersByTimeAsync(0);
    expect(generator).toHaveBeenCalledOnce(); const before = commands.length;
    assistant.activity(); assistant.receive(snap({ focused: true, activity: 1 }));
    assistant.receive(snap({ focused: false, caretAtEnd: false, activity: 1 }));
    expect(commands).toHaveLength(before); expect(generator.mock.calls[0][0]?.signal?.aborted).not.toBe(true);
    finish('Prepared while reading'); await vi.advanceTimersByTimeAsync(1);
    const visible = commands.length; expect(commands.at(-1)).toMatchObject({ type: 'suggestion', text: 'Prepared while reading' });
    assistant.activity(); assistant.receive(snap({ focused: true, activity: 2 })); await vi.advanceTimersByTimeAsync(3000);
    expect(commands).toHaveLength(visible); expect(generator).toHaveBeenCalledOnce(); assistant.cancel();
  });
  test('typing invalidates in-flight text even before the new draft snapshot arrives', async () => {
    const store = new Store(directory()); store.update(s => { s.global.shareContext = true; });
    let finish!: (text: string) => void;
    const generator = vi.fn((_request: Parameters<typeof generate>[0]) => new Promise<string>(resolve => { finish = resolve; })), commands: RemoteCommand[] = [];
    const assistant = new Assistant(store, { get: () => 'synthetic' } as unknown as Vault, { send: c => commands.push(c), focus() {} }, () => {}, false, generator);
    assistant.receive(snap()); const pending = assistant.request(); assistant.activity(true);
    finish('Stale text'); await pending;
    expect(commands.some(c => c.type === 'suggestion')).toBe(false); assistant.cancel();
  });
  test('mid-draft edits do not call the provider; returning to the end enables suggestions', async () => {
    vi.useFakeTimers(); const store = new Store(directory()); store.update(s => { s.global.suggestions = true; });
    const generator = vi.fn(async () => ' suffix'), commands: RemoteCommand[] = [];
    const assistant = new Assistant(store, { get: () => 'synthetic' } as unknown as Vault, { send: c => commands.push(c), focus() {} }, () => {}, false, generator);
    assistant.receive(snap({ draft: 'Editing in the middle', focused: true, caretAtEnd: false }));
    await vi.advanceTimersByTimeAsync(2000); await assistant.request(); expect(generator).not.toHaveBeenCalled();
    expect(assistant.message).not.toContain('Tab to accept');
    assistant.receive(snap({ draft: 'Editing in the middle', focused: true, caretAtEnd: true }));
    await vi.advanceTimersByTimeAsync(1500); expect(generator).toHaveBeenCalledTimes(1);
    expect(commands.some(c => c.type === 'suggestion')).toBe(true); assistant.cancel();
  });
  test('mention-bearing drafts never reach a provider for refinement', async () => {
    const generator = vi.fn(async () => '@Alice'), store = new Store(directory());
    const assistant = new Assistant(store, {} as Vault, { send() {}, focus() {} }, () => {}, false, generator);
    assistant.receive(snap({ draft: '@Alice', draftIssue: 'unsupported' })); await assistant.request('Shorter');
    expect(generator).not.toHaveBeenCalled(); expect(assistant.message).toContain('cannot be preserved'); assistant.cancel();
  });
  test('manual empty-composer requests explain the context opt-in beside the composer', async () => {
    const generator = vi.fn(async () => 'unused'), commands: RemoteCommand[] = [], store = new Store(directory());
    const assistant = new Assistant(store, {} as Vault, { send: c => commands.push(c), focus() {} }, () => {}, false, generator);
    assistant.receive(snap()); await assistant.request();
    expect(generator).not.toHaveBeenCalled();
    expect(commands).toContainEqual({ type: 'notice', text: expect.stringContaining('AI settings → Replies') }); assistant.cancel();
  });
  test('oversized drafts are explained and never passed to a provider for refinement', async () => {
    const generator = vi.fn(async () => 'replacement'), store = new Store(directory());
    const assistant = new Assistant(store, {} as Vault, { send() {}, focus() {} }, () => {}, false, generator);
    assistant.receive(snap({ draft: 'x'.repeat(8000), draftIssue: 'too-long' })); await assistant.request('Shorter');
    expect(generator).not.toHaveBeenCalled(); expect(assistant.message).toContain('8,000'); assistant.cancel();
  });
});
describe('incremental desktop status', () => {
  const full = (sequence: number): Status => ({ sequence, runtimePaused: false, state: initialState(), chat: { chatId: null, name: '', kind: 'direct', ready: false }, keys: { openai: false, anthropic: false }, secureStorage: false, fixture: true, message: 'Ready', pending: null });
  const update = (sequence: number): StatusUpdate => { const { state: _state, ...transient } = full(sequence); return { ...transient, message: 'Thinking' }; };
  test('preserves the existing library without copying it for transient updates', () => {
    const cache = new StatusCache(), initial = full(1); cache.accept(initial);
    expect(cache.accept(update(2))?.state).toBe(initial.state);
    expect(cache.accept(full(0))?.sequence).toBe(2);
  });
  test('reconciles a transient event arriving before the initial full read', () => {
    const cache = new StatusCache(); expect(cache.accept(update(2))).toBeUndefined();
    expect(cache.accept(full(1))).toMatchObject({ sequence: 2, message: 'Thinking', state: initialState() });
    expect(cache.accept(full(3))?.sequence).toBe(3);
  });
  test('sticker changes send only new entries and survive updates before the initial read', () => {
    const a = full(1), b = full(2), c = full(3), cache = new StatusCache();
    const sticker = { id: 'a'.repeat(64), image: 'data:image/webp;base64,UklGRg==', searchTerms: '', firstSeen: 1, lastSeen: 1 };
    a.state.stickers = [sticker]; b.state.stickers = [sticker, { ...sticker, id: 'b'.repeat(64) }]; c.state = { ...b.state, global: { ...b.state.global, tone: 'friendly' } };
    const delta = statusUpdate(b, a.state); expect(delta.stickerChanges?.upsert).toHaveLength(1); expect(delta.state).not.toHaveProperty('stickers');
    cache.accept(delta); cache.accept(statusUpdate(c, b.state)); const result = cache.accept(a);
    expect(result?.state.stickers).toHaveLength(2); expect(result?.state.global.tone).toBe('friendly');
    const d = { ...c, sequence: 4, state: { ...c.state, stickers: [] } }; cache.accept(statusUpdate(d, c.state)); expect(cache.accept(a)?.state.stickers).toHaveLength(0);
  });
});
describe('sticker persistence and search', () => {
  const sticker = { id: 'a'.repeat(64), image: 'data:image/webp;base64,UklGRg==', searchTerms: 'Buenos días, happy, good morning sunshine', firstSeen: 1, lastSeen: 1 };
  test('legacy tags and captions migrate losslessly, remain editable and survive restart', () => {
    const dir = directory();
    const { searchTerms: _terms, ...base } = sticker;
    const legacy = { ...base, tags: ['happy', 'feliz'], keywords: 'good morning sunshine, buenos días' };
    writeFileSync(join(dir, 'companion.json'), JSON.stringify({ ...initialState(), stickers: [legacy] }));
    const store = new Store(dir);
    expect(store.state.stickers[0]).toEqual({ ...base, searchTerms: 'happy, feliz, good morning sunshine, buenos días' });
    for (const query of ['happy', 'feliz', '"good morning"', '"buenos dias"']) expect(searchStickers(store.state.stickers, query)).toHaveLength(1);
    store.update(s => { s.stickers[0].searchTerms += ', smile, sonrisa'; });
    const next = new Store(dir);
    expect(next.state.stickers).toEqual(store.state.stickers);
    expect(next.state.stickers[0]).not.toHaveProperty('tags');
    expect(searchStickers(next.state.stickers, 'sonrisa')).toHaveLength(1);
    expect(stickerSchema.safeParse({ ...legacy, keywords: 'x'.repeat(1001) }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'sticker', id: base.id, searchTerms: 'x'.repeat(4001) }).success).toBe(false);
  });
  test('persists metadata across restart and reobservation, searches phrases and accents', () => {
    const dir = directory(), store = new Store(dir); store.update(s => upsertSticker(s.stickers, sticker));
    const next = new Store(dir); next.update(s => upsertSticker(s.stickers, { ...sticker, searchTerms: '', lastSeen: 20 }));
    expect(next.state.stickers).toHaveLength(1); expect(searchStickers(next.state.stickers, 'buenos dias')).toHaveLength(1);
    expect(searchStickers(next.state.stickers, 'happy "good morning"')).toHaveLength(1);
    expect(searchStickers(next.state.stickers, 'unindexed')).toHaveLength(0);
    expect(statSync(join(dir, 'companion.json')).mode & 0o777).toBe(0o600);
  });
  test('invalid state is preserved and a failed update cannot change memory', () => {
    const dir = directory(), store = new Store(dir);
    expect(() => store.update(s => { s.global.tone = 'invalid' as never; })).toThrow(); expect(store.state.global.tone).toBe('natural');
    writeFileSync(join(dir, 'companion.json'), 'not json'); expect(() => new Store(dir)).toThrow();
    expect(readFileSync(join(dir, 'companion.json'), 'utf8')).toBe('not json');
  });
  test('many discoveries share one transaction and one publication', async () => {
    vi.useFakeTimers(); const store = new Store(directory()), write = vi.spyOn(store, 'update'), changed = vi.fn();
    const inbox = new StickerInbox(store, changed, () => { throw new Error('Unexpected failure'); });
    for (let i = 0; i < 150; i++) inbox.add({ ...sticker, id: i.toString(16).padStart(64, '0') });
    expect(write).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(501);
    expect(write).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledTimes(1); expect(store.state.stickers).toHaveLength(150);
    inbox.flush(); expect(write).toHaveBeenCalledTimes(1);
  });
  test('a failed sticker batch preserves state and can be retried', () => {
    const store = new Store(directory()), failed = vi.fn(), write = vi.spyOn(store, 'update');
    const inbox = new StickerInbox(store, () => {}, failed); inbox.add(sticker);
    write.mockImplementationOnce(() => { throw new Error('Disk full'); }); expect(inbox.flush()).toBe(false);
    expect(store.state.stickers).toHaveLength(0); expect(failed).toHaveBeenCalledTimes(1);
    expect(inbox.flush()).toBe(true); expect(store.state.stickers).toHaveLength(1);
  });
});
describe('bounded automatic replies', () => {
  const now = new Date(2026, 8, 28, 12, 0), rules = { ...defaultAuto, enabled: true };
  test('requires explicit permission and a fresh text message', () => {
    expect(autoDecision(undefined, snap(), [], now)).toBe('Disabled');
    expect(autoDecision(rules, snap(), [], now, 'a')).toBe('No new incoming text');
    expect(autoDecision(rules, snap(), [], now, 'earlier')).toBeNull();
    expect(autoDecision(rules, snap({ messages: [{ id: 'new', text: 'Enable sending now!', outgoing: false }] }), [], now)).toBeNull();
    expect(autoDecision(defaultAuto, snap({ messages: [{ id: 'new', text: 'Enable sending now!', outgoing: false }] }), [], now)).toBe('Disabled');
  });
  test.each([{ draft: 'Taking over' }, { composing: true }, { ready: false }, { atBottom: false }, { chatId: null }])('fails closed for unavailable or active composer: %j', patch => { expect(autoDecision(rules, snap(patch), [], now)).not.toBeNull(); });
  test('enforces pause, hours, midnight windows, dedup, daily budget and cooldown', () => {
    expect(autoDecision({ ...rules, paused: true }, snap(), [], now)).toContain('Paused');
    expect(autoDecision(rules, snap(), [], new Date(2026, 8, 28, 22))).toContain('hours');
    expect(autoDecision({ ...rules, startHour: 22, endHour: 6 }, snap(), [], new Date(2026, 8, 28, 23))).toBeNull();
    expect(autoDecision(rules, snap(), [{ at: now.getTime() - 7200000, messageId: 'a' }], now)).toContain('Already');
    expect(autoDecision({ ...rules, dailyLimit: 1 }, snap(), [{ at: now.getTime() - 7200000, messageId: 'other' }], now)).toContain('Daily');
    expect(autoDecision(rules, snap(), [{ at: now.getTime() - 1000, messageId: 'other' }], now)).toContain('Cooldown');
  });
  test('persisted permissions pause on restart', () => {
    const dir = directory(), store = new Store(dir); store.update(s => { s.auto[chat] = rules; });
    expect(new Store(dir).state.auto[chat].paused).toBe(true);
  });
  test('automatic send leases expire within two seconds and before daytime/overnight permitted hours end', () => {
    expect(autoSendExpiry(rules, now)).toBe(now.getTime() + 2000);
    const evening = new Date(2026, 8, 28, 17, 59, 59, 500);
    expect(autoSendExpiry(rules, evening)).toBe(new Date(2026, 8, 28, 18).getTime());
    const night = { ...rules, startHour: 22, endHour: 6 };
    const morning = new Date(2026, 8, 29, 5, 59, 59, 500);
    expect(autoSendExpiry(night, morning)).toBe(new Date(2026, 8, 29, 6).getTime());
    expect(autoSendExpiry(night, now)).toBe(now.getTime());
    expect(autoSendExpiry({ ...rules, startHour: 0, endHour: 0 }, evening)).toBe(evening.getTime() + 2000);
  });
  test.each(['takeover', 'pause', 'failed-pause'])('rule edits preserve %s until explicit resume', async reason => {
    vi.useFakeTimers();
    const store = new Store(directory()); store.update(s => { s.global.shareContext = true; });
    const assistant = new Assistant(store, {} as Vault, { send() {}, focus() {} }, () => {}, true);
    assistant.receive(snap()); assistant.changeAutoPermission(chat, 'enable');
    if (reason === 'failed-pause') vi.spyOn(store, 'update').mockImplementationOnce(() => { throw new Error('disk full'); });
    if (reason === 'pause') assistant.changeAutoPermission(chat, 'pause'); else assistant.activity();
    // These patches could have been created before the pause arrived at the UI.
    assistant.updateAutoRules(chat, { dailyLimit: 3 });
    assistant.updateAutoRules(chat, { startHour: 0, endHour: 0 });
    assistant.changeAutoPermission(chat, 'enable'); // Repeated enable cannot act as resume.
    expect(store.state.auto[chat]).toMatchObject({ enabled: true, paused: true, dailyLimit: 3 });
    expect(assistant.isRuntimePaused()).toBe(true);
    assistant.receive(snap({ messages: [{ id: 'b', text: 'New while paused', outgoing: false }] }));
    await vi.advanceTimersByTimeAsync(2000); expect(assistant.pending).toBeNull();
    assistant.changeAutoPermission(chat, 'resume');
    expect(store.state.auto[chat].paused).toBe(false); expect(assistant.isRuntimePaused()).toBe(false);
    assistant.receive(snap({ messages: [{ id: 'c', text: 'After resume', outgoing: false }] }));
    await vi.advanceTimersByTimeAsync(2000); expect(assistant.pending).not.toBeNull(); assistant.cancel();
  });
  test('rule patches cannot carry send permissions, and edits cannot enable a disabled chat', () => {
    expect(actionSchema.safeParse({ type: 'autoRules', chatId: chat, patch: { enabled: true } }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'autoRules', chatId: chat, patch: { paused: false } }).success).toBe(false);
    const store = new Store(directory()), assistant = new Assistant(store, {} as Vault, { send() {}, focus() {} }, () => {}, true);
    assistant.receive(snap()); assistant.updateAutoRules(chat, { dailyLimit: 3 });
    expect(store.state.auto[chat].enabled).toBe(false);
    expect(() => assistant.changeAutoPermission(chat, 'resume')).toThrow('Enable');
    expect(() => assistant.changeAutoPermission(group, 'enable')).toThrow('Open');
    assistant.changeAutoPermission(chat, 'enable'); assistant.changeAutoPermission(chat, 'disable');
    assistant.updateAutoRules(chat, { delaySeconds: 15 }); expect(store.state.auto[chat].enabled).toBe(false);
    assistant.cancel();
  });
  test('a failed explicit resume never clears the runtime safety pause', () => {
    const store = new Store(directory()), assistant = new Assistant(store, {} as Vault, { send() {}, focus() {} }, () => {}, true);
    assistant.receive(snap()); assistant.changeAutoPermission(chat, 'enable'); assistant.activity();
    vi.spyOn(store, 'update').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => assistant.changeAutoPermission(chat, 'resume')).toThrow('disk full');
    expect(assistant.isRuntimePaused()).toBe(true); expect(store.state.auto[chat].paused).toBe(true); assistant.cancel();
  });
  test('orchestrator never replies to initial history, reserves budget before dispatch, and pauses on takeover', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const store = new Store(directory()); store.update(s => { s.auto[chat] = { ...rules, delaySeconds: 15 }; s.global.shareContext = true; });
    const commands: RemoteCommand[] = [];
    const assistant = new Assistant(store, {} as Vault, { send: c => commands.push(c), focus() {} }, () => {}, true);
    assistant.receive(snap()); await vi.advanceTimersByTimeAsync(20000);
    expect(commands.some(c => c.type === 'autoSend')).toBe(false);
    assistant.receive(snap({ messages: [{ id: 'b', text: 'A new message', outgoing: false }] }));
    await vi.advanceTimersByTimeAsync(1500); expect(assistant.pending).not.toBeNull();
    await vi.advanceTimersByTimeAsync(16000);
    expect(store.state.ledger[chat]).toHaveLength(1); expect(commands.filter(c => c.type === 'autoSend')).toHaveLength(1);
    const dispatched = commands.find(c => c.type === 'autoSend')!;
    expect(dispatched.expiresAt).toBe(store.state.ledger[chat][0].at + 2000);
    expect(assistant.authorizeAutomatic('unrelated-attempt')).toBe(false);
    expect(assistant.authorizeAutomatic(dispatched.nonce)).toBe(true);
    expect(assistant.authorizeAutomatic(dispatched.nonce)).toBe(false);
    assistant.activity(); expect(store.state.auto[chat].paused).toBe(true); expect(assistant.pending).toBeNull(); assistant.cancel();
  });
  test.each(['pause', 'takeover', 'expired', 'removed-reservation'])('queued sends must revalidate in main after %s', async reason => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const store = new Store(directory()); store.update(s => { s.auto[chat] = { ...rules, delaySeconds: 15 }; s.global.shareContext = true; });
    const commands: RemoteCommand[] = [], assistant = new Assistant(store, {} as Vault, { send: c => commands.push(c), focus() {} }, () => {}, true);
    assistant.receive(snap()); assistant.receive(snap({ messages: [{ id: 'b', text: 'New arrival', outgoing: false }] }));
    await vi.advanceTimersByTimeAsync(16200);
    const command = commands.find(c => c.type === 'autoSend')!; expect(command).toBeDefined();
    if (reason === 'pause') assistant.changeAutoPermission(chat, 'pause');
    if (reason === 'takeover') assistant.activity();
    if (reason === 'expired') await vi.advanceTimersByTimeAsync(2000);
    if (reason === 'removed-reservation') store.update(s => { s.ledger[chat] = []; });
    expect(assistant.authorizeAutomatic(command.nonce)).toBe(false);
    assistant.cancel();
  });
  test('takeover during countdown prevents dispatch', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const store = new Store(directory()); store.update(s => { s.auto[chat] = rules; s.global.shareContext = true; });
    const commands: RemoteCommand[] = [], assistant = new Assistant(store, {} as Vault, { send: c => commands.push(c), focus() {} }, () => {}, true);
    assistant.receive(snap()); assistant.receive(snap({ messages: [{ id: 'b', text: 'new', outgoing: false }] }));
    await vi.advanceTimersByTimeAsync(1500); assistant.activity(); await vi.advanceTimersByTimeAsync(60000);
    expect(commands.some(c => c.type === 'autoSend')).toBe(false); expect(store.state.ledger[chat]).toBeUndefined(); assistant.cancel();
  });
  test.each(['text', 'viewport'])('reconsiders a fresh message after delayed %s readiness', async stage => {
    vi.useFakeTimers(); const store = new Store(directory()); store.update(s => { s.auto[chat] = { ...rules, startHour: 0, endHour: 0 }; s.global.shareContext = true; });
    const assistant = new Assistant(store, {} as Vault, { send() {}, focus() {} }, () => {}, true);
    assistant.receive(snap());
    assistant.receive(snap({ messages: [{ id: 'b', text: stage === 'text' ? '' : 'new', outgoing: false }], atBottom: stage !== 'viewport' }));
    await vi.advanceTimersByTimeAsync(1500); expect(assistant.pending).toBeNull();
    assistant.receive(snap({ messages: [{ id: 'b', text: 'new', outgoing: false }], atBottom: true }));
    await vi.advanceTimersByTimeAsync(1500); expect(assistant.pending).not.toBeNull(); assistant.cancel();
  });
  test('a message that becomes ready more than a minute later is not treated as fresh', async () => {
    vi.useFakeTimers(); const store = new Store(directory()); store.update(s => { s.auto[chat] = { ...rules, startHour: 0, endHour: 0 }; s.global.shareContext = true; });
    const assistant = new Assistant(store, {} as Vault, { send() {}, focus() {} }, () => {}, true);
    assistant.receive(snap()); assistant.receive(snap({ messages: [{ id: 'b', text: '', outgoing: false }] }));
    await vi.advanceTimersByTimeAsync(61000); assistant.receive(snap({ messages: [{ id: 'b', text: 'Late', outgoing: false }] }));
    await vi.advanceTimersByTimeAsync(1500); expect(assistant.pending).toBeNull(); assistant.cancel();
  });
  test('removing and restoring loaded messages never makes seen history a new arrival', async () => {
    vi.useFakeTimers(); const store = new Store(directory()); store.update(s => { s.auto[chat] = { ...rules, startHour: 0, endHour: 0 }; s.global.shareContext = true; });
    const assistant = new Assistant(store, {} as Vault, { send() {}, focus() {} }, () => {}, true);
    const older = { id: 'older', text: 'Older incoming', outgoing: false }, latest = { id: 'latest', text: 'Latest incoming', outgoing: false };
    assistant.receive(snap({ messages: [older, latest] })); assistant.receive(snap({ messages: [older] }));
    await vi.advanceTimersByTimeAsync(2000); expect(assistant.pending).toBeNull();
    assistant.receive(snap({ messages: [older, latest] })); await vi.advanceTimersByTimeAsync(2000); expect(assistant.pending).toBeNull();
    assistant.receive(snap({ messages: [older, latest, { id: 'new', text: 'New arrival', outgoing: false }] }));
    await vi.advanceTimersByTimeAsync(2000); expect(assistant.pending).not.toBeNull(); assistant.cancel();
  });
  test('takeover remains paused through a failed disk write until explicit resume', async () => {
    vi.useFakeTimers(); const store = new Store(directory()); store.update(s => { s.auto[chat] = { ...rules, startHour: 0, endHour: 0 }; s.global.shareContext = true; });
    const assistant = new Assistant(store, {} as Vault, { send() {}, focus() {} }, () => {}, true); assistant.receive(snap());
    const write = vi.spyOn(store, 'update'); write.mockImplementationOnce(() => { throw new Error('disk full'); });
    assistant.activity(); expect(assistant.isRuntimePaused()).toBe(true); expect(store.state.auto[chat].paused).toBe(false);
    assistant.receive(snap({ messages: [{ id: 'new', text: 'New arrival', outgoing: false }] })); await vi.advanceTimersByTimeAsync(3000); expect(assistant.pending).toBeNull();
    assistant.reconfigure(); assistant.receive(snap({ messages: [{ id: 'new2', text: 'Another arrival', outgoing: false }] })); await vi.advanceTimersByTimeAsync(3000); expect(assistant.pending).toBeNull();
    assistant.changeAutoPermission(chat, 'resume'); assistant.receive(snap({ messages: [{ id: 'new3', text: 'After explicit resume', outgoing: false }] })); await vi.advanceTimersByTimeAsync(1500); expect(assistant.pending).not.toBeNull(); assistant.cancel();
  });
});
describe('connection-check generations', () => {
  const configuration = { provider: 'openai' as const, model: 'synthetic-model', key: 'synthetic-key' };
  test.each(['success', 'error'])('configuration invalidation discards stale %s even if transport ignores abort', async outcome => {
    let finish!: (value: string) => void, fail!: (error: Error) => void;
    const generator = vi.fn((_request: Parameters<typeof generate>[0]) => new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; }));
    const check = new ProviderCheck(generator), pending = check.run(configuration);
    check.invalidate();
    expect(generator.mock.calls[0][0].signal!.aborted).toBe(true);
    if (outcome === 'success') finish('Connected'); else fail(new Error('Old configuration failed'));
    expect(await pending).toBeUndefined();
  });
  test('a newer check owns feedback when an older request finishes last', async () => {
    let finish!: (value: string) => void;
    const generator = vi.fn().mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; })).mockResolvedValue('Connected');
    const check = new ProviderCheck(generator), old = check.run(configuration);
    expect(await check.run({ ...configuration, model: 'replacement-model' })).toContain('Connected');
    finish('Connected'); expect(await old).toBeUndefined();
  });
  test('current configuration errors remain visible', async () => {
    const check = new ProviderCheck(async () => { throw new Error('Key rejected'); });
    await expect(check.run(configuration)).rejects.toThrow('Key rejected');
  });
});
describe('real provider request formats and safe failures', () => {
  const request = { provider: 'openai' as const, model: 'configured-model', key: 'test-secret-not-real', system: 'Draft a reply', input: 'Synthetic test' };
  test.each([['gpt-6-luna', 'none'], ['gpt-6-astra', 'low'], ['custom-model', undefined]])('uses only documented latency controls for %s', async (model, effort) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi' }] }] }))) as unknown as typeof fetch;
    await generate({ ...request, model }, fetcher);
    const body = JSON.parse(vi.mocked(fetcher).mock.calls[0][1]!.body as string);
    expect(body.reasoning).toEqual(effort ? { effort } : undefined);
  });
  test('OpenAI Responses uses instructions, non-stored requests and parses message content', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'Hello!' }] }] }))) as unknown as typeof fetch;
    expect(await generate(request, fetcher)).toBe('Hello!');
    const [url, options] = vi.mocked(fetcher).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses'); expect(JSON.parse(options!.body as string)).toMatchObject({ store: false, instructions: 'Draft a reply', model: 'configured-model' });
    expect(options!.redirect).toBe('error');
  });
  test('Anthropic uses Messages with versioned header', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'Hi' }] }))) as unknown as typeof fetch;
    expect(await generate({ ...request, provider: 'anthropic' }, fetcher)).toBe('Hi');
    expect(vi.mocked(fetcher).mock.calls[0][1]!.headers).toMatchObject({ 'anthropic-version': '2023-06-01', 'x-api-key': request.key });
  });
  test('provider adapters retain significant leading and trailing whitespace', async () => {
    expect(await generate(request, (async () => new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: ' again\n' }] }] }))) as typeof fetch)).toBe(' again\n');
  });
  test('errors never echo secrets or provider response bodies', async () => {
    await expect(generate(request, (async () => new Response(request.key, { status: 401 })) as typeof fetch)).rejects.toThrow('Key rejected');
    await expect(generate(request, (async () => { throw new Error(request.key); }) as typeof fetch)).rejects.toThrow('Unable to connect');
  });
});
