import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { actionSchema, initialState, stateSchema, stickerSchema, type State, type Sticker } from '../src/shared/model';
import { applyStickerGroupAction, groupSelectionState } from '../src/core/sticker-groups';
import { forgetSticker, searchStickers, upsertSticker } from '../src/core/stickers';
import { statusUpdate, StatusCache } from '../src/core/status';
import { Store } from '../src/main/store';
const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
const group = '550e8400-e29b-41d4-a716-446655440000';
const second = '550e8400-e29b-41d4-a716-446655440001';
const sticker = (id = a, terms = 'dog, perro'): Sticker => ({ id, searchTerms: terms, firstSeen: 1, lastSeen: 1, size: 12, kind: 'static', groups: [] });
const state = (): State => ({ ...initialState(), stickers: [sticker(), sticker(b, 'cat, gato'), sticker(c, 'dog, puppy')] });
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

test('old v2 manifests default groups without rewriting and the next save persists them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sticker-groups-')); dirs.push(dir);
  const raw: any = state(); delete raw.stickerGroups; raw.stickers.forEach((s: any) => delete s.groups);
  const original = JSON.stringify(raw); writeFileSync(join(dir, 'companion.json'), original);
  const store = new Store(dir);
  expect(store.state.stickerGroups).toEqual([]); expect(store.state.stickers.every(s => s.groups.length === 0)).toBe(true);
  expect(readFileSync(join(dir, 'companion.json'), 'utf8')).toBe(original);
  store.update(s => applyStickerGroupAction(s, { type: 'createStickerGroup', name: ' Dogs ', stickerIds: [a, c] }, () => group));
  expect(new Store(dir).state).toEqual(store.state);
  expect(JSON.parse(readFileSync(join(dir, 'companion.json'), 'utf8')).stickerGroups).toEqual([{ id: group, name: 'Dogs' }]);
});

test('schema defaults and strict constraints reject duplicate names, ids, memberships and dangling ids', () => {
  const old: any = sticker(); delete old.groups; expect(stickerSchema.parse(old).groups).toEqual([]);
  const s = state(); s.stickerGroups = [{ id: group, name: ' Dogs ' }]; s.stickers[0].groups = [group];
  expect(stateSchema.parse(s).stickerGroups[0].name).toBe('Dogs');
  for (const name of ['', ' ', 'x'.repeat(41)]) expect(stateSchema.safeParse({ ...s, stickerGroups: [{ id: group, name }] }).success).toBe(false);
  for (const other of [{ id: second, name: 'dogs' }, { id: group, name: 'Cats' }]) expect(stateSchema.safeParse({ ...s, stickerGroups: [...s.stickerGroups, other] }).success).toBe(false);
  s.stickers[0].groups = [second]; expect(stateSchema.safeParse(s).success).toBe(false);
  s.stickers[0].groups = [group, group]; expect(stateSchema.safeParse(s).success).toBe(false);
  s.stickers[0].groups = []; s.stickerGroups = Array.from({ length: 51 }, (_, i) => ({ id: randomUUID(), name: `Group ${i}` })); expect(stateSchema.safeParse(s).success).toBe(false);
  expect(stateSchema.safeParse({ ...state(), stickerGroups: [{ id: 'bad', name: 'Dogs', unexpected: true }] }).success).toBe(false);
});

