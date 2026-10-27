// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: { nonce: '00000000-0000-4000-8000-000000000001', generation: 1 },
  send: vi.fn(), invoke: vi.fn(), on: vi.fn(), start: vi.fn(), stop: vi.fn(), command: vi.fn()
}));
vi.mock('electron', () => ({ ipcRenderer: { send: mocks.send, invoke: mocks.invoke, on: mocks.on } }));
vi.mock('../src/connector/dom', () => ({ DomConnector: class {
  start = mocks.start; stop = mocks.stop; command = mocks.command;
} }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.send.mockReset(); vi.useFakeTimers();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 100 } as DOMRect);
  document.body.replaceChildren(); mocks.invoke.mockResolvedValue(mocks.session);
});
afterEach(() => {
  window.dispatchEvent(new Event('beforeunload'));
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren();
});
async function load() { await import('../src/preload/remote'); await Promise.resolve(); }
test('preload captures non-bubbling asset errors before the asynchronous session handshake resolves', async () => {
  let resolve!: (session: typeof mocks.session) => void;
  mocks.invoke.mockReturnValue(new Promise(done => { resolve = done; }));
  document.body.innerHTML = '<div id="initial_startup"></div><link rel="stylesheet" href="https://PRIVATE">';
  await load(); document.querySelector('link')!.dispatchEvent(new Event('error'));
  expect(mocks.send).not.toHaveBeenCalled();
  resolve(mocks.session); await Promise.resolve(); vi.advanceTimersByTime(2000);
  expect(mocks.send).toHaveBeenLastCalledWith('companion:boot-heartbeat', { ...mocks.session, phase: 'splash', progress: null,
    visible: true, online: true, assetFailed: true, assetFailureKind: 'stylesheet' });
  expect(JSON.stringify(mocks.send.mock.calls)).not.toContain('PRIVATE');
});

test('preload logs forced activation after 20s and continues splash heartbeats', async () => {
  document.body.innerHTML = '<div id="initial_startup"></div>'; await load();
  vi.advanceTimersByTime(19_999); expect(mocks.start).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(mocks.start).toHaveBeenCalledTimes(1);
  expect(mocks.send.mock.calls.filter(([channel]) => channel === 'companion:boot-deferral-expired'))
    .toEqual([['companion:boot-deferral-expired', mocks.session]]);
  vi.advanceTimersByTime(6000);
  expect(mocks.send).toHaveBeenLastCalledWith('companion:boot-heartbeat', { ...mocks.session, phase: 'splash', progress: null, visible: true, online: true });
  expect(mocks.start).toHaveBeenCalledTimes(1);
});
test('early empty document then splash does not start the preload connector', async () => {
  const state = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  await load(); expect(mocks.start).not.toHaveBeenCalled();
  document.body.innerHTML = '<div id="initial_startup"></div>'; state.mockReturnValue('complete');
  document.dispatchEvent(new Event('DOMContentLoaded')); vi.advanceTimersByTime(6000);
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.send).toHaveBeenLastCalledWith('companion:boot-heartbeat', { ...mocks.session, phase: 'splash', progress: null, visible: true, online: true });
  document.body.innerHTML = '<div id="pane-side"></div>'; vi.advanceTimersByTime(2000);
  expect(mocks.start).toHaveBeenCalledTimes(1);
});
test('unknown activation waits for grace and document completion, then starts once without a timeout diagnostic', async () => {
  const state = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  const body = vi.spyOn(document, 'body', 'get').mockReturnValue(null as unknown as HTMLElement);
  await load(); expect(mocks.start).not.toHaveBeenCalled();
  body.mockRestore(); document.dispatchEvent(new Event('DOMContentLoaded'));
  document.dispatchEvent(new Event('DOMContentLoaded')); vi.advanceTimersByTime(6000);
  expect(mocks.start).not.toHaveBeenCalled();
  state.mockReturnValue('complete'); vi.advanceTimersByTime(2000);
  expect(mocks.start).not.toHaveBeenCalled();
  vi.advanceTimersByTime(2000); expect(mocks.start).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(22_000);
  expect(mocks.start).toHaveBeenCalledTimes(1);
  expect(mocks.send.mock.calls.some(([channel]) => channel === 'companion:boot-deferral-expired')).toBe(false);
});
test('unknown document at the 20s cap logs expiry and waits for a document body', async () => {
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  const body = vi.spyOn(document, 'body', 'get').mockReturnValue(null as unknown as HTMLElement);
  await load(); vi.advanceTimersByTime(20_000);
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.send.mock.calls.filter(([channel]) => channel === 'companion:boot-deferral-expired'))
    .toEqual([['companion:boot-deferral-expired', mocks.session]]);
  body.mockRestore(); document.dispatchEvent(new Event('DOMContentLoaded'));
  document.dispatchEvent(new Event('DOMContentLoaded')); vi.advanceTimersByTime(6000);
  expect(mocks.start).toHaveBeenCalledTimes(1);
});
test('unload cancels activation waiting for the document body after the cap', async () => {
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  const body = vi.spyOn(document, 'body', 'get').mockReturnValue(null as unknown as HTMLElement);
  await load(); vi.advanceTimersByTime(20_000); window.dispatchEvent(new Event('beforeunload'));
  body.mockRestore(); document.dispatchEvent(new Event('DOMContentLoaded')); vi.advanceTimersByTime(22_000);
  expect(mocks.start).not.toHaveBeenCalled();
});

