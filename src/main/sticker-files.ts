import { constants, closeSync, fstatSync, openSync, fsyncSync, readSync, mkdirSync, chmodSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { type DiscoveredSticker, type Sticker } from '../shared/model';
import { MAX_STICKER_BYTES } from '../shared/sticker-limits';
import { InvalidStickerError, storedSticker } from './sticker-bytes';
import { atomicWrite, syncDirectory, syncSavedDirectory, type StorageFault } from './store';

export const stickerHash = /^[a-f0-9]{64}$/;
export class StickerFiles {
  readonly directory: string;
  durabilityWarning = false;
  constructor(directory: string, private fault?: StorageFault) {
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
      return storedSticker(`data:image/webp;base64,${bytes.toString('base64')}`, id);
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
      chmodSync(path, 0o600);
      const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW); // Writable for Windows FlushFileBuffers.
      try { fsyncSync(fd); } finally { closeSync(fd); }
      this.durabilityWarning = !syncSavedDirectory(this.directory, this.fault, `blob:${sticker.id}`);
    } else this.durabilityWarning = !atomicWrite(path, verified.bytes, this.fault, `blob:${sticker.id}`);
    this.read(sticker.id); this.fault?.(`blob:${sticker.id}:verified`);
    return { ...metadata, kind: verified.animated ? 'animated' : 'static', size: verified.bytes.length };
  }
  remove(id: string) {
    this.retryDirectorySync();
    try { unlinkSync(this.path(id)); this.durabilityWarning = !syncSavedDirectory(this.directory, this.fault, 'blob:remove'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  gc(references: string[]) {
    this.ensureDirectory();
    const live = new Set(references);
    for (const name of readdirSync(this.directory)) {
      const match = /^([a-f0-9]{64})\.webp(?:\.tmp)?$/.exec(name);
      if (!match || (live.has(match[1]) && !name.endsWith('.tmp'))) continue;
      const path = join(this.directory, name);
      try {
        if (lstatSync(path).isFile()) { this.fault?.(`gc:${name}:remove`); unlinkSync(path); this.durabilityWarning = true; }
      } catch { /* A failed orphan cleanup must not block other files or library startup. */ }
    }
    this.durabilityWarning = !syncSavedDirectory(this.directory, this.fault, 'blob:gc');
  }
}
