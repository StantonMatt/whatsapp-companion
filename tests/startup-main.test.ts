// @vitest-environment jsdom
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DomConnector } from '../src/connector/dom';
import type { RemoteCommand } from '../src/shared/connector';
import { emptySnapshot } from '../src/shared/model';

const mocks = vi.hoisted(() => ({
  app: undefined as any, ipc: undefined as any, windows: [] as any[], views: [] as any[],
  records: [] as { event: string; details: any }[], handlers: new Map<string, (...args: any[]) => any>(), errors: vi.fn(), messageBox: vi.fn(), renderer: { on: vi.fn(), invoke: vi.fn(), send: vi.fn() }
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const makeSession = () => Object.assign(new EventEmitter(), {
    protocol: { handle: vi.fn() }, setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn()
  });
  class Contents extends EventEmitter {
    session = makeSession(); destroyed = false; url = ''; throttling = true;
    frame = { url: '', isDestroyed: () => false };
    get mainFrame() { return this.frame; }
    send = vi.fn(); close = vi.fn(() => { this.destroyed = true; this.emit('destroyed'); });
    reload = vi.fn(() => { this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); });
    isDestroyed() { return this.destroyed; }
    getURL() { return this.url; }
    async loadURL(url: string) {
      this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      this.url = this.frame.url = url; this.emit('dom-ready'); this.emit('did-finish-load');
    }
    setBackgroundThrottling(value: boolean) { this.throttling = value; }
    setUserAgent() {} setWindowOpenHandler() {} setZoomMode() {}
    async setVisualZoomLevelLimits() {} getZoomFactor() { return 1; }
    focus() {} isFocused() { return false; }
  }
  class View {
    webContents = new Contents(); bounds = { x: 0, y: 0, width: 1280, height: 860 };
    constructor(public options: any) { this.webContents.throttling = options.webPreferences.backgroundThrottling ?? true; mocks.views.push(this); }
    setBounds(bounds: any) { this.bounds = bounds; } getBounds() { return this.bounds; }
    setVisible() {} setBackgroundColor() {}
  }
  class Window extends EventEmitter {
    webContents = new Contents(); destroyed = false; minimized = false; visible = true;
    focus = vi.fn(); restore = vi.fn(() => { this.minimized = false; });
    contentView = Object.assign(new EventEmitter(), { children: [] as View[],
      addChildView: (view: View) => this.contentView.children.push(view), getBounds: () => ({ width: 1280, height: 860 }) });
    constructor() { super(); mocks.windows.push(this); }
    isDestroyed() { return this.destroyed; } isMinimized() { return this.minimized; } isVisible() { return this.visible; }
    async loadURL(url: string) { await this.webContents.loadURL(url); }
    close() { let prevented = false; this.emit('close', { preventDefault: () => { prevented = true; } }); if (!prevented) { this.destroyed = true; this.emit('closed'); } }
  }
  mocks.ipc = Object.assign(new EventEmitter(), { handle: (name: string, handler: (...args: any[]) => any) => mocks.handlers.set(name, handler) });
  mocks.app = Object.assign(new EventEmitter(), {
    isPackaged: false, directory: '',
    commandLine: { removeSwitch() {}, hasSwitch: () => true, appendSwitch() {} }, enableSandbox() {}, setName() {},
    setPath(_name: string, value: string) { this.directory = value; }, getPath() { return this.directory; },
    getVersion: () => '0.1.0', requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), quit: vi.fn()
  });
  return { ipcRenderer: mocks.renderer, app: mocks.app, BrowserWindow: Window, WebContentsView: View, ipcMain: mocks.ipc,
    session: { defaultSession: makeSession() }, protocol: { registerSchemesAsPrivileged() {} },
    dialog: { showErrorBox: mocks.errors, showMessageBox: mocks.messageBox }, shell: {},
    Menu: { buildFromTemplate: (value: unknown) => value, setApplicationMenu() {} } };
});
vi.mock('../src/main/vault', () => ({
  configuredBackend: () => undefined, promptKey: vi.fn(), Vault: class { has() { return false; } secure() { return true; } }
}));
vi.mock('../src/main/context-menu', () => ({ installEditContextMenus() {} }));
vi.mock('../src/main/startup-diagnostics', () => ({ StartupDiagnostics: class {
  record(event: string, details: any = {}) { mocks.records.push({ event, details }); } flush() { return Promise.resolve(); }
} }));
let directory: string, args: string[];
beforeEach(async () => {
  vi.resetModules(); mocks.app?.removeAllListeners(); mocks.ipc?.removeAllListeners(); mocks.app?.quit.mockReset();
  mocks.windows.length = mocks.views.length = mocks.records.length = 0; mocks.handlers.clear(); mocks.errors.mockClear(); mocks.messageBox.mockReset().mockResolvedValue({ response: 0 });
  directory = mkdtempSync(join(tmpdir(), 'startup-main-')); args = process.argv;
  process.argv = [...args, '--fixture', `--data-dir=${directory}`]; vi.stubGlobal('__dirname', '/fixture-build');
  await import('../src/main/index');
  await vi.waitFor(() => { expect(mocks.errors).not.toHaveBeenCalled(); expect(mocks.views[1]?.webContents.url).toContain('fixture.html'); });
});
afterEach(async () => {
  mocks.windows[0]?.close();
  await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalled());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); process.argv = args; rmSync(directory, { recursive: true, force: true });
});
function bootEvent() { const contents = mocks.views[1].webContents; return { sender: contents, senderFrame: contents.mainFrame }; }
function bootSession() { return mocks.handlers.get('companion:boot-session')!(bootEvent()); }
function snapshotRequests() { return mocks.views[1].webContents.send.mock.calls.filter(([, command]: any[]) => command?.type === 'snapshot'); }
function connectorReady(session = bootSession()) { mocks.ipc.emit('companion:connector-ready', bootEvent(), session); }
function acknowledgeSnapshot() {
  const nonce = snapshotRequests().at(-1)?.[1].nonce;
  expect(nonce).toBeDefined();
  mocks.ipc.emit('companion:event', bootEvent(), { type: 'snapshot', nonce, snapshot: { ...emptySnapshot,
    chatId: '123@c.us', name: 'Alex', ready: true, conversationOpen: true, revision: 'fixture',
    messages: [{ id: 'false_123@c.us_a', text: 'Hello', outgoing: false }] } });
}
function expectManualNotice() {
  mocks.ipc.emit('companion:event', bootEvent(), { type: 'request' });
  expect(mocks.views[1].webContents.send.mock.calls).toContainEqual(['companion:command', {
    type: 'notice', text: expect.stringContaining('Enable conversation context in AI settings')
  }]);
}
test('load before splash-delayed activation does not spend snapshot retries; ready recovers assistance and initializes chrome', () => {
  const contents = mocks.views[1].webContents;
  vi.useFakeTimers();
  try {
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    contents.send.mockClear(); contents.emit('did-finish-load');
    vi.advanceTimersByTime(6000);
    expect(snapshotRequests()).toHaveLength(0);
    mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), { ...bootSession(), phase: 'shell', progress: null, visible: true, online: true });
    expect(snapshotRequests()).toHaveLength(0);
    contents.send.mockClear(); connectorReady();
    expect(contents.send.mock.calls).toContainEqual(['companion:command', expect.objectContaining({ type: 'chrome' })]);
    expect(snapshotRequests()).toHaveLength(1);
    acknowledgeSnapshot(); expectManualNotice();
    connectorReady(); expect(snapshotRequests()).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});
