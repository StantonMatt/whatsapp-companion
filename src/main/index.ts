import { app, BrowserWindow, WebContentsView, ipcMain, session, dialog, shell, Menu } from 'electron';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { actionSchema, snapshotSchema, stickerSchema, stickerImageSchema, providerSchema, panelSchema, type Panel, type Status } from '../shared/model';
import { Store } from './store';
import { Conversations } from './conversations';
import { Vault, promptKey, configuredBackend } from './vault';
import { Assistant } from './assistant';
import { setPreferences, resetPreferences } from '../core/settings';
import { learnStyle } from '../core/style';
import { statusUpdate } from '../core/status';
import { StickerTransfer } from '../core/sticker-transfer';
import { StickerInbox } from './sticker-inbox';
import { ProviderCheck } from './provider-check';
import { ModelCatalog } from './models';
import { currentTextModels, savedEffort, setReasoning } from '../core/model-policy';
import { MAX_STICKER_BYTES } from '../shared/sticker-limits';

// Some AppImage launchers add --no-sandbox automatically. Never allow that
// compatibility fallback to remove protection from the embedded remote page.
app.commandLine.removeSwitch('no-sandbox');
app.enableSandbox();
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
  const vault = new Vault(app.getPath('userData'));
  const providerCheck = new ProviderCheck();
  const modelCatalog = new ModelCatalog();
  const root = __dirname;
  const uiURL = pathToFileURL(join(root, 'ui/index.html')).href;
  const remoteURL = fixture ? pathToFileURL(join(root, 'fixture.html')).href : 'https://web.whatsapp.com/';
  const conversations = new Conversations(store);
  const stickerTransfer = new StickerTransfer();
  let stickerSendTimer: ReturnType<typeof setTimeout> | undefined;
  let panel: Panel = null, panelChat: string | null = null, keyPromptOpen = false;
  let stickerLocation: Status['stickerLocation'] = null;
  let locateRequest: { nonce: string; timer: ReturnType<typeof setTimeout> } | undefined;
  let chrome = { rail: 64, listWidth: 430, theme: 'dark' as 'dark' | 'light' };
  const win = new BrowserWindow({ width: 1280, height: 860, minWidth: 880, minHeight: 620, backgroundColor: '#161717', title: 'WhatsApp Companion',
    icon: join(root, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  const controls = new WebContentsView({ webPreferences: { preload: join(root, 'local.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  const remote = new WebContentsView({ webPreferences: { preload: join(root, 'remote.cjs'), partition: fixture ? 'persist:fixture' : 'persist:whatsapp', contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: true } });
  // WhatsApp rejects Electron-branded user agents despite the current Chromium engine.
  const platform = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  remote.webContents.setUserAgent(`Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`);
  win.contentView.addChildView(remote);
  win.contentView.addChildView(controls);
  controls.setVisible(false);
  let pendingChrome = false;
  const syncChrome = () => {
    if (remote.webContents.isDestroyed()) return;
    const bounds = controls.getBounds(), zoom = remote.webContents.getZoomFactor();
    remote.webContents.send('companion:command', { type: 'chrome', panel, pending: pendingChrome,
      panelBounds: panel ? { left: bounds.x / zoom, right: (bounds.x + bounds.width) / zoom } : null });
  };
  const layout = () => {
    if (win.isDestroyed() || remote.webContents.isDestroyed()) return;
    const { width, height } = win.contentView.getBounds();
    remote.setBounds({ x: 0, y: 0, width, height });
    const rail = Math.min(100, Math.max(0, chrome.rail));
    const panelWidth = Math.min(width - rail, Math.max(380, panel === 'chat' ? 430 : chrome.listWidth));
    controls.setBounds({ x: panel === 'chat' ? width - panelWidth : rail, y: 0, width: panelWidth, height });
    controls.setVisible(panel !== null);
    syncChrome();
  };
  // KDE can emit window resize/maximize before committing the content area's new size.
  // Follow the actual parent view bounds, including maximize, restore and fullscreen.
  win.contentView.on('bounds-changed', layout); layout();
  // The native child view uses device-independent bounds matching the unzoomed settings panel.
  controls.webContents.setZoomMode('disabled');
  controls.webContents.on('did-finish-load', () => controls.webContents.setZoomMode('disabled'));
  void controls.webContents.setVisualZoomLevelLimits(1, 1);
  controls.webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && ['+', '=', '-', '0'].includes(input.key)) event.preventDefault();
  });
  let sequence = 0, lastState: Status['state'] | undefined;
  const status = (): Status => ({ sequence, panel, stickerLocation, stickerPreview: stickerTransfer.preview, theme: chrome.theme, runtimePaused: assistant.isRuntimePaused(), state: store.state, chat: { chatId: assistant.snapshot.chatId, settingsId: assistant.snapshot.settingsId, name: assistant.snapshot.name, kind: assistant.snapshot.kind, ready: assistant.snapshot.ready }, keys: { openai: vault.has('openai'), anthropic: vault.has('anthropic') }, secureStorage: vault.secure(), fixture, message: assistant.message, pending: assistant.pending });
  const publish = () => {
    if (win.isDestroyed() || controls.webContents.isDestroyed()) return;
    sequence++;
    if (panel === 'chat' && panelChat !== assistant.snapshot.settingsId) { panel = null; panelChat = null; layout(); }
    const next = status();
    pendingChrome = Boolean(assistant.pending); syncChrome();
    controls.webContents.send('companion:status', statusUpdate(next, lastState));
    lastState = next.state;
  };
  const assistant = new Assistant(store, vault, { send: command => { if (!remote.webContents.isDestroyed()) remote.webContents.send('companion:command', command); }, focus: () => remote.webContents.focus() }, publish, fixture);
  const cancelSticker = () => { clearTimeout(stickerSendTimer); stickerTransfer.cancel(); if (!remote.webContents.isDestroyed()) remote.webContents.send('companion:command', { type: 'cancelSticker' }); };
  const openPanel = (next: Panel) => {
    cancelSticker();
    if (next === 'chat' && (!assistant.snapshot.ready || !assistant.snapshot.settingsId)) {
      assistant.message = 'Chat settings need recognizable messages. Wait for this conversation to load.';
      remote.webContents.send('companion:command', { type: 'notice', text: assistant.message }); publish(); return;
    }
    panel = next; panelChat = next === 'chat' ? assistant.snapshot.settingsId! : null;
    clearTimeout(locateRequest?.timer); locateRequest = undefined; stickerLocation = null;
    if (panel) assistant.activity();
    layout(); publish();
    if (panel) controls.webContents.focus(); else remote.webContents.focus();
  };
  const requireScope = (scope: string) => {
    if (scope !== 'global' && scope !== 'general' && (scope !== assistant.snapshot.settingsId || !assistant.snapshot.ready)) throw new Error('This conversation changed. Reopen its settings.');
  };
  const providerChanged = () => {
    providerCheck.invalidate(); assistant.reconfigure();
    assistant.message = 'Provider configuration changed. Use Test connection to check account access.';
  };
  controls.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) { cancelSticker(); panel = null; panelChat = null; layout(); assistant.activity(); }
  });
  const stickerInbox = new StickerInbox(store, publish, () => { assistant.message = 'Sticker indexing could not be saved. Check disk space, then reload WhatsApp to retry.'; publish(); });
  const isLocal = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => event.sender === controls.webContents && event.senderFrame === controls.webContents.mainFrame && event.senderFrame.url === uiURL;
  const isRemote = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => event.sender === remote.webContents && event.senderFrame === remote.webContents.mainFrame && (fixture ? event.senderFrame.url === remoteURL : new URL(event.senderFrame.url).origin === 'https://web.whatsapp.com');
  ipcMain.handle('companion:authorize-auto', (event, raw: unknown) => {
    if (!isRemote(event)) return false;
    const nonce = z.string().uuid().safeParse(raw);
    return nonce.success && assistant.authorizeAutomatic(nonce.data);
  });
  ipcMain.handle('companion:authorize-sticker', (event, raw: unknown) => {
    if (!isRemote(event)) return false;
    const nonce = z.string().uuid().safeParse(raw);
    return nonce.success && stickerTransfer.authorize(nonce.data, assistant.snapshot);
  });
  ipcMain.handle('companion:status', event => { if (!isLocal(event)) throw new Error('Denied'); return status(); });
  ipcMain.handle('companion:models', (event, raw: unknown) => {
    if (!isLocal(event)) return { models: [], error: 'Denied' };
    const parsed = providerSchema.safeParse(raw);
    if (!parsed.success) return { models: [], error: 'Invalid provider.' };
    const provider = parsed.data;
    if (fixture) return { models: currentTextModels(provider, (provider === 'openai'
      ? ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-luna-2026-05-18', 'gpt-4o', 'text-embedding-3-small', 'gpt-audio']
      : ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-6']).map(id => ({ id, name: id }))) };
    try { return modelCatalog.load(provider, vault.get(provider)); }
    catch (error) { return { models: [], error: error instanceof Error ? error.message : 'Unable to unlock the provider key.' }; }
  });
  ipcMain.handle('companion:action', async (event, raw: unknown) => {
    if (!isLocal(event)) return { ok: false, error: 'Denied' };
    const parsed = actionSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'Invalid setting. Check the value and try again.' };
    const action = parsed.data;
    try {
      if ('scope' in action) requireScope(action.scope);
      switch (action.type) {
        case 'preferences': store.update(s => setPreferences(s, action.scope, action.patch)); assistant.reconfigure(); break;
        case 'resetPreferences': store.update(s => resetPreferences(s, action.scope)); assistant.reconfigure(); break;
        case 'provider': store.update(s => { s.provider = action.provider; s.models[action.provider] = action.model; }); providerChanged(); break;
        case 'reasoning': store.update(s => setReasoning(s, action.provider, action.model, action.effort)); providerChanged(); break;
        case 'key': {
          if (keyPromptOpen) throw new Error('A key entry dialog is already open.');
          keyPromptOpen = true;
          try { vault.set(action.provider, await promptKey(action.provider), action.persist); modelCatalog.invalidate(action.provider); providerChanged(); assistant.message = 'API key configured. Use Test connection to check account access.'; }
          finally { keyPromptOpen = false; }
          break;
        }
        case 'deleteKey': vault.remove(action.provider); modelCatalog.invalidate(action.provider); providerChanged(); break;
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
          if (action.scope !== 'general' && action.scope !== assistant.snapshot.settingsId) throw new Error('Open this conversation to learn its style.');
          const examples = action.examples.trim() ? action.examples.split('\n') : assistant.snapshot.messages.filter(m => m.outgoing).map(m => m.text);
          const profile = learnStyle(examples, 'selected');
          if (!profile) throw new Error('At least five sent messages or selected examples are needed. Add one example per line. Sparse conversations can use your general profile.');
          store.update(s => { s.profiles[action.scope] = profile; }); assistant.reconfigure(); break;
        }
        case 'resetProfile': store.update(s => { delete s.profiles[action.scope]; if (action.scope !== 'general') setPreferences(s, action.scope, { learnFromSent: false }); }); assistant.reconfigure(); break;
        case 'beginStickerDrag': {
          if (panel !== 'stickers' || !store.state.stickers.some(s => s.id === action.id)) throw new Error('Open the sticker library and choose an indexed sticker.');
          const ticket = stickerTransfer.begin(action.id, action.nonce, assistant.snapshot);
          remote.webContents.send('companion:command', { type: 'armStickerDrag', id: ticket.id, nonce: ticket.nonce, target: ticket.target }); break;
        }
        case 'cancelSticker': cancelSticker(); break;
        case 'sendSticker': {
          const ticket = stickerTransfer.confirm(action.nonce, assistant.snapshot);
          clearTimeout(stickerSendTimer);
          stickerSendTimer = setTimeout(() => { stickerTransfer.result(ticket.nonce, false); remote.webContents.send('companion:command', { type: 'cancelSticker' }); publish(); }, 6000);
          remote.webContents.send('companion:command', { type: 'sendSticker', id: ticket.id, nonce: ticket.nonce, target: ticket.target, expiresAt: Date.now() + 5000 }); break;
        }
        case 'sticker': store.update(s => { const sticker = s.stickers.find(x => x.id === action.id); if (!sticker) throw new Error('Sticker no longer indexed.'); sticker.searchTerms = action.searchTerms; }); break;
        case 'forgetSticker': stickerInbox.discard(action.id); store.update(s => { s.stickers = s.stickers.filter(x => x.id !== action.id); }); break;
        case 'locateSticker': {
          if (!store.state.stickers.some(s => s.id === action.id)) throw new Error('Sticker no longer indexed.');
          clearTimeout(locateRequest?.timer);
          const nonce = randomUUID();
          stickerLocation = { id: action.id, state: 'looking' };
          locateRequest = { nonce, timer: setTimeout(() => {
            locateRequest = undefined; stickerLocation = { id: action.id, state: 'unavailable' }; publish();
          }, 3000) };
          remote.webContents.send('companion:command', { ...action, nonce }); break;
        }
        case 'panel': openPanel(action.panel); break;
        case 'reload': assistant.reconfigure(); await remote.webContents.loadURL(remoteURL); break;
        case 'cancelAuto': assistant.activity(); break;
      }
      publish(); return { ok: true };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Operation failed. Your previous data is preserved.' }; }
  });
  ipcMain.on('companion:event', (event, raw: unknown) => {
    if (!isRemote(event)) return;
    const envelope = z.object({ type: z.string() }).passthrough().safeParse(raw);
    if (!envelope.success) return;
    try {
      switch (envelope.data.type) {
        case 'stickerDrop': {
          const v = z.object({ type: z.literal('stickerDrop'), nonce: z.string().uuid() }).strict().safeParse(raw);
          if (v.success && panel === 'stickers') {
            const ticket = stickerTransfer.drop(v.data.nonce, assistant.snapshot);
            if (ticket) { assistant.activity(); remote.webContents.send('companion:command', { type: 'prepareSticker', id: ticket.id, nonce: ticket.nonce, target: ticket.target }); publish(); controls.webContents.focus(); }
          } break;
        }
        case 'stickerPrepared': {
          const v = z.object({ type: z.literal('stickerPrepared'), nonce: z.string().uuid(), found: z.boolean() }).strict().safeParse(raw);
          if (v.success) { stickerTransfer.prepared(v.data.nonce, v.data.found, assistant.snapshot); publish(); } break;
        }
        case 'stickerSent': {
          const v = z.object({ type: z.literal('stickerSent'), nonce: z.string().uuid(), clicked: z.boolean() }).strict().safeParse(raw);
          if (v.success) { if (stickerTransfer.preview?.nonce === v.data.nonce) clearTimeout(stickerSendTimer); stickerTransfer.result(v.data.nonce, v.data.clicked); publish(); } break;
        }
        case 'stickerLocated': {
          const v = z.object({ type: z.literal('stickerLocated'), nonce: z.string().uuid(), found: z.boolean() }).strict().safeParse(raw);
          if (v.success && locateRequest?.nonce === v.data.nonce && stickerLocation) {
            clearTimeout(locateRequest.timer); locateRequest = undefined;
            stickerLocation = { id: stickerLocation.id, state: v.data.found ? 'found' : 'missing' }; publish();
          } break;
        }
        case 'snapshot': {
          const s = snapshotSchema.safeParse(envelope.data.snapshot);
          if (s.success) {
            let settingsId: string | null;
            try { settingsId = conversations.identify(s.data); }
            catch (error) { assistant.receive({ ...s.data, settingsId: null, ready: false }); throw error; }
            const snapshot = { ...s.data, settingsId };
            if (stickerTransfer.observe(snapshot)) cancelSticker();
            assistant.receive(snapshot);
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
        case 'dismiss': assistant.dismiss(); break;
        case 'request': { const v = z.object({ type: z.literal('request'), instruction: z.string().max(1000).optional() }).strict().safeParse(raw); if (v.success) void assistant.request(v.data.instruction); break; }
        case 'result': { const v = z.object({ type: z.literal('result'), nonce: z.string().uuid(), sent: z.boolean() }).strict().safeParse(raw); if (v.success) assistant.result(v.data.nonce, v.data.sent); break; }
        case 'sticker': {
          const v = z.object({ type: z.literal('sticker'), image: stickerImageSchema }).strict().safeParse(raw);
          if (!v.success) break;
          const bytes = Buffer.from(v.data.image.split(',')[1], 'base64');
          if (bytes.length > MAX_STICKER_BYTES || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') break;
          const id = createHash('sha256').update(bytes).digest('hex');
          const existing = store.state.stickers.find(x => x.id === id);
          if (existing && Date.now() - existing.lastSeen < 60000) break;
          const sticker = stickerSchema.parse({ id, image: v.data.image, searchTerms: '', firstSeen: Date.now(), lastSeen: Date.now() });
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
  const grantedPermissions = new Set<string>();
  remoteSession.setPermissionCheckHandler((_wc, permission, origin) => origin === 'https://web.whatsapp.com' && grantedPermissions.has(permission));
  remoteSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (wc !== remote.webContents || !details.isMainFrame || !details.requestingUrl.startsWith('https://web.whatsapp.com/')) { callback(false); return; }
    if (!['notifications', 'media'].includes(permission)) { callback(false); return; }
    if (grantedPermissions.has(permission)) { callback(true); return; }
    void dialog.showMessageBox(win, { message: `Allow WhatsApp to use ${permission === 'media' ? 'your microphone or camera' : 'desktop notifications'}?`, buttons: ['Deny', 'Allow'], defaultId: 0, cancelId: 0 }).then(r => { if (r.response === 1) grantedPermissions.add(permission); callback(r.response === 1); });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  remoteSession.on('will-download', (_event, item) => { item.setSaveDialogOptions({ title: 'Save WhatsApp attachment' }); });
  remote.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) { cancelSticker(); assistant.reconfigure(); } });
  remote.webContents.on('render-process-gone', () => { cancelSticker(); assistant.reconfigure(); assistant.message = 'WhatsApp stopped responding. Use Reload WhatsApp to reconnect.'; publish(); });
  remote.webContents.on('did-fail-load', (_event, _code, _description, _url, mainFrame) => { if (mainFrame) { assistant.message = 'WhatsApp could not load. Check your connection and use Reload WhatsApp.'; publish(); } });
  win.on('closed', () => { clearTimeout(locateRequest?.timer); clearTimeout(stickerSendTimer); providerCheck.invalidate(); modelCatalog.invalidate('openai'); modelCatalog.invalidate('anthropic'); assistant.cancel(); stickerInbox.flush(); remote.webContents.close(); controls.webContents.close(); app.quit(); });
  app.on('second-instance', () => { if (win.isMinimized()) win.restore(); win.focus(); });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Companion', submenu: [{ label: 'AI settings', accelerator: 'CmdOrCtrl+,', click: () => openPanel('settings') }, { label: 'Sticker library', click: () => openPanel('stickers') }, { label: 'Chat AI settings', click: () => openPanel('chat') }, { type: 'separator' }, { label: 'Reload WhatsApp', click: () => { assistant.reconfigure(); void remote.webContents.loadURL(remoteURL); } }, { role: 'quit' }] }, { role: 'editMenu' },
    { label: 'View', submenu: [{ label: 'Reload controls', accelerator: 'CmdOrCtrl+R', click: () => controls.webContents.reload() }, { label: 'Force reload controls', accelerator: 'CmdOrCtrl+Shift+R', click: () => controls.webContents.reloadIgnoringCache() }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] }]));
  await win.loadURL('about:blank');
  await controls.webContents.loadURL(uiURL);
  await remote.webContents.loadURL(remoteURL).catch(() => {});
  publish();
}
