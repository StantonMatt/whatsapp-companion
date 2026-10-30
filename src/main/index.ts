import { StickerTagQueue } from './sticker-tagging';
import { checkStickerDimensions } from './sticker-fingerprint';
import { decodeStickerTagFrames, tagImagesSchema } from './sticker-tag-images';
import { applyStickerGroupAction } from '../core/sticker-groups';
import { app, BrowserWindow, WebContentsView, ipcMain, session, protocol, dialog, shell, Menu, powerMonitor } from 'electron';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { actionSchema, snapshotSchema, discoveredStickerSchema, stickerImageSchema, providerSchema, panelSchema, type Panel, type Status, type ViewBounds, type DirectStickerDisabledReason } from '../shared/model';
import { accountSafetyEventSchema, displayAckSchema, dismissEventSchema, type AccountSafetyReason } from '../shared/connector';
import { Store } from './store';
import { ChromeSync } from './chrome-sync';
import { Conversations } from './conversations';
import { Vault, promptKey, configuredBackend } from './vault';
import { Assistant } from './assistant';
import { setPreferences, resetStylePreferences } from '../core/settings';
import { learnStyle, styleSamples, minimumStyleSamples } from '../core/style';
import { statusUpdate, StatusPublisher } from '../core/status';
import { StickerTransfer, stickerRoute } from '../core/sticker-transfer';
import { StickerReadiness } from '../core/sticker-readiness';
import { STICKER_PICKER_WATCHDOG_MS, STICKER_MAKER_CLEANUP_MS, STICKER_MAKER_WATCHDOG_MS, stickerMakerDetails, stickerLookupDiagnosticsSchema, type StickerLookupDiagnostics } from '../shared/sticker-transfer';
import { storedSticker } from './sticker-bytes';
import { StickerInbox } from './sticker-inbox';
import { decodeStickerPixels } from './sticker-fingerprint';
import { STICKER_SCHEME, stickerResponse } from './sticker-protocol';
import { ProviderCheck } from './provider-check';
import { RequestCounts, useRequestCounts } from './request-counts';
import { ModelCatalog } from './models';
import { currentTextModels, savedEffort, setReasoning } from '../core/model-policy';
import { MAX_STICKER_BYTES, MAX_LIBRARY_STICKERS, MAX_LIBRARY_BYTES } from '../shared/sticker-limits';
import { StickerSendDiagnostics } from './sticker-send-diagnostics';
import { PickerDiagnostics } from './picker-diagnostics';
import { DirectStickerSender } from './direct-sticker-sender';
import { DirectStickerSafety } from './direct-sticker-safety';
import { installEditContextMenus } from './context-menu';
import { installRemotePermissions, NotificationConsent } from './permissions';
import { StartAtLogin, loginExecutable } from './autostart';
import { createCompanionTray } from './tray';
import { StartupDiagnostics } from './startup-diagnostics';
import { StartupWatchdog } from './startup-watchdog';
import { RemoteLoadRecovery } from './remote-load-recovery';
import { bootSessionSchema } from '../shared/boot';
import { safeRendererSend, requireRendererSend, positiveBounds, cleanupOnce, quitAfterFlush } from './lifecycle';

// Some AppImage launchers add --no-sandbox automatically. Never allow that
// compatibility fallback to remove protection from the embedded remote page.
app.commandLine.removeSwitch('no-sandbox');
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: STICKER_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const fixture = process.argv.includes('--fixture') && !app.isPackaged;
const dataArg = process.argv.find(x => x.startsWith('--data-dir='));
if (dataArg && !app.isPackaged) app.setPath('userData', resolve(dataArg.slice(11)));
else if (fixture) app.setPath('userData', join(app.getPath('appData'), 'whatsapp-companion-fixture'));
app.setName('WhatsApp Companion');
// Remember the OS backend used to encrypt this app's own keys. Never fall back to plaintext.
if (process.platform === 'linux' && !app.commandLine.hasSwitch('password-store')) {
  try { const backend = configuredBackend(app.getPath('userData')); if (backend) app.commandLine.appendSwitch('password-store', backend === 'gnome_libsecret' ? 'gnome-libsecret' : backend); } catch { /* Startup reports damaged data below. */ }
}
const acquired = app.requestSingleInstanceLock();
const startupDiagnostics = new StartupDiagnostics(app.getPath('userData'), acquired);
let quitStarted = false, quitAllowed = false;
let closeWindow: (() => void) | undefined;
const quit = () => {
  if (quitStarted) return;
  quitStarted = true;
  startupDiagnostics.record('before-quit'); startupDiagnostics.record('quit');
  void quitAfterFlush(() => startupDiagnostics.flush(), () => { quitAllowed = true; app.quit(); });
};
// Install before initialization: failures and early OS/menu quits need the same
// bounded flush as a fully initialized window, without recursively vetoing quit.
app.on('before-quit', event => {
  if (quitAllowed) return;
  event.preventDefault();
  if (closeWindow) closeWindow(); else quit();
});
app.on('window-all-closed', () => quit());
startupDiagnostics.record('lock', { acquired, app: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome });
if (!acquired) quit();
else void app.whenReady().then(() => { if (!quitStarted) return start(); }).catch(() => {
  try {
    dialog.showErrorBox('WhatsApp Companion could not start', 'The local data file or OS credential store could not be opened. Your files have been preserved. See README for recovery steps.');
  } catch { /* A native error dialog failure must not prevent shutdown. */ }
  finally { if (closeWindow) closeWindow(); else quit(); }
});

