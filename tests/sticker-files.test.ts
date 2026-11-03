import { afterEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, legacyStateSchema, stateSchema, stickerSchema, type DiscoveredSticker } from '../src/shared/model';
import { Store } from '../src/main/store';
import { stickerResponse } from '../src/main/sticker-protocol';
import { StickerFiles } from '../src/main/sticker-files';
import * as stickerBytes from '../src/main/sticker-bytes';
import { StickerInbox } from '../src/main/sticker-inbox';
import { upsertSticker } from '../src/core/stickers';
import { MAX_LIBRARY_BYTES, MAX_LIBRARY_STICKERS, MAX_STICKER_BYTES } from '../src/shared/sticker-limits';

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/sticker-dedupe/images.json', import.meta.url), 'utf8'));
function observation(name = 'original'): DiscoveredSticker {
  const image = fixtures[name].image as string;
  return { id: createHash('sha256').update(Buffer.from(image.split(',')[1], 'base64')).digest('hex'), image, searchTerms: 'cat, gato', firstSeen: 123, lastSeen: 456 };
}
const dirs: string[] = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'sticker-files-')); dirs.push(dir); return dir; };
const manifest = (dir: string) => join(dir, 'companion.json');
const blob = (dir: string, id = observation().id) => join(dir, 'stickers', `${id}.webp`);
const load = (dir: string) => JSON.parse(readFileSync(manifest(dir), 'utf8'));
function seed(dir: string) {
  const legacy = { ...legacyInitialState(), version: 1, stickers: [observation(), observation('animated')], forgottenStickers: ['f'.repeat(64)] };
  writeFileSync(manifest(dir), JSON.stringify(legacy)); return legacy;
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

test('migrates without re-encoding/deduplication and durably preserves an immutable backup', () => {
  const dir = directory(), legacy = seed(dir);
  legacy.stickers.push(observation('reencoded'));
  legacy.stickers[0].fingerprint = { version: 1, animated: false, hash: 'a'.repeat(16), pixels: fixtures.original.pixels };
  writeFileSync(manifest(dir), JSON.stringify(legacy));
  const original = readFileSync(manifest(dir), 'utf8');
  const store = new Store(dir);
  expect(store.state.version).toBe(2);
  for (const entry of legacy.stickers) {
    expect(store.state.stickers.find(s => s.id === entry.id)).toMatchObject({ id: entry.id, searchTerms: entry.searchTerms, firstSeen: 123, lastSeen: 456 });
    expect(store.readSticker(entry.id).image).toBe(entry.image);
    expect(store.state.stickers.find(s => s.id === entry.id)?.fingerprint).toEqual(entry.fingerprint);
    expect(statSync(blob(dir, entry.id)).mode & 0o777).toBe(0o600);
  }
  expect(statSync(join(dir, 'stickers')).mode & 0o777).toBe(0o700);
  expect(statSync(manifest(dir)).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(dir, 'companion.v1-backup.json'), 'utf8')).toBe(original);
  expect(load(dir).stickers.every((s: object) => !('image' in s))).toBe(true);
  store.update(s => { s.global.language = 'Spanish'; });
  expect(new Store(dir).state.global.language).toBe('Spanish');
  expect(readFileSync(join(dir, 'companion.v1-backup.json'), 'utf8')).toBe(original);
});

const steps = ['backup:write', 'backup:sync', 'backup:replace', 'backup:rename', 'backup:directory-sync', 'backup:directory', ...['original', 'animated'].flatMap(name => ['write', 'sync', 'replace', 'rename', 'directory-sync', 'directory', 'verified'].map(step => `blob:${observation(name).id}:${step}`)), 'migration:verified', 'manifest:write', 'manifest:sync', 'manifest:replace', 'manifest:rename', 'manifest:directory-sync', 'manifest:directory'];
test.each(steps)('an interruption at %s leaves v1 intact or v2 complete; rerun finishes', checkpoint => {
  const dir = directory(), legacy = seed(dir);
  const start = () => new Store(dir, step => { if (step === checkpoint) throw new Error('crash'); });
  if (/:rename$|:directory-sync$|:directory$/.test(checkpoint)) expect(start).not.toThrow();
  else expect(start).toThrow('crash');
  const current = load(dir);
  if (current.version === 1) expect(current).toEqual(legacy);
  else {
    expect(stateSchema.safeParse(current).success).toBe(true);
    for (const sticker of current.stickers) expect(existsSync(blob(dir, sticker.id))).toBe(true);
  }
  const restored = new Store(dir);
  expect(restored.state.version).toBe(2);
  for (const entry of legacy.stickers) expect(restored.readSticker(entry.id).image).toBe(entry.image);
  expect(readFileSync(join(dir, 'companion.v1-backup.json'), 'utf8')).toBe(JSON.stringify(legacy));
});

