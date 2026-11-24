// @vitest-environment jsdom
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DomConnector } from '../src/connector/dom';
import type { RemoteCommand } from '../src/shared/connector';
import { emptySnapshot, initialState } from '../src/shared/model';

const mocks = vi.hoisted(() => ({
  app: undefined as any, ipc: undefined as any, windows: [] as any[], views: [] as any[],
  trays: [] as any[], trayFailure: false, activateOnLoad: false, pendingRemoteLoad: undefined as Promise<void> | undefined,
  menus: [] as any[], images: [] as any[], power: undefined as any,
  vaultKeys: new Map<string, string>(), vaultSet: vi.fn(), secure: true, external: vi.fn(), generator: vi.fn(),
  records: [] as { event: string; details: any }[], handlers: new Map<string, (...args: any[]) => any>(), errors: vi.fn(), messageBox: vi.fn(), renderer: { on: vi.fn(), invoke: vi.fn(), send: vi.fn() }
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const makeSession = () => Object.assign(new EventEmitter(), {
    protocol: { handle: vi.fn() }, setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), setUserAgent: vi.fn()
  });
  class Contents extends EventEmitter {
    session = makeSession(); destroyed = false; url = ''; throttling = true; loaded = false;
    frame = { url: '', isDestroyed: () => false };
    get mainFrame() { return this.frame; }
    send = vi.fn(); close = vi.fn(() => { this.destroyed = true; this.emit('destroyed'); });
    stop = vi.fn();
    reload = vi.fn(() => { this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); });
    isDestroyed() { return this.destroyed; }
    getURL() { return this.url; }
    async loadURL(url: string) {
      this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      this.url = this.frame.url = url;
      if (mocks.activateOnLoad) { mocks.activateOnLoad = false; mocks.app.emit('activate'); }
      if (url.startsWith('companion-fixture-stall:')) await new Promise<void>(() => {});
      if (url.includes('fixture.html')) await mocks.pendingRemoteLoad;
      this.loaded = true; this.emit('dom-ready'); this.emit('did-finish-load');
    }
    setBackgroundThrottling(value: boolean) { this.throttling = value; }
    setUserAgent = vi.fn(); setWindowOpenHandler() {} setZoomMode() {}
    async setVisualZoomLevelLimits() {} getZoomFactor() { return 1; }
    focus() { this.emit('focus'); } isFocused() { return false; }
  }
  class View {
    webContents = new Contents(); bounds = { x: 0, y: 0, width: 1280, height: 860 };
    initialUserAgent: string | undefined;
    constructor(public options: any) {
      this.initialUserAgent = options.webPreferences.session?.setUserAgent.mock.lastCall?.[0];
      this.webContents.session = options.webPreferences.session ?? this.webContents.session;
      this.webContents.throttling = options.webPreferences.backgroundThrottling ?? true; mocks.views.push(this);
    }
    setBounds(bounds: any) { this.bounds = bounds; } getBounds() { return this.bounds; }
    setVisible() {} setBackgroundColor() {}
  }
  class Window extends EventEmitter {
    webContents = new Contents(); destroyed = false; minimized = false; visible = true;
    focus = vi.fn(() => { this.emit('focus'); }); moveTop = vi.fn(); setSkipTaskbar = vi.fn();
    show = vi.fn(() => { this.visible = true; this.emit('show'); });
    hide = vi.fn(() => { this.visible = false; this.emit('hide'); });
    restore = vi.fn(() => { this.minimized = false; this.emit('restore'); });
    contentView = Object.assign(new EventEmitter(), { children: [] as View[],
      addChildView: (view: View) => this.contentView.children.push(view), getBounds: () => ({ width: 1280, height: 860 }) });
    constructor(options: any) { super(); this.visible = options.show !== false; mocks.windows.push(this); }
    isFocused() { return this.visible && !this.minimized; }
    isDestroyed() { return this.destroyed; } isMinimized() { return this.minimized; } isVisible() { return this.visible; }
    async loadURL(url: string) { await this.webContents.loadURL(url); }
    close() { let prevented = false; this.emit('close', { preventDefault: () => { prevented = true; } }); if (!prevented) { this.destroyed = true; this.emit('closed'); } }
  }
  mocks.ipc = Object.assign(new EventEmitter(), { handle: (name: string, handler: (...args: any[]) => any) => mocks.handlers.set(name, handler) });
  mocks.app = Object.assign(new EventEmitter(), {
    isPackaged: false, directory: '',
    commandLine: { removeSwitch() {}, hasSwitch: () => true, appendSwitch() {}, getSwitchValue: vi.fn(() => 'wayland') }, enableSandbox() {}, setName() {},
    setPath(_name: string, value: string) { this.directory = value; }, getPath() { return this.directory; },
    getVersion: () => '0.1.0', requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), quit: vi.fn(), relaunch: vi.fn()
  });
  mocks.power = new EventEmitter();
  class Tray extends EventEmitter {
    menu: any; setToolTip = vi.fn(); destroy = vi.fn();
    setContextMenu(menu: any) { this.menu = menu; }
    constructor(public image: any) { super(); if (mocks.trayFailure) throw new Error('no tray'); mocks.trays.push(this); }
  }
  return { contextBridge: { executeInMainWorld: vi.fn() }, Tray, powerMonitor: mocks.power, nativeImage: {
    createEmpty: () => { const image = { addRepresentation: vi.fn() }; mocks.images.push(image); return image; },
    createFromPath: (path: string) => ({ isEmpty: () => false, toPNG: () => Buffer.from(path) })
  }, ipcRenderer: mocks.renderer, app: mocks.app, BrowserWindow: Window, WebContentsView: View, ipcMain: mocks.ipc,
    session: { defaultSession: makeSession(), fromPartition: vi.fn(() => makeSession()) }, protocol: { registerSchemesAsPrivileged() {} },
    dialog: { showErrorBox: mocks.errors, showMessageBox: mocks.messageBox }, shell: { openExternal: mocks.external },
    Menu: { buildFromTemplate: (value: unknown) => { mocks.menus.push(value); return value; }, setApplicationMenu() {} } };
});
vi.mock('../src/main/vault', () => ({
  configuredBackend: () => undefined, Vault: class {
    has(provider: string) { return mocks.vaultKeys.has(provider); }
    secure() { return mocks.secure; }
    get(provider: string) { return mocks.vaultKeys.get(provider); }
    set(provider: string, key: string, persist: boolean) { mocks.vaultSet(provider, key, persist); mocks.vaultKeys.set(provider, key); }
    remove(provider: string) { mocks.vaultKeys.delete(provider); }
  }
}));
vi.mock('../src/main/providers', async original => ({ ...await original<typeof import('../src/main/providers')>(), generate: mocks.generator }));
vi.mock('../src/main/context-menu', () => ({ installEditContextMenus() {} }));
vi.mock('../src/main/startup-diagnostics', () => ({ StartupDiagnostics: class {
  record(event: string, details: any = {}) { mocks.records.push({ event, details }); } flush() { return Promise.resolve(); }
} }));
let directory: string, args: string[];
beforeEach(async () => {
  mocks.vaultKeys.clear(); mocks.vaultSet.mockReset(); mocks.external.mockReset().mockResolvedValue(undefined); mocks.generator.mockReset().mockResolvedValue('Connected'); mocks.secure = true;
  vi.resetModules(); mocks.app?.removeAllListeners(); mocks.ipc?.removeAllListeners(); mocks.power?.removeAllListeners(); mocks.app?.quit.mockReset(); mocks.app?.relaunch.mockReset(); if (mocks.app) mocks.app.isPackaged = false;
  mocks.windows.length = mocks.views.length = mocks.records.length = mocks.trays.length = mocks.menus.length = mocks.images.length = 0; mocks.trayFailure = false; mocks.activateOnLoad = false; mocks.pendingRemoteLoad = undefined; mocks.handlers.clear(); mocks.errors.mockClear(); mocks.messageBox.mockReset().mockResolvedValue({ response: 0 });
  mocks.app?.commandLine.getSwitchValue.mockReturnValue('wayland');
  directory = mkdtempSync(join(tmpdir(), 'startup-main-')); args = process.argv;
  process.argv = [...args, '--fixture', `--data-dir=${directory}`]; vi.stubGlobal('__dirname', '/fixture-build');
  await import('../src/main/index');
  await vi.waitFor(() => { expect(mocks.errors).not.toHaveBeenCalled(); expect(mocks.views[1]?.webContents.url).toContain('fixture.html'); });
});
afterEach(async () => {
  mocks.app.emit('before-quit', { preventDefault() {} });
  await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalled());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); process.argv = args; rmSync(directory, { recursive: true, force: true });
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
async function expectManualNotice() {
  const contents = mocks.views[0].webContents;
  await mocks.handlers.get('companion:action')!({ sender: contents, senderFrame: contents.mainFrame }, { type: 'preferences', scope: 'global', patch: { aiFeatures: true } });
  acknowledgeSnapshot();
  mocks.ipc.emit('companion:event', bootEvent(), { type: 'request' });
  expect(mocks.views[1].webContents.send.mock.calls).toContainEqual(['companion:command', {
    type: 'notice', text: expect.stringContaining('Enable conversation context in Settings')
  }]);
}
test('hidden remote failure survives error-page commit/dom-ready and retries; manual navigation cancels retry', () => {
  const contents = mocks.views[1].webContents, win = mocks.windows[0], load = vi.spyOn(contents, 'loadURL');
  vi.useFakeTimers();
  try {
    win.hide(); contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    contents.emit('did-fail-provisional-load', {}, -105, 'PRIVATE', 'https://PRIVATE', true);
    contents.emit('did-navigate', {}, 'chrome-error://chromewebdata/', -1);
    contents.emit('dom-ready'); contents.emit('did-finish-load');
    contents.emit('did-fail-load', {}, -105, 'PRIVATE', 'https://PRIVATE', true);
    vi.advanceTimersByTime(1999); expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(load).toHaveBeenCalledExactlyOnceWith(contents.url);
    expect(win.isVisible()).toBe(false);
    expect(mocks.records).toContainEqual({ event: 'load-failed', details: { code: -105, attempt: 1 } });
    expect(mocks.records).toContainEqual({ event: 'load-retry', details: { attempt: 1 } });
    expect(JSON.stringify(mocks.records)).not.toContain('PRIVATE');
    contents.emit('did-fail-load', {}, -105, 'PRIVATE', 'https://PRIVATE', true);
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    contents.emit('dom-ready'); vi.advanceTimersByTime(5000); expect(load).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
test('main ignores aborted/subframe loads and shutdown cancels retry', () => {
  const contents = mocks.views[1].webContents, load = vi.spyOn(contents, 'loadURL');
  vi.useFakeTimers();
  try {
    contents.emit('did-fail-load', {}, -3, 'aborted', '', true);
    contents.emit('did-fail-load', {}, -105, 'subframe', '', false);
    vi.advanceTimersByTime(5000); expect(load).not.toHaveBeenCalled();
    expect(mocks.records.some(record => record.event === 'load-failed')).toBe(false);
    contents.emit('did-fail-load', {}, -105, '', '', true);
    mocks.app.emit('before-quit', { preventDefault() {} });
    vi.advanceTimersByTime(5000); expect(load).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
test('two uncommitted navigations stop/reload then relaunch through normal shutdown', async () => {
  const contents = mocks.views[1].webContents;
  vi.spyOn(contents, 'loadURL').mockImplementation(() => {
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    return new Promise<void>(() => {});
  });
  mocks.app.quit.mockImplementationOnce(() => mocks.app.emit('before-quit', { preventDefault() {} }));
  vi.useFakeTimers();
  try {
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    vi.advanceTimersByTime(45_000);
    expect(contents.stop).toHaveBeenCalledOnce(); expect(contents.loadURL).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(45_000);
    expect(mocks.app.relaunch).toHaveBeenCalledExactlyOnceWith({ execPath: process.execPath,
      args: [...process.argv.slice(1).filter(arg => arg !== '--hidden'), '--relaunched-after-stall'] });
    expect(mocks.records.some(record => record.event === 'close-requested')).toBe(true);
  } finally { vi.useRealTimers(); }
  await vi.waitFor(() => expect(mocks.records.some(record => record.event === 'quit')).toBe(true));
});
test('remote session has the page UA before view construction', () => {
  const remote = mocks.views[1];
  expect(remote.initialUserAgent).toContain('Chrome/');
  expect(remote.initialUserAgent).not.toContain('Electron');
  expect(remote.webContents.setUserAgent.mock.calls).toEqual([[remote.initialUserAgent]]);
  expect(remote.webContents.session.setUserAgent.mock.calls).toEqual([[remote.initialUserAgent]]);
});
test('load before splash-delayed activation does not spend snapshot retries; ready recovers assistance and initializes chrome', async () => {
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
    acknowledgeSnapshot(); await expectManualNotice();
    const afterOptIn = snapshotRequests().length;
    connectorReady(); expect(snapshotRequests()).toHaveLength(afterOptIn);
  } finally { vi.useRealTimers(); }
});
test('readiness authenticates the current remote frame and session before resuming assistance', async () => {
  const valid = bootSession(), contents = mocks.views[1].webContents;
  contents.send.mockClear();
  for (const raw of [null, { ...valid, generation: valid.generation - 1 }, { ...valid, nonce: '00000000-0000-4000-8000-000000000002' }, { ...valid, text: 'PRIVATE' }])
    connectorReady(raw as typeof valid);
  mocks.ipc.emit('companion:connector-ready', { ...bootEvent(), sender: mocks.views[0].webContents }, valid);
  mocks.ipc.emit('companion:connector-ready', { ...bootEvent(), senderFrame: { ...contents.frame } }, valid);
  const url = contents.frame.url;
  contents.frame.url = 'https://untrusted.invalid/'; connectorReady(valid); contents.frame.url = url;
  expect(snapshotRequests()).toHaveLength(0);
  connectorReady(); expect(snapshotRequests()).toHaveLength(1); acknowledgeSnapshot(); await expectManualNotice();
});
test.each(['reload', 'crash then reload'])('%s issues a fresh boot session and re-establishes assistance only after that connector activates', async mode => {
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
  connectorReady(current); acknowledgeSnapshot(); await expectManualNotice();
});
test('in-page navigation retains the active document session and connector instead of stranding assistance', async () => {
  const contents = mocks.views[1].webContents, current = bootSession();
  connectorReady(); acknowledgeSnapshot(); contents.send.mockClear();
  contents.frame.url = `${contents.frame.url.split('#')[0]}#another-chat`;
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  contents.emit('did-navigate-in-page', {}, contents.frame.url, true);
  expect(bootSession()).toEqual(current); expect(snapshotRequests()).toHaveLength(0);
  await expectManualNotice();
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
test('remote stays unthrottled after shell readiness for hidden delivery', () => {
  const contents = mocks.views[1].webContents, heartbeat = { ...bootSession(), phase: 'splash', progress: null, visible: true, online: true };
  expect(contents.throttling).toBe(false);
  mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), { ...heartbeat, phase: 'login' }); expect(contents.throttling).toBe(false);
  mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), { ...heartbeat, generation: 0, phase: 'shell' }); expect(contents.throttling).toBe(false);
  mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), { ...heartbeat, phase: 'shell' }); expect(contents.throttling).toBe(false);
});
test('structural diagnostics authenticate and validate heartbeats, logging once per document session', () => {
  const contents = mocks.views[1].webContents;
  const structure = { visibleProgress: true, tagName: 'PROGRESS', ancestors: [{ tagName: 'DIV', id: 'app', idPresent: true, testId: null, testIdPresent: false }] };
  const heartbeat = { ...bootSession(), phase: 'splash', progress: 1, visible: true, online: true, structure };
  for (const raw of [
    { ...heartbeat, generation: 0 },
    { ...heartbeat, structure: { ...structure, text: 'PRIVATE MESSAGE' } },
    { ...heartbeat, structure: { ...structure, tagName: 'USER-ALICESMITH' } },
    { ...heartbeat, structure: { ...structure, ancestors: [{ ...structure.ancestors[0], tagName: 'TOKEN-ABCDEFGH1234' }] } },
    { ...heartbeat, structure: { ...structure, ancestors: [{ ...structure.ancestors[0], id: 'PRIVATE NAME' }] } },
    ...['user_AliceSmith', 'token_abcdEFGH1234'].flatMap(value => [
      { ...heartbeat, structure: { ...structure, ancestors: [{ ...structure.ancestors[0], id: value }] } },
      { ...heartbeat, structure: { ...structure, ancestors: [{ ...structure.ancestors[0], testId: value, testIdPresent: true }] } }
    ])
  ]) mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), raw);
  mocks.ipc.emit('companion:boot-heartbeat', { ...bootEvent(), sender: mocks.views[0].webContents }, heartbeat);
  mocks.ipc.emit('companion:boot-heartbeat', { ...bootEvent(), senderFrame: { ...contents.frame } }, heartbeat);
  expect(mocks.records.filter(record => record.event === 'structure')).toHaveLength(0);
  mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), heartbeat);
  mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), heartbeat);
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), heartbeat);
  expect(mocks.records.filter(record => record.event === 'structure')).toEqual([
    { event: 'structure', details: { structure, generation: heartbeat.generation } }
  ]);
  contents.reload(); const current = bootSession();
  mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), heartbeat);
  expect(mocks.records.filter(record => record.event === 'structure')).toHaveLength(1);
  const empty = { visibleProgress: false, tagName: null, ancestors: [] };
  mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), { ...heartbeat, ...current, phase: 'unknown', progress: null, structure: empty });
  expect(mocks.records.filter(record => record.event === 'structure')).toEqual([
    { event: 'structure', details: { structure, generation: heartbeat.generation } },
    { event: 'structure', details: { structure: empty, generation: current.generation } }
  ]);
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
  const { Menu } = await import('electron');
  mocks.app.emit('before-quit', { preventDefault() {} });
  await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
  mocks.app.removeAllListeners(); mocks.ipc.removeAllListeners(); mocks.power.removeAllListeners(); mocks.app.quit.mockClear();
  mocks.windows.length = mocks.views.length = mocks.records.length = 0; mocks.handlers.clear();
  vi.spyOn(Menu, 'setApplicationMenu').mockImplementation(() => { throw new Error('native menu initialization failed'); });
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
  mocks.app.emit('before-quit', { preventDefault() {} }); mocks.app.emit('second-instance'); remote.emit('focus');
  expect(win.focus).not.toHaveBeenCalled(); expect(win.restore).not.toHaveBeenCalled();
  expect(remote.send).not.toHaveBeenCalled(); expect(controls.send).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalled());
  expect(remote.close).toHaveBeenCalledOnce(); expect(controls.close).toHaveBeenCalledOnce();
  expect(mocks.records.map(record => record.event)).toEqual(expect.arrayContaining(['close-requested', 'intake-drained', 'views-destroyed', 'quit']));
});


