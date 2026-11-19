import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Store } from '../src/main/store';
import { Conversations } from '../src/main/conversations';
import { emptySnapshot, actionSchema, snapshotSchema, type Snapshot } from '../src/shared/model';
import { resolveSettings, setPreferences, resetPreferences } from '../src/core/settings';
import { buildPrompt } from '../src/main/providers';
import { Assistant } from '../src/main/assistant';
import type { Vault } from '../src/main/vault';
const dirs: string[] = [];
const registries: Conversations[] = [];
afterEach(() => { registries.splice(0).forEach(registry => registry.close()); dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })); dirs.length = 0; });
const setup = () => { const dir = mkdtempSync(join(tmpdir(), 'companion-conversations-')); dirs.push(dir); const store = new Store(dir); const registry = new Conversations(store); registries.push(registry); return { dir, store, registry }; };
const snapshot = (ids: string[], name = 'Same display name'): Snapshot => ({ ...emptySnapshot, kind: 'unknown', conversationOpen: true, ready: true, name, messages: ids.map(id => ({ id, text: 'PRIVATE MESSAGE CONTENT', outgoing: true })) });
test('recognition persists across restart and rename, without names or message content', () => {
  const { store, registry, dir } = setup();
  const id = registry.identify(snapshot(['OPAQUE111', 'OPAQUE222']))!;
  store.update(s => setPreferences(s, id, { tone: 'professional' }));
  const reopened = new Store(dir), next = new Conversations(reopened); registries.push(next);
  expect(next.identify(snapshot(['OPAQUE222', 'OPAQUE333'], 'Renamed'))).toBe(id);
  expect(resolveSettings(reopened.state, 'unknown', id).values.tone).toBe('professional');
  const data = readFileSync(join(dir, 'companion.json'), 'utf8');
  expect(data).not.toContain('Same display name'); expect(data).not.toContain('PRIVATE MESSAGE'); expect(data).not.toContain('OPAQUE222');
});
test('duplicate names and disjoint history cannot adopt another chat’s instructions or style', () => {
  const { store, registry } = setup();
  const a = registry.identify(snapshot(['CHAT_A_001']))!, b = registry.identify(snapshot(['CHAT_B_001']))!;
  expect(a).not.toBe(b);
  store.update(s => { setPreferences(s, a, { instructions: 'Private work context', style: 'conversation' }); s.profiles[a] = { description: 'Private writing traits', samples: 5, source: 'edited', updatedAt: 1 }; });
  const prefs = resolveSettings(store.state, 'unknown', b).values;
  const prompt = buildPrompt(store.state, { ...prefs, style: 'conversation' }, { ...snapshot(['CHAT_B_001']), settingsId: b });
  expect(prefs.instructions).toBe(''); expect(prompt.system).not.toContain('Private work'); expect(prompt.system).not.toContain('Private writing');
  expect(registry.identify(snapshot(['CHAT_A_001']))).toBe(a);
  const disjoint = registry.identify(snapshot(['NEW_NO_OVERLAP']))!;
  expect(disjoint).not.toBe(a); expect(resolveSettings(store.state, 'unknown', disjoint).values.instructions).toBe('');
});
test('mixed anchors fail closed without merging or updating existing identities', () => {
  const { registry, store } = setup(); registry.identify(snapshot(['CHAT_A_001'])); registry.identify(snapshot(['CHAT_B_001']));
  const before = structuredClone(store.state.conversations);
  expect(registry.identify(snapshot(['CHAT_A_001', 'CHAT_B_001', 'UNRELATED']))).toBeNull();
  expect(store.state.conversations).toEqual(before);
  expect(registry.identify({ ...snapshot(['CHAT_A_001']), conversationOpen: false })).toBeNull();
});
test('visible conversations retain recognition without a ready composer, but hidden history cannot identify them', () => {
  const { registry } = setup();
  const visible = snapshot(['CHAT_A_001']);
  const id = registry.identify(visible);
  expect(registry.identify({ ...visible, ready: false })).toBe(id);
  expect(registry.identify({ ...visible, conversationOpen: false, ready: false })).toBeNull();
});
test('only new anchors write to disk, anchors are bounded, and capacity does not evict private settings', () => {
  const { registry, store } = setup();
  const first = registry.identify(snapshot(['FIRST001']))!;
  const update = vi.spyOn(store, 'update');
  registry.identify(snapshot(['FIRST001'])); expect(update).not.toHaveBeenCalled();
  let previous = 'FIRST001';
  for (let i = 0; i < 220; i++) { const next = `NEXT${String(i).padStart(6, '0')}`; expect(registry.identify(snapshot([previous, next]))).toBe(first); previous = next; }
  registry.flush();
  expect(store.state.conversations[first]).toHaveLength(200);
  for (let i = 1; i < 2000; i++) store.state.conversations[`local:capacity-${i}`] = [];
  expect(registry.identify(snapshot(['UNSEEN001']))).toBeNull();
  expect(registry.identify(snapshot([previous]))).toBe(first);
});
test('local identity scopes preferences/style, cannot be supplied by remote or authorize auto sending', () => {
  const { store, registry } = setup(), snap = snapshot(['CHAT_A_001']);
  const id = registry.identify(snap)!;
  expect(snapshotSchema.safeParse({ ...snap, settingsId: id }).success).toBe(false);
  expect(actionSchema.safeParse({ type: 'autoPermission', chatId: id, permission: 'enable' }).success).toBe(false);
  store.update(s => { s.global.aiFeatures = true; setPreferences(s, id, { style: 'conversation', learnFromSent: true, tone: 'friendly' }); });
  const assistant = new Assistant(store, {} as Vault, { send() {}, focus() {} }, () => {}, true);
  assistant.receive({ ...snapshot(['CHAT_A_001', 'CHAT_A_002', 'CHAT_A_003', 'CHAT_A_004', 'CHAT_A_005']), settingsId: id });
  expect(store.state.profiles[id]?.samples).toBe(5);
  expect(store.state.auto).toEqual({});
  store.update(s => resetPreferences(s, id));
  expect(resolveSettings(store.state, 'unknown', id).values.tone).toBe('natural');
});


test('anchor observations coalesce, remain usable for overlap before flush and drain on close', async () => {
  vi.useFakeTimers();
  try {
    const { registry, store, dir } = setup(), first = registry.identify(snapshot(['FIRST001']))!;
    const update = vi.spyOn(store, 'update');
    expect(registry.identify(snapshot(['FIRST001', 'SECOND001']))).toBe(first);
    expect(registry.identify(snapshot(['SECOND001', 'THIRD001']))).toBe(first);
    expect(update).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(250);
    expect(update).toHaveBeenCalledTimes(1); expect(store.state.conversations[first]).toHaveLength(3);
    registry.identify(snapshot(['THIRD001', 'FOURTH001'])); registry.close();
    expect(update).toHaveBeenCalledTimes(2); expect(new Store(dir).state.conversations[first]).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

test('failed observation saves retain anchors for retry without merging identities', () => {
  const { registry, store } = setup(), first = registry.identify(snapshot(['FIRST001']))!;
  registry.identify(snapshot(['FIRST001', 'SECOND001']));
  const update = vi.spyOn(store, 'update').mockImplementationOnce(() => { throw new Error('disk full'); });
  expect(() => registry.flush()).toThrow('disk full');
  expect(registry.identify(snapshot(['SECOND001']))).toBe(first);
  update.mockRestore(); registry.flush(); expect(store.state.conversations[first]).toHaveLength(2);
});