test('reuse verifies existing blobs; incomplete temps are replaced; a backup is never overwritten', () => {
  const dir = directory(), legacy = seed(dir);
  mkdirSync(join(dir, 'stickers'));
  writeFileSync(blob(dir), Buffer.from(legacy.stickers[0].image.split(',')[1], 'base64'));
  writeFileSync(`${blob(dir, legacy.stickers[1].id)}.tmp`, 'partial');
  writeFileSync(join(dir, 'companion.v1-backup.json'), 'older preserved backup');
  const restored = new Store(dir);
  expect(restored.state.stickers).toHaveLength(2);
  expect(readFileSync(join(dir, 'companion.v1-backup.json'), 'utf8')).toBe('older preserved backup');
  expect(readdirSync(join(dir, 'stickers')).some(name => name.endsWith('.tmp'))).toBe(false);
});
test.each(['existing', 'after-write'])('verification failure (%s) preserves the inline manifest and skips GC', when => {
  const dir = directory(), legacy = seed(dir);
  mkdirSync(join(dir, 'stickers'));
  const orphan = blob(dir, 'e'.repeat(64)); writeFileSync(orphan, 'orphan');
  if (when === 'existing') writeFileSync(blob(dir), 'partial');
  expect(() => new Store(dir, step => { if (when === 'after-write' && step === `blob:${legacy.stickers[0].id}:directory`) writeFileSync(blob(dir), 'corrupt'); })).toThrow();
  expect(load(dir)).toEqual(legacy); expect(existsSync(orphan)).toBe(true);
});
test('full legacy validation precedes backup or file writes', () => {
  const dir = directory(); seed(dir);
  const raw = load(dir); raw.stickers[1].id = 'd'.repeat(64); writeFileSync(manifest(dir), JSON.stringify(raw));
  expect(() => new Store(dir)).toThrow('hash');
  expect(existsSync(join(dir, 'companion.v1-backup.json'))).toBe(false);
  expect(existsSync(join(dir, 'stickers'))).toBe(false);
  expect(load(dir)).toEqual(raw);
});
test('forget persists the tombstone before unlink, and restart GC cleans recognized orphans only', () => {
  const dir = directory(); seed(dir);
  let interrupt = false;
  const store = new Store(dir, step => { if (interrupt && step === 'forget:manifest') throw new Error('crash'); });
  const id = observation().id;
  interrupt = true; expect(() => store.forgetSticker(id)).toThrow('crash');
  expect(load(dir).forgottenStickers).toContain(id); expect(load(dir).stickers.some((s: { id: string }) => s.id === id)).toBe(false);
  expect(existsSync(blob(dir))).toBe(true);
  writeFileSync(join(dir, 'stickers', 'keep-me.txt'), 'user file');
  writeFileSync(`${blob(dir, 'a'.repeat(64))}.tmp`, 'temp');
  new Store(dir);
  expect(existsSync(blob(dir))).toBe(false); expect(existsSync(join(dir, 'stickers', 'keep-me.txt'))).toBe(true);
  expect(existsSync(`${blob(dir, 'a'.repeat(64))}.tmp`)).toBe(false);
});
test('failed manifest save leaves the live reference and file untouched', () => {
  const dir = directory(); seed(dir); let interrupt = false;
  const store = new Store(dir, step => { if (interrupt && step === 'manifest:sync') throw new Error('disk full'); });
  interrupt = true; expect(() => store.forgetSticker(observation().id)).toThrow('disk full');
  expect(load(dir).stickers).toHaveLength(2); expect(store.state.stickers).toHaveLength(2); expect(existsSync(blob(dir))).toBe(true);
});
test.each(['write', 'sync', 'replace', 'rename', 'directory-sync', 'directory'])('manifest failure at %s keeps memory aligned with disk and preserves Forget on later writes', checkpoint => {
  const dir = directory(); seed(dir);
  let fail = false;
  const store = new Store(dir, step => { if (fail && step === `manifest:${checkpoint}`) throw new Error('IO failure'); });
  fail = true;
  const replaced = !['write', 'sync', 'replace'].includes(checkpoint);
  if (replaced) expect(() => store.forgetSticker(observation().id)).not.toThrow();
  else expect(() => store.forgetSticker(observation().id)).toThrow('IO failure');
  expect(store.state).toEqual(load(dir));
  expect(store.durabilityWarning).toBe(replaced);
  expect(store.state.forgottenStickers.includes(observation().id)).toBe(replaced);
  // The blob outlives a tombstone that is not yet crash-durable.
  expect(existsSync(blob(dir))).toBe(true);
  fail = false;
  store.update(state => { state.global.language = 'Spanish'; });
  expect(store.state).toEqual(load(dir)); expect(store.durabilityWarning).toBe(false);
  expect(load(dir).forgottenStickers.includes(observation().id)).toBe(replaced);
  new Store(dir);
  expect(existsSync(blob(dir))).toBe(!replaced);
});
test('persistent directory sync warnings allow saves and normal follow-up until retry succeeds', () => {
  const dir = directory(); seed(dir); let fail = false;
  const store = new Store(dir, step => { if (fail && step.endsWith(':directory-sync')) throw new Error('sync failed'); });
  fail = true; expect(() => store.forgetSticker(observation().id)).not.toThrow();
  const next = vi.fn();
  expect(() => store.update(next)).not.toThrow(); expect(next).toHaveBeenCalledOnce();
  expect(store.state).toEqual(load(dir)); expect(store.durabilityWarning).toBe(true);
  fail = false; store.update(next); expect(next).toHaveBeenCalledTimes(2); expect(store.durabilityWarning).toBe(false);
});
test.each(['write', 'sync', 'replace', 'rename', 'directory-sync', 'directory', 'verified'])('blob failure at %s preserves installed bytes and safely retries intake', async checkpoint => {
  const dir = directory(), entry = observation(); let fail = true;
  const store = new Store(dir, step => { if (fail && step === `blob:${entry.id}:${checkpoint}`) throw new Error('blob failure'); });
  const inbox = new StickerInbox(store, vi.fn(), vi.fn()); inbox.add(entry);
  const replaced = !['write', 'sync', 'replace'].includes(checkpoint);
  const saved = replaced && checkpoint !== 'verified';
  expect(await inbox.flush()).toBe(saved); expect(store.state.stickers).toHaveLength(saved ? 1 : 0);
  expect(existsSync(blob(dir))).toBe(replaced);
  if (replaced) expect(store.stickerFiles.read(entry.id).image).toBe(entry.image);
  expect(store.durabilityWarning).toBe(replaced && checkpoint !== 'verified');
  fail = false; inbox.add(entry); expect(await inbox.flush()).toBe(true); expect(store.readSticker(entry.id).image).toBe(entry.image);
  expect(store.durabilityWarning).toBe(false); await inbox.close();
});
test('a blob directory sync warning retries without blocking another blob or losing installed bytes', () => {
  const dir = directory(); let fail = true;
  const store = new Store(dir, step => { if (fail && step.endsWith(':directory-sync')) throw new Error('sync failed'); });
  expect(() => store.stickerFiles.write(observation())).not.toThrow();
  expect(store.stickerFiles.read(observation().id).image).toBe(observation().image);
  expect(() => store.stickerFiles.write(observation('different'))).not.toThrow();
  expect(existsSync(blob(dir, observation('different').id))).toBe(true); expect(store.durabilityWarning).toBe(true);
  fail = false; store.stickerFiles.write(observation('different')); expect(store.durabilityWarning).toBe(false);
});
test('post-replacement manifest warning publishes successful intake without keeping retries', async () => {
  const dir = directory(); let fail = true;
  const store = new Store(dir, step => { if (fail && step === 'manifest:directory-sync') throw new Error('sync failed'); });
  const changed = vi.fn(), inbox = new StickerInbox(store, changed, vi.fn()); inbox.add(observation());
  expect(await inbox.flush()).toBe(true); expect(changed).toHaveBeenCalledOnce(); expect(inbox.issue).toBeUndefined();
  expect(store.state).toEqual(load(dir)); expect(store.readSticker(observation().id).image).toBe(observation().image);
  fail = false; store.update(s => { s.global.language = 'Spanish'; }); expect(await inbox.flush()).toBe(true); expect(store.state.stickers).toHaveLength(1);
  expect(store.durabilityWarning).toBe(false); await inbox.close();
});
test('invalid manifests never trigger GC', () => {
  const dir = directory(); seed(dir); new Store(dir);
  writeFileSync(manifest(dir), '{}');
  expect(() => new Store(dir)).toThrow(); expect(existsSync(blob(dir))).toBe(true);
});
test.each(['missing', 'corrupt', 'symlink'])('missing/damaged blobs (%s) retain metadata and fail closed', async failure => {
  const dir = directory(); seed(dir); const store = new Store(dir), entry = structuredClone(store.state.stickers[0]);
  unlinkSync(blob(dir));
  if (failure === 'corrupt') writeFileSync(blob(dir), 'corrupt');
  if (failure === 'symlink') symlinkSync(blob(dir, observation('animated').id), blob(dir));
  expect(() => store.readSticker(entry.id)).toThrow('Restore the file from a backup, or let the app rediscover the sticker.');
  const response = await stickerResponse(store, { url: `companion-sticker://${entry.id}`, method: 'GET' });
  expect(response.status).toBe(404); expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(new Store(dir).state.stickers[0]).toEqual(entry);
});
test('protocol serves only canonical current references with re-verified WebP bytes', async () => {
  const dir = directory(); seed(dir); const store = new Store(dir), id = observation().id;
  const response = await stickerResponse(store, { url: `companion-sticker://${id}`, method: 'GET' });
  expect(response.headers.get('Content-Type')).toBe('image/webp'); expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(blob(dir)));
  for (const url of [`companion-sticker://${id}/..`, `companion-sticker://${id}?x`, `companion-sticker://${id}/foo`, `companion-sticker://user@${id}`, `companion-sticker://${id.toUpperCase()}`, 'companion-sticker://../companion.json', `companion-sticker://${'e'.repeat(64)}`]) expect((await stickerResponse(store, { url, method: 'GET' })).status).toBe(404);
  expect((await stickerResponse(store, { url: `companion-sticker://${id}`, method: 'POST' })).status).toBe(404);
  store.forgetSticker(id); expect((await stickerResponse(store, { url: `companion-sticker://${id}`, method: 'GET' })).status).toBe(404);
});
test('schema v2 strictly rejects inline images, missing size/kind, duplicates and excess bytes; v1 remains explicit', () => {
  const entry = observation(), dir = directory(); const store = new Store(dir), metadata = store.stickerFiles.write(entry);
  expect(legacyStateSchema.safeParse({ ...legacyInitialState(), version: 1, stickers: [entry] }).success).toBe(true);
  expect(stateSchema.safeParse({ ...legacyInitialState(), version: 1, stickers: [entry] }).success).toBe(false);
  expect(stickerSchema.safeParse({ ...metadata, image: entry.image }).success).toBe(false);
  const { size: _size, ...missing } = metadata; expect(stickerSchema.safeParse(missing).success).toBe(false);
  expect(stateSchema.safeParse({ ...initialState(), stickers: [metadata, metadata] }).success).toBe(false);
  const full = Array.from({ length: 1025 }, (_, i) => ({ ...metadata, size: 1024 * 1024, id: i.toString(16).padStart(64, '0') }));
  expect(stateSchema.safeParse({ ...initialState(), stickers: full }).success).toBe(false);
});
test.each(['count', 'bytes'])('intake reports %s capacity instead of silently refusing', async limit => {
  const store = new Store(directory()), entry = observation(), metadata = store.stickerFiles.write(entry), failed = vi.fn();
  const count = limit === 'count' ? MAX_LIBRARY_STICKERS : 1024;
  store.update(s => { s.stickers = Array.from({ length: count }, (_, i) => ({ ...metadata, size: limit === 'bytes' ? 1024 * 1024 : metadata.size, id: i.toString(16).padStart(64, '0') })); });
  expect(store.state.stickers.reduce((n, s) => n + s.size, 0)).toBeLessThanOrEqual(MAX_LIBRARY_BYTES);
  const inbox = new StickerInbox(store, vi.fn(), failed);
  inbox.add(entry); expect(await inbox.flush()).toBe(true);
  expect(inbox.issue).toBe('Sticker library is full'); expect(failed).toHaveBeenCalledWith('Sticker library is full');
  expect(store.state.stickers).toHaveLength(count);
  store.update(s => { s.stickers = []; }); inbox.add(entry); await inbox.flush(); expect(inbox.issue).toBeUndefined();
});
test('intake reports disk failures and retains observations to retry', async () => {
  const store = new Store(directory()), entry = observation(), failed = vi.fn();
  const write = vi.spyOn(store.stickerFiles, 'write').mockImplementation(() => { throw new Error('disk full'); });
  const inbox = new StickerInbox(store, vi.fn(), failed); inbox.add(entry);
  expect(await inbox.flush()).toBe(false); expect(inbox.issue).toBe("Couldn't save new stickers"); expect(store.state.stickers).toEqual([]);
  write.mockRestore(); expect(await inbox.flush()).toBe(true); expect(store.state.stickers[0].id).toBe(entry.id);
  expect(upsertSticker(store.state.stickers, { ...store.state.stickers[0], lastSeen: 999 })).toBe(true);
});

