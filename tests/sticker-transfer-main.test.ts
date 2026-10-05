import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import { emptySnapshot, initialState, type Snapshot, type Status, type StatusUpdate, type State, type ViewBounds } from '../src/shared/model';
import { StatusCache } from '../src/core/status';
import { STICKER_MAKER_CLEANUP_MS, STICKER_MAKER_WATCHDOG_MS } from '../src/shared/sticker-transfer';

type Contents = EventEmitter & { mainFrame: { url: string }; send: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>; capturePage: ReturnType<typeof vi.fn>; isFocused: ReturnType<typeof vi.fn>; session: { protocol: { handle: ReturnType<typeof vi.fn> } } };
const mocks = vi.hoisted(() => ({
  views: [] as { webContents: Contents; getBounds: () => ViewBounds }[],
  win: undefined as (EventEmitter & { contentView: EventEmitter; close: () => void }) | undefined,
  handlers: new Map<string, (...args: any[]) => any>(),
  ipc: undefined as EventEmitter | undefined,
  app: undefined as EventEmitter | undefined,
  animated: false,
  readFailure: false,
  reads: [] as string[],
  errors: [] as unknown[],
  diagnostics: [] as any[],
  menu: [] as any[],
  store: undefined as { update: (change: (state: State) => void) => void } | undefined
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const permissions = () => Object.assign(new EventEmitter(), {
    protocol: { handle: vi.fn() }, setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn()
  });
  class WebContents extends EventEmitter {
    mainFrame = { url: '' };
    session = permissions();
    send = vi.fn();
    loadURL = vi.fn(async (url: string) => { this.mainFrame.url = url; });
    isDestroyed = () => false;
    getZoomFactor = () => 1;
    setZoomMode = vi.fn();
    setVisualZoomLevelLimits = vi.fn(async () => {});
    setUserAgent = vi.fn();
    setWindowOpenHandler = vi.fn();
    isFocused = vi.fn(() => true);
    focus = vi.fn();
    close = vi.fn();
    capturePage = vi.fn(async () => ({
      isEmpty: () => false,
      resize: () => ({ toJPEG: () => Buffer.from('fixture shield') })
    }));
  }
  class WebContentsView {
    webContents = new WebContents();
    bounds = { x: 64, y: 0, width: 430, height: 860 };
    constructor() { mocks.views.push(this); }
    getBounds = () => this.bounds;
    setBounds = (bounds: typeof this.bounds) => { this.bounds = bounds; };
    setVisible = vi.fn();
    setBackgroundColor = vi.fn();
  }
  class BrowserWindow extends EventEmitter {
    webContents = new WebContents();
    contentView = Object.assign(new EventEmitter(), {
      addChildView: vi.fn(), getBounds: () => ({ width: 1280, height: 860 })
    });
    constructor() { super(); mocks.win = this; }
    isDestroyed = () => false;
    loadURL = this.webContents.loadURL;
    close() {
      const event = { preventDefault: vi.fn() };
      this.emit('close', event);
      if (!event.preventDefault.mock.calls.length) this.emit('closed');
    }
  }
  const app = Object.assign(new EventEmitter(), {
    commandLine: { removeSwitch: vi.fn(), hasSwitch: () => true },
    enableSandbox: vi.fn(), setName: vi.fn(), getPath: () => '/tmp/sticker-main-test',
    getVersion: () => 'test', requestSingleInstanceLock: () => true,
    whenReady: async () => {}, quit: vi.fn()
  });
  mocks.app = app;
  const ipcMain = new EventEmitter(); mocks.ipc = ipcMain;
  return {
    app, BrowserWindow, WebContentsView, protocol: { registerSchemesAsPrivileged: vi.fn() },
    ipcMain: Object.assign(ipcMain, { handle: (name: string, handler: (...args: any[]) => any) => mocks.handlers.set(name, handler) }),
    session: { defaultSession: permissions() },
    dialog: { showErrorBox: (...args: unknown[]) => mocks.errors.push(args) },
    shell: {}, Menu: { buildFromTemplate: vi.fn(template => { mocks.menu = template; return template; }), setApplicationMenu: vi.fn() }
  };
});
vi.mock('../src/main/sticker-send-diagnostics', () => ({ StickerSendDiagnostics: class {
  append(send: unknown, diagnostics: unknown) { mocks.diagnostics.push({ send, diagnostics }); }
} }));
vi.mock('../src/main/store', () => ({ Store: class {
  state = { ...initialState(), stickers: [{ id: 'a'.repeat(64), groups: [], kind: 'static' as const, size: 12, firstSeen: 0, lastSeen: 0, searchTerms: '' }] };
  constructor() { mocks.store = this; }
  readSticker = (id: string) => { mocks.reads.push(id); if (mocks.readFailure) throw new Error('Sticker file is missing or damaged.'); return { image: 'data:image/webp;base64,UklGRg==', bytes: Buffer.alloc(12), animated: mocks.animated }; };
  readStickerBytes = async (id: string) => { const { image: _image, ...verified } = this.readSticker(id); return verified; };
  update(change: (state: State) => void) { const next = structuredClone(this.state); change(next); this.state = next; }
  forgetSticker(id: string) { this.update(state => { state.stickers = state.stickers.filter(s => s.id !== id); state.forgottenStickers.push(id); }); }
  stickerFiles = {
    write: ({ image: _image, ...metadata }: any) => { mocks.readFailure = false; return { ...metadata, size: 12, groups: [], kind: 'static' as const }; }
  };
} }));
vi.mock('../src/main/vault', () => ({ Vault: class {
  has = () => false;
  secure = () => false;
} }));
vi.mock('../src/main/sticker-bytes', () => ({ storedSticker: (image: string) => ({ image, bytes: Buffer.alloc(12), animated: mocks.animated }) }));

const nonce = '550e8400-e29b-41d4-a716-446655440000';
const snapshot: Snapshot = { ...emptySnapshot, chatId: '123@c.us', name: 'A friend', conversationOpen: true, ready: true, revision: '1' };
const controls = () => mocks.views[0].webContents;
const remote = () => mocks.views[1].webContents;
const eventFor = (sender: Contents) => ({ sender, senderFrame: sender.mainFrame });
const status = (): Status => mocks.handlers.get('companion:status')!(eventFor(controls()));
const action = (raw: unknown) => mocks.handlers.get('companion:action')!(eventFor(controls()), raw);
const remoteEvent = (raw: unknown) => mocks.ipc!.emit('companion:event', eventFor(remote()), raw);
const authorize = (phase: 'disclose' | 'send') => mocks.handlers.get('companion:authorize-sticker')!(eventFor(remote()), {
  nonce, phase, snapshot: phase === 'send' ? { ...snapshot, ready: false, stickerPreparation: nonce } : snapshot
});
const clicked = () => remoteEvent({ type: 'stickerClicked', nonce });
const confirmed = () => remoteEvent({ type: 'stickerSent', nonce, clicked: true, confirmed: true });

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(0);
  vi.stubGlobal('__dirname', '/tmp/sticker-main-test');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.animated = false; mocks.readFailure = false; mocks.reads.length = 0; mocks.diagnostics.length = 0;
  mocks.views.length = 0; mocks.handlers.clear(); mocks.errors.length = 0;
  await import('../src/main/index');
  await vi.dynamicImportSettled();
  expect(mocks.errors).toEqual([]);
  remoteEvent({ type: 'snapshot', snapshot });
  expect(await action({ type: 'panel', panel: 'stickers' })).toEqual({ ok: true });
  const sending = action({ type: 'sendSticker', id: 'a'.repeat(64), nonce, destinationToken: status().chat.destinationToken });
  // Let capture publish the shield, then acknowledge its local draw.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(status().stickerShield?.nonce).toBe(nonce);
  mocks.handlers.get('companion:shield-ready')!(eventFor(controls()), { nonce, reducedMotion: true });
  expect(await sending).toEqual({ ok: true });
  expect(authorize('disclose')).toBe(true);
  expect(inputBlocked()).toBe(true);
  expect(controls().focus).toHaveBeenCalled();
  remote().send.mockClear();
});
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  mocks.ipc?.removeAllListeners();
});