test('main watchdog actually reloads remote webContents and preserves its budget across navigation generations', async () => {
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
  connectorReady(session); acknowledgeSnapshot(); await expectManualNotice();
  // Stale heartbeats cannot contribute to the second observation window.
  clock.mockReturnValue(62_000);
  mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), { ...prior, phase: 'splash', progress: 1, visible: true, online: true });
  for (let now = 62_000; now <= 178_000; now += 2000) observe(now);
  expect(contents.reload).toHaveBeenCalledTimes(1);
  observe(180_000); expect(contents.reload).toHaveBeenCalledTimes(2); session = bootSession();
  contents.send.mockClear(); contents.emit('did-finish-load');
  expect(snapshotRequests()).toHaveLength(0);
  connectorReady(session); acknowledgeSnapshot(); await expectManualNotice();
  for (let now = 182_000; now <= 400_000; now += 2000) observe(now);
  expect(contents.reload).toHaveBeenCalledTimes(2);
  expect(mocks.records.filter(record => record.event === 'reload').map(record => record.details.reloads)).toEqual([1, 2]);
});
test('hidden failed-asset splash reloads promptly and logs one authenticated asset failure per generation', () => {
  const win = mocks.windows[0], contents = mocks.views[1].webContents, clock = vi.spyOn(performance, 'now');
  win.close(); win.show.mockClear();
  const session = bootSession(), heartbeat = { ...session, phase: 'splash', progress: 0, visible: false, online: true,
    assetFailed: true, assetFailureKind: 'stylesheet' };
  clock.mockReturnValue(0);
  mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), { ...heartbeat, generation: 0 });
  mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), { ...heartbeat, assetFailureKind: 'PRIVATE' });
  mocks.ipc.emit('companion:boot-heartbeat', { ...bootEvent(), sender: mocks.views[0].webContents }, heartbeat);
  mocks.ipc.emit('companion:boot-heartbeat', { ...bootEvent(), senderFrame: { ...contents.frame } }, heartbeat);
  expect(mocks.records.filter(record => record.event === 'asset-failure')).toHaveLength(0);
  for (let now = 0; now <= 4000; now += 2000) {
    clock.mockReturnValue(now); mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), heartbeat);
  }
  expect(contents.reload).not.toHaveBeenCalled();
  clock.mockReturnValue(6000); mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), heartbeat);
  expect(contents.reload).toHaveBeenCalledOnce();
  expect(win.visible).toBe(false); expect(win.show).not.toHaveBeenCalled();
  expect(mocks.records.filter(record => record.event === 'asset-failure')).toEqual([
    { event: 'asset-failure', details: { kind: 'stylesheet', generation: session.generation } }
  ]);
  expect(mocks.records.filter(record => record.event === 'reload')).toEqual([
    { event: 'reload', details: { reloads: 1, generation: session.generation } }
  ]);
  mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), heartbeat);
  expect(mocks.records.filter(record => record.event === 'asset-failure')).toHaveLength(1);
  mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), { ...heartbeat, ...bootSession(), assetFailureKind: 'script' });
  expect(mocks.records.filter(record => record.event === 'asset-failure')).toHaveLength(2);
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
  connectorReady(); shellHeartbeat();
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
    expect(await action(local, { type: 'preferences', scope: 'global', patch: { aiFeatures: true } })).toEqual({ ok: true });
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
    mocks.app.emit('before-quit', { preventDefault() {} }); await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
  }
});