test('new stickers index beyond the old 50,000,000-character library budget', async () => {
  const store = new Store(directory()), inbox = new StickerInbox(store, vi.fn(), vi.fn());
  const bytes = Buffer.alloc(1024 * 1024); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WEBP', 8);
  bytes.write('ANIM', 12); bytes.writeUInt32LE(bytes.length - 20, 16);
  let chars = 0;
  // Two independently bounded intake batches; persistent images exceed v1's
  // total encoded budget without bloating the metadata manifest.
  for (let index = 0; index < 40; index++) {
    bytes.writeUInt32LE(index, 20);
    const image = `data:image/webp;base64,${bytes.toString('base64')}`; chars += image.length;
    inbox.add({ id: createHash('sha256').update(bytes).digest('hex'), image, searchTerms: 'large animation', firstSeen: 1, lastSeen: 1 });
    if (index === 19) expect(await inbox.flush()).toBe(true);
  }
  expect(await inbox.flush()).toBe(true); expect(chars).toBeGreaterThan(50_000_000);
  expect(store.state.stickers).toHaveLength(40); expect(inbox.issue).toBeUndefined();
  expect(statSync(manifest(dirs.at(-1)!)).size).toBeLessThan(20_000);
  expect(new Store(dirs.at(-1)!).state.stickers).toEqual(store.state.stickers);
});
test('pending intake has its own bound and reports overflow while retaining the accepted batch', async () => {
  const store = new Store(directory()), changed = vi.fn(), failed = vi.fn();
  // Avoid writing 2,000 tiny fixture files; this check exercises intake rather
  // than durability (covered above). The manifest still validates and persists.
  vi.spyOn(store.stickerFiles, 'write').mockImplementation(({ image, ...metadata }) => ({ ...metadata, groups: [], size: 24, kind: 'static' }));
  const inbox = new StickerInbox(store, changed, failed);
  const bytes = Buffer.alloc(24); bytes.write('RIFF'); bytes.writeUInt32LE(16, 4); bytes.write('WEBP', 8); bytes.write('TEST', 12); bytes.writeUInt32LE(4, 16);
  let refusedId = '';
  for (let index = 0; index < 2001; index++) {
    bytes.writeUInt32LE(index, 20);
    const id = createHash('sha256').update(bytes).digest('hex');
    inbox.add({ ...observation(), id, image: `data:image/webp;base64,${bytes.toString('base64')}` });
    refusedId = id;
  }
  expect(failed).toHaveBeenCalledWith("Couldn't save new stickers");
  await inbox.flush(); expect(store.state.stickers).toHaveLength(2000);
  expect(store.state.stickers.some(s => s.id === refusedId)).toBe(false);
  expect(inbox.issue).toBe('Sticker library is full'); expect(changed).toHaveBeenCalled();
});

test('a failed orphan unlink still publishes a successful durable Forget, then GC retries', async () => {
  const dir = directory(); seed(dir); const store = new Store(dir), id = observation().id;
  vi.spyOn(store.stickerFiles, 'remove').mockImplementationOnce(() => { throw new Error('unlink failed'); });
  expect(() => store.forgetSticker(id)).not.toThrow();
  expect(store.state.stickers.some(sticker => sticker.id === id)).toBe(false);
  expect(load(dir).forgottenStickers).toContain(id); expect(existsSync(blob(dir))).toBe(true);
  expect((await stickerResponse(store, { url: `companion-sticker://${id}`, method: 'GET' })).status).toBe(404);
  new Store(dir); expect(existsSync(blob(dir))).toBe(false);
});

test('an absent manifest preserves existing blobs during fresh-start/recovery', () => {
  const dir = directory(); seed(dir); new Store(dir);
  unlinkSync(manifest(dir)); const fresh = new Store(dir);
  expect(fresh.state.stickers).toEqual([]); expect(existsSync(blob(dir))).toBe(true);
  expect(fresh.recoveryHint).toContain('companion.v1-backup.json');
  const bytes = readFileSync(blob(dir));
  fresh.update(s => { s.global.language = 'Spanish'; });
  const restarted = new Store(dir);
  expect(restarted.state.global.language).toBe('Spanish');
  expect(restarted.recoveryHint).toContain('Restore companion.json');
  expect(readFileSync(blob(dir))).toEqual(bytes);
  writeFileSync(manifest(dir), readFileSync(join(dir, 'companion.v1-backup.json')));
  const recovered = new Store(dir);
  expect(recovered.state.stickers).toHaveLength(2); expect(recovered.recoveryHint).toBeUndefined();
  expect(existsSync(join(dir, 'sticker-recovery.json'))).toBe(false);
});

test.each(['directory'])('a nonregular existing blob (%s) cannot block valid intake or be overwritten', async damage => {
  vi.useFakeTimers();
  const dir = directory(); seed(dir); const store = new Store(dir), entry = structuredClone(store.state.stickers[0]);
  unlinkSync(blob(dir));
  if (damage === 'directory') mkdirSync(blob(dir));
  const write = vi.spyOn(store.stickerFiles, 'write'), inbox = new StickerInbox(store, vi.fn(), vi.fn());
  inbox.add({ ...observation(), lastSeen: 999 }); inbox.add(observation('different'));
  expect(await inbox.flush()).toBe(true);
  expect(store.state.stickers.find(s => s.id === entry.id)).toEqual(entry);
  expect(() => store.readSticker(entry.id)).toThrow('missing or damaged');
  expect(store.readSticker(observation('different').id).image).toBe(observation('different').image);
  const attempts = write.mock.calls.filter(([s]) => s.id === entry.id).length;
  await vi.advanceTimersByTimeAsync(60_000);
  inbox.add(observation('reencoded')); await inbox.flush();
  expect(write.mock.calls.filter(([s]) => s.id === entry.id)).toHaveLength(attempts);
  expect(vi.getTimerCount()).toBe(0); await inbox.close();
});