test('all group actions preserve creation order, many-to-many membership and delete cleanup', () => {
  const s = state();
  applyStickerGroupAction(s, { type: 'createStickerGroup', name: 'Dogs', stickerIds: [a, a, c] }, () => group);
  applyStickerGroupAction(s, { type: 'createStickerGroup', name: 'Favorites' }, () => second);
  applyStickerGroupAction(s, { type: 'stickerGroupMembership', id: a, groupId: second, member: true }, randomUUID);
  applyStickerGroupAction(s, { type: 'bulkStickerGroupMembership', stickerIds: [a, b], groupId: second, member: true }, randomUUID);
  expect(s.stickers[0].groups).toEqual([group, second]); expect(s.stickers[1].groups).toEqual([second]);
  applyStickerGroupAction(s, { type: 'renameStickerGroup', id: group, name: ' Animals ' }, randomUUID);
  expect(s.stickerGroups.map(g => g.name)).toEqual(['Animals', 'Favorites']);
  applyStickerGroupAction(s, { type: 'stickerGroupMembership', id: b, groupId: second, member: false }, randomUUID);
  applyStickerGroupAction(s, { type: 'bulkStickerGroupMembership', stickerIds: [a, c], groupId: group, member: false }, randomUUID);
  expect(s.stickers[0].groups).toEqual([second]);
  applyStickerGroupAction(s, { type: 'deleteStickerGroup', id: second }, randomUUID);
  expect(s.stickers).toHaveLength(3); expect(s.stickers.every(s => !s.groups.includes(second))).toBe(true);
  s.stickers[0].groups = [group]; upsertSticker(s.stickers, { ...sticker(), lastSeen: 99 }); expect(s.stickers[0].groups).toEqual([group]);
  forgetSticker(s, a); expect(s.stickers.some(s => s.id === a)).toBe(false);
  expect(stateSchema.safeParse(s).success).toBe(true);
});

test('invalid action values and unknown ids are rejected without partial changes', () => {
  const s = state(); applyStickerGroupAction(s, { type: 'createStickerGroup', name: 'Dogs' }, () => group);
  const invalid = [
    { type: 'createStickerGroup', name: ' dogs ' },
    { type: 'createStickerGroup', name: 'New', stickerIds: [a, 'f'.repeat(64)] },
    { type: 'renameStickerGroup', id: second, name: 'Cats' },
    { type: 'deleteStickerGroup', id: second },
    { type: 'stickerGroupMembership', id: a, groupId: second, member: true },
    { type: 'stickerGroupMembership', id: 'f'.repeat(64), groupId: group, member: true },
    { type: 'bulkStickerGroupMembership', stickerIds: [a, 'f'.repeat(64)], groupId: group, member: true }
  ];
  for (const raw of invalid) {
    const before = structuredClone(s), action = actionSchema.parse(raw);
    expect(() => applyStickerGroupAction(s, action as any, randomUUID)).toThrow(); expect(s).toEqual(before);
  }
  for (const raw of [
    { type: 'createStickerGroup', name: ' ' }, { type: 'renameStickerGroup', id: group, name: 'x'.repeat(41) },
    { type: 'deleteStickerGroup', id: 'bad' }, { type: 'stickerGroupMembership', id: a, groupId: group, member: 'yes' },
    { type: 'bulkStickerGroupMembership', groupId: group, member: true, stickerIds: [] },
    { type: 'createStickerGroup', name: 'New', id: second }
  ]) expect(actionSchema.safeParse(raw).success).toBe(false);
  s.stickerGroups = Array.from({ length: 50 }, (_, i) => ({ id: randomUUID(), name: `Group ${i}` }));
  expect(() => applyStickerGroupAction(s, { type: 'createStickerGroup', name: 'One more' }, randomUUID)).toThrow('50');
});

test('group and search filters intersect; tri-state counts the entire selection', () => {
  const s = state(); s.stickers[0].groups = [group]; s.stickers[1].groups = [group];
  expect(searchStickers(s.stickers, 'dog', group).map(s => s.id)).toEqual([a]);
  expect(searchStickers(s.stickers, '', group)).toHaveLength(2); expect(searchStickers(s.stickers, 'dog')).toHaveLength(2);
  expect(groupSelectionState([], group)).toBe(false); expect(groupSelectionState(s.stickers, group)).toBe('mixed');
  expect(groupSelectionState(s.stickers.slice(0, 2), group)).toBe(true); expect(groupSelectionState([s.stickers[2]], group)).toBe(false);
});

test('membership-only edits cross incremental IPC status and reach the renderer cache', () => {
  const s = state(); s.stickerGroups = [{ id: group, name: 'Dogs' }];
  const base: any = { sequence: 1, state: s };
  const next = { ...base, sequence: 2, state: structuredClone(s) }; next.state.stickers[0].groups = [group];
  const cache = new StatusCache(); cache.accept(base);
  const delta = statusUpdate(next, s); expect(delta.stickerChanges?.upsert).toEqual([next.state.stickers[0]]);
  expect(cache.accept(delta)?.state.stickers[0].groups).toEqual([group]);
});
