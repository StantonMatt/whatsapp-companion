import { afterEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type StorageFault } from '../src/main/store';
import { actionSchema } from '../src/shared/model';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/sticker-dedupe/images.json', import.meta.url), 'utf8'));
const dirs: string[] = [];
const seed = (fault?: StorageFault) => {
  const dir = mkdtempSync(join(tmpdir(), 'sticker-delete-')); dirs.push(dir);
  const store = new Store(dir, fault);
  const stickers = ['original', 'animated'].map(name => {
    const image = fixtures[name].image as string;
    const id = createHash('sha256').update(Buffer.from(image.split(',')[1], 'base64')).digest('hex');
    return store.stickerFiles.write({ id, image, firstSeen: 1, lastSeen: 2, searchTerms: name });
  });
  store.update(state => { state.stickers = stickers; });
  return { store, ids: stickers.map(s => s.id), dir };
};
const disk = (dir: string) => JSON.parse(readFileSync(join(dir, 'companion.json'), 'utf8'));
const blob = (dir: string, id: string) => join(dir, 'stickers', `${id}.webp`);
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('bulk action bounds ids, requires unique hashes and rejects extra fields', () => {
  const ids = ['a'.repeat(64), 'b'.repeat(64)];
  expect(actionSchema.safeParse({ type: 'forgetStickers', ids }).success).toBe(true);
  expect(actionSchema.safeParse({ type: 'forgetStickers', ids: Array.from({ length: 2000 }, (_, i) => i.toString(16).padStart(64, '0')) }).success).toBe(true);
  for (const raw of [{}, { ids: [] }, { ids: [ids[0], ids[0]] }, { ids: ['bad'] }, { ids: [1] }, { ids, extra: true }, { ids: Array.from({ length: 2001 }, (_, i) => i.toString(16).padStart(64, '0')) }]) {
    expect(actionSchema.safeParse({ type: 'forgetStickers', ...raw }).success).toBe(false);
  }
});

test('bulk deletion writes once, persists all tombstones before any blob cleanup and invalidates every cache', () => {
  let writes = 0;
  const { store, ids, dir } = seed(step => { if (step === 'manifest:write') writes++; }); writes = 0;
  const update = vi.spyOn(store, 'update'), invalidate = vi.spyOn(store.stickerFiles, 'invalidate');
  const original = store.stickerFiles.remove.bind(store.stickerFiles);
  const remove = vi.spyOn(store.stickerFiles, 'remove').mockImplementation(id => {
    expect(disk(dir).stickers).toEqual([]); expect(disk(dir).forgottenStickers).toEqual(ids);
    original(id);
  });
  store.forgetStickers(ids);
  expect(update).toHaveBeenCalledOnce(); expect(writes).toBe(1); expect(remove).toHaveBeenCalledTimes(2);
  for (const id of ids) { expect(invalidate).toHaveBeenCalledWith(id, 'removed'); expect(existsSync(blob(dir, id))).toBe(false); }
});

test('unknown ids are ignored consistently by single and bulk actions, without writes or tombstones', () => {
  const { store, ids } = seed(), update = vi.spyOn(store, 'update');
  expect(store.forgetSticker('f'.repeat(64))).toEqual([]); expect(store.forgetStickers(['e'.repeat(64)])).toEqual([]);
  expect(update).not.toHaveBeenCalled(); expect(store.state.forgottenStickers).toEqual([]);
  expect(store.forgetStickers([ids[0], 'f'.repeat(64)])).toEqual([ids[0]]);
  expect(store.state.forgottenStickers).toEqual([ids[0]]); expect(store.state.stickers.map(s => s.id)).toEqual([ids[1]]);
});

test('failed batch manifest write leaves every reference, blob and cache untouched', () => {
  let fail = false;
  const { store, ids, dir } = seed(step => { if (fail && step === 'manifest:sync') throw new Error('disk full'); });
  const invalidate = vi.spyOn(store.stickerFiles, 'invalidate'), remove = vi.spyOn(store.stickerFiles, 'remove');
  fail = true; expect(() => store.forgetStickers(ids)).toThrow('disk full');
  expect(store.state).toEqual(disk(dir)); expect(store.state.stickers).toHaveLength(2); expect(store.state.forgottenStickers).toEqual([]);
  expect(invalidate).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  for (const id of ids) expect(existsSync(blob(dir, id))).toBe(true);
});

test('one failed unlink leaves an orphan and still removes the other blob; restart retries it', () => {
  const { store, ids, dir } = seed(), original = store.stickerFiles.remove.bind(store.stickerFiles);
  vi.spyOn(store.stickerFiles, 'remove').mockImplementation(id => { if (id === ids[0]) throw new Error('unlink failed'); original(id); });
  expect(() => store.forgetStickers(ids)).not.toThrow();
  expect(store.state.stickers).toEqual([]); expect(disk(dir).forgottenStickers).toEqual(ids);
  expect(existsSync(blob(dir, ids[0]))).toBe(true); expect(existsSync(blob(dir, ids[1]))).toBe(false);
  new Store(dir); expect(existsSync(blob(dir, ids[0]))).toBe(false);
});

test('a batch directory durability warning preserves all blobs after the saved tombstones', () => {
  let fail = false;
  const { store, ids, dir } = seed(step => { if (fail && step === 'manifest:directory-sync') throw new Error('sync failed'); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fail = true; expect(store.forgetStickers(ids)).toEqual(ids);
  expect(store.durabilityWarning).toBe(true); expect(disk(dir).forgottenStickers).toEqual(ids);
  for (const id of ids) expect(existsSync(blob(dir, id))).toBe(true);
});


test('successful sync retry clears the deletion durability warning without rewriting tombstones', () => {
  let fail = false;
  const { store, ids, dir } = seed(step => { if (fail && step.includes('directory-sync')) throw new Error('sync failed'); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fail = true; expect(store.forgetStickers(ids)).toEqual(ids);
  expect(store.durabilityWarning).toBe(true);
  fail = false; store.update(() => {});
  expect(store.durabilityWarning).toBe(false); expect(disk(dir).forgottenStickers).toEqual(ids);
});


test('bulk deletion returns preserved recovery hashes and ignores unrelated unknown ids', () => {
  const { ids, dir } = seed();
  rmSync(join(dir, 'companion.json'));
  const recovered = new Store(dir);
  expect(recovered.state.stickers).toEqual([]);
  expect(recovered.forgetStickers([ids[0], 'f'.repeat(64)])).toEqual([ids[0]]);
  expect(disk(dir).forgottenStickers).toEqual([ids[0]]); expect(existsSync(blob(dir, ids[0]))).toBe(false);
  expect(existsSync(blob(dir, ids[1]))).toBe(true); expect(recovered.recoveryHint).toContain('Restore companion.json');
});