test.each(['hash', 'invalid', 'malformed-url', 'oversized'])('permanent invalid intake (%s) is dropped while valid stickers save', async failure => {
  vi.useFakeTimers();
  const store = new Store(directory()), bad = observation();
  if (failure === 'hash') bad.id = 'f'.repeat(64);
  if (failure === 'invalid') bad.image = 'data:image/webp;base64,aW52YWxpZA==';
  if (failure === 'malformed-url') bad.image = 'invalid';
  if (failure === 'oversized') {
    const bytes = Buffer.alloc(MAX_STICKER_BYTES + 1);
    bad.image = `data:image/webp;base64,${bytes.toString('base64')}`;
    bad.id = createHash('sha256').update(bytes).digest('hex');
  }
  const write = vi.spyOn(store.stickerFiles, 'write'), inbox = new StickerInbox(store, vi.fn(), vi.fn());
  inbox.add(bad); inbox.add(observation('different')); expect(await inbox.flush()).toBe(true);
  expect(store.state.stickers.map(s => s.id)).toEqual([observation('different').id]);
  await vi.advanceTimersByTimeAsync(60_000); await inbox.flush();
  expect(write.mock.calls.filter(([s]) => s.id === bad.id)).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0); await inbox.close();
});

test('per-item IO failures back off, retain intake after five attempts, and let unrelated discoveries save', async () => {
  vi.useFakeTimers();
  const store = new Store(directory()), bad = observation(), failed = vi.fn();
  const original = store.stickerFiles.write.bind(store.stickerFiles);
  const write = vi.spyOn(store.stickerFiles, 'write').mockImplementation(s => {
    if (s.id === bad.id) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return original(s);
  });
  const inbox = new StickerInbox(store, vi.fn(), failed);
  inbox.add(bad); inbox.add(observation('different')); expect(await inbox.flush()).toBe(false);
  expect(store.state.stickers.map(s => s.id)).toEqual([observation('different').id]);
  expect(inbox.issue).toBe("Couldn't save new stickers");
  await vi.advanceTimersByTimeAsync(999); expect(write.mock.calls.filter(([s]) => s.id === bad.id)).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); expect(write.mock.calls.filter(([s]) => s.id === bad.id)).toHaveLength(2);
  // Repeated rediscovery and new stickers cannot bypass this hash's backoff.
  inbox.add(bad); inbox.add(observation('animated'));
  await vi.advanceTimersByTimeAsync(500);
  expect(store.state.stickers.some(s => s.id === observation('animated').id)).toBe(true);
  expect(write.mock.calls.filter(([s]) => s.id === bad.id)).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(write.mock.calls.filter(([s]) => s.id === bad.id)).toHaveLength(5);
  expect(vi.getTimerCount()).toBe(0);
  inbox.add(bad); inbox.add(observation('reencoded')); await vi.advanceTimersByTimeAsync(500);
  expect(store.state.stickers.some(s => s.id === observation('reencoded').id)).toBe(true);
  expect(write.mock.calls.filter(([s]) => s.id === bad.id)).toHaveLength(5);
  expect(inbox.issue).toBe("Couldn't save new stickers");
  write.mockRestore(); expect(await inbox.flush()).toBe(true);
  expect(store.readSticker(bad.id).image).toBe(bad.image); expect(inbox.issue).toBeUndefined();
  await inbox.close(); expect(vi.getTimerCount()).toBe(0);
});

test('a manifest failure retries valid intake but still drops permanent failures', async () => {
  vi.useFakeTimers();
  const dir = directory(); seed(dir); const store = new Store(dir);
  unlinkSync(blob(dir)); mkdirSync(blob(dir));
  const write = vi.spyOn(store.stickerFiles, 'write'), update = store.update.bind(store);
  vi.spyOn(store, 'update').mockImplementationOnce(mutator => {
    mutator(structuredClone(store.state)); throw new Error('disk full');
  }).mockImplementation(update);
  const inbox = new StickerInbox(store, vi.fn(), vi.fn());
  inbox.add(observation()); inbox.add(observation('different')); expect(await inbox.flush()).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(store.readSticker(observation('different').id).image).toBe(observation('different').image);
  expect(write.mock.calls.filter(([s]) => s.id === observation().id)).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0); await inbox.close();
});

test('manifest IO failures also stop automatic retries after five attempts and retain intake', async () => {
  vi.useFakeTimers();
  const store = new Store(directory()), update = vi.spyOn(store, 'update').mockImplementation(() => { throw new Error('disk full'); });
  const inbox = new StickerInbox(store, vi.fn(), vi.fn());
  inbox.add(observation()); expect(await inbox.flush()).toBe(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(update).toHaveBeenCalledTimes(5); expect(vi.getTimerCount()).toBe(0);
  expect(inbox.issue).toBe("Couldn't save new stickers"); expect(store.state.stickers).toEqual([]);
  update.mockRestore(); expect(await inbox.flush()).toBe(true);
  expect(store.readSticker(observation().id).image).toBe(observation().image);
  await inbox.close();
});

test('an over-budget observation is dropped while a smaller sticker in the same batch fits', async () => {
  vi.useFakeTimers();
  const store = new Store(directory()), large = observation(), metadata = store.stickerFiles.write(large);
  store.update(state => {
    state.stickers = Array.from({ length: 1024 }, (_, i) => ({ ...metadata, size: MAX_STICKER_BYTES, id: i.toString(16).padStart(64, '0') }));
    state.stickers[0].size -= 20;
  });
  const bytes = Buffer.alloc(12); bytes.write('RIFF'); bytes.writeUInt32LE(4, 4); bytes.write('WEBP', 8);
  const small = { ...large, image: `data:image/webp;base64,${bytes.toString('base64')}`, id: createHash('sha256').update(bytes).digest('hex') };
  const write = vi.spyOn(store.stickerFiles, 'write'), inbox = new StickerInbox(store, vi.fn(), vi.fn());
  inbox.add(large); inbox.add(small); expect(await inbox.flush()).toBe(true);
  expect(store.state.stickers.some(s => s.id === large.id)).toBe(false);
  expect(store.readSticker(small.id).bytes).toEqual(bytes);
  expect(inbox.issue).toBe('Sticker library is full');
  await vi.advanceTimersByTimeAsync(60_000); await inbox.flush();
  expect(write).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0); await inbox.close();
});

test('migration preserves every inline entry on per-file failure and finishes after external restoration', () => {
  const dir = directory(), legacy = seed(dir), original = readFileSync(manifest(dir), 'utf8');
  mkdirSync(join(dir, 'stickers')); writeFileSync(blob(dir, legacy.stickers[1].id), 'corrupt');
  expect(() => new Store(dir)).toThrow();
  expect(readFileSync(manifest(dir), 'utf8')).toBe(original);
  expect(readFileSync(join(dir, 'companion.v1-backup.json'), 'utf8')).toBe(original);
  expect(readFileSync(blob(dir, legacy.stickers[1].id), 'utf8')).toBe('corrupt');
  expect(existsSync(blob(dir, legacy.stickers[0].id))).toBe(true);
  unlinkSync(blob(dir, legacy.stickers[1].id));
  expect(new Store(dir).state.stickers.map(s => s.id)).toEqual(legacy.stickers.map(s => s.id));
});

test('GC leaves a failed orphan for later cleanup and removes unrelated orphans without blocking startup', () => {
  const dir = directory(); seed(dir); new Store(dir);
  const first = '0'.repeat(64), second = '1'.repeat(64);
  writeFileSync(blob(dir, first), 'orphan'); writeFileSync(blob(dir, second), 'orphan');
  const store = new Store(dir, step => { if (step === `gc:${first}.webp:remove`) throw new Error('unlink failed'); });
  expect(store.state.stickers).toHaveLength(2);
  expect(existsSync(blob(dir, first))).toBe(true); expect(existsSync(blob(dir, second))).toBe(false);
  new Store(dir); expect(existsSync(blob(dir, first))).toBe(false);
});

