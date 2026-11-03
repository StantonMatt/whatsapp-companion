import { constants, closeSync, fstatSync, openSync, fsyncSync, readSync, mkdirSync, chmodSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { type DiscoveredSticker, type Sticker } from '../shared/model';
import { MAX_STICKER_BYTES } from '../shared/sticker-limits';
import { InvalidStickerError, storedSticker, verifyStickerBytes } from './sticker-bytes';
import { atomicWrite, syncDirectory, syncSavedDirectory, type StorageFault } from './store';

export const stickerHash = /^[a-f0-9]{64}$/;
type ActiveRead = { id: string; invalidated?: 'changed' | 'removed' };
class StickerReadChangedError extends Error {}
export class StickerFiles {
  readonly directory: string;
  durabilityWarning = false;
  private cache = new Map<string, { signature: string; verified: ReturnType<typeof verifyStickerBytes> }>();
  private cacheBytes = 0;
  private activeReads = new Set<ActiveRead>();
  readonly cacheBudget: number;
  private signature(stat: BigIntStats) {
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  }
  invalidate(id?: string, reason: 'changed' | 'removed' = 'changed') {
    // Removal is terminal for requests already in progress, even if the same
    // hash is subsequently restored before they finish.
    for (const read of this.activeReads) if ((!id || read.id === id) && read.invalidated !== 'removed') read.invalidated = reason;
    if (!id) { this.cache.clear(); this.cacheBytes = 0; return; }
    const old = this.cache.get(id);
    if (old) { this.cacheBytes -= old.verified.bytes.length; this.cache.delete(id); }
  }
  // Every request checks the actual opened file, even a cache hit. HTTP cache
  // revalidation therefore cannot hide deletion, symlinks or later corruption.
  async readBytes(id: string) {
    this.path(id);
    const read: ActiveRead = { id };
    this.activeReads.add(read);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const verified = await this.readBytesOnce(id, read);
          this.checkRead(read);
          return verified;
        } catch (error) {
          // Repairs can replace an opened inode or fix a failed read. Reopen
          // once, but never revive a request cancelled by Forget or deletion.
          if (attempt || read.invalidated === 'removed' || (read.invalidated !== 'changed' && !(error instanceof StickerReadChangedError))) throw error;
          read.invalidated = undefined;
        }
      }
    } finally { this.activeReads.delete(read); }
  }
  private checkRead(read: ActiveRead) {
    if (read.invalidated) throw new StickerReadChangedError('Sticker cache invalidated during read.');
  }
  private async readBytesOnce(id: string, read: ActiveRead) {
    const path = this.path(id);
    let handle: FileHandle | undefined;
    try {
      if (!(await lstat(this.directory)).isDirectory()) throw new InvalidStickerError('Invalid sticker directory.');
      const fd = handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await fd.stat({ bigint: true });
      this.checkRead(read);
      if (!stat.isFile() || stat.size < 12n || stat.size > BigInt(MAX_STICKER_BYTES)) throw new InvalidStickerError('Invalid sticker file.');
      const signature = this.signature(stat);
      const buffer = Buffer.allocUnsafe(Number(stat.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await fd.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (BigInt(length) !== stat.size || this.signature(await fd.stat({ bigint: true })) !== signature) throw new StickerReadChangedError('Sticker file changed during read.');
      this.checkRead(read);
      const bytes = buffer.subarray(0, length), cached = this.cache.get(id);
      // Inode, size and timestamps can all survive a same-tick overwrite.
      // Compare the opened file's bytes before reusing their verification.
      if (cached?.signature === signature && bytes.equals(cached.verified.bytes)) {
        this.cache.delete(id); this.cache.set(id, cached);
        return cached.verified;
      }
      if (cached) { this.cache.delete(id); this.cacheBytes -= cached.verified.bytes.length; }
      const verified = verifyStickerBytes(bytes, id);
      if (verified.bytes.length <= this.cacheBudget) {
        while (this.cacheBytes + verified.bytes.length > this.cacheBudget && this.cache.size) {
          const oldest = this.cache.keys().next().value!;
          this.cacheBytes -= this.cache.get(oldest)!.verified.bytes.length; this.cache.delete(oldest);
        }
        this.cache.set(id, { signature, verified }); this.cacheBytes += verified.bytes.length;
      }
      return verified;
    } catch (error) {
      const cached = this.cache.get(id);
      // Invalidation already evicted the old entry; do not evict a newer
      // request's verified replacement while the old handle is finishing.
      if (cached && !read.invalidated) { this.cacheBytes -= cached.verified.bytes.length; this.cache.delete(id); }
      throw error;
    } finally { await handle?.close(); }
  }
  constructor(directory: string, private fault?: StorageFault, cacheBudget = 64 * 1024 * 1024) {
    this.cacheBudget = cacheBudget;
    this.directory = join(directory, 'stickers');
  }
  private path(id: string) {
    if (!stickerHash.test(id)) throw new InvalidStickerError('Invalid sticker hash.');
    return join(this.directory, `${id}.webp`);
  }
  private ensureDirectory() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.directory).isDirectory()) throw new Error('Invalid sticker directory.');
    chmodSync(this.directory, 0o700);
    syncDirectory(join(this.directory, '..'));
  }
  read(id: string) {
    if (!lstatSync(this.directory).isDirectory()) throw new Error('Invalid sticker directory.');
    let fd: number;
    try { fd = openSync(this.path(id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new InvalidStickerError('Invalid sticker file.');
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size < 12 || stat.size > MAX_STICKER_BYTES) throw new InvalidStickerError('Invalid sticker file.');
      // Bound reads even if the file is changed between fstat and reading.
      const buffer = Buffer.allocUnsafe(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length !== stat.size || fstatSync(fd).size !== stat.size) throw new Error('Sticker file changed during read.');
      const bytes = buffer.subarray(0, length);
      return { ...verifyStickerBytes(bytes, id), image: `data:image/webp;base64,${bytes.toString('base64')}` };
    } finally { closeSync(fd); }
  }
  retryDirectorySync() {
    if (this.durabilityWarning) this.durabilityWarning = !syncSavedDirectory(this.directory, this.fault, 'blob:retry');
  }
  write(sticker: DiscoveredSticker, repairDamaged = false): Sticker {
    const { image, ...metadata } = sticker;
    const verified = storedSticker(image, sticker.id);
    this.ensureDirectory();
    this.retryDirectorySync();
    const path = this.path(sticker.id);
    let exists = false;
    try { lstatSync(path); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (exists) {
      try { this.read(sticker.id); }
      catch (error) {
        // Only validated incoming bytes may repair a damaged blob. Atomic
        // rename replaces a symlink itself without following its target.
        // Migration remains strict, and directories are never replaced.
        const damaged = lstatSync(path);
        if (!repairDamaged || !(error instanceof InvalidStickerError) || (!damaged.isFile() && !damaged.isSymbolicLink())) throw error;
        exists = false;
      }
    }
    if (exists) {
      // chmod, even to the same mode, changes ctime and defeats both cached
      // and in-flight signature checks on harmless rediscovery.
      if ((lstatSync(path).mode & 0o7777) !== 0o600) chmodSync(path, 0o600);
      const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW); // Writable for Windows FlushFileBuffers.
      try { fsyncSync(fd); } finally { closeSync(fd); }
      this.durabilityWarning = !syncSavedDirectory(this.directory, this.fault, `blob:${sticker.id}`);
    } else {
      this.durabilityWarning = !atomicWrite(path, verified.bytes, this.fault, `blob:${sticker.id}`);
      this.invalidate(sticker.id);
    }
    this.read(sticker.id); this.fault?.(`blob:${sticker.id}:verified`);
    return { ...metadata, groups: [], kind: verified.animated ? 'animated' : 'static', size: verified.bytes.length };
  }
  remove(id: string) {
    this.retryDirectorySync();
    try {
      unlinkSync(this.path(id)); this.invalidate(id, 'removed');
      this.durabilityWarning = !syncSavedDirectory(this.directory, this.fault, 'blob:remove');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.invalidate(id, 'removed');
    }
  }
  gc(references: string[]) {
    this.ensureDirectory();
    const live = new Set(references);
    for (const name of readdirSync(this.directory)) {
      const match = /^([a-f0-9]{64})\.webp(?:\.tmp)?$/.exec(name);
      if (!match || (live.has(match[1]) && !name.endsWith('.tmp'))) continue;
      const path = join(this.directory, name);
      try {
        if (lstatSync(path).isFile()) {
          this.fault?.(`gc:${name}:remove`);
          unlinkSync(path);
          if (!name.endsWith('.tmp')) this.invalidate(match[1], 'removed');
          this.durabilityWarning = true;
        }
      } catch { /* A failed orphan cleanup must not block other files or library startup. */ }
    }
    this.durabilityWarning = !syncSavedDirectory(this.directory, this.fault, 'blob:gc');
  }
}
