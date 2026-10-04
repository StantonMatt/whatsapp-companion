import { applyStickerGroupAction } from '../core/sticker-groups';
import { app, BrowserWindow, WebContentsView, ipcMain, session, protocol, dialog, shell, Menu } from 'electron';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { actionSchema, snapshotSchema, discoveredStickerSchema, stickerImageSchema, providerSchema, panelSchema, type Panel, type Status, type ViewBounds, type DirectStickerDisabledReason } from '../shared/model';
import { accountSafetyEventSchema, displayAckSchema, dismissEventSchema, type AccountSafetyReason } from '../shared/connector';
import { Store } from './store';
import { Conversations } from './conversations';
import { Vault, promptKey, configuredBackend } from './vault';
import { Assistant } from './assistant';
import { setPreferences, resetStylePreferences } from '../core/settings';
import { learnStyle, styleSamples, minimumStyleSamples } from '../core/style';
import { statusUpdate } from '../core/status';
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
import { installRemotePermissions } from './permissions';

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
if (!app.requestSingleInstanceLock()) app.quit();
else void app.whenReady().then(start).catch(() => {
  dialog.showErrorBox('WhatsApp Companion could not start', 'The local data file or OS credential store could not be opened. Your files have been preserved. See README for recovery steps.'); app.quit();
});