const inputBlocked = (input = { type: 'keyDown', key: 'x' }) => {
  const preventDefault = vi.fn(); remote().emit('before-input-event', { preventDefault }, input);
  return preventDefault.mock.calls.length > 0;
};

const publications = () => controls().send.mock.calls.filter(([channel]) => channel === 'companion:status').map(([, update]) => update as StatusUpdate);
const chromeCommands = () => remote().send.mock.calls.filter(([channel, command]) => channel === 'companion:command' && command.type === 'chrome');

test('status polling during pending maker capture preserves the subscriber send and busy chat update', async () => {
  await action({ type: 'cancelSticker' });
  await vi.advanceTimersByTimeAsync(STICKER_MAKER_CLEANUP_MS);
  const cache = new StatusCache();
  mocks.ipc!.emit('companion:subscribe', eventFor(controls()));
  cache.accept(publications().at(-1)!);
  expect(status().chat.canSendSticker).toBe(true);
  controls().send.mockClear();
  let finishCapture!: () => void;
  remote().capturePage.mockImplementationOnce(() => new Promise(resolve => {
    finishCapture = () => resolve({ isEmpty: () => false, resize: () => ({ toJPEG: () => Buffer.from('fixture shield') }) });
  }));
  const nextNonce = '550e8400-e29b-41d4-a716-446655440001';
  const sending = action({ type: 'sendSticker', id: 'a'.repeat(64), nonce: nextNonce, destinationToken: status().chat.destinationToken });
  for (let read = 0; read < 5; read++) {
    expect(status()).toMatchObject({ stickerSend: { nonce: nextNonce, state: 'preparing' }, chat: { canSendSticker: false, stickerSendBlockedReason: 'busy' } });
  }
  expect(publications()).toHaveLength(0);
  finishCapture();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(publications()[0]).toMatchObject({ stickerSend: { nonce: nextNonce, state: 'preparing' },
    chat: { canSendSticker: false, stickerSendBlockedReason: 'busy' }, stickerShield: { nonce: nextNonce, image: expect.any(String) } });
  for (const update of publications()) cache.accept(update);
  expect(cache.accept({ sequence: 0 })).toMatchObject({ stickerSend: status().stickerSend, chat: status().chat, stickerShield: status().stickerShield });
  mocks.handlers.get('companion:shield-ready')!(eventFor(controls()), { nonce: nextNonce, reducedMotion: true });
  expect(await sending).toEqual({ ok: true });
});

test.each(['did-start-loading', 'did-finish-load', 'render-process-gone', 'destroyed'])('controls %s resets status and the next publication is complete', async event => {
  await action({ type: 'cancelSticker' });
  controls().send.mockClear();
  controls().emit(event);
  await action({ type: 'panel', panel: 'stickers' });
  const update = publications()[0];
  expect(update.state?.stickers).toHaveLength(1);
  expect(update).toHaveProperty('chat'); expect(update).toHaveProperty('keys');
  expect(new StatusCache().accept(update)).toBeDefined();
});

test.each(['reload', 'crash and reload'])('controls %s closes the panel and publishes a reopened panel to the fresh consumer', async kind => {
  await action({ type: 'cancelSticker' });
  if (kind === 'crash and reload') controls().emit('render-process-gone');
  controls().emit('did-start-navigation', {}, controls().mainFrame.url, false, true);
  controls().emit('did-start-loading');
  controls().send.mockClear();
  controls().emit('did-finish-load');
  const cache = new StatusCache();
  expect(cache.accept(publications()[0])?.panel).toBeNull();
  // One-shot reads remain complete without changing subscription history.
  expect(cache.accept(status())?.panel).toBeNull();
  controls().send.mockClear();
  await action({ type: 'panel', panel: 'stickers' });
  for (const update of publications()) cache.accept(update);
  expect(cache.accept({ sequence: 0 })?.panel).toBe('stickers');
});

test('controls reload resends shield bytes for the same nonce, and subscriptions always receive complete status', () => {
  controls().send.mockClear();
  controls().emit('did-start-loading');
  controls().emit('did-finish-load');
  expect(publications()[0].stickerShield).toMatchObject({ nonce, image: expect.any(String) });
  for (let i = 0; i < 2; i++) {
    controls().send.mockClear();
    mocks.ipc!.emit('companion:subscribe', eventFor(controls()));
    expect(publications()).toHaveLength(1);
    expect(new StatusCache().accept(publications()[0])).toMatchObject({ panel: 'stickers', stickerShield: { nonce, image: expect.any(String) } });
  }
  controls().send.mockClear();
  mocks.ipc!.emit('companion:subscribe', eventFor(remote()));
  expect(publications()).toHaveLength(0);
});

test.each(['did-start-loading', 'did-finish-load', 'render-process-gone', 'destroyed', 'navigation'])('remote %s resets chrome delivery even with unchanged geometry', async event => {
  await action({ type: 'cancelSticker' });
  remote().send.mockClear();
  if (event === 'navigation') remote().emit('did-start-navigation', {}, 'https://web.whatsapp.com/', false, true);
  else remote().emit(event);
  mocks.win!.contentView.emit('bounds-changed');
  expect(chromeCommands().length).toBeGreaterThan(0);
  expect(chromeCommands().at(-1)![1]).toMatchObject({ panel: 'stickers' });
  remote().send.mockClear();
  mocks.win!.contentView.emit('bounds-changed');
  expect(chromeCommands()).toHaveLength(0);
});

test.each([false, true])('recent exact-hash discovery is suppressed only while its blob verifies (damaged: %s)', async damaged => {
  const { createHash } = await import('node:crypto');
  const { StickerInbox } = await import('../src/main/sticker-inbox');
  const add = vi.spyOn(StickerInbox.prototype, 'add').mockImplementation(() => {});
  const bytes = Buffer.alloc(12); bytes.write('RIFF'); bytes.writeUInt32LE(4, 4); bytes.write('WEBP', 8);
  const id = createHash('sha256').update(bytes).digest('hex');
  mocks.store!.update(state => { state.stickers[0].id = id; state.stickers[0].lastSeen = Date.now(); });
  mocks.readFailure = damaged; mocks.reads.length = 0;
  remoteEvent({ type: 'sticker', image: `data:image/webp;base64,${bytes.toString('base64')}` });
  expect(mocks.reads).toEqual([id]); expect(add).toHaveBeenCalledTimes(damaged ? 1 : 0);
  if (damaged) expect(add).toHaveBeenCalledWith(expect.objectContaining({ id }));
});

const interruptions = [
  { name: 'Escape / cancelSticker', run: () => action({ type: 'cancelSticker' }) },
  { name: 'panel close', run: () => action({ type: 'panel', panel: null }) },
  { name: 'trusted rail navigation', run: () => remoteEvent({ type: 'navigate', panel: null }) },
  { name: 'chat change', run: () => remoteEvent({ type: 'snapshot', snapshot: { ...snapshot, chatId: '456@c.us', name: 'B', revision: '2' } }) },
  { name: 'conversation hidden', run: () => remoteEvent({ type: 'snapshot', snapshot: { ...snapshot, conversationOpen: false, ready: false, stickerPreparation: nonce } }) },
  { name: 'remote chat cancellation', run: () => remoteEvent({ type: 'stickerCancelled', nonce, reason: 'chat-changed', detail: 'chat-changed' }) },
  { name: 'reload action', run: () => action({ type: 'reload' }) },
  { name: 'reload menu', run: () => mocks.menu[0].submenu.find((item: any) => item.label === 'Reload WhatsApp').click() },
  { name: 'remote navigation', run: () => remote().emit('did-start-navigation', {}, 'https://web.whatsapp.com/', false, true) },
  { name: 'controls navigation', run: () => controls().emit('did-start-navigation', {}, controls().mainFrame.url, false, true) },
  { name: 'remote renderer gone', run: () => remote().emit('render-process-gone') },
  { name: 'controls renderer gone', run: () => controls().emit('render-process-gone') },
  { name: 'resize', run: () => mocks.win!.contentView.emit('bounds-changed') },
  { name: 'shield cap', run: () => vi.advanceTimersByTimeAsync(10_000 - Date.now()) }
];

