import { afterEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, legacyStateSchema, stateSchema, stickerSchema, type DiscoveredSticker } from '../src/shared/model';
import { Store } from '../src/main/store';
import { stickerResponse } from '../src/main/sticker-protocol';
import { StickerInbox } from '../src/main/sticker-inbox';
import { upsertSticker } from '../src/core/stickers';
import { MAX_LIBRARY_BYTES, MAX_LIBRARY_STICKERS, MAX_STICKER_BYTES } from '../src/shared/sticker-limits';

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
test.each(['missing', 'corrupt', 'symlink'])('missing/damaged blobs (%s) retain metadata and fail closed', failure => {
  const dir = directory(); seed(dir); const store = new Store(dir), entry = structuredClone(store.state.stickers[0]);
  unlinkSync(blob(dir));
  if (failure === 'corrupt') writeFileSync(blob(dir), 'corrupt');
  if (failure === 'symlink') symlinkSync(blob(dir, observation('animated').id), blob(dir));
  expect(() => store.readSticker(entry.id)).toThrow('Restore the file from a backup, or let the app rediscover the sticker.');
  const response = stickerResponse(store, { url: `companion-sticker://${entry.id}`, method: 'GET' });
  expect(response.status).toBe(404); expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(new Store(dir).state.stickers[0]).toEqual(entry);
});
test('protocol serves only canonical current references with re-verified WebP bytes', async () => {
  const dir = directory(); seed(dir); const store = new Store(dir), id = observation().id;
  const response = stickerResponse(store, { url: `companion-sticker://${id}`, method: 'GET' });
  expect(response.headers.get('Content-Type')).toBe('image/webp'); expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(blob(dir)));
  for (const url of [`companion-sticker://${id}/..`, `companion-sticker://${id}?x`, `companion-sticker://${id}/foo`, `companion-sticker://user@${id}`, `companion-sticker://${id.toUpperCase()}`, 'companion-sticker://../companion.json', `companion-sticker://${'e'.repeat(64)}`]) expect(stickerResponse(store, { url, method: 'GET' }).status).toBe(404);
  expect(stickerResponse(store, { url: `companion-sticker://${id}`, method: 'POST' }).status).toBe(404);
  store.forgetSticker(id); expect(stickerResponse(store, { url: `companion-sticker://${id}`, method: 'GET' }).status).toBe(404);
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

test('a failed orphan unlink still publishes a successful durable Forget, then GC retries', () => {
  const dir = directory(); seed(dir); const store = new Store(dir), id = observation().id;
  vi.spyOn(store.stickerFiles, 'remove').mockImplementationOnce(() => { throw new Error('unlink failed'); });
  expect(() => store.forgetSticker(id)).not.toThrow();
  expect(store.state.stickers.some(sticker => sticker.id === id)).toBe(false);
  expect(load(dir).forgottenStickers).toContain(id); expect(existsSync(blob(dir))).toBe(true);
  expect(stickerResponse(store, { url: `companion-sticker://${id}`, method: 'GET' }).status).toBe(404);
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
