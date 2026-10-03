import { afterEach, describe, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetSticker } from '../src/core/stickers';
import { initialState, stateSchema, stickerSchema, type DiscoveredSticker } from '../src/shared/model';
import { Store } from '../src/main/store';
import { StickerInbox } from '../src/main/sticker-inbox';
import { decodeStickerPixels, fingerprintSticker, nearSticker } from '../src/main/sticker-fingerprint';
import { statusUpdate } from '../src/core/status';
import type { Status } from '../src/shared/model';

const fixtures: Record<string, { image: string; pixels: string }> = JSON.parse(readFileSync(new URL('./fixtures/sticker-dedupe/images.json', import.meta.url), 'utf8'));
const sticker = (name: string, searchTerms = ''): DiscoveredSticker => {
  const image = fixtures[name].image;
  return { image, id: createHash('sha256').update(Buffer.from(image.split(',')[1], 'base64')).digest('hex'), searchTerms, firstSeen: 1, lastSeen: 1 };
};
// Independent Pillow-decoded first-frame thumbnails, generated alongside the
// encoded fixtures. Actual Chromium canvas decoding is covered by desktop tests.
const decode = vi.fn(async (image: string) => Object.values(fixtures).find(value => value.image === image)!.pixels);
const directories: string[] = [];
function store() { const dir = mkdtempSync(join(tmpdir(), 'sticker-dedupe-')); directories.push(dir); return new Store(dir); }
afterEach(() => { directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); decode.mockClear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('forgotten stickers', () => {
  test('ignores a forgotten hash on later observation and after restart, preserving the original of a duplicate', async () => {
    const saved = store(), original = sticker('original', 'tagged original'), duplicate = sticker('reencoded');
    saved.update(state => { state.stickers.push(saved.stickerFiles.write(original), saved.stickerFiles.write(duplicate)); });
    const inbox = new StickerInbox(saved, vi.fn(), vi.fn(), decode);
    inbox.add(duplicate);
    saved.update(state => forgetSticker(state, duplicate.id)); inbox.discard(duplicate.id);
    inbox.add(duplicate); expect(await inbox.flush()).toBe(true);
    expect(saved.state.stickers).toEqual([saved.stickerFiles.write(original)]); expect(decode).not.toHaveBeenCalled();
    const restored = new Store(directories.at(-1)!);
    const next = new StickerInbox(restored, vi.fn(), vi.fn(), decode);
    next.add(duplicate); expect(await next.flush()).toBe(true);
    expect(restored.state.stickers).toEqual([saved.stickerFiles.write(original)]); expect(restored.state.forgottenStickers).toEqual([duplicate.id]);
  });
  test('bounds unique forgotten hashes at 5000, dropping oldest and renewing a repeated hash', () => {
    const state = initialState();
    state.forgottenStickers = Array.from({ length: 5000 }, (_, i) => i.toString(16).padStart(64, '0'));
    forgetSticker(state, '0'.repeat(64));
    const next = 'f'.repeat(64); forgetSticker(state, next);
    expect(state.forgottenStickers).toHaveLength(5000);
    expect(state.forgottenStickers).not.toContain('1'.padStart(64, '0'));
    expect(state.forgottenStickers.slice(-2)).toEqual(['0'.repeat(64), next]);
    expect(stateSchema.safeParse(state).success).toBe(true);
  });
  test('does not reinsert an observation forgotten while its thumbnail is decoding', async () => {
    const saved = store(), incoming = sticker('original');
    let release!: (pixels: string) => void;
    const inbox = new StickerInbox(saved, vi.fn(), vi.fn(), () => new Promise(resolve => { release = resolve; }));
    inbox.add(incoming); const flushing = inbox.flush();
    saved.update(state => forgetSticker(state, incoming.id)); inbox.discard(incoming.id);
    release(fixtures.original.pixels); await flushing;
    expect(saved.state.stickers).toHaveLength(0);
  });
});

describe('perceptual sticker intake', () => {
  test.each(['missing', 'corrupt', 'metadata'])('retains a healthy re-encoding when a matching fingerprint belongs to a %s blob', async damage => {
    const saved = store(), original = sticker('original', 'keep tags'), incoming = sticker('reencoded');
    const fingerprint = await fingerprintSticker(original, decode);
    saved.update(state => { state.stickers.push({ ...saved.stickerFiles.write(original), fingerprint }); });
    const path = join(directories.at(-1)!, 'stickers', `${original.id}.webp`);
    if (damage === 'missing') unlinkSync(path);
    else if (damage === 'corrupt') writeFileSync(path, 'corrupt');
    else saved.update(state => { state.stickers[0].size += 1; });
    const before = structuredClone(saved.state.stickers[0]);
    const inbox = new StickerInbox(saved, vi.fn(), vi.fn(), decode); inbox.add(incoming);
    expect(await inbox.flush()).toBe(true);
    expect(saved.state.stickers.map(s => s.id)).toEqual([original.id, incoming.id]);
    expect(saved.state.stickers[0]).toEqual(before);
    expect(saved.readSticker(incoming.id).image).toBe(incoming.image);
    expect(new Store(directories.at(-1)!).state.stickers).toEqual(saved.state.stickers); await inbox.close();
  });
  test.each(['missing', 'short', 'hash', 'symlink', 'metadata'])('healthy exact-hash rediscovery repairs a %s blob and preserves tags', async damage => {
    const saved = store(), original = sticker('original', 'keep tags');
    saved.update(state => { state.stickers.push(saved.stickerFiles.write(original)); });
    const path = join(directories.at(-1)!, 'stickers', `${original.id}.webp`);
    if (damage === 'missing') unlinkSync(path);
    else if (damage === 'short') writeFileSync(path, 'corrupt');
    else if (damage === 'hash') writeFileSync(path, Buffer.from(sticker('different').image.split(',')[1], 'base64'));
    else if (damage === 'symlink') {
      const target = join(directories.at(-1)!, 'do-not-change'); writeFileSync(target, 'keep target');
      unlinkSync(path); symlinkSync(target, path);
    }
    else saved.update(state => { state.stickers[0].size += 1; });
    const inbox = new StickerInbox(saved, vi.fn(), vi.fn(), decode);
    inbox.add({ ...original, searchTerms: '', lastSeen: 999 }); expect(await inbox.flush()).toBe(true);
    expect(saved.state.stickers).toHaveLength(1);
    expect(saved.state.stickers[0]).toMatchObject({ id: original.id, searchTerms: 'keep tags', lastSeen: 999 });
    expect(saved.readSticker(original.id).image).toBe(original.image);
    if (damage === 'symlink') expect(readFileSync(join(directories.at(-1)!, 'do-not-change'), 'utf8')).toBe('keep target');
    expect(new Store(directories.at(-1)!).readSticker(original.id).image).toBe(original.image); await inbox.close();
  });
  test('checks cached fingerprints again if a blob is damaged after a successful suppression', async () => {
    const saved = store(), original = sticker('original'), incoming = sticker('reencoded');
    saved.update(state => { state.stickers.push(saved.stickerFiles.write(original)); });
    const inbox = new StickerInbox(saved, vi.fn(), vi.fn(), decode); inbox.add(incoming); await inbox.flush();
    expect(saved.state.stickers).toHaveLength(1);
    writeFileSync(join(directories.at(-1)!, 'stickers', `${original.id}.webp`), 'corrupt');
    inbox.add(incoming); expect(await inbox.flush()).toBe(true);
    expect(saved.readSticker(incoming.id).image).toBe(incoming.image); expect(saved.state.stickers).toHaveLength(2); await inbox.close();
  });
  test('continues past a damaged match to suppress against a healthy matching blob', async () => {
    const saved = store(), damaged = sticker('animated'), healthy = sticker('original'), incoming = sticker('reencoded');
    saved.update(state => { state.stickers.push(saved.stickerFiles.write(damaged), saved.stickerFiles.write(healthy)); });
    const inbox = new StickerInbox(saved, vi.fn(), vi.fn(), decode); inbox.add(incoming); await inbox.flush();
    writeFileSync(join(directories.at(-1)!, 'stickers', `${damaged.id}.webp`), 'corrupt');
    inbox.add({ ...incoming, lastSeen: 999 }); await inbox.flush();
    expect(saved.state.stickers).toHaveLength(2); expect(saved.state.stickers[1].lastSeen).toBe(999); await inbox.close();
  });
  test('suppresses a re-encoded picture, preserves tags, migrates legacy fingerprints and persists them', async () => {
    const saved = store(), original = sticker('original', 'cat, gato'), copy = sticker('reencoded');
    expect(copy.id).not.toBe(original.id);
    saved.update(state => { state.stickers.push(saved.stickerFiles.write(original)); });
    expect(saved.state.stickers[0].fingerprint).toBeUndefined(); expect(decode).not.toHaveBeenCalled();
    const inbox = new StickerInbox(saved, vi.fn(), vi.fn(), decode);
    inbox.add({ ...copy, lastSeen: 20 }); expect(await inbox.flush()).toBe(true);
    expect(saved.state.stickers).toHaveLength(1);
    expect(saved.state.stickers[0]).toMatchObject({ id: original.id, searchTerms: 'cat, gato', lastSeen: 20, fingerprint: { animated: false, version: 1 } });
    expect(new Store(directories.at(-1)!).state.stickers).toEqual(saved.state.stickers);
    decode.mockClear();
    inbox.add(copy); await inbox.flush();
    expect(decode).toHaveBeenCalledTimes(1); // Only the new encoding, never the migrated original.
  });
  test('fingerprint backfill skips a corrupt candidate and still backfills healthy candidates and saves intake', async () => {
    const saved = store(), damaged = sticker('original'), healthy = sticker('animated'), incoming = sticker('different');
    saved.update(state => { state.stickers.push(saved.stickerFiles.write(damaged), saved.stickerFiles.write(healthy)); });
    writeFileSync(join(directories.at(-1)!, 'stickers', `${damaged.id}.webp`), 'corrupt');
    const before = structuredClone(saved.state.stickers[0]);
    const inbox = new StickerInbox(saved, vi.fn(), vi.fn(), decode);
    inbox.add(incoming); expect(await inbox.flush()).toBe(true);
    expect(saved.state.stickers[0]).toEqual(before);
    expect(saved.state.stickers.find(s => s.id === healthy.id)?.fingerprint).toBeDefined();
    expect(saved.state.stickers.find(s => s.id === incoming.id)?.fingerprint).toBeDefined();
    expect(() => saved.readSticker(damaged.id)).toThrow('missing or damaged');
    await inbox.close();
  });
  test('compares additions in the same batch, keeps different content and never suppresses animation with a static', async () => {
    const saved = store(), inbox = new StickerInbox(saved, vi.fn(), vi.fn(), decode);
    for (const name of ['original', 'reencoded', 'different', 'animated']) inbox.add(sticker(name));
    await inbox.flush();
    expect(saved.state.stickers.map(s => s.id)).toEqual(['original', 'different', 'animated'].map(name => sticker(name).id));
    expect(saved.state.stickers.at(-1)!.fingerprint!.animated).toBe(true);
    const animation = await fingerprintSticker(sticker('animated'), decode);
    const still = await fingerprintSticker(sticker('original'), decode);
    expect(nearSticker(animation, { ...animation, animated: false })).toBe(false);
    expect(nearSticker(still, { ...animation, animated: false })).toBe(true);
    expect(nearSticker(still, animation)).toBe(true);
  });
  test.each([false, true])('suppresses flattened static copies of an animated first frame (same batch: %s)', async sameBatch => {
    const saved = store(), original = sticker('animated', 'animated original');
    if (!sameBatch) saved.update(state => { state.stickers.push(saved.stickerFiles.write(original)); });
    const inbox = new StickerInbox(saved, vi.fn(), vi.fn(), decode);
    if (sameBatch) inbox.add(original);
    inbox.add({ ...sticker('reencoded'), lastSeen: 25 });
    await inbox.flush();
    expect(saved.state.stickers).toHaveLength(1);
    expect(saved.state.stickers[0]).toMatchObject({ id: original.id, searchTerms: original.searchTerms, lastSeen: 25, fingerprint: { animated: true } });
    expect(new Store(directories.at(-1)!).state.stickers).toEqual(saved.state.stickers);
  });
  test('adds genuinely different static content even with the same colors as an animated first frame', async () => {
    const saved = store(), original = sticker('animated'), incoming = sticker('different');
    // Same RGB histogram, different spatial arrangement: both thumbnails have
    // the same average color, but their structure exceeds the Hamming limit.
    const pixels = Buffer.from(fixtures.animated.pixels, 'base64');
    const mirrored = Buffer.alloc(pixels.length);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) pixels.copy(mirrored, (y * 9 + x) * 3, (y * 9 + 8 - x) * 3, (y * 9 + 9 - x) * 3);
    const sameColors = async (image: string) => image === incoming.image ? mirrored.toString('base64') : decode(image);
    const animated = await fingerprintSticker(original, sameColors), still = await fingerprintSticker(incoming, sameColors);
    expect(nearSticker(still, animated)).toBe(false);
    saved.update(state => { state.stickers.push(saved.stickerFiles.write(original)); });
    const inbox = new StickerInbox(saved, vi.fn(), vi.fn(), sameColors);
    inbox.add(incoming); await inbox.flush();
    expect(saved.state.stickers.map(s => s.id)).toEqual([original.id, incoming.id]);
  });
  test('never suppresses an animated observation with an existing matching static first frame', async () => {
    const saved = store(), original = sticker('original'), incoming = sticker('animated');
    saved.update(state => { state.stickers.push(saved.stickerFiles.write(original)); });
    const inbox = new StickerInbox(saved, vi.fn(), vi.fn(), decode);
    inbox.add(incoming); await inbox.flush();
    expect(saved.state.stickers.map(s => s.id)).toEqual([original.id, incoming.id]);
  });
  test('requires both <=4 differing bits and RGB mean absolute difference <=12', async () => {
    const fp = await fingerprintSticker(sticker('original'), decode);
    const xor = (mask: bigint) => ({ ...fp, hash: (BigInt(`0x${fp.hash}`) ^ mask).toString(16).padStart(16, '0') });
    expect(nearSticker(fp, xor(15n))).toBe(true); expect(nearSticker(fp, xor(31n))).toBe(false);
    expect(nearSticker(fp, { ...fp, pixels: Buffer.alloc(216, 255).toString('base64') })).toBe(false);
  });
  test('rejects mismatched bytes and unbounded decoder results; decode failures keep exact-hash indexing', async () => {
    const incoming = sticker('original');
    await expect(fingerprintSticker({ ...incoming, id: 'f'.repeat(64) }, decode)).rejects.toThrow('hash');
    expect(decode).not.toHaveBeenCalled();
    await expect(fingerprintSticker(incoming, async () => '0'.repeat(289))).rejects.toThrow('thumbnail');
    const saved = store(), failed = vi.fn();
    const inbox = new StickerInbox(saved, vi.fn(), failed, async () => { throw new Error('decode failed'); });
    inbox.add({ ...incoming, fingerprint: await fingerprintSticker(incoming, decode) }); await inbox.flush();
    expect(saved.state.stickers[0].fingerprint).toBeUndefined(); expect(failed).not.toHaveBeenCalled();
  });
  test('retains decode-failure cache for surviving images through batch completion and exact rediscovery', async () => {
    const saved = store(), incoming = sticker('original');
    const unsupported = vi.fn(async (image: string) => {
      if (image === incoming.image) throw new Error('unsupported');
      return decode(image);
    });
    const inbox = new StickerInbox(saved, vi.fn(), vi.fn(), unsupported);
    inbox.add(incoming); await inbox.flush();
    inbox.add(incoming); await inbox.flush();
    inbox.add(sticker('different')); await inbox.flush();
    expect(unsupported.mock.calls.filter(([image]) => image === incoming.image)).toHaveLength(1);
    expect(saved.state.stickers.find(s => s.id === incoming.id)?.fingerprint).toBeUndefined();
  });
  test('invalidates a failed decode when its entry is forgotten', async () => {
    const saved = store(), incoming = sticker('original');
    const unsupported = vi.fn(async () => { throw new Error('unsupported'); });
    const inbox = new StickerInbox(saved, vi.fn(), vi.fn(), unsupported);
    inbox.add(incoming); await inbox.flush();
    saved.update(state => forgetSticker(state, incoming.id)); inbox.discard(incoming.id);
    // Simulate an explicit removal from the denylist to exercise invalidation.
    saved.update(state => { state.forgottenStickers = []; });
    inbox.add(incoming); await inbox.flush();
    expect(unsupported).toHaveBeenCalledTimes(2);
  });
  test('evicts a failed-decode cache when its observation cannot survive the library limit', async () => {
    const saved = store(), incoming = sticker('original');
    saved.update(state => { state.stickers = Array.from({ length: 2000 }, (_, i) => ({ ...saved.stickerFiles.write(sticker('different')), id: i.toString(16).padStart(64, '0') })); });
    const unsupported = vi.fn(async () => { throw new Error('unsupported'); });
    const inbox = new StickerInbox(saved, vi.fn(), vi.fn(), unsupported);
    inbox.add(incoming); await inbox.flush();
    expect(saved.state.stickers.some(s => s.id === incoming.id)).toBe(false);
    saved.update(state => { state.stickers = []; });
    inbox.add(incoming); await inbox.flush();
    expect(unsupported).toHaveBeenCalledTimes(2);
  });
  test('bounds each renderer decode at two seconds and ignores a late result', async () => {
    vi.useFakeTimers();
    const saved = store(), incoming = sticker('original'), failed = vi.fn();
    let release!: (pixels: string) => void;
    const inbox = new StickerInbox(saved, vi.fn(), failed, () => new Promise(resolve => { release = resolve; }));
    inbox.add(incoming); const flushing = inbox.flush();
    await vi.advanceTimersByTimeAsync(1999);
    expect(saved.state.stickers).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await flushing).toBe(true);
    expect(saved.state.stickers[0]).toMatchObject({ id: incoming.id });
    expect(saved.state.stickers[0].fingerprint).toBeUndefined();
    release(fixtures.original.pixels); await vi.advanceTimersByTimeAsync(0);
    expect(saved.state.stickers[0].fingerprint).toBeUndefined();
    expect(failed).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  test('legacy schemas load without new fields and invalid fingerprint/denylist metadata is rejected', () => {
    const saved = store(), legacy = initialState();
    const { forgottenStickers: _ignored, ...old } = legacy;
    writeFileSync(join(directories.at(-1)!, 'companion.json'), JSON.stringify({ ...old, stickerGroups: undefined, version: 1, stickers: [sticker('original')] }));
    expect(new Store(directories.at(-1)!).state.forgottenStickers).toEqual([]);
    expect(stickerSchema.safeParse({ ...sticker('original'), fingerprint: { version: 1, animated: false, hash: 'bad', pixels: fixtures.original.pixels } }).success).toBe(false);
    expect(stateSchema.safeParse({ ...saved.state, forgottenStickers: ['bad'] }).success).toBe(false);
  });
  test('local decoder composites alpha over white, requests a first-frame thumbnail and releases the bitmap', async () => {
    const close = vi.fn(), bitmap = { close };
    const create = vi.fn(async () => bitmap);
    const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn(), getImageData: () => ({ data: Uint8Array.from({ length: 288 }, (_, i) => i % 4 === 3 ? 255 : 127) }) };
    vi.stubGlobal('createImageBitmap', create);
    vi.stubGlobal('OffscreenCanvas', class { getContext() { return context; } });
    expect(await decodeStickerPixels(fixtures.original.image)).toBe(Buffer.alloc(216, 127).toString('base64'));
    expect(create).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({ resizeWidth: 9, resizeHeight: 8 }));
    expect(context.fillStyle).toBe('#ffffff'); expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 9, 8); expect(close).toHaveBeenCalledOnce();
  });
  test('refuses oversized declared dimensions before invoking the trusted decoder', async () => {
    const bytes = Buffer.from(fixtures.animated.image.split(',')[1], 'base64');
    expect(bytes.toString('ascii', 12, 16)).toBe('VP8X');
    bytes.writeUIntLE(4095, 24, 3);
    const image = `data:image/webp;base64,${bytes.toString('base64')}`;
    const id = createHash('sha256').update(bytes).digest('hex');
    await expect(fingerprintSticker({ ...sticker('animated'), image, id }, decode)).rejects.toThrow('dimensions');
    expect(decode).not.toHaveBeenCalled();
  });
  test('fingerprint migration is published, while cloning identical fingerprints produces no sticker delta', async () => {
    const previous = initialState(); previous.stickers = [store().stickerFiles.write(sticker('original'))];
    const state = structuredClone(previous); state.stickers[0].fingerprint = await fingerprintSticker(sticker('original'), decode);
    expect(statusUpdate({ state } as Status, previous).stickerChanges?.upsert).toEqual(state.stickers);
    expect(statusUpdate({ state: structuredClone(state) } as Status, state).stickerChanges).toBeUndefined();
  });
  test('closing drains observations queued during a decode and stops further discovery', async () => {
    const saved = store(); let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const inbox = new StickerInbox(saved, vi.fn(), vi.fn(), async image => { await waiting; return decode(image); });
    inbox.add(sticker('original')); const flushing = inbox.flush();
    inbox.add(sticker('different')); const closing = inbox.close();
    inbox.add(sticker('animated')); release(); await flushing; await closing;
    expect(saved.state.stickers.map(s => s.id)).toEqual(['original', 'different'].map(name => sticker(name).id));
  });
  test('close has a three-second total bound, saves queued observations exactly and ignores late decoding', async () => {
    vi.useFakeTimers();
    const saved = store(), animated = sticker('animated', 'keep animation'), original = sticker('original');
    saved.update(state => { state.stickers.push(saved.stickerFiles.write(animated)); });
    const releases: (() => void)[] = [], changed = vi.fn(), failed = vi.fn();
    const inbox = new StickerInbox(saved, changed, failed, image => image === original.image ? decode(image) : new Promise(resolve => {
      releases.push(() => resolve(Object.values(fixtures).find(value => value.image === image)!.pixels));
    }));
    inbox.add(original); inbox.add(sticker('different')); const flushing = inbox.flush();
    await vi.advanceTimersByTimeAsync(0); // The incoming fingerprint is ready; legacy decoding is stalled.
    inbox.add(sticker('reencoded'));
    const closing = inbox.close(); expect(inbox.close()).toBe(closing);
    inbox.add({ ...original, lastSeen: 100 });
    await vi.advanceTimersByTimeAsync(2999);
    expect(saved.state.stickers).toEqual([saved.stickerFiles.write(animated)]);
    await vi.advanceTimersByTimeAsync(1); await closing; await flushing;
    expect(saved.state.stickers.map(s => s.id)).toEqual([animated.id, original.id, sticker('different').id, sticker('reencoded').id]);
    expect(saved.state.stickers.find(s => s.id === original.id)?.lastSeen).toBe(1);
    expect(saved.state.stickers.every(s => !s.fingerprint)).toBe(true);
    expect(new Store(directories.at(-1)!).state.stickers).toEqual(saved.state.stickers);
    expect(changed).toHaveBeenCalledOnce(); expect(failed).not.toHaveBeenCalled();
    releases.forEach(release => release()); await vi.advanceTimersByTimeAsync(5000);
    expect(saved.state.stickers.every(s => !s.fingerprint)).toBe(true);
    expect(changed).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  test('shutdown fallback respects Forget and completes even if the exact-hash save fails', async () => {
    vi.useFakeTimers();
    const saved = store(), incoming = sticker('original'), forgotten = sticker('animated'), failed = vi.fn();
    const inbox = new StickerInbox(saved, vi.fn(), failed, () => new Promise(() => {}));
    inbox.add(incoming); inbox.add(sticker('different')); const flushing = inbox.flush();
    inbox.add(forgotten);
    saved.update(state => forgetSticker(state, forgotten.id)); inbox.discard(forgotten.id);
    let attemptedIds: string[] | undefined;
    const update = vi.spyOn(saved, 'update').mockImplementation(mutator => {
      const attempted = structuredClone(saved.state); mutator(attempted);
      attemptedIds = attempted.stickers.map(s => s.id);
      throw new Error('disk full');
    });
    const closing = inbox.close();
    await vi.advanceTimersByTimeAsync(2999); expect(update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await closing; await flushing;
    expect(update).toHaveBeenCalledOnce(); expect(failed).toHaveBeenCalledOnce();
    expect(attemptedIds).toEqual([incoming.id, sticker('different').id]);
    expect(saved.state.stickers).toHaveLength(0); expect(saved.state.forgottenStickers).toEqual([forgotten.id]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