async function start() {
  const store = new Store(app.getPath('userData'));
  const requestCounts = new RequestCounts(app.getPath('userData'));
  useRequestCounts(requestCounts);
  const vault = new Vault(app.getPath('userData'));
  const providerCheck = new ProviderCheck();
  const modelCatalog = new ModelCatalog();
  const root = __dirname;
  const uiURL = pathToFileURL(join(root, 'ui/index.html')).href;
  const remoteURL = fixture ? pathToFileURL(join(root, 'fixture.html')).href : 'https://web.whatsapp.com/';
  const conversations = new Conversations(store);
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
    icon: join(root, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  const controls = new WebContentsView({ webPreferences: { preload: join(root, 'local.cjs'), partition: 'companion-controls', contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  const remote = new WebContentsView({ webPreferences: { preload: join(root, 'remote.cjs'), partition: fixture ? 'persist:fixture' : 'persist:whatsapp', contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: true } });
  installEditContextMenus([remote.webContents, controls.webContents], win, Menu);
  // Scheme privileges are global; the handler exists only in the local session.
  controls.webContents.session.protocol.handle(STICKER_SCHEME, request => stickerResponse({ readSticker }, request));
  // WhatsApp rejects Electron-branded user agents despite the current Chromium engine.
  const platform = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  remote.webContents.setUserAgent(`Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`);
  win.contentView.addChildView(remote);
  win.contentView.addChildView(controls);
  controls.setBackgroundColor('#00000000');
  controls.setVisible(false);
  const pickerDiagnostics = new PickerDiagnostics({
    directory: app.getPath('userData'), appVersion: app.getVersion(),
    send: command => { if (!remote.webContents.isDestroyed()) remote.webContents.send('companion:command', command); },
    reveal: path => shell.showItemInFolder(path),
    notify: message => { if (!win.isDestroyed()) void dialog.showMessageBox(win, { type: 'info', message, buttons: ['OK'] }).catch(() => {}); }
  });
  let pendingChrome = false;
  const syncChrome = () => {
    if (remote.webContents.isDestroyed()) return;
    const bounds = shieldPanel ?? controls.getBounds(), zoom = remote.webContents.getZoomFactor();
    remote.webContents.send('companion:command', { type: 'chrome', panel, pending: pendingChrome,
      panelBounds: panel ? { left: bounds.x / zoom, right: (bounds.x + bounds.width) / zoom } : null });
  };
  const layout = () => {
    if (win.isDestroyed() || remote.webContents.isDestroyed()) return;
    const { width, height } = win.contentView.getBounds();
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
  let sequence = 0, lastState: Status['state'] | undefined;
  // Presentation can hold composer readiness during maker teardown. Send
  // availability and route selection use the raw conversation/composer state.
  const stickerSendBlockedReason = () => stickerTransfer.blockedReason(assistant.snapshot, makerInputCleaning);
  const libraryMessage = () => stickerBlobErrors.values().next().value ?? stickerIntakeError ?? store.recoveryHint ?? (store.state.stickers.length >= MAX_LIBRARY_STICKERS || store.state.stickers.reduce((total, s) => total + s.size, 0) >= MAX_LIBRARY_BYTES ? 'Sticker library is full' : undefined);
  const status = (): Status => ({ sequence, panel, stickerLibraryError: libraryMessage(), stickerLocation, stickerShield, stickerSend: stickerTransfer.send, theme: chrome.theme, runtimePaused: assistant.isRuntimePaused(), state: directStickerSafety.state(), chat: { destinationToken: stickerTransfer.destinationToken(assistant.snapshot), chatId: assistant.snapshot.chatId, settingsId: assistant.snapshot.settingsId, name: assistant.snapshot.name, kind: assistant.snapshot.kind, ready: (presentedSnapshot ?? assistant.snapshot).ready, canSendSticker: !stickerSendBlockedReason(), stickerSendBlockedReason: stickerSendBlockedReason(), loadedSentSamples: styleSamples(assistant.snapshot.messages.filter(m => m.outgoing && !m.directionFallback).map(m => m.text)).length }, keys: { openai: vault.has('openai'), anthropic: vault.has('anthropic') }, secureStorage: vault.secure(), fixture, message: assistant.message, pending: assistant.pending });
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
    if (win.isDestroyed() || controls.webContents.isDestroyed()) return;
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
    sequence++;
    if (panel === 'chat' && panelChat !== assistant.snapshot.settingsId) { panel = null; panelChat = null; layout(); }
    const next = status();
    pendingChrome = Boolean(assistant.pending); syncChrome();
    controls.webContents.send('companion:status', statusUpdate(next, lastState));
    lastState = next.state;
  };
  const assistant = new Assistant(store, vault, { send: command => { if (!remote.webContents.isDestroyed()) remote.webContents.send('companion:command', command); }, focus: () => { if (!makerInputOwner) remote.webContents.focus(); } }, publish, fixture);
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
  const stopStickerLookup = () => { settleMakerInput(); clearTimeout(stickerSendTimer); if (!remote.webContents.isDestroyed()) remote.webContents.send('companion:command', { type: 'cancelSticker' }); };
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
    try { if (!send || send.nonce !== nonce) return false; readSticker(send.id); }
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
  const openPanel = (next: Panel) => {
    cancelSticker(); clearStickerShield();
    if (next === 'chat' && (!assistant.snapshot.ready || !assistant.snapshot.settingsId)) {
      assistant.message = 'Chat settings need recognizable messages. Wait for this conversation to load.';
      remote.webContents.send('companion:command', { type: 'notice', text: assistant.message }); publish(); return;
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
    providerCheck.invalidate(); assistant.reconfigure({ keyProvider });
    assistant.message = 'Provider configuration changed. Use Test connection to check account access.';
  };
  controls.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) { panel = null; panelChat = null; cancelSticker(); finishMakerInput(); clearStickerShield(true); layout(); assistant.activity(); }
  });
  const stickerInbox = new StickerInbox(store, () => {
    for (const id of stickerBlobErrors.keys()) {
      if (!store.state.stickers.some(s => s.id === id)) stickerBlobErrors.delete(id);
      else try { readSticker(id); } catch { /* Still needs recovery. */ }
    }
    publish();
  }, message => { stickerIntakeError = message; publish(); }, image =>
    controls.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${decodeStickerPixels.toString()})(${JSON.stringify(image)})` }]));
  const isLocal = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => event.sender === controls.webContents && event.senderFrame === controls.webContents.mainFrame && event.senderFrame.url === uiURL;
  const isRemote = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => !closing && event.sender === remote.webContents && event.senderFrame === remote.webContents.mainFrame && (fixture ? event.senderFrame.url === remoteURL : new URL(event.senderFrame.url).origin === 'https://web.whatsapp.com');
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
    try { if (!stickerTransfer.send || stickerTransfer.send.nonce !== request.data.nonce) return false; readSticker(stickerTransfer.send.id); }
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
  ipcMain.handle('companion:status', event => { if (!isLocal(event)) throw new Error('Denied'); return status(); });
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
  ipcMain.handle('companion:action', async (event, raw: unknown) => {
    if (closing || !isLocal(event)) return { ok: false, error: 'Denied' };
    const parsed = actionSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'Invalid setting. Check the value and try again.' };
    const action = parsed.data;
    try {
      if ('scope' in action) requireScope(action.scope);
      switch (action.type) {
        case 'preferences': directStickerSafety.preferences(action.scope, action.patch);
          if (accountSafety) disableDirect(accountSafety);
          assistant.reconfigure(); break;
        case 'resetPreferences': directStickerSafety.reset(action.scope);
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
          remote.webContents.send('companion:command', route === 'maker' ? { type: 'makeSticker', id: ticket.id, nonce: ticket.nonce, target: ticket.target, route, image: stored.image } : { type: 'prepareSticker', id: ticket.id, nonce: ticket.nonce, target: ticket.target, route }); break;
        }
        case 'createStickerGroup':
        case 'renameStickerGroup':
        case 'deleteStickerGroup':
        case 'stickerGroupMembership':
        case 'bulkStickerGroupMembership': store.update(s => applyStickerGroupAction(s, action, randomUUID)); break;
        case 'sticker': store.update(s => { const sticker = s.stickers.find(x => x.id === action.id); if (!sticker) throw new Error('Sticker no longer indexed.'); sticker.searchTerms = action.searchTerms; }); break;
        case 'forgetSticker': store.forgetSticker(action.id); stickerInbox.discard(action.id); if (stickerTransfer.send?.id === action.id) cancelSticker(); stickerBlobErrors.delete(action.id); break;
        case 'locateSticker': {
          stickerTransfer.requireDestination(action.destinationToken, assistant.snapshot);
          readSticker(action.id);
          clearTimeout(locateRequest?.timer);
          const nonce = randomUUID();
          stickerLocation = { id: action.id, state: 'looking' };
          locateRequest = { nonce, destinationToken: action.destinationToken, timer: setTimeout(() => {
            locateRequest = undefined; stickerLocation = { id: action.id, state: 'unavailable' }; publish();
          }, 3000) };
          remote.webContents.send('companion:command', { type: 'locateSticker', id: action.id, nonce }); break;
        }
        case 'panel': openPanel(action.panel); break;
        case 'reload': cancelSticker(); finishMakerInput(); clearStickerShield(); publish(); assistant.suspend(); await remote.webContents.loadURL(remoteURL); break;
        case 'cancelAuto': assistant.activity(); break;
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
            if (ticket) {
              clearTimeout(stickerSendTimer);
              // A lost picker result cannot prove whether activation happened.
              stickerSendTimer = setTimeout(() => { stickerTransfer.result(ticket.nonce, true, false, 'unconfirmed'); stopStickerLookup(); publish(); }, 6000);
              remote.webContents.send('companion:command', { type: 'sendSticker', id: ticket.id, nonce: ticket.nonce, target: ticket.target, expiresAt: Date.now() + 5000 });
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
          if (v.success) { chrome = v.data; layout(); publish(); } break;
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
  const remoteSession = remote.webContents.session;
  installRemotePermissions(remote.webContents, fixture ? remoteURL : undefined, async permission => {
    const result = await dialog.showMessageBox(win, { message: `Allow WhatsApp to use ${permission === 'media' ? 'your microphone or camera' : 'desktop notifications'}?`, buttons: ['Deny', 'Allow'], defaultId: 0, cancelId: 0 });
    return result.response === 1;
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  controls.webContents.session.setPermissionCheckHandler(() => false);
  controls.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  remoteSession.on('will-download', (_event, item) => { item.setSaveDialogOptions({ title: 'Save WhatsApp attachment' }); });
  remote.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) { pickerDiagnostics.cancel(); cancelSticker(); finishMakerInput(); clearStickerShield(); publish(); assistant.suspend(); } });
  controls.webContents.on('render-process-gone', () => { panel = null; panelChat = null; cancelSticker(); finishMakerInput(); clearStickerShield(true); layout(); });
  remote.webContents.on('did-finish-load', () => assistant.refresh(true));
  remote.webContents.on('render-process-gone', () => { pickerDiagnostics.cancel(); cancelSticker(); finishMakerInput(); clearStickerShield(); assistant.suspend(); assistant.message = 'WhatsApp stopped responding. Use Reload WhatsApp to reconnect.'; publish(); });
  remote.webContents.on('did-fail-load', (_event, _code, _description, _url, mainFrame) => { if (mainFrame) { assistant.message = 'WhatsApp could not load. Check your connection and use Reload WhatsApp.'; publish(); } });
  win.on('close', event => {
    cancelSticker(); stopMakerInput(); assistant.cancel(true); publish(); clearStickerShield(true);
    if (!indexDrained) {
      event.preventDefault();
      if (!closing) {
        closing = true;
        void stickerInbox.close().finally(() => { indexDrained = true; win.close(); });
      }
    }
  });
  app.on('before-quit', () => { assistant.cancel(true); providerCheck.invalidate(); modelCatalog.invalidate('openai'); modelCatalog.invalidate('anthropic'); requestCounts.close(); cancelSticker(); stopMakerInput(); publish(); clearStickerShield(true); });
  win.on('closed', () => { pickerDiagnostics.cancel(); stickerTransfer.cancel(); recordStickerSend(); stopMakerInput(); clearTimeout(locateRequest?.timer); clearTimeout(stickerSendTimer); clearTimeout(stickerReadinessTimer); providerCheck.invalidate(); modelCatalog.invalidate('openai'); modelCatalog.invalidate('anthropic'); assistant.cancel(true); remote.webContents.close(); controls.webContents.close(); app.quit(); });
  app.on('second-instance', () => { if (win.isMinimized()) win.restore(); win.focus(); });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Companion', submenu: [{ label: 'AI settings', accelerator: 'CmdOrCtrl+,', click: () => openPanel('settings') }, { label: 'Sticker library', click: () => openPanel('stickers') }, { label: 'Chat AI settings', click: () => openPanel('chat') }, { label: 'Capture sticker picker layout', click: () => pickerDiagnostics.capture() }, { type: 'separator' }, { label: 'Reload WhatsApp', click: () => { cancelSticker(); finishMakerInput(); clearStickerShield(); publish(); assistant.suspend(); void remote.webContents.loadURL(remoteURL); } }, { role: 'quit' }] }, { role: 'editMenu' },
    { label: 'View', submenu: [{ label: 'Reload controls', accelerator: 'CmdOrCtrl+R', click: () => controls.webContents.reload() }, { label: 'Force reload controls', accelerator: 'CmdOrCtrl+Shift+R', click: () => controls.webContents.reloadIgnoringCache() }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] }]));
  await win.loadURL('about:blank');
  await controls.webContents.loadURL(uiURL);
  await remote.webContents.loadURL(remoteURL).catch(() => {});
  publish();
}