test('commands become available before the one-shot current-session readiness announcement; deferred commands are not replayed', async () => {
  document.body.innerHTML = '<div id="initial_startup"></div>';
  await load();
  const command = mocks.on.mock.calls.find(([channel]) => channel === 'companion:command')![1];
  command({}, { type: 'snapshot', nonce: mocks.session.nonce });
  command({}, { type: 'autoSend' });
  expect(mocks.command).not.toHaveBeenCalled();
  expect(mocks.send.mock.calls.some(([channel]) => channel === 'companion:connector-ready')).toBe(false);
  mocks.send.mockImplementation(channel => {
    if (channel === 'companion:connector-ready') command({}, { type: 'snapshot', nonce: mocks.session.nonce });
  });
  document.body.innerHTML = '<div id="pane-side"></div>'; vi.advanceTimersByTime(2000);
  expect(mocks.start).toHaveBeenCalledOnce();
  expect(mocks.command.mock.calls).toEqual([[{ type: 'snapshot', nonce: mocks.session.nonce }]]);
  expect(mocks.send.mock.calls.filter(([channel]) => channel === 'companion:connector-ready'))
    .toEqual([['companion:connector-ready', mocks.session]]);
  expect(mocks.start.mock.invocationCallOrder[0]).toBeLessThan(mocks.command.mock.invocationCallOrder[0]);
  vi.advanceTimersByTime(22_000);
  expect(mocks.send.mock.calls.filter(([channel]) => channel === 'companion:connector-ready')).toHaveLength(1);
  window.dispatchEvent(new Event('beforeunload'));
  command({}, { type: 'snapshot', nonce: mocks.session.nonce });
  expect(mocks.command).toHaveBeenCalledOnce();
});
test.each(['shell', 'login', 'blocked', 'unknown', 'splash'])('%s activation announces command readiness independently of shell detection', async phase => {
  const markup = { shell: '<div id="pane-side"></div>', login: '<div data-testid="qrcode"></div>', blocked: '<div data-testid="account-warning"></div>', unknown: '', splash: '<div id="initial_startup"></div>' };
  document.body.innerHTML = markup[phase as keyof typeof markup];
  await load(); vi.advanceTimersByTime(20_000);
  expect(mocks.send.mock.calls.filter(([channel]) => channel === 'companion:connector-ready'))
    .toEqual([['companion:connector-ready', mocks.session]]);
});
test('a boot handshake resolving after unload cannot start a detector or announce readiness', async () => {
  let resolve!: (session: typeof mocks.session) => void;
  mocks.invoke.mockReturnValue(new Promise(done => { resolve = done; }));
  document.body.innerHTML = '<div id="pane-side"></div>';
  await load(); window.dispatchEvent(new Event('beforeunload'));
  resolve(mocks.session); await Promise.resolve();
  vi.advanceTimersByTime(22_000);
  expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
});
test('a replacement document independently handshakes and announces its new generation', async () => {
  document.body.innerHTML = '<div id="pane-side"></div>'; await load();
  const oldCommand = mocks.on.mock.calls.find(([channel]) => channel === 'companion:command')![1];
  window.dispatchEvent(new Event('beforeunload'));
  const next = { nonce: '00000000-0000-4000-8000-000000000002', generation: 2 };
  vi.resetModules(); mocks.invoke.mockResolvedValue(next);
  await load();
  expect(mocks.invoke.mock.calls).toEqual([['companion:boot-session'], ['companion:boot-session']]);
  expect(mocks.send.mock.calls.filter(([channel]) => channel === 'companion:connector-ready'))
    .toEqual([['companion:connector-ready', mocks.session], ['companion:connector-ready', next]]);
  oldCommand({}, { type: 'snapshot', nonce: next.nonce }); expect(mocks.command).not.toHaveBeenCalled();
  const newCommand = mocks.on.mock.calls.filter(([channel]) => channel === 'companion:command').at(-1)![1];
  newCommand({}, { type: 'snapshot', nonce: next.nonce }); expect(mocks.command).toHaveBeenCalledOnce();
});
test('failed connector startup cannot announce readiness', async () => {
  mocks.start.mockImplementationOnce(() => { throw new Error('partial startup'); });
  document.body.innerHTML = '<div id="pane-side"></div>'; await load();
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(mocks.send).toHaveBeenCalledWith('companion:boot-error');
  expect(mocks.send.mock.calls.some(([channel]) => channel === 'companion:connector-ready')).toBe(false);
});
