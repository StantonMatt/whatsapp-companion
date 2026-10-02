import { test, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StickerSendDiagnostics } from '../src/main/sticker-send-diagnostics';
import { stickerLookupDiagnosticsSchema } from '../src/shared/sticker-transfer';

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