test('Forget unlink failure cannot block forgetting another sticker', () => {
  const dir = directory(); seed(dir); const store = new Store(dir);
  vi.spyOn(store.stickerFiles, 'remove').mockImplementationOnce(() => { throw new Error('unlink failed'); });
  store.forgetSticker(observation().id); store.forgetSticker(observation('animated').id);
  expect(store.state.stickers).toEqual([]); expect(load(dir).forgottenStickers).toEqual(expect.arrayContaining([observation().id, observation('animated').id]));
  expect(existsSync(blob(dir))).toBe(true); expect(existsSync(blob(dir, observation('animated').id))).toBe(false);
  new Store(dir); expect(existsSync(blob(dir))).toBe(false);
});

test('GC directory failure preserves the valid library and damaged directory for recovery', () => {
  const dir = directory(); seed(dir); const before = new Store(dir).state.stickers;
  rmSync(join(dir, 'stickers'), { recursive: true }); writeFileSync(join(dir, 'stickers'), 'damaged directory');
  expect(new Store(dir).state.stickers).toEqual(before);
  expect(readFileSync(join(dir, 'stickers'), 'utf8')).toBe('damaged directory');
});

test('closing drains fresh observations queued behind an IO failure without spinning retries', async () => {
  vi.useFakeTimers();
  const store = new Store(directory()), bad = observation(), good = observation('different');
  const original = store.stickerFiles.write.bind(store.stickerFiles);
  const write = vi.spyOn(store.stickerFiles, 'write').mockImplementation(s => {
    if (s.id === bad.id) throw new Error('disk full');
    return original(s);
  });
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const inbox = new StickerInbox(store, vi.fn(), vi.fn(), async image => {
    if (image === bad.image) await waiting;
    return fixtures[image === bad.image ? 'original' : 'different'].pixels;
  });
  inbox.add(bad); const flushing = inbox.flush(); inbox.add(good);
  const closing = inbox.close(); release(); await flushing; await closing;
  expect(store.state.stickers.map(s => s.id)).toEqual([good.id]);
  expect(write.mock.calls.filter(([s]) => s.id === bad.id)).toHaveLength(1);
  expect(inbox.issue).toBe("Couldn't save new stickers"); expect(vi.getTimerCount()).toBe(0);
});


test('discarding failed intake clears only that item’s error; empty flush stays clear', async () => {
  const store = new Store(directory());
  vi.spyOn(store.stickerFiles, 'write').mockImplementation(() => { throw new Error('disk full'); });
  const failed = vi.fn(), inbox = new StickerInbox(store, vi.fn(), failed);
  const first = observation(), second = observation('different');
  inbox.add(first); inbox.add(second); expect(await inbox.flush()).toBe(false);
  expect(inbox.issue).toBe("Couldn't save new stickers");
  inbox.discard(first.id); expect(inbox.issue).toBe("Couldn't save new stickers");
  inbox.discard(second.id); expect(inbox.issue).toBeUndefined();
  expect(failed).toHaveBeenLastCalledWith(undefined);
  expect(await inbox.flush()).toBe(true); expect(inbox.issue).toBeUndefined();
  await inbox.close();
});

test('post-replacement manifest warning logs and retries directory sync on the next write', () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {}), steps: string[] = [];
  let fail = true;
  const store = new Store(directory(), step => { steps.push(step); if (fail && step === 'manifest:directory-sync') throw new Error('sync failed'); });
  expect(() => store.update(s => { s.global.language = 'Spanish'; })).not.toThrow();
  expect(store.state.global.language).toBe('Spanish'); expect(store.durabilityWarning).toBe(true);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('Storage durability warning'));
  fail = false; steps.length = 0;
  store.update(s => { s.global.language = 'English'; });
  expect(steps[0]).toBe('manifest:retry:directory-sync'); expect(store.durabilityWarning).toBe(false);
});


test('rediscovering all preserved blobs clears recovery advice; cleanup failure cannot fail a save', async () => {
  const dir = directory(); seed(dir); new Store(dir); unlinkSync(manifest(dir));
  let failCleanup = true;
  const store = new Store(dir, step => { if (failCleanup && step === 'recovery:clear') throw new Error('unlink failed'); });
  const inbox = new StickerInbox(store, vi.fn(), vi.fn());
  inbox.add(observation()); inbox.add(observation('animated'));
  expect(await inbox.flush()).toBe(true);
  expect(store.state.stickers).toHaveLength(2); expect(store.state).toEqual(load(dir));
  expect(store.recoveryHint).toBeUndefined(); expect(existsSync(join(dir, 'sticker-recovery.json'))).toBe(true);
  failCleanup = false; store.update(s => { s.global.language = 'Spanish'; });
  expect(store.recoveryHint).toBeUndefined(); expect(existsSync(join(dir, 'sticker-recovery.json'))).toBe(false);
  expect(new Store(dir).state.stickers).toHaveLength(2); await inbox.close();
});


test('rediscovered then forgotten hashes count toward recovery across restarts', async () => {
  const dir = directory(); seed(dir); new Store(dir); unlinkSync(manifest(dir));
  const store = new Store(dir), inbox = new StickerInbox(store, vi.fn(), vi.fn());
  inbox.add(observation()); expect(await inbox.flush()).toBe(true);
  store.forgetSticker(observation().id);
  expect(store.recoveryHint).toContain('Restore companion.json'); await inbox.close();
  const restarted = new Store(dir), recovered = new StickerInbox(restarted, vi.fn(), vi.fn());
  expect(restarted.recoveryHint).toContain('Restore companion.json');
  recovered.add(observation('animated')); expect(await recovered.flush()).toBe(true);
  expect(restarted.recoveryHint).toBeUndefined(); expect(existsSync(join(dir, 'sticker-recovery.json'))).toBe(false);
  expect(new Store(dir).recoveryHint).toBeUndefined(); await recovered.close();
});

test.each([false, true])('Forget immediately resolves the last preserved hash (cleanup failure: %s)', failCleanup => {
  const dir = directory(); seed(dir); new Store(dir); unlinkSync(manifest(dir));
  if (failCleanup) vi.spyOn(console, 'warn').mockImplementation(() => {});
  const store = new Store(dir, step => { if (failCleanup && step === 'recovery:clear') throw new Error('unlink failed'); });
  store.forgetSticker(observation().id);
  expect(store.recoveryHint).toContain('Restore companion.json');
  store.forgetSticker(observation('animated').id);
  expect(store.recoveryHint).toBeUndefined(); expect(existsSync(join(dir, 'sticker-recovery.json'))).toBe(failCleanup);
  expect(load(dir).forgottenStickers).toEqual([observation().id, observation('animated').id]);
  expect(new Store(dir).recoveryHint).toBeUndefined();
  expect(existsSync(join(dir, 'sticker-recovery.json'))).toBe(false);
});

test('recovery guard survives a successful manifest replacement with a durability warning', async () => {
  const dir = directory(); seed(dir); new Store(dir); unlinkSync(manifest(dir));
  let fail = true;
  const store = new Store(dir, step => { if (fail && step === 'manifest:directory-sync') throw new Error('sync failed'); });
  const inbox = new StickerInbox(store, vi.fn(), vi.fn());
  inbox.add(observation()); inbox.add(observation('animated'));
  expect(await inbox.flush()).toBe(true); expect(store.recoveryHint).toBeUndefined();
  expect(store.durabilityWarning).toBe(true); expect(existsSync(join(dir, 'sticker-recovery.json'))).toBe(true);
  fail = false; store.update(s => { s.global.language = 'Spanish'; });
  expect(store.durabilityWarning).toBe(false); expect(existsSync(join(dir, 'sticker-recovery.json'))).toBe(false);
  await inbox.close();
});