test('readiness authenticates the current remote frame and session before resuming assistance', () => {
  const valid = bootSession(), contents = mocks.views[1].webContents;
  contents.send.mockClear();
  for (const raw of [null, { ...valid, generation: valid.generation - 1 }, { ...valid, nonce: '00000000-0000-4000-8000-000000000002' }, { ...valid, text: 'PRIVATE' }])
    connectorReady(raw as typeof valid);
  mocks.ipc.emit('companion:connector-ready', { ...bootEvent(), sender: mocks.views[0].webContents }, valid);
  mocks.ipc.emit('companion:connector-ready', { ...bootEvent(), senderFrame: { ...contents.frame } }, valid);
  const url = contents.frame.url;
  contents.frame.url = 'https://untrusted.invalid/'; connectorReady(valid); contents.frame.url = url;
  expect(snapshotRequests()).toHaveLength(0);
  connectorReady(); expect(snapshotRequests()).toHaveLength(1); acknowledgeSnapshot(); expectManualNotice();
});
test.each(['reload', 'crash then reload'])('%s issues a fresh boot session and re-establishes assistance only after that connector activates', mode => {
  const contents = mocks.views[1].webContents, prior = bootSession();
  connectorReady(); acknowledgeSnapshot();
  if (mode === 'crash then reload') {
    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(bootSession().nonce).not.toBe(prior.nonce);
    contents.send.mockClear(); connectorReady(prior); expect(snapshotRequests()).toHaveLength(0);
  }
  contents.reload(); const current = bootSession();
  expect(current.generation).toBeGreaterThan(prior.generation); expect(current.nonce).not.toBe(prior.nonce);
  contents.send.mockClear(); contents.emit('did-finish-load'); connectorReady(prior);
  expect(snapshotRequests()).toHaveLength(0);
  connectorReady(current); acknowledgeSnapshot(); expectManualNotice();
});
test('in-page navigation retains the active document session and connector instead of stranding assistance', () => {
  const contents = mocks.views[1].webContents, current = bootSession();
  connectorReady(); acknowledgeSnapshot(); contents.send.mockClear();
  contents.frame.url = `${contents.frame.url.split('#')[0]}#another-chat`;
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  contents.emit('did-navigate-in-page', {}, contents.frame.url, true);
  expect(bootSession()).toEqual(current); expect(snapshotRequests()).toHaveLength(0);
  expectManualNotice();
});
test('real main wiring authenticates boot sender/frame/origin and changes nonce on document navigation only', () => {
  const valid = bootSession(); expect(valid.generation).toBe(1);
  const session = mocks.handlers.get('companion:boot-session')!;
  expect(session({ ...bootEvent(), sender: mocks.views[0].webContents })).toBeNull();
  expect(session({ ...bootEvent(), senderFrame: { ...bootEvent().senderFrame } })).toBeNull();
  const contents = mocks.views[1].webContents, url = contents.frame.url;
  contents.frame.url = 'https://untrusted.invalid/'; expect(session(bootEvent())).toBeNull(); contents.frame.url = url;
  contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false }); expect(bootSession()).toEqual(valid);
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true }); expect(bootSession()).toEqual(valid);
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  expect(bootSession()).toMatchObject({ generation: 2 }); expect(bootSession().nonce).not.toBe(valid.nonce);
});
test('main sets startup throttling false and restores it only on an authenticated shell heartbeat', () => {
  const contents = mocks.views[1].webContents, heartbeat = { ...bootSession(), phase: 'splash', progress: null, visible: true, online: true };
  expect(contents.throttling).toBe(false);
  mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), { ...heartbeat, phase: 'login' }); expect(contents.throttling).toBe(false);
  mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), { ...heartbeat, generation: 0, phase: 'shell' }); expect(contents.throttling).toBe(false);
  mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), { ...heartbeat, phase: 'shell' }); expect(contents.throttling).toBe(true);
});
test('splash deferral expiry is logged only for the trusted current boot session', () => {
  const current = bootSession();
  for (const raw of [{ ...current, generation: 0 }, { ...current, nonce: '00000000-0000-4000-8000-000000000002' }, { ...current, text: 'PRIVATE' }])
    mocks.ipc.emit('companion:boot-deferral-expired', bootEvent(), raw);
  mocks.ipc.emit('companion:boot-deferral-expired', { ...bootEvent(), sender: mocks.views[0].webContents }, current);
  expect(mocks.records.filter(record => record.event === 'connector-deferral-expired')).toHaveLength(0);
  mocks.ipc.emit('companion:boot-deferral-expired', bootEvent(), current);
  expect(mocks.records.filter(record => record.event === 'connector-deferral-expired')).toEqual([
    { event: 'connector-deferral-expired', details: { generation: current.generation } }
  ]);
});
test('initialization failure after shutdown handlers are installed closes the window before quitting', async () => {
  const Window = mocks.windows[0].constructor;
  mocks.windows[0].close();
  await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
  mocks.app.removeAllListeners(); mocks.ipc.removeAllListeners(); mocks.app.quit.mockClear();
  mocks.windows.length = mocks.views.length = mocks.records.length = 0; mocks.handlers.clear();
  vi.spyOn(Window.prototype, 'loadURL').mockRejectedValue(new Error('native window load failed'));
  // Electron's quit may be cancelled by a window's asynchronous close handler.
  // The final quit must therefore happen only after that handler has drained.
  mocks.app.quit.mockImplementation(() => { expect(mocks.windows[0].isDestroyed()).toBe(true); });
  vi.resetModules();
  await import('../src/main/index');
  await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
  expect(mocks.errors).toHaveBeenCalledOnce();
  expect(mocks.records.map(record => record.event)).toEqual(expect.arrayContaining(['intake-drained', 'views-destroyed', 'quit']));
});
test('before-quit closes initialized views and flushes through the shared quit path', async () => {
  const preventDefault = vi.fn();
  mocks.app.emit('before-quit', { preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
  expect(mocks.views[0].webContents.close).toHaveBeenCalledOnce();
  expect(mocks.views[1].webContents.close).toHaveBeenCalledOnce();
  expect(mocks.records.filter(record => record.event === 'quit')).toHaveLength(1);
});
test('close blocks second instance and renderer IPC immediately; disposed frame and thrown view close still quit', async () => {
  const win = mocks.windows[0], remote = mocks.views[1].webContents, controls = mocks.views[0].webContents;
  Object.defineProperty(remote, 'mainFrame', { get() { throw new Error('disposed'); } });
  remote.send.mockClear(); controls.send.mockClear();
  remote.send.mockImplementation(() => { throw new Error('send'); });
  controls.send.mockImplementation(() => { throw new Error('send'); });
  remote.close.mockImplementation(() => { throw new Error('close'); });
  win.close(); mocks.app.emit('second-instance');
  expect(win.focus).not.toHaveBeenCalled(); expect(win.restore).not.toHaveBeenCalled();
  expect(remote.send).not.toHaveBeenCalled(); expect(controls.send).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalled());
  expect(remote.close).toHaveBeenCalledOnce(); expect(controls.close).toHaveBeenCalledOnce();
  expect(mocks.records.map(record => record.event)).toEqual(expect.arrayContaining(['close-requested', 'intake-drained', 'views-destroyed', 'quit']));
});


test('main watchdog actually reloads remote webContents and preserves its budget across navigation generations', () => {
  const contents = mocks.views[1].webContents, clock = vi.spyOn(performance, 'now');
  let session = bootSession();
  connectorReady(session); acknowledgeSnapshot();
  const observe = (now: number) => {
    clock.mockReturnValue(now);
    mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), { ...session, phase: 'splash', progress: 1, visible: true, online: true });
  };
  for (let now = 0; now <= 60_000; now += 2000) observe(now);
  expect(contents.reload).toHaveBeenCalledTimes(1);
  const prior = session; session = bootSession(); expect(session.generation).toBe(prior.generation + 1);
  contents.send.mockClear(); contents.emit('did-finish-load'); connectorReady(prior);
  expect(snapshotRequests()).toHaveLength(0);
  connectorReady(session); acknowledgeSnapshot(); expectManualNotice();
  // Stale heartbeats cannot contribute to the second observation window.
  clock.mockReturnValue(62_000);
  mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), { ...prior, phase: 'splash', progress: 1, visible: true, online: true });
  for (let now = 62_000; now <= 178_000; now += 2000) observe(now);
  expect(contents.reload).toHaveBeenCalledTimes(1);
  observe(180_000); expect(contents.reload).toHaveBeenCalledTimes(2); session = bootSession();
  contents.send.mockClear(); contents.emit('did-finish-load');
  expect(snapshotRequests()).toHaveLength(0);
  connectorReady(session); acknowledgeSnapshot(); expectManualNotice();
  for (let now = 182_000; now <= 400_000; now += 2000) observe(now);
  expect(contents.reload).toHaveBeenCalledTimes(2);
  expect(mocks.records.filter(record => record.event === 'reload').map(record => record.details.reloads)).toEqual([1, 2]);
});
test('main layout retains positive remote bounds while parent reports zero, then follows positive bounds', () => {
  const win = mocks.windows[0], remote = mocks.views[1], bounds = { ...remote.bounds };
  const readBounds = vi.spyOn(win.contentView, 'getBounds');
  readBounds.mockReturnValue({ width: 0, height: 0 }); win.contentView.emit('bounds-changed');
  expect(remote.bounds).toEqual(bounds);
  expect(mocks.records.some(record => record.event === 'bounds-rejected')).toBe(true);
  readBounds.mockReturnValue({ width: 1440, height: 900 }); win.contentView.emit('bounds-changed');
  expect(remote.bounds).toMatchObject({ width: 1440, height: 900 });
});


