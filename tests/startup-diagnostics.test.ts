import { test, expect } from 'vitest';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StartupDiagnostics, STARTUP_LOG_LIMIT } from '../src/main/startup-diagnostics';

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
test('diagnostic IO failure never rejects flush or interrupts startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'startup-failure-'));
  try {
    await writeFile(join(directory, 'diagnostics'), 'not a directory');
    const logger = new StartupDiagnostics(directory); logger.record('lock');
    await expect(logger.flush()).resolves.toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
