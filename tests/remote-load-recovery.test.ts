import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RemoteLoadRecovery, STALL_RELAUNCH_MARKER } from '../src/main/remote-load-recovery';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function recovery(args = ['app', '--fixture', '--data-dir=/disposable', '--hidden'], visible = false, env: NodeJS.ProcessEnv = {}) {
  const options = { args, visible: () => visible, env, execPath: '/mount/companion/companion', closing: vi.fn(() => false),
    load: vi.fn(() => instance.navigate(true, false)), stop: vi.fn(), relaunch: vi.fn(), record: vi.fn() };
  const instance = new RemoteLoadRecovery(options);
  instance.navigate(true, false);
  return { instance, options };
}
test('main-frame failures retry indefinitely with 2/5/15/30/60s backoff, even while hidden', () => {
  const { instance, options } = recovery();
  for (const [index, delay] of [2000, 5000, 15_000, 30_000, 60_000, 60_000, 60_000].entries()) {
    instance.fail(-106, true, true); instance.fail(-106, true);
    // Chromium commits an error document and fires dom-ready/finish-load.
    instance.commit(-1); instance.domReady();
    expect(options.record).toHaveBeenCalledWith('load-failed', { code: -106, attempt: index + 1 });
    vi.advanceTimersByTime(delay - 1); expect(options.load).toHaveBeenCalledTimes(index);
    vi.advanceTimersByTime(1); expect(options.load).toHaveBeenCalledTimes(index + 1);
    expect(options.record).toHaveBeenCalledWith('load-retry', { attempt: index + 1 });
  }
  expect(options.relaunch).not.toHaveBeenCalled(); expect(options.stop).not.toHaveBeenCalled();
});
test('ERR_ABORTED and subframe failures never schedule a retry or log failure', () => {
  const { instance, options } = recovery();
  instance.fail(-106, false); instance.fail(-3, true, true); instance.fail(-3, true);
  vi.advanceTimersByTime(120_000);
  expect(options.load).not.toHaveBeenCalled(); expect(options.record).not.toHaveBeenCalled();
});
test.each(['commit', 'dom-ready'] as const)('successful %s resets failure backoff and consecutive stalls', signal => {
  const { instance, options } = recovery();
  instance.fail(-106, true); vi.advanceTimersByTime(2000);
  instance.fail(-106, true); vi.advanceTimersByTime(5000);
  if (signal === 'commit') instance.commit(200); else instance.domReady();
  instance.navigate(true, false); instance.fail(-106, true);
  expect(options.record).toHaveBeenLastCalledWith('load-failed', { code: -106, attempt: 1 });
  vi.advanceTimersByTime(2000); expect(options.load).toHaveBeenCalledTimes(3);
  vi.advanceTimersByTime(45_000); expect(options.stop).toHaveBeenCalledOnce();
  instance.commit(302); instance.navigate(true, false);
  vi.advanceTimersByTime(45_000); expect(options.stop).toHaveBeenCalledTimes(2);
  expect(options.relaunch).not.toHaveBeenCalled();
});
test.each([false, true])('another main-frame navigation (same document %s) cancels pending retry', sameDocument => {
  const { instance, options } = recovery(); instance.fail(-106, true);
  instance.navigate(false, false); vi.advanceTimersByTime(1000);
  instance.navigate(true, sameDocument); vi.advanceTimersByTime(1000);
  expect(options.load).not.toHaveBeenCalled();
  instance.close(); vi.advanceTimersByTime(120_000); expect(options.load).not.toHaveBeenCalled();
});
test.each(['close', 'closing gate'] as const)('%s cancels or suppresses pending failure retries and stalls', mode => {
  for (const failed of [false, true]) {
    const { instance, options } = recovery();
    if (failed) instance.fail(-106, true);
    if (mode === 'close') instance.close(); else options.closing.mockReturnValue(true);
    instance.navigate(true, false); instance.fail(-106, true);
    vi.advanceTimersByTime(120_000);
    expect(options.load).not.toHaveBeenCalled(); expect(options.stop).not.toHaveBeenCalled(); expect(options.relaunch).not.toHaveBeenCalled();
  }
});
test('first navigation stall stops and reloads at 45s, second stall relaunches only once', () => {
  const { instance, options } = recovery();
  vi.advanceTimersByTime(44_999); expect(options.load).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(options.stop).toHaveBeenCalledOnce(); expect(options.load).toHaveBeenCalledOnce();
  expect(options.stop.mock.invocationCallOrder[0]).toBeLessThan(options.load.mock.invocationCallOrder[0]);
  vi.advanceTimersByTime(45_000);
  expect(options.relaunch).toHaveBeenCalledExactlyOnceWith({ execPath: '/mount/companion/companion',
    args: ['app', '--fixture', '--data-dir=/disposable', '--hidden', STALL_RELAUNCH_MARKER] });
  expect(options.record.mock.calls.map(([event]) => event)).toEqual(['navigation-stalled', 'load-retry', 'navigation-stalled', 'relaunch']);
  instance.navigate(true, false); vi.advanceTimersByTime(300_000);
  expect(options.relaunch).toHaveBeenCalledOnce(); expect(options.load).toHaveBeenCalledOnce();
});
test('relaunch preserves fixture/data arguments, drops hidden when shown, and honors this AppImage mount', () => {
  const { options } = recovery(undefined, true, { APPDIR: '/mount/companion', APPIMAGE: '/apps/Companion.AppImage' });
  vi.advanceTimersByTime(90_000);
  expect(options.relaunch).toHaveBeenCalledExactlyOnceWith({ execPath: '/apps/Companion.AppImage',
    args: ['app', '--fixture', '--data-dir=/disposable', STALL_RELAUNCH_MARKER] });
});
test('an inherited unrelated AppImage is never relaunched', () => {
  const { options } = recovery([], false, { APPDIR: '/mount/editor', APPIMAGE: '/apps/Editor.AppImage' });
  vi.advanceTimersByTime(90_000);
  expect(options.relaunch.mock.calls[0][0].execPath).toBe('/mount/companion/companion');
});
test('relaunch marker forbids relaunch and repeats stop/reload every 60s after initial 45s stall', () => {
  const { options } = recovery([STALL_RELAUNCH_MARKER]);
  vi.advanceTimersByTime(45_000); expect(options.stop).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(59_999); expect(options.stop).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1); expect(options.stop).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(180_000); expect(options.stop).toHaveBeenCalledTimes(5);
  expect(options.load).toHaveBeenCalledTimes(5); expect(options.relaunch).not.toHaveBeenCalled();
});
test.each(['commit', 'dom-ready', 'failure', 'provisional failure', 'aborted'] as const)('%s clears the navigation stall timer', signal => {
  const { instance, options } = recovery();
  vi.advanceTimersByTime(44_000);
  if (signal === 'commit') instance.commit(404);
  else if (signal === 'dom-ready') instance.domReady();
  else instance.fail(signal === 'aborted' ? -3 : -106, true, signal === 'provisional failure');
  vi.advanceTimersByTime(1000);
  expect(options.stop).not.toHaveBeenCalled(); expect(options.relaunch).not.toHaveBeenCalled();
  instance.close();
});
test('subframe and same-document navigation do not arm a stall timer or replace the cross-document timer', () => {
  const { instance, options } = recovery();
  instance.domReady(); instance.navigate(false, false); instance.navigate(true, true);
  vi.advanceTimersByTime(120_000); expect(options.load).not.toHaveBeenCalled();
  instance.navigate(true, false); vi.advanceTimersByTime(40_000); instance.navigate(false, false); instance.navigate(true, true);
  vi.advanceTimersByTime(5000); expect(options.load).toHaveBeenCalledOnce();
});
test('provisional failure prevents error-page dom-ready from cancelling an already scheduled retry', () => {
  const { instance, options } = recovery();
  instance.fail(-105, true, true); instance.domReady(); instance.fail(-105, true);
  vi.advanceTimersByTime(2000); instance.fail(-105, true, true); instance.commit(-1); instance.domReady(); instance.fail(-105, true);
  vi.advanceTimersByTime(4999); expect(options.load).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1); expect(options.load).toHaveBeenCalledTimes(2);
});
test('a commit after a provisional failure cannot reset backoff even with an HTTP status', () => {
  const { instance, options } = recovery();
  instance.fail(-105, true); vi.advanceTimersByTime(2000);
  instance.fail(-105, true, true); instance.commit(200); instance.domReady(); instance.fail(-105, true);
  vi.advanceTimersByTime(4999); expect(options.load).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1); expect(options.load).toHaveBeenCalledTimes(2);
});
test.each([-10_000, 2, 1.5, NaN])('failure code %s is bounded and integral in diagnostics', code => {
  const { instance, options } = recovery(); instance.fail(code, true);
  const details = options.record.mock.calls[0][1];
  expect(Number.isInteger(details.code)).toBe(true); expect(details.code).toBeGreaterThanOrEqual(-1000); expect(details.code).toBeLessThanOrEqual(0);
});