async function start() {
  startupDiagnostics.record('app-ready');
  const storeStarted = performance.now();
  const store = new Store(app.getPath('userData'), undefined, { deferGC: true, timing: (phase, durationMs) => startupDiagnostics.record(phase, { durationMs }) });
  startupDiagnostics.record('store-load', { durationMs: performance.now() - storeStarted });
  const requestCounts = new RequestCounts(app.getPath('userData'));
  useRequestCounts(requestCounts);
  const vault = new Vault(app.getPath('userData'));
  const providerCheck = new ProviderCheck();
  const modelCatalog = new ModelCatalog();
  const root = __dirname;
  const uiURL = pathToFileURL(join(root, 'ui/index.html')).href;
  const remoteURL = fixture ? pathToFileURL(join(root, 'fixture.html')).href + (process.argv.includes('--fixture-startup-asset-failure') ? '#startup-asset-failure' : process.argv.includes('--fixture-startup-watchdog') ? '#startup-stuck' : process.argv.includes('--fixture-startup-splash') ? '#startup-splash' : '') : 'https://web.whatsapp.com/';
  const fixtureStartupStall = fixture && process.argv.includes('--fixture-startup-stall');
  const conversations = new Conversations(store, () => { assistant.message = 'Conversation observations could not be saved. Check disk space and the data directory.'; publish(); });
  const stickerTransfer = new StickerTransfer();
  const directStickerSafety = new DirectStickerSafety(store, stickerTransfer, () => {
    assistant.message = 'Direct sticker sending turned off for this session; saving the setting failed. Check disk space and the data directory before re-enabling it.';
  });
  const stickerSendDiagnostics = new StickerSendDiagnostics(app.getPath('userData'));
  let sendDiagnostic: { nonce: string; startedAt: number; result?: StickerLookupDiagnostics; written?: boolean } | undefined;
  const stickerReadiness = new StickerReadiness();
  let presentedSnapshot: ReturnType<StickerReadiness['present']> | undefined;
  let stickerReadinessTimer: ReturnType<typeof setTimeout> | undefined;
  let shieldDrawn: { nonce: string; resolve: (drawn: boolean) => void } | undefined;
  let makerInputOwner: string | undefined;
  let makerInputTarget: { chatId: string | null; name: string } | undefined;
  let makerInputTimer: ReturnType<typeof setTimeout> | undefined;
  let makerInputDisclosed = false, makerInputPreparationSeen = false, makerInputCleaning = false;
  let makerInputCleanupDeadline = 0;
  let stickerSendTimer: ReturnType<typeof setTimeout> | undefined;
  let stickerShield: Status['stickerShield'] = null;
  let shieldPanel: ViewBounds | null = null;
  let shieldExpanded = false, shieldReducedMotion = false;
  let shieldTarget: { chatId: string | null; name: string; settingsId?: string | null } | null = null;
  let shieldGeneration = 0;
  let shieldCapTimer: ReturnType<typeof setTimeout> | undefined;
  let shieldRestoreTimer: ReturnType<typeof setTimeout> | undefined;
  let shieldRestoreNonce: string | undefined;
  let panel: Panel = null, panelChat: string | null = null, keyPromptOpen = false;
  let closing = false, indexDrained = false;
  let gcTimer: ReturnType<typeof setTimeout> | undefined;
  let permissionDialogsOpen = 0;
  // Test thresholds are fixed, main-only and impossible to enable in packaged/live mode.
  const startupWatchdog = new StartupWatchdog(fixture && (process.argv.includes('--fixture-startup-watchdog') || process.argv.includes('--fixture-startup-asset-failure')) ? { splashMs: 600, stalledMs: 300, assetFailureMs: 300, spacingMs: 1200, heartbeatGapMs: 6000 } : undefined);
  let bootSession = { nonce: randomUUID(), generation: 0 };
  startupWatchdog.navigate(bootSession);
  let detectorSeen = false, structureLogged = false, assetFailureLogged = false, shellChromeSynced = false, connectorReady = false;
  let lastBoot: { phase: string; progress: number | null; visible: boolean; online: boolean; chatListReady?: boolean } | undefined;
  let lastDecision: string | undefined;
  let stickerIntakeError: string | undefined;
  const stickerBlobErrors = new Map<string, string>();
  const readSticker = (id: string) => {
    try {
      const sticker = store.readSticker(id);
      if (stickerBlobErrors.delete(id)) publish();
      return sticker;
    } catch (error) {
      if (store.state.stickers.some(s => s.id === id)) stickerBlobErrors.set(id, error instanceof Error ? error.message : 'Sticker file unavailable.');
      else stickerBlobErrors.delete(id);
      throw error;
    }
  };
  let stickerLocation: Status['stickerLocation'] = null;
  let locateRequest: { nonce: string; destinationToken: string; timer: ReturnType<typeof setTimeout> } | undefined;
  let chrome = { rail: 64, listWidth: 430, theme: 'dark' as 'dark' | 'light' };
  const win = new BrowserWindow({ width: 1280, height: 860, minWidth: 880, minHeight: 620, backgroundColor: '#161717', title: 'WhatsApp Companion',
    icon: join(root, 'icon.png'), show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  startupDiagnostics.record('window-created');
  let tray: ReturnType<typeof createCompanionTray> | undefined;
  let startAtLogin = false;
  // Login-item arguments are Windows-only; macOS reports login launches itself.
  const hiddenStart = process.argv.includes('--hidden') || (app.isPackaged && process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
  let suppressStartupActivation = hiddenStart;
  const login = new StartAtLogin({ packaged: app.isPackaged, fixture, platform: process.platform,
    configDirectory: process.env.XDG_CONFIG_HOME && isAbsolute(process.env.XDG_CONFIG_HOME) ? process.env.XDG_CONFIG_HOME : join(homedir(), '.config'),
    executable: loginExecutable(process.env, process.execPath), setLoginItemSettings: settings => app.setLoginItemSettings(settings) });
  const saveFailure = (message: string) => { dialog.showErrorBox('WhatsApp Companion', message); };
  const notifications = new NotificationConsent({
    answer: () => store.state.desktop.notifications,
    save: answer => { store.update(state => { state.desktop.notifications = answer; }); tray?.refresh(); },
    saveFailed: () => { tray?.refresh(); saveFailure('The notification setting could not be saved. Check disk space and the data directory.'); },
    visible: () => !closing && connectorReady && lastBoot?.phase === 'shell' && lastBoot.chatListReady === true && !win.isDestroyed() && win.isVisible() && !win.isMinimized(),
    prompt: async signal => {
      permissionDialogsOpen++; startupWatchdog.resetObservations();
      try {
        const result = await dialog.showMessageBox(win, { title: 'WhatsApp Companion', message: 'Allow notifications for new messages?',
          ...(tray ? { detail: 'Closing the window keeps WhatsApp Companion running in the tray.' } : {}),
          buttons: ['Deny', 'Allow'], defaultId: 1, cancelId: 0, signal });
        return result.response === 1;
      } finally { permissionDialogsOpen--; startupWatchdog.resetObservations(); }
    }
  });
  const maybeAskNotifications = () => {
    if (closing) return;
    if (connectorReady && lastBoot?.phase === 'shell' && lastBoot.chatListReady === true && notifications.answer() === undefined) void notifications.request();
    notifications.maybeAsk();
  };
  // Clicking a notification while the window is in the tray doesn't open it; use the tray icon.
  const showWindow = () => {
    if (closing || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.setSkipTaskbar(false); if (!win.isVisible()) win.show();
    win.moveTop(); win.focus(); maybeAskNotifications();
  };
  const controls = new WebContentsView({ webPreferences: { preload: join(root, 'local.cjs'), partition: 'companion-controls', contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  // WhatsApp rejects Electron-branded user agents despite the current Chromium engine.
  const platform = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  const userAgent = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
  const remoteSession = session.fromPartition(fixture ? 'persist:fixture' : 'persist:whatsapp');
  // Set the partition default before creating the view, including worker/network use.
  // Electron 44 exposes no UA metadata parameter; its Chromium client hints remain unchanged.
  remoteSession.setUserAgent(userAgent);
  const remote = new WebContentsView({ webPreferences: { preload: join(root, 'remote.cjs'), session: remoteSession, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: true, backgroundThrottling: false } });
  startupDiagnostics.record('views-created');
  const sendRemote = (command: unknown) => safeRendererSend(remote.webContents, closing, 'companion:command', command);
  const requireRemote = (command: unknown) => requireRendererSend(remote.webContents, closing, 'companion:command', command);
  installEditContextMenus([remote.webContents, controls.webContents], win, Menu);
  // Scheme privileges are global; the handler exists only in the local session.
  controls.webContents.session.protocol.handle(STICKER_SCHEME, request => stickerResponse({ readStickerBytes: async id => {
    try {
      const bytes = await store.readStickerBytes(id);
      if (stickerBlobErrors.delete(id)) publish();
      return bytes;
    } catch (error) {
      if (store.state.stickers.some(s => s.id === id)) {
        const message = error instanceof Error ? error.message : 'Sticker file unavailable.';
        if (stickerBlobErrors.get(id) !== message) { stickerBlobErrors.set(id, message); publish(); }
      }
      throw error;
    }
  } }, request));
  remote.webContents.setUserAgent(userAgent);
  win.contentView.addChildView(remote);
  win.contentView.addChildView(controls);
  controls.setBackgroundColor('#00000000');
  controls.setVisible(false);
  const stickerTags = new StickerTagQueue({
    state: () => store.state, update: mutate => store.update(mutate), key: provider => vault.has(provider) ? vault.get(provider) : undefined, publish: () => publish(), fixture,
    fixtureFailure: (id, attempt) => process.argv.includes('--fixture-tag-partial') && attempt === 1 && store.state.stickers.findIndex(s => s.id === id) % 3 === 0,
    images: async (id, provider, signal) => {
      signal.throwIfAborted();
      const stored = await store.readStickerBytes(id);
      const image = `data:image/webp;base64,${stored.bytes.toString('base64')}`;
      checkStickerDimensions(image);
      if (!stored.animated && provider === 'openai') return [{ mime: 'image/webp', data: stored.bytes.toString('base64') }];
      // Bounded local decode: hanging controls cannot occupy a queue slot forever.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancel: (() => void) | undefined;
      try {
        const frames = await new Promise<unknown>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Sticker decode timed out.')), 10_000);
          cancel = () => reject(new Error('Cancelled')); signal.addEventListener('abort', cancel, { once: true });
          signal.throwIfAborted();
          controls.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${decodeStickerTagFrames.toString()})(${JSON.stringify(image)},${stored.animated})` }]).then(resolve, reject);
        });
        signal.throwIfAborted();
        return tagImagesSchema.parse(frames);
      } finally { clearTimeout(timer); if (cancel) signal.removeEventListener('abort', cancel); }
    }
  });
  const pickerDiagnostics = new PickerDiagnostics({
    directory: app.getPath('userData'), appVersion: app.getVersion(),
    send: command => { sendRemote(command); },
    reveal: path => shell.showItemInFolder(path),
    notify: message => { if (!win.isDestroyed()) void dialog.showMessageBox(win, { type: 'info', message, buttons: ['OK'] }).catch(() => {}); }
  });
  let pendingChrome = false;
  const chromeSync = new ChromeSync(command => { sendRemote(command); });
  const syncChrome = () => {
    if (closing || remote.webContents.isDestroyed() || controls.webContents.isDestroyed()) return;
    const bounds = shieldPanel ?? controls.getBounds(), zoom = remote.webContents.getZoomFactor();
    chromeSync.next({ type: 'chrome', panel, pending: pendingChrome,
      panelBounds: panel ? { left: bounds.x / zoom, right: (bounds.x + bounds.width) / zoom } : null });
  };
  let initialBoundsLogged = false;
  const layout = () => {
    if (closing || win.isDestroyed() || remote.webContents.isDestroyed() || controls.webContents.isDestroyed()) return;
    const { width, height } = win.contentView.getBounds();
    if (!positiveBounds({ width, height })) { startupDiagnostics.record('bounds-rejected'); return; }
    if (!initialBoundsLogged) { initialBoundsLogged = true; startupDiagnostics.record('bounds', { width, height }); }
    remote.setBounds({ x: 0, y: 0, width, height });
    const rail = Math.min(100, Math.max(0, chrome.rail));
    const panelWidth = Math.min(width - rail, Math.max(380, panel === 'chat' ? 430 : chrome.listWidth));
    const controlsX = shieldPanel?.x ?? (panel === 'chat' ? width - panelWidth : rail);
    controls.setBounds(shieldExpanded ? { x: controlsX, y: 0, width: width - controlsX, height } : { x: controlsX, y: 0, width: panelWidth, height });
    controls.setVisible(panel !== null || shieldPanel !== null);
    syncChrome();
  };
  // KDE can emit window resize/maximize before committing the content area's new size.
  // Follow the actual parent view bounds, including maximize, restore and fullscreen.
  layout();
  // The native child view uses device-independent bounds matching the unzoomed settings panel.
  controls.webContents.setZoomMode('disabled');
  controls.webContents.on('did-finish-load', () => controls.webContents.setZoomMode('disabled'));
  void controls.webContents.setVisualZoomLevelLimits(1, 1);
  controls.webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && ['+', '=', '-', '0'].includes(input.key)) event.preventDefault();
  });
  const stopMakerInput = () => {
    clearTimeout(makerInputTimer); makerInputTimer = undefined;
    makerInputOwner = undefined; makerInputTarget = undefined;
    makerInputDisclosed = false; makerInputPreparationSeen = false; makerInputCleaning = false;
    makerInputCleanupDeadline = 0;
  };
  const finishMakerInput = () => {
    const owned = Boolean(makerInputOwner);
    stopMakerInput();
    // Panel close deferred remote focus while cleanup still owned the editor.
    // Return native focus once that ownership ends, including the timeout path.
    if (owned && !panel && !win.isDestroyed() && !remote.webContents.isDestroyed()) remote.webContents.focus();
  };
  const settleMakerInput = () => {
    if (!makerInputOwner || makerInputCleaning) return;
    // Without a disclosure grant the connector cannot assign a file or mount
    // an editor. Release now: a held makeSticker command may never acknowledge
    // cancellation, and a key blocked here cannot be recovered by a later timer.
    if (!makerInputDisclosed) { finishMakerInput(); return; }
    makerInputCleaning = true;
    clearTimeout(makerInputTimer);
    // Cancellation suppresses the connector's result. Preparation snapshots
    // normally acknowledge teardown; a lost snapshot cannot hold Send forever.
    // Keep only the remaining mount/Close budget measured from disclosure.
    makerInputTimer = setTimeout(() => { finishMakerInput(); publish(); }, Math.max(0, makerInputCleanupDeadline - Date.now()));
  };
  const startMakerInput = (nonce: string) => {
    stopMakerInput();
    makerInputOwner = nonce;
    makerInputTarget = { chatId: assistant.snapshot.chatId, name: assistant.snapshot.name };
    if (remote.webContents.isFocused()) controls.webContents.focus();
    // Bound ownership even if a held command never reaches the connector.
    makerInputTimer = setTimeout(() => {
      stickerTransfer.timeout(nonce); finishMakerInput(); stopStickerLookup(); publish();
    }, 60_000);
  };
  remote.webContents.on('before-input-event', event => {
    if (!makerInputOwner) return;
    event.preventDefault();
    // The focus event is not reliable for programmatic focus; reclaim it on any blocked input.
    if (!controls.webContents.isDestroyed()) controls.webContents.focus();
  });
  remote.webContents.on('focus', () => { if (makerInputOwner && !controls.webContents.isDestroyed()) controls.webContents.focus(); });
  let sequence = 0;
  // This publisher belongs only to the authorized controls webContents.
  const statusPublisher = new StatusPublisher(update => {
    safeRendererSend(controls.webContents, closing, 'companion:status', update);
    sequence = update.sequence;
  });
  // Presentation can hold composer readiness during maker teardown. Send
  // availability and route selection use the raw conversation/composer state.
  const stickerSendBlockedReason = () => stickerTransfer.blockedReason(assistant.snapshot, makerInputCleaning);
  const libraryMessage = () => (store.durabilityWarning ? 'Sticker changes saved; disk sync pending.' : undefined) ?? stickerBlobErrors.values().next().value ?? stickerIntakeError ?? store.recoveryHint ?? (store.state.stickers.length >= MAX_LIBRARY_STICKERS || store.state.stickers.reduce((total, s) => total + s.size, 0) >= MAX_LIBRARY_BYTES ? 'Sticker library is full' : undefined);
  const status = (): Status => ({ sequence, panel, stickerTagging: stickerTags.progress, stickerTags: stickerTags.items, stickerTagPause: stickerTags.pause, stickerLibraryError: libraryMessage(), stickerLocation, stickerShield, stickerSend: stickerTransfer.send, theme: chrome.theme, runtimePaused: assistant.isRuntimePaused(), state: directStickerSafety.state(), chat: { destinationToken: stickerTransfer.destinationToken(assistant.snapshot), chatId: assistant.snapshot.chatId, settingsId: assistant.snapshot.settingsId, name: assistant.snapshot.name, kind: assistant.snapshot.kind, ready: (presentedSnapshot ?? assistant.snapshot).ready, canSendSticker: !stickerSendBlockedReason(), stickerSendBlockedReason: stickerSendBlockedReason(), loadedSentSamples: styleSamples(assistant.snapshot.messages.filter(m => m.outgoing && !m.directionFallback).map(m => m.text)).length }, keys: { openai: vault.has('openai'), anthropic: vault.has('anthropic') }, secureStorage: vault.secure(), fixture, message: assistant.message, pending: assistant.pending });
  let lastMakerDiagnostic: Status['stickerSend'];
  const recordStickerSend = () => {
    const send = stickerTransfer.send;
    if (send && send.route !== 'direct' && sendDiagnostic?.nonce === send.nonce && !sendDiagnostic.written &&
      !['finding', 'preparing', 'sending'].includes(send.state)) {
      sendDiagnostic.written = true;
      stickerSendDiagnostics.append(send, { totalMs: Math.max(sendDiagnostic.result?.totalMs ?? 0, Date.now() - sendDiagnostic.startedAt), categories: sendDiagnostic.result?.categories ?? [], ...(sendDiagnostic.result?.reason ? { reason: sendDiagnostic.result.reason } : {}) });
    }
  };
  const publish = () => {
    recordStickerSend();
    if (makerInputOwner) {
      const send = stickerTransfer.send;
      if (send?.nonce !== makerInputOwner || send.detail === 'draft-appeared') finishMakerInput();
      else if (!['preparing', 'sending'].includes(send.state)) settleMakerInput();
    }
    if (closing || win.isDestroyed() || controls.webContents.isDestroyed()) return;
    // Results/cancellation end ownership even if the remote never publishes
    // another snapshot. Expire presentation independently of remote changes.
    const snapshot = assistant.snapshot;
    presentedSnapshot = stickerReadiness.present(snapshot, stickerTransfer.ownsMaker(snapshot) ? snapshot.stickerPreparation : undefined);
    clearTimeout(stickerReadinessTimer); stickerReadinessTimer = undefined;
    if (stickerReadiness.settlingDeadline > Date.now()) {
      stickerReadinessTimer = setTimeout(publish, stickerReadiness.settlingDeadline - Date.now());
    }
    if (stickerShield && (stickerTransfer.send?.nonce !== stickerShield.nonce ||
      !['preparing', 'sending'].includes(stickerTransfer.send.state) || panel !== 'stickers' ||
      shieldTarget?.chatId !== assistant.snapshot.chatId || shieldTarget?.name !== assistant.snapshot.name ||
      (assistant.snapshot.stickerPreparation !== stickerShield.nonce &&
        (!(presentedSnapshot ?? assistant.snapshot).ready || shieldTarget?.settingsId !== assistant.snapshot.settingsId)))) clearStickerShield();
    const makerResult = stickerTransfer.send;
    if (makerResult?.route === 'maker' && makerResult.detail && ['failed', 'cancelled'].includes(makerResult.state) && makerResult !== lastMakerDiagnostic) {
      // Only allowlisted structural codes; no chat identity or sticker data.
      console.warn('Sticker maker result', { state: makerResult.state, detail: makerResult.detail });
      lastMakerDiagnostic = makerResult;
    }
    if (panel === 'chat' && panelChat !== assistant.snapshot.settingsId) { panel = null; panelChat = null; layout(); }
    const next = status();
    pendingChrome = Boolean(assistant.pending); syncChrome();
    statusPublisher.next({ ...next, sequence: sequence + 1 });
  };
  const assistant = new Assistant(store, vault, { send: command => { sendRemote(command); }, focus: () => { if (!closing && !makerInputOwner && !remote.webContents.isDestroyed()) remote.webContents.focus(); } }, publish, fixture);
  let accountSafety: AccountSafetyReason = null;
  const disableDirect = (reason: DirectStickerDisabledReason) => {
    directStickerSafety.stop(reason);
    publish();
  };
  const directStickerSender = new DirectStickerSender({ readSticker: id => readSticker(id).image,
    transfer: stickerTransfer, snapshot: () => assistant.snapshot,
    enabled: () => directStickerSafety.enabled(), disable: disableDirect, diagnostics: stickerSendDiagnostics, publish,
    execute: script => {
      if (remote.webContents.isDestroyed() || (fixture ? remote.webContents.getURL() !== remoteURL : new URL(remote.webContents.getURL()).origin !== 'https://web.whatsapp.com')) throw new Error('Remote page changed');
      return remote.webContents.executeJavaScript(script);
    }
  });
  const stopStickerLookup = () => { settleMakerInput(); clearTimeout(stickerSendTimer); if (!remote.webContents.isDestroyed()) sendRemote({ type: 'cancelSticker' }); };
  const restoreShieldBounds = () => {
    clearTimeout(shieldRestoreTimer); shieldRestoreTimer = undefined; shieldRestoreNonce = undefined;
    shieldPanel = null; shieldExpanded = false; layout();
  };
  // Let the renderer finish its exit transition before shrinking. A bound also
  // restores input when the renderer cannot acknowledge the fade.
  const clearStickerShield = (immediate = false) => {
    shieldGeneration++;
    shieldDrawn?.resolve(false); shieldDrawn = undefined;
    clearTimeout(shieldCapTimer); shieldCapTimer = undefined;
    const nonce = stickerShield?.nonce;
    stickerShield = null; shieldTarget = null;
    if (!shieldPanel) return;
    if (immediate || shieldReducedMotion) {
      restoreShieldBounds();
    } else if (!shieldRestoreTimer) {
      shieldRestoreNonce = nonce;
      shieldRestoreTimer = setTimeout(restoreShieldBounds, 750);
    }
  };
  const showStickerShield = async (nonce: string) => {
    const generation = ++shieldGeneration;
    const panelBounds = shieldPanel ?? controls.getBounds();
    const { width, height } = win.contentView.getBounds();
    const x = panelBounds.x + panelBounds.width;
    const bounds = { x, y: 0, width: width - x, height };
    if (bounds.width <= 0 || height <= 0) return;
    let captureTimer: ReturnType<typeof setTimeout> | undefined;
    // A failed/hung capture must never prevent the user's send.
    try {
      const snapshot = await Promise.race([
        remote.webContents.capturePage(bounds),
        new Promise<null>(resolve => { captureTimer = setTimeout(() => resolve(null), 1200); })
      ]);
      if (!snapshot || snapshot.isEmpty() || generation !== shieldGeneration || panel !== 'stickers' ||
        stickerTransfer.send?.nonce !== nonce || stickerTransfer.send.state !== 'preparing' || win.isDestroyed()) return;
      const scale = Math.min(1, 1600 / bounds.width, 1000 / bounds.height);
      const image = snapshot.resize({ width: Math.max(1, Math.round(bounds.width * scale)), height: Math.max(1, Math.round(height * scale)) }).toJPEG(65);
      if (image.length > 1024 * 1024) return;
      clearTimeout(shieldRestoreTimer); shieldRestoreTimer = undefined; shieldRestoreNonce = undefined;
      shieldPanel = panelBounds;
      shieldTarget = { chatId: assistant.snapshot.chatId, name: assistant.snapshot.name, settingsId: assistant.snapshot.settingsId };
      stickerShield = { nonce, image: `data:image/jpeg;base64,${image.toString('base64')}`, bounds, panel: panelBounds };
      shieldCapTimer = setTimeout(() => {
        // This is a visual cap, independent of the post-click result budget.
        clearStickerShield(); publish();
      }, 10_000);
      let drawTimer: ReturnType<typeof setTimeout> | undefined;
      const drawn = new Promise<boolean>(resolve => {
        shieldDrawn = { nonce, resolve };
        drawTimer = setTimeout(() => resolve(false), 1200);
      });
      publish();
      const acknowledged = await drawn;
      clearTimeout(drawTimer);
      if (shieldDrawn?.nonce === nonce) shieldDrawn = undefined;
      if (!acknowledged || generation !== shieldGeneration || stickerShield?.nonce !== nonce) {
        if (stickerShield?.nonce === nonce) { clearStickerShield(true); publish(); }
        return;
      }
      shieldExpanded = true; layout();
    } catch {
      if (stickerShield?.nonce === nonce) { clearStickerShield(); publish(); }
      // Sending remains available without a snapshot.
    }
    finally { clearTimeout(captureTimer); }
  };
  const cancelSticker = () => {
    if (stickerTransfer.cancel()) { stopStickerLookup(); clearStickerShield(); }
  };
  const watchStickerMakerResult = (nonce: string) => {
    clearTimeout(stickerSendTimer);
    stickerSendTimer = setTimeout(() => { stickerTransfer.result(nonce, true, false, 'unconfirmed', 'confirm-timeout'); finishMakerInput(); stopStickerLookup(); publish(); }, STICKER_MAKER_WATCHDOG_MS);
  };
  const authorizeSticker = (nonce: string, snapshot: typeof assistant.snapshot) => {
    const send = stickerTransfer.send;
    // A queued picker Send already used verified bytes during preparation.
    // Deleting its library entry cannot revoke that issued command's grant.
    try { if (!send || send.nonce !== nonce) return false; if (!stickerTransfer.pickerSendQueued(nonce)) readSticker(send.id); }
    catch (error) { cancelSticker(); publish(); return false; }
    const allowed = stickerTransfer.authorize(nonce, snapshot);
    // Start the outcome budget at the grant, even if navigation or a renderer
    // failure prevents the clicked notification from reaching main.
    if (allowed) {
      if (stickerTransfer.send?.route === 'maker') { clearTimeout(makerInputTimer); makerInputTimer = undefined; watchStickerMakerResult(nonce); }
      publish();
    }
    return allowed;
  };
  win.contentView.on('bounds-changed', () => { cancelSticker(); clearStickerShield(); publish(); layout(); });
  // Recognize visible loaded history independently of composer readiness;
  // never infer a destination from names or presentation smoothing.
  const identifyStickerDestination = (snapshot: typeof assistant.snapshot) => conversations.identify(snapshot);
  const observeStickerDestination = (snapshot: typeof assistant.snapshot) => {
    const revoked = stickerTransfer.observe(snapshot);
    if (revoked) stopStickerLookup();
    if (makerInputOwner) {
      if (!snapshot.conversationOpen || makerInputTarget?.chatId !== snapshot.chatId || makerInputTarget?.name !== snapshot.name || snapshot.draft !== '' || snapshot.draftIssue || snapshot.composing || stickerTransfer.send?.detail === 'draft-appeared') finishMakerInput();
      else if (snapshot.stickerPreparation === makerInputOwner) makerInputPreparationSeen = true;
      // The connector drops its preparation token only after cleanup. Do not
      // mistake a pre-assignment snapshot for a teardown acknowledgement.
      else if (makerInputCleaning && makerInputPreparationSeen) finishMakerInput();
    }
    if (locateRequest && locateRequest.destinationToken !== stickerTransfer.destinationToken(snapshot)) {
      clearTimeout(locateRequest.timer); locateRequest = undefined;
      if (stickerLocation) stickerLocation = { id: stickerLocation.id, state: 'unavailable' };
    }
    return revoked;
  };
  const openPanel = (next: Panel, confirmed = false) => {
    if (closing || win.isDestroyed() || controls.webContents.isDestroyed() || remote.webContents.isDestroyed()) return;
    // The local controls own unsaved editor drafts. Rail/menu navigation must
    // ask them before unmounting the library; only their panel action completes it.
    if (panel === 'stickers' && next !== 'stickers' && !confirmed) {
      safeRendererSend(controls.webContents, closing, 'companion:panel-navigation', next);
      controls.webContents.focus();
      return;
    }
    cancelSticker(); clearStickerShield();
    if (next === 'chat' && (!assistant.snapshot.ready || !assistant.snapshot.settingsId)) {
      assistant.message = 'Chat settings need recognizable messages. Wait for this conversation to load.';
      sendRemote({ type: 'notice', text: assistant.message }); publish(); return;
    }
    panel = next; panelChat = next === 'chat' ? assistant.snapshot.settingsId! : null;
    clearTimeout(locateRequest?.timer); locateRequest = undefined; stickerLocation = null;
    if (panel) assistant.activity();
    layout(); publish();
    if (panel) controls.webContents.focus(); else if (!makerInputOwner && stickerTransfer.send?.state !== 'sending') remote.webContents.focus();
  };
  const requireScope = (scope: string) => {
    if (scope !== 'global' && scope !== 'general' && (scope !== assistant.snapshot.settingsId || !assistant.snapshot.ready)) throw new Error('This conversation changed. Reopen its settings.');
  };
  const providerChanged = (keyProvider?: 'openai' | 'anthropic') => {
    if (!keyProvider || keyProvider === store.state.provider) stickerTags.configurationChanged();
    providerCheck.invalidate(); assistant.reconfigure({ keyProvider });
    assistant.message = 'Provider configuration changed. Use Test connection to check account access.';
  };
  controls.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) { statusPublisher.reset(); panel = null; panelChat = null; cancelSticker(); finishMakerInput(); clearStickerShield(true); layout(); assistant.activity(); }
  });
  controls.webContents.on('did-start-loading', () => statusPublisher.reset());
  controls.webContents.on('did-finish-load', () => { statusPublisher.reset(); publish(); });
  controls.webContents.on('destroyed', () => statusPublisher.reset());
  const stickerInbox = new StickerInbox(store, () => {
    stickerTags.observe();
    for (const id of stickerBlobErrors.keys()) {
      if (!store.state.stickers.some(s => s.id === id)) stickerBlobErrors.delete(id);
      else try { readSticker(id); } catch { /* Still needs recovery. */ }
    }
    publish();
  }, message => { stickerIntakeError = message; publish(); }, image =>
    controls.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${decodeStickerPixels.toString()})(${JSON.stringify(image)})` }]));
  const trustedFrame = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent, contents: Electron.WebContents, local = false, allowClosing = false) => {
    try {
      if ((closing && !allowClosing) || contents.isDestroyed() || event.sender !== contents || !event.senderFrame || event.senderFrame.isDestroyed() || event.senderFrame !== contents.mainFrame) return false;
      return local ? event.senderFrame.url === uiURL : fixture ? event.senderFrame.url.split('#')[0] === remoteURL.split('#')[0] : new URL(event.senderFrame.url).origin === 'https://web.whatsapp.com';
    } catch { return false; }
  };
  const isLocal = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => trustedFrame(event, controls.webContents, true);
  const isRemote = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => trustedFrame(event, remote.webContents);
  ipcMain.handle('companion:boot-session', event => isRemote(event) ? bootSession : null);
  ipcMain.on('companion:connector-ready', (event, raw: unknown) => {
    if (!isRemote(event) || connectorReady) return;
    const parsed = bootSessionSchema.safeParse(raw);
    if (!parsed.success || parsed.data.nonce !== bootSession.nonce || parsed.data.generation !== bootSession.generation) return;
    connectorReady = true; maybeAskNotifications();
    // The preload deliberately drops commands during deferral. Re-establish
    // chrome and the assistant's navigation barrier after activation, even if
    // did-finish-load and every snapshot retry already happened on the splash.
    chromeSync.reset(); syncChrome(); assistant.refresh(true);
  });
  ipcMain.on('companion:boot-error', event => { if (isRemote(event)) startupDiagnostics.record('preload-error'); });
  ipcMain.on('companion:boot-deferral-expired', (event, raw: unknown) => {
    if (!isRemote(event)) return;
    const parsed = bootSessionSchema.safeParse(raw);
    if (parsed.success && parsed.data.nonce === bootSession.nonce && parsed.data.generation === bootSession.generation)
      startupDiagnostics.record('connector-deferral-expired', { generation: bootSession.generation });
  });
  ipcMain.on('companion:boot-heartbeat', (event, raw: unknown) => {
    if (!isRemote(event) || win.isDestroyed()) return;
    const result = startupWatchdog.accept(raw, performance.now(), { visible: win.isVisible() && !win.isMinimized(), closing,
      busy: permissionDialogsOpen > 0 || keyPromptOpen || Boolean(assistant.pending) || Boolean(makerInputOwner) || Boolean(stickerTransfer.send && ['finding', 'preparing', 'sending'].includes(stickerTransfer.send.state)) });
    if (!result) return;
    const { observation, decision } = result;
    if (!detectorSeen) { detectorSeen = true; startupDiagnostics.record('detector-ready', { generation: bootSession.generation }); }
    if (!structureLogged && observation.structure && (observation.phase === 'unknown' || observation.phase === 'splash')) {
      structureLogged = true;
      startupDiagnostics.record('structure', { structure: observation.structure, generation: bootSession.generation });
    }
    if (!assetFailureLogged && observation.assetFailed && observation.assetFailureKind) {
      assetFailureLogged = true;
      startupDiagnostics.record('asset-failure', { kind: observation.assetFailureKind, generation: bootSession.generation });
    }
    if (lastBoot?.phase !== observation.phase) startupDiagnostics.record('phase', { phase: observation.phase, generation: bootSession.generation });
    if (lastBoot?.progress !== observation.progress) startupDiagnostics.record('progress', { progress: observation.progress });
    if (lastBoot?.visible !== observation.visible || lastBoot?.online !== observation.online) startupDiagnostics.record('visibility', { visible: observation.visible, online: observation.online });
    lastBoot = observation;
    if (decision !== lastDecision) { lastDecision = decision; startupDiagnostics.record('watchdog', { decision, reloads: startupWatchdog.reloads }); }
    maybeAskNotifications();
    if (observation.phase === 'shell' && !shellChromeSynced) { shellChromeSynced = true; chromeSync.reset(); syncChrome(); }
    if (decision === 'reload') {
      startupDiagnostics.record('reload', { reloads: startupWatchdog.reloads, generation: bootSession.generation });
      cancelSticker(); finishMakerInput(); clearStickerShield(); assistant.suspend();
      try { if (!closing && !remote.webContents.isDestroyed()) remote.webContents.reload(); } catch { /* No more recovery action on a disposed frame. */ }
    }
  });
  ipcMain.handle('companion:authorize-auto', (event, raw: unknown) => {
    if (!isRemote(event)) return false;
    const nonce = z.string().uuid().safeParse(raw);
    return nonce.success && assistant.authorizeAutomatic(nonce.data);
  });
  ipcMain.handle('companion:authorize-sticker', (event, raw: unknown) => {
    if (!isRemote(event) || stickerTransfer.send?.route === 'direct') return false;
    if (typeof raw === 'string') {
      const nonce = z.string().uuid().safeParse(raw);
      return nonce.success && authorizeSticker(nonce.data, assistant.snapshot);
    }
    const request = z.object({ nonce: z.string().uuid(), phase: z.enum(['disclose', 'send']), snapshot: snapshotSchema }).strict().safeParse(raw);
    if (!request.success) return false;
    // A command held across cancellation can request permission late. Its
    // snapshot must not affect ownership or the destination of a newer send.
    if (stickerTransfer.send?.nonce !== request.data.nonce || !['preparing', 'sending'].includes(stickerTransfer.send.state)) return false;
    const snapshot = { ...request.data.snapshot, settingsId: identifyStickerDestination(request.data.snapshot) };
    if (observeStickerDestination(snapshot)) { publish(); return false; }
    try { if (!stickerTransfer.send || stickerTransfer.send.nonce !== request.data.nonce) return false; if (!stickerTransfer.pickerSendQueued(request.data.nonce)) readSticker(stickerTransfer.send.id); }
    catch (error) { cancelSticker(); publish(); return false; }
    const allowed = request.data.phase === 'disclose' ? stickerTransfer.disclose(request.data.nonce, snapshot) : authorizeSticker(request.data.nonce, snapshot);
    if (allowed && request.data.phase === 'disclose' && makerInputOwner === request.data.nonce) {
      makerInputDisclosed = true;
      makerInputCleanupDeadline = Date.now() + STICKER_MAKER_CLEANUP_MS;
    }
    return allowed;
  });
  ipcMain.handle('companion:shield-ready', (event, raw: unknown) => {
    if (!isLocal(event)) return;
    const drawn = z.object({ nonce: z.string().uuid(), reducedMotion: z.boolean() }).strict().safeParse(raw);
    if (drawn.success && shieldDrawn?.nonce === drawn.data.nonce && stickerShield?.nonce === drawn.data.nonce) {
      shieldReducedMotion = drawn.data.reducedMotion; shieldDrawn.resolve(true);
    }
  });
  ipcMain.handle('companion:shield-faded', (event, raw: unknown) => {
    if (!isLocal(event)) return;
    const nonce = z.string().uuid().safeParse(raw);
    if (nonce.success && nonce.data === shieldRestoreNonce && !stickerShield) restoreShieldBounds();
  });
  // A surviving controls frame may read the settled state during close.
  // Actions, permissions and outgoing renderer IPC remain blocked immediately.
  ipcMain.handle('companion:status', event => { if (!trustedFrame(event, controls.webContents, true, true)) throw new Error('Denied'); return statusUpdate(status()); });
  ipcMain.on('companion:subscribe', event => {
    if (!isLocal(event)) return;
    statusPublisher.reset(); publish();
  });
  ipcMain.handle('companion:models', (event, raw: unknown, refresh: unknown = false) => {
    if (!isLocal(event)) return { models: [], error: 'Denied' };
    const parsed = providerSchema.safeParse(raw);
    if (!parsed.success || typeof refresh !== 'boolean') return { models: [], error: 'Invalid provider.' };
    const provider = parsed.data;
    if (fixture) return { models: currentTextModels(provider, (provider === 'openai'
      ? ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-sol-2026-09-29', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-luna-2026-05-18', 'gpt-4o', 'text-embedding-3-small', 'gpt-audio']
      : ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-6']).map(id => ({ id, name: id }))) };
    try { return modelCatalog.load(provider, vault.get(provider), refresh); }
    catch (error) { return { models: [], error: error instanceof Error ? error.message : 'Unable to unlock the provider key.' }; }
  });
  const cleanupForgottenSticker = (id: string) => {
    stickerInbox.discard(id);
    if (stickerTransfer.send?.id === id && stickerTransfer.revokeIfNotAuthorized()) { stopStickerLookup(); clearStickerShield(); }
    stickerBlobErrors.delete(id);
  };
  ipcMain.handle('companion:action', async (event, raw: unknown) => {
    if (closing || !isLocal(event)) return { ok: false, error: 'Denied' };
    const parsed = actionSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'Invalid setting. Check the value and try again.' };
    const action = parsed.data;
    try {
      if ('scope' in action) requireScope(action.scope);
      switch (action.type) {
        case 'preferences': directStickerSafety.preferences(action.scope, action.patch);
          stickerTags.observe();
          if (accountSafety) disableDirect(accountSafety);
          assistant.reconfigure(); break;
        case 'resetPreferences': directStickerSafety.reset(action.scope);
          stickerTags.observe();
          assistant.reconfigure(); break;
        case 'resetStylePreferences': store.update(s => resetStylePreferences(s, action.scope)); assistant.reconfigure(); break;
        case 'provider': store.update(s => { s.provider = action.provider; s.models[action.provider] = action.model; }); providerChanged(); break;
        case 'reasoning': store.update(s => setReasoning(s, action.provider, action.model, action.effort)); providerChanged(); break;
        case 'key': {
          if (keyPromptOpen) throw new Error('A key entry dialog is already open.');
          keyPromptOpen = true;
          try { vault.set(action.provider, await promptKey(action.provider), action.persist); modelCatalog.invalidate(action.provider); providerChanged(action.provider); assistant.message = 'API key configured. Use Test connection to check account access.'; }
          finally { keyPromptOpen = false; }
          break;
        }
        case 'deleteKey': vault.remove(action.provider); modelCatalog.invalidate(action.provider); providerChanged(action.provider); break;
        case 'testProvider': {
          if (fixture) { assistant.message = 'Demo provider check passed locally. No network request was made.'; break; }
          const p = store.state.provider;
          const configuration = { provider: p, model: store.state.models[p], key: vault.get(p), effort: savedEffort(store.state) };
          const checking = providerCheck.run(configuration);
          assistant.message = 'Testing provider connection…'; publish();
          try { const result = await checking; if (result) assistant.message = result; }
          catch (error) { assistant.message = 'Provider connection check failed.'; publish(); throw error; }
          break;
        }
        case 'autoRules': assistant.updateAutoRules(action.chatId, action.patch); break;
        case 'autoPermission': assistant.changeAutoPermission(action.chatId, action.permission); break;
        case 'profile': store.update(s => { s.profiles[action.scope] = { description: action.description, samples: 5, updatedAt: Date.now(), source: 'edited' }; }); assistant.reconfigure(); break;
        case 'learn': {
          if (!action.examples.trim() && (!assistant.snapshot.ready || !action.sourceChatId || action.sourceChatId !== assistant.snapshot.settingsId)) throw new Error('This conversation changed. Reopen Style and try again.');
          if (action.scope !== 'general' && action.scope !== assistant.snapshot.settingsId) throw new Error('Open this conversation to learn its style.');
          const examples = action.examples.trim() ? action.examples.split('\n') : assistant.snapshot.messages.filter(m => m.outgoing && !m.directionFallback).map(m => m.text);
          const profile = learnStyle(examples, 'selected');
          if (!profile) throw new Error(action.examples.trim() ? `Add at least ${minimumStyleSamples} messages with three or more characters, one per line.` : `Only ${styleSamples(examples).length} usable sent messages are loaded. Scroll up in WhatsApp to load more; at least ${minimumStyleSamples} are needed.`);
          store.update(s => { s.profiles[action.scope] = profile; }); assistant.reconfigure({ learning: true }); break;
        }
        case 'resetProfile': store.update(s => { delete s.profiles[action.scope]; if (action.scope !== 'general') setPreferences(s, action.scope, { learnFromSent: false }); }); assistant.reconfigure(); break;
        case 'cancelSticker': cancelSticker(); break;
        case 'sendSticker': {
          if (panel !== 'stickers' || !store.state.stickers.some(s => s.id === action.id)) throw new Error('Open the sticker library and choose an indexed sticker.');
          if (stickerSendBlockedReason() === 'busy') throw new Error('Wait for the current sticker.');
          const sticker = store.state.stickers.find(s => s.id === action.id)!;
          const stored = readSticker(sticker.id);
          const fallbackRoute = stickerRoute(assistant.snapshot, stored.animated, action.still) as 'maker' | 'picker';
          let route = stickerRoute(assistant.snapshot, stored.animated, action.still, directStickerSafety.enabled());
          let ticket = stickerTransfer.begin(action.id, action.nonce, action.destinationToken, assistant.snapshot, Date.now(), route, stored.animated);
          sendDiagnostic = { nonce: action.nonce, startedAt: Date.now() };
          if (stickerTransfer.send?.state === 'failed') break;
          assistant.activity();
          if (route === 'direct') {
            publish();
            const fallback = await directStickerSender.run(ticket, stored.image, fallbackRoute);
            if (!fallback) break;
            ticket = fallback; route = fallbackRoute;
          }
          clearTimeout(stickerSendTimer);
          stickerSendTimer = setTimeout(() => { if (stickerTransfer.timeout(ticket.nonce)) { finishMakerInput(); stopStickerLookup(); publish(); } }, route === 'picker' ? STICKER_PICKER_WATCHDOG_MS : 60_000);
          if (route === 'maker') await showStickerShield(ticket.nonce);
          if (stickerTransfer.send?.nonce !== ticket.nonce || !['finding', 'preparing'].includes(stickerTransfer.send.state)) break;
          try { readSticker(ticket.id); } catch (error) { cancelSticker(); throw error; }
          if (route === 'maker') startMakerInput(ticket.nonce);
          requireRemote(route === 'maker' ? { type: 'makeSticker', id: ticket.id, nonce: ticket.nonce, target: ticket.target, route, image: stored.image } : { type: 'prepareSticker', id: ticket.id, nonce: ticket.nonce, target: ticket.target, route }); break;
        }
        case 'createStickerGroup':
        case 'renameStickerGroup':
        case 'deleteStickerGroup':
        case 'stickerGroupMembership':
        case 'bulkStickerGroupMembership': store.update(s => applyStickerGroupAction(s, action, randomUUID)); break;
        case 'tagStickers': stickerTags.enqueue(action.ids); break;
        case 'suggestStickerTags': stickerTags.suggest(action.id, action.nonce, action.searchTerms); break;
        case 'removeStickerTag': stickerTags.remove(action.id); break;
        case 'stopStickerTags': stickerTags.stop(); break;
        case 'retryStickerTags': stickerTags.retry(action.excludedIds); break;
        case 'dismissStickerTags': stickerTags.dismiss(); break;
        case 'sticker': stickerTags.remove(action.id); store.update(s => { const sticker = s.stickers.find(x => x.id === action.id); if (!sticker) throw new Error('Sticker no longer indexed.'); sticker.searchTerms = action.searchTerms;
          if (action.addGroups) sticker.groups = [...new Set([...sticker.groups, ...action.addGroups.filter(id => s.stickerGroups.some(g => g.id === id))])].slice(0, 50);
        }); break;
        case 'forgetSticker':
        case 'forgetStickers': {
          const ids = action.type === 'forgetSticker' ? [action.id] : action.ids;
          for (const id of ids) stickerTags.remove(id);
          const removed = store.forgetStickers(ids);
          for (const id of removed) cleanupForgottenSticker(id);
          break;
        }
        case 'locateSticker': {
          stickerTransfer.requireDestination(action.destinationToken, assistant.snapshot);
          readSticker(action.id);
          clearTimeout(locateRequest?.timer);
          const nonce = randomUUID();
          stickerLocation = { id: action.id, state: 'looking' };
          locateRequest = { nonce, destinationToken: action.destinationToken, timer: setTimeout(() => {
            locateRequest = undefined; stickerLocation = { id: action.id, state: 'unavailable' }; publish();
          }, 3000) };
          requireRemote({ type: 'locateSticker', id: action.id, nonce }); break;
        }
        case 'panel': openPanel(action.panel, true); break;
        case 'reload': cancelSticker(); finishMakerInput(); clearStickerShield(); publish(); assistant.suspend(); await remote.webContents.loadURL(remoteURL); break;
        case 'cancelAuto': assistant.activity(); return { ok: true };
      }
      publish(); return { ok: true };
    } catch (error) {
      if (action.type === 'preferences' || action.type === 'resetPreferences') publish();
      if (action.type === 'sendSticker') {
        if (stickerTransfer.send?.nonce === action.nonce) {
          if (makerInputOwner === action.nonce) {
            finishMakerInput(); stickerTransfer.result(action.nonce, false, false, 'editor-unavailable', 'maker-error');
          } else cancelSticker();
          clearStickerShield();
        }
        publish();
      }
      if (action.type === 'locateSticker') publish();
      return { ok: false, error: error instanceof Error ? error.message : 'Operation failed. Your previous data is preserved.' };
    }
  });
  ipcMain.on('companion:event', (event, raw: unknown) => {
    if (!isRemote(event)) return;
    const envelope = z.object({ type: z.string() }).passthrough().safeParse(raw);
    if (!envelope.success) return;
    if (stickerTransfer.send?.route === 'direct' && ['stickerPrepared', 'stickerClicked', 'stickerSent', 'stickerCancelled'].includes(envelope.data.type)) return;
    try {
      switch (envelope.data.type) {
        case 'accountSafety': {
          const v = accountSafetyEventSchema.safeParse(raw);
          if (v.success) {
            accountSafety = v.data.reason;
            if (accountSafety) disableDirect(accountSafety);
          }
          break;
        }
        case 'stickerPickerLayout': pickerDiagnostics.receive(raw); break;
        case 'stickerPrepared': {
          // Optional telemetry is validated separately from the transfer result.
          const v = z.object({ type: z.literal('stickerPrepared'), nonce: z.string().uuid(), found: z.boolean(), diagnostics: stickerLookupDiagnosticsSchema.optional().catch(undefined) }).strict().safeParse(raw);
          if (v.success) {
            if (sendDiagnostic?.nonce === v.data.nonce && !sendDiagnostic.written) sendDiagnostic.result = v.data.diagnostics;
            const ticket = stickerTransfer.prepared(v.data.nonce, v.data.found, assistant.snapshot);
            if (ticket && stickerTransfer.queuePickerSend(ticket.nonce)) {
              clearTimeout(stickerSendTimer);
              // A lost picker result cannot prove whether activation happened.
              stickerSendTimer = setTimeout(() => { stickerTransfer.result(ticket.nonce, true, false, 'unconfirmed'); stopStickerLookup(); publish(); }, 6000);
              requireRemote({ type: 'sendSticker', id: ticket.id, nonce: ticket.nonce, target: ticket.target, expiresAt: Date.now() + 5000 });
            } else if (stickerTransfer.send?.nonce === v.data.nonce && stickerTransfer.send.state !== 'sending') stopStickerLookup();
            publish();
          } break;
        }
        case 'stickerCancelled': {
          const v = z.object({ type: z.literal('stickerCancelled'), nonce: z.string().uuid(), reason: z.literal('chat-changed'), detail: z.enum(stickerMakerDetails).optional() }).strict().safeParse(raw);
          if (v.success && stickerTransfer.send?.nonce === v.data.nonce) {
            if (makerInputOwner === v.data.nonce) finishMakerInput();
            if (stickerTransfer.cancel(v.data.reason, v.data.detail)) stopStickerLookup();
            publish();
          }
          break;
        }
        case 'stickerClicked': {
          const v = z.object({ type: z.literal('stickerClicked'), nonce: z.string().uuid() }).strict().safeParse(raw);
          if (v.success) {
            stickerTransfer.clicked(v.data.nonce);
            if (stickerTransfer.send?.nonce === v.data.nonce && stickerTransfer.send.state === 'sending') {
              watchStickerMakerResult(v.data.nonce);
              publish();
            }
          } break;
        }
        case 'stickerSent': {
          const v = z.object({ type: z.literal('stickerSent'), nonce: z.string().uuid(), clicked: z.boolean(), confirmed: z.boolean().optional(), reason: z.enum(['editor-unavailable', 'unconfirmed', 'draft']).optional(), detail: z.enum(stickerMakerDetails).optional(), diagnostics: stickerLookupDiagnosticsSchema.optional().catch(undefined) }).strict().safeParse(raw);
          if (v.success) {
            if (sendDiagnostic?.nonce === v.data.nonce && !sendDiagnostic.written && v.data.diagnostics) sendDiagnostic.result = v.data.diagnostics;
            if (makerInputOwner === v.data.nonce) finishMakerInput();
            if (stickerTransfer.send?.nonce === v.data.nonce && ['sending', 'preparing'].includes(stickerTransfer.send.state)) clearTimeout(stickerSendTimer);
            stickerTransfer.result(v.data.nonce, v.data.clicked, v.data.confirmed, v.data.reason, v.data.detail);
            publish();
          } break;
        }
        case 'stickerLocated': {
          const v = z.object({ type: z.literal('stickerLocated'), nonce: z.string().uuid(), found: z.boolean() }).strict().safeParse(raw);
          if (v.success && locateRequest?.nonce === v.data.nonce && locateRequest.destinationToken === stickerTransfer.destinationToken(assistant.snapshot) && stickerLocation) {
            clearTimeout(locateRequest.timer); locateRequest = undefined;
            stickerLocation = { id: stickerLocation.id, state: v.data.found ? 'found' : 'missing' }; publish();
          } break;
        }
        case 'snapshot': {
          const s = snapshotSchema.safeParse(envelope.data.snapshot);
          if (s.success) {
            // Parse first so a failed identification still completes a nonce-tagged refresh.
            const nonce = z.string().uuid().optional().safeParse(envelope.data.nonce);
            let settingsId: string | null;
            try { settingsId = identifyStickerDestination(s.data); }
            catch (error) {
              const unavailable = { ...s.data, settingsId: null, ready: false };
              observeStickerDestination(unavailable);
              presentedSnapshot = unavailable;
              if (nonce.success) assistant.receive(unavailable, false, nonce.data);
              throw error;
            }
            const snapshot = { ...s.data, settingsId };
            presentedSnapshot = stickerReadiness.present(snapshot, stickerTransfer.ownsMaker(snapshot) ? snapshot.stickerPreparation : undefined);
            const revoked = observeStickerDestination(snapshot);
            if (nonce.success) assistant.receive(snapshot, false, nonce.data);
            if (revoked) publish();
          } break;
        }
        case 'navigate': {
          const v = z.object({ type: z.literal('navigate'), panel: panelSchema }).strict().safeParse(raw);
          if (v.success) openPanel(v.data.panel === panel ? null : v.data.panel); break;
        }
        case 'chrome': {
          const v = z.object({ type: z.literal('chrome'), rail: z.number().finite().min(0).max(100), listWidth: z.number().finite().min(0).max(1500), theme: z.enum(['dark', 'light']) }).strict().safeParse(raw);
          if (v.success && (chrome.rail !== v.data.rail || chrome.listWidth !== v.data.listWidth || chrome.theme !== v.data.theme)) { chrome = v.data; layout(); publish(); } break;
        }
        case 'cancelAuto': assistant.activity(); break;
        case 'activity': { const v = z.object({ type: z.literal('activity'), editing: z.boolean().optional() }).strict().safeParse(raw); if (v.success) assistant.activity(v.data.editing); break; }
        case 'applied': { const v = z.object({ type: z.literal('applied'), key: z.string().max(1_000_000), suggestionId: z.string().uuid(), success: z.boolean().optional() }).strict().safeParse(raw); if (v.success) assistant.applied(v.data); break; }
        case 'displayAck': { const v = displayAckSchema.safeParse(raw); if (v.success) assistant.displayAck(v.data); break; }
        case 'dismiss': { const v = dismissEventSchema.safeParse(raw); if (v.success) assistant.dismiss(v.data); break; }
        case 'request': { const v = z.object({ type: z.literal('request'), instruction: z.string().max(1000).optional(), operation: z.enum(['translate', 'retry']).optional(), key: z.string().max(1_000_000).optional(), suggestionId: z.string().uuid().optional() }).strict().safeParse(raw); if (v.success) void assistant.request(v.data.instruction, false, v.data); break; }
        case 'result': { const v = z.object({ type: z.literal('result'), nonce: z.string().uuid(), sent: z.boolean() }).strict().safeParse(raw); if (v.success) assistant.result(v.data.nonce, v.data.sent); break; }
        case 'sticker': {
          const v = z.object({ type: z.literal('sticker'), image: stickerImageSchema }).strict().safeParse(raw);
          if (!v.success) break;
          const bytes = Buffer.from(v.data.image.split(',')[1], 'base64');
          if (bytes.length > MAX_STICKER_BYTES || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') break;
          const id = createHash('sha256').update(bytes).digest('hex');
          storedSticker(v.data.image, id);
          if (store.state.forgottenStickers.includes(id)) break;
          const existing = store.state.stickers.find(x => x.id === id);
          if (existing && Date.now() - existing.lastSeen < 60000) {
            try { readSticker(id); break; }
            catch { /* A fresh observation can repair a missing or damaged blob. */ }
          }
          const sticker = discoveredStickerSchema.parse({ id, image: v.data.image, searchTerms: '', firstSeen: Date.now(), lastSeen: Date.now() });
          stickerInbox.add(sticker); break;
        }
      }
    } catch { assistant.message = 'A local update could not be saved. Check disk space and the data directory.'; publish(); }
  });
  for (const contents of [win.webContents, controls.webContents, remote.webContents]) {
    contents.setWindowOpenHandler(({ url }) => {
      if (contents === remote.webContents && /^https?:\/\//.test(url)) void dialog.showMessageBox(win, { type: 'question', message: 'Open this link in your browser?', detail: url.slice(0, 500), buttons: ['Cancel', 'Open'], defaultId: 0, cancelId: 0 }).then(r => { if (r.response === 1) void shell.openExternal(url); });
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('will-navigate', (event, url) => {
      if (contents !== remote.webContents ? url !== uiURL : fixture ? url !== remoteURL : new URL(url).origin !== 'https://web.whatsapp.com') event.preventDefault();
    });
  }
  installRemotePermissions(remote.webContents, fixture ? remoteURL : undefined, async () => {
    permissionDialogsOpen++; startupWatchdog.resetObservations();
    try {
      const result = await dialog.showMessageBox(win, { message: 'Allow WhatsApp to use your microphone or camera?', buttons: ['Deny', 'Allow'], defaultId: 0, cancelId: 0 });
      return !closing && result.response === 1;
    } finally { permissionDialogsOpen--; startupWatchdog.resetObservations(); }
  }, notifications);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  controls.webContents.session.setPermissionCheckHandler(() => false);
  controls.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  remoteSession.on('will-download', (_event, item) => { item.setSaveDialogOptions({ title: 'Save WhatsApp attachment' }); });
  const remoteLoadRecovery = new RemoteLoadRecovery({
    load: () => { void remote.webContents.loadURL(remoteURL).catch(() => {}); }, stop: () => remote.webContents.stop(),
    closing: () => closing || remote.webContents.isDestroyed(), visible: () => !win.isDestroyed() && win.isVisible(),
    execPath: process.execPath, args: process.argv.slice(1), env: process.env,
    relaunch: options => { app.relaunch(options); app.quit(); }, record: (event, details) => startupDiagnostics.record(event, details)
  }, fixtureStartupStall ? { stalledMs: 1500, repeatStalledMs: 2000, retryMs: [200, 500, 1000] } : undefined);
  remote.webContents.on('did-start-navigation', details => {
    remoteLoadRecovery.navigate(details.isMainFrame, details.isSameDocument);
    if (!details.isMainFrame || details.isSameDocument || closing) return;
    bootSession = { nonce: randomUUID(), generation: bootSession.generation + 1 };
    startupWatchdog.navigate(bootSession); detectorSeen = false; structureLogged = false; assetFailureLogged = false; shellChromeSynced = false; connectorReady = false; lastBoot = undefined; lastDecision = undefined;
    startupDiagnostics.record('remote-navigation', { generation: bootSession.generation });
    chromeSync.reset(); pickerDiagnostics.cancel(); cancelSticker(); finishMakerInput(); clearStickerShield(); publish(); assistant.suspend();
  });
  remote.webContents.on('did-start-loading', () => chromeSync.reset());
  remote.webContents.on('destroyed', () => { chromeSync.reset(); remoteLoadRecovery.close(); });
  controls.webContents.on('render-process-gone', () => { panel = null; panelChat = null; cancelSticker(); finishMakerInput(); clearStickerShield(true); layout(); statusPublisher.reset(); });
  remote.webContents.on('did-navigate', (_event, _url, httpResponseCode) => remoteLoadRecovery.commit(httpResponseCode));
  remote.webContents.on('dom-ready', () => { remoteLoadRecovery.domReady(); startupDiagnostics.record('dom-ready'); });
  remote.webContents.on('preload-error', () => startupDiagnostics.record('preload-error'));
  remote.webContents.on('unresponsive', () => startupDiagnostics.record('unresponsive'));
  remote.webContents.on('responsive', () => startupDiagnostics.record('responsive'));
  remote.webContents.on('did-finish-load', () => { startupDiagnostics.record('finish-load'); chromeSync.reset(); syncChrome(); if (connectorReady) assistant.refresh(true); });
  remote.webContents.on('render-process-gone', (_event, details) => {
    startupDiagnostics.record('render-process-gone', { reason: ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'].includes(details.reason) ? details.reason : 'other' });
    bootSession = { nonce: randomUUID(), generation: bootSession.generation + 1 };
    startupWatchdog.navigate(bootSession); detectorSeen = false; structureLogged = false; assetFailureLogged = false; shellChromeSynced = false; connectorReady = false; lastBoot = undefined; lastDecision = undefined;
    pickerDiagnostics.cancel(); cancelSticker(); finishMakerInput(); clearStickerShield(); assistant.suspend(); assistant.message = 'WhatsApp stopped responding. Use Reload WhatsApp to reconnect.'; publish(); chromeSync.reset(); });
  remote.webContents.on('did-fail-provisional-load', (_event, code, _description, _url, mainFrame) => remoteLoadRecovery.fail(code, mainFrame, true));
  remote.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
    remoteLoadRecovery.fail(code, mainFrame);
    if (mainFrame && code !== -3 && !closing) { assistant.message = 'WhatsApp could not load. Check your connection and use Reload WhatsApp.'; publish(); }
  });
  const stopRuntime = cleanupOnce([
    () => remoteLoadRecovery.close(),
    () => conversations.close(), () => cancelSticker(), () => stopMakerInput(), () => assistant.cancel(true),
    () => clearStickerShield(true), () => pickerDiagnostics.cancel(), () => stickerTransfer.cancel(), () => recordStickerSend(),
    () => { clearTimeout(locateRequest?.timer); clearTimeout(stickerSendTimer); clearTimeout(stickerReadinessTimer); clearTimeout(shieldCapTimer); clearTimeout(shieldRestoreTimer); },
    () => stickerTags.close(), () => providerCheck.invalidate(), () => modelCatalog.invalidate('openai'), () => modelCatalog.invalidate('anthropic'), () => requestCounts.close()
  ], () => {});
  const beginClosing = () => {
    if (closing) return;
    closing = true; notifications.close(); startupDiagnostics.record('close-requested'); clearTimeout(gcTimer); startupWatchdog.resetObservations();
    stopRuntime();
  };
  const destroyViews = cleanupOnce([
    () => { tray?.tray.destroy(); tray = undefined; },
    () => { if (!remote.webContents.isDestroyed()) remote.webContents.close(); },
    () => { if (!controls.webContents.isDestroyed()) controls.webContents.close(); }
  ], () => {
    startupDiagnostics.record('views-destroyed'); quit();
  });
  let drainStarted = false;
  win.on('close', event => {
    if (tray && !closing) { event.preventDefault(); win.hide(); win.setSkipTaskbar(true); return; }
    beginClosing();
    if (!indexDrained) {
      event.preventDefault();
      if (!drainStarted) {
        drainStarted = true;
        void Promise.resolve().then(() => stickerInbox.close()).catch(() => {}).finally(() => {
          indexDrained = true; startupDiagnostics.record('intake-drained');
          if (!win.isDestroyed()) win.close(); else destroyViews();
        });
      }
    }
  });
  closeWindow = () => {
    beginClosing();
    if (!win.isDestroyed()) win.close(); else destroyViews();
  };
  win.on('closed', () => { beginClosing(); destroyViews(); });
  app.on('second-instance', showWindow);
  app.on('activate', () => {
    // macOS activates once at launch. Later Dock clicks must work even while
    // the remote navigation is still pending.
    if (suppressStartupActivation) { suppressStartupActivation = false; return; }
    showWindow();
  });
  // query-session-end can still be canceled, so only a confirmed end quits.
  win.on('session-end', () => closeWindow?.());
  // Electron emits a cancelable event here; its typings omit that argument.
  powerMonitor.on('shutdown', (event?: Electron.Event) => { event?.preventDefault(); closeWindow?.(); });
  const recordVisibility = () => {
    const visible = !win.isDestroyed() && win.isVisible() && !win.isMinimized();
    startupDiagnostics.record('visibility', { visible });
    if (!visible) startupWatchdog.resetObservations();
    else maybeAskNotifications();
  };
  win.on('show', recordVisibility); win.on('hide', recordVisibility); win.on('minimize', recordVisibility); win.on('restore', recordVisibility);
  try {
    tray = createCompanionTray(root, { open: showWindow, notifications: () => notifications.answer() === 'allowed',
      startAtLogin: () => startAtLogin,
      toggleNotifications: () => {
        notifications.change(notifications.answer() !== 'allowed'); tray?.refresh();
      },
      toggleStartAtLogin: () => {
        const enabled = !startAtLogin;
        try { login.change(enabled, startAtLogin, value => store.update(state => { state.desktop.startAtLogin = value; })); startAtLogin = enabled; }
        catch { saveFailure('Start at login could not be updated. Check the autostart directory and local data permissions.'); }
        tray?.refresh();
      }, quit: () => closeWindow?.() });
    startupDiagnostics.record('tray-created');
  } catch { startupDiagnostics.record('tray-unavailable'); }
  try {
    startAtLogin = login.initialize(store.state.desktop.startAtLogin, Boolean(tray), value => store.update(state => { state.desktop.startAtLogin = value; })) === true;
  } catch { saveFailure('Start at login could not be updated. Check the autostart directory and local data permissions.'); }
  tray?.refresh();
  if (!hiddenStart || !tray) win.show();
  else win.setSkipTaskbar(true);
  recordVisibility();
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Companion', submenu: [{ label: 'AI settings', accelerator: 'CmdOrCtrl+,', click: () => openPanel('settings') }, { label: 'Sticker library', click: () => openPanel('stickers') }, { label: 'Chat AI settings', click: () => openPanel('chat') }, { label: 'Capture sticker picker layout', click: () => pickerDiagnostics.capture() }, { type: 'separator' }, { label: 'Reload WhatsApp', click: () => { if (closing || remote.webContents.isDestroyed()) return; cancelSticker(); finishMakerInput(); clearStickerShield(); publish(); assistant.suspend(); void remote.webContents.loadURL(remoteURL).catch(() => {}); } }, { role: 'quit', accelerator: 'CmdOrCtrl+Q' }] }, { role: 'editMenu' },
    { label: 'View', submenu: [{ label: 'Reload controls', accelerator: 'CmdOrCtrl+R', click: () => controls.webContents.reload() }, { label: 'Force reload controls', accelerator: 'CmdOrCtrl+Shift+R', click: () => controls.webContents.reloadIgnoringCache() }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] }]));
  await win.loadURL('about:blank');
  await controls.webContents.loadURL(uiURL);
  startupDiagnostics.record('controls-loaded');
  if (closing) return;
  // Let navigation begin before best-effort GC; migration was already durable.
  gcTimer = setTimeout(() => { if (!closing) store.collectGarbage((phase, durationMs) => startupDiagnostics.record(phase, { durationMs })); }, 5000);
  if (fixtureStartupStall) remoteSession.protocol.handle('companion-fixture-stall', () => new Promise<Response>(() => {}));
  await remote.webContents.loadURL(fixtureStartupStall ? 'companion-fixture-stall://startup/' : remoteURL).catch(() => {});
  suppressStartupActivation = false;
  publish();
}
