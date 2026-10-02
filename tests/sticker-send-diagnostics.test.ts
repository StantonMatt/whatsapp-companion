import { test, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StickerSendDiagnostics } from '../src/main/sticker-send-diagnostics';
import { stickerLookupDiagnosticsSchema } from '../src/shared/sticker-transfer';
import { DIRECT_SHAPE } from '../src/shared/direct-sticker';

test('send diagnostics are private, omit identity and rotate at 256 KB', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sticker-sends-'));
  const path = join(directory, 'diagnostics/sticker-sends.log');
  const diagnostic = { totalMs: 8000, categories: [{ name: 'favorites' as const, activatedMs: 0, firstImageMs: 8000, settledMs: null, loadingSeen: true, imagesSeen: 1, found: true }] };
  const send = { id: 'private-id', nonce: 'private-nonce', name: 'private-chat', route: 'picker' as const, animated: true, state: 'sent' as const, sent: 'confirmed' as const };
  try {
    const logger = new StickerSendDiagnostics(directory);
    logger.append(send, diagnostic);
    const raw = readFileSync(path, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ route: 'picker', animated: true, outcome: 'confirmed', totalMs: 8000, categories: diagnostic.categories });
    expect(raw).not.toMatch(/private|data:image|blob:/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, 'diagnostics')).mode & 0o777).toBe(0o700);
    writeFileSync(path, 'x'.repeat(256 * 1024));
    logger.append(send, diagnostic);
    expect(statSync(`${path}.1`).size).toBe(256 * 1024);
    expect(statSync(path).size).toBeLessThan(256 * 1024);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('remote diagnostics accept only bounded timings and fixed category names', () => {
  const valid = { totalMs: 15000, categories: [{ name: 'recent', activatedMs: 0, firstImageMs: null, settledMs: null, loadingSeen: true, imagesSeen: 0, found: false }] };
  expect(stickerLookupDiagnosticsSchema.safeParse(valid).success).toBe(true);
  for (const invalid of [{ ...valid, image: 'private' }, { ...valid, totalMs: Infinity }, { ...valid, categories: [{ ...valid.categories[0], name: 'private-pack' }] }, { ...valid, categories: [{ ...valid.categories[0], source: 'blob:private' }] }]) {
    expect(stickerLookupDiagnosticsSchema.safeParse(invalid).success).toBe(false);
  }
});

test('native and direct records share the rotating owner-only log', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sticker-sends-combined-'));
  const path = join(directory, 'diagnostics/sticker-sends.log');
  const logger = new StickerSendDiagnostics(directory);
  const direct = { route: 'direct' as const, phase: 'send' as const, elapsedMs: 1600,
    outcome: 'confirmed' as const, code: 'none' as const, fingerprint: `${DIRECT_SHAPE}|2.3000.1030000000` };
  try {
    logger.append({ id: 'private-id', nonce: 'private-nonce', name: 'private-chat', route: 'picker', animated: true, state: 'missing' },
      { totalMs: 15000, categories: [], reason: 'lookup-cap' });
    logger.appendDirect(direct);
    const records = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ route: 'picker', reason: 'lookup-cap', totalMs: 15000 });
    expect(records[1]).toMatchObject(direct);
    expect(records.every(record => typeof record.timestamp === 'string')).toBe(true);
    expect(readFileSync(path, 'utf8')).not.toContain('private');
    writeFileSync(path, 'x'.repeat(256 * 1024));
    logger.appendDirect(direct);
    expect(statSync(`${path}.1`).size).toBe(256 * 1024);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject(direct);
    for (const file of [path, `${path}.1`]) expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, 'diagnostics')).mode & 0o777).toBe(0o700);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('direct shape diagnostics accept only fixed structural details and require one', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sticker-sends-detail-'));
  const path = join(directory, 'diagnostics/sticker-sends.log');
  const logger = new StickerSendDiagnostics(directory);
  const direct = { route: 'direct' as const, phase: 'resolve' as const, elapsedMs: 2,
    outcome: 'fallback' as const, code: 'module-shape' as const, fingerprint: null };
  try {
    logger.appendDirect({ ...direct, detail: 'Collections.Chat.getActive/active/models missing' });
    const raw = readFileSync(path, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ ...direct, detail: 'Collections.Chat.getActive/active/models missing' });
    for (const detail of [undefined, null, 'PRIVATE-CHAT', 'Collections.Chat.get missing: PRIVATE', 'x'.repeat(500)]) {
      logger.appendDirect({ ...direct, detail } as any);
      expect(readFileSync(path, 'utf8')).toBe(raw);
    }
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
