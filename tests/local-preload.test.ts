import { beforeEach, expect, test, vi } from 'vitest';
import type { DesktopAPI, StatusUpdate } from '../src/shared/model';

const mocks = vi.hoisted(() => ({
  api: undefined as DesktopAPI | undefined,
  on: vi.fn(), send: vi.fn(), removeListener: vi.fn(), invoke: vi.fn()
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: DesktopAPI) => { mocks.api = api; } },
  ipcRenderer: mocks
}));

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  await import('../src/preload/local');
});

test('every controls subscription requests a full publication after registering its listener', () => {
  const receive = vi.fn();
  for (let i = 0; i < 2; i++) {
    const stop = mocks.api!.subscribe(receive);
    const listener = mocks.on.mock.calls[i][1];
    expect(mocks.on.mock.calls[i][0]).toBe('companion:status');
    expect(mocks.send.mock.calls[i]).toEqual(['companion:subscribe']);
    expect(mocks.on.mock.invocationCallOrder[i]).toBeLessThan(mocks.send.mock.invocationCallOrder[i]);
    const update: StatusUpdate = { sequence: i + 1, panel: 'stickers' };
    listener({}, update);
    expect(receive).toHaveBeenLastCalledWith(update);
    stop();
    expect(mocks.removeListener).toHaveBeenLastCalledWith('companion:status', listener);
  }
});