test.each(interruptions.filter(({ name }) => name !== 'shield cap'))('$name before the final grant cancels preparation', async ({ run }) => {
  await run();
  expect(status().stickerSend?.state).toBe('cancelled');
  expect(authorize('send')).toBe(false);
  clicked(); confirmed();
  expect(status().stickerSend?.state).toBe('cancelled');
});

test('the shield cap before the final grant only clears the visual shield', async () => {
  await vi.advanceTimersByTimeAsync(10_000);
  expect(status().stickerShield).toBeNull();
  expect(status().stickerSend?.state).toBe('preparing');
  expect(authorize('send')).toBe(true);
  confirmed();
  expect(status().stickerSend).toMatchObject({ state: 'sent', sent: 'confirmed' });
});

for (const order of ['before clicked', 'after clicked', 'after result', 'after result without clicked'] as const) {
  test.each(interruptions)(`$name ${order} after the final grant preserves the send outcome`, async ({ run }) => {
    // Grant late enough for the visual cap to run before the result watchdog.
    await vi.advanceTimersByTimeAsync(3000);
    expect(authorize('send')).toBe(true);
    expect(status().stickerSend?.state).toBe('sending');
    if (order === 'after clicked' || order === 'after result') clicked();
    if (order === 'after result' || order === 'after result without clicked') confirmed();
    await run();
    expect(remote().send.mock.calls.some(([channel, command]) => channel === 'companion:command' && command.type === 'cancelSticker')).toBe(false);
    if (order === 'before clicked' || order === 'after clicked') {
      expect(status().stickerSend?.state).toBe('sending');
      await action({ type: 'panel', panel: 'stickers' });
      remoteEvent({ type: 'snapshot', snapshot });
      expect(await action({ type: 'sendSticker', id: 'a'.repeat(64), nonce: '550e8400-e29b-41d4-a716-446655440001', destinationToken: status().chat.destinationToken })).toMatchObject({ ok: false, error: 'Wait for the current sticker.' });
      clicked(); confirmed();
    } else {
      clicked();
    }
    expect(status().stickerSend).toMatchObject({ nonce, state: 'sent', sent: 'confirmed' });
  });
}

test.each(interruptions)('$name after the grant without any clicked/result notification becomes unknown', async ({ run }) => {
  await vi.advanceTimersByTimeAsync(3000);
  expect(authorize('send')).toBe(true);
  await run();
  expect(status().stickerSend?.state).toBe('sending');
  await vi.advanceTimersByTimeAsync(11_000 - Date.now() - 1);
  expect(status().stickerSend?.state).toBe('sending');
  await vi.advanceTimersByTimeAsync(1);
  expect(status().stickerSend).toMatchObject({ nonce, state: 'failed', sent: 'unknown', reason: 'unconfirmed', detail: 'confirm-timeout' });
});

test('clicked replenishes the confirmation and cleanup budget after a delayed grant reply', async () => {
  expect(authorize('send')).toBe(true);
  await vi.advanceTimersByTimeAsync(3000);
  clicked();
  await vi.advanceTimersByTimeAsync(STICKER_MAKER_WATCHDOG_MS - 1);
  expect(status().stickerSend?.state).toBe('sending');
  confirmed();
  await vi.advanceTimersByTimeAsync(1);
  expect(status().stickerSend).toMatchObject({ state: 'sent', sent: 'confirmed' });
});

