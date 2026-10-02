import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'companion-desktop-'));
await mkdir('.local/screenshots', { recursive: true });
let app;
try {
  app = await electron.launch({ chromiumSandbox: true, args: [resolve('.'), '--fixture', `--data-dir=${dir}`], timeout: 30000, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
  await expect.poll(async () => (await app.windows()).some(p => p.url().endsWith('/ui/index.html'))).toBe(true);
  const local = (await app.windows()).find(p => p.url().endsWith('/ui/index.html'));
  const remote = await expect.poll(async () => (await app.windows()).find(p => p.url().endsWith('fixture.html'))).not.toBeUndefined().then(async () => (await app.windows()).find(p => p.url().endsWith('fixture.html')));
  const clickAssistant = async (name) => {
    // Closed shadow roots remain discoverable to accessibility tools. Click the
    // actual button with trusted pointer input rather than invoking its handler.
    const session = await remote.context().newCDPSession(remote);
    try {
      let node;
      await expect.poll(async () => { node = (await session.send('Accessibility.getFullAXTree')).nodes.find(n => n.role?.value === 'button' && n.name?.value === name); return !!node; }).toBe(true);
      const { model } = await session.send('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId });
      await remote.mouse.click((model.border[0] + model.border[4]) / 2, (model.border[1] + model.border[5]) / 2);
    } finally { await session.detach(); }
  };
  const assistantUi = async () => {
    const session = await remote.context().newCDPSession(remote);
    try {
      const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
      const nodes = [];
      const visit = node => { nodes.push(node); for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) visit(child); };
      visit(root);
      const classes = node => { const index = node.attributes?.indexOf('class'); return index >= 0 ? node.attributes[index + 1].split(' ') : []; };
      const text = node => node ? node.nodeValue + (node.children ?? []).map(text).join('') : '';
      const ghost = nodes.find(node => classes(node).includes('ghost'));
      const popup = nodes.find(node => classes(node).includes('popup'));
      return { ghost: text(ghost), popupHidden: popup?.attributes?.includes('hidden') };
    } finally { await session.detach(); }
  };
  const openPanel = async (panel, page = remote) => {
    // Closing a native view crosses IPC; wait before toggling the same panel again.
    await expect.poll(async () => (await local.evaluate(() => window.companion.status())).panel).not.toBe(panel);
    if (panel === 'chat') {
      await expect(page.locator('#companion-chat-settings')).toBeVisible();
      await page.locator('#companion-chat-settings').click();
    } else {
      const session = await page.context().newCDPSession(page);
      try {
        const name = panel === 'stickers' ? 'Sticker library' : 'AI settings';
        let nodes;
        await expect.poll(async () => {
          nodes = (await session.send('Accessibility.getFullAXTree')).nodes.filter(n => n.role?.value === 'button' && n.name?.value === name);
          return nodes.length;
        }).toBe(1);
        const { object } = await session.send('DOM.resolveNode', { backendNodeId: nodes[0].backendDOMNodeId });
        let sample;
        // Both buttons retarget to the same closed-shadow host. Identify the
        // actual button, and wait for the connector to catch up with the current
        // Media anchor after resize, then observe three stable animation frames.
        await expect.poll(async () => {
          const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', {
            objectId: object.objectId, awaitPromise: true, returnByValue: true,
            arguments: [{ value: panel === 'stickers' ? 88 : 44 }],
            functionDeclaration: (async function (offset) {
              let previous;
              for (let frame = 0; frame < 3; frame++) {
                await new Promise(resolve => requestAnimationFrame(resolve));
                const rect = this.getBoundingClientRect();
                const anchor = document.querySelector('[data-navbar-item][aria-label="Media"]')?.getBoundingClientRect();
                const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                const root = this.getRootNode();
                const hit = root.elementFromPoint(point.x, point.y)?.closest('button');
                const geometry = JSON.stringify([rect.left, rect.top, rect.width, rect.height, innerWidth, innerHeight, anchor?.left, anchor?.top]);
                if (!this.isConnected || !rect.width || !rect.height || !anchor || rect.left !== anchor.left || rect.top !== anchor.top - offset ||
                    document.elementFromPoint(point.x, point.y) !== root.host || hit !== this || (previous && previous !== geometry)) return { ready: false, geometry };
                previous = geometry;
                if (frame === 2) return { ready: true, point };
              }
            }).toString()
          });
          if (exceptionDetails) throw new Error(exceptionDetails.text);
          sample = result.value;
          return sample;
        }).toMatchObject({ ready: true });
        await page.mouse.click(sample.point.x, sample.point.y);
      } finally { await session.detach(); }
    }
    await expect.poll(async () => (await local.evaluate(() => window.companion.status())).panel).toBe(panel);
    await expect(local.locator('aside')).toHaveAttribute('aria-label', panel === 'chat' ? 'Chat AI settings' : panel === 'stickers' ? 'Sticker library' : 'AI settings');
  };
  const section = async (name) => {
    const back = local.getByLabel('Back to settings');
    if (await back.count()) await back.click();
    await local.getByRole('button', { name, exact: true }).click();
  };
  const statusText = local.getByTestId('assistant-status');
  const geometry = () => app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return { size: win.getContentSize(), bounds: win.contentView.children[0].getBounds(), controls: win.contentView.children[1].getBounds(), zoom: win.contentView.children[1].webContents.getZoomFactor() };
  });
  const viewRoles = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === 'View').submenu.items.map(item => item.role));
  expect(viewRoles).not.toContain('zoomin'); expect(viewRoles).not.toContain('zoomout');
  const originalSize = (await geometry()).size;
  for (const panelOpen of [false, true]) {
    if (panelOpen) await openPanel('settings');
    for (const size of [[1000, 700], [1240, 850], originalSize]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), size);
      await expect.poll(async () => { const g = await geometry(); return { size: g.size, bounds: g.bounds }; }).toEqual({ size, bounds: { x: 0, y: 0, width: size[0], height: size[1] } });
      await expect.poll(() => remote.evaluate(() => [innerWidth, innerHeight])).toEqual(size);
      if (panelOpen) await expect.poll(() => local.locator('aside').evaluate(el => el.getBoundingClientRect().height)).toBe(size[1]);
      expect(await local.locator('.toolbar').count()).toBe(0);
    }
    if (panelOpen) await local.getByLabel('Close panel').click();
    console.log(`PASS native WhatsApp fills the window on resize ${panelOpen ? 'with settings overlay' : 'without a panel'}`);
  }
  for (const panel of ['settings', 'stickers']) {
    await openPanel(panel);
    const before = await geometry(); expect(before.bounds.width).toBe(before.size[0]);
    expect(before.controls.x).toBe(64); expect(before.controls.y).toBe(0);
    await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].contentView.children[1].webContents; wc.focus();
      for (const keyCode of ['+', '-', '0']) { wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['control'] }); wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['control'] }); }
      wc.setZoomFactor(1.25);
    });
    expect((await geometry()).zoom).toBe(1); expect(await geometry()).toEqual(before);
    await Promise.all([local.waitForEvent('load'), app.evaluate(({ BrowserWindow, Menu }) => {
      const win = BrowserWindow.getAllWindows()[0];
      Menu.getApplicationMenu().items.find(item => item.label === 'View').submenu.items.find(item => item.label === 'Reload controls').click({}, win, win.webContents);
    })]);
    await expect(local.locator('aside')).toBeHidden();
    await openPanel(panel); await local.getByLabel('Close panel').click();
    console.log(`PASS ${panel} sidebar navigation, zoom and renderer reload`);
  }
  await openPanel('settings');
  await section('Replies');
  const lengthPicker = local.getByRole('combobox', { name: /^Reply length/ });
  await lengthPicker.click();
  await expect(local.getByRole('option', { name: 'Balanced', exact: true })).toBeVisible();
  const pickerFits = () => lengthPicker.locator('option').evaluateAll(options => options.every(option => {
    const rect = option.getBoundingClientRect();
    return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
  }));
  expect(await pickerFits()).toBe(true);
  await local.screenshot({ path: '.local/screenshots/dropdown-dark.png' });
  await local.keyboard.press('ArrowDown'); await local.keyboard.press('Enter');
  await expect(lengthPicker).toHaveValue('balanced');
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).state.global.length).toBe('balanced');
  await lengthPicker.click(); await local.keyboard.press('d'); await local.keyboard.press('Enter');
  await expect(lengthPicker).toHaveValue('detailed');
  await lengthPicker.click(); await local.getByRole('option', { name: 'Brief', exact: true }).click();
  await expect(lengthPicker).toHaveValue('brief');
  console.log('PASS themed dropdown supports pointer, arrows, type-ahead and saved selection');
  await lengthPicker.click(); await local.keyboard.press('Escape');
  await expect(lengthPicker).toBeFocused();
  expect(await lengthPicker.evaluate(e => e.matches(':open'))).toBe(false);
  await expect(local.locator('aside')).toBeVisible();
  await lengthPicker.click(); await local.getByRole('heading', { name: 'Replies', exact: true }).click();
  expect(await lengthPicker.evaluate(e => e.matches(':open'))).toBe(false);
  await expect(lengthPicker).toHaveValue('brief');
  await local.evaluate(() => document.documentElement.dataset.theme = 'light');
  await lengthPicker.click();
  expect(await pickerFits()).toBe(true);
  await local.screenshot({ path: '.local/screenshots/dropdown-light.png' });
  await local.keyboard.press('Escape');
  await local.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await local.keyboard.press('Escape');
  await expect(local.locator('aside')).toBeHidden();
  console.log('PASS dropdown Escape/outside-click dismissal, panel Escape and light/dark menus');
  await openPanel('settings');
  await section('Providers');
  const model = local.getByRole('combobox', { name: 'Model ID', exact: true });
  await expect(model).toBeEnabled();
  expect(await model.locator('option').evaluateAll(options => options.map(option => option.value))).toEqual(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna']);
  const effort = local.getByRole('slider', { name: 'Reasoning effort', exact: true });
  await expect(effort).toHaveAttribute('aria-valuetext', 'None');
  await effort.focus(); await effort.press('ArrowRight'); await effort.press('ArrowRight');
  await expect(effort).toHaveAttribute('aria-valuetext', 'Medium');
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).state.reasoning.openai['gpt-6-luna']).toBe('medium');
  await model.selectOption('gpt-6-astra');
  await expect(effort).toHaveAttribute('aria-valuetext', 'Low');
  await expect(effort).toHaveAttribute('max', '4');
  const sliderBounds = await effort.boundingBox();
  await local.mouse.click(sliderBounds.x + sliderBounds.width - 3, sliderBounds.y + sliderBounds.height / 2);
  await expect(effort).toHaveAttribute('aria-valuetext', 'Max');
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).state.reasoning.openai['gpt-6-astra']).toBe('max');
  expect(await local.evaluate(() => window.companion.action({ type: 'reasoning', provider: 'openai', model: 'gpt-6-astra', effort: 'none' }))).toMatchObject({ ok: false });
  await model.selectOption('gpt-6-luna');
  await expect(effort).toHaveAttribute('aria-valuetext', 'Medium');
  await effort.press('Home');
  await expect(effort).toHaveAttribute('aria-valuetext', 'None');
  await model.selectOption('gpt-6-astra');
  await expect(effort).toHaveAttribute('aria-valuetext', 'Max');
  await model.selectOption('gpt-6.1-sol');
  await expect(effort).toHaveAttribute('aria-valuetext', 'Low'); await expect(effort).toHaveAttribute('max', '4');
  await effort.press('End'); await expect(effort).toHaveAttribute('aria-valuetext', 'Max');
  expect(await local.evaluate(() => window.companion.action({ type: 'reasoning', provider: 'openai', model: 'gpt-6.1-sol', effort: 'none' }))).toMatchObject({ ok: false });
  await model.selectOption('gpt-6-sol'); await expect(effort).toHaveAttribute('aria-valuetext', 'None');
  await model.selectOption('gpt-6.1-sol'); await expect(effort).toHaveAttribute('aria-valuetext', 'Max');
  await model.selectOption('gpt-6-astra');
  console.log('PASS Sol 6.1 is available with Low-to-Max reasoning and independent saved settings');
  console.log('PASS reasoning slider supports pointer and keyboard, validates levels and remembers each model');
  await local.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('anthropic');
  await expect(model).toBeEnabled();
  expect(await model.locator('option').evaluateAll(options => options.map(option => option.value))).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001']);
  await expect(effort).toHaveAttribute('aria-valuetext', 'Low');
  await model.selectOption('claude-haiku-4-5-20251001');
  await expect(effort).toHaveCount(0);
  await expect(local.getByText('Reasoning effort is not adjustable for this model.')).toBeVisible();
  await model.selectOption('claude-opus-5-5');
  await local.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('openai');
  await expect(model).toHaveValue('gpt-6-astra');
  await expect(model).toBeEnabled();
  await local.getByRole('button', { name: 'Refresh models', exact: true }).click();
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue('gpt-6-astra');
  expect(await local.evaluate(() => window.companion.models('invalid'))).toEqual({ models: [], error: 'Invalid provider.' });
  await local.screenshot({ path: '.local/screenshots/provider-models.png' });
  console.log('PASS provider dropdown lists current text models only, refreshes and preserves independent selections');
  await local.evaluate(() => window.companion.action({ type: 'provider', provider: 'openai', model: 'gpt-4o' }));
  await expect(model).toHaveValue('');
  await expect(model.locator('option[value="gpt-4o"]')).toHaveCount(0);
  await expect(local.getByText('Saved model: gpt-4o. Choose a listed model to update it.')).toBeVisible();
  expect((await local.evaluate(() => window.companion.status())).state.models.openai).toBe('gpt-4o');
  await model.selectOption('gpt-6-astra');
  console.log('PASS legacy saved models stay out of the dropdown without silently changing configuration');
  await app.evaluate(({ ipcMain }) => {
    globalThis.modelListMode = 'error';
    ipcMain.removeHandler('companion:models');
    ipcMain.handle('companion:models', (_event, provider) => {
      if (globalThis.modelListMode === 'error') return { models: [], error: 'Models (403): This key cannot list models. Allow read access to Models.' };
      if (globalThis.modelListMode === 'pending' && provider === 'openai') return new Promise(resolve => { globalThis.finishModelList = resolve; });
      return { models: [{ id: provider === 'openai' ? 'gpt-6-luna' : 'claude-sonnet-5-5', name: provider === 'openai' ? 'gpt-6-luna' : 'Claude Sonnet 5.5' }] };
    });
  });
  await local.getByRole('button', { name: 'Refresh models', exact: true }).click();
  await expect(local.getByRole('alert')).toContainText('read access to Models');
  await expect(model).toHaveValue('gpt-6-astra');
  await expect(model).toBeDisabled();
  await app.evaluate(() => { globalThis.modelListMode = 'success'; });
  await local.getByRole('button', { name: 'Refresh models', exact: true }).click();
  await expect(model).toBeEnabled();
  await expect(local.getByRole('alert')).toHaveCount(0);
  await expect(model).toHaveValue('');
  await expect(model.locator('option:checked')).toHaveText('Choose a current text model');
  expect((await local.evaluate(() => window.companion.status())).state.models.openai).toBe('gpt-6-astra');
  console.log('PASS model-list permission failures can retry without replacing the saved model');
  await app.evaluate(() => { globalThis.modelListMode = 'pending'; });
  await local.getByRole('button', { name: 'Refresh models', exact: true }).click();
  await expect(model).toBeDisabled();
  await expect.poll(() => app.evaluate(() => typeof globalThis.finishModelList)).toBe('function');
  await local.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('anthropic');
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue('');
  expect((await local.evaluate(() => window.companion.status())).state.models.anthropic).toBe('claude-opus-5-5');
  await app.evaluate(() => { globalThis.finishModelList({ models: [{ id: 'stale-openai-model', name: 'stale-openai-model' }] }); globalThis.modelListMode = 'success'; });
  await local.waitForTimeout(150); // Let the previous provider's resolved IPC result reach React.
  await expect(model.locator('option')).toHaveCount(2);
  await expect(model.locator('option[value="claude-sonnet-5-5"]')).toHaveText('Claude Sonnet 5.5');
  await expect(model.locator('option[value="stale-openai-model"]')).toHaveCount(0);
  await model.selectOption('claude-sonnet-5-5');
  await local.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('openai');
  await expect(model).toBeEnabled();
  await model.selectOption('gpt-6-luna');
  console.log('PASS late model results from the previous provider cannot replace the current dropdown');
  await section('Replies');
  await local.getByLabel('Close panel').click();
  const emptyComposer = remote.getByRole('textbox', { name: 'Type a message' });
  const emptyBounds = await emptyComposer.boundingBox();
  await remote.mouse.click(emptyBounds.x + emptyBounds.width - 17, emptyBounds.y - 16);
  await remote.keyboard.press('Enter');
  const accessibility = await remote.context().newCDPSession(remote);
  await expect.poll(async () => (await accessibility.send('Accessibility.getFullAXTree')).nodes.some(node => node.name?.value?.includes('Enable conversation context in AI settings'))).toBe(true);
  await accessibility.detach();
  await remote.screenshot({ path: '.local/screenshots/context-consent-notice.png' });
  console.log('PASS manual Suggest without context consent displays a visible composer explanation');
  await emptyComposer.click(); await openPanel('settings'); await section('Replies');
  await local.getByLabel('Share recent conversation context').click();
  await expect(local.getByLabel('Share recent conversation context')).toBeChecked();
  await local.getByLabel('Inline suggestions', { exact: false }).click();
  await expect(local.getByLabel('Inline suggestions', { exact: false })).toBeChecked();
  await local.getByLabel('Close panel').click();
  const editor = remote.getByRole('textbox', { name: 'Type a message' });
  await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  expect(await editor.evaluate(el => el.ownerDocument.hasFocus() && el.ownerDocument.activeElement === el)).toBe(false);
  console.log('PASS empty composer prepares a suggestion before it receives focus');
  await local.evaluate(() => { window.fixtureSuggestionStatuses = []; window.companion.subscribe(s => window.fixtureSuggestionStatuses.push(s.message)); });
  await editor.click();
  await openPanel('settings');
  await section('Replies');
  await local.getByLabel('Language', { exact: false }).focus();
  await remote.waitForTimeout(400);
  await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  await local.getByLabel('Close panel').click();
  await editor.click(); await editor.click();
  await remote.waitForTimeout(500); // Covers the connector poll; it must retain, not regenerate.
  expect(await local.evaluate(() => window.fixtureSuggestionStatuses.some(s => s === 'Thinking…'))).toBe(false);
  await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  await remote.screenshot({ path: '.local/screenshots/refocused-suggestion.png' });
  await editor.press('Tab');
  await expect(editor).toHaveText('Sounds good, see you then!');
  expect(await remote.evaluate(() => window.fixtureSent)).toEqual([]);
  console.log('PASS empty composer Tab accepts without sending');
  console.log('PASS panel clicks and refocusing retain the same suggestion for immediate Tab acceptance');
  await editor.fill('');
  await remote.evaluate(() => window.add('I will let you know.', true));
  await editor.click();
  await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  await editor.press('Tab'); await expect(editor).toHaveText('Sounds good, see you then!');
  expect(await remote.evaluate(() => window.fixtureSent)).toEqual([]);
  console.log('PASS empty composer suggests after the owner sent the latest message');
  await editor.fill(''); await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  let starBounds = await editor.boundingBox();
  await remote.mouse.click(starBounds.x + starBounds.width - 17, starBounds.y - 16);
  await remote.screenshot({ path: '.local/screenshots/refine-suggestion-menu.png' });
  await clickAssistant('Shorter');
  await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  await expect(editor).toHaveText('');
  await expect.poll(assistantUi).toEqual({ ghost: 'That sounds lovely. See you then!', popupHidden: true });
  await remote.screenshot({ path: '.local/screenshots/refine-suggestion-inline.png' });
  await editor.click(); await editor.press('Tab');
  await expect(editor).toHaveText('That sounds lovely. See you then!');
  expect(await remote.evaluate(() => window.fixtureSent)).toEqual([]);
  console.log('PASS star updates ghost text inline with no result popup; Tab inserts without sending');
  await editor.fill('Translate this written message');
  starBounds = await editor.boundingBox(); await remote.mouse.click(starBounds.x + starBounds.width - 17, starBounds.y - 16);
  await clickAssistant('Translate…'); await remote.keyboard.type('Spanish'); await remote.keyboard.press('Enter');
  await expect(editor).toHaveText('That sounds lovely. See you then!');
  expect(await remote.evaluate(() => window.fixtureSent)).toEqual([]);
  console.log('PASS translation replaces the written draft directly without sending');
  await editor.fill('Keep this text while cancelling');
  starBounds = await editor.boundingBox(); await remote.mouse.click(starBounds.x + starBounds.width - 17, starBounds.y - 16);
  await clickAssistant('Warmer'); await expect(statusText).toHaveText('Thinking…'); await remote.keyboard.press('Escape');
  await remote.waitForTimeout(400);
  await expect(editor).toHaveText('Keep this text while cancelling');
  await expect(statusText).not.toHaveText('Tab to accept · Esc to dismiss');
  expect(await remote.evaluate(() => window.fixtureSent)).toEqual([]);
  console.log('PASS Escape cancels pending refinement without a late preview or draft changes');
  await editor.fill('Thanks,');
  await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  await openPanel('settings');
  await local.getByLabel('Close panel').click();
  await editor.click();
  await editor.press('Tab');
  await expect(editor).toHaveText('Thanks, see you then!');
  console.log('PASS partial draft continuation');
  console.log('PASS partial continuation survives refocusing and appends without replacing the draft');
  await editor.fill('Editing a longer draft'); await editor.press('Home');
  await expect(statusText).not.toHaveText('Tab to accept · Esc to dismiss');
  await remote.waitForTimeout(1500);
  await expect(statusText).not.toHaveText(/Thinking|Tab to accept/);
  await editor.press('End');
  await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  await editor.press('Tab'); await expect(editor).toHaveText('Editing a longer draft see you then!');
  console.log('PASS mid-draft caret suppresses requests until moved to the end');
  const longDraft = 'A longer message with several soft-wrapped lines. '.repeat(35);
  await editor.fill(longDraft);
  await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  expect(await editor.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await remote.screenshot({ path: '.local/screenshots/scrolled-composer.png' });
  await editor.press('Tab'); await expect(editor).toHaveText(longDraft + ' see you then!');
  console.log('PASS scrolled composer accepts a visible continuation');
  await editor.fill('A long draft to make warmer');
  await editor.evaluate(editor => {
    // Emulate WhatsApp's editor model: replacement is only retained once its
    // selectionchange handler has observed the full-draft selection.
    let selected = false;
    const original = editor.textContent;
    const selection = () => { selected = !document.getSelection()?.isCollapsed && editor.contains(document.getSelection()?.anchorNode); };
    const input = event => { if (event.target === editor && !selected) editor.textContent = original; };
    document.addEventListener('selectionchange', selection); editor.addEventListener('input', input);
    window.finishSelectionFixture = () => { document.removeEventListener('selectionchange', selection); editor.removeEventListener('input', input); };
  });
  const bounds = await editor.boundingBox();
  await remote.mouse.click(bounds.x + bounds.width - 17, bounds.y - 16);
  await remote.waitForTimeout(700); // The refinement form must survive snapshot polling while the user thinks.
  await remote.keyboard.type('Make it warmer');
  await remote.keyboard.press('Enter');
  await expect(statusText).toHaveText('Thinking…');
  await editor.click(); // Refocusing must not cancel the in-flight edit.
  await expect(editor).toHaveText('That sounds lovely. See you then!');
  await remote.screenshot({ path: '.local/screenshots/refinement.png' });
  await remote.evaluate(() => window.finishSelectionFixture());
  await editor.press('Control+z'); await expect(editor).toHaveText('A long draft to make warmer');
  console.log('PASS refinement edits the draft after refocusing, without sending, and native Undo restores it');
  await editor.fill(''); await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  let refineBounds = await editor.boundingBox();
  await remote.mouse.click(refineBounds.x + refineBounds.width - 17, refineBounds.y - 16);
  await clickAssistant('Shorter');
  await expect.poll(assistantUi).toEqual({ ghost: 'That sounds lovely. See you then!', popupHidden: true });
  refineBounds = await editor.boundingBox();
  await remote.mouse.click(refineBounds.x + refineBounds.width - 17, refineBounds.y - 16);
  await clickAssistant('Warmer'); await editor.click();
  await expect.poll(assistantUi).toEqual({ ghost: 'That sounds lovely. See you then!', popupHidden: true });
  await expect(editor).toHaveText(''); await editor.press('Tab');
  await expect(editor).toHaveText('That sounds lovely. See you then!');
  expect(await remote.evaluate(() => window.fixtureSent)).toEqual([]);
  console.log('PASS repeated refinement updates the inline reply and survives refocusing while pending');
  await remote.exposeFunction('fixtureReplacementInput', key => remote.keyboard.press(key));
  for (const [key, expected] of [['X', 'Keep my draftX'], ['Backspace', 'Keep my draf']]) {
    await editor.fill('Keep my draft');
    await editor.evaluate((editor, key) => {
      const selected = () => {
        if (document.getSelection()?.toString() !== 'Keep my draft') return;
        document.removeEventListener('selectionchange', selected);
        void window.fixtureReplacementInput(key);
      };
      document.addEventListener('selectionchange', selected);
    }, key);
    const rect = await editor.boundingBox(); await remote.mouse.click(rect.x + rect.width - 17, rect.y - 16);
    await clickAssistant('Warmer');
    await expect(editor).toHaveText(expected);
    expect(await remote.evaluate(() => window.fixtureSent)).toEqual([]);
    console.log(`PASS ${key} during native selection reconciliation edits only at the original caret`);
  }
  await editor.fill('Keep my draft');
  await editor.evaluate(editor => {
    window.fixtureSelectionMoved = false;
    const selected = () => {
      if (document.getSelection()?.toString() !== 'Keep my draft') return;
      document.removeEventListener('selectionchange', selected);
      const range = document.createRange(); range.setStart(editor.firstChild, 0); range.setEnd(editor.firstChild, 4);
      const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      window.fixtureSelectionMoved = true;
    };
    document.addEventListener('selectionchange', selected);
  });
  const selectionBounds = await editor.boundingBox(); await remote.mouse.click(selectionBounds.x + selectionBounds.width - 17, selectionBounds.y - 16);
  await clickAssistant('Warmer');
  await expect.poll(() => remote.evaluate(() => window.fixtureSelectionMoved)).toBe(true);
  await remote.waitForTimeout(100);
  await expect(editor).toHaveText('Keep my draft'); expect(await remote.evaluate(() => document.getSelection()?.toString())).toBe('Keep');
  console.log('PASS selection changes during replacement preserve the full draft and the new selection');
  await editor.fill('A draft while searching');
  await remote.evaluate(() => { const search = document.createElement('input'); search.id = 'fixture-search'; search.setAttribute('aria-label', 'Fixture search'); document.querySelector('#pane-side').prepend(search); });
  const searchBounds = await editor.boundingBox(); await remote.mouse.click(searchBounds.x + searchBounds.width - 17, searchBounds.y - 16);
  await clickAssistant('Warmer');
  const fixtureSearch = remote.getByLabel('Fixture search'); await fixtureSearch.click(); await fixtureSearch.fill('Find this');
  await expect(statusText).toHaveText('Tab to accept · Esc to dismiss'); await remote.waitForTimeout(100);
  await expect(fixtureSearch).toBeFocused(); await expect(editor).toHaveText('A draft while searching');
  await fixtureSearch.press('X'); await expect(fixtureSearch).toHaveValue('Find thisX');
  await editor.click(); await expect(editor).toHaveText('That sounds lovely. See you then!');
  await remote.evaluate(() => document.getElementById('fixture-search').remove());
  console.log('PASS arriving refinement preserves search focus and applies only on returning to the composer');
  await editor.fill('Maybe');
  await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  await editor.press('Escape');
  await remote.waitForTimeout(1500); // Dismissal must survive activity snapshot updates and the debounce window.
  await editor.press('Tab');
  await expect(editor).toHaveText('Maybe');
  expect(await remote.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Send');
  console.log('PASS Escape dismisses and ordinary Tab navigation returns');
  await editor.fill('Input method draft');
  await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  await editor.dispatchEvent('compositionstart', { data: 'に' });
  await editor.press('Tab');
  await expect(editor).toHaveText('Input method draft');
  await editor.dispatchEvent('compositionend', { data: 'に' });
  console.log('PASS simulated IME composition blocks suggestion acceptance');
  await editor.dispatchEvent('compositionstart', { data: 'に' });
  await remote.getByRole('button', { name: 'Replace composer' }).click();
  await editor.click(); await editor.fill('After replacement');
  await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  await editor.press('Tab'); await expect(editor).toHaveText('After replacement see you then!');
  console.log('PASS composer replacement during composition permits ordinary suggestions again');
  await editor.evaluate(el => {
    el.innerHTML = '<p>First</p><p><br></p>'; el.focus();
    const range = document.createRange(); range.setStart(el.lastChild, 0); range.collapse(true);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertParagraph' }));
  });
  await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  await editor.press('Tab'); await expect(editor).toContainText('see you then!');
  expect(await remote.evaluate(() => window.fixtureSent)).toEqual([]);
  console.log('PASS Tab accepts a continuation at the final empty paragraph without sending');
  await editor.evaluate(el => {
    el.innerHTML = 'Hi <span contenteditable="false" data-mention-id="123">@Alice</span>';
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await expect(statusText).toContainText('cannot be preserved safely');
  const mentionBounds = await editor.boundingBox();
  await remote.mouse.click(mentionBounds.x + mentionBounds.width - 17, mentionBounds.y - 16);
  await remote.keyboard.type('Make it shorter'); await remote.keyboard.press('Enter');
  await expect(editor.locator('[data-mention-id="123"]')).toHaveText('@Alice');
  await expect(editor).toHaveText('Hi @Alice');
  await expect(statusText).toContainText('your draft is unchanged');
  console.log('PASS refinement rejects a structured mention without removing its target');
  await editor.fill('Waiting for another message');
  await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  await remote.getByRole('button', { name: 'Simulate incoming' }).click();
  await editor.click(); await editor.press('Tab');
  await expect(editor).toHaveText('Waiting for another message');
  console.log('PASS incoming message invalidates the visible suggestion');
  await editor.fill('Changed');
  await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  await remote.getByRole('button', { name: 'Weekend plans', exact: false }).click();
  await expect(editor).toHaveText('');
  await editor.click(); await editor.press('Tab');
  await expect(editor).toHaveText('');
  console.log('PASS chat change discards old suggestion');
  await editor.click(); await editor.fill('Line one'); await editor.press('Shift+Enter'); await editor.type('Line two');
  await expect(editor).toContainText('Line one'); await expect(editor).toContainText('Line two');
  expect(await remote.evaluate(() => window.fixtureSent)).toEqual([]);
  await editor.press('Enter');
  expect((await remote.evaluate(() => window.fixtureSent)).length).toBe(1);
  console.log('PASS Shift+Enter and Enter retain fixture behavior');
  // WhatsApp (and the fixture) define their own module loader as window.require; only Node's must be absent.
  expect(await remote.evaluate(() => {
    let fs = 'unavailable';
    try { if (typeof window.require === 'function' && window.require('fs')?.readFileSync) fs = 'available'; } catch { /* page loader rejects Node modules */ }
    return { nodeRequire: typeof window.require === 'function' && ('cache' in window.require || 'resolve' in window.require) ? 'node' : 'none', fs, bridge: typeof window.companion, process: typeof window.process };
  })).toEqual({ nodeRequire: 'none', fs: 'unavailable', bridge: 'undefined', process: 'undefined' });
  console.log('PASS remote has no Node or desktop API');
  // The preceding composer scenario leaves the group open; sticker sends below
  // are explicitly bound to the fixture's Alex conversation.
  await remote.getByRole('button', { name: /^Alex/ }).click();
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).chat).toMatchObject({ name: 'Alex', chatId: '123456@c.us', ready: true });
  // Keep the existing lookup/race scenarios animated; static routes are tested below.
  await remote.evaluate(() => { window.fixtureAnimatedSticker = true; });
  await remote.getByRole('button', { name: 'Load sticker', exact: true }).click();
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).state.stickers.length).toBe(1);
  await openPanel('stickers');
  const stickerPanel = local.getByRole('complementary', { name: 'Sticker library', exact: true });
  const stickerSearch = stickerPanel.getByRole('textbox', { name: 'Search stickers', exact: true });
  const stickerEditor = stickerPanel.getByRole('region', { name: 'Search terms', exact: true });
  const stickerTerms = stickerEditor.getByRole('textbox', { name: 'Search terms', exact: true });
  const stickerLocation = stickerEditor.getByRole('status');
  const untaggedCard = stickerPanel.getByRole('group', { name: 'Sticker without search terms', exact: true });
  await untaggedCard.getByRole('button', { name: 'Add search terms', exact: true }).click();
  await expect(untaggedCard.getByRole('button', { name: 'Add search terms', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(stickerTerms).toBeFocused();
  await expect(stickerTerms).toHaveAttribute('maxlength', '4000');
  await expect(stickerEditor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(stickerEditor.getByRole('textbox', { name: 'Tags', exact: true })).toHaveCount(0);
  await expect(stickerEditor.getByRole('textbox', { name: 'Keywords and phrases', exact: true })).toHaveCount(0);
  await stickerTerms.fill('happy, feliz, thanks, gracias, good morning friend, buenos días amigo');
  await stickerEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(stickerEditor).toHaveCount(0);
  await stickerSearch.fill('gracias "good morning"');
  await expect(stickerPanel.getByRole('group', { name: 'happy, feliz, thanks, gracias, good morning friend, buenos días amigo', exact: true })).toBeVisible();
  console.log('PASS sticker indexing, unified editor and bilingual phrase search');
  await stickerPanel.getByRole('group', { name: 'happy, feliz, thanks, gracias, good morning friend, buenos días amigo', exact: true }).getByRole('button', { name: 'Edit search terms', exact: true }).click();
  await stickerTerms.fill('unsaved search terms');
  await stickerSearch.fill('no matching sticker');
  await expect(stickerEditor).toHaveCount(0);
  await stickerSearch.fill('');
  await expect(stickerEditor).toBeVisible();
  await expect(stickerTerms).toHaveValue('unsaved search terms');
  await expect(stickerSearch).toBeFocused();
  // Use keyboard input without focusing a locator, so a stolen focus would
  // change the draft instead of continuing the search.
  await local.keyboard.type('happy');
  await expect(stickerSearch).toHaveValue('happy');
  await expect(stickerSearch).toBeFocused();
  await expect(stickerTerms).toHaveValue('unsaved search terms');
  await stickerSearch.fill('gracias "good morning"');
  console.log('PASS filtering an open editor preserves its unsaved draft and keeps typing in Search stickers');
  await stickerEditor.getByRole('button', { name: 'Locate in WhatsApp', exact: true }).click();
  await expect(stickerLocation).toHaveText('Highlighted in WhatsApp. Nothing was sent.');
  const sentBeforeLocating = await remote.evaluate(() => window.fixtureSent.length);
  await remote.locator('.messages').getByRole('img', { name: 'sticker', exact: true }).evaluate(el => el.remove());
  await stickerEditor.getByRole('button', { name: 'Locate in WhatsApp', exact: true }).click();
  await expect(stickerLocation).toContainText('This sticker isn’t loaded in WhatsApp.');
  // A hidden conversation can retain stale DOM identity but must be unavailable.
  const tokenBeforeHiding = (await local.evaluate(() => window.companion.status())).chat.destinationToken;
  await remote.evaluate(() => { document.querySelector('#main').style.display = 'none'; });
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).chat).toMatchObject({ name: 'Alex', ready: false, canSendSticker: false });
  expect((await local.evaluate(() => window.companion.status())).chat.destinationToken).not.toBe(tokenBeforeHiding);
  await stickerEditor.getByRole('button', { name: 'Locate in WhatsApp', exact: true }).click();
  await expect(stickerPanel.getByRole('button', { name: 'Open a chat to send', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await expect(stickerPanel.locator('.hint')).toHaveText('1 stickers indexed · Open a chat to send');
  // Playwright treats aria-disabled as disabled. Force trusted input to verify
  // the handler's guard while retaining the button's focusability.
  await stickerPanel.getByRole('button', { name: 'Open a chat to send', exact: true }).click({ force: true });
  expect((await local.evaluate(() => window.companion.status())).stickerSend).toBeNull();
  const hiddenSend = await local.evaluate(async () => {
    const status = await window.companion.status();
    return window.companion.action({ type: 'sendSticker', id: status.state.stickers[0].id, nonce: crypto.randomUUID(), destinationToken: status.chat.destinationToken });
  });
  expect(hiddenSend).toEqual({ ok: false, error: 'Open a conversation before sending a sticker.' });
  await expect(stickerLocation).toBeVisible();
  await stickerLocation.scrollIntoViewIfNeeded();
  const noticeFits = await stickerLocation.evaluate(el => {
    const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
  });
  expect(noticeFits).toBe(true);
  await expect(stickerTerms).toHaveValue('unsaved search terms');
  await expect(local.locator('.connection-status')).toHaveCount(0);
  await local.screenshot({ path: '.local/screenshots/sticker-location.png' });
  await remote.evaluate(() => { document.querySelector('#main').style.display = ''; });
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).chat.canSendSticker).toBe(true);
  expect(await remote.evaluate(() => window.fixtureSent.length)).toBe(sentBeforeLocating);
  await stickerEditor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(stickerEditor.getByRole('group', { name: 'Discard changes?', exact: true }).getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await stickerSearch.fill('no matching sticker');
  await expect(stickerEditor).toHaveCount(0);
  await stickerSearch.fill('');
  await expect(stickerEditor.getByRole('group', { name: 'Discard changes?', exact: true })).toBeVisible();
  await expect(stickerSearch).toBeFocused();
  await local.keyboard.type('happy');
  await expect(stickerSearch).toHaveValue('happy');
  await expect(stickerSearch).toBeFocused();
  await expect(stickerTerms).toHaveValue('unsaved search terms');
  await stickerEditor.getByRole('group', { name: 'Discard changes?', exact: true }).getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(stickerTerms).toHaveValue('unsaved search terms');
  await expect(stickerTerms).toBeFocused();
  await stickerEditor.getByRole('button', { name: 'Close', exact: true }).click();
  await stickerEditor.getByRole('group', { name: 'Discard changes?', exact: true }).getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(stickerEditor).toHaveCount(0);
  await expect(stickerPanel.getByRole('button', { name: 'Edit search terms', exact: true })).toBeFocused();
  console.log('PASS a hidden conversation disables Send despite stale identity; location feedback stays inside the panel and preserves edits');
  const stickerCard = stickerPanel.getByRole('group', { name: 'happy, feliz, thanks, gracias, good morning friend, buenos días amigo', exact: true });
  // This live paragraph has no status role; location feedback does.
  const stickerLive = stickerPanel.locator('[aria-live="polite"]');
  // Hold only the acknowledgement: the real main handler still saves and publishes.
  const holdStickerActionReply = async type => app.evaluate(({ ipcMain }, type) => {
    const original = ipcMain._invokeHandlers.get('companion:action');
    if (typeof original !== 'function') throw new Error('Fixture action handler missing');
    globalThis.releaseStickerActionReply = undefined;
    ipcMain.removeHandler('companion:action');
    ipcMain.handle('companion:action', async (event, action) => {
      const result = await original(event, action);
      if (action.type !== type) return result;
      return new Promise(resolve => {
        globalThis.releaseStickerActionReply = () => {
          ipcMain.removeHandler('companion:action'); ipcMain.handle('companion:action', original);
          globalThis.releaseStickerActionReply = undefined; resolve(result);
        };
      });
    });
  }, type);
  const releaseStickerActionReply = async () => {
    await expect.poll(() => app.evaluate(() => typeof globalThis.releaseStickerActionReply)).toBe('function');
    await app.evaluate(() => globalThis.releaseStickerActionReply());
  };
  const savedStickerTerms = 'happy, feliz, thanks, gracias, good morning friend, buenos días amigo';
  await stickerSearch.fill('');
  await stickerCard.getByRole('button', { name: 'Edit search terms', exact: true }).click();
  await stickerTerms.fill('submitted terms fixture');
  await holdStickerActionReply('sticker');
  await stickerEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => app.evaluate(() => typeof globalThis.releaseStickerActionReply)).toBe('function');
  await stickerTerms.fill('newer unsaved terms fixture');
  await releaseStickerActionReply();
  await local.waitForTimeout(100); // Let the delayed IPC acknowledgement reach the editor.
  await expect(stickerEditor).toBeVisible(); await expect(stickerTerms).toHaveValue('newer unsaved terms fixture');
  await expect(stickerTerms).toBeFocused();
  await expect(stickerEditor.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await stickerEditor.getByRole('button', { name: 'Close', exact: true }).click();
  await stickerEditor.getByRole('button', { name: 'Discard', exact: true }).click();
  const submittedCard = stickerPanel.getByRole('group', { name: 'submitted terms fixture', exact: true });
  await submittedCard.getByRole('button', { name: 'Edit search terms', exact: true }).click();
  await expect(stickerTerms).toHaveValue('submitted terms fixture');
  await stickerTerms.fill('second submission fixture');
  await holdStickerActionReply('sticker');
  await stickerEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => app.evaluate(() => typeof globalThis.releaseStickerActionReply)).toBe('function');
  await expect(stickerEditor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await stickerEditor.getByRole('button', { name: 'Close', exact: true }).click();
  await stickerPanel.getByRole('group', { name: 'second submission fixture', exact: true }).getByRole('button', { name: 'Edit search terms', exact: true }).click();
  await releaseStickerActionReply();
  await local.waitForTimeout(100); // A stale acknowledgement must leave this new editor visit open.
  await expect(stickerEditor).toBeVisible(); await expect(stickerTerms).toBeFocused();
  await stickerTerms.fill(savedStickerTerms);
  await stickerEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(stickerEditor).toHaveCount(0);
  console.log('PASS delayed Save keeps newer text editable and cannot close a reopened editor');

  const nativeStickerPicker = remote.getByTestId('expressions-panel');
  const nativeStickerTrigger = remote.getByRole('button', { name: 'Emojis, GIFs, Stickers', exact: true });
  // Stub native diagnostic UI only for these disposable fixture scenarios.
  await app.evaluate(({ dialog, shell }) => {
    const showMessageBox = dialog.showMessageBox, showItemInFolder = shell.showItemInFolder;
    globalThis.pickerDiagnosticCalls = { messages: [], paths: [] };
    dialog.showMessageBox = async (_win, options) => { globalThis.pickerDiagnosticCalls.messages.push(options.message); return { response: 0, checkboxChecked: false }; };
    shell.showItemInFolder = path => { globalThis.pickerDiagnosticCalls.paths.push(path); };
    globalThis.restorePickerDiagnosticUi = () => { dialog.showMessageBox = showMessageBox; shell.showItemInFolder = showItemInFolder; };
  });
  const capturePickerLayout = () => app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu().items.find(item => item.label === 'Companion').submenu.items.find(item => item.label === 'Capture sticker picker layout').click();
  });
  const diagnosticFiles = async () => readdir(join(dir, 'diagnostics')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  try {
    await expect(nativeStickerPicker).toHaveCount(0);
    await capturePickerLayout();
    await expect.poll(() => app.evaluate(() => globalThis.pickerDiagnosticCalls.messages)).toEqual(["Open WhatsApp's sticker picker first, then try again."]);
    expect(await diagnosticFiles()).toEqual([]);
    await nativeStickerTrigger.click();
    await expect(nativeStickerPicker).toBeVisible();
    await expect.poll(() => nativeStickerPicker.evaluate(el => getComputedStyle(el.parentElement).transform)).toBe('matrix(1, 0, 0, 1, 0, 0)');
    // Wait for the existing connector's picker layout adjustment to settle.
    await nativeStickerPicker.evaluate(async el => {
      let previous;
      let stable = 0;
      for (let frame = 0; frame < 120; frame++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const current = el.parentElement.outerHTML;
        stable = current === previous ? stable + 1 : 0; previous = current;
        if (stable === 3) return;
      }
      throw new Error('Native picker layout did not settle');
    });
    const pickerState = () => remote.evaluate(() => {
      const picker = document.querySelector('[data-testid="expressions-panel"]');
      const elements = [picker, ...picker.querySelectorAll('*')];
      return { html: picker.parentElement.outerHTML, scroll: elements.map(el => [el.scrollLeft, el.scrollTop]), focus: document.activeElement?.outerHTML,
        textSent: window.fixtureSent.length, stickerSent: window.fixtureStickerSent.length };
    });
    const before = await pickerState();
    await capturePickerLayout();
    await expect.poll(diagnosticFiles).toHaveLength(1);
    const filename = (await diagnosticFiles())[0], path = join(dir, 'diagnostics', filename);
    expect(filename).toMatch(/^sticker-picker-.*\.json$/);
    const contents = await readFile(path, 'utf8'), diagnostic = JSON.parse(contents);
    expect(diagnostic).toMatchObject({ status: 'captured', appVersion: '0.1.0', connectorVersion: 1, truncated: false, tree: { tagName: 'ul', attributes: { 'data-testid': 'expressions-panel' } } });
    for (const secret of ['PRIVATE-PICKER-TITLE', 'PRIVATE-PICKER-LABEL', 'PRIVATE-PICKER-ALT', 'Alex', '123456@c.us', 'base64,']) expect(contents).not.toContain(secret);
    expect(diagnostic.tree.children.find(node => node.attributes['data-testid'] === 'panel-starred').labels['aria-label'].words).toEqual(['favorites']);
    const flatten = node => [node, ...node.children.flatMap(flatten)];
    const image = flatten(diagnostic.tree).find(node => node.tagName === 'img');
    expect(image.image.scheme).toBe('data'); expect(image.labels.alt.words).toEqual(['sticker']);
    expect(diagnostic.ancestors.at(-1)).toEqual({ tagName: 'body' });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect.poll(() => app.evaluate(() => globalThis.pickerDiagnosticCalls.paths)).toEqual([path]);
    expect(await app.evaluate(() => globalThis.pickerDiagnosticCalls.messages.at(-1))).toContain(path);
    expect(await pickerState()).toEqual(before);
    await nativeStickerTrigger.click(); await expect(nativeStickerPicker).toHaveCount(0);
    console.log('PASS sticker picker diagnostic saves redacted owner-only JSON without changing the picker, and no-picker capture creates no file');
  } finally { await app.evaluate(() => globalThis.restorePickerDiagnosticUi()); }
  const sendCard = () => stickerCard.getByRole('button', { name: 'Send to Alex', exact: true });
  const stickerState = async () => (await local.evaluate(() => window.companion.status())).stickerSend;
  const holdStickerCommand = async type => app.evaluate(({ BrowserWindow }, type) => {
    const contents = BrowserWindow.getAllWindows()[0].contentView.children[0].webContents;
    const original = contents.send.bind(contents);
    globalThis.heldStickerCommand = undefined;
    const queued = [];
    contents.send = (channel, ...args) => {
      if (channel === 'companion:command' && (args[0]?.type === type || globalThis.heldStickerCommand)) {
        globalThis.heldStickerCommand ??= args[0];
        queued.push([channel, ...args]); return;
      }
      return original(channel, ...args);
    };
    globalThis.releaseStickerCommand = () => {
      contents.send = original;
      // Preserve IPC order: a queued prepare must precede its cancellation.
      // Delivering it after cancel would create an impossible stale lookup.
      for (const command of queued) original(...command);
    };
  }, type);
  const releaseStickerCommand = async () => {
    await expect.poll(() => app.evaluate(() => Boolean(globalThis.heldStickerCommand))).toBe(true);
    await app.evaluate(() => globalThis.releaseStickerCommand());
  };
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).chat.ready).toBe(true);
  await editor.fill('Keep this unsent sticker draft');
  const textSendsBeforeStickers = await remote.evaluate(() => window.fixtureSent.length);
  await expect(remote.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  // A decoy media control makes accidental activation observable separately
  // from the text composer and the one native sticker button.
  await remote.evaluate(() => {
    window.fixtureMediaSent = 0;
    const media = document.createElement('button'); media.id = 'fixture-media-send';
    media.setAttribute('aria-label', 'Send media'); media.textContent = 'Send media';
    media.onclick = () => { window.fixtureMediaSent++; };
    document.querySelector('#tools').append(media);
  });
  await stickerCard.locator('img').click();
  await sendCard().evaluate(button => button.click());
  expect(await stickerState()).toBeNull();
  expect(await remote.evaluate(() => window.fixtureStickerSent.length)).toBe(0);
  await sendCard().click();
  await expect.poll(stickerState).toMatchObject({ route: 'picker', animated: true, state: 'sent' });
  await expect(stickerLive).toHaveText('Sent to Alex');
  await expect(stickerCard.locator('.sticker-overlay')).toHaveText('Sent');
  await expect.poll(() => remote.evaluate(() => window.fixtureStickerSent.length)).toBe(1);
  expect(await remote.evaluate(() => window.fixtureStickerSent[0])).toEqual(await remote.evaluate(() => ({ source: window.fixtureStickerSource, peer: '123456@c.us' })));
  await expect(editor).toHaveText('Keep this unsent sticker draft');
  await expect(nativeStickerPicker).toHaveCount(0);
  await expect(local.getByRole('dialog')).toHaveCount(0);
  const firstSend = await stickerState();
  const replay = await local.evaluate(({ id, nonce }) => window.companion.status().then(status => window.companion.action({ type: 'sendSticker', id, nonce, destinationToken: status.chat.destinationToken })), firstSend);
  expect(replay.ok).toBe(false);
  expect(await remote.evaluate(() => window.fixtureSent.length)).toBe(textSendsBeforeStickers);
  expect(await remote.evaluate(() => window.fixtureMediaSent)).toBe(0);
  // Main retains the result; only the UI's 1.5-second flash returns to idle.
  await expect(stickerLive).toHaveText('');
  await expect(stickerCard.locator('.sticker-overlay')).toHaveCount(0);
  expect((await stickerState()).state).toBe('sent');
  console.log('PASS one trusted card click sends one native original without a dialog; synthetic clicks and replay cannot send; draft untouched');

  // Index a second disposable original to exercise ordering and other-card
  // concurrency. Do not change the fixture's native picker's source.
  await stickerSearch.fill('');
  const firstStickerId = await stickerCard.getAttribute('data-sticker');
  await remote.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d'); context.fillStyle = '#3388cc'; context.fillRect(0, 0, 64, 64);
    const image = document.createElement('img'); image.id = 'fixture-extra-sticker'; image.alt = 'sticker';
    image.src = canvas.toDataURL('image/webp'); image.width = 64; document.querySelector('.messages').append(image);
  });
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).state.stickers.length).toBe(2);
  const otherStickerId = (await local.evaluate(() => window.companion.status())).state.stickers.find(sticker => sticker.id !== firstStickerId).id;
  const gridIds = () => stickerPanel.locator('.sticker-grid > [data-sticker]').evaluateAll(cards => cards.map(card => card.getAttribute('data-sticker')));
  const otherCard = stickerPanel.locator(`[data-sticker="${otherStickerId}"]`);
  await expect.poll(gridIds).toEqual([firstStickerId, otherStickerId]);
  await remote.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d'); context.fillStyle = '#cc8833'; context.fillRect(0, 0, 64, 64);
    const image = document.createElement('img'); image.id = 'fixture-third-sticker'; image.alt = 'sticker';
    image.src = canvas.toDataURL('image/webp'); image.width = 64; document.querySelector('.messages').append(image);
  });
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).state.stickers.length).toBe(3);
  const thirdStickerId = (await local.evaluate(() => window.companion.status())).state.stickers.find(sticker => ![firstStickerId, otherStickerId].includes(sticker.id)).id;
  await expect.poll(gridIds).toEqual([firstStickerId, otherStickerId, thirdStickerId]);
  const otherImage = (await local.evaluate(() => window.companion.status())).state.stickers.find(sticker => sticker.id === otherStickerId).image;
  // Reindex B through main's fixture IPC with a later clock, bypassing only the
  // one-minute discovery throttle. Both newcomers must retain their own ranks.
  await app.evaluate(({ ipcMain, BrowserWindow }, image) => {
    const contents = BrowserWindow.getAllWindows()[0].contentView.children[0].webContents;
    const now = Date.now;
    try {
      Date.now = () => now() + 120000;
      ipcMain.emit('companion:event', { sender: contents, senderFrame: contents.mainFrame }, { type: 'sticker', image });
    } finally { Date.now = now; }
  }, otherImage);
  await expect.poll(async () => {
    const stickers = (await local.evaluate(() => window.companion.status())).state.stickers;
    return stickers.find(s => s.id === otherStickerId).lastSeen > stickers.find(s => s.id === thirdStickerId).lastSeen;
  }).toBe(true);
  await expect.poll(gridIds).toEqual([firstStickerId, otherStickerId, thirdStickerId]);
  // A query change takes the new lastSeen order; status updates above did not.
  await stickerSearch.fill('happy'); await expect(otherCard).toHaveCount(0);
  await stickerSearch.fill('');
  await expect.poll(gridIds).toEqual([otherStickerId, thirdStickerId, firstStickerId]);
  await remote.locator('#fixture-third-sticker').evaluate(image => image.remove());
  expect((await local.evaluate(id => window.companion.action({ type: 'forgetSticker', id }), thirdStickerId)).ok).toBe(true);
  await expect.poll(gridIds).toEqual([otherStickerId, firstStickerId]);
  const frozenOrder = await gridIds();
  console.log('PASS the open grid keeps its order as stickers are indexed and refreshes order when the query changes');

  // A hidden editor's draft belongs to its sticker, even after another editor opens.
  // Give B searchable terms temporarily so the query can hide A while showing B.
  const otherDraftCard = stickerPanel.locator(`[data-sticker="${otherStickerId}"]`);
  const discardPrompt = stickerEditor.getByRole('group', { name: 'Discard changes?', exact: true });
  await otherCard.getByRole('button', { name: 'Add search terms', exact: true }).click();
  await stickerTerms.fill('draft recovery fixture');
  await stickerEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(stickerEditor).toHaveCount(0);
  await stickerCard.getByRole('button', { name: 'Edit search terms', exact: true }).click();
  await stickerTerms.fill('unsaved draft for sticker A');
  await stickerSearch.fill('draft recovery fixture');
  await expect(stickerCard).toHaveCount(0);
  await expect(stickerEditor).toHaveCount(0);
  await otherDraftCard.getByRole('button', { name: 'Edit search terms', exact: true }).click();
  await expect(discardPrompt).toHaveCount(0);
  await expect(stickerTerms).toHaveValue('draft recovery fixture');
  await expect(stickerEditor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await stickerSearch.fill('');
  await stickerEditor.getByRole('button', { name: 'Close', exact: true }).click();
  await stickerCard.getByRole('button', { name: 'Edit search terms', exact: true }).click();
  await expect(stickerTerms).toHaveValue('unsaved draft for sticker A');
  await expect(stickerEditor.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await otherDraftCard.getByRole('button', { name: 'Edit search terms', exact: true }).click();
  await expect(discardPrompt).toBeVisible();
  await expect(discardPrompt.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await discardPrompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(stickerTerms).toHaveValue('unsaved draft for sticker A');
  await otherDraftCard.getByRole('button', { name: 'Edit search terms', exact: true }).click();
  await discardPrompt.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(stickerTerms).toHaveValue('draft recovery fixture');
  // Restore B's untagged state for the remaining concurrency and Forget checks.
  await stickerTerms.fill('');
  await stickerEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(stickerEditor).toHaveCount(0);
  await stickerCard.getByRole('button', { name: 'Edit search terms', exact: true }).click();
  await expect(stickerTerms).toHaveValue('happy, feliz, thanks, gracias, good morning friend, buenos días amigo');
  await expect(stickerEditor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await stickerEditor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(gridIds).toEqual(frozenOrder);
  console.log('PASS hidden sticker drafts survive opening another editor; visible switches still prompt and Discard clears only that sticker');

  // Hold the lookup to exercise finding deterministically, without live accounts.
  await holdStickerCommand('prepareSticker');
  await sendCard().click();
  await expect(stickerCard.getByRole('button', { name: 'Sending sticker…', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await expect(stickerLive).toHaveText('Sending sticker…');
  await expect(stickerCard.getByRole('button', { name: 'Sending sticker…', exact: true })).toBeFocused();
  await expect(stickerCard.locator('.sticker-overlay')).toHaveText('Sending…');
  await expect(otherCard.getByRole('button', { name: 'Wait for the current sticker', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await expect(otherCard.getByRole('button', { name: 'Add search terms', exact: true })).toBeEnabled();
  const findingSend = await stickerState();
  await otherCard.getByRole('button', { name: 'Wait for the current sticker', exact: true }).click({ force: true });
  expect((await stickerState()).nonce).toBe(findingSend.nonce);
  await otherCard.getByRole('button', { name: 'Add search terms', exact: true }).click();
  await expect(stickerTerms).toBeFocused();
  await stickerEditor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(gridIds).toEqual(frozenOrder);
  const duplicateSend = await local.evaluate(id => window.companion.status().then(status => window.companion.action({ type: 'sendSticker', id, nonce: crypto.randomUUID(), destinationToken: status.chat.destinationToken })), findingSend.id);
  expect(duplicateSend.ok).toBe(false);
  await stickerSearch.fill('no matching sticker');
  expect((await stickerState()).nonce).toBe(findingSend.nonce);
  expect((await stickerState()).state).toBe('finding');
  await stickerSearch.fill('');
  await stickerCard.getByRole('button', { name: 'Cancel sending', exact: true }).click();
  await expect.poll(async () => (await stickerState())?.state).toBe('cancelled');
  await expect(stickerLive).toHaveText('Cancelled');
  await expect(stickerCard.locator('.sticker-overlay')).toHaveText('Cancelled');
  await releaseStickerCommand();
  await expect(stickerLive).toHaveText('');
  await expect(stickerCard.locator('.sticker-overlay')).toHaveCount(0);
  expect((await stickerState()).state).toBe('cancelled');
  await expect(nativeStickerPicker).toHaveCount(0);
  expect(await remote.evaluate(() => window.fixtureStickerSent.length)).toBe(1);
  console.log('PASS finding can be cancelled; other-card clicks and duplicate sends are rejected, edits remain available and search keeps the same ticket');

  // Finding replaces this editor's original focus-return button with Cancel.
  await stickerCard.getByRole('button', { name: 'Edit search terms', exact: true }).click();
  await holdStickerCommand('prepareSticker'); await sendCard().click();
  await expect(stickerCard.getByRole('button', { name: 'Cancel sending', exact: true })).toBeVisible();
  await stickerTerms.focus(); await local.keyboard.press('Escape');
  await expect(stickerEditor).toHaveCount(0);
  await expect(stickerCard.getByRole('button', { name: 'Cancel sending', exact: true })).toBeFocused();
  expect((await stickerState()).state).toBe('finding');
  await local.keyboard.press('Escape');
  await expect.poll(async () => (await stickerState()).state).toBe('cancelled');
  await expect(stickerPanel).toBeVisible();
  await releaseStickerCommand(); await expect(nativeStickerPicker).toHaveCount(0);
  console.log('PASS Escape closes the editor to the current Cancel button, then cancels Finding');

  await otherCard.getByRole('button', { name: 'Add search terms', exact: true }).click();
  await stickerTerms.fill('temporary fixture sticker');
  await stickerEditor.getByRole('button', { name: 'Save', exact: true }).click();
  const temporaryCard = stickerPanel.getByRole('group', { name: 'temporary fixture sticker', exact: true });
  await temporaryCard.getByRole('button', { name: 'Edit search terms', exact: true }).click();
  await remote.locator('#fixture-extra-sticker').evaluate(image => image.remove());
  await stickerEditor.getByRole('button', { name: 'Forget', exact: true }).click();
  await expect(temporaryCard).toHaveCount(0); await expect(stickerEditor).toHaveCount(0);
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).state.stickers.length).toBe(1);
  await expect(sendCard()).toBeFocused();
  console.log('PASS Save closes the editor and Forget removes the disposable card and returns focus to the remaining Send');

  await holdStickerCommand('prepareSticker'); await sendCard().click();
  await expect(stickerCard.getByRole('button', { name: 'Cancel sending', exact: true })).toBeVisible();
  await stickerSearch.fill('no matching sticker');
  await expect(stickerPanel.getByText('No matching stickers', { exact: true })).toBeVisible();
  await local.keyboard.press('Escape');
  await expect.poll(async () => (await stickerState())?.state).toBe('cancelled');
  await expect(stickerPanel).toBeVisible();
  await expect(stickerLive).toHaveText('Cancelled');
  await expect(stickerPanel.locator('.hint')).toHaveText('1 stickers indexed · Cancelled');
  await releaseStickerCommand(); await expect(nativeStickerPicker).toHaveCount(0);
  await expect(stickerPanel.locator('.hint')).toHaveText('1 stickers indexed');
  await stickerSearch.fill('');
  console.log('PASS Escape cancels finding before closing the panel and announces a filtered card result in the live region and hint');

  await holdStickerCommand('prepareSticker'); await sendCard().click();
  await expect(stickerCard.getByRole('button', { name: 'Cancel sending', exact: true })).toBeVisible();
  const displayedDestination = (await local.evaluate(() => window.companion.status())).chat.destinationToken;
  await remote.evaluate(() => document.querySelector('#group').click());
  await expect.poll(stickerState).toMatchObject({ state: 'cancelled', reason: 'chat-changed' });
  const cancelledBeforeQueuedClick = await stickerState();
  const staleActions = await local.evaluate(async ({ id, destinationToken }) => [
    await window.companion.action({ type: 'sendSticker', id, nonce: crypto.randomUUID(), destinationToken }),
    await window.companion.action({ type: 'locateSticker', id, destinationToken })
  ], { id: firstStickerId, destinationToken: displayedDestination });
  for (const result of staleActions) { expect(result.ok).toBe(false); expect(result.error).toContain('conversation changed'); }
  expect(await stickerState()).toEqual(cancelledBeforeQueuedClick);

  await releaseStickerCommand();
  expect(await remote.evaluate(() => window.fixtureStickerSent.length)).toBe(1);
  await remote.evaluate(() => document.querySelector('#friend').click());
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).chat.name).toBe('Alex');
  await editor.fill('Keep this unsent sticker draft');
  console.log('PASS chat change cancels finding with a chat-changed reason');

  await holdStickerCommand('prepareSticker'); await sendCard().click();
  await expect(stickerCard.getByRole('button', { name: 'Cancel sending', exact: true })).toBeVisible();
  await stickerPanel.getByRole('button', { name: 'Close panel', exact: true }).click();
  await expect.poll(async () => (await stickerState())?.state).toBe('cancelled');
  await releaseStickerCommand(); await expect(nativeStickerPicker).toHaveCount(0);
  await openPanel('stickers');
  console.log('PASS closing the panel revokes finding permission');

  // Sending has crossed the cancellable boundary even if dispatch is queued.
  await holdStickerCommand('sendSticker'); await sendCard().click();
  await expect.poll(() => app.evaluate(() => Boolean(globalThis.heldStickerCommand))).toBe(true);
  expect((await stickerState()).state).toBe('sending');
  await expect(stickerCard.getByRole('button', { name: 'Sending sticker…', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await expect(stickerCard.getByRole('button', { name: 'Edit search terms', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await expect(stickerCard.locator('.sticker-overlay')).toHaveText('Sending…');
  // Both active phases use the same Sending announcement.
  await expect(stickerLive).toHaveText('Sending sticker…');
  await expect(stickerCard.getByRole('button', { name: 'Cancel sending', exact: true })).toHaveCount(0);
  expect((await local.evaluate(() => window.companion.action({ type: 'cancelSticker' }))).ok).toBe(true);
  expect((await stickerState()).state).toBe('sending');
  await local.keyboard.press('Escape');
  await expect(stickerPanel).toBeVisible();
  expect((await stickerState()).state).toBe('sending');
  await releaseStickerCommand();
  await expect.poll(async () => (await stickerState())?.state).toBe('sent');
  expect(await remote.evaluate(() => window.fixtureStickerSent.length)).toBe(2);
  await expect(editor).toHaveText('Keep this unsent sticker draft');
  console.log('PASS cancellation after sending starts is ignored and the native click finishes');

  // Preserve native picker layout coverage from the retired integration script.
  const assertStickerPickerFits = async (side = 'left') => {
    await expect.poll(async () => {
      const bounds = await nativeStickerPicker.boundingBox();
      const { left, right, width } = await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0], overlay = win.contentView.children[1].getBounds();
        const zoom = win.contentView.children[0].webContents.getZoomFactor();
        return { left: overlay.x / zoom, right: (overlay.x + overlay.width) / zoom, width: win.getContentSize()[0] / zoom };
      });
      const rail = await remote.locator('#pane-side').boundingBox();
      return !!bounds && bounds.width >= 320 && bounds.x >= (side === 'left' ? right : rail.x) + 7 && bounds.x + bounds.width <= (side === 'left' ? width : left) - 7;
    }).toBe(true);
  };
  await nativeStickerTrigger.click(); await expect(nativeStickerPicker).toBeVisible();
  await assertStickerPickerFits();
  for (const width of [880, 1500, 1280]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 832), width);
    await assertStickerPickerFits();
  }
  await local.evaluate(() => window.companion.action({ type: 'panel', panel: null }));
  await expect.poll(() => nativeStickerPicker.evaluate(el => ({ translate: el.parentElement.style.translate, maxWidth: el.parentElement.style.maxWidth }))).toEqual({ translate: '', maxWidth: '560px' });
  await openPanel('chat');
  for (const width of [880, 1100, 1500, 1280]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 832), width);
    await assertStickerPickerFits('right');
  }
  await openPanel('stickers'); await assertStickerPickerFits();
  await nativeStickerTrigger.click(); await expect(nativeStickerPicker).toHaveCount(0);
  console.log('PASS native picker stays beside either panel through narrow/wide resizing and restores its layout on close');

  // Keyboard activation is trusted. An already open picker is not lookup-owned.
  await nativeStickerTrigger.click(); await expect(nativeStickerPicker).toBeVisible();
  await sendCard().focus(); await sendCard().press('Enter');
  await expect.poll(() => remote.evaluate(() => window.fixtureStickerSent.length)).toBe(3);
  await expect(nativeStickerPicker).toBeVisible();
  await nativeStickerTrigger.click(); await expect(nativeStickerPicker).toHaveCount(0);
  console.log('PASS keyboard Send activates the native sticker once and preserves a user-opened picker');

  await holdStickerCommand('sendSticker'); await sendCard().click();
  await expect.poll(() => app.evaluate(() => Boolean(globalThis.heldStickerCommand))).toBe(true);
  // Disconnect the original while dispatch is held: no fallback or retry.
  await nativeStickerPicker.getByTestId('sticker-item').evaluate(item => item.remove());
  await releaseStickerCommand();
  await expect.poll(async () => (await stickerState())?.state).toBe('failed');
  await expect(stickerLive).toContainText(/Couldn[’']t confirm the sticker was sent/);
  await expect(stickerPanel.getByText(/^Couldn[’']t confirm the sticker was sent\. Check the chat before sending it again\.$/)).toBeVisible();
  await expect(stickerPanel.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  await expect(stickerPanel.getByRole('button', { name: 'Send still', exact: true })).toHaveCount(0);
  await stickerPanel.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(stickerPanel.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0);
  await expect(sendCard()).toBeFocused();
  await expect(stickerLive).toHaveText('');
  expect(await remote.evaluate(() => window.fixtureStickerSent.length)).toBe(3);
  await expect(nativeStickerPicker).toHaveCount(0);
  console.log('PASS an unconfirmed native activation reports failure and never retries');

  await remote.evaluate(() => { window.fixtureHideSticker = true; });
  const missingLookupStarted = Date.now();
  await sendCard().click();
  await expect.poll(async () => (await stickerState())?.state, { timeout: 3500, intervals: [50] }).toBe('missing');
  expect(Date.now() - missingLookupStarted).toBeLessThanOrEqual(3000);
  expect((await stickerState()).route).toBe('picker');
  expect(await remote.evaluate(() => window.fixtureMakerSent.length)).toBe(0);
  expect(await remote.evaluate(() => window.fixtureStickerSent.length)).toBe(3);
  await expect(stickerPanel.getByText('WhatsApp doesn’t have the animated version loaded.', { exact: true })).toBeVisible();
  await expect(stickerPanel.getByRole('button', { name: 'Send still', exact: true })).toBeFocused();
  await local.keyboard.press('Escape');
  await expect(stickerPanel.getByRole('button', { name: 'Send still', exact: true })).toHaveCount(0);
  await expect(stickerPanel).toBeVisible();
  expect(await remote.evaluate(() => window.fixtureStickerSent.length)).toBe(3);
  await sendCard().click();
  await expect.poll(async () => (await stickerState())?.state, { timeout: 3500, intervals: [50] }).toBe('missing');
  await expect(stickerPanel.getByRole('button', { name: 'Send still', exact: true })).not.toHaveAttribute('aria-disabled', 'true');
  const stillDraftCounters = await remote.evaluate(() => [window.fixtureAttachClicks || 0, window.fixtureMakerOpens, window.fixtureMakerAssignments, window.fixtureMakerSent.length]);
  const stillDraftMarkup = await editor.evaluate(element => element.innerHTML);
  await stickerPanel.getByRole('button', { name: 'Send still', exact: true }).click();
  await expect.poll(stickerState).toMatchObject({ route: 'maker', animated: true, state: 'failed', reason: 'draft', detail: 'draft-present', sent: 'not-sent' });
  expect(await editor.evaluate(element => element.innerHTML)).toBe(stillDraftMarkup);
  expect(await remote.evaluate(() => [window.fixtureAttachClicks || 0, window.fixtureMakerOpens, window.fixtureMakerAssignments, window.fixtureMakerSent.length])).toEqual(stillDraftCounters);
  await expect(stickerPanel.locator('.sticker-message .msg p')).toHaveText('Send or clear your draft first, then send the sticker.');
  await expect(stickerPanel.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  await expect(stickerPanel.getByRole('button', { name: 'Send still', exact: true })).toHaveCount(0);
  console.log('PASS Send still with a draft refuses before any native page interaction');
  await local.keyboard.press('Escape'); await editor.fill('');
  await sendCard().click();
  await expect.poll(stickerState, { timeout: 3500 }).toMatchObject({ state: 'missing' });
  await stickerPanel.getByRole('button', { name: 'Send still', exact: true }).click();
  await expect.poll(stickerState, { timeout: 8000 }).toMatchObject({ route: 'maker', animated: true, state: 'sent' });
  expect(await remote.evaluate(() => window.fixtureMakerSent.length)).toBe(1);
  expect(await remote.evaluate(() => window.fixtureStickerSent.length)).toBe(4);
  await expect(editor).toHaveText('');
  console.log('PASS animated lookup never falls back automatically; explicit Send still uses the maker');
  await remote.evaluate(() => { window.fixtureHideSticker = false; });
  await expect(nativeStickerPicker).toHaveCount(0);
  expect(await remote.evaluate(() => window.fixtureSent.length)).toBe(textSendsBeforeStickers);
  expect(await remote.evaluate(() => window.fixtureMediaSent)).toBe(0);
  for (const delay of [3000, 8000]) {
    await remote.evaluate(delay => { window.fixtureColdPickerDelay = delay; window.fixturePickerCache = {}; }, delay);
    const beforeCold = await remote.evaluate(() => window.fixtureStickerSent.length);
    const started = Date.now();
    await sendCard().click();
    await expect.poll(stickerState, { timeout: 16000, intervals: [50] }).toMatchObject({ route: 'picker', state: 'sent', sent: 'confirmed' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(delay);
    expect(await remote.evaluate(() => window.fixtureStickerSent.length)).toBe(beforeCold + 1);
    await expect(nativeStickerPicker).toHaveCount(0);
  }
  console.log('PASS cold picker spinner and empty categories load for 3–8 seconds without a false animated miss');
  await remote.evaluate(() => { window.fixtureColdPickerDelay = -1; window.fixturePickerCache = {}; });
  const foreverStarted = Date.now();
  const beforeRetry = await remote.evaluate(() => window.fixtureStickerSent.length);
  await sendCard().click();
  await expect.poll(stickerState, { timeout: 16500, intervals: [50] }).toMatchObject({ route: 'picker', state: 'missing' });
  expect(Date.now() - foreverStarted).toBeGreaterThanOrEqual(15000);
  expect(Date.now() - foreverStarted).toBeLessThan(16500);
  expect(await remote.evaluate(() => window.fixtureStickerSent.length)).toBe(beforeRetry);
  const originalRetry = stickerPanel.getByRole('button', { name: 'Try again', exact: true });
  await expect(originalRetry).toBeVisible();
  await expect(stickerPanel.getByRole('button', { name: 'Send still', exact: true })).toBeVisible();
  const missingNonce = (await stickerState()).nonce;
  await originalRetry.evaluate(button => button.click());
  expect((await stickerState()).nonce).toBe(missingNonce);
  await remote.evaluate(() => { window.fixtureColdPickerDelay = 0; window.fixturePickerCache = {}; });
  await originalRetry.click();
  await expect.poll(stickerState, { timeout: 6000 }).toMatchObject({ route: 'picker', state: 'sent', sent: 'confirmed' });
  expect((await stickerState()).nonce).not.toBe(missingNonce);
  expect(await remote.evaluate(() => window.fixtureStickerSent.length)).toBe(beforeRetry + 1);
  console.log('PASS forever-loading picker stops at 15 seconds; trusted Try again starts a fresh animated lookup');
  await remote.locator('#fixture-media-send').evaluate(button => button.remove());
  await holdStickerCommand('sendSticker'); await sendCard().click();
  await expect.poll(() => app.evaluate(() => Boolean(globalThis.heldStickerCommand))).toBe(true);
  const beforePickerUnconfirmed = await remote.evaluate(() => window.fixtureStickerSent.length);
  await nativeStickerPicker.getByTestId('sticker-item').evaluate(item => {
    const button = item.closest('[role="button"], button');
    button.onclick = () => { window.fixtureStickerSent.push({ source: item.querySelector('img').src, peer: '123456@c.us' }); };
  });
  await releaseStickerCommand();
  await expect.poll(stickerState, { timeout: 8000 }).toMatchObject({ route: 'picker', state: 'failed', sent: 'unknown' });
  expect(await remote.evaluate(() => window.fixtureStickerSent.length)).toBe(beforePickerUnconfirmed + 1);
  await expect(stickerPanel.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  await expect(stickerPanel.getByRole('button', { name: 'Send still', exact: true })).toHaveCount(0);
  await local.keyboard.press('Escape');
  console.log('PASS a picker activation without a confirming outgoing sticker reports unknown');
  // Static indexed bytes use the maker with an empty composer even if no picker item is loaded.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.on('companion:event', (_event, value) => { if (value.type === 'snapshot') globalThis.stickerSnapshot = value.snapshot; });
  });
  await remote.evaluate(() => {
    window.fixtureHideSticker = true;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#9966cc'; ctx.fillRect(0, 0, 64, 64);
    const img = document.createElement('img'); img.id = 'fixture-static-maker'; img.alt = 'sticker'; img.width = 64; img.src = canvas.toDataURL('image/webp'); document.querySelector('.messages').append(img);
  });
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).state.stickers.length).toBe(2);
  const staticMakerId = (await local.evaluate(() => window.companion.status())).state.stickers.find(s => s.id !== firstStickerId).id;
  const staticMakerCard = stickerPanel.locator(`[data-sticker="${staticMakerId}"]`);
  const makerSend = () => staticMakerCard.getByRole('button', { name: 'Send to Alex', exact: true });
  const makerReady = async (button = makerSend()) => {
    // These scenarios use a settled composer; emptiness selects maker, drafts
    // select picker. Destination availability alone does not prove readiness.
    await expect(editor).toBeVisible();
    await remote.waitForTimeout(550);
    // Presentation may hold chat.ready during maker teardown. Wait for the
    // actual connector snapshot used by main's route selection at click time.
    await expect.poll(() => app.evaluate(() => ({ open: globalThis.stickerSnapshot?.conversationOpen, ready: globalThis.stickerSnapshot?.ready }))).toEqual({ open: true, ready: true });
    // Main also owns the cancelled editor's remaining mount/cleanup window.
    // Wait for its send gate, rather than inferring teardown from chat readiness.
    await expect.poll(async () => (await local.evaluate(() => window.companion.status())).chat, { message: 'Maker cleanup releases Send', timeout: 8000 }).toMatchObject({ canSendSticker: true, ready: true });
    // status() reads main directly; wait for the chosen control's update too.
    await expect(button).toBeVisible();
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
  };
  const startMaker = async (button = makerSend()) => {
    await makerReady(button);
    const previousNonce = (await stickerState())?.nonce;
    await button.click();
    await expect.poll(async () => {
      const status = await local.evaluate(() => window.companion.status());
      return { nonce: status.stickerSend?.nonce, state: status.stickerSend?.state, chat: status.chat, message: status.message };
    }, { message: 'A trusted maker click starts a new send' }).not.toMatchObject({ nonce: previousNonce });
    return (await stickerState()).nonce;
  };
  // Drafts use the original native item and never open the maker.
  await editor.fill('Keep this unsent sticker draft');
  const staticDraftMarkup = await editor.evaluate(element => element.innerHTML);
  const staticDraftCounters = await remote.evaluate(() => [window.fixtureAttachClicks || 0, window.fixtureMakerOpens, window.fixtureMakerAssignments, window.fixtureMakerSent.length]);
  const originalPickerSource = await remote.evaluate(() => window.fixtureStickerSource);
  await remote.evaluate(() => { window.fixtureStickerSource = document.querySelector('#fixture-static-maker').src; window.fixtureHideSticker = false; });
  const staticPickerNonce = await startMaker();
  await expect.poll(stickerState, { timeout: 8000 }).toMatchObject({ nonce: staticPickerNonce, route: 'picker', animated: false, state: 'sent', sent: 'confirmed' });
  expect(await editor.evaluate(element => element.innerHTML)).toBe(staticDraftMarkup);
  expect(await remote.evaluate(() => [window.fixtureAttachClicks || 0, window.fixtureMakerOpens, window.fixtureMakerAssignments, window.fixtureMakerSent.length])).toEqual(staticDraftCounters);
  await remote.evaluate(source => { window.fixtureStickerSource = source; window.fixtureHideSticker = true; }, originalPickerSource);
  const staticMissNonce = await startMaker();
  await expect.poll(stickerState, { timeout: 8000 }).toMatchObject({ nonce: staticMissNonce, route: 'picker', state: 'failed', reason: 'draft', detail: 'draft-present', sent: 'not-sent' });
  expect(await editor.evaluate(element => element.innerHTML)).toBe(staticDraftMarkup);
  await expect(stickerPanel.locator('.sticker-message .msg p')).toHaveText('Send or clear your draft first, then send the sticker.');
  await expect(stickerLive).toHaveText('Send or clear your draft first, then send the sticker.');
  await expect(stickerPanel.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  await expect(stickerPanel.getByRole('button', { name: 'Send still', exact: true })).toHaveCount(0);
  await local.keyboard.press('Escape'); await editor.fill('');
  console.log('PASS static with a draft uses the picker; found sends and missing shows a draft row without touching the draft');
  // A visible chat with no composer is available, but emptiness is uncertain.
  // Static sends must use the native picker without opening the maker.
  const composerlessCounters = await remote.evaluate(() => [window.fixtureMakerOpens, window.fixtureMakerAssignments, window.fixtureMakerSent.length, window.fixtureSent.length]);
  const composerlessSendsBefore = await remote.evaluate(() => window.fixtureStickerSent.length);
  try {
    await remote.evaluate(() => {
      window.fixtureStickerSource = document.querySelector('#fixture-static-maker').src;
      window.fixtureHideSticker = false; window.fixtureComposerPresent(false);
    });
    await expect(editor).toHaveCount(0);
    await expect.poll(async () => (await local.evaluate(() => window.companion.status())).chat).toMatchObject({ name: 'Alex', ready: false, canSendSticker: true });
    await expect(makerSend()).not.toHaveAttribute('aria-disabled', 'true');
    await expect(stickerPanel.locator('.hint')).not.toContainText('Open a chat to send');
    await makerSend().click();
    await expect.poll(stickerState, { timeout: 8000 }).toMatchObject({ id: staticMakerId, route: 'picker', animated: false, state: 'sent', sent: 'confirmed' });
    expect(await remote.evaluate(() => window.fixtureStickerSent.length)).toBe(composerlessSendsBefore + 1);
    expect(await remote.evaluate(() => [window.fixtureMakerOpens, window.fixtureMakerAssignments, window.fixtureMakerSent.length, window.fixtureSent.length])).toEqual(composerlessCounters);
    await expect(nativeStickerPicker).toHaveCount(0);
  } finally {
    await remote.evaluate(source => {
      window.fixtureComposerPresent(true); window.fixtureStickerSource = source; window.fixtureHideSticker = true;
    }, originalPickerSource);
  }
  await expect(editor).toBeVisible(); await expect(editor).toHaveText('');
  await makerReady();
  console.log('PASS a visible chat with a missing composer stays available and routes static through the picker');
  const controlsBounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[1].getBounds());
  const shieldStatus = async () => (await local.evaluate(() => window.companion.status())).stickerShield;
  const originalControlsBounds = await controlsBounds();
  const assertShieldCleared = async () => {
    await expect.poll(shieldStatus).toBeNull();
    await expect(local.locator('.shield')).toHaveCount(0);
    await expect.poll(controlsBounds).toEqual(originalControlsBounds);
  };
  // Sample actual Chromium drawing frames, including the frame before any
  // resize event is delivered to React. This also catches absent fast shields.
  const startMakerFrames = async () => {
    await local.evaluate(() => {
      window.makerFrames = [];
      const sample = () => {
        const panel = document.querySelector('.app-frame'), shield = document.querySelector('.shield');
        const sends = [...document.querySelectorAll('.sticker .send')];
        window.makerFrames.push({ width: innerWidth, left: panel.getBoundingClientRect().left, panelWidth: panel.getBoundingClientRect().width,
          shield: Boolean(shield), noChat: Boolean(document.querySelector('.hint')?.textContent.includes('Open a chat to send')) || sends.some(button => button.getAttribute('aria-label') === 'Open a chat to send'),
          leaving: shield?.hasAttribute('data-leaving') ?? false,
          sending: Boolean([...document.querySelectorAll('.sticker-overlay')].some(overlay => overlay.textContent.includes('Sending…'))) || Boolean(document.querySelector('.hint')?.textContent.includes('Sending…')) });
        window.makerFrameRequest = requestAnimationFrame(sample);
      };
      window.makerFrameRequest = requestAnimationFrame(sample);
    });
    await remote.evaluate(() => {
      window.makerHeaderFrames = [];
      // The remote view can stop receiving animation frames while covered by
      // the shield. Sample DOM transitions too, so editor coverage cannot vanish.
      const sample = () => window.makerHeaderFrames.push({ visible: Boolean(document.querySelector('#main header #companion-chat-settings')),
        editor: Boolean(document.querySelector('#fixture-sticker-editor')) });
      sample();
      window.makerHeaderTimer = setInterval(sample, 20);
      window.makerHeaderObserver = new MutationObserver(sample);
      window.makerHeaderObserver.observe(document.body, { childList: true, subtree: true });
    });
  };
  const assertMakerFrames = async () => {
    const frames = await local.evaluate(() => { cancelAnimationFrame(window.makerFrameRequest); return window.makerFrames; });
    const header = await remote.evaluate(() => { clearInterval(window.makerHeaderTimer); window.makerHeaderObserver.disconnect(); return window.makerHeaderFrames; });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.some(frame => frame.width > originalControlsBounds.width + 1)).toBe(true);
    expect(frames.filter(frame => frame.noChat)).toEqual([]);
    expect(header.length).toBeGreaterThan(0);
    expect(header.filter(sample => sample.editor).length).toBeGreaterThan(0);
    expect(header.filter(sample => !sample.visible)).toEqual([]);
    for (const frame of frames) {
      const expanded = frame.width > originalControlsBounds.width + 1;
      expect(frame.left + originalControlsBounds.x).toBe(originalControlsBounds.x);
      expect(frame.panelWidth).toBe(originalControlsBounds.width);
      if (expanded) expect(frame.shield).toBe(true);
      if (frame.leaving) expect(frame.sending).toBe(false);
    }
  };
  const makerCountBefore = await remote.evaluate(() => window.fixtureMakerSent.length);
  const messagesBeforeMaker = await remote.locator('[data-testid="sticker-container"]').count();
  const allSendsBeforeMaker = await remote.evaluate(() => window.fixtureStickerSent.length);
  // Baseline: native keydowns reach WhatsApp's page while no maker send owns input.
  await remote.evaluate(() => {
    window.nativeKeydowns = 0;
    if (!window.nativeKeydownCounter) { window.nativeKeydownCounter = true; window.addEventListener('keydown', event => { if (event.isTrusted) window.nativeKeydowns++; }, true); }
  });
  await remote.getByRole('textbox', { name: 'Type a message' }).evaluate(element => element.focus());
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].contentView.children[0].webContents;
    contents.focus(); contents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' }); contents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' });
  });
  await expect.poll(() => remote.evaluate(() => window.nativeKeydowns), { timeout: 3000 }).toBeGreaterThan(0);
  await holdStickerCommand('makeSticker');
  await makerReady();
  await remote.evaluate(() => { window.fixtureStickerEditorDelay = 1500; window.fixtureStickerSpinnerDelay = 1000; });
  const railNonce = await startMaker();
  await expect.poll(() => app.evaluate(() => Boolean(globalThis.heldStickerCommand))).toBe(true);
  await expect.poll(stickerState).toMatchObject({ state: 'preparing', route: 'maker', animated: false });
  const activeShield = await shieldStatus();
  expect(activeShield.nonce).toBe(railNonce);
  expect(activeShield.panel).toEqual(originalControlsBounds);
  expect(activeShield.image).toMatch(/^data:image\/jpeg;base64,/);
  expect(activeShield.image.length).toBeLessThan(1_400_000);
  const windowBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.getBounds());
  expect(activeShield.bounds).toEqual({ x: originalControlsBounds.x + originalControlsBounds.width, y: 0, width: windowBounds.width - originalControlsBounds.x - originalControlsBounds.width, height: windowBounds.height });
  await expect.poll(controlsBounds).toEqual({ x: originalControlsBounds.x, y: 0, width: windowBounds.width - originalControlsBounds.x, height: windowBounds.height });
  await expect(local.locator('.shield')).toBeVisible();
  await expect(stickerPanel).toHaveCSS('width', `${originalControlsBounds.width}px`);
  await expect(staticMakerCard.getByRole('button', { name: 'Cancel sending', exact: true })).toHaveCount(0);
  await expect(staticMakerCard.getByRole('button', { name: 'Sending sticker…', exact: true })).toBeFocused();
  await expect(stickerLive).toHaveText('Sending sticker…');
  const dispatchNativeKey = () => app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].contentView.children[0].webContents;
    contents.focus();
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'X' });
    // sendInputEvent dispatches raw events; text insertion needs a char event.
    contents.sendInputEvent({ type: 'char', keyCode: 'x' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'X' });
  });
  // Count trusted keydowns that actually reach WhatsApp's page; main's
  // before-input-event block stops them before the page sees them.
  await remote.evaluate(() => {
    window.nativeKeydowns = 0;
    if (!window.nativeKeydownCounter) { window.nativeKeydownCounter = true; window.addEventListener('keydown', event => { if (event.isTrusted) window.nativeKeydowns++; }, true); }
  });
  await editor.evaluate(element => element.focus());
  await dispatchNativeKey();
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(await remote.evaluate(() => window.nativeKeydowns)).toBe(0);
  await expect(editor).toHaveText('');
  // Main moves focus back to the controls on the remote view's focus event.
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.isFocused()), { timeout: 2000 }).toBe(false);
  // Native views do not pass pointer events through transparent HTML. Assert
  // the entire rail stays outside the controls bounds, then exercise its click.
  const railBounds = await remote.locator('nav.rail').boundingBox();
  expect(railBounds.x + railBounds.width).toBeLessThanOrEqual((await controlsBounds()).x);
  await remote.evaluate(() => {
    window.makerRailClicks = 0;
    document.querySelector('[data-navbar-item][aria-label="Chats"]').addEventListener('click', event => {
      if (event.isTrusted) window.makerRailClicks++;
    }, { once: true });
  });
  await remote.getByRole('button', { name: 'Chats', exact: true }).click();
  expect(await remote.evaluate(() => window.makerRailClicks)).toBe(1);
  // Native navigation closes Companion's panel and revokes a preparing send.
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).panel).toBeNull();
  await expect.poll(stickerState).toMatchObject({ nonce: railNonce, route: 'maker', state: 'cancelled' });
  await assertShieldCleared();
  // Deliver the held command followed by its queued cancellation before
  // checking cleanup or starting another maker operation.
  await releaseStickerCommand();
  await expect(remote.locator('#fixture-attach-menu, #fixture-sticker-editor, #fixture-sticker-discard')).toHaveCount(0);
  await expect(nativeStickerPicker).toHaveCount(0);
  expect(await stickerState()).toMatchObject({ nonce: railNonce, state: 'cancelled' });
  expect(await remote.evaluate(() => window.fixtureMakerSent.length)).toBe(makerCountBefore);
  expect(await remote.evaluate(() => window.fixtureStickerSent.length)).toBe(allSendsBeforeMaker);
  await expect(remote.locator('[data-testid="sticker-container"]')).toHaveCount(messagesBeforeMaker);
  expect(await remote.evaluate(() => window.fixtureSent.length)).toBe(textSendsBeforeStickers);
  expect(await remote.evaluate(() => window.fixtureMediaSent)).toBe(0);
  await expect(editor).toHaveText('');
  await expect.poll(async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.focus());
    return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.isFocused());
  }).toBe(true);
  await remote.evaluate(() => { window.nativeKeydowns = 0; });
  await editor.evaluate(element => element.focus());
  await dispatchNativeKey();
  await expect.poll(() => remote.evaluate(() => window.nativeKeydowns), { timeout: 3000 }).toBeGreaterThan(0);
  await editor.fill('');
  console.log('PASS maker keyboard input is blocked and remote focus excluded until cancellation, then keyboard input resumes');
  console.log('PASS WhatsApp navigation rail remains uncovered and clickable during the maker shield');

  // The cancelled ticket cannot drive the editor/spinner/send checks. Reopen
  // the panel and sample only this fresh send's shield show/hide frames.
  await openPanel('stickers');
  await holdStickerCommand('makeSticker');
  await startMakerFrames(); const makerNonce = await startMaker();
  expect(makerNonce).not.toBe(railNonce);
  await expect.poll(() => app.evaluate(() => Boolean(globalThis.heldStickerCommand))).toBe(true);
  await expect.poll(stickerState).toMatchObject({ nonce: makerNonce, route: 'maker', state: 'preparing' });
  await expect(local.locator('.shield')).toBeVisible();
  await releaseStickerCommand();
  await expect(remote.locator('#fixture-sticker-editor [data-testid="loading-spinner"]')).toBeVisible();
  const nativeEditorSend = remote.locator('#fixture-sticker-editor div[role="button"][aria-label="Send 1 selected"]');
  await expect(nativeEditorSend).toBeVisible();
  expect(await remote.evaluate(() => window.fixtureMakerSent.length)).toBe(makerCountBefore);
  await expect.poll(stickerState, { timeout: 8000 }).toMatchObject({ id: staticMakerId, nonce: makerNonce, route: 'maker', animated: false, state: 'sent' });
  expect(await remote.evaluate(() => Boolean(window.fixtureMakerSentDuringLoading))).toBe(false);
  expect(await remote.evaluate(() => window.fixtureMakerSent.length)).toBe(makerCountBefore + 1);
  expect(await remote.evaluate(() => window.fixtureStickerSent.length)).toBe(allSendsBeforeMaker + 1);
  await expect(remote.locator('[data-testid="sticker-container"]')).toHaveCount(messagesBeforeMaker + 1);
  await assertShieldCleared();
  await remote.waitForTimeout(850);
  await assertMakerFrames();
  await remote.evaluate(() => { window.fixtureStickerEditorDelay = 0; window.fixtureStickerSpinnerDelay = 0; });
  console.log('PASS maker send preserves chat readiness and header; panel stays fixed on every shield show/hide frame');
  expect(await remote.evaluate(() => window.fixturePhotoAssignments)).toBe(0);
  expect(await remote.evaluate(() => ({ assignments: window.fixtureUnrelatedImageAssignments, files: document.querySelector('#fixture-unrelated-image-input').files.length, menuRetained: Boolean(document.querySelector('#fixture-unrelated-menu[hidden]')) }))).toEqual({ assignments: 0, files: 0, menuRetained: true });
  const storedStatic = (await local.evaluate(() => window.companion.status())).state.stickers.find(s => s.id === staticMakerId).image;
  expect(await remote.evaluate(async () => {
    const file = window.fixtureMakerSent.at(-1).file;
    return 'data:image/webp;base64,' + btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
  })).toBe(storedStatic);
  await expect(editor).toHaveText('');
  await expect(nativeStickerPicker).toHaveCount(0);
  console.log('PASS static stored WebP uses the New sticker route without a loaded native picker item; decoy never receives files; composer stays empty');

  await makerReady(); await startMakerFrames();
  const fastNonce = await startMaker();
  await expect.poll(stickerState).toMatchObject({ nonce: fastNonce, state: 'sent' });
  await assertShieldCleared(); await remote.waitForTimeout(850); await assertMakerFrames();
  console.log('PASS a fast maker send never enlarges the controls without a mounted shield');

  // A filtered-out sender uses the same ready destination presentation.
  await remote.evaluate(() => { window.fixtureStickerEditorDelay = 1500; });
  await makerReady(); await startMakerFrames(); const filteredNonce = await startMaker();
  await stickerPanel.getByRole('textbox', { name: 'Search stickers', exact: true }).fill('no matching sticker');
  await expect(stickerPanel.locator('.hint')).toContainText('Sending…');
  await expect.poll(stickerState).toMatchObject({ nonce: filteredNonce, state: 'sent' });
  await expect(stickerPanel.locator('.hint')).toContainText('Sent to Alex');
  await expect(stickerPanel.locator('.hint')).not.toContainText('Open a chat to send');
  await assertShieldCleared(); await remote.waitForTimeout(850); await assertMakerFrames();
  await stickerPanel.getByRole('textbox', { name: 'Search stickers', exact: true }).fill('');
  await expect(stickerSearch).toHaveValue('');
  await expect(staticMakerCard).toBeVisible();
  await remote.evaluate(() => { window.fixtureStickerEditorDelay = 0; });
  console.log('PASS a filtered-out maker result says Sent to Alex without a no-chat hint');

  await remote.evaluate(() => { window.fixtureStickerTypedAfterSend = 'New text entered meanwhile'; });
  const appearedNonce = await startMaker();
  await expect.poll(stickerState, { timeout: 8000 }).toMatchObject({ nonce: appearedNonce, state: 'failed', reason: 'draft', detail: 'draft-appeared', sent: 'unknown' });
  await assertShieldCleared();
  await expect(editor).toHaveText('New text entered meanwhile');
  await expect(stickerPanel.locator('.sticker-message .msg p')).toHaveText('Couldn’t confirm the sticker was sent. Check the chat before sending again.');
  await expect(stickerLive).toHaveText('Couldn’t confirm the sticker was sent. Check the chat before sending again.');
  await expect(stickerPanel.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  await expect(stickerPanel.getByRole('button', { name: 'Send still', exact: true })).toHaveCount(0);
  await remote.evaluate(() => { window.fixtureStickerTypedAfterSend = ''; });
  await local.keyboard.press('Escape'); await editor.fill('');
  console.log('PASS a draft appearing after maker activation stays untouched and reports unknown without a retry action');

  for (const toggle of ['fixtureNoStickerEditor', 'fixtureStickerEditorWithoutSend', 'fixtureStickerCaption', 'fixtureStickerSpinnerDelay', 'fixtureStickerSendUnconfirmed']) {
    await makerReady(); await remote.evaluate(toggle => { window[toggle] = toggle === 'fixtureStickerSpinnerDelay' ? -1 : true; window.fixtureStickerDiscardDelay = 150; window.fixtureStickerClearDraftOnDiscard = true; }, toggle);
    const before = await remote.evaluate(() => window.fixtureMakerSent.length);
    const discardsBefore = await remote.evaluate(() => window.fixtureMakerDiscards || 0);
    if (toggle === 'fixtureStickerSendUnconfirmed') await startMakerFrames();
    const started = Date.now(), nonce = await startMaker();
    // Preparation is bounded to 5 s plus the snapshot's 1.2 s cap; an
    // uncertain click keeps its separate 4 s confirmation window.
    const unconfirmed = toggle === 'fixtureStickerSendUnconfirmed';
    await expect.poll(stickerState, { message: `Maker result for ${toggle}`, timeout: 8000, intervals: [100] }).toMatchObject({ nonce, state: 'failed', reason: unconfirmed ? 'unconfirmed' : 'editor-unavailable' });
    expect(Date.now() - started).toBeLessThan(8000);
    expect(await remote.evaluate(() => window.fixtureMakerSent.length)).toBe(before + (toggle === 'fixtureStickerSendUnconfirmed' ? 1 : 0));
    await remote.waitForTimeout(300);
    expect(await remote.evaluate(() => window.fixtureMakerSent.length)).toBe(before + (toggle === 'fixtureStickerSendUnconfirmed' ? 1 : 0));
    await expect(remote.locator('#fixture-sticker-editor')).toHaveCount(0);
    await expect(remote.locator('#fixture-sticker-discard')).toHaveCount(0);
    expect(await remote.evaluate(() => window.fixtureMakerDiscards || 0)).toBe(discardsBefore + (['fixtureStickerEditorWithoutSend', 'fixtureStickerCaption', 'fixtureStickerSpinnerDelay'].includes(toggle) ? 1 : 0));
    expect(await remote.evaluate(() => window.fixtureMakerCancelDiscards || 0)).toBe(0);
    await expect(editor).toHaveText('');
    await assertShieldCleared();
    if (unconfirmed) await assertMakerFrames();
    await remote.evaluate(toggle => { window[toggle] = false; window.fixtureStickerDiscardDelay = 0; window.fixtureStickerClearDraftOnDiscard = false; }, toggle);
    if (toggle === 'fixtureStickerSendUnconfirmed') {
      await expect(stickerPanel.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
      await expect(stickerPanel.getByRole('button', { name: 'Send still', exact: true })).toHaveCount(0);
      await expect(stickerPanel.locator('.sticker-message .msg p').filter({ hasText: /^Couldn[’']t confirm the sticker was sent\. Check the chat before sending it again\.$/ })).toBeVisible();
      await local.keyboard.press('Escape');
      await expect(stickerPanel.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0);
      await expect(stickerPanel).toBeVisible();
      await expect(makerSend()).toBeFocused();
    } else {
      await expect(stickerPanel.locator('.sticker-message .msg p').filter({ hasText: 'WhatsApp didn’t open its sticker editor. Nothing was sent.' }), `Failure row for ${toggle}`).toBeVisible();
      const tryAgain = stickerPanel.getByRole('button', { name: 'Try again', exact: true });
      await expect(tryAgain).toBeVisible();
      await local.keyboard.press('Escape');
      await expect(tryAgain).toHaveCount(0);
      await expect(stickerPanel).toBeVisible();
      if (toggle === 'fixtureNoStickerEditor') {
        await makerReady(); await remote.evaluate(() => { window.fixtureNoStickerEditor = true; });
        const nonce = await startMaker();
        await expect.poll(stickerState, { timeout: 8000, intervals: [100] }).toMatchObject({ nonce, state: 'failed', reason: 'editor-unavailable' });
        await remote.evaluate(() => { window.fixtureNoStickerEditor = false; });
        const failedNonce = (await stickerState()).nonce;
        const retryNonce = await startMaker(tryAgain);
        await expect.poll(stickerState, { timeout: 8000 }).toMatchObject({ id: staticMakerId, nonce: retryNonce, route: 'maker', state: 'sent' });
        expect((await stickerState()).nonce).not.toBe(failedNonce);
        expect(await remote.evaluate(() => window.fixtureMakerSent.length)).toBe(before + 1);
        await assertShieldCleared();
      }
    }
  }
  console.log('PASS unavailable/unsafe maker editors close; an uncertain click is unconfirmed and is never retried');

  const beforePreparingCancel = await remote.evaluate(() => window.fixtureMakerSent.length);
  const beforePreparingAssignments = await remote.evaluate(() => window.fixtureMakerAssignments);
  await makerReady(); await remote.evaluate(() => { window.fixtureStickerEditorDelay = 2000; window.fixtureStickerDiscardDelay = 200; });
  const preparingNonce = await startMaker(); await expect.poll(stickerState).toMatchObject({ nonce: preparingNonce, state: 'preparing' });
  await expect(local.locator('.shield')).toBeVisible();
  await expect.poll(() => remote.evaluate(() => window.fixtureMakerAssignments)).toBe(beforePreparingAssignments + 1);
  await expect(staticMakerCard.getByRole('button', { name: 'Cancel sending', exact: true })).toHaveCount(0);
  await local.keyboard.press('Escape');
  await expect.poll(stickerState).toMatchObject({ nonce: preparingNonce, state: 'cancelled' });
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).chat).toMatchObject({ canSendSticker: false, stickerSendBlockedReason: 'busy' });
  await expect(staticMakerCard.getByRole('button', { name: 'Wait for the current sticker', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await assertShieldCleared();
  expect(await remote.evaluate(() => window.fixtureMakerSent.length)).toBe(beforePreparingCancel);
  await remote.waitForTimeout(2200); await expect(remote.locator('#fixture-sticker-editor')).toHaveCount(0);
  await expect(remote.locator('#fixture-sticker-discard')).toHaveCount(0);
  await expect(editor).toHaveText('');

  const changedChatNonce = await startMaker(); await expect.poll(stickerState).toMatchObject({ nonce: changedChatNonce, state: 'preparing' });
  await expect(local.locator('.shield')).toBeVisible();
  await expect.poll(() => remote.evaluate(() => window.fixtureMakerAssignments)).toBe(beforePreparingAssignments + 2);
  await remote.evaluate(() => document.querySelector('#group').click());
  await expect.poll(stickerState).toMatchObject({ nonce: changedChatNonce, state: 'cancelled', reason: 'chat-changed' });
  await assertShieldCleared();
  expect(await remote.evaluate(() => window.fixtureMakerSent.length)).toBe(beforePreparingCancel);
  await remote.waitForTimeout(2200); await expect(remote.locator('#fixture-sticker-editor')).toHaveCount(0);
  await expect(remote.locator('#fixture-sticker-discard')).toHaveCount(0);
  expect(await remote.evaluate(() => window.fixtureMakerCancelDiscards || 0)).toBe(0);
  await remote.evaluate(() => { window.fixtureStickerEditorDelay = 0; window.fixtureStickerDiscardDelay = 0; window.fixtureHideSticker = false; });
  await remote.getByRole('button', { name: /^Alex/ }).click(); await makerReady(); await editor.fill('');
  // Revoke an already mounted/loading editor, so chat-change cleanup exercises
  // its Close -> Discard transition rather than only a late file load.
  await remote.evaluate(() => { window.fixtureStickerSpinnerDelay = -1; window.fixtureStickerDiscardDelay = 150; window.fixtureStickerClearDraftOnDiscard = true; });
  const mountedChatNonce = await startMaker();
  await expect(remote.locator('#fixture-sticker-editor [data-testid="loading-spinner"]')).toBeVisible();
  const mountedDiscardsBefore = await remote.evaluate(() => window.fixtureMakerDiscards || 0);
  await remote.evaluate(() => document.querySelector('#group').click());
  await expect.poll(stickerState).toMatchObject({ nonce: mountedChatNonce, state: 'cancelled', reason: 'chat-changed' });
  await expect(remote.locator('#fixture-sticker-editor, #fixture-sticker-discard')).toHaveCount(0);
  expect(await remote.evaluate(() => window.fixtureMakerDiscards || 0)).toBe(mountedDiscardsBefore + 1);
  expect(await remote.evaluate(() => window.fixtureMakerCancelDiscards || 0)).toBe(0);
  expect(await remote.evaluate(() => window.fixtureMakerSent.length)).toBe(beforePreparingCancel);
  await expect(editor).toHaveText('');
  await assertShieldCleared();
  await remote.evaluate(() => { window.fixtureStickerSpinnerDelay = 0; window.fixtureStickerDiscardDelay = 0; window.fixtureStickerClearDraftOnDiscard = false; });
  await remote.getByRole('button', { name: /^Alex/ }).click(); await makerReady(); await editor.fill('');
  await holdStickerCommand('makeSticker'); const cappedNonce = await startMaker();
  await expect.poll(() => app.evaluate(() => Boolean(globalThis.heldStickerCommand))).toBe(true);
  await expect(local.locator('.shield')).toBeVisible();
  await expect.poll(shieldStatus, { timeout: 11_000, intervals: [100] }).toBeNull();
  expect(await stickerState()).toMatchObject({ nonce: cappedNonce, state: 'preparing' });
  await assertShieldCleared();
  await local.keyboard.press('Escape');
  await expect.poll(stickerState).toMatchObject({ nonce: cappedNonce, state: 'cancelled' });
  await releaseStickerCommand();
  expect(await remote.evaluate(() => window.fixtureMakerSent.length)).toBe(beforePreparingCancel);
  console.log('PASS the main-process shield cap restores the native controls bounds while preparation remains cancellable');
  // Opt-in direct route: the existing off-mode scenarios above remain native.
  expect((await local.evaluate(() => window.companion.status())).state.global.directStickerSend).toBe(false);
  expect(await remote.evaluate(() => window.fixtureDirectSent.length)).toBe(0);
  await local.evaluate(() => window.companion.action({ type: 'panel', panel: 'settings' }));
  const directToggle = local.getByLabel('Send stickers directly (experimental)', { exact: true });
  const assertDirectPreference = async (enabled, page = local) => {
    await expect.poll(async () => (await page.evaluate(() => window.companion.status())).state.global.directStickerSend).toBe(enabled);
    await expect(page.getByLabel('Send stickers directly (experimental)', { exact: true })).toBeEnabled();
    expect(JSON.parse(await readFile(join(dir, 'companion.json'), 'utf8')).global.directStickerSend).toBe(enabled);
  };
  await expect(directToggle).not.toBeChecked(); await assertDirectPreference(false);
  await directToggle.check(); await expect(directToggle).toBeChecked(); await assertDirectPreference(true);
  await directToggle.uncheck(); await expect(directToggle).not.toBeChecked(); await assertDirectPreference(false);
  await directToggle.check(); await expect(directToggle).toBeChecked(); await assertDirectPreference(true);
  console.log('PASS direct sticker opt-in reflects off/on/off clicks immediately and persists each change');
  await local.evaluate(() => window.companion.action({ type: 'panel', panel: 'stickers' }));
  const directUiCounters = await remote.evaluate(() => [window.fixtureAttachClicks || 0, window.fixtureMakerOpens, window.fixtureMakerAssignments, window.fixtureMakerSent.length]);
  for (const [stickerId, animated] of [[staticMakerId, false], [firstStickerId, true]]) {
    const saved = (await local.evaluate(() => window.companion.status())).state.stickers.find(s => s.id === stickerId);
    await editor.fill('Keep this direct sticker draft'); const markup = await editor.evaluate(el => el.innerHTML);
    const button = stickerId === staticMakerId ? makerSend() : sendCard();
    await makerReady(button); await button.click();
    await expect.poll(stickerState).toMatchObject({ id: stickerId, route: 'direct', animated, state: 'sent', sent: 'confirmed' });
    expect(await editor.evaluate(el => el.innerHTML)).toBe(markup);
    expect(await remote.evaluate(async () => {
      const file = window.fixtureDirectSent.at(-1).file, bytes = new Uint8Array(await file.arrayBuffer());
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      return 'data:image/webp;base64,' + btoa(binary);
    })).toBe(saved.image);
    expect(await remote.evaluate(() => window.fixtureDirectSent.at(-1).isAnimated)).toBe(animated);
    expect(await remote.evaluate(() => [window.fixtureAttachClicks || 0, window.fixtureMakerOpens, window.fixtureMakerAssignments, window.fixtureMakerSent.length])).toEqual(directUiCounters);
    await expect(nativeStickerPicker).toHaveCount(0); await expect(remote.locator('#fixture-sticker-editor')).toHaveCount(0);
    await assertShieldCleared();
  }
  console.log('PASS opt-in static and animated sends use original bytes directly, preserve drafts, and open no picker/editor/shield');
  // Module loss can fall back before any upload. Preserve existing draft policy.
  await remote.evaluate(source => { window.fixtureDirectModulesMissing = true; window.fixtureHideSticker = false; window.fixtureStickerSource = source; }, originalPickerSource);
  const directUploadsBeforeFallback = await remote.evaluate(() => window.fixtureDirectUploads.length);
  await makerReady(sendCard()); await sendCard().click();
  await expect.poll(stickerState).toMatchObject({ route: 'picker', state: 'sent' });
  await expect(editor).toHaveText('Keep this direct sticker draft');
  await editor.fill(''); await makerReady(); await makerSend().click();
  await expect.poll(stickerState, { timeout: 8000 }).toMatchObject({ route: 'maker', state: 'sent' });
  expect(await remote.evaluate(() => window.fixtureDirectUploads.length)).toBe(directUploadsBeforeFallback);
  await assertShieldCleared();
  console.log('PASS missing direct modules fall back to picker with a draft and maker with an empty composer');
  await remote.evaluate(() => { window.fixtureDirectModulesMissing = false; window.fixtureDirectSwitchDuringUpload = true; });
  const directSendsBeforeSwitch = await remote.evaluate(() => window.fixtureDirectSent.length);
  await makerReady(); await makerSend().click();
  await expect.poll(stickerState).toMatchObject({ route: 'direct', state: 'failed', reason: 'chat-changed', sent: 'not-sent' });
  expect(await remote.evaluate(() => window.fixtureDirectSent.length)).toBe(directSendsBeforeSwitch);
  await remote.evaluate(() => { window.fixtureDirectSwitchDuringUpload = false; window.fixtureHideSticker = true; });
  await remote.getByRole('button', { name: /^Alex/ }).click();
  await local.evaluate(() => window.companion.action({ type: 'panel', panel: 'settings' }));
  await directToggle.uncheck(); await expect(directToggle).not.toBeChecked(); await assertDirectPreference(false);
  await local.evaluate(() => window.companion.action({ type: 'panel', panel: 'stickers' }));
  await editor.fill(''); await makerReady(); await makerSend().click();
  await expect.poll(stickerState, { timeout: 8000 }).toMatchObject({ route: 'maker', state: 'sent' });
  expect(await remote.evaluate(() => window.fixtureDirectSent.length)).toBe(directSendsBeforeSwitch);
  await assertShieldCleared();
  console.log('PASS switching chat during direct upload sends nothing; disabling the setting restores native routing');
  // Safety stops persist and explain themselves in the existing Settings hint.
  await local.evaluate(() => window.companion.action({ type: 'panel', panel: 'settings' }));
  const assertSafetyStop = async (reason, line) => {
    await assertDirectPreference(false);
    const global = (await local.evaluate(() => window.companion.status())).state.global;
    expect(global.directStickerDisabledReason).toBe(reason);
    expect(global.directStickerDisabledAt).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(join(dir, 'companion.json'), 'utf8')).global).toMatchObject(global);
    await expect(local.getByText(`Turned off automatically: ${line}`, { exact: true })).toBeVisible();
  };
  await directToggle.check(); await assertDirectPreference(true);
  await remote.evaluate(() => window.fixtureSetQrScreen(true));
  await assertSafetyStop('logged-out', 'WhatsApp logged out.');
  await remote.evaluate(() => window.fixtureSetQrScreen(false));
  // Let the connector publish that the safety screen has gone before re-enable.
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).chat.ready).toBe(true);
  await directToggle.check(); await assertDirectPreference(true);
  expect((await local.evaluate(() => window.companion.status())).state.global.directStickerDisabledReason).toBeUndefined();
  await remote.evaluate(() => window.fixtureSetAccountWarning(true, 'Sua conta restrita'));
  await assertSafetyStop('account-warning', 'WhatsApp showed an account warning.');
  // Re-enable while the warning remains visible must stop again, releasing the toggle.
  // The stop unchecks it again immediately, so click rather than check() (which insists it stays checked).
  await directToggle.click(); await assertSafetyStop('account-warning', 'WhatsApp showed an account warning.');
  await remote.evaluate(() => window.fixtureSetAccountWarning(false));
  await remote.waitForTimeout(400);
  await directToggle.check(); await assertDirectPreference(true);
  expect((await local.evaluate(() => window.companion.status())).state.global.directStickerDisabledAt).toBeUndefined();
  console.log('PASS QR/logout and account-warning screens persist safety stops; re-enable clears the reason');
  await local.evaluate(() => window.companion.action({ type: 'panel', panel: 'stickers' }));
  await remote.evaluate(source => { window.fixtureHideSticker = false; window.fixtureStickerSource = source; }, originalPickerSource);
  await editor.fill('Preserve the draft at the direct rate cap');
  const cappedSendsBefore = await remote.evaluate(() => window.fixtureDirectSent.length);
  let rateFallback = false;
  // Earlier sends may still occupy the same rolling window. Eleven rapid new
  // clicks must reach fallback, without waiting for any direct-send cooldown.
  for (let i = 0; i < 11; i++) {
    const previousNonce = (await stickerState())?.nonce;
    await makerReady(sendCard()); await sendCard().click();
    await expect.poll(async () => {
      const current = await stickerState();
      return current?.nonce === previousNonce ? null : current;
    }).toMatchObject({ state: 'sent', sent: 'confirmed' });
    if ((await stickerState()).route === 'picker') { rateFallback = true; break; }
    expect((await stickerState()).route).toBe('direct');
  }
  expect(rateFallback).toBe(true);
  expect((await remote.evaluate(() => window.fixtureDirectSent.length)) - cappedSendsBefore).toBeLessThanOrEqual(10);
  await expect(editor).toHaveText('Preserve the draft at the direct rate cap');
  const directRecords = (await readFile(join(dir, 'diagnostics', 'sticker-sends.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(directRecords.some(record => record.route === 'direct' && record.outcome === 'fallback' && record.code === 'rate-limit')).toBe(true);
  expect((await local.evaluate(() => window.companion.status())).state.global.directStickerSend).toBe(true);
  await local.evaluate(() => window.companion.action({ type: 'panel', panel: 'settings' }));
  await directToggle.uncheck(); await assertDirectPreference(false);
  await local.evaluate(() => window.companion.action({ type: 'panel', panel: 'stickers' }));
  await editor.fill('');
  console.log('PASS the direct rate cap immediately routes the next sticker through the native picker');
  // Remove only this disposable index entry and its fixture images so the later
  // restart/delta checks still exercise the original single saved sticker.
  await remote.locator('#fixture-static-maker').evaluate(img => img.remove()).catch(() => {});
  expect((await local.evaluate(id => window.companion.action({ type: 'forgetSticker', id }), staticMakerId)).ok).toBe(true);
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).state.stickers.length).toBe(1);
  console.log('PASS maker preparing can be cancelled, including a late editor mount, and chat changes revoke it');
  await expect(editor).toHaveText(''); await editor.fill('');
  console.log('PASS maker results, explicit retry, Escape dismissal, and shield cleanup match the direct-send UI');
  await local.screenshot({ path: '.local/screenshots/stickers.png' });
  await remote.screenshot({ path: '.local/screenshots/whatsapp-view.png' });
  const capture = await app.evaluate(async ({ desktopCapturer }) => (await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 1024 } }))[0].thumbnail.toPNG().toString('base64'));
  await writeFile('.local/screenshots/desktop.png', Buffer.from(capture, 'base64'));
  await stickerPanel.getByRole('button', { name: 'Close panel', exact: true }).click();
  // Sticker sends use Alex; restore the group for scoped settings, Style's
  // group-to-Alex switch and the automatic-reply scenarios below.
  await remote.getByRole('button', { name: 'Weekend plans', exact: false }).click();
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).chat).toMatchObject({ name: 'Weekend plans', chatId: '999999@g.us', settingsId: '999999@g.us', ready: true, loadedSentSamples: 0 });
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), originalSize);
  await expect.poll(async () => (await geometry()).size).toEqual(originalSize);
  await local.evaluate(() => {
    window.transientChecks = [];
    window.companion.subscribe(update => window.transientChecks.push({ includesState: Object.hasOwn(update, 'state'), bytes: JSON.stringify(update).length }));
  });
  await editor.fill('Typing after indexing stickers');
  await expect.poll(async () => local.evaluate(() => window.transientChecks.length)).toBeGreaterThan(0);
  expect(await local.evaluate(() => window.transientChecks.every(update => !update.includesState && update.bytes < 5000))).toBe(true);
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).state.stickers.length).toBe(1);
  await editor.fill('');
  console.log('PASS typing sends small status deltas and retains the cached sticker library');
  await openPanel('chat');
  await section('Replies');
  await local.getByLabel('Tone', { exact: false }).selectOption('professional');
  await expect(local.getByText('Custom for this chat', { exact: true })).toBeVisible();
  await local.getByRole('button', { name: 'Reset all to global settings' }).click();
  await expect(local.getByLabel('Tone', { exact: false })).toHaveValue('natural');
  console.log('PASS settings inheritance and reset in renderer');
  await local.evaluate(() => window.companion.action({ type: 'profile', scope: 'general', description: 'Approved general punctuation.' }));
  await section('Style');
  await expect(local.getByLabel('Match my writing style', { exact: false })).toHaveValue('off');
  await expect(local.getByText('Style matching is off.', { exact: true })).toBeVisible();
  await expect(local.getByText(/sparse history/)).toHaveCount(0);
  await expect(local.getByLabel('Selected examples')).toBeHidden();
  await expect(local.getByTestId('style-history')).toContainText('5 needed');
  await expect(local.getByRole('button', { name: 'Learn from this chat', exact: true })).toBeDisabled();
  await local.screenshot({ path: '.local/screenshots/style-empty.png' });
  await remote.evaluate(() => { for (const text of ['Thanks for checking', 'See you soon', 'That sounds good', 'Let me have a look', 'I will let you know']) window.add(text, true); });
  await expect(local.getByRole('button', { name: 'Learn from this chat', exact: true })).toBeEnabled();
  await local.getByRole('button', { name: 'Learn from this chat', exact: true }).click();
  await expect(local.getByText('View or edit saved style', { exact: true })).toBeVisible();
  await expect(local.getByLabel('Match my writing style', { exact: false })).toHaveValue('off');
  await local.getByLabel('Match my writing style', { exact: false }).selectOption('conversation');
  await expect(local.getByText('Using the style saved for this chat.', { exact: true })).toBeVisible();
  await local.getByText('View or edit saved style', { exact: true }).click();
  await expect(local.getByRole('textbox', { name: 'Writing traits', exact: true })).not.toHaveValue('');
  await local.getByRole('button', { name: 'Reset profile and stop learning' }).click();
  await expect(local.getByText('No style learned for this chat yet. Using your general style for now.', { exact: true })).toBeVisible();
  await local.getByLabel('Learn automatically from my messages', { exact: false }).click();
  await expect(local.getByLabel('Learn automatically from my messages', { exact: false })).toBeChecked();
  await expect(local.getByText('Using the style saved for this chat.', { exact: true })).toBeVisible();
  await local.screenshot({ path: '.local/screenshots/style-chat.png' });
  expect(await local.evaluate(() => window.companion.action({ type: 'preferences', scope: '999999@g.us', patch: { tone: 'professional' } }))).toMatchObject({ ok: true });
  await local.getByRole('button', { name: 'Use global style settings', exact: true }).click();
  await expect(local.getByLabel('Match my writing style', { exact: false })).toHaveValue('off');
  expect((await local.evaluate(() => window.companion.status())).state.chats['999999@g.us']).toEqual({ tone: 'professional' });
  expect(await local.evaluate(() => window.companion.action({ type: 'resetPreferences', scope: '999999@g.us' }))).toMatchObject({ ok: true });
  console.log('PASS Style explains loaded history, learns directly, enables explicitly, and resets only style inheritance');
  await local.getByText('Add examples manually', { exact: true }).click();
  await local.getByLabel('Selected examples').fill('Private group example one\nPrivate group example two\nPrivate group example three\nPrivate group example four\nPrivate group example five');
  await remote.getByRole('button', { name: /^Alex/ }).click();
  await expect(local.locator('aside')).toBeHidden();
  await openPanel('chat'); await section('Style');
  await expect(local.getByLabel('Selected examples')).toBeHidden();
  await local.getByText('Add examples manually', { exact: true }).click();
  await expect(local.getByLabel('Selected examples')).toHaveValue('');
  await expect(local.getByRole('button', { name: 'Learn from examples', exact: true })).toBeDisabled();
  expect((await local.evaluate(() => window.companion.status())).state.profiles.general.description).toBe('Approved general punctuation.');
  await remote.getByRole('button', { name: 'Weekend plans', exact: false }).click();
  await expect(local.locator('aside')).toBeHidden();
  await openPanel('chat'); await section('Style');
  await expect(local.getByLabel('Selected examples')).toBeHidden();
  await local.getByText('Add examples manually', { exact: true }).click();
  await expect(local.getByLabel('Selected examples')).toHaveValue('');
  const staleLearn = await local.evaluate(() => window.companion.action({ type: 'learn', scope: 'general', examples: '', sourceChatId: '123456@c.us' }));
  expect(staleLearn).toMatchObject({ ok: false });
  expect((await local.evaluate(() => window.companion.status())).state.profiles.general.description).toBe('Approved general punctuation.');
  console.log('PASS chat switches clear scoped examples without altering the approved general profile');
  await openPanel('settings'); await section('Style');
  await expect(local.getByRole('combobox', { name: 'Match my writing style', exact: true })).toHaveValue('off');
  await expect(local.getByRole('button', { name: 'Learn general style from this chat', exact: true })).toBeVisible();
  await expect(local.getByText('Use global style settings', { exact: true })).toHaveCount(0);
  await expect(local.getByLabel('Selected examples')).toBeHidden();
  await local.getByText('View or edit saved style', { exact: true }).click();
  await expect(local.getByRole('textbox', { name: 'Writing traits', exact: true })).toHaveValue('Approved general punctuation.');
  await local.screenshot({ path: '.local/screenshots/style-global.png' });
  await openPanel('chat');
  console.log('PASS global Style keeps general profile controls separate from conversation overrides');
  await section('Auto replies');
  await expect(local.getByLabel('Allow automatic replies in this chat')).not.toBeChecked();
  console.log('PASS automatic replies initially off');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(880, 620));
  const untilPicker = local.getByRole('combobox', { name: /^Until hour/ });
  await untilPicker.click(); await local.keyboard.press('End');
  await expect(untilPicker.locator('option[value="23"]')).toBeInViewport();
  await local.screenshot({ path: '.local/screenshots/dropdown-hours.png' });
  await local.keyboard.press('Enter'); await expect(untilPicker).toHaveValue('23');
  await untilPicker.click(); await local.keyboard.press('Tab');
  expect(await untilPicker.evaluate(e => e.matches(':open'))).toBe(false);
  expect(await local.locator('aside').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), originalSize);
  console.log('PASS long dropdown scrolls to last option, closes on Tab and fits a small window');
  const fixtureCheck = await local.evaluate(() => window.companion.action({ type: 'testProvider' }));
  expect(fixtureCheck.ok).toBe(true);
  await expect(statusText).toHaveText('Demo provider check passed locally. No network request was made.');
  console.log('PASS demo provider check needs no key and performs no real call');
  await local.getByLabel('From hour').selectOption('0');
  await local.getByLabel('Until hour').selectOption('0');
  await local.getByLabel('Cancellation window in seconds').selectOption('15');
  await local.getByLabel('Allow automatic replies in this chat').click();
  await expect(local.getByLabel('Allow automatic replies in this chat')).toBeChecked();
  const rapid = await local.evaluate(() => Promise.all([
    window.companion.action({ type: 'autoPermission', chatId: '999999@g.us', permission: 'pause' }),
    window.companion.action({ type: 'autoRules', chatId: '999999@g.us', patch: { dailyLimit: 3 } })
  ]));
  expect(rapid.every(result => result.ok)).toBe(true);
  await expect(local.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await expect(local.getByLabel('Daily reply limit')).toHaveValue('3');
  expect((await local.evaluate(() => window.companion.status())).state.auto['999999@g.us'].paused).toBe(true);
  await local.getByRole('button', { name: 'Resume', exact: true }).click();
  console.log('PASS rapid pause and rule edit remain paused until explicit resume');
  const armForLocalActivity = async text => {
    expect((await local.evaluate(() => window.companion.action({ type: 'autoPermission', chatId: '999999@g.us', permission: 'resume' }))).ok).toBe(true);
    await remote.evaluate(text => window.add(text), text);
    await expect.poll(async () => Boolean((await local.evaluate(() => window.companion.status())).pending)).toBe(true);
  };
  const expectLocalPause = async () => {
    await expect.poll(async () => Boolean((await local.evaluate(() => window.companion.status())).pending)).toBe(false);
    expect((await local.evaluate(() => window.companion.status())).state.auto['999999@g.us'].paused).toBe(true);
  };
  await armForLocalActivity('Synthetic arrival before local navigation');
  await section('Replies'); await expectLocalPause();
  const language = local.getByLabel('Language', { exact: false }); await language.focus();
  await armForLocalActivity('Synthetic arrival before local typing');
  await language.pressSequentially(' Spanish'); await expectLocalPause();
  const localPanel = await local.locator('aside').boundingBox();
  await local.mouse.move(localPanel.x + 20, localPanel.y + 200);
  await armForLocalActivity('Synthetic arrival before local scrolling');
  await local.mouse.wheel(0, 80); await expectLocalPause();
  await section('Auto replies');
  await local.getByRole('button', { name: 'Resume', exact: true }).click();
  console.log('PASS local tab navigation, typing and scrolling each cancel and pause automatic replies');
  await local.getByLabel('Close panel').click();
  await remote.evaluate(() => window.add('A synthetic incoming message for automatic dispatch'));
  await expect.poll(async () => Boolean((await local.evaluate(() => window.companion.status())).pending)).toBe(true);
  const messageBounds = await remote.locator('.messages').boundingBox();
  await remote.mouse.move(messageBounds.x + 20, messageBounds.y + 20);
  await remote.mouse.wheel(0, 10);
  await expect.poll(async () => Boolean((await local.evaluate(() => window.companion.status())).pending)).toBe(false);
  expect((await local.evaluate(() => window.companion.status())).state.auto['999999@g.us'].paused).toBe(true);
  console.log('PASS even a small wheel gesture pauses and cancels an automatic reply');
  await armForLocalActivity('Synthetic arrival before the inline Cancel control');
  const cancelFooter = await remote.locator('#main footer').boundingBox();
  const cancelPoint = { x: (await remote.evaluate(() => innerWidth)) - 100, y: cancelFooter.y - 19 };
  await expect.poll(() => remote.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, cancelPoint)).toBe('companion-navigation');
  const sentBeforeCancel = (await remote.evaluate(() => window.fixtureSent)).length;
  await remote.mouse.click(cancelPoint.x, cancelPoint.y);
  await expectLocalPause();
  expect((await remote.evaluate(() => window.fixtureSent)).length).toBe(sentBeforeCancel);
  console.log('PASS inline Cancel pauses an automatic reply through the trusted navigation control');
  await armForLocalActivity('Synthetic arrival before keyboard activation of the native sticker picker');
  const nativePicker = remote.getByRole('button', { name: 'Emojis, GIFs, Stickers', exact: true });
  await nativePicker.focus(); await nativePicker.press('Enter');
  await expectLocalPause();
  await remote.evaluate(() => document.querySelector('[data-testid="expressions-panel"]')?.remove());
  console.log('PASS keyboard activation of native controls pauses automatic replies');
  await openPanel('chat');
  await section('Auto replies');
  await local.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(local.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await local.keyboard.press('Escape');
  await expect(local.locator('aside')).toBeHidden();
  expect((await local.evaluate(() => window.companion.status())).state.auto['999999@g.us'].paused).toBe(false);
  console.log('PASS Escape closes chat settings without undoing explicit Resume');
  await remote.evaluate(() => window.add('A second synthetic incoming message after explicit resume'));
  await expect.poll(async () => (await remote.evaluate(() => window.fixtureSent)).at(-1), { timeout: 25000 }).toBe('Sounds good, see you then!');
  console.log('PASS explicitly armed automatic reply dispatches through the fixture composer');
  await remote.evaluate(() => {
    window.add('A synthetic question using the current WhatsApp markup');
    document.querySelector('.sidebar').id = 'pane-side'; document.querySelector('#group').setAttribute('aria-selected', 'true');
    document.querySelector('#main header span').setAttribute('data-testid', 'conversation-info-header-chat-title');
    document.querySelectorAll('#main [data-id]').forEach((node, index) => {
      const direction = document.createElement('span'); direction.dataset.icon = node.dataset.id.startsWith('true_') ? 'tail-out' : 'tail-in'; node.append(direction);
      node.dataset.id = `OPAQUE${index}ABC`; node.dataset.testid = `conv-msg-${node.dataset.id}`;
    });
    const editor = document.querySelector('[role=textbox]'); editor.setAttribute('aria-placeholder', 'Type a message');
  });
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).chat).toMatchObject({ chatId: null, kind: 'unknown', ready: true });
  await editor.click(); await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  const sentBeforeModern = (await remote.evaluate(() => window.fixtureSent)).length;
  await editor.press('Tab'); await expect(editor).toHaveText('Sounds good, see you then!');
  expect((await remote.evaluate(() => window.fixtureSent)).length).toBe(sentBeforeModern);
  await editor.fill('');
  console.log('PASS current WhatsApp opaque message IDs allow global suggestions and Tab acceptance without sending');
  const modernChat = (await local.evaluate(() => window.companion.status())).chat.settingsId;
  expect(modernChat).toMatch(/^local:/);
  await openPanel('chat'); await section('Replies');
  await local.getByLabel('Tone', { exact: false }).selectOption('friendly');
  await expect(local.getByText('Custom for this chat', { exact: true })).toBeVisible();
  await local.getByLabel('Reply length', { exact: false }).selectOption('detailed');
  await local.screenshot({ path: '.local/screenshots/chat-overrides.png' });
  await local.getByLabel('Close panel').click();
  await openPanel('settings'); await section('Replies');
  await expect(local.getByLabel('Tone', { exact: false })).toHaveValue('natural');
  await local.getByLabel('Tone', { exact: false }).selectOption('professional');
  await local.getByLabel('Close panel').click();
  await openPanel('chat'); await section('Replies');
  await expect(local.getByLabel('Tone', { exact: false })).toHaveValue('friendly');
  await local.getByLabel('Close panel').click();
  const modernHtml = await remote.locator('.messages').innerHTML();
  await remote.getByRole('button', { name: /^Alex/ }).click();
  await openPanel('chat'); await section('Replies');
  await expect(local.getByLabel('Tone', { exact: false })).toHaveValue('professional');
  const stale = await local.evaluate(id => window.companion.action({ type: 'preferences', scope: id, patch: { tone: 'direct' } }), modernChat);
  expect(stale.ok).toBe(false); expect(stale.error).toContain('conversation changed');
  await local.getByLabel('Close panel').click();
  await remote.evaluate(html => { document.querySelector('.messages').innerHTML = html; document.querySelector('#main header span').textContent = 'Renamed conversation'; }, modernHtml);
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).chat.settingsId).toBe(modernChat);
  await openPanel('chat'); await section('Replies');
  await expect(local.getByLabel('Tone', { exact: false })).toHaveValue('friendly');
  await local.getByRole('button', { name: 'Reset all to global settings', exact: true }).click();
  await expect(local.getByLabel('Tone', { exact: false })).toHaveValue('professional');
  await local.getByLabel('Reply length', { exact: false }).selectOption('detailed');
  await local.getByLabel('Close panel').click();
  console.log('PASS modern per-chat overrides isolate chats, follow global defaults, reject stale saves and survive renaming');
  await openPanel('settings');
  await remote.getByRole('button', { name: 'Chats', exact: true }).click();
  await expect(local.locator('aside')).toBeHidden();
  console.log('PASS native WhatsApp navigation closes the settings overlay');

  await remote.evaluate(() => {
    const photo = document.createElement('div'); photo.className = 'message';
    photo.dataset.id = 'OPAQUEPHOTO123'; photo.dataset.testid = 'conv-msg-OPAQUEPHOTO123';
    photo.innerHTML = '<span data-icon="tail-in"></span><div data-testid="image-thumb" style="width:160px;height:100px;background:#bdd7cb" aria-label="Synthetic image"></div>';
    document.querySelector('.messages').replaceChildren(photo);
  });
  await editor.click(); await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  await editor.press('Tab'); await expect(editor).toHaveText('Sounds good, see you then!');
  expect((await remote.evaluate(() => window.fixtureSent)).length).toBe(sentBeforeModern);
  await editor.fill('');
  console.log('PASS image-only conversation generates an inline draft without sending');
  await app.evaluate(({ ipcMain }) => { ipcMain.on('companion:event', (_event, value) => { if (value.type === 'snapshot') globalThis.attributionSnapshot = value.snapshot; }); });
  await remote.evaluate(() => {
    document.querySelector('.messages').innerHTML = '<div data-id="MUM_PHOTO" data-testid="conv-msg-MUM_PHOTO"><div data-testid="msg-container"><span data-testid="author">Mum</span><div data-testid="image-thumb" style="height:90px"></div></div></div><div data-id="SIBLING_PRAISE" data-testid="conv-msg-SIBLING_PRAISE"><div data-testid="msg-container"><span data-testid="author">Brother</span><div data-testid="quoted-message"><span data-testid="author">Mum</span><span data-testid="selectable-text">A few photos</span><div data-testid="image-thumb"></div></div><span data-testid="selectable-text">Lovely photos</span></div></div>';
  });
  await expect.poll(() => app.evaluate(() => globalThis.attributionSnapshot?.messages)).toEqual([
    { id: 'MUM_PHOTO', sender: 'Mum', outgoing: false, text: '', attachment: 'image' },
    { id: 'SIBLING_PRAISE', sender: 'Brother', outgoing: false, text: 'Lovely photos', quoted: { text: 'A few photos', sender: 'Mum', attachment: 'image' } }
  ]);
  expect(await app.evaluate(() => globalThis.attributionSnapshot.kind)).toBe('group');
  await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  await editor.click(); await editor.press('Tab'); await expect(editor).toHaveText('Sounds good, see you then!'); await editor.fill('');
  await remote.evaluate(() => { document.querySelector('[data-id="SIBLING_PRAISE"] [data-testid="author"]').textContent = 'Another participant'; });
  await expect.poll(() => app.evaluate(() => globalThis.attributionSnapshot?.messages.at(-1)?.sender)).toBe('Another participant');
  expect((await remote.evaluate(() => window.fixtureSent)).length).toBe(sentBeforeModern);
  console.log('PASS group/quote attribution reaches main and Tab accepts the validated suggestion without sending');
  await remote.evaluate(() => {
    document.querySelector('.messages').innerHTML = '<div data-id="DIEGO_DOCUMENT" data-testid="conv-msg-DIEGO_DOCUMENT"><div data-testid="msg-container"><span data-testid="author">Diego</span><div data-testid="document-thumb" title="View file"><div data-testid="image-thumb"></div><span dir="auto">Outdoor article.pdf</span><span data-testid="type">PDF</span></div></div></div><div data-id="DIEGO_CAPTION" data-testid="conv-msg-DIEGO_CAPTION"><div data-testid="msg-container"><span data-testid="author">Diego</span><span data-testid="selectable-text">Salimos en el mercurio</span></div></div><div data-id="GIORGIO_REPLY" data-testid="conv-msg-GIORGIO_REPLY"><div data-testid="msg-container"><span data-testid="author">Giorgio</span><div data-testid="quoted-message"><span data-testid="author">Diego</span><div data-testid="document-thumb"><span dir="auto">Outdoor article.pdf</span></div></div><span data-testid="selectable-text">Se pasooo</span></div></div>';
  });
  await expect.poll(() => app.evaluate(() => globalThis.attributionSnapshot?.messages)).toEqual([
    { id: 'DIEGO_DOCUMENT', sender: 'Diego', outgoing: false, text: '', attachment: 'document', attachmentName: 'Outdoor article.pdf' },
    { id: 'DIEGO_CAPTION', sender: 'Diego', outgoing: false, text: 'Salimos en el mercurio' },
    { id: 'GIORGIO_REPLY', sender: 'Giorgio', outgoing: false, text: 'Se pasooo', quoted: { text: '', sender: 'Diego', attachment: 'document', attachmentName: 'Outdoor article.pdf' } }
  ]);
  await expect(statusText).toHaveText('Tab to accept · Esc to dismiss');
  await editor.click(); await editor.press('Tab'); await expect(editor).toHaveText('Sounds good, see you then!'); await editor.fill('');
  expect((await remote.evaluate(() => window.fixtureSent)).length).toBe(sentBeforeModern);
  console.log('PASS PDF filenames and quoted files reach main; Tab accepts the validated suggestion without sending');

  await local.evaluate(() => window.companion.action({ type: 'panel', panel: null }));
  await remote.locator('#friend').click();
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).chat.chatId).toBe('123456@c.us');
  await expect.poll(async () => (await local.evaluate(() => window.companion.status())).chat.ready).toBe(true);
  expect(await local.evaluate(async () => {
    const preferences = await window.companion.action({ type: 'preferences', scope: '123456@c.us', patch: { shareContext: true, suggestions: false } });
    const rules = await window.companion.action({ type: 'autoRules', chatId: '123456@c.us', patch: { startHour: 0, endHour: 0, delaySeconds: 15 } });
    const permission = await window.companion.action({ type: 'autoPermission', chatId: '123456@c.us', permission: 'enable' });
    return [preferences, rules, permission].every(result => result.ok);
  })).toBe(true);
  await app.evaluate(({ BrowserWindow }) => {
    const remote = BrowserWindow.getAllWindows()[0].contentView.children[0].webContents;
    globalThis.releaseHeldAuto = () => { remote.send = original; original('companion:command', globalThis.heldAuto); };
    const original = remote.send.bind(remote);
    remote.send = (channel, ...args) => {
      if (channel === 'companion:command' && args[0]?.type === 'autoSend') { globalThis.heldAuto = args[0]; return; }
      return original(channel, ...args);
    };
  });
  await remote.evaluate(() => window.add('Synthetic message before a local pause overtakes queued dispatch'));
  await expect.poll(() => app.evaluate(() => Boolean(globalThis.heldAuto)), { timeout: 25000, intervals: [50] }).toBe(true);
  const countBeforeHeld = (await remote.evaluate(() => window.fixtureSent)).length;
  expect((await local.evaluate(() => window.companion.action({ type: 'autoPermission', chatId: '123456@c.us', permission: 'pause' }))).ok).toBe(true);
  await app.evaluate(() => globalThis.releaseHeldAuto());
  await expect(editor).toHaveText('Sounds good, see you then!');
  await remote.waitForTimeout(250); // Allow the final authorization round trip to complete.
  expect((await remote.evaluate(() => window.fixtureSent)).length).toBe(countBeforeHeld);
  expect((await local.evaluate(() => window.companion.status())).state.auto['123456@c.us'].paused).toBe(true);
  await editor.fill('');
  console.log('PASS a queued send rechecks main permission and cannot overtake a pause from local controls');

  await local.evaluate(() => window.companion.action({ type: 'panel', panel: 'settings' }));
  await directToggle.check(); await expect(directToggle).toBeChecked(); await assertDirectPreference(true);
  expect(await local.evaluate(async () => window.companion.action({ type: 'preferences', scope: 'global',
    patch: { language: (await window.companion.status()).state.global.language } }))).toMatchObject({ ok: true });
  await expect(directToggle).toBeChecked(); await assertDirectPreference(true);
  await app.close(); app = undefined;
  app = await electron.launch({ chromiumSandbox: true, args: [resolve('.'), '--fixture', `--data-dir=${dir}`], timeout: 30000 });
  await expect.poll(async () => (await app.windows()).some(p => p.url().endsWith('/ui/index.html'))).toBe(true);
  const reopened = (await app.windows()).find(p => p.url().endsWith('/ui/index.html'));
  await reopened.evaluate(() => window.companion.action({ type: 'panel', panel: 'stickers' }));
  await expect(reopened.getByRole('complementary', { name: 'Sticker library', exact: true }).getByRole('group', { name: 'happy, feliz, thanks, gracias, good morning friend, buenos días amigo', exact: true })).toBeVisible();
  console.log('PASS metadata persists across actual application restart');
  const reopenedState = (await reopened.evaluate(() => window.companion.status())).state;
  expect(reopenedState.reasoning.openai).toMatchObject({ 'gpt-6-astra': 'max', 'gpt-6-luna': 'none' });
  console.log('PASS reasoning preferences persist across actual application restart');
  expect(reopenedState.global.directStickerSend).toBe(true);
  await reopened.evaluate(() => window.companion.action({ type: 'panel', panel: 'settings' }));
  await expect(reopened.getByLabel('Send stickers directly (experimental)', { exact: true })).toBeChecked();
  await assertDirectPreference(true, reopened);
  console.log('PASS direct sticker opt-in survives unrelated preference patches and actual application restart');
  await reopened.getByLabel('Close panel').click();
  const remoteReopened = (await app.windows()).find(p => p.url().endsWith('fixture.html'));
  await remoteReopened.evaluate(html => { document.querySelector('.messages').innerHTML = html; }, modernHtml);
  await expect.poll(async () => (await reopened.evaluate(() => window.companion.status())).chat.settingsId).toBe(modernChat);
  await remoteReopened.locator('#companion-chat-settings').click();
  await reopened.getByRole('button', { name: 'Replies', exact: true }).click();
  await expect(reopened.getByLabel('Reply length', { exact: false })).toHaveValue('detailed');
  await expect(reopened.getByLabel('Tone', { exact: false })).toHaveValue('professional');
  console.log('PASS modern chat recognition and overrides persist across an actual application restart');

  await reopened.evaluate(() => window.companion.action({ type: 'panel', panel: 'settings' }));
  const restoredDirectToggle = reopened.getByLabel('Send stickers directly (experimental)', { exact: true });
  await restoredDirectToggle.uncheck(); await expect(restoredDirectToggle).not.toBeChecked();
  await assertDirectPreference(false, reopened);
  await app.close(); app = undefined;
  app = await electron.launch({ chromiumSandbox: true, args: [resolve('.'), '--fixture', `--data-dir=${dir}`], timeout: 30000 });
  await expect.poll(async () => (await app.windows()).some(p => p.url().endsWith('/ui/index.html'))).toBe(true);
  const disabledReopened = (await app.windows()).find(p => p.url().endsWith('/ui/index.html'));
  await disabledReopened.evaluate(() => window.companion.action({ type: 'panel', panel: 'settings' }));
  await expect(disabledReopened.getByLabel('Send stickers directly (experimental)', { exact: true })).not.toBeChecked();
  await assertDirectPreference(false, disabledReopened);
  console.log('PASS disabling direct sticker sending also persists across an actual application restart');

} catch (error) {
  if (app) { const pages = await app.windows(); for (const page of pages) console.log(page.url(), (await page.locator('body').innerText()).slice(0, 2500)); }
  throw error;
} finally {
  await app?.close(); await rm(dir, { recursive: true, force: true });
}
