import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'companion-sticker-drag-'));
let app;
try {
  app = await electron.launch({ chromiumSandbox: true, args: [resolve('.'), '--fixture', `--data-dir=${dir}`], timeout: 30000 });
  await expect.poll(async () => (await app.windows()).some(p => p.url().endsWith('/ui/index.html'))).toBe(true);
  const local = (await app.windows()).find(p => p.url().endsWith('/ui/index.html'));
  await expect.poll(async () => (await app.windows()).some(p => p.url().endsWith('/fixture.html'))).toBe(true);
  const remote = (await app.windows()).find(p => p.url().endsWith('/fixture.html'));
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).chat.ready).toBe(true);
  await remote.getByRole('button', { name: 'Load sticker', exact: true }).click();
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).state.stickers.length).toBe(1);
  const editor = remote.locator('[contenteditable=true][role=textbox]'); await editor.fill('Keep this unsent draft');
  await local.evaluate(() => window.companion.action({ type: 'panel', panel: 'stickers' }));
  for (const page of [local,remote]) await page.evaluate(() => { window.dragEvents=[]; for(const name of ['pointerdown','dragstart','dragenter','dragover','drop','dragend']) document.addEventListener(name, event => { if(window.dragEvents.length<30)window.dragEvents.push({type:name,x:event.clientX,y:event.clientY,trust:event.isTrusted,types:event.dataTransfer?[...event.dataTransfer.types]:[]}); },true); });
  const source = local.getByRole('button', { name: /^Edit sticker/ });
  const preview = local.getByRole('dialog', { name: 'Send to Alex', exact: true });
  const picker = remote.locator('[data-testid="expressions-panel"]');
  const pickerTrigger = remote.getByRole('button', { name: 'Emojis, GIFs, Stickers', exact: true });
  const assertPickerFits = async (side = 'left') => {
    await expect.poll(async () => {
      const bounds = await picker.boundingBox();
      const { left, right, width } = await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0], overlay = w.contentView.children[1].getBounds();
        const zoom = w.contentView.children[0].webContents.getZoomFactor();
        return { left: overlay.x / zoom, right: (overlay.x + overlay.width) / zoom, width: w.getContentSize()[0] / zoom };
      });
      const rail = await remote.locator('#pane-side').boundingBox();
      return !!bounds && bounds.width >= 320 && bounds.x >= (side === 'left' ? right : rail.x) + 7 && bounds.x + bounds.width <= (side === 'left' ? width : left) - 7;
    }).toBe(true);
  };
  const drag = async (target = '#main footer') => {
    await source.scrollIntoViewIfNeeded();
    const src = await source.boundingBox(), dst = await remote.locator(target).boundingBox();
    if (process.platform === 'linux') {
      // Genuine OS mouse drag across the separate WebContentsViews, including Chromium's data transfer.
      const g = await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0]; w.focus();
        return { content: w.getContentBounds(), controls: w.contentView.children[1].getBounds() };
      });
      const x = Math.round(g.content.x + g.controls.x + src.x + src.width / 2), y = Math.round(g.content.y + src.y + src.height / 2);
      try {
        await exec('xdotool', ['mousemove', '--sync', String(x), String(y), 'mousedown', '1', 'mousemove', '--sync', String(x + 15), String(y + 5)], { timeout: 5000 });
        await new Promise(r => setTimeout(r, 200));
        await exec('xdotool', ['mousemove', '--sync', String(Math.round(g.content.x + dst.x + dst.width / 2)), String(Math.round(g.content.y + dst.y + dst.height / 2))], { timeout: 5000 });
        await new Promise(r => setTimeout(r, 100));
        await exec('xdotool', ['mousemove', '--sync', String(Math.round(g.content.x + dst.x + dst.width / 2 + 4)), String(Math.round(g.content.y + dst.y + dst.height / 2 + 1))], { timeout: 5000 });
        await new Promise(r => setTimeout(r, 100));
      } finally { await exec('xdotool', ['mouseup', '1'], { timeout: 5000 }); }
    } else {
      // Cross-platform protocol fallback retains a trusted drag source/drop and the actual transferred data.
      const origin = await local.context().newCDPSession(local), destination = await remote.context().newCDPSession(remote);
      await origin.send('Input.setInterceptDrags', { enabled: true });
      const intercepted = new Promise(resolve => origin.once('Input.dragIntercepted', resolve));
      await local.mouse.move(src.x + src.width / 2, src.y + src.height / 2); await local.mouse.down();
      await local.mouse.move(src.x + src.width / 2 + 20, src.y + src.height / 2 + 20);
      const { data } = await intercepted;
      for (const type of ['dragEnter', 'dragOver', 'drop']) await destination.send('Input.dispatchDragEvent', { type, x: dst.x + dst.width / 2, y: dst.y + dst.height / 2, data });
      await local.mouse.up(); await origin.detach(); await destination.detach();
    }
  };
  await drag();
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Send sticker', exact: true })).toBeEnabled({ timeout: 15000 });
  await assertPickerFits();
  expect(await remote.evaluate(() => window.fixtureStickerSent)).toEqual([]);
  await expect(editor).toHaveText('Keep this unsent draft');
  await mkdir('.local/screenshots', { recursive: true });
  await local.screenshot({ path: '.local/screenshots/sticker-drag-preview.png' });
  await local.keyboard.press('Escape');
  await expect(preview).toHaveCount(0); await expect(local.locator('aside')).toBeVisible();
  await expect(picker).toHaveCount(0);
  expect(await remote.evaluate(() => window.fixtureStickerSent)).toEqual([]);
  console.log('PASS real drag across native views previews the original sticker, preserves the draft and Escape cancels');

  await pickerTrigger.click();
  const edge = await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0].contentView.children[1].getBounds(); return b.x + b.width; });
  expect(await picker.evaluate((el, edge) => new Promise(resolve => {
    const start = performance.now(); let fits = true;
    const frame = () => { const r = el.getBoundingClientRect(); fits &&= r.left >= edge + 7 && r.right <= innerWidth - 7;
      if (performance.now() - start < 300) requestAnimationFrame(frame); else resolve(fits); };
    requestAnimationFrame(frame);
  }), edge)).toBe(true);
  await assertPickerFits();
  for (const width of [880, 1500, 1280]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 832), width);
    await assertPickerFits();
  }
  await local.evaluate(() => window.companion.action({ type: 'panel', panel: null }));
  await expect.poll(() => picker.evaluate(el => ({ translate: el.parentElement.style.translate, maxWidth: el.parentElement.style.maxWidth }))).toEqual({ translate: '', maxWidth: '560px' });
  await local.evaluate(() => window.companion.action({ type: 'panel', panel: 'chat' }));
  for (const width of [880, 1100, 1280, 1500, 1280]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 832), width);
    await assertPickerFits('right');
  }
  console.log('PASS right-side chat settings leave the native picker unobscured at narrow and wide widths');
  await local.evaluate(() => window.companion.action({ type: 'panel', panel: 'stickers' }));
  await assertPickerFits();
  await drag(); await expect(preview.getByRole('button', { name: 'Send sticker', exact: true })).toBeEnabled({ timeout: 15000 });
  await preview.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(picker).toBeVisible(); await assertPickerFits();
  await pickerTrigger.click(); await expect(picker).toHaveCount(0);
  expect(await remote.evaluate(() => window.fixtureStickerSent)).toEqual([]);
  console.log('PASS native picker stays beside the library on resize, restores its layout on close and preserves a manually opened picker');

  await drag(); await expect(preview.getByRole('button', { name: 'Send sticker', exact: true })).toBeEnabled({ timeout: 15000 });
  const nonce = await local.evaluate(async () => (await window.companion.status()).stickerPreview.nonce);
  await preview.getByRole('button', { name: 'Send sticker', exact: true }).click();
  await expect.poll(() => remote.evaluate(() => window.fixtureStickerSent.length)).toBe(1);
  expect(await remote.evaluate(() => window.fixtureStickerSent[0])).toEqual(await remote.evaluate(() => ({ source: window.fixtureStickerSource, peer: '123456@c.us' })));
  await expect(editor).toHaveText('Keep this unsent draft');
  await expect(local.getByRole('dialog')).toHaveCount(0);
  await expect(picker).toHaveCount(0);
  const replay = await local.evaluate(nonce => window.companion.action({ type: 'sendSticker', nonce }), nonce);
  expect(replay.ok).toBe(false);
  expect(await remote.evaluate(() => window.fixtureStickerSent.length)).toBe(1);
  expect(await remote.evaluate(() => window.fixtureSent)).toEqual([]);
  console.log('PASS explicit confirmation activates exactly one native sticker, never a media attachment or text Send');

  await drag(); await expect(preview.getByRole('button', { name: 'Send sticker', exact: true })).toBeEnabled({ timeout: 15000 });
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const remote = BrowserWindow.getAllWindows()[0].contentView.children[0].webContents;
    const original = remote.send.bind(remote);
    const result = (_event, message) => { if (message?.type === 'stickerSent' && message.nonce === globalThis.heldSticker?.nonce) globalThis.heldStickerResult = message; };
    ipcMain.on('companion:event', result);
    remote.send = (channel, ...args) => {
      if (channel === 'companion:command' && args[0]?.type === 'sendSticker') { globalThis.heldSticker = args[0]; return; }
      if (channel === 'companion:command' && args[0]?.type === 'cancelSticker' && globalThis.heldSticker) return;
      return original(channel, ...args);
    };
    globalThis.releaseHeldSticker = () => { remote.send = original; original('companion:command', globalThis.heldSticker); };
    globalThis.finishHeldSticker = () => { original('companion:command', { type: 'cancelSticker' }); ipcMain.removeListener('companion:event', result); };
  });
  await preview.getByRole('button', { name: 'Send sticker', exact: true }).click();
  await expect.poll(() => app.evaluate(() => Boolean(globalThis.heldSticker))).toBe(true);
  await preview.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await app.evaluate(() => globalThis.releaseHeldSticker());
  await expect.poll(() => app.evaluate(() => globalThis.heldStickerResult?.clicked)).toBe(false);
  await app.evaluate(() => globalThis.finishHeldSticker());
  expect(await remote.evaluate(() => window.fixtureStickerSent.length)).toBe(1);
  await expect(editor).toHaveText('Keep this unsent draft');
  console.log('PASS cancelled sticker permission rejects a queued native activation even before remote cancellation arrives');

  await drag(); await expect(preview.getByRole('button', { name: 'Send sticker', exact: true })).toBeEnabled({ timeout: 15000 });
  await remote.evaluate(() => document.querySelector('#group').click());
  await expect(local.getByRole('dialog')).toHaveCount(0);
  await expect(picker).toHaveCount(0);
  expect(await remote.evaluate(() => window.fixtureStickerSent.length)).toBe(1);
  console.log('PASS changing chats cancels a pending sticker preview');

  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).chat.ready).toBe(true);
  await drag('#main header');
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).stickerPreview).toBeNull();
  expect(await remote.evaluate(() => ({ node: typeof window.require, bridge: typeof window.companion }))).toEqual({ node: 'undefined', bridge: 'undefined' });
  expect(await remote.evaluate(() => window.fixtureStickerSent.length)).toBe(1);
  console.log('PASS drops outside the conversation body do nothing and the remote page retains no desktop bridge');
} catch (error) {
  if (app) for (const page of await app.windows()) {
    console.log('DRAG',page.url(),await page.evaluate(()=>window.dragEvents));
    if (page.url().includes('/ui/index.html')) console.log('LOCAL', (await page.locator('body').innerText()).slice(0,1500));
  }
  throw error;
} finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
