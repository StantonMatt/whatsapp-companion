import { test, expect } from 'vitest';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StartupDiagnostics, STARTUP_LOG_LIMIT } from '../src/main/startup-diagnostics';
import type { BootStructure } from '../src/shared/boot';
test('local startup load failures persist only allowlisted numeric codes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'startup-local-load-'));
  try {
    const logger = new StartupDiagnostics(directory);
    for (const event of ['base-load-failed', 'controls-load-failed'] as const) {
      logger.record(event, { code: -2 }); logger.record(event);
      for (const details of [{ code: -1001 }, { code: 1 }, { code: -1.5 }, { code: NaN }, { code: -2, url: 'file:///PRIVATE' }, { message: 'PRIVATE' }])
        logger.record(event, details as never);
    }
    await logger.flush();
    const raw = await readFile(join(directory, 'diagnostics/startup.log'), 'utf8');
    expect(raw.trim().split('\n').map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ event: 'base-load-failed', code: -2 }), expect.objectContaining({ event: 'base-load-failed' }),
      expect.objectContaining({ event: 'controls-load-failed', code: -2 }), expect.objectContaining({ event: 'controls-load-failed' })
    ]);
    expect(raw).not.toMatch(/PRIVATE|file:|message|url/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('load recovery records only bounded numeric codes and attempts without navigation details', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'startup-recovery-'));
  try {
    const logger = new StartupDiagnostics(directory);
    logger.record('load-failed', { code: -105, attempt: 1 });
    logger.record('load-retry', { attempt: 1 }); logger.record('navigation-stalled', { attempt: 2 }); logger.record('relaunch', { attempt: 2 });
    for (const details of [{ code: -1001 }, { code: 1 }, { code: -1.5 }, { code: NaN }, { attempt: 0 }, { attempt: 1.5 },
      { attempt: Infinity }, { attempt: Number.MAX_SAFE_INTEGER + 1 }, { code: -105, url: 'https://PRIVATE' }, { description: 'PRIVATE' }])
      logger.record('load-failed', details as never);
    await logger.flush();
    const raw = await readFile(join(directory, 'diagnostics/startup.log'), 'utf8');
    expect(raw.trim().split('\n').map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ event: 'load-failed', code: -105, attempt: 1 }), expect.objectContaining({ event: 'load-retry', attempt: 1 }),
      expect.objectContaining({ event: 'navigation-stalled', attempt: 2 }), expect.objectContaining({ event: 'relaunch', attempt: 2 })
    ]);
    expect(raw).not.toMatch(/PRIVATE|https:|description|url/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('asset failures persist only allowlisted kinds and generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'startup-assets-'));
  try {
    const logger = new StartupDiagnostics(directory);
    logger.record('asset-failure', { kind: 'script', generation: 1 });
    logger.record('asset-failure', { kind: 'stylesheet', generation: 2 });
    for (const details of [{ kind: 'PRIVATE' }, { kind: 'script', url: 'https://PRIVATE' }, { kind: 'stylesheet', message: 'PRIVATE' }])
      logger.record('asset-failure', details as never);
    await logger.flush();
    const raw = await readFile(join(directory, 'diagnostics/startup.log'), 'utf8');
    expect(raw.trim().split('\n').map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ event: 'asset-failure', kind: 'script', generation: 1 }),
      expect.objectContaining({ event: 'asset-failure', kind: 'stylesheet', generation: 2 })
    ]);
    expect(raw).not.toMatch(/PRIVATE|https:|message|url/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('ordered private diagnostics append across interrupted launches and reject private fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'startup-log-'));
  try {
    const path = join(directory, 'diagnostics/startup.log');
    const first = new StartupDiagnostics(directory);
    first.record('lock', { acquired: true }); first.record('phase', { phase: 'splash' }); await first.flush();
    const second = new StartupDiagnostics(directory);
    second.record('lock', { acquired: true }); second.record('store-load', { durationMs: 12 });
    for (const details of [{ url: 'https://PRIVATE' }, { message: 'PRIVATE' }, { name: 'PRIVATE' }, { nonce: 'PRIVATE' }, { reason: 'PRIVATE' }, { phase: 'PRIVATE' }, { app: 'PRIVATE' }]) second.record('phase', details as never);
    second.record('connector-deferral-expired', { generation: 1 }); second.record('quit'); await second.flush();
    const raw = await readFile(path, 'utf8'), records = raw.trim().split('\n').map(line => JSON.parse(line));
    expect(records.map(r => r.event)).toEqual(['lock', 'phase', 'lock', 'store-load', 'connector-deferral-expired', 'quit']);
    expect(records[0].launch).not.toBe(records[2].launch);
    expect(records.every(r => typeof r.timestamp === 'string' && Number.isFinite(r.elapsedMs))).toBe(true);
    expect(raw).not.toMatch(/PRIVATE|https:|message|nonce/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, 'diagnostics'))).mode & 0o777).toBe(0o700);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('rotation retains one previous timeline with private permissions and bounded queue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'startup-rotate-'));
  try {
    const path = join(directory, 'diagnostics/startup.log'), logger = new StartupDiagnostics(directory);
    logger.record('lock'); await logger.flush();
    await writeFile(path, 'x'.repeat(STARTUP_LOG_LIMIT));
    logger.record('phase', { phase: 'splash' }); await logger.flush();
    expect((await stat(`${path}.1`)).size).toBe(STARTUP_LOG_LIMIT);
    expect((await stat(`${path}.1`)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8')).phase).toBe('splash');
    for (let i = 0; i < 1000; i++) logger.record('progress', { progress: 1 });
    await logger.flush();
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(513);
    expect((await stat(path)).size).toBeLessThan(STARTUP_LOG_LIMIT);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('structural diagnostics persist only the fixed content-free validated signature', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'startup-structure-'));
  try {
    const logger = new StartupDiagnostics(directory);
    const structure: BootStructure = { visibleProgress: true, tagName: 'PROGRESS', ancestors: [
      { tagName: 'DIV', id: 'app', idPresent: true, testId: 'other', testIdPresent: true }
    ] };
    logger.record('structure', { structure, generation: 2 });
    for (const unsafe of [
      { ...structure, text: 'PRIVATE MESSAGE' }, { ...structure, classes: 'PRIVATE' },
      { ...structure, tagName: 'USER-ALICESMITH' },
      { ...structure, ancestors: [{ ...structure.ancestors[0], tagName: 'TOKEN-ABCDEFGH1234' }] },
      { ...structure, ancestors: [{ ...structure.ancestors[0], id: 'PRIVATE NAME' }] },
      { ...structure, ancestors: [{ ...structure.ancestors[0], testId: 'QR/PRIVATE' }] },
      ...['user_AliceSmith', 'token_abcdEFGH1234'].flatMap(value => [
        { ...structure, ancestors: [{ ...structure.ancestors[0], id: value }] },
        { ...structure, ancestors: [{ ...structure.ancestors[0], testId: value }] }
      ]),
      { ...structure, ancestors: [{ ...structure.ancestors[0], title: 'PRIVATE NAME' }] }
    ]) logger.record('structure', { structure: unsafe } as never);
    await logger.flush();
    const raw = await readFile(join(directory, 'diagnostics/startup.log'), 'utf8');
    const records = raw.trim().split('\n').map(line => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: 'structure', structure, generation: 2 });
    expect(raw).not.toMatch(/PRIVATE|message|classes|title|QR|user_AliceSmith|token_abcdEFGH1234/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('diagnostic IO failure never rejects flush or interrupts startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'startup-failure-'));
  try {
    await writeFile(join(directory, 'diagnostics'), 'not a directory');
    const logger = new StartupDiagnostics(directory); logger.record('lock');
    await expect(logger.flush()).resolves.toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