test('Forget recomputes a full-library hint from dropped intake after releasing capacity', async () => {
  const store = new Store(directory()), metadata = store.stickerFiles.write(observation()), failed = vi.fn();
  store.update(s => { s.stickers = Array.from({ length: MAX_LIBRARY_STICKERS }, (_, i) => ({ ...metadata, id: i.toString(16).padStart(64, '0') })); });
  const inbox = new StickerInbox(store, vi.fn(), failed);
  inbox.add(observation('different')); expect(await inbox.flush()).toBe(true);
  expect(inbox.issue).toBe('Sticker library is full');
  const id = store.state.stickers[0].id; store.forgetSticker(id); inbox.discard(id);
  expect(inbox.issue).toBeUndefined(); expect(failed).toHaveBeenLastCalledWith(undefined);
  await inbox.close();
});

function legacyInitialState() { const { stickerGroups: _groups, ...state } = initialState(); return state; }

test('async byte reads coalesce and reuse verification without base64 or synchronous reads', async () => {
  const dir = directory(); seed(dir); const store = new Store(dir), id = observation().id;
  const verify = vi.spyOn(stickerBytes, 'verifyStickerBytes'), sync = vi.spyOn(store.stickerFiles, 'read');
  const reads = await Promise.all(Array.from({ length: 8 }, () => store.readStickerBytes(id)));
  expect(verify).toHaveBeenCalledTimes(1); expect(sync).not.toHaveBeenCalled();
  expect(reads.every(read => read === reads[0])).toBe(true); expect(reads[0]).not.toHaveProperty('image');
  expect(await store.readStickerBytes(id)).toBe(reads[0]); expect(verify).toHaveBeenCalledTimes(1);
  // Sending remains authoritative even after a display cache hit.
  expect(store.readSticker(id).image).toBe(observation().image); expect(verify).toHaveBeenCalledTimes(2);
});

test('verified byte cache has a byte-budget LRU and oversized entries are not retained', async () => {
  const dir = directory(), files = new StickerFiles(dir, undefined, 48);
  function tiny(index: number) {
    const bytes = Buffer.alloc(24); bytes.write('RIFF'); bytes.writeUInt32LE(16, 4); bytes.write('WEBP', 8);
    bytes.write('TEST', 12); bytes.writeUInt32LE(4, 16); bytes.writeUInt32LE(index, 20);
    return { ...observation(), id: createHash('sha256').update(bytes).digest('hex'), image: `data:image/webp;base64,${bytes.toString('base64')}` };
  }
  const entries = [tiny(1), tiny(2), tiny(3)]; entries.forEach(entry => files.write(entry));
  const verify = vi.spyOn(stickerBytes, 'verifyStickerBytes');
  const first = await files.readBytes(entries[0].id); await files.readBytes(entries[1].id); await files.readBytes(entries[0].id);
  await files.readBytes(entries[2].id); expect(await files.readBytes(entries[0].id)).toBe(first);
  expect(verify).toHaveBeenCalledTimes(3); await files.readBytes(entries[1].id); expect(verify).toHaveBeenCalledTimes(4);
  const tooSmall = new StickerFiles(dir, undefined, 23); verify.mockClear();
  await tooSmall.readBytes(entries[0].id); await tooSmall.readBytes(entries[0].id); expect(verify).toHaveBeenCalledTimes(2);
});

test.each(['missing', 'corrupt', 'symlink'])('cached display detects later %s damage and restoration retries successfully', async failure => {
  const dir = directory(); seed(dir); const store = new Store(dir), entry = observation();
  expect((await stickerResponse(store, { url: `companion-sticker://${entry.id}`, method: 'GET' })).status).toBe(200);
  const original = readFileSync(blob(dir));
  if (failure === 'corrupt') { const changed = Buffer.from(original); changed[changed.length - 1] ^= 1; writeFileSync(blob(dir), changed); }
  else { unlinkSync(blob(dir)); if (failure === 'symlink') symlinkSync(blob(dir, observation('animated').id), blob(dir)); }
  expect((await stickerResponse(store, { url: `companion-sticker://${entry.id}`, method: 'GET' })).status).toBe(404);
  if (failure === 'symlink') unlinkSync(blob(dir));
  writeFileSync(blob(dir), original);
  expect((await stickerResponse(store, { url: `companion-sticker://${entry.id}`, method: 'GET' })).status).toBe(200);
});

test('cached display detects same-size corruption even when filesystem timestamps collide', async () => {
  const dir = directory(); seed(dir); const store = new Store(dir), entry = observation();
  const original = readFileSync(blob(dir)), timestamps = statSync(blob(dir), { bigint: true });
  const open = fsPromises.open;
  // Older kernels can give successive tmpfs writes identical mtime/ctime.
  // Keep real file handles and bytes, but make that collision deterministic.
  vi.spyOn(fsPromises, 'open').mockImplementation(async (path, flags, mode) => {
    const handle = await open(path, flags, mode), stat = handle.stat.bind(handle);
    vi.spyOn(handle, 'stat').mockImplementation(async (...args: Parameters<typeof handle.stat>) => {
      const actual = await stat(...args);
      return Object.assign(actual, { mtimeNs: timestamps.mtimeNs, ctimeNs: timestamps.ctimeNs });
    });
    return handle;
  });
  const request = () => stickerResponse(store, { url: `companion-sticker://${entry.id}`, method: 'GET' });
  expect((await request()).status).toBe(200);
  const changed = Buffer.from(original); changed[changed.length - 1] ^= 1;
  writeFileSync(blob(dir), changed);
  expect((await request()).status).toBe(404);
  writeFileSync(blob(dir), original);
  expect((await request()).status).toBe(200);
});

test('identical rediscovery retains cached bytes; actual repair replaces them', async () => {
  const dir = directory(); seed(dir); const store = new Store(dir), entry = observation();
  const first = await store.readStickerBytes(entry.id);
  store.stickerFiles.write(entry, true);
  expect(await store.readStickerBytes(entry.id)).toBe(first);
  writeFileSync(blob(dir), 'damaged'); store.stickerFiles.write(entry, true);
  expect(await store.readStickerBytes(entry.id)).not.toBe(first);
  const pending = store.readStickerBytes(entry.id), rejected = expect(pending).rejects.toThrow();
  store.forgetSticker(entry.id); await rejected;
  expect((await stickerResponse(store, { url: `companion-sticker://${entry.id}`, method: 'GET' })).status).toBe(404);
});

// Hold a real handle at an explicit async boundary, so writes/removals race
// against both an opened inode and shared verification work deterministically.
function pauseStickerRead(at: 'open' | 'read' | 'close' = 'open') {
  let release!: () => void, reached!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const paused = new Promise<void>(resolve => { reached = resolve; });
  const open = fsPromises.open;
  vi.spyOn(fsPromises, 'open').mockImplementationOnce(async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    if (at === 'open') { reached(); await waiting; }
    else if (at === 'read') {
      const read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementationOnce(async (...args: Parameters<typeof handle.read>) => {
        const result = await read(...args); reached(); await waiting; return result;
      });
    } else {
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => { await close(); reached(); await waiting; });
    }
    return handle;
  });
  return { paused, release };
}

