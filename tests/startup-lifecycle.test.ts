import { test, expect, vi } from 'vitest';
import { cleanupOnce, safeRendererSend, requireRendererSend, positiveBounds, startupThrottling, quitAfterFlush } from '../src/main/lifecycle';

test('frame availability, destroyed state, closing and thrown sends all fail closed', () => {
  const send = vi.fn();
  const contents = { isDestroyed: () => false, mainFrame: { isDestroyed: () => false }, send };
  expect(safeRendererSend(contents, false, 'command')).toBe(true);
  expect(safeRendererSend(contents, true, 'command')).toBe(false);
  expect(safeRendererSend({ ...contents, isDestroyed: () => true }, false, 'command')).toBe(false);
  expect(safeRendererSend({ ...contents, mainFrame: null }, false, 'command')).toBe(false);
  expect(safeRendererSend({ ...contents, mainFrame: { isDestroyed: () => true } }, false, 'command')).toBe(false);
  expect(safeRendererSend({ ...contents, get mainFrame(): never { throw new Error('disposed'); } }, false, 'command')).toBe(false);
  send.mockImplementation(() => { throw new Error('disposed send'); });
  expect(safeRendererSend(contents, false, 'command')).toBe(false);
});
test('required delivery propagates dispatch errors and rejects unavailable frames before sending', () => {
  const send = vi.fn();
  const contents = { isDestroyed: () => false, mainFrame: { isDestroyed: () => false }, send };
  requireRendererSend(contents, false, 'command');
  send.mockClear();
  for (const unavailable of [
    { ...contents, isDestroyed: () => true },
    { ...contents, mainFrame: null },
    { ...contents, mainFrame: { isDestroyed: () => true } }
  ]) expect(() => requireRendererSend(unavailable, false, 'command')).toThrow('Renderer unavailable');
  expect(() => requireRendererSend(contents, true, 'command')).toThrow('Renderer unavailable');
  expect(send).not.toHaveBeenCalled();
  const error = new Error('dispatch failed');
  send.mockImplementation(() => { throw error; });
  expect(() => requireRendererSend(contents, false, 'command')).toThrow(error);
});
test('cleanup continues through thrown cancellation and close, closes both views, always quits, once', () => {
  const order: string[] = [], quit = vi.fn(() => order.push('quit'));
  const cleanup = cleanupOnce([
    () => { order.push('cancel'); throw new Error('cancel'); },
    () => { order.push('remote'); throw new Error('close'); },
    () => { order.push('controls'); }
  ], quit);
  cleanup(); cleanup();
  expect(order).toEqual(['cancel', 'remote', 'controls', 'quit']); expect(quit).toHaveBeenCalledOnce();
});
test('throttling restores once after first shell; disposed webContents are ignored', () => {
  const setBackgroundThrottling = vi.fn();
  const restore = startupThrottling({ isDestroyed: () => false, setBackgroundThrottling });
  expect(setBackgroundThrottling).not.toHaveBeenCalled(); restore(); restore();
  expect(setBackgroundThrottling).toHaveBeenCalledExactlyOnceWith(true);
  startupThrottling({ isDestroyed: () => true, setBackgroundThrottling })();
  expect(setBackgroundThrottling).toHaveBeenCalledTimes(1);
});
test('zero/nonfinite bounds are rejected until positive size arrives', () => {
  for (const bounds of [{ width: 0, height: 800 }, { width: 1200, height: 0 }, { width: NaN, height: 10 }, { width: -1, height: 20 }]) expect(positiveBounds(bounds)).toBe(false);
  expect(positiveBounds({ width: 1280, height: 860 })).toBe(true);
});


test('diagnostic errors and a stuck writer cannot prevent quitting or leave a flush timer', async () => {
  vi.useFakeTimers();
  try {
    const quit = vi.fn();
    await quitAfterFlush(() => Promise.reject(new Error('disk')), quit);
    expect(quit).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    const pending = quitAfterFlush(() => new Promise(() => {}), quit);
    await vi.advanceTimersByTimeAsync(1000); await pending;
    expect(quit).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