const trayMenu = () => mocks.trays.at(-1).menu;
const desktopState = () => JSON.parse(readFileSync(join(directory, 'companion.json'), 'utf8')).desktop;
const shellHeartbeat = (phase = 'shell', chatListReady = phase === 'shell') => mocks.ipc.emit('companion:boot-heartbeat', bootEvent(), { ...bootSession(), phase, chatListReady, progress: null, visible: true, online: true });
test('tray icon has both image scales, tooltip, ordered menu and immediate main-only toggles', () => {
  const tray = mocks.trays[0];
  expect(tray.setToolTip).toHaveBeenCalledExactlyOnceWith('WhatsApp Companion');
  expect(mocks.images[0].addRepresentation.mock.calls.map(([value]: any[]) => value.scaleFactor)).toEqual([1, 2]);
  expect(trayMenu().map((item: any) => item.label ?? item.type)).toEqual([
    'Open WhatsApp Companion', 'separator', 'Notifications', 'Start at login', 'separator', 'Quit'
  ]);
  expect(mocks.menus.at(-1)[0].submenu.at(-1)).toMatchObject({ role: 'quit', accelerator: 'CmdOrCtrl+Q' });
  expect(trayMenu()[2]).toMatchObject({ type: 'checkbox', checked: false });
  expect(trayMenu()[3]).toMatchObject({ type: 'checkbox', checked: false });
  trayMenu()[2].click(); expect(desktopState().notifications).toBe('allowed'); expect(trayMenu()[2].checked).toBe(true);
  trayMenu()[2].click(); expect(desktopState().notifications).toBe('denied'); expect(trayMenu()[2].checked).toBe(false);
  trayMenu()[3].click(); expect(desktopState().startAtLogin).toBe(true); expect(trayMenu()[3].checked).toBe(true);
  expect(mocks.messageBox).not.toHaveBeenCalled();
});
test('X hides and removes the taskbar entry without stopping runtime or destroying views', () => {
  const win = mocks.windows[0]; win.close();
  expect(win.hide).toHaveBeenCalledOnce(); expect(win.setSkipTaskbar).toHaveBeenLastCalledWith(true);
  expect(win.isVisible()).toBe(false); expect(win.isDestroyed()).toBe(false);
  expect(mocks.records.some(record => record.event === 'close-requested')).toBe(false);
  expect(mocks.views.every(view => !view.webContents.destroyed)).toBe(true); expect(mocks.app.quit).not.toHaveBeenCalled();
  expect(mocks.handlers.get('companion:boot-session')!(bootEvent())).not.toBeNull();
});
test.each(['click', 'menu', 'second-instance', 'notification'])('%s shows, restores, raises and focuses', source => {
  const win = mocks.windows[0]; win.close(); win.minimized = true;
  if (source === 'click') mocks.trays[0].emit('click');
  if (source === 'menu') trayMenu()[0].click();
  if (source === 'second-instance') mocks.app.emit('second-instance', {}, ['--hidden']);
  if (source === 'notification') mocks.ipc.emit('companion:notification-click', bootEvent());
  expect(win.isVisible()).toBe(true); expect(win.restore).toHaveBeenCalledOnce();
  expect(win.moveTop).toHaveBeenCalled(); expect(win.focus).toHaveBeenCalled();
  expect(win.setSkipTaskbar).toHaveBeenLastCalledWith(false);
  if (source !== 'click') {
    if (source === 'menu') trayMenu()[0].click();
    else if (source === 'notification') mocks.ipc.emit('companion:notification-click', bootEvent());
    else mocks.app.emit('second-instance', {}, []);
    expect(win.isVisible()).toBe(true);
  }
});
test('notification activation rejects other renderers, subframes, navigated documents and shutdown', () => {
  const win = mocks.windows[0], remote = mocks.views[1].webContents, controls = mocks.views[0].webContents;
  win.close(); win.focus.mockClear();
  for (const event of [
    { sender: controls, senderFrame: controls.mainFrame },
    { sender: remote, senderFrame: { ...remote.mainFrame } },
    { sender: remote, senderFrame: null }
  ]) mocks.ipc.emit('companion:notification-click', event);
  const url = remote.mainFrame.url; remote.mainFrame.url = 'https://example.com/';
  mocks.ipc.emit('companion:notification-click', bootEvent()); remote.mainFrame.url = url;
  mocks.app.emit('before-quit', { preventDefault() {} });
  mocks.ipc.emit('companion:notification-click', bootEvent());
  expect(win.focus).not.toHaveBeenCalled(); expect(win.isVisible()).toBe(false);
});
test.each([
  { platform: 'linux', backend: 'wayland' }, { platform: 'linux', backend: 'x11' },
  { platform: 'win32', backend: '' }, { platform: 'darwin', backend: '' }
].flatMap(mode => ['minimized', 'compositor-minimized', 'visible', 'hidden'].map(state => ({ ...mode, state }))))(
  'tray remaps only unfocused Wayland surfaces ($platform, $backend, $state)', async ({ platform, backend, state }) => {
  const originalPlatform = process.platform;
  try {
    Object.defineProperty(process, 'platform', { value: platform });
    mocks.app.commandLine.getSwitchValue.mockReturnValue(backend);
    // A Wayland session can still run an X11 Electron window.
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland'); vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
    await restart();
    const win = mocks.windows[0]; win.minimized = state === 'minimized'; win.visible = state !== 'hidden';
    vi.spyOn(win, 'isFocused').mockReturnValue(false);
    const remoteFocus = vi.spyOn(mocks.views[1].webContents, 'focus');
    win.restore.mockClear(); win.hide.mockClear(); win.show.mockClear();
    mocks.trays[0].emit('click');
    expect(win.restore).toHaveBeenCalledTimes(state === 'minimized' ? 1 : 0);
    const wayland = platform === 'linux' && backend === 'wayland';
    if (wayland && state !== 'hidden') {
      expect(win.hide).toHaveBeenCalledOnce(); expect(win.show).toHaveBeenCalledOnce();
      if (state === 'minimized') expect(win.restore.mock.invocationCallOrder[0]).toBeLessThan(win.hide.mock.invocationCallOrder[0]);
      expect(win.hide.mock.invocationCallOrder[0]).toBeLessThan(win.show.mock.invocationCallOrder[0]);
    } else {
      expect(win.hide).not.toHaveBeenCalled(); expect(win.show).toHaveBeenCalledTimes(state === 'hidden' ? 1 : 0);
    }
    expect(win.isMinimized()).toBe(false); expect(win.isVisible()).toBe(true);
    expect(win.focus).toHaveBeenCalled(); expect(win.setSkipTaskbar).toHaveBeenLastCalledWith(false);
    expect(remoteFocus).toHaveBeenCalledTimes(platform === 'linux' ? 1 : 0);
  } finally { Object.defineProperty(process, 'platform', { value: originalPlatform }); }
});
test.each(['menu', 'second-instance', 'notification'])('%s does not remap an already focused Wayland window', source => {
  const win = mocks.windows[0];
  vi.spyOn(win, 'isFocused').mockReturnValue(true);
  win.visible = true; win.minimized = false;
  win.hide.mockClear(); win.show.mockClear();
  if (source === 'menu') trayMenu()[0].click();
  else if (source === 'notification') mocks.ipc.emit('companion:notification-click', bootEvent());
  else mocks.app.emit('second-instance', {}, []);
  expect(win.hide).not.toHaveBeenCalled(); expect(win.show).not.toHaveBeenCalled();
  expect(win.moveTop).toHaveBeenCalled(); expect(win.focus).toHaveBeenCalled();
});
test('reported minimization still remaps even if focus has not updated yet', () => {
  const win = mocks.windows[0]; win.minimized = true;
  vi.spyOn(win, 'isFocused').mockReturnValue(true);
  win.hide.mockClear(); win.show.mockClear(); trayMenu()[0].click();
  expect(win.restore).toHaveBeenCalledOnce(); expect(win.hide).toHaveBeenCalledOnce(); expect(win.show).toHaveBeenCalledOnce();
});
test.each(['linux', 'win32', 'darwin'])('tray click toggles the focused window only on Linux (%s)', platform => {
  const originalPlatform = process.platform, win = mocks.windows[0];
  vi.spyOn(win, 'isFocused').mockReturnValue(true);
  win.visible = true; win.minimized = false;
  win.hide.mockClear(); win.show.mockClear(); win.focus.mockClear();
  try {
    Object.defineProperty(process, 'platform', { value: platform });
    mocks.trays[0].emit('click');
    expect(win.isVisible()).toBe(platform !== 'linux');
    if (platform === 'linux') {
      expect(win.hide).toHaveBeenCalledOnce(); expect(win.focus).not.toHaveBeenCalled();
      expect(win.setSkipTaskbar).toHaveBeenLastCalledWith(true);
      mocks.trays[0].emit('click');
      expect(win.isVisible()).toBe(true); expect(win.focus).toHaveBeenCalledOnce();
      expect(win.setSkipTaskbar).toHaveBeenLastCalledWith(false);
    } else expect(win.hide).not.toHaveBeenCalled();
  } finally { Object.defineProperty(process, 'platform', { value: originalPlatform }); }
});
test.each(['remote', 'controls'])('Wayland waits for native focus and restores the last focused %s view after a remap', view => {
  const win = mocks.windows[0], remote = mocks.views[1].webContents, controls = mocks.views[0].webContents;
  mocks.menus.at(-1)[0].submenu.find((item: any) => item.label === 'Settings').click();
  (view === 'remote' ? remote : controls).emit('focus');
  const remoteFocus = vi.spyOn(remote, 'focus'), controlsFocus = vi.spyOn(controls, 'focus');
  win.close(); win.focus.mockImplementation(() => {});
  mocks.trays[0].emit('click');
  expect(remoteFocus).not.toHaveBeenCalled(); expect(controlsFocus).not.toHaveBeenCalled();
  // Mapping may focus the base/other view before the native window focus arrives.
  (view === 'remote' ? controls : remote).emit('focus');
  win.emit('focus');
  expect(remoteFocus).toHaveBeenCalledTimes(view === 'remote' ? 1 : 0);
  expect(controlsFocus).toHaveBeenCalledTimes(view === 'controls' ? 1 : 0);
  remoteFocus.mockClear(); controlsFocus.mockClear();
  win.emit('focus');
  expect(remoteFocus).toHaveBeenCalledTimes(view === 'remote' ? 1 : 0);
  expect(controlsFocus).toHaveBeenCalledTimes(view === 'controls' ? 1 : 0);
});
test.each(['remote', 'controls'])('Alt-Tab with Settings open restores the last focused %s view', view => {
  const win = mocks.windows[0], remote = mocks.views[1].webContents, controls = mocks.views[0].webContents;
  mocks.menus.at(-1)[0].submenu.find((item: any) => item.label === 'Settings').click();
  (view === 'remote' ? remote : controls).emit('focus');
  const remoteFocus = vi.spyOn(remote, 'focus'), controlsFocus = vi.spyOn(controls, 'focus');
  win.emit('blur'); win.emit('focus');
  expect(remoteFocus).toHaveBeenCalledTimes(view === 'remote' ? 1 : 0);
  expect(controlsFocus).toHaveBeenCalledTimes(view === 'controls' ? 1 : 0);
});
test('Linux focuses WhatsApp before any child view has reported focus', () => {
  const remoteFocus = vi.spyOn(mocks.views[1].webContents, 'focus');
  mocks.windows[0].emit('focus'); expect(remoteFocus).toHaveBeenCalledOnce();
});
test('a cancelable session-end query leaves the app running', () => {
  mocks.windows[0].emit('query-session-end', { preventDefault: () => { throw new Error('must not block session end'); } });
  expect(mocks.app.quit).not.toHaveBeenCalled(); expect(mocks.trays[0].destroy).not.toHaveBeenCalled();
});
test.each(['tray', 'session-end', 'shutdown'])('%s quits completely and destroys the tray', async source => {
  const tray = mocks.trays[0];
  if (source === 'tray') trayMenu()[5].click();
  else if (source === 'shutdown') { const event = { preventDefault: vi.fn() }; mocks.power.emit('shutdown', event); expect(event.preventDefault).toHaveBeenCalledOnce(); expect(mocks.records.some(record => record.event === 'close-requested')).toBe(true); }
  else mocks.windows[0].emit(source, { preventDefault: () => { throw new Error('must not block session end'); } });
  await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce()); expect(tray.destroy).toHaveBeenCalledOnce();
});
test.each([0, 1])('notification ask waits for signed-in shell, saves response %s once and updates permission live', async response => {
  mocks.messageBox.mockResolvedValue({ response });
  shellHeartbeat('login'); connectorReady(); expect(mocks.messageBox).not.toHaveBeenCalled();
  shellHeartbeat();
  await vi.waitFor(() => expect(desktopState().notifications).toBe(response === 1 ? 'allowed' : 'denied'));
  expect(mocks.messageBox).toHaveBeenCalledExactlyOnceWith(mocks.windows[0], expect.objectContaining({
    title: 'WhatsApp Companion', message: 'Allow notifications for new messages?',
    detail: 'Closing the window keeps WhatsApp Companion running in the tray.', buttons: ['Deny', 'Allow'], defaultId: 1, cancelId: 0
  }));
  shellHeartbeat(); expect(mocks.messageBox).toHaveBeenCalledOnce();
  const contents = mocks.views[1].webContents;
  const check = contents.session.setPermissionCheckHandler.mock.lastCall[0];
  const details = { isMainFrame: true, requestingUrl: contents.url };
  expect(check(contents, 'notifications', 'file://', details)).toBe(response === 1);
  trayMenu()[2].click(); expect(check(contents, 'notifications', 'file://', details)).toBe(response !== 1);
  expect(contents.reload).not.toHaveBeenCalled();
});
test('ready while hidden waits for show; quitting an open prompt discards its answer', async () => {
  let release!: (value: any) => void;
  mocks.messageBox.mockReturnValue(new Promise(resolve => { release = resolve; }));
  mocks.windows[0].close(); connectorReady(); shellHeartbeat(); expect(mocks.messageBox).not.toHaveBeenCalled();
  mocks.trays[0].emit('click'); expect(mocks.messageBox).toHaveBeenCalledOnce();
  trayMenu()[5].click(); release({ response: 1 });
  await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
  expect(desktopState()).toEqual({});
});
async function restart(options: { live?: boolean; hidden?: boolean; noTray?: boolean; packaged?: boolean; startupStall?: boolean; waitForRemote?: boolean; failSave?: boolean; desktop?: { notifications?: 'allowed' | 'denied'; startAtLogin?: boolean } } = {}) {
  mocks.app.emit('before-quit', { preventDefault() {} }); await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalled());
  mocks.app.removeAllListeners(); mocks.ipc.removeAllListeners(); mocks.power.removeAllListeners(); mocks.app.quit.mockClear(); mocks.messageBox.mockClear();
  mocks.windows.length = mocks.views.length = mocks.records.length = mocks.trays.length = 0; mocks.handlers.clear();
  mocks.trayFailure = options.noTray ?? false; mocks.app.isPackaged = options.packaged ?? false;
  if (options.desktop) writeFileSync(join(directory, 'companion.json'), JSON.stringify({ ...initialState(), desktop: options.desktop }));
  process.argv = [...args, ...(options.live ? [] : ['--fixture']), `--data-dir=${directory}`, ...(options.hidden ? ['--hidden'] : []), ...(options.startupStall ? ['--fixture-startup-stall'] : [])];
  vi.resetModules();
  if (options.failSave) { const { Store } = await import('../src/main/store'); vi.spyOn(Store.prototype, 'update').mockImplementation(() => { throw new Error('disk full'); }); }
  await import('../src/main/index');
  if (options.waitForRemote !== false) await vi.waitFor(() => expect(mocks.views[1]?.webContents.url).toContain(options.packaged || options.live ? 'https://web.whatsapp.com/' : options.startupStall ? 'companion-fixture-stall:' : 'fixture.html'));
}
test.each([true, false])('base page load rejection continues startup (numeric errno %s)', async numeric => {
  const Window = mocks.windows[0].constructor, error = new Error('PRIVATE file:///PRIVATE');
  if (numeric) Object.assign(error, { errno: -2 });
  vi.spyOn(Window.prototype, 'loadURL').mockRejectedValue(error);
  await restart();
  expect(mocks.errors).not.toHaveBeenCalled(); expect(mocks.app.quit).not.toHaveBeenCalled();
  expect(mocks.views[0].webContents.loaded).toBe(true);
  expect(mocks.records.filter(record => ['base-load-failed', 'controls-loaded', 'remote-navigation'].includes(record.event))).toEqual([
    { event: 'base-load-failed', details: numeric ? { code: -2 } : {} },
    { event: 'controls-loaded', details: {} }, { event: 'remote-navigation', details: { generation: 1 } }
  ]);
});
test.each([
  ['committed controls page', true, 1], ['retry succeeds', false, 1], ['retry also rejects', false, 2]
] as const)('controls load rejection continues remote startup: %s', async (_mode, committed, failures) => {
  const prototype = mocks.views[0].webContents.constructor.prototype as { loadURL(url: string): Promise<void> }, loadURL = prototype.loadURL;
  let attempts = 0;
  vi.spyOn(prototype, 'loadURL').mockImplementation(async function (this: any, url: string) {
    if (!url.endsWith('/ui/index.html')) return loadURL.call(this, url);
    attempts++;
    if (committed) { this.url = this.frame.url = url; this.loaded = true; this.emit('dom-ready'); this.emit('did-stop-loading'); }
    else if (attempts > failures) await loadURL.call(this, url);
    if (attempts <= failures) throw Object.assign(new Error('PRIVATE file:///PRIVATE'), { errno: -2 });
  });
  await restart();
  expect(attempts).toBe(committed ? 1 : 2);
  expect(mocks.errors).not.toHaveBeenCalled(); expect(mocks.app.quit).not.toHaveBeenCalled();
  expect(mocks.views[1].webContents.url).toContain('fixture.html');
  expect(mocks.records.filter(record => ['controls-load-failed', 'controls-loaded', 'remote-navigation'].includes(record.event))).toEqual([
    ...Array.from({ length: failures }, () => ({ event: 'controls-load-failed', details: { code: -2 } })),
    ...(committed || failures === 1 ? [{ event: 'controls-loaded', details: {} }] : []),
    { event: 'remote-navigation', details: { generation: 1 } }
  ]);
  expect(JSON.stringify(mocks.records)).not.toContain('PRIVATE');
});
test.each([
  ['base', false], ['base', true], ['controls', false], ['controls', true], ['controls retry', false], ['controls retry', true]
] as const)('shutdown while %s load is pending stops startup quietly (reject %s)', async (phase, rejected) => {
  const prototype = mocks.views[0].webContents.constructor.prototype as { loadURL(url: string): Promise<void> }, loadURL = prototype.loadURL;
  let settle: (() => void) | undefined, attempts = 0;
  vi.spyOn(prototype, 'loadURL').mockImplementation(function (this: any, url: string) {
    const target = phase === 'base' ? url === 'about:blank' : url.endsWith('/ui/index.html');
    if (!target) return loadURL.call(this, url);
    attempts++;
    if (phase === 'controls retry' && attempts === 1) return Promise.reject(Object.assign(new Error('load failed'), { errno: -2 }));
    return new Promise<void>((resolve, reject) => { settle = () => rejected ? reject(Object.assign(new Error('load stopped'), { errno: -2 })) : resolve(); });
  });
  await restart({ noTray: true, waitForRemote: false });
  await vi.waitFor(() => expect(settle).toBeDefined());
  const view = mocks.views[0], controls = view.webContents, readDestroyedContents = vi.fn(() => undefined);
  controls.close.mockImplementation(() => {
    controls.destroyed = true; controls.emit('destroyed');
    Object.defineProperty(view, 'webContents', { configurable: true, get: readDestroyedContents });
  });
  mocks.windows[0].close();
  await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
  expect(controls.close).toHaveBeenCalledOnce(); expect(mocks.windows[0].isDestroyed()).toBe(true);
  const records = [...mocks.records];
  settle!();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(readDestroyedContents).not.toHaveBeenCalled();
  expect(mocks.errors).not.toHaveBeenCalled(); expect(mocks.app.quit).toHaveBeenCalledOnce();
  expect(attempts).toBe(phase === 'controls retry' ? 2 : 1);
  expect(mocks.records).toEqual(records);
  expect(mocks.records.some(record => record.event === 'remote-navigation')).toBe(false);
});
test('initialization failure during window shutdown skips the startup error box', async () => {
  const { Menu } = await import('electron');
  vi.spyOn(Menu, 'setApplicationMenu').mockImplementation(() => {
    mocks.windows[0].close();
    expect(mocks.records.some(record => record.event === 'close-requested')).toBe(true);
    expect(mocks.app.quit).not.toHaveBeenCalled();
    throw new Error('native menu initialization failed');
  });
  await restart({ noTray: true, waitForRemote: false });
  await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
  expect(mocks.errors).not.toHaveBeenCalled();
  expect(mocks.windows[0].isDestroyed()).toBe(true);
  expect(mocks.records.map(record => record.event)).toEqual(expect.arrayContaining(['intake-drained', 'views-destroyed', 'quit']));
});
test('readiness failure after quit skips the startup error box', async () => {
  let reject!: (error: Error) => void;
  vi.spyOn(mocks.app, 'whenReady').mockReturnValue(new Promise<void>((_resolve, rejectReady) => { reject = rejectReady; }));
  await restart({ waitForRemote: false });
  expect(mocks.windows).toHaveLength(0);
  mocks.app.emit('before-quit', { preventDefault() {} });
  await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
  reject(new Error('readiness failed'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(mocks.errors).not.toHaveBeenCalled(); expect(mocks.app.quit).toHaveBeenCalledOnce();
});
test('fixture stall flag selects an uncommitted first load and shortened main-only recovery', async () => {
  vi.useFakeTimers();
  try {
    await restart({ hidden: true, startupStall: true });
    const contents = mocks.views[1].webContents;
    expect(contents.session.protocol.handle).toHaveBeenCalledWith('companion-fixture-stall', expect.any(Function));
    await vi.advanceTimersByTimeAsync(1500);
    expect(contents.stop).toHaveBeenCalledOnce(); expect(contents.url).toContain('fixture.html');
    expect(mocks.records.filter(record => record.event === 'navigation-stalled')).toHaveLength(1);
    expect(mocks.records.filter(record => record.event === 'load-retry')).toHaveLength(1);
    expect(mocks.windows[0].isVisible()).toBe(false);
  } finally { vi.useRealTimers(); }
});
test('packaged app ignores fixture stall protocol and shortened thresholds', async () => {
  vi.stubEnv('XDG_CONFIG_HOME', join(directory, 'xdg'));
  await restart({ packaged: true, startupStall: true });
  const contents = mocks.views[1].webContents;
  expect(contents.session.protocol.handle).not.toHaveBeenCalledWith('companion-fixture-stall', expect.any(Function));
  vi.useFakeTimers();
  try {
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    vi.advanceTimersByTime(44_999); expect(contents.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(contents.stop).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
test('hidden launch loads the remote, keeps watchdog gated, and relinking does not show the window', async () => {
  await restart({ hidden: true }); const win = mocks.windows[0], contents = mocks.views[1].webContents;
  expect(win.show).not.toHaveBeenCalled(); expect(win.visible).toBe(false);
  connectorReady(); shellHeartbeat(); shellHeartbeat('login'); contents.emit('focus');
  expect(mocks.messageBox).not.toHaveBeenCalled(); expect(win.visible).toBe(false);
  expect(contents.reload).not.toHaveBeenCalled();
  expect(mocks.records.filter(record => record.event === 'watchdog').every(record => record.details.decision === 'gated')).toBe(true);
});
test('tray construction failure shows a hidden launch; X quits and notification prompt omits tray detail', async () => {
  await restart({ hidden: true, noTray: true });
  expect(mocks.windows[0].visible).toBe(true); expect(desktopState()).toEqual({});
  connectorReady(); shellHeartbeat(); await vi.waitFor(() => expect(mocks.messageBox).toHaveBeenCalledOnce());
  expect(mocks.messageBox.mock.lastCall![1]).not.toHaveProperty('detail');
  mocks.windows[0].close(); await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
});
test('a persisted answer suppresses the ask after restart and silently answers WhatsApp requests', async () => {
  await restart({ desktop: { notifications: 'denied' } }); connectorReady(); shellHeartbeat();
  const contents = mocks.views[1].webContents, callback = vi.fn();
  contents.session.setPermissionRequestHandler.mock.lastCall[0](contents, 'notifications', callback, { isMainFrame: true, requestingUrl: contents.url });
  expect(callback).toHaveBeenCalledExactlyOnceWith(false); expect(mocks.messageBox).not.toHaveBeenCalled();
});

test('packaged startup enables XDG login once, uses APPIMAGE, repairs moves, and tray toggles persist', async () => {
  vi.stubEnv('XDG_CONFIG_HOME', join(directory, 'xdg')); vi.stubEnv('APPIMAGE', '/opt/Companion App.AppImage'); vi.stubEnv('APPDIR', dirname(process.execPath));
  await restart({ packaged: true, hidden: true });
  const path = join(directory, 'xdg/autostart/whatsapp-companion.desktop');
  expect(desktopState().startAtLogin).toBe(true); expect(trayMenu()[3].checked).toBe(true);
  expect(readFileSync(path, 'utf8')).toContain('Exec="/opt/Companion App.AppImage" --hidden');
  expect(mocks.windows[0].visible).toBe(false);
  vi.stubEnv('APPIMAGE', '/opt/Moved Companion.AppImage'); vi.stubEnv('APPDIR', dirname(process.execPath)); await restart({ packaged: true });
  expect(readFileSync(path, 'utf8')).toContain('Exec="/opt/Moved Companion.AppImage" --hidden');
  trayMenu()[3].click(); expect(desktopState().startAtLogin).toBe(false); expect(existsSync(path)).toBe(false);
  trayMenu()[3].click(); expect(desktopState().startAtLogin).toBe(true); expect(existsSync(path)).toBe(true);
});
test('an APPIMAGE inherited from another AppImage is not used for login', async () => {
  vi.stubEnv('XDG_CONFIG_HOME', join(directory, 'xdg')); vi.stubEnv('APPIMAGE', '/opt/Other.AppImage'); vi.stubEnv('APPDIR', '/tmp/.mount_Other');
  await restart({ packaged: true });
  expect(readFileSync(join(directory, 'xdg/autostart/whatsapp-companion.desktop'), 'utf8')).toContain(`Exec="${process.execPath}" --hidden`);
});
test('packaged no-tray startup does not enable autostart and cannot stay hidden', async () => {
  vi.stubEnv('XDG_CONFIG_HOME', join(directory, 'xdg')); vi.stubEnv('APPIMAGE', '/opt/Companion.AppImage'); vi.stubEnv('APPDIR', dirname(process.execPath));
  await restart({ packaged: true, hidden: true, noTray: true });
  expect(existsSync(join(directory, 'xdg/autostart/whatsapp-companion.desktop'))).toBe(false);
  expect(desktopState()).toEqual({}); expect(mocks.windows[0].visible).toBe(true);
});
test('an unanswered hidden request stays deferred through relinking until the signed-in shell returns', async () => {
  const win = mocks.windows[0], contents = mocks.views[1].webContents, callback = vi.fn();
  win.close(); connectorReady(); shellHeartbeat();
  contents.session.setPermissionRequestHandler.mock.lastCall[0](contents, 'notifications', callback, { isMainFrame: true, requestingUrl: contents.url });
  shellHeartbeat('login'); mocks.trays[0].emit('click'); expect(mocks.messageBox).not.toHaveBeenCalled();
  shellHeartbeat(); await vi.waitFor(() => expect(callback).toHaveBeenCalledExactlyOnceWith(false));
  expect(mocks.messageBox).toHaveBeenCalledOnce(); expect(desktopState().notifications).toBe('denied');
});

function observeChat(chatId: string) {
  const nonce = snapshotRequests().at(-1)?.[1].nonce;
  mocks.ipc.emit('companion:event', bootEvent(), { type: 'snapshot', nonce, snapshot: { ...emptySnapshot,
    chatId, ready: true, conversationOpen: true, name: 'Fixture', revision: chatId,
    messages: [{ id: `false_${chatId}_a`, text: 'Hello', outgoing: false }] } });
}
test('conversation changes while hidden never show or focus the window', () => {
  connectorReady(); observeChat('123@c.us'); const win = mocks.windows[0]; win.close(); win.show.mockClear(); win.focus.mockClear();
  observeChat('456@c.us');
  expect(win.show).not.toHaveBeenCalled(); expect(win.focus).not.toHaveBeenCalled(); expect(win.visible).toBe(false);
});
test('main-process webContents focus while hidden never restores the window', () => {
  connectorReady(); observeChat('123@c.us'); const win = mocks.windows[0]; win.close(); win.show.mockClear(); win.focus.mockClear();
  mocks.views[1].webContents.focus();
  expect(win.show).not.toHaveBeenCalled(); expect(win.focus).not.toHaveBeenCalled(); expect(win.visible).toBe(false);
});
test('navigation before the visible loaded list does not ask, including WhatsApp requests', async () => {
  connectorReady(); shellHeartbeat('shell', false);
  const contents = mocks.views[1].webContents, callback = vi.fn();
  contents.session.setPermissionRequestHandler.mock.lastCall[0](contents, 'notifications', callback, { isMainFrame: true, requestingUrl: contents.url });
  expect(mocks.messageBox).not.toHaveBeenCalled(); expect(callback).not.toHaveBeenCalled();
  shellHeartbeat('shell', true);
  await vi.waitFor(() => expect(callback).toHaveBeenCalledExactlyOnceWith(false));
  expect(mocks.messageBox).toHaveBeenCalledOnce();
});
test('notification save failure reports once and keeps the answer and tray checkbox for this session', async () => {
  const { Store } = await import('../src/main/store');
  vi.spyOn(Store.prototype, 'update').mockImplementation(() => { throw new Error('disk full'); });
  mocks.messageBox.mockResolvedValue({ response: 1 }); connectorReady(); shellHeartbeat();
  await vi.waitFor(() => expect(mocks.errors).toHaveBeenCalledExactlyOnceWith('WhatsApp Companion', expect.stringContaining('notification setting could not be saved')));
  expect(trayMenu()[2].checked).toBe(true);
  shellHeartbeat(); shellHeartbeat(); expect(mocks.messageBox).toHaveBeenCalledOnce();
  const contents = mocks.views[1].webContents, callback = vi.fn();
  contents.session.setPermissionRequestHandler.mock.lastCall[0](contents, 'notifications', callback, { isMainFrame: true, requestingUrl: contents.url });
  expect(callback).toHaveBeenCalledExactlyOnceWith(true); expect(desktopState()).toEqual({});
});
test('activate ignores initial hidden startup and shows the window on subsequent activation', async () => {
  mocks.activateOnLoad = true; await restart({ hidden: true }); const win = mocks.windows[0];
  expect(win.visible).toBe(false); expect(win.show).not.toHaveBeenCalled();
  mocks.app.emit('activate'); expect(win.visible).toBe(true); expect(win.focus).toHaveBeenCalled();
});
test('activation after the initial hidden launch activation shows the window while remote loading is pending', async () => {
  let release!: () => void;
  mocks.pendingRemoteLoad = new Promise<void>(resolve => { release = resolve; });
  mocks.activateOnLoad = true;
  try {
    await restart({ hidden: true });
    const win = mocks.windows[0], contents = mocks.views[1].webContents;
    expect(contents.loaded).toBe(false); expect(win.visible).toBe(false); expect(win.show).not.toHaveBeenCalled();
    mocks.app.emit('activate'); expect(win.visible).toBe(true); expect(win.focus).toHaveBeenCalled();
    expect(contents.loaded).toBe(false);
  } finally { release(); }
  await vi.waitFor(() => expect(mocks.views[1].webContents.loaded).toBe(true));
});
test.each([true, false])('autostart toggle to %s rolls back OS state after a failed save and keeps its checkbox', async enabled => {
  vi.stubEnv('XDG_CONFIG_HOME', join(directory, 'xdg')); vi.stubEnv('APPIMAGE', '/opt/Companion.AppImage'); vi.stubEnv('APPDIR', dirname(process.execPath));
  await restart({ packaged: true, desktop: { startAtLogin: !enabled } });
  const { Store } = await import('../src/main/store'); vi.spyOn(Store.prototype, 'update').mockImplementation(() => { throw new Error('disk full'); });
  trayMenu()[3].click();
  expect(existsSync(join(directory, 'xdg/autostart/whatsapp-companion.desktop'))).toBe(!enabled);
  expect(desktopState().startAtLogin).toBe(!enabled); expect(trayMenu()[3].checked).toBe(!enabled);
  expect(mocks.errors).toHaveBeenCalledExactlyOnceWith('WhatsApp Companion', expect.stringContaining('Start at login could not be updated'));
});
test('failed first-run autostart save rolls back the OS entry and shows an unchecked checkbox', async () => {
  vi.stubEnv('XDG_CONFIG_HOME', join(directory, 'xdg')); vi.stubEnv('APPIMAGE', '/opt/Companion.AppImage'); vi.stubEnv('APPDIR', dirname(process.execPath));
  await restart({ packaged: true, failSave: true });
  expect(existsSync(join(directory, 'xdg/autostart/whatsapp-companion.desktop'))).toBe(false);
  expect(desktopState()).toEqual({}); expect(trayMenu()[3].checked).toBe(false);
  expect(mocks.errors).toHaveBeenCalledOnce();
});
test('failed first-run OS apply never saves autostart or checks its checkbox', async () => {
  const config = join(directory, 'xdg'); writeFileSync(config, 'not a directory');
  vi.stubEnv('XDG_CONFIG_HOME', config); vi.stubEnv('APPIMAGE', '/opt/Companion.AppImage'); vi.stubEnv('APPDIR', dirname(process.execPath));
  await restart({ packaged: true });
  expect(desktopState()).toEqual({}); expect(trayMenu()[3].checked).toBe(false);
  expect(mocks.errors).toHaveBeenCalledOnce();
});


const localEvent = () => { const sender = mocks.views[0].webContents; return { sender, senderFrame: sender.mainFrame }; };
const localAction = (action: unknown) => mocks.handlers.get('companion:action')!(localEvent(), action);
const localStatus = () => mocks.handlers.get('companion:status')!(localEvent());
test('fresh main persists AI off and refuses AI operations and model listing before any provider access', async () => {
  expect(JSON.parse(readFileSync(join(directory, 'companion.json'), 'utf8')).global.aiFeatures).toBe(false);
  for (const action of [
    { type: 'key', provider: 'openai', key: 'sk-synthetic_fixture_key_never_real' }, { type: 'testProvider', provider: 'openai' },
    { type: 'getKey', provider: 'openai' }, { type: 'deleteKey', provider: 'openai' },
    { type: 'provider', provider: 'openai', model: 'gpt-6-luna' }, { type: 'reasoning', provider: 'openai', model: 'gpt-6-luna', effort: 'none' },
    { type: 'preferences', scope: 'global', patch: { suggestions: true } }, { type: 'learn', scope: 'general', examples: 'Synthetic example' },
    { type: 'profile', scope: 'general', description: 'Synthetic writing habits' }, { type: 'resetProfile', scope: 'general' },
    { type: 'resetStylePreferences', scope: '123@c.us' }, { type: 'resetPreferences', scope: 'global' },
    { type: 'autoRules', chatId: '123@c.us', patch: { dailyLimit: 1 } }, { type: 'autoPermission', chatId: '123@c.us', permission: 'resume' },
    { type: 'tagStickers', ids: ['a'.repeat(64)] }, { type: 'retryStickerTags', excludedIds: [] },
    { type: 'suggestStickerTags', id: 'a'.repeat(64), nonce: '00000000-0000-4000-8000-000000000001', searchTerms: '' }
  ]) expect(await localAction(action)).toEqual({ ok: false, error: 'AI features are off' });
  expect(await mocks.handlers.get('companion:models')!(localEvent(), 'openai')).toEqual({ models: [], error: 'AI features are off' });
  expect(mocks.vaultSet).not.toHaveBeenCalled(); expect(mocks.external).not.toHaveBeenCalled(); expect(mocks.generator).not.toHaveBeenCalled();
  expect(mocks.menus.at(-1)[0].submenu.find((item: any) => item.label === 'Chat AI settings').visible).toBe(false);
});
test('key IPC validates in main, saves via vault, exposes booleans only, and uses fixed provider links', async () => {
  await localAction({ type: 'preferences', scope: 'global', patch: { aiFeatures: true } });
  const key = 'sk-synthetic_fixture_key_never_real';
  for (const [provider, value, error] of [
    ['openai', 'invalid', 'This does not look like a valid API key.'],
    ['openai', 'sk-ant-synthetic_fixture_key_never_real', 'This looks like an Anthropic key.'],
    ['anthropic', key, 'This looks like an OpenAI key.']
  ]) expect(await localAction({ type: 'key', provider, key: value })).toEqual({ ok: false, error });
  expect(mocks.vaultSet).not.toHaveBeenCalled();
  const malformed = await localAction({ type: 'key', provider: 'openai', key, persist: true });
  expect(malformed).toEqual({ ok: false, error: 'Invalid setting. Check the value and try again.' });
  mocks.vaultSet.mockImplementationOnce(() => { throw new Error(key); });
  expect(await localAction({ type: 'key', provider: 'openai', key })).toEqual({ ok: false, error: 'Couldn’t save the key. Try again.' });
  expect(await localAction({ type: 'key', provider: 'openai', key })).toEqual({ ok: true });
  expect(mocks.vaultSet).toHaveBeenLastCalledWith('openai', key, true);
  const status = localStatus(); expect(status.keys).toEqual({ openai: true, anthropic: false });
  expect(JSON.stringify(status)).not.toContain(key); expect(JSON.stringify(mocks.records)).not.toContain(key);
  expect(readFileSync(join(directory, 'companion.json'), 'utf8')).not.toContain(key);
  expect(await localAction({ type: 'testProvider', provider: 'openai' })).toEqual({ ok: true, message: '✓ Connected' });
  expect(mocks.generator).not.toHaveBeenCalled();
  for (const provider of ['openai', 'anthropic']) await localAction({ type: 'getKey', provider });
  expect(mocks.external.mock.calls).toEqual([['https://platform.openai.com/api-keys'], ['https://console.anthropic.com/settings/keys']]);
  mocks.secure = false; await localAction({ type: 'checkSecureStorage' }); expect(localStatus().secureStorage).toBe(false);
  expect((await localAction({ type: 'key', provider: 'openai', key })).error).toContain('secure storage is unavailable');
});
test('saving/removing switches to a keyed provider and keeps both saved models and reasoning', async () => {
  await localAction({ type: 'preferences', scope: 'global', patch: { aiFeatures: true } });
  await localAction({ type: 'provider', provider: 'anthropic', model: 'claude-opus-5-5' });
  await localAction({ type: 'provider', provider: 'openai', model: 'gpt-6-astra' });
  await localAction({ type: 'key', provider: 'anthropic', key: 'sk-ant-synthetic_fixture_key_never_real' });
  expect(localStatus().state.provider).toBe('anthropic');
  await localAction({ type: 'key', provider: 'openai', key: 'sk-synthetic_fixture_key_never_real' });
  await localAction({ type: 'deleteKey', provider: 'anthropic' }); expect(localStatus().state.provider).toBe('openai');
  await localAction({ type: 'deleteKey', provider: 'openai' }); expect(localStatus().state.global.aiFeatures).toBe(true);
  expect(localStatus().state.models).toEqual({ openai: 'gpt-6-astra', anthropic: 'claude-opus-5-5' });
  expect(mocks.menus.at(-1)[0].submenu.find((item: any) => item.label === 'Chat AI settings').visible).toBe(true);
});
test.each([true, false])('key changes omit the provider warning and selected-provider tests clear it (fixture: %s)', async fixture => {
  if (!fixture) await restart({ live: true });
  await localAction({ type: 'preferences', scope: 'global', patch: { aiFeatures: true } });
  const warning = 'Provider configuration changed. Use Test connection to check account access.';
  await localAction({ type: 'key', provider: 'openai', key: 'sk-synthetic_fixture_key_never_real' });
  expect(localStatus().message).not.toBe(warning);
  await localAction({ type: 'deleteKey', provider: 'openai' });
  expect(localStatus().message).not.toBe(warning);
  await localAction({ type: 'key', provider: 'openai', key: 'sk-synthetic_fixture_key_never_real' });
  await localAction({ type: 'key', provider: 'anthropic', key: 'sk-ant-synthetic_fixture_key_never_real' });
  await localAction({ type: 'provider', provider: 'openai', model: 'gpt-6-astra' });
  expect(localStatus().message).toBe(warning);
  await localAction({ type: 'testProvider', provider: 'anthropic' });
  expect(localStatus().message).toBe(warning);
  expect(await localAction({ type: 'testProvider', provider: 'openai' })).toEqual({ ok: true, message: '✓ Connected' });
  expect(localStatus().message).toBe('');
  expect(mocks.views[0].webContents.send.mock.calls.filter(([channel]: [string]) => channel === 'companion:status').at(-1)?.[1].message).toBe('');
  await localAction({ type: 'reasoning', provider: 'openai', model: 'gpt-6-astra', effort: 'low' });
  expect(localStatus().message).toBe(warning);
  await localAction({ type: 'testProvider', provider: 'openai' });
  expect(localStatus().message).toBe('');
});
test('live provider checks use the pressed provider saved model and cancel when AI turns off', async () => {
  await restart({ live: true });
  await localAction({ type: 'preferences', scope: 'global', patch: { aiFeatures: true } });
  await localAction({ type: 'key', provider: 'openai', key: 'sk-synthetic_fixture_key_never_real' });
  await localAction({ type: 'key', provider: 'anthropic', key: 'sk-ant-synthetic_fixture_key_never_real' });
  await localAction({ type: 'provider', provider: 'anthropic', model: 'claude-opus-5-5' });
  await localAction({ type: 'provider', provider: 'openai', model: 'gpt-6-astra' });
  expect(await localAction({ type: 'testProvider', provider: 'anthropic' })).toEqual({ ok: true, message: '✓ Connected' });
  expect(mocks.generator).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'anthropic', model: 'claude-opus-5-5' }));
  let finish!: (text: string) => void; mocks.generator.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = localAction({ type: 'testProvider', provider: 'openai' });
  const signal = mocks.generator.mock.lastCall![0].signal;
  await localAction({ type: 'preferences', scope: 'global', patch: { aiFeatures: false } }); expect(signal.aborted).toBe(true);
  finish('Late Connected'); expect((await pending).ok).toBe(false);
  const calls = mocks.generator.mock.calls.length;
  await localAction({ type: 'testProvider', provider: 'openai' }); expect(mocks.generator.mock.calls).toHaveLength(calls);
});

test.each([false, true])('startup initializes an absent switch from saved keys once (fixture: %s)', async fixture => {
  const state = JSON.parse(readFileSync(join(directory, 'companion.json'), 'utf8')); delete state.global.aiFeatures;
  writeFileSync(join(directory, 'companion.json'), JSON.stringify(state));
  mocks.vaultKeys.set('openai', 'sk-synthetic_fixture_key_never_real');
  await restart({ live: !fixture });
  expect(localStatus().state.global.aiFeatures).toBe(!fixture);
  expect(JSON.parse(readFileSync(join(directory, 'companion.json'), 'utf8')).global.aiFeatures).toBe(!fixture);
  mocks.vaultKeys.clear(); await restart({ live: !fixture });
  expect(localStatus().state.global.aiFeatures).toBe(!fixture);
});