test.each(['write', 'rediscovery', 'GC', 'migration', 'recovery'] as const)('%s preserves cached and shared in-flight reads of healthy blobs', async source => {
  const dir = directory(); seed(dir); const store = new Store(dir), entry = observation();
  const warm = await store.readStickerBytes(entry.id);
  const change = async () => {
    if (source === 'write') store.stickerFiles.write(entry, true);
    else if (source === 'GC') {
      // Removing an interrupted temp for the same hash must not cancel reads.
      writeFileSync(`${blob(dir)}.tmp`, 'partial');
      store.stickerFiles.gc(store.state.stickers.map(s => s.id));
    } else if (source === 'migration') {
      seed(dir); expect(new Store(dir).state.version).toBe(2);
    } else if (source === 'recovery') {
      unlinkSync(manifest(dir)); const recovered = new Store(dir);
      expect(recovered.recoveryHint).toContain('preserved');
      recovered.update(state => { state.stickers = store.state.stickers; });
      expect(recovered.recoveryHint).toBeUndefined();
    } else {
      const inbox = new StickerInbox(store, vi.fn(), vi.fn());
      inbox.add({ ...entry, lastSeen: 789 }); expect(await inbox.flush()).toBe(true); await inbox.close();
    }
  };
  const cachedGate = pauseStickerRead(), cached = store.readStickerBytes(entry.id);
  await cachedGate.paused; await change(); cachedGate.release();
  expect(await cached).toBe(warm); expect(await store.readStickerBytes(entry.id)).toBe(warm);
  // A separate cache starts cold; pause after shared verification is registered.
  const files = new StickerFiles(dir), gate = pauseStickerRead('read');
  const first = files.readBytes(entry.id); await gate.paused;
  const second = files.readBytes(entry.id);
  if (source === 'GC') files.gc(store.state.stickers.map(s => s.id));
  else if (source === 'write') files.write(entry, true);
  else await change();
  const verify = vi.spyOn(stickerBytes, 'verifyStickerBytes'); verify.mockClear();
  gate.release(); const reads = await Promise.all([first, second]);
  expect(reads[0]).toBe(reads[1]); expect(await files.readBytes(entry.id)).toBe(reads[0]);
  expect(verify).toHaveBeenCalledTimes(1);
});

test.each(['open', 'read', 'close'] as const)('display retries a real repair during %s, including coalesced readers', async at => {
  const dir = directory(); seed(dir); const store = new Store(dir), entry = observation();
  const gate = pauseStickerRead(at);
  const response = stickerResponse(store, { url: `companion-sticker://${entry.id}`, method: 'GET' });
  await gate.paused;
  const second = store.readStickerBytes(entry.id);
  writeFileSync(blob(dir), 'damaged'); store.stickerFiles.write(entry, true);
  gate.release();
  const result = await response;
  expect(result.status).toBe(200);
  expect(Buffer.from(await result.arrayBuffer())).toEqual(Buffer.from(entry.image.split(',')[1], 'base64'));
  expect((await second).bytes).toEqual(store.readSticker(entry.id).bytes);
});

test.each(['missing', 'corrupt', 'symlink'] as const)('an opened %s blob retries after repair instead of reporting damage', async damage => {
  const dir = directory(); seed(dir); const store = new Store(dir), entry = observation();
  if (damage === 'missing') unlinkSync(blob(dir));
  else if (damage === 'corrupt') writeFileSync(blob(dir), 'damaged');
  else { unlinkSync(blob(dir)); symlinkSync(blob(dir, observation('animated').id), blob(dir)); }
  // Pause before open as missing/symlink files cannot produce a handle.
  const lstat = fsPromises.lstat;
  let release!: () => void, reached!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }), paused = new Promise<void>(resolve => { reached = resolve; });
  vi.spyOn(fsPromises, 'lstat').mockImplementationOnce(async (...args: Parameters<typeof fsPromises.lstat>) => {
    const stat = await lstat(...args); reached(); await waiting; return stat;
  });
  const response = stickerResponse(store, { url: `companion-sticker://${entry.id}`, method: 'GET' });
  await paused; store.stickerFiles.write(entry, true); release();
  expect((await response).status).toBe(200);
});

test.each(['Forget', 'remove', 'GC'] as const)('%s terminates only affected reads even if the blob is restored', async source => {
  const dir = directory(); seed(dir); const store = new Store(dir), entry = observation(), other = observation('animated');
  const retained = await store.readStickerBytes(other.id);
  const gate = pauseStickerRead('close'), pending = store.stickerFiles.readBytes(entry.id);
  const rejected = expect(pending).rejects.toThrow();
  await gate.paused;
  if (source === 'Forget') store.forgetSticker(entry.id);
  else if (source === 'remove') store.stickerFiles.remove(entry.id);
  else store.stickerFiles.gc([other.id]);
  store.stickerFiles.write(entry, true); gate.release(); await rejected;
  expect(await store.readStickerBytes(other.id)).toBe(retained);
  if (source === 'Forget') {
    expect((await stickerResponse(store, { url: `companion-sticker://${entry.id}`, method: 'GET' })).status).toBe(404);
    expect(() => store.readSticker(entry.id)).toThrow('no longer indexed');
  }
});

test.each(['hash', 'all'] as const)('non-removal %s invalidation retries once and repeated invalidation remains an error', async scope => {
  const dir = directory(); seed(dir); const store = new Store(dir), id = observation().id;
  const open = fsPromises.open;
  const attempts = vi.spyOn(fsPromises, 'open').mockImplementation(async (path, flags, mode) => {
    const handle = await open(path, flags, mode); store.stickerFiles.invalidate(scope === 'hash' ? id : undefined); return handle;
  });
  await expect(store.readStickerBytes(id)).rejects.toThrow('missing or damaged');
  expect(attempts).toHaveBeenCalledTimes(2);
  attempts.mockRestore(); expect((await store.readStickerBytes(id)).bytes).toEqual(store.readSticker(id).bytes);
});

test('Forget rejects pending display reads while retaining the blob after a durability warning', async () => {
  const dir = directory(); seed(dir); const entry = observation();
  let fail = false;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const store = new Store(dir, step => { if (fail && step === 'manifest:directory-sync') throw new Error('sync failed'); });
  const gate = pauseStickerRead(), pending = stickerResponse(store, { url: `companion-sticker://${entry.id}`, method: 'GET' });
  await gate.paused; fail = true; store.forgetSticker(entry.id); gate.release();
  expect((await pending).status).toBe(404); expect(existsSync(blob(dir))).toBe(true);
  expect(() => store.readSticker(entry.id)).toThrow('no longer indexed');
});

test.each(['rediscovery', 'repair', 'Forget', 'GC', 'migration', 'recovery'] as const)('authoritative sendable reads remain verified after %s', async source => {
  const dir = directory(); seed(dir); const store = new Store(dir), entry = observation();
  await store.readStickerBytes(entry.id); // Display cache must not bypass sending verification.
  if (source === 'rediscovery') store.stickerFiles.write(entry, true);
  else if (source === 'repair') { writeFileSync(blob(dir), 'damaged'); store.stickerFiles.write(entry, true); }
  else if (source === 'Forget') store.forgetSticker(entry.id);
  else if (source === 'GC') store.stickerFiles.gc([observation('animated').id]);
  else if (source === 'migration') { seed(dir); new Store(dir); }
  else { unlinkSync(manifest(dir)); new Store(dir); }
  const verify = vi.spyOn(stickerBytes, 'verifyStickerBytes');
  if (source === 'Forget' || source === 'GC') expect(() => store.readSticker(entry.id)).toThrow();
  else {
    expect(store.readSticker(entry.id).image).toBe(entry.image); expect(verify).toHaveBeenCalledTimes(1);
    writeFileSync(blob(dir), 'damaged'); expect(() => store.readSticker(entry.id)).toThrow('missing or damaged');
  }
});

test('identical writes that restore permissions retry signature changes without discarding healthy content', async () => {
  const dir = directory(); seed(dir); const store = new Store(dir), entry = observation();
  chmodSync(blob(dir), 0o644);
  const gate = pauseStickerRead('read'), pending = store.readStickerBytes(entry.id);
  await gate.paused; store.stickerFiles.write(entry); gate.release();
  expect((await pending).bytes).toEqual(store.readSticker(entry.id).bytes);
  expect(statSync(blob(dir)).mode & 0o777).toBe(0o600);
});

test('rejected incoming bytes and failed GC leave healthy cached and in-flight reads intact', async () => {
  const dir = directory(); seed(dir); new Store(dir); const entry = observation();
  const files = new StickerFiles(dir, step => { if (step.startsWith('gc:')) throw new Error('cleanup failed'); });
  const warm = await files.readBytes(entry.id), gate = pauseStickerRead(), pending = files.readBytes(entry.id);
  await gate.paused;
  expect(() => files.write({ ...entry, image: observation('different').image }, true)).toThrow();
  files.gc([]); gate.release();
  expect(await pending).toBe(warm); expect(await files.readBytes(entry.id)).toBe(warm);
});

