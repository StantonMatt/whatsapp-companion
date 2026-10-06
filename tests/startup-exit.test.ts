import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ app: undefined as any, errors: vi.fn() }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  mocks.app = Object.assign(new EventEmitter(), {
    isPackaged: false, directory: '',
    commandLine: { removeSwitch() {}, hasSwitch: () => true }, enableSandbox() {}, setName() {},
    setPath(_name: string, value: string) { this.directory = value; }, getPath() { return this.directory; },
    getVersion: () => '0.1.0', requestSingleInstanceLock: vi.fn(), whenReady: vi.fn(), quit: vi.fn()
  });
  return { app: mocks.app, BrowserWindow: vi.fn(), WebContentsView: vi.fn(), ipcMain: {}, session: {},
    protocol: { registerSchemesAsPrivileged() {} }, dialog: { showErrorBox: mocks.errors }, shell: {}, Menu: {}, safeStorage: {} };
});

let directory: string, args: string[], logger: { flush(): Promise<void> } | undefined;
let realFlush: (() => Promise<void>) | undefined;
beforeEach(async () => {
  vi.resetModules();
  const { app } = await import('electron');
  app.removeAllListeners(); mocks.app.quit.mockReset(); mocks.errors.mockReset();
  mocks.app.requestSingleInstanceLock.mockReset().mockReturnValue(true);
  mocks.app.whenReady.mockReset().mockResolvedValue(undefined);
  directory = await mkdtemp(join(tmpdir(), 'startup-exit-')); args = process.argv;
  process.argv = [...args, `--data-dir=${directory}`];
  // Exercise a genuine initialization failure before window shutdown handlers exist.
  await writeFile(join(directory, 'companion.json'), 'invalid JSON');
  logger = undefined; realFlush = undefined;
});
afterEach(async () => {
  vi.useRealTimers();
  if (logger && realFlush) await realFlush.call(logger);
  vi.restoreAllMocks(); process.argv = args;
  await rm(directory, { recursive: true, force: true });
});
async function interceptFlush(flush: () => Promise<void>) {
  const { StartupDiagnostics } = await import('../src/main/startup-diagnostics');
  realFlush = StartupDiagnostics.prototype.flush;
  return vi.spyOn(StartupDiagnostics.prototype, 'flush').mockImplementation(function (this: InstanceType<typeof StartupDiagnostics>) {
    logger = this;
    return flush();
  });
}
async function events() {
  return (await readFile(join(directory, 'diagnostics/startup.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).event);
}

test('a lock-losing instance neither writes nor rotates the primary diagnostic history', async () => {
  const { STARTUP_LOG_LIMIT } = await import('../src/main/startup-diagnostics');
  const path = join(directory, 'diagnostics/startup.log');
  await mkdir(join(directory, 'diagnostics'));
  const history = 'x'.repeat(STARTUP_LOG_LIMIT);
  await writeFile(path, history); await writeFile(`${path}.1`, 'retained history');
  mocks.app.requestSingleInstanceLock.mockReturnValue(false);
  await import('../src/main/index');
  await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
  expect(mocks.app.whenReady).not.toHaveBeenCalled(); expect(mocks.errors).not.toHaveBeenCalled();
  expect(await readFile(path, 'utf8')).toBe(history);
  expect(await readFile(`${path}.1`, 'utf8')).toBe('retained history');
});

test('initialization failure waits for queued diagnostics before quitting, without reentering the flush', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const flush = await interceptFlush(async () => { await gate; await realFlush!.call(logger); });
  const prevented = vi.fn();
  mocks.app.quit.mockImplementation(() => mocks.app.emit('before-quit', { preventDefault: prevented }));
  await import('../src/main/index');
  await vi.waitFor(() => expect(mocks.errors).toHaveBeenCalledOnce());
  expect(flush).toHaveBeenCalledOnce(); expect(mocks.app.quit).not.toHaveBeenCalled();
  release();
  await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
  expect(await events()).toEqual(['lock', 'app-ready', 'before-quit', 'quit']);
  expect(prevented).not.toHaveBeenCalled(); expect(flush).toHaveBeenCalledOnce();
});

test('initialization failure still quits after the diagnostic timeout', async () => {
  const flush = await interceptFlush(() => new Promise(() => {}));
  vi.useFakeTimers();
  await import('../src/main/index');
  expect(mocks.errors).toHaveBeenCalledOnce(); expect(flush).toHaveBeenCalledOnce();
  expect(mocks.app.quit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(999); expect(mocks.app.quit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(mocks.app.quit).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test('before-quit during readiness flushes and prevents initialization from starting afterwards', async () => {
  let ready!: () => void;
  mocks.app.whenReady.mockReturnValue(new Promise<void>(resolve => { ready = resolve; }));
  await import('../src/main/index');
  const preventDefault = vi.fn();
  mocks.app.emit('before-quit', { preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
  ready(); await Promise.resolve();
  expect(mocks.errors).not.toHaveBeenCalled();
  expect(await events()).toEqual(['lock', 'before-quit', 'quit']);
});
