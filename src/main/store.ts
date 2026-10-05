import { constants, fstatSync, fchmodSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync, openSync, fsyncSync, closeSync, linkSync, unlinkSync, readdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join } from 'node:path';
import { initialState, legacyStateSchema, stateSchema, type State } from '../shared/model';
import { StickerFiles } from './sticker-files';
import { storedSticker } from './sticker-bytes';
import { forgetStickers } from '../core/stickers';

// Optional checkpoints let tests interrupt durability boundaries like a crash.
export type StorageFault = (step: string) => void;
export function syncDirectory(directory: string, fault?: StorageFault, prefix = 'manifest') {
  fault?.(`${prefix}:directory-sync`);
  if (process.platform === 'win32') return;
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
// Directory sync is best effort after installation: the saved contents are
// authoritative even when the OS cannot confirm their crash durability.
export function syncSavedDirectory(directory: string, fault?: StorageFault, prefix = 'manifest') {
  try { syncDirectory(directory, fault, prefix); return true; }
  catch { console.warn(`Storage durability warning (${prefix}): directory sync failed; retrying on the next write.`); return false; }
}
export function atomicWrite(path: string, text: string | Buffer, fault?: StorageFault, prefix = 'manifest', exclusive = false) {
  const temp = `${path}.tmp`;
  // Remove a previous interrupted temp without following a filesystem link.
  try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
  chmodSync(temp, 0o600); fault?.(`${prefix}:write`);
  const fd = openSync(temp, 'r+'); // Windows FlushFileBuffers requires a writable handle.
  try { fsyncSync(fd); } finally { closeSync(fd); }
  fault?.(`${prefix}:sync`);
  fault?.(`${prefix}:replace`);
  let replaced = false;
  try {
    if (exclusive) {
      try { linkSync(temp, path); replaced = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      unlinkSync(temp);
      // A pre-existing backup is never replaced, but its data and permissions
      // must also be durable before migration can discard the inline manifest.
      const backup = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!fstatSync(backup).isFile()) throw new Error('Invalid migration backup.');
        fchmodSync(backup, 0o600); fsyncSync(backup);
      } finally { closeSync(backup); }
    } else { renameSync(temp, path); replaced = true; }
    fault?.(`${prefix}:rename`);
    syncDirectory(dirname(path), fault, prefix); fault?.(`${prefix}:directory`);
    return true;
  } catch (error) {
    // Replacement is the save boundary. A later failure must not suppress
    // callers' normal follow-up or make them retry an already successful save.
    if (replaced) {
      console.warn(`Storage durability warning (${prefix}): file saved; directory sync will be retried on the next write.`);
      return false;
    }
    throw error;
  }
}
export class Store {
  state: State;
  readonly stickerFiles: StickerFiles;
  private path: string;
  private recoveryPath: string;
  private preservedStickerIds: string[] = [];
  private manifestDurabilityWarning = false;
  get durabilityWarning() { return this.manifestDurabilityWarning || this.stickerFiles.durabilityWarning; }
  recoveryHint?: string;
  constructor(directory: string, private fault?: StorageFault) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'companion.json');
    this.stickerFiles = new StickerFiles(directory, fault);
    const loadedManifest = existsSync(this.path);
    this.recoveryPath = join(directory, 'sticker-recovery.json');
    const recoveryPath = this.recoveryPath;
    // Preserve references outside a newly defaulted manifest. This record
    // survives unrelated saves and restarts until a restored manifest covers it.
    let preserved: string[] = existsSync(recoveryPath) ? JSON.parse(readFileSync(recoveryPath, 'utf8')) : [];
    if (!Array.isArray(preserved) || preserved.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw new Error('Invalid sticker recovery record. Restore companion.json or its v1 backup.');
    if (!loadedManifest && existsSync(this.stickerFiles.directory)) {
      const recognized = readdirSync(this.stickerFiles.directory).flatMap(name => /^([a-f0-9]{64})\.webp$/.exec(name)?.[1] ?? []);
      preserved = [...new Set([...preserved, ...recognized])];
      if (preserved.length) this.manifestDurabilityWarning = !atomicWrite(recoveryPath, JSON.stringify(preserved), fault, 'recovery');
    }
    // Invalid data is never silently overwritten with defaults. No GC on errors.
    if (loadedManifest) {
      const original = readFileSync(this.path, 'utf8'), raw: unknown = JSON.parse(original);
      if ((raw as { version?: unknown })?.version === 1) {
        const legacy = legacyStateSchema.parse(raw);
        // Validate ALL bytes and metadata before writing even the backup.
        const stickers = legacy.stickers.map(({ image, ...metadata }) => {
          const verified = storedSticker(image, metadata.id);
          return { ...metadata, kind: verified.animated ? 'animated' as const : 'static' as const, size: verified.bytes.length };
        });
        const next = stateSchema.parse({ ...legacy, version: 2, stickers });
        this.manifestDurabilityWarning = !atomicWrite(join(directory, 'companion.v1-backup.json'), original, fault, 'backup', true) || this.manifestDurabilityWarning;
        // Migration must preserve the whole inline library until every blob is
        // verified. Unlike intake, it cannot drop individual legacy entries.
        for (const sticker of legacy.stickers) this.stickerFiles.write(sticker);
        fault?.('migration:verified');
        this.manifestDurabilityWarning = !atomicWrite(this.path, JSON.stringify(next), fault) || this.manifestDurabilityWarning;
        this.state = next;
      } else this.state = stateSchema.parse(raw);
    } else this.state = initialState();
    // No manifest means no authoritative reference set: preserve any blobs
    // during fresh-start/recovery instead of treating them as orphaned.
    this.preservedStickerIds = preserved;
    if (preserved.length) {
      this.recoveryHint = 'Sticker files were preserved after companion.json was missing. Restore companion.json or companion.v1-backup.json to recover the library.';
      if (loadedManifest) this.finishRecovery();
    }
    if (loadedManifest) {
      try { this.stickerFiles.gc([...this.state.stickers.map(s => s.id), ...preserved]); }
      catch { /* GC is best effort; a valid manifest remains usable during IO failures. */ }
    }
    for (const rules of Object.values(this.state.auto)) rules.paused = true;
  }
  private finishRecovery(clearRecord = true) {
    if (!this.preservedStickerIds.length || !this.preservedStickerIds.every(id => this.state.stickers.some(s => s.id === id) || this.state.forgottenStickers.includes(id))) return;
    // A loaded/restored or successfully saved manifest resolves all preserved hashes.
    // Recovery-record cleanup cannot turn that successful save into a failure.
    this.recoveryHint = undefined;
    // Keep the crash-recovery guard until the replacement manifest's directory
    // sync succeeds. The in-memory library is already saved and usable.
    if (!clearRecord) return;
    try { this.fault?.('recovery:clear'); unlinkSync(this.recoveryPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Sticker recovery record cleanup failed; retrying on the next write.'); return;
      }
    }
    this.preservedStickerIds = [];
    this.manifestDurabilityWarning = !syncSavedDirectory(dirname(this.path), this.fault, 'recovery') || this.manifestDurabilityWarning;
  }
  update(mutator: (state: State) => void) {
    this.stickerFiles.retryDirectorySync();
    if (this.manifestDurabilityWarning) this.manifestDurabilityWarning = !syncSavedDirectory(dirname(this.path), this.fault, 'manifest:retry');
    const next = structuredClone(this.state);
    mutator(next);
    if (isDeepStrictEqual(next, this.state)) { this.finishRecovery(!this.manifestDurabilityWarning); return; }
    stateSchema.parse(next);
    this.manifestDurabilityWarning = !atomicWrite(this.path, JSON.stringify(next), this.fault);
    this.state = next;
    this.finishRecovery(!this.manifestDurabilityWarning);
  }

  private indexedState?: State;
  private stickerIndex = new Map<string, State['stickers'][number]>();
  private indexedSticker(id: string) {
    if (this.indexedState !== this.state) {
      this.stickerIndex = new Map(this.state.stickers.map(s => [s.id, s])); this.indexedState = this.state;
    }
    return this.stickerIndex.get(id);
  }
  async readStickerBytes(id: string) {
    const sticker = this.indexedSticker(id);
    if (!sticker) throw new Error('Sticker no longer indexed.');
    try {
      const verified = await this.stickerFiles.readBytes(id);
      const current = this.indexedSticker(id);
      if (!current || verified.bytes.length !== current.size || verified.animated !== (current.kind === 'animated')) throw new Error('Sticker metadata mismatch.');
      return verified;
    } catch { throw new Error('Sticker file is missing or damaged. Restore the file from a backup, or let the app rediscover the sticker.'); }
  }
  readSticker(id: string) {
    const sticker = this.indexedSticker(id);
    if (!sticker) throw new Error('Sticker no longer indexed.');
    try {
      const verified = this.stickerFiles.read(id);
      if (verified.bytes.length !== sticker.size || verified.animated !== (sticker.kind === 'animated')) throw new Error('Sticker metadata mismatch.');
      return verified;
    } catch { throw new Error('Sticker file is missing or damaged. Restore the file from a backup, or let the app rediscover the sticker.'); }
  }
  forgetSticker(id: string) { return this.forgetStickers([id]); }
  forgetStickers(ids: string[]) {
    // Unknown hashes are ignored, consistently for single and bulk deletion.
    // Recovery can also explicitly forget a preserved, unindexed blob.
    const known = new Set([...this.state.stickers.map(sticker => sticker.id), ...this.preservedStickerIds]);
    const removed = [...new Set(ids)].filter(id => known.has(id));
    if (!removed.length) return removed;
    this.update(state => forgetStickers(state, removed));
    for (const id of removed) this.stickerFiles.invalidate(id, 'removed');
    // Persist ALL tombstones before deleting any blob. Failed unlinking leaves
    // only an orphan for startup GC; it must not prevent the remaining cleanup.
    this.fault?.('forget:manifest');
    if (this.manifestDurabilityWarning) return removed;
    for (const id of removed) {
      try { this.stickerFiles.remove(id); } catch { /* Startup GC retries orphan deletion. */ }
    }
    this.fault?.('forget:removed');
    return removed;
  }
}