test.each([['media', false], ['notifications', false], ['media', true], ['notifications', true]] as const)('watchdog stays paused until overlapping prompts close (first %s, second rejected %s)', async (first, rejected) => {
  const contents = mocks.views[1].webContents, session = bootSession(), clock = vi.spyOn(performance, 'now');
  const pending = new Map<string, { resolve: (value: { response: number }) => void; reject: (error: Error) => void }>();
  mocks.messageBox.mockImplementation((_win, options) => new Promise((resolve, reject) => {
    pending.set(options.message.includes('microphone') ? 'media' : 'notifications', { resolve, reject });
  }));
  const request = contents.session.setPermissionRequestHandler.mock.calls.at(-1)[0];
  const callbacks = { media: vi.fn(), notifications: vi.fn() };
  const frame = { isMainFrame: true, requestingUrl: contents.frame.url };
  const observe = (now: number) => {
    clock.mockReturnValue(now);
    mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), { ...session, phase: 'splash', progress: 1, visible: true, online: true });
  };
  for (let now = 0; now <= 40_000; now += 2000) observe(now);
  request(contents, 'media', callbacks.media, frame);
  request(contents, 'notifications', callbacks.notifications, frame);
  expect(pending.size).toBe(2);
  for (let now = 42_000; now <= 110_000; now += 2000) observe(now);
  expect(contents.reload).not.toHaveBeenCalled();
  pending.get(first)!.resolve({ response: 0 });
  await vi.waitFor(() => expect(callbacks[first]).toHaveBeenCalledExactlyOnceWith(false));
  for (let now = 112_000; now <= 190_000; now += 2000) observe(now);
  expect(contents.reload).not.toHaveBeenCalled();
  const second = first === 'media' ? 'notifications' : 'media';
  if (rejected) pending.get(second)!.reject(new Error('dialog closed'));
  else pending.get(second)!.resolve({ response: 1 });
  await vi.waitFor(() => expect(callbacks[second]).toHaveBeenCalledExactlyOnceWith(!rejected));
  for (let now = 192_000; now < 252_000; now += 2000) observe(now);
  expect(contents.reload).not.toHaveBeenCalled();
  observe(252_000); expect(contents.reload).toHaveBeenCalledTimes(1);
});


