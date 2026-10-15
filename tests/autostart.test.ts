import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, symlinkSync, lstatSync, statSync, chmodSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { StartAtLogin } from '../src/main/autostart';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function setup(overrides: Partial<ConstructorParameters<typeof StartAtLogin>[0]> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'companion-autostart-')); directories.push(directory);
  const options = { packaged: true, fixture: false, platform: 'linux' as NodeJS.Platform, configDirectory: directory,
    executable: '/opt/WhatsApp Companion.AppImage', setLoginItemSettings: vi.fn(), ...overrides };
  return { login: new StartAtLogin(options), options, path: join(directory, 'autostart/whatsapp-companion.desktop') };
}
test('first packaged run defaults on only with a tray; explicit false stays off', () => {
  const c = setup(); expect(c.login.initialize(undefined, false)).toBeUndefined(); expect(existsSync(c.path)).toBe(false);
  expect(c.login.initialize(undefined, true)).toBe(true);
  expect(readFileSync(c.path, 'utf8')).toContain('Exec="/opt/WhatsApp Companion.AppImage" --hidden\n');
  expect(readFileSync(c.path, 'utf8')).toContain('X-GNOME-Autostart-enabled=true');
  c.login.apply(false); expect(existsSync(c.path)).toBe(false);
  expect(c.login.initialize(false, true)).toBe(false); expect(existsSync(c.path)).toBe(false);
  c.login.apply(false);
});
test('startup repairs a stale executable path and quotes desktop Exec reserved characters', () => {
  const c = setup(); c.login.initialize(true, true);
  const executable = '/home/user/Apps/A "quote" $cash `tick` \\ slash %app.AppImage';
  new StartAtLogin({ ...c.options, executable }).initialize(true, true);
  const exec = readFileSync(c.path, 'utf8').split('\n').find(line => line.startsWith('Exec='))!;
  expect(exec).toBe('Exec="/home/user/Apps/A \\\\"quote\\\\" \\\\$cash \\\\`tick\\\\` \\\\\\\\ slash %%app.AppImage" --hidden');
});
test.each([{ packaged: false }, { fixture: true }])('dev/fixture never touches autostart: %j', overrides => {
  const c = setup(overrides); expect(c.login.initialize(undefined, true)).toBeUndefined();
  c.login.apply(true); c.login.apply(false); expect(existsSync(c.path)).toBe(false);
  expect(c.options.setLoginItemSettings).not.toHaveBeenCalled();
});
test.each(['darwin', 'win32'] as const)('%s uses Electron login settings and the hidden argument', platform => {
  const c = setup({ platform }); expect(c.login.initialize(undefined, true)).toBe(true);
  expect(c.options.setLoginItemSettings).toHaveBeenCalledExactlyOnceWith({ openAtLogin: true, args: ['--hidden'] });
  c.login.apply(false); expect(c.options.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false, args: ['--hidden'] });
  expect(existsSync(c.path)).toBe(false);
});
test('rewriting autostart replaces a symlink without touching its target; disable unlinks it', () => {
  const c = setup(); mkdirSync(join(c.options.configDirectory, 'autostart'));
  const target = join(c.options.configDirectory, 'other-file'); writeFileSync(target, 'unrelated', { mode: 0o644 });
  symlinkSync(target, c.path); c.login.apply(true);
  expect(readFileSync(target, 'utf8')).toBe('unrelated'); expect(lstatSync(c.path).isSymbolicLink()).toBe(false);
  expect(statSync(c.path).mode & 0o777).toBe(0o600);
  rmSync(c.path); symlinkSync(target, c.path); c.login.apply(false);
  expect(lstatSync(target).isFile()).toBe(true); expect(readFileSync(target, 'utf8')).toBe('unrelated');
});
test('matching entries with unsafe permissions or symlinks are replaced, secure unchanged entries are untouched', () => {
  const c = setup(); c.login.apply(true); const entry = readFileSync(c.path, 'utf8');
  chmodSync(c.path, 0o644); const old = statSync(c.path); c.login.apply(true);
  expect(statSync(c.path).mode & 0o777).toBe(0o600); expect(statSync(c.path).ino).not.toBe(old.ino);
  const secure = statSync(c.path); c.login.apply(true);
  expect(statSync(c.path)).toMatchObject({ ino: secure.ino, mtimeMs: secure.mtimeMs, ctimeMs: secure.ctimeMs });
  const target = join(c.options.configDirectory, 'other-file'); writeFileSync(target, entry, { mode: 0o644 });
  rmSync(c.path); symlinkSync(target, c.path); c.login.apply(true);
  expect(lstatSync(c.path).isSymbolicLink()).toBe(false); expect(statSync(target).mode & 0o777).toBe(0o644);
  expect(readdirSync(join(c.options.configDirectory, 'autostart'))).toEqual(['whatsapp-companion.desktop']);
});
test.each([true, false])('toggle to %s rolls back the OS entry when saving fails', enabled => {
  const c = setup(); c.login.apply(!enabled);
  const save = vi.fn(() => { throw new Error('disk full'); });
  expect(() => c.login.change(enabled, !enabled, save)).toThrow('disk full');
  expect(existsSync(c.path)).toBe(!enabled); expect(save).toHaveBeenCalledExactlyOnceWith(enabled);
});
test('first-run initialization rolls back the default entry when saving fails', () => {
  const c = setup(), save = vi.fn(() => { throw new Error('disk full'); });
  expect(() => c.login.initialize(undefined, true, save)).toThrow('disk full');
  expect(existsSync(c.path)).toBe(false); expect(save).toHaveBeenCalledExactlyOnceWith(true);
});
test('apply failure during initialization or toggle never saves', () => {
  const c = setup({ platform: 'darwin', setLoginItemSettings: vi.fn(() => { throw new Error('OS refused'); }) });
  const save = vi.fn();
  expect(() => c.login.initialize(undefined, true, save)).toThrow('OS refused');
  expect(() => c.login.change(true, false, save)).toThrow('OS refused'); expect(save).not.toHaveBeenCalled();
});