test('an unsuccessful repair does not invalidate bytes that were never replaced', async () => {
  const dir = directory(); seed(dir); new Store(dir); const entry = observation();
  writeFileSync(blob(dir), 'damaged');
  const files = new StickerFiles(dir, step => { if (step.endsWith(':replace')) throw new Error('replacement failed'); });
  const invalidate = vi.spyOn(files, 'invalidate');
  expect(() => files.write(entry, true)).toThrow('replacement failed');
  expect(invalidate).not.toHaveBeenCalled();
  await expect(files.readBytes(entry.id)).rejects.toThrow();
});

test('async display rejects metadata mismatches, oversized files and directory symlinks', async () => {
  const dir = directory(); seed(dir); const store = new Store(dir), id = observation().id;
  store.update(s => { s.stickers[0].size++; }); await expect(store.readStickerBytes(id)).rejects.toThrow('missing or damaged');
  store.update(s => { s.stickers[0].size--; });
  writeFileSync(blob(dir), Buffer.alloc(MAX_STICKER_BYTES + 1)); await expect(store.readStickerBytes(id)).rejects.toThrow('missing or damaged');
  const other = directory(); mkdirSync(join(other, 'blobs'));
  rmSync(join(dir, 'stickers'), { recursive: true }); symlinkSync(join(other, 'blobs'), join(dir, 'stickers'));
  await expect(store.readStickerBytes(id)).rejects.toThrow('missing or damaged');
});

test('no-op updates preserve state identity and avoid writes', () => {
  const steps: string[] = [], store = new Store(directory(), step => steps.push(step));
  const before = store.state; steps.length = 0;
  store.update(s => { s.provider = 'openai'; }); expect(store.state).toBe(before); expect(steps).toEqual([]);
  store.update(s => { s.provider = 'anthropic'; }); expect(store.state).not.toBe(before); expect(steps).toContain('manifest:write');
  steps.length = 0; const saved = store.state;
  store.update(s => { s.provider = 'anthropic'; }); expect(store.state).toBe(saved); expect(steps).toEqual([]);
});


test('no-op saves still retry outstanding directory durability warnings', () => {
  let fail = true; const steps: string[] = [];
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const store = new Store(directory(), step => { steps.push(step); if (fail && step === 'manifest:directory-sync') throw new Error('sync unavailable'); });
  store.update(s => { s.provider = 'anthropic'; }); expect(store.durabilityWarning).toBe(true);
  const state = store.state; fail = false; steps.length = 0;
  store.update(s => { s.provider = 'anthropic'; });
  expect(store.state).toBe(state); expect(store.durabilityWarning).toBe(false);
  expect(steps).toContain('manifest:retry:directory-sync'); expect(steps).not.toContain('manifest:write'); warning.mockRestore();
});


test('deferred startup GC leaves durable migration intact and uses references at collection time', () => {
  const dir = directory(), legacy = seed(dir), timing = vi.fn();
  const gc = vi.spyOn(StickerFiles.prototype, 'gc');
  const store = new Store(dir, undefined, { deferGC: true, timing });
  expect(gc).not.toHaveBeenCalled();
  expect(load(dir).version).toBe(2);
  expect(JSON.parse(readFileSync(join(dir, 'companion.v1-backup.json'), 'utf8'))).toEqual(legacy);
  for (const entry of legacy.stickers) expect(store.readSticker(entry.id).image).toBe(entry.image);
  expect(timing).toHaveBeenCalledWith('migration', expect.any(Number));
  const later = observation('reencoded');
  const metadata = store.stickerFiles.write(later);
  store.update(state => { state.stickers.push({ ...metadata, searchTerms: later.searchTerms, firstSeen: later.firstSeen, lastSeen: later.lastSeen }); });
  store.collectGarbage(timing);
  expect(gc).toHaveBeenCalledTimes(1);
  expect(store.readSticker(later.id).image).toBe(later.image);
  expect(timing).toHaveBeenCalledWith('gc', expect.any(Number));
});
test('deferred GC never deletes preserved files after a missing manifest', () => {
  const dir = directory(); seed(dir); new Store(dir);
  unlinkSync(manifest(dir));
  const recovered = new Store(dir, undefined, { deferGC: true });
  recovered.collectGarbage();
  expect(existsSync(blob(dir))).toBe(true);
  expect(existsSync(blob(dir, observation('animated').id))).toBe(true);
});


test.each(['single', 'bulk'] as const)('Forget %s before deferred GC preserves crash-restorable bytes while directory sync fails', mode => {
  const dir = directory(); seed(dir); new Store(dir);
  const previousManifest = readFileSync(manifest(dir), 'utf8');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const store = new Store(dir, step => { if (step.includes('directory-sync') && step.startsWith('manifest')) throw new Error('sync failed'); }, { deferGC: true });
  const gc = vi.spyOn(store.stickerFiles, 'gc');
  const ids = mode === 'single' ? [observation().id] : [observation().id, observation('animated').id];
  if (mode === 'single') store.forgetSticker(ids[0]); else store.forgetStickers(ids);
  expect(store.durabilityWarning).toBe(true);
  expect(store.state.forgottenStickers).toEqual(expect.arrayContaining(ids));
  store.collectGarbage();
  expect(gc).not.toHaveBeenCalled();
  for (const id of ids) expect(existsSync(blob(dir, id))).toBe(true);
  // Simulate a crash losing the unsynced manifest replacement, then reload
  // the prior durable reference set and perform ordinary startup collection.
  writeFileSync(manifest(dir), previousManifest);
  const restarted = new Store(dir);
  for (const entry of [observation(), observation('animated')]) expect(restarted.readSticker(entry.id).image).toBe(entry.image);
});
test('deferred GC resumes only after a later write confirms manifest durability', () => {
  const dir = directory(); seed(dir); new Store(dir);
  let fail = true;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const store = new Store(dir, step => { if (fail && step.startsWith('manifest') && step.includes('directory-sync')) throw new Error('sync failed'); }, { deferGC: true });
  store.forgetSticker(observation().id); store.collectGarbage();
  expect(existsSync(blob(dir))).toBe(true);
  fail = false; store.update(() => {});
  expect(store.durabilityWarning).toBe(false);
  store.collectGarbage();
  expect(existsSync(blob(dir))).toBe(false);
  expect(store.readSticker(observation('animated').id).image).toBe(observation('animated').image);
});
test.each(['backup', 'manifest', 'recovery'] as const)('startup GC skips collection with an outstanding %s durability warning and keeps recovery anchors', prefix => {
  const dir = directory(), legacy = seed(dir);
  const ids = legacy.stickers.map(sticker => sticker.id);
  const recoveryPath = join(dir, 'sticker-recovery.json');
  writeFileSync(recoveryPath, JSON.stringify(ids));
  let fail = true;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const gc = vi.spyOn(StickerFiles.prototype, 'gc');
  const store = new Store(dir, step => { if (fail && step === `${prefix}:directory-sync`) throw new Error('sync failed'); });
  expect(store.durabilityWarning).toBe(true);
  expect(gc).not.toHaveBeenCalled();
  // A manifest/backup warning must also prevent recovery record cleanup;
  // recovery cleanup sync can itself fail after unlinking the resolved record.
  expect(existsSync(recoveryPath)).toBe(prefix !== 'recovery');
  for (const entry of legacy.stickers) expect(store.readSticker(entry.id).image).toBe(entry.image);
  fail = false; store.update(() => {}); store.collectGarbage();
  expect(store.durabilityWarning).toBe(false);
  expect(gc).toHaveBeenCalledTimes(1);
  expect(existsSync(recoveryPath)).toBe(false);
});