// Real main IPC handlers, preload, BootDetector, DomConnector and Assistant.
// Only Electron transport/native geometry and native editing are simulated.
test.each(['refinement', 'automatic suggestion', 'continuation'] as const)('%s survives repeated post-activation boot heartbeats', async operation => {
  vi.useFakeTimers();
  const contents = mocks.views[1].webContents;
  const commands: RemoteCommand[] = [];
  const events: { channel: string; payload: any }[] = [];
  let deliver: (_event: unknown, command: RemoteCommand) => void = () => {};
  let connector!: DomConnector;
  const { DomConnector: Connector } = await import('../src/connector/dom');
  const listeners = new Map<EventTarget, EventListener>();
  for (const prototype of [HTMLButtonElement.prototype, HTMLInputElement.prototype]) {
    const add = prototype.addEventListener;
    vi.spyOn(prototype, 'addEventListener').mockImplementation(function (this: HTMLElement, type, listener, options) {
      if ((type === 'click' || type === 'keydown') && typeof listener === 'function') listeners.set(this, listener as EventListener);
      return add.call(this, type, listener, options);
    });
  }
  const start = Connector.prototype.start;
  vi.spyOn(Connector.prototype, 'start').mockImplementation(function (this: DomConnector) { connector = this; start.call(this); });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 600, left: 0, top: 200, right: 800, bottom: 800 } as DOMRect);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  document.body.innerHTML = '<div id="pane-side"></div><div id="main"><header><span title="Alex">Alex</span></header><div data-id="false_123@c.us_a"><span class="selectable-text copyable-text">Hello</span></div><footer><div contenteditable="true" role="textbox" tabindex="0"></div></footer></div>';
  const editor = document.querySelector<HTMLElement>('[role=textbox]')!;
  if (operation !== 'automatic suggestion') editor.textContent = 'A long draft to make warmer';
  const focusEnd = () => {
    editor.focus(); const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
  };
  focusEnd();
  const previousInsert = document.execCommand;
  document.execCommand = vi.fn((_command: string, _ui: boolean, text: string) => {
    const selection = document.getSelection()!, range = selection.getRangeAt(0);
    range.deleteContents(); range.insertNode(document.createTextNode(text)); focusEnd();
    editor.dispatchEvent(new InputEvent('input', { bubbles: true })); return true;
  });
  mocks.renderer.on.mockImplementation((channel, handler) => { if (channel === 'companion:command') deliver = handler; });
  mocks.renderer.invoke.mockImplementation((channel, ...args) => Promise.resolve(mocks.handlers.get(channel)!(bootEvent(), ...args)));
  mocks.renderer.send.mockImplementation((channel, payload) => { events.push({ channel, payload }); setTimeout(() => mocks.ipc.emit(channel, bootEvent(), payload), 0); });
  contents.send.mockImplementation((channel: string, command: RemoteCommand) => {
    if (channel === 'companion:command') { commands.push(command); setTimeout(() => deliver({}, command), 0); }
  });
  // More than four heartbeat intervals elapse while generation is pending.
  (globalThis as any).fixtureGenerationDelayMs = 10_000;
  try {
    await import('../src/preload/remote');
    await vi.advanceTimersByTimeAsync(700);
    expect(connector.read().ready).toBe(true);
    expect(events.filter(event => event.channel === 'companion:connector-ready')).toHaveLength(1);
    const action = mocks.handlers.get('companion:action')!;
    const local = { sender: mocks.views[0].webContents, senderFrame: mocks.views[0].webContents.mainFrame };
    expect(await action(local, { type: 'preferences', scope: 'global', patch: { suggestions: operation !== 'refinement', shareContext: true } })).toEqual({ ok: true });
    if (operation === 'refinement') {
      await vi.advanceTimersByTimeAsync(100);
      listeners.get(connector['button'])!.call(connector['button'], { isTrusted: true } as Event);
      await vi.advanceTimersByTimeAsync(700); // Form survives polls/queued IPC.
      expect(connector['popup'].hidden).toBe(false);
      const instruction = connector['popup'].querySelector('input')!;
      expect(document.activeElement).toBe(connector['host']);
      instruction.value = 'Make it warmer';
      connector['keydown']({ isTrusted: true, key: 'Enter', target: connector['host'] } as unknown as KeyboardEvent);
      listeners.get(instruction)!.call(instruction, { isTrusted: true, key: 'Enter', preventDefault() {}, stopPropagation() {} } as KeyboardEvent);
      await vi.advanceTimersByTimeAsync(10);
    } else await vi.advanceTimersByTimeAsync(1100);
    const pending = connector['pending']!;
    expect(pending).toMatchObject({ type: operation === 'refinement' ? 'refining' : 'thinking' });
    const snapshots = commands.filter(command => command.type === 'snapshot').length;
    const heartbeats = events.filter(event => event.channel === 'companion:boot-heartbeat').length;
    // Duplicate readiness, finish-loading-independent heartbeats, visibility
    // and online changes must never introduce a fresh assistant barrier.
    mocks.ipc.emit('companion:connector-ready', bootEvent(), bootSession());
    for (let i = 0; i < 4; i++) {
      mocks.windows[0].visible = i % 2 === 0; mocks.windows[0].emit(i % 2 ? 'hide' : 'show');
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: i % 2 === 0 });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: i % 2 ? 'hidden' : 'visible' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(connector['pending']?.requestId).toBe(pending.requestId);
      expect(connector['ghost'].querySelector('.dots')).not.toBeNull();
      expect(connector['popup'].hidden).toBe(true);
    }
    expect(events.filter(event => event.channel === 'companion:boot-heartbeat').length).toBeGreaterThanOrEqual(heartbeats + 4);
    expect(events.filter(event => event.channel === 'companion:connector-ready')).toHaveLength(1);
    expect(commands.filter(command => command.type === 'snapshot')).toHaveLength(snapshots);
    expect(contents.reload).not.toHaveBeenCalled();
    mocks.windows[0].visible = true; mocks.windows[0].emit('show');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    await vi.advanceTimersByTimeAsync(3000);
    if (operation === 'refinement') expect(editor.textContent).toBe('That sounds lovely. See you then!');
    else {
      expect(connector['suggestion']?.text).toBe(operation === 'continuation' ? ' see you then!' : 'Sounds good, see you then!');
      connector['acceptSuggestion']();
      await vi.advanceTimersByTimeAsync(100);
      expect(editor.textContent).toBe(operation === 'continuation' ? 'A long draft to make warmer see you then!' : 'Sounds good, see you then!');
    }
    expect(connector['pending']).toBeUndefined();
    expect(events.some(event => event.channel === 'companion:event' && event.payload.type === 'applied')).toBe(true);
  } finally {
    window.dispatchEvent(new Event('beforeunload'));
    delete (globalThis as any).fixtureGenerationDelayMs;
    document.execCommand = previousInsert;
    delete (document as any).visibilityState; delete (navigator as any).onLine;
    document.getSelection()?.removeAllRanges(); document.body.replaceChildren();
    mocks.windows[0].close(); await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
  }
});
