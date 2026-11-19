import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Main-process stubs only; the remote fixture has no desktop API bridge.
export async function runTrayDesktop() {
  const scratch = process.env.COMPANION_TEST_SCRATCH ?? join(homedir(), '.cache/agent-scratch/whatsapp-companion');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'tray-desktop-'));
  let app;
  const launch = async dataDirectory => {
    app = await electron.launch({ chromiumSandbox: true,
      args: [resolve('.'), '--fixture', '--hidden', '--fixture-startup-splash', `--data-dir=${dataDirectory}`], timeout: 30000 });
    await app.evaluate(({ dialog, Tray }) => {
      globalThis.notificationDialogs = [];
      const originalDialog = dialog.showMessageBox;
      dialog.showMessageBox = (win, options) => {
        if (options.message !== 'Allow notifications for new messages?') return originalDialog(win, options);
        globalThis.notificationDialogs.push({ title: options.title, message: options.message, detail: options.detail,
          buttons: options.buttons, defaultId: options.defaultId, cancelId: options.cancelId });
        return new Promise(resolve => {
          globalThis.answerNotificationDialog = response => resolve({ response, checkboxChecked: false });
          options.signal.addEventListener('abort', () => resolve({ response: 0, checkboxChecked: false }), { once: true });
        });
      };
      const setContextMenu = Tray.prototype.setContextMenu;
      Tray.prototype.setContextMenu = function (menu) {
        globalThis.fixtureTray = this; globalThis.fixtureTrayMenu = menu;
        return setContextMenu.call(this, menu);
      };
    });
    await expect.poll(async () => (await app.windows()).some(page => page.url().endsWith('/ui/index.html'))).toBe(true);
    const fixturePage = async () => (await app.windows()).find(page => page.url().split('#')[0].endsWith('/fixture.html'));
    await expect.poll(fixturePage, { timeout: 15000 }).not.toBeUndefined();
    const remote = await fixturePage();
    // A hidden window paints no frames, so poll the DOM rather than Playwright visibility.
    await expect.poll(() => remote.evaluate(() => Boolean(document.querySelector('#pane-side'))), { timeout: 15000 }).toBe(true);
    const records = async () => {
      try { return (await readFile(join(dataDirectory, 'diagnostics/startup.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
      catch { return []; }
    };
    await expect.poll(async () => (await records()).some(record => record.event === 'phase' && record.phase === 'shell')).toBe(true);
    expect((await records()).some(record => record.event === 'tray-created')).toBe(true);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
    return remote;
  };
  const state = async () => {
    try { return JSON.parse(await readFile(join(directory, 'companion.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { desktop: {} }; throw error; }
  };
  const quit = async () => {
    const exited = app.waitForEvent('close');
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const item = Menu.getApplicationMenu().items.find(item => item.label === 'Companion').submenu.items.find(item => item.role === 'quit');
      setImmediate(() => item.click({}, win, win.webContents));
    });
    await exited; app = undefined;
  };
  try {
    let remote = await launch(directory);
    const freshLocal = (await app.windows()).find(page => page.url().endsWith('/ui/index.html'));
    expect((await freshLocal.evaluate(() => window.companion.status())).state.global.aiFeatures).toBe(false);
    expect(await remote.locator('#companion-chat-settings').count()).toBe(0);
    expect(await app.evaluate(() => globalThis.notificationDialogs)).toEqual([]);
    expect(await remote.evaluate(() => Notification.permission)).toBe('denied');
    await app.evaluate(({ app }) => app.emit('second-instance', {}, [], process.cwd()));
    await expect.poll(() => app.evaluate(() => globalThis.notificationDialogs.length)).toBe(1);
    expect(await app.evaluate(() => globalThis.notificationDialogs[0])).toEqual({
      title: 'WhatsApp Companion', message: 'Allow notifications for new messages?',
      detail: 'Closing the window keeps WhatsApp Companion running in the tray.', buttons: ['Deny', 'Allow'], defaultId: 1, cancelId: 0
    });
    await app.evaluate(() => globalThis.answerNotificationDialog(0));
    await expect.poll(async () => (await state()).desktop.notifications).toBe('denied');
    expect(await remote.evaluate(() => Notification.requestPermission())).toBe('denied');
    expect(await app.evaluate(() => globalThis.notificationDialogs.length)).toBe(1);
    console.log('PASS hidden startup waits for show before asking once; Deny is persisted');

    await remote.evaluate(() => { window.notificationReloadSentinel = 'same document'; });
    const toggle = () => app.evaluate(({ BrowserWindow }) => {
      const item = globalThis.fixtureTrayMenu.items.find(item => item.label === 'Notifications');
      const win = BrowserWindow.getAllWindows()[0]; item.click({}, win, win.webContents);
    });
    await toggle();
    await expect.poll(async () => (await state()).desktop.notifications).toBe('allowed');
    expect(await remote.evaluate(async () => ({ permission: Notification.permission,
      query: (await navigator.permissions.query({ name: 'notifications' })).state,
      request: await Notification.requestPermission(), sentinel: window.notificationReloadSentinel }))).toEqual({
      permission: 'granted', query: 'granted', request: 'granted', sentinel: 'same document'
    });
    await toggle();
    expect(await remote.evaluate(() => Notification.permission)).toBe('denied');
    await toggle();
    expect(await app.evaluate(() => globalThis.notificationDialogs.length)).toBe(1);
    console.log('PASS actual tray notification toggles change Notification.permission/query/request in the same document without reload');

    const local = (await app.windows()).find(page => page.url().endsWith('/ui/index.html'));
    const observedChat = () => local.evaluate(async () => (await window.companion.status()).chat);
    await expect.poll(observedChat).toMatchObject({ chatId: '123456@c.us', ready: true });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    expect(await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0], remote = win.contentView.children[0].webContents;
      return { visible: win.isVisible(), remoteAlive: !remote.isDestroyed(), throttled: remote.getBackgroundThrottling() };
    })).toEqual({ visible: false, remoteAlive: true, throttled: false });
    expect(await remote.evaluate(() => window.notificationReloadSentinel)).toBe('same document');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.focus());
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
    // Select another fixture chat without creating an OS notification or sending a message.
    await remote.evaluate(() => document.querySelector('#group').click());
    await expect.poll(observedChat).toMatchObject({ chatId: '999999@g.us', ready: true });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
    console.log('PASS a hidden chat change and main focus leave the window hidden');
    await app.evaluate(() => globalThis.fixtureTray.emit('click'));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await app.evaluate(() => globalThis.fixtureTray.emit('click'));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(false);
    const seed = await state();
    const exited = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => {
      const item = globalThis.fixtureTrayMenu.items.find(item => item.label === 'Quit');
      const win = BrowserWindow.getAllWindows()[0]; setImmediate(() => item.click({}, win, win.webContents));
    });
    await exited; app = undefined;
    console.log('PASS X hides without destroying WhatsApp, tray restores hidden/minimized windows, tray Quit exits');

    remote = await launch(directory);
    expect(await remote.evaluate(() => Notification.permission)).toBe('granted');
    await app.evaluate(({ app }) => app.emit('second-instance', {}, [], process.cwd()));
    expect(await app.evaluate(() => globalThis.notificationDialogs)).toEqual([]);
    await quit();
    console.log('PASS saved Allow survives restart, hidden login launch never asks again, app-menu Quit exits');

    const interrupted = join(directory, 'interrupted');
    await launch(interrupted);
    await app.evaluate(({ app }) => app.emit('second-instance', {}, [], process.cwd()));
    await expect.poll(() => app.evaluate(() => globalThis.notificationDialogs.length)).toBe(1);
    await quit();
    let saved;
    try { saved = JSON.parse(await readFile(join(interrupted, 'companion.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    expect(saved?.desktop?.notifications).toBeUndefined();
    console.log('PASS quitting during the notification dialog leaves the answer unset');
    return { ...seed, desktop: { notifications: 'denied' } };
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
}