const inputExits = interruptions.filter(({ name }) => name !== 'shield cap');
inputExits.push(
  { name: 'window close', run: () => mocks.win!.close() },
  { name: 'app quit', run: () => mocks.app!.emit('before-quit') },
  { name: 'window closed', run: () => mocks.win!.emit('closed') }
);
test.each(inputExits)('maker input exclusion ends on $name before authorization', async ({ name, run }) => {
  expect(inputBlocked()).toBe(true);
  await run();
  if (['Escape / cancelSticker', 'panel close', 'trusted rail navigation', 'resize'].includes(name)) {
    expect(inputBlocked()).toBe(true);
    await vi.advanceTimersByTimeAsync(STICKER_MAKER_CLEANUP_MS - 1);
    expect(inputBlocked()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(inputBlocked()).toBe(false);
  controls().focus.mockClear(); remote().emit('focus');
  expect(controls().focus).not.toHaveBeenCalled();
});
test.each(inputExits.filter(({ name }) => name !== 'remote chat cancellation' && name !== 'resize' && name !== 'Escape / cancelSticker' && name !== 'panel close' && name !== 'trusted rail navigation'))('maker input exclusion ends on $name after authorization', async ({ run }) => {
  expect(authorize('send')).toBe(true);
  expect(inputBlocked()).toBe(true);
  await run();
  expect(inputBlocked()).toBe(false);
});
test.each([
  { type: 'keyDown', key: 'x' }, { type: 'keyUp', key: 'x' },
  { type: 'keyDown', key: 'v', control: true }, { type: 'keyDown', key: 'v', meta: true },
  { type: 'keyDown', key: 'Insert', shift: true }, { type: 'keyDown', key: 'Process', isComposing: true }
])('maker excludes keyboard, paste shortcuts and IME: %j', input => {
  expect(inputBlocked(input)).toBe(true);
  controls().focus.mockClear(); remote().emit('focus');
  expect(controls().focus).toHaveBeenCalledOnce();
});
test.each(['sent', 'failed', 'draft-appeared'] as const)('maker input exclusion ends on terminal %s', terminal => {
  expect(authorize('send')).toBe(true);
  remoteEvent({ type: 'stickerSent', nonce, clicked: true, confirmed: terminal === 'sent',
    ...(terminal === 'draft-appeared' ? { reason: 'draft', detail: terminal } : {}) });
  expect(inputBlocked()).toBe(false);
});
test('maker watchdog and preparation timeout both release input', async () => {
  expect(authorize('send')).toBe(true);
  await vi.advanceTimersByTimeAsync(STICKER_MAKER_WATCHDOG_MS);
  expect(inputBlocked()).toBe(false);
});
test('preparation timeout releases input without a result', async () => {
  await vi.advanceTimersByTimeAsync(60_000);
  expect(status().stickerSend?.state).toBe('failed');
  expect(inputBlocked()).toBe(false);
});
test('visual cap alone retains maker input exclusion', async () => {
  await vi.advanceTimersByTimeAsync(10_000);
  expect(status().stickerShield).toBeNull();
  expect(inputBlocked()).toBe(true);
});

async function newSend(next: Snapshot, animated: boolean, still?: true) {
  await action({ type: 'cancelSticker' });
  await vi.advanceTimersByTimeAsync(STICKER_MAKER_WATCHDOG_MS);
  remoteEvent({ type: 'snapshot', snapshot: next });
  mocks.animated = animated; remote().send.mockClear();
  const nextNonce = '550e8400-e29b-41d4-a716-446655440001';
  expect(await action({ type: 'sendSticker', id: 'a'.repeat(64), nonce: nextNonce, destinationToken: status().chat.destinationToken, ...(still && { still }) })).toEqual({ ok: true });
  return nextNonce;
}
test('a hidden main with retained chat identity is unavailable and rejects a fresh Send', async () => {
  await action({ type: 'cancelSticker' });
  const displayed = status().chat.destinationToken;
  remote().send.mockClear();
  remoteEvent({ type: 'snapshot', snapshot: { ...snapshot, conversationOpen: false, ready: false } });
  expect(status().chat).toMatchObject({ chatId: snapshot.chatId, name: snapshot.name, ready: false, canSendSticker: false, settingsId: null });
  expect(status().chat.destinationToken).not.toBe(displayed);
  expect(await action({ type: 'sendSticker', id: 'a'.repeat(64), nonce: '550e8400-e29b-41d4-a716-446655440001', destinationToken: status().chat.destinationToken })).toEqual({ ok: false, error: 'Open a conversation before sending a sticker.' });
  expect(remote().send.mock.calls.some(([, command]) => ['prepareSticker', 'makeSticker'].includes(command.type))).toBe(false);
  expect(inputBlocked()).toBe(false);
});
test('a visible chat with an empty composer starts the maker route', () => {
  expect(status().chat).toMatchObject({ canSendSticker: false, stickerSendBlockedReason: 'busy' });
  expect(status().stickerSend).toMatchObject({ route: 'maker', animated: false, state: 'preparing' });
});
test('a visible opaque-ID chat with a missing composer remains recognized and uses the picker', async () => {
  const nextNonce = await newSend({ ...snapshot, chatId: null, kind: 'unknown', ready: false, messages: [{ id: 'OPAQUE123', text: 'Hello', outgoing: false }] }, false);
  expect(status().chat.settingsId).toMatch(/^local:/);
  expect(status().chat).toMatchObject({ canSendSticker: false, stickerSendBlockedReason: 'busy' });
  expect(status().stickerSend).toMatchObject({ nonce: nextNonce, route: 'picker', state: 'finding' });
  expect(remote().send.mock.calls.some(([, command]) => command.type === 'prepareSticker')).toBe(true);
  expect(inputBlocked()).toBe(false);
});
test.each([{ draft: 'Unsent text' }, { draft: ' ' }, { draftIssue: 'unsupported' as const }, { composing: true }, { ready: false }])('static with an unsafe composer uses picker without blocking input: %j', async change => {
  const nextNonce = await newSend({ ...snapshot, ...change }, false);
  expect(status().chat).toMatchObject({ canSendSticker: false, stickerSendBlockedReason: 'busy' });
  expect(status().stickerSend).toMatchObject({ nonce: nextNonce, route: 'picker', state: 'finding' });
  expect(remote().send.mock.calls.some(([, command]) => command.type === 'prepareSticker')).toBe(true);
  expect(remote().send.mock.calls.some(([, command]) => command.type === 'makeSticker')).toBe(false);
  expect(inputBlocked()).toBe(false);
  remoteEvent({ type: 'stickerPrepared', nonce: nextNonce, found: false });
  expect(status().stickerSend).toMatchObject({ state: 'failed', reason: 'draft', detail: 'draft-present', sent: 'not-sent' });
});
test.each([false, true])('Send still with draft fails without interacting with the page (animated=%s)', async animated => {
  await newSend({ ...snapshot, draft: 'Unsent text' }, animated, true);
  expect(status().stickerSend).toMatchObject({ route: 'maker', state: 'failed', reason: 'draft', detail: 'draft-present', sent: 'not-sent' });
  expect(remote().send.mock.calls.filter(([, command]) => ['prepareSticker', 'makeSticker', 'cancelSticker'].includes(command.type))).toEqual([]);
  expect(inputBlocked()).toBe(false);
});
test.each([undefined, false, true])('picker results use explicit confirmation=%s', async confirmation => {
  const nextNonce = await newSend({ ...snapshot, draft: 'Unsent text' }, false);
  remoteEvent({ type: 'stickerPrepared', nonce: nextNonce, found: true });
  expect(mocks.handlers.get('companion:authorize-sticker')!(eventFor(remote()), nextNonce)).toBe(true);
  remoteEvent({ type: 'stickerSent', nonce: nextNonce, clicked: true, ...(confirmation !== undefined && { confirmed: confirmation }) });
  expect(status().stickerSend).toMatchObject({ state: confirmation ? 'sent' : 'failed', sent: confirmation ? 'confirmed' : 'unknown' });
});

test.each([{ draft: 'New draft' }, { draftIssue: 'unsupported' as const }, { composing: true }])('draft appearing during preparation ends input exclusion: %j', patch => {
  remoteEvent({ type: 'snapshot', snapshot: { ...snapshot, ...patch, stickerPreparation: nonce } });
  expect(status().stickerSend).toMatchObject({ state: 'failed', reason: 'draft', detail: 'draft-appeared', sent: 'not-sent' });
  expect(inputBlocked()).toBe(false);
});
test('terminal results stop redirecting remote focus', () => {
  expect(authorize('send')).toBe(true); confirmed();
  controls().focus.mockClear(); remote().emit('focus');
  expect(controls().focus).not.toHaveBeenCalled();
});


test.each(['panel close', 'trusted rail navigation', 'Escape / cancelSticker', 'resize'])('%s after authorization retains input until connector teardown', async name => {
  expect(authorize('send')).toBe(true);
  await interruptions.find(exit => exit.name === name)!.run();
  expect(status().stickerSend?.state).toBe('sending');
  expect(inputBlocked()).toBe(true);
  confirmed();
  expect(inputBlocked()).toBe(false);
  controls().focus.mockClear(); remote().emit('focus');
  expect(controls().focus).not.toHaveBeenCalled();
});

test.each(['result', 'preparation snapshot', 'cleanup timeout'] as const)('cancelled assigned maker releases input on %s', async exit => {
  remoteEvent({ type: 'snapshot', snapshot: { ...snapshot, ready: false, stickerPreparation: nonce } });
  await action({ type: 'cancelSticker' });
  expect(status().stickerSend?.state).toBe('cancelled');
  expect(inputBlocked()).toBe(true);
  // An unrelated pre-assignment snapshot cannot acknowledge editor cleanup.
  if (exit === 'result') remoteEvent({ type: 'stickerSent', nonce, clicked: false, confirmed: false });
  else if (exit === 'preparation snapshot') remoteEvent({ type: 'snapshot', snapshot });
  else {
    await vi.advanceTimersByTimeAsync(STICKER_MAKER_CLEANUP_MS - 1);
    expect(inputBlocked()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(status().stickerSend?.state).toBe('cancelled');
  expect(inputBlocked()).toBe(false);
  controls().focus.mockClear(); remote().emit('focus');
  expect(controls().focus).not.toHaveBeenCalled();
});

test('a pre-assignment snapshot cannot release cancelled disclosed maker cleanup', async () => {
  await action({ type: 'cancelSticker' });
  remoteEvent({ type: 'snapshot', snapshot });
  expect(inputBlocked()).toBe(true);
  await vi.advanceTimersByTimeAsync(STICKER_MAKER_CLEANUP_MS);
  expect(inputBlocked()).toBe(false);
});

async function nextHeldMaker(reducedMotion = true) {
  expect(authorize('send')).toBe(true); confirmed();
  remoteEvent({ type: 'snapshot', snapshot });
  const nextNonce = '550e8400-e29b-41d4-a716-446655440001';
  const sending = action({ type: 'sendSticker', id: 'a'.repeat(64), nonce: nextNonce, destinationToken: status().chat.destinationToken });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  mocks.handlers.get('companion:shield-ready')!(eventFor(controls()), { nonce: nextNonce, reducedMotion });
  expect(await sending).toEqual({ ok: true });
  // The mock webContents records makeSticker without delivering it, just like
  // the desktop fixture's held-command queue. No disclosure was requested.
  expect(remote().send.mock.calls.some(([, command]) => command.type === 'makeSticker' && command.nonce === nextNonce)).toBe(true);
  expect(inputBlocked()).toBe(true);
  return nextNonce;
}

test('shield restore waits for the local fade acknowledgment and ignores invalid or stale acknowledgments', async () => {
  const heldNonce = await nextHeldMaker(false);
  await action({ type: 'cancelSticker' });
  expect(status().stickerShield).toBeNull();
  await vi.advanceTimersByTimeAsync(150);
  expect(mocks.views[0].getBounds().width).toBe(1280 - 64);
  const faded = mocks.handlers.get('companion:shield-faded')!;
  faded(eventFor(remote()), heldNonce);
  faded(eventFor(controls()), 'invalid');
  faded(eventFor(controls()), nonce);
  expect(mocks.views[0].getBounds().width).toBe(1280 - 64);
  faded(eventFor(controls()), heldNonce);
  expect(mocks.views[0].getBounds().width).toBe(430);
  await vi.advanceTimersByTimeAsync(1000);
  expect(mocks.views[0].getBounds().width).toBe(430);
});

test('shield restore has a short bound when no fade acknowledgment arrives', async () => {
  await nextHeldMaker(false);
  await action({ type: 'cancelSticker' });
  await vi.advanceTimersByTimeAsync(749);
  expect(mocks.views[0].getBounds().width).toBe(1280 - 64);
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.views[0].getBounds().width).toBe(430);
});

test('an old fade acknowledgment and restore timeout cannot shrink a new shield', async () => {
  const heldNonce = await nextHeldMaker(false);
  await action({ type: 'cancelSticker' });
  remoteEvent({ type: 'snapshot', snapshot });
  const nextNonce = '550e8400-e29b-41d4-a716-446655440002';
  const sending = action({ type: 'sendSticker', id: 'a'.repeat(64), nonce: nextNonce, destinationToken: status().chat.destinationToken });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  mocks.handlers.get('companion:shield-ready')!(eventFor(controls()), { nonce: nextNonce, reducedMotion: false });
  expect(await sending).toEqual({ ok: true });
  mocks.handlers.get('companion:shield-faded')!(eventFor(controls()), heldNonce);
  await vi.advanceTimersByTimeAsync(1000);
  expect(status().stickerShield?.nonce).toBe(nextNonce);
  expect(mocks.views[0].getBounds().width).toBe(1280 - 64);
});

test.each(inputExits)('$name releases an undisclosed held command immediately and keeps late permissions revoked', async ({ name, run }) => {
  const heldNonce = await nextHeldMaker();
  remote().send.mockClear();
  remote().focus.mockClear();
  // This interruption normally targets the first send in beforeEach.
  if (name === 'remote chat cancellation') remoteEvent({ type: 'stickerCancelled', nonce: heldNonce, reason: 'chat-changed' });
  else await run();
  expect(status().stickerSend).toMatchObject({ nonce: heldNonce, state: 'cancelled' });
  expect(inputBlocked()).toBe(false);
  if (name === 'trusted rail navigation' || name === 'panel close') {
    expect(status().panel).toBeNull();
    expect(remote().send.mock.calls.filter(([, command]) => command.type === 'cancelSticker')).toHaveLength(1);
    expect(remote().focus).toHaveBeenCalledOnce();
  }
  if (name === 'controls navigation' || name === 'controls renderer gone') {
    expect(status().panel).toBeNull();
    expect(remote().focus).toHaveBeenCalledOnce();
  }
  controls().focus.mockClear(); remote().emit('focus');
  expect(controls().focus).not.toHaveBeenCalled();
  // Release the held command: both permission requests stay denied. There is
  // no result/cleanup acknowledgement to make ownership end in this case.
  expect(mocks.handlers.get('companion:authorize-sticker')!(eventFor(remote()), { nonce: heldNonce, phase: 'disclose', snapshot })).toBe(false);
  expect(mocks.handlers.get('companion:authorize-sticker')!(eventFor(remote()), { nonce: heldNonce, phase: 'send', snapshot: { ...snapshot, ready: false, stickerPreparation: heldNonce } })).toBe(false);
  expect(inputBlocked()).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(inputBlocked()).toBe(false);
  remoteEvent({ type: 'stickerClicked', nonce: heldNonce });
  remoteEvent({ type: 'stickerSent', nonce: heldNonce, clicked: false, confirmed: false });
  expect(inputBlocked()).toBe(false);
  expect(status().stickerSend?.state).toBe('cancelled');
  expect(remote().send.mock.calls.some(([, command]) => ['makeSticker', 'sendSticker', 'prepareSticker'].includes(command.type))).toBe(false);
});

test.each(['disclose', 'send'] as const)('late %s permission from an old command cannot cancel or release a newer maker', async phase => {
  const nextNonce = await nextHeldMaker();
  const authorizeNext = mocks.handlers.get('companion:authorize-sticker')!;
  expect(authorizeNext(eventFor(remote()), { nonce: nextNonce, phase: 'disclose', snapshot })).toBe(true);
  remoteEvent({ type: 'snapshot', snapshot: { ...snapshot, ready: false, stickerPreparation: nextNonce } });
  const destinationToken = status().chat.destinationToken;
  // An old held request carries a stale chat snapshot. Reject it before it
  // enters destination observation or acknowledges the newer editor's cleanup.
  expect(authorizeNext(eventFor(remote()), { nonce, phase, snapshot: { ...snapshot, chatId: '456@c.us', name: 'B', revision: '2', draft: 'Old draft' } })).toBe(false);
  expect(status().stickerSend).toMatchObject({ nonce: nextNonce, state: 'preparing' });
  expect(status().chat.destinationToken).toBe(destinationToken);
  expect(inputBlocked()).toBe(true);
  expect(authorizeNext(eventFor(remote()), { nonce: nextNonce, phase: 'send', snapshot: { ...snapshot, ready: false, stickerPreparation: nextNonce } })).toBe(true);
});

test('a new send waits for cancelled maker cleanup, and old results cannot release its input', async () => {
  await action({ type: 'cancelSticker' });
  expect(status().stickerSend).toMatchObject({ nonce, state: 'cancelled', detail: 'cancelled' });
  expect(status().chat).toMatchObject({ ready: true, canSendSticker: false, stickerSendBlockedReason: 'busy' });
  const nextNonce = '550e8400-e29b-41d4-a716-446655440001';
  const nextAction = { type: 'sendSticker', id: 'a'.repeat(64), nonce: nextNonce, destinationToken: status().chat.destinationToken };
  expect(await action(nextAction)).toEqual({ ok: false, error: 'Wait for the current sticker.' });
  remoteEvent({ type: 'stickerSent', nonce, clicked: false, confirmed: false });
  expect(status().chat).toMatchObject({ canSendSticker: true, stickerSendBlockedReason: undefined });
  const sending = action(nextAction);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  mocks.handlers.get('companion:shield-ready')!(eventFor(controls()), { nonce: nextNonce, reducedMotion: true });
  expect(await sending).toEqual({ ok: true });
  remoteEvent({ type: 'stickerSent', nonce, clicked: false, confirmed: false });
  remoteEvent({ type: 'stickerCancelled', nonce, reason: 'chat-changed' });
  expect(inputBlocked()).toBe(true);
});

test('assignment observed after cancellation releases cleanup as soon as its token disappears', async () => {
  await action({ type: 'cancelSticker' });
  // A file was assigned, but the periodic snapshot had not yet reached main
  // when Escape cancelled this send. The remaining ownership is cleanup only.
  remoteEvent({ type: 'snapshot', snapshot: { ...snapshot, stickerPreparation: nonce } });
  expect(status().chat).toMatchObject({ ready: true, canSendSticker: false, stickerSendBlockedReason: 'busy' });
  expect(inputBlocked()).toBe(true);
  await vi.advanceTimersByTimeAsync(2200);
  remoteEvent({ type: 'snapshot', snapshot });
  expect(inputBlocked()).toBe(false);
  expect(status().stickerSend).toMatchObject({ nonce, state: 'cancelled' });
  expect(status().chat).toMatchObject({ canSendSticker: true, stickerSendBlockedReason: undefined });
  const nextNonce = '550e8400-e29b-41d4-a716-446655440001';
  const sending = action({ type: 'sendSticker', id: 'a'.repeat(64), nonce: nextNonce, destinationToken: status().chat.destinationToken });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  mocks.handlers.get('companion:shield-ready')!(eventFor(controls()), { nonce: nextNonce, reducedMotion: true });
  expect(await sending).toEqual({ ok: true });
  expect(status().stickerSend).toMatchObject({ nonce: nextNonce, state: 'preparing' });
});

test('lost teardown snapshots hold Send only through the remaining disclosure budget and publish its release', async () => {
  await vi.advanceTimersByTimeAsync(4500);
  await action({ type: 'cancelSticker' });
  const nextNonce = '550e8400-e29b-41d4-a716-446655440001';
  const nextAction = { type: 'sendSticker', id: 'a'.repeat(64), nonce: nextNonce, destinationToken: status().chat.destinationToken };
  expect(status().chat).toMatchObject({ canSendSticker: false, stickerSendBlockedReason: 'busy' });
  expect(await action(nextAction)).toEqual({ ok: false, error: 'Wait for the current sticker.' });
  await action({ type: 'cancelSticker' }); // Repeated cancellation cannot extend cleanup.
  await vi.advanceTimersByTimeAsync(STICKER_MAKER_CLEANUP_MS - Date.now() - 1);
  expect(status().chat.canSendSticker).toBe(false);
  controls().send.mockClear();
  await vi.advanceTimersByTimeAsync(1);
  expect(inputBlocked()).toBe(false);
  expect(status().chat).toMatchObject({ canSendSticker: true, stickerSendBlockedReason: undefined });
  expect(controls().send.mock.calls.at(-1)).toMatchObject(['companion:status', { chat: { canSendSticker: true, stickerSendBlockedReason: undefined } }]);
  const sending = action(nextAction);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  mocks.handlers.get('companion:shield-ready')!(eventFor(controls()), { nonce: nextNonce, reducedMotion: true });
  expect(await sending).toEqual({ ok: true });
  expect(status().stickerSend).toMatchObject({ nonce: nextNonce, state: 'preparing' });
});


test('shield cap during sending keeps input blocked until the bounded result watchdog', async () => {
  await vi.advanceTimersByTimeAsync(3000);
  expect(authorize('send')).toBe(true);
  await vi.advanceTimersByTimeAsync(7000);
  expect(status().stickerShield).toBeNull();
  expect(inputBlocked()).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(status().stickerSend).toMatchObject({ state: 'failed', sent: 'unknown' });
  expect(inputBlocked()).toBe(false);
});

test.each([{ draft: 'New draft' }, { draftIssue: 'unsupported' as const }, { composing: true }])('draft appearing after authorization releases input without inventing an outcome: %j', patch => {
  expect(authorize('send')).toBe(true);
  remoteEvent({ type: 'snapshot', snapshot: { ...snapshot, ...patch, stickerPreparation: nonce } });
  expect(status().stickerSend?.state).toBe('sending');
  expect(inputBlocked()).toBe(false);
  remoteEvent({ type: 'stickerSent', nonce, clicked: true, confirmed: false, reason: 'draft', detail: 'draft-appeared' });
  expect(status().stickerSend).toMatchObject({ state: 'failed', reason: 'draft', detail: 'draft-appeared', sent: 'unknown' });
});

test('maker command dispatch failure releases input and focus reclamation', async () => {
  expect(authorize('send')).toBe(true); confirmed();
  remoteEvent({ type: 'snapshot', snapshot });
  const nextNonce = '550e8400-e29b-41d4-a716-446655440001';
  remote().send.mockImplementation((channel, command) => {
    if (channel === 'companion:command' && command.type === 'makeSticker') throw new Error('dispatch failed');
  });
  const sending = action({ type: 'sendSticker', id: 'a'.repeat(64), nonce: nextNonce, destinationToken: status().chat.destinationToken });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  mocks.handlers.get('companion:shield-ready')!(eventFor(controls()), { nonce: nextNonce, reducedMotion: true });
  expect(await sending).toEqual({ ok: false, error: 'dispatch failed' });
  expect(status().stickerSend).toMatchObject({ state: 'failed', detail: 'maker-error', sent: 'not-sent' });
  expect(inputBlocked()).toBe(false);
  controls().focus.mockClear(); remote().emit('focus');
  expect(controls().focus).not.toHaveBeenCalled();
});


test('result cleanup preserves local focus when the sticker panel remains open', () => {
  expect(authorize('send')).toBe(true);
  remote().focus.mockClear();
  confirmed();
  expect(inputBlocked()).toBe(false);
  expect(remote().focus).not.toHaveBeenCalled();
});


test('main records validated category timings once per completed picker attempt', async () => {
  await action({ type: 'cancelSticker' });
  remoteEvent({ type: 'stickerSent', nonce, clicked: false, confirmed: false });
  mocks.animated = true;
  const nextNonce = '650e8400-e29b-41d4-a716-446655440000';
  expect(await action({ type: 'sendSticker', id: 'a'.repeat(64), nonce: nextNonce, destinationToken: status().chat.destinationToken })).toEqual({ ok: true });
  const diagnostics = { totalMs: 8000, categories: [{ name: 'favorites', activatedMs: 0, firstImageMs: null, settledMs: 8000, loadingSeen: true, imagesSeen: 0, found: false }] };
  await vi.advanceTimersByTimeAsync(8000);
  remoteEvent({ type: 'stickerPrepared', nonce: nextNonce, found: false, diagnostics });
  expect(status().stickerSend?.state).toBe('missing');
  expect(mocks.diagnostics.filter(entry => entry.send.nonce === nextNonce)).toEqual([expect.objectContaining({ diagnostics })]);
  remoteEvent({ type: 'stickerPrepared', nonce: nextNonce, found: false, diagnostics });
  remoteEvent({ type: 'snapshot', snapshot });
  expect(mocks.diagnostics.filter(entry => entry.send.nonce === nextNonce)).toHaveLength(1);
});

const invalidDiagnostics = [
  ...['activatedMs', 'firstImageMs', 'settledMs'].map(field => ({
    totalMs: 15_010, categories: [{ name: 'recent', activatedMs: 0, firstImageMs: null, settledMs: null, loadingSeen: false, imagesSeen: 1, found: true, [field]: 15_010 }]
  })),
  { totalMs: 120_001, categories: [] },
  { totalMs: 10, categories: [{ name: 'private category' }] },
  { totalMs: 10, categories: [], extra: 'private telemetry' },
  null
];

test.each(invalidDiagnostics)('invalid lookup telemetry cannot veto preparation: %j', async diagnostics => {
  await action({ type: 'cancelSticker' });
  remoteEvent({ type: 'stickerSent', nonce, clicked: false, confirmed: false });
  mocks.animated = true;
  const nextNonce = '650e8400-e29b-41d4-a716-446655440000';
  expect(await action({ type: 'sendSticker', id: 'a'.repeat(64), nonce: nextNonce, destinationToken: status().chat.destinationToken })).toEqual({ ok: true });
  await vi.advanceTimersByTimeAsync(15_010);
  remoteEvent({ type: 'stickerPrepared', nonce: nextNonce, found: true, diagnostics });
  expect(status().stickerSend?.state).toBe('sending');
  expect(remote().send).toHaveBeenCalledWith('companion:command', expect.objectContaining({ type: 'sendSticker', nonce: nextNonce }));
  expect(mocks.handlers.get('companion:authorize-sticker')!(eventFor(remote()), { nonce: nextNonce, phase: 'send', snapshot })).toBe(true);
  remoteEvent({ type: 'stickerSent', nonce: nextNonce, clicked: true, confirmed: true });
  await vi.advanceTimersByTimeAsync(1000);
  expect(status().stickerSend).toMatchObject({ state: 'sent', sent: 'confirmed' });
  expect(mocks.diagnostics.find(entry => entry.send.nonce === nextNonce)?.diagnostics.categories).toEqual([]);
});

test.each(invalidDiagnostics)('invalid send telemetry cannot veto confirmation: %j', async diagnostics => {
  expect(authorize('send')).toBe(true); clicked();
  remoteEvent({ type: 'stickerSent', nonce, clicked: true, confirmed: true, diagnostics });
  expect(status().stickerSend).toMatchObject({ state: 'sent', sent: 'confirmed' });
  expect(inputBlocked()).toBe(false);
  await vi.advanceTimersByTimeAsync(STICKER_MAKER_WATCHDOG_MS);
  expect(status().stickerSend).toMatchObject({ state: 'sent', sent: 'confirmed' });
  expect(mocks.diagnostics.find(entry => entry.send.nonce === nonce)?.diagnostics.categories).toEqual([]);
});

test('discarding invalid telemetry still requires a valid transfer result', () => {
  expect(authorize('send')).toBe(true);
  remoteEvent({ type: 'stickerSent', nonce, clicked: 'yes', confirmed: true, diagnostics: invalidDiagnostics[0] });
  expect(status().stickerSend?.state).toBe('sending');
  expect(inputBlocked()).toBe(true);
});

test('invalid telemetry cannot hold a failed preparation or unsent maker open', async () => {
  remoteEvent({ type: 'stickerSent', nonce, clicked: false, confirmed: false, diagnostics: invalidDiagnostics[0] });
  expect(status().stickerSend).toMatchObject({ state: 'failed', sent: 'not-sent' });
  expect(inputBlocked()).toBe(false);
  mocks.animated = true;
  const nextNonce = '650e8400-e29b-41d4-a716-446655440000';
  expect(await action({ type: 'sendSticker', id: 'a'.repeat(64), nonce: nextNonce, destinationToken: status().chat.destinationToken })).toEqual({ ok: true });
  remoteEvent({ type: 'stickerPrepared', nonce: nextNonce, found: false, diagnostics: invalidDiagnostics[0] });
  expect(status().stickerSend?.state).toBe('missing');
});


test('the maker reads stored files before preparation and rechecks before image disclosure and Send', () => {
  expect(mocks.reads.length).toBeGreaterThanOrEqual(3);
  expect(mocks.reads.every(id => id === 'a'.repeat(64))).toBe(true);
  const before = mocks.reads.length;
  expect(authorize('send')).toBe(true);
  expect(mocks.reads.length).toBe(before + 2); // fresh disclosure input plus final authorization
});
test('picker sends and Locate read verified files even when the remote already has an image', async () => {
  await action({ type: 'cancelSticker' }); const before = mocks.reads.length;
  await newSend(snapshot, true);
  expect(status().stickerSend?.route).toBe('picker'); expect(mocks.reads.length).toBeGreaterThan(before);
  await action({ type: 'cancelSticker' });
  const count = mocks.reads.length;
  expect(await action({ type: 'locateSticker', id: 'a'.repeat(64), destinationToken: status().chat.destinationToken })).toEqual({ ok: true });
  expect(mocks.reads.length).toBe(count + 1);
});
test('missing blobs fail all send routes and Locate with a clear error and no command', async () => {
  await action({ type: 'cancelSticker' }); await vi.advanceTimersByTimeAsync(STICKER_MAKER_CLEANUP_MS); mocks.readFailure = true; remote().send.mockClear();
  for (const direct of [false, true]) {
    expect(await action({ type: 'preferences', scope: 'global', patch: { directStickerSend: direct } })).toEqual({ ok: true });
    for (const animated of [false, true]) {
      mocks.animated = animated;
      expect(await action({ type: 'sendSticker', id: 'a'.repeat(64), nonce: '550e8400-e29b-41d4-a716-446655440099', destinationToken: status().chat.destinationToken })).toMatchObject({ ok: false, error: expect.stringContaining('missing or damaged') });
    }
  }
  expect(await action({ type: 'locateSticker', id: 'a'.repeat(64), destinationToken: status().chat.destinationToken })).toMatchObject({ ok: false, error: expect.stringContaining('missing or damaged') });
  expect(remote().send.mock.calls.some(([, command]) => ['makeSticker', 'prepareSticker', 'locateSticker'].includes(command?.type))).toBe(false);
});
test('a file lost during preparation revokes final Send authorization', () => {
  mocks.readFailure = true;
  expect(authorize('send')).toBe(false);
  expect(status().stickerLibraryError).toContain('missing or damaged');
  expect(status().stickerSend?.state).toBe('cancelled');
});


test('sticker protocol handler is installed only on the controls session', () => {
  expect(controls().session.protocol.handle).toHaveBeenCalledWith('companion-sticker', expect.any(Function));
  expect(remote().session.protocol.handle).not.toHaveBeenCalled();
  expect(status().state.stickers.every(sticker => !('image' in sticker))).toBe(true);
});

test('successful protocol retry clears only the verified id and publishes observable error changes', async () => {
  const first = 'a'.repeat(64), second = 'b'.repeat(64);
  mocks.store!.update(state => { state.stickers.push({ ...state.stickers[0], id: second }); });
  mocks.readFailure = true;
  for (const id of [first, second]) expect(await action({ type: 'locateSticker', id, destinationToken: status().chat.destinationToken })).toMatchObject({ ok: false });
  const handle = controls().session.protocol.handle.mock.calls[0][1] as (request: { url: string; method: string }) => Promise<Response>;
  controls().send.mockClear();
  const failed = await handle({ url: `companion-sticker://${first}`, method: 'GET' });
  expect(failed.status).toBe(404); expect(failed.headers.get('Cache-Control')).toBe('no-store');
  expect(controls().send).not.toHaveBeenCalled();
  mocks.readFailure = false;
  expect((await handle({ url: `companion-sticker://${first}`, method: 'GET' })).status).toBe(200);
  let updates = controls().send.mock.calls.filter(([channel]) => channel === 'companion:status');
  expect(updates).toHaveLength(0); expect(status().stickerLibraryError).toBe('Sticker file is missing or damaged.');
  controls().send.mockClear();
  expect((await handle({ url: `companion-sticker://${second}`, method: 'GET' })).status).toBe(200);
  updates = controls().send.mock.calls.filter(([channel]) => channel === 'companion:status');
  expect(updates).toHaveLength(1); expect(updates[0][1].stickerLibraryError).toBeUndefined();
  controls().send.mockClear();
  for (const id of [first, second]) expect((await handle({ url: `companion-sticker://${id}`, method: 'GET' })).status).toBe(200);
  expect(controls().send).not.toHaveBeenCalled();
});


test('blob loss while waiting for shield draw publishes cancellation and shield removal', async () => {
  await action({ type: 'cancelSticker' });
  await vi.advanceTimersByTimeAsync(STICKER_MAKER_CLEANUP_MS);
  const nextNonce = '550e8400-e29b-41d4-a716-446655440001';
  const sending = action({ type: 'sendSticker', id: 'a'.repeat(64), nonce: nextNonce, destinationToken: status().chat.destinationToken });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(status().stickerShield?.nonce).toBe(nextNonce);
  mocks.readFailure = true; controls().send.mockClear();
  mocks.handlers.get('companion:shield-ready')!(eventFor(controls()), { nonce: nextNonce, reducedMotion: true });
  expect(await sending).toMatchObject({ ok: false });
  const updates = controls().send.mock.calls.filter(([channel]) => channel === 'companion:status');
  expect(updates.length).toBeGreaterThan(0);
  expect(updates.at(-1)![1]).toMatchObject({ stickerSend: { state: 'cancelled' }, stickerShield: null, stickerLibraryError: 'Sticker file is missing or damaged.' });
  expect(inputBlocked()).toBe(false);
  expect(remote().send.mock.calls.some(([, command]) => command.type === 'makeSticker' && command.nonce === nextNonce)).toBe(false);
});

test('maker command failure publishes a terminal result and clears its shield', async () => {
  await action({ type: 'cancelSticker' });
  await vi.advanceTimersByTimeAsync(STICKER_MAKER_CLEANUP_MS);
  const nextNonce = '550e8400-e29b-41d4-a716-446655440001';
  const sending = action({ type: 'sendSticker', id: 'a'.repeat(64), nonce: nextNonce, destinationToken: status().chat.destinationToken });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(status().stickerShield?.nonce).toBe(nextNonce);
  remote().send.mockImplementation((_, command) => { if (command.type === 'makeSticker') throw new Error('remote unavailable'); });
  controls().send.mockClear();
  mocks.handlers.get('companion:shield-ready')!(eventFor(controls()), { nonce: nextNonce, reducedMotion: true });
  expect(await sending).toMatchObject({ ok: false });
  const updates = controls().send.mock.calls.filter(([channel]) => channel === 'companion:status');
  expect(updates.at(-1)![1]).toMatchObject({ stickerSend: { state: 'failed', sent: 'not-sent' }, stickerShield: null });
  expect(inputBlocked()).toBe(false);
});

test('blob errors clear after verified Locate recovery and Forget, without clearing other ids', async () => {
  mocks.readFailure = true; expect(authorize('send')).toBe(false);
  expect(status().stickerLibraryError).toBe('Sticker file is missing or damaged.');
  mocks.readFailure = false;
  expect(await action({ type: 'locateSticker', id: 'a'.repeat(64), destinationToken: status().chat.destinationToken })).toEqual({ ok: true });
  expect(status().stickerLibraryError).toBeUndefined();
  const second = 'b'.repeat(64);
  mocks.store!.update(state => { state.stickers.push({ ...state.stickers[0], id: second }); });
  mocks.readFailure = true;
  for (const id of ['a'.repeat(64), second]) expect(await action({ type: 'locateSticker', id, destinationToken: status().chat.destinationToken })).toMatchObject({ ok: false });
  expect(await action({ type: 'forgetSticker', id: 'a'.repeat(64) })).toEqual({ ok: true });
  expect(status().stickerLibraryError).toBe('Sticker file is missing or damaged.');
  expect(await action({ type: 'forgetSticker', id: second })).toEqual({ ok: true });
  expect(status().stickerLibraryError).toBeUndefined();
});

test('verified rediscovery clears an authorization blob error', async () => {
  const { createHash } = await import('node:crypto');
  const { StickerInbox } = await import('../src/main/sticker-inbox');
  const add = vi.spyOn(StickerInbox.prototype, 'add');
  const bytes = Buffer.alloc(12); bytes.write('RIFF'); bytes.writeUInt32LE(4, 4); bytes.write('WEBP', 8);
  const id = createHash('sha256').update(bytes).digest('hex');
  // Start a new send with the discovered identity.
  await action({ type: 'cancelSticker' }); mocks.store!.update(state => { state.stickers[0].id = id; });
  mocks.readFailure = true;
  expect(await action({ type: 'locateSticker', id, destinationToken: status().chat.destinationToken })).toMatchObject({ ok: false });
  expect(status().stickerLibraryError).toBe('Sticker file is missing or damaged.');
  remoteEvent({ type: 'sticker', image: `data:image/webp;base64,${bytes.toString('base64')}` });
  expect(add).toHaveBeenCalledOnce();
  expect(await (add.mock.contexts[0] as InstanceType<typeof StickerInbox>).flush()).toBe(true);
  expect(status().stickerLibraryError).toBeUndefined();
});


test('verified recent rediscovery publishes cleared errors even when intake is suppressed', async () => {
  const { createHash } = await import('node:crypto');
  const { StickerInbox } = await import('../src/main/sticker-inbox');
  const add = vi.spyOn(StickerInbox.prototype, 'add');
  const bytes = Buffer.alloc(12); bytes.write('RIFF'); bytes.writeUInt32LE(4, 4); bytes.write('WEBP', 8);
  const id = createHash('sha256').update(bytes).digest('hex');
  mocks.store!.update(state => { state.stickers[0].id = id; state.stickers[0].lastSeen = Date.now(); });
  mocks.readFailure = true;
  expect(await action({ type: 'locateSticker', id, destinationToken: status().chat.destinationToken })).toMatchObject({ ok: false });
  expect(status().stickerLibraryError).toBe('Sticker file is missing or damaged.');
  mocks.readFailure = false; controls().send.mockClear();
  remoteEvent({ type: 'sticker', image: `data:image/webp;base64,${bytes.toString('base64')}` });
  expect(add).not.toHaveBeenCalled();
  const updates = controls().send.mock.calls.filter(([channel]) => channel === 'companion:status');
  expect(updates).toHaveLength(1); expect(updates[0][1].stickerLibraryError).toBeUndefined();
});

test('local validated group IPC creates, assigns, renames, removes, and publishes membership-only changes', async () => {
  const id = status().state.stickers[0].id;
  expect(await action({ type: 'createStickerGroup', name: ' Animals ', stickerIds: [id] })).toEqual({ ok: true });
  const group = status().state.stickerGroups[0]; expect(group.name).toBe('Animals'); expect(group.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(status().state.stickers[0].groups).toEqual([group.id]);
  expect(await action({ type: 'createStickerGroup', name: 'Favorites' })).toEqual({ ok: true });
  const second = status().state.stickerGroups[1].id;
  expect(await action({ type: 'stickerGroupMembership', id, groupId: second, member: true })).toEqual({ ok: true });
  expect(status().state.stickers[0].groups).toEqual([group.id, second]);
  expect(await action({ type: 'renameStickerGroup', id: group.id, name: 'Dogs' })).toEqual({ ok: true });
  expect(status().state.stickerGroups.map(g => g.name)).toEqual(['Dogs', 'Favorites']);
  expect(await action({ type: 'bulkStickerGroupMembership', stickerIds: [id], groupId: group.id, member: false })).toEqual({ ok: true });
  expect(status().state.stickers[0].groups).toEqual([second]);
  expect(await action({ type: 'bulkStickerGroupMembership', stickerIds: [id], groupId: group.id, member: true })).toEqual({ ok: true });
  expect(await action({ type: 'deleteStickerGroup', id: group.id })).toEqual({ ok: true });
  expect(status().state.stickerGroups.map(g => g.id)).toEqual([second]); expect(status().state.stickers[0].groups).toEqual([second]);
  expect(await action({ type: 'stickerGroupMembership', id, groupId: second, member: false })).toEqual({ ok: true });
  expect(status().state.stickers[0].groups).toEqual([]);
});

test('main rejects unknown sticker/group ids, duplicate/invalid names and remote group actions', async () => {
  const id = status().state.stickers[0].id;
  expect(await action({ type: 'createStickerGroup', name: 'Animals' })).toEqual({ ok: true });
  const groupId = status().state.stickerGroups[0].id, unknown = '550e8400-e29b-41d4-a716-446655440000';
  for (const raw of [
    { type: 'createStickerGroup', name: ' animals ' }, { type: 'createStickerGroup', name: '' },
    { type: 'createStickerGroup', name: 'x'.repeat(41) }, { type: 'createStickerGroup', name: 'New', stickerIds: ['b'.repeat(64)] },
    { type: 'renameStickerGroup', id: unknown, name: 'New' }, { type: 'deleteStickerGroup', id: unknown },
    { type: 'renameStickerGroup', id: groupId, name: ' ' },
    { type: 'stickerGroupMembership', id, groupId: unknown, member: true },
    { type: 'stickerGroupMembership', id: 'b'.repeat(64), groupId, member: true },
    { type: 'bulkStickerGroupMembership', stickerIds: [id, 'b'.repeat(64)], groupId, member: true },
    { type: 'bulkStickerGroupMembership', stickerIds: [], groupId, member: true }
  ]) {
    const before = structuredClone(status().state);
    expect(await action(raw)).toMatchObject({ ok: false }); expect(status().state).toEqual(before);
  }
  expect(await mocks.handlers.get('companion:action')!(eventFor(remote()), { type: 'createStickerGroup', name: 'Remote' })).toEqual({ ok: false, error: 'Denied' });
});
