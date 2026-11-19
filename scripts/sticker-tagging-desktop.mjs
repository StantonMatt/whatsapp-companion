import { expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { launchApp, closeApp, preserveDiagnostics, enableFixtureAi } from './desktop-harness.mjs';

export async function runStickerTaggingDesktop() {
  const scratch = process.env.COMPANION_TEST_SCRATCH ?? join(process.env.HOME, '.cache/agent-scratch/whatsapp-companion');
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, 'tagging-desktop-'));
  let app;
  let failed = false;
  const step = what => console.log(`${new Date().toISOString()} STEP tagging: ${what}`);
  const launch = async (partial = false, seed = false) => {
    step(seed ? 'seed launch' : partial ? 'partial launch' : 'launch');
    app = await launchApp({ chromiumSandbox: true, args: [resolve('.'), '--fixture', ...(seed ? ['--fixture-startup-watchdog'] : []), ...partial ? ['--fixture-tag-partial'] : [], `--data-dir=${dir}`], timeout: 30000, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } }, dir);
    await expect.poll(async () => (await app.windows()).some(p => p.url().endsWith('/ui/index.html'))).toBe(true);
    return (await app.windows()).find(p => p.url().endsWith('/ui/index.html'));
  };
  try {
    let local = await launch(false, true);
    const state = (await local.evaluate(() => window.companion.status())).state;
    delete state.hasForgotten; state.desktop = { notifications: 'denied' };
    step('seed close');
    await closeApp(app, dir, 'tagging seed'); app = undefined;
    const sample = JSON.parse(await readFile('tests/fixtures/sticker-dedupe/images.json', 'utf8')).original.image;
    const base = Buffer.from(sample.split(',')[1], 'base64');
    await mkdir(join(dir, 'stickers'), { recursive: true });
    state.stickers = []; state.stickerGroups = [{ id: '550e8400-e29b-41d4-a716-446655440000', name: 'Favorites' }];
    for (let i = 0; i < 24; i++) {
      // Distinct verified blobs with identical image pixels: the metadata chunk
      // makes deterministic library entries without changing the actual image.
      const chunk = Buffer.alloc(12); chunk.write('EXIF'); chunk.writeUInt32LE(4, 4); chunk.writeUInt32LE(i, 8);
      const bytes = Buffer.concat([base, chunk]); bytes.writeUInt32LE(bytes.length - 8, 4);
      const id = createHash('sha256').update(bytes).digest('hex');
      await writeFile(join(dir, 'stickers', `${id}.webp`), bytes, { mode: 0o600 });
      state.stickers.push({ id, firstSeen: 1, lastSeen: 24 - i, groups: [], kind: 'static', size: bytes.length, searchTerms: '' });
    }
    await writeFile(join(dir, 'companion.json'), JSON.stringify(state), { mode: 0o600 });
    local = await launch(true);
    await enableFixtureAi(local);
    await local.evaluate(() => window.companion.action({ type: 'panel', panel: 'stickers' }));
    let panel = local.getByRole('complementary', { name: 'Sticker library', exact: true });
    await panel.getByRole('button', { name: 'Edit stickers', exact: true }).click();
    await panel.getByRole('button', { name: 'Untagged', exact: true }).click();
    step('Tag/Stop');
    await panel.getByRole('button', { name: 'Tag 24 untagged', exact: true }).click();
    await expect(panel.getByRole('group', { name: 'Tag 24 stickers with OpenAI?', exact: true })).toBeVisible();
    await local.keyboard.press('Escape');
    await expect(panel.getByRole('group', { name: 'Tag 24 stickers with OpenAI?', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Tag 24 untagged', exact: true }).click();
    await panel.getByRole('button', { name: 'Tag', exact: true }).click();
    await expect(panel.locator('.tag-strip')).toContainText('Tagging');
    await panel.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(panel.locator('.tag-strip')).toContainText('Stopped');
    const completedBeforeStop = (await local.evaluate(() => window.companion.status())).state.stickers.filter(s => s.searchTerms).length;
    expect(completedBeforeStop).toBeLessThan(24);
    await local.waitForTimeout(750);
    expect((await local.evaluate(() => window.companion.status())).state.stickers.filter(s => s.searchTerms).length).toBe(completedBeforeStop);
    // Restart resets fixture attempt counters, preserving any results that
    // arrived before Stop. This avoids requiring cancellation to beat a clock.
    step('restart close');
    await closeApp(app, dir, 'tagging restart'); app = undefined;
    step('restart'); local = await launch(true);
    await local.evaluate(() => window.companion.action({ type: 'panel', panel: 'stickers' }));
    panel = local.getByRole('complementary', { name: 'Sticker library', exact: true });
    await panel.getByRole('button', { name: 'Edit stickers', exact: true }).click();
    await panel.getByRole('button', { name: 'Untagged', exact: true }).click();
    const remaining = 24 - completedBeforeStop;
    await panel.getByRole('button', { name: `Tag ${remaining} untagged`, exact: true }).click();
    if (remaining > 20) await panel.getByRole('button', { name: 'Tag', exact: true }).click();
    await expect.poll(async () => (await local.evaluate(() => window.companion.status())).stickerTagging?.state, { timeout: 15000 }).toBe('partial');
    await expect(panel.locator('.tag-strip')).toContainText('failed');
    step('retry');
    await panel.locator('.tag-strip').getByRole('button', { name: 'Try again', exact: true }).click();
    await expect.poll(async () => (await local.evaluate(() => window.companion.status())).state.stickers.filter(s => s.searchTerms).length, { timeout: 10000 }).toBe(24);
    await expect(panel.getByRole('button', { name: 'Untagged', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(await panel.locator('.sticker-art').count()).toBeGreaterThan(0);
    await panel.getByRole('button', { name: 'All', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Untagged', exact: true })).toHaveCount(0);
    step('editor');
    const first = panel.locator('.sticker-art').first(); await first.click();
    const detail = panel.getByRole('region', { name: 'Search terms', exact: true });
    const original = await detail.getByRole('textbox').inputValue();
    await detail.getByRole('button', { name: 'Suggest search terms', exact: true }).click();
    await expect(detail.locator('textarea')).toHaveAttribute('data-suggested', 'true');
    await detail.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(detail.getByRole('textbox')).toHaveValue(original);
    await detail.getByRole('button', { name: 'Suggest search terms', exact: true }).click();
    await expect(detail.locator('textarea')).toHaveAttribute('data-suggested', 'true');
    await detail.getByRole('textbox').fill('fixture edited suggestion, prueba');
    await detail.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(detail).toHaveCount(0);
    await expect.poll(async () => (await local.evaluate(() => window.companion.status())).state.stickers[0].searchTerms).toBe('fixture edited suggestion, prueba');
    await panel.getByRole('button', { name: 'Done', exact: true }).click();
    step('automatic setting');
    await local.evaluate(() => window.companion.action({ type: 'panel', panel: 'settings' }));
    const toggle = local.getByLabel('Tag new stickers automatically', { exact: true });
    await expect(toggle).not.toBeChecked(); await toggle.click(); await expect(toggle).toBeChecked();
    await expect(local.getByText('Sends new sticker images to OpenAI.', { exact: true })).toBeVisible();
    const remote = (await app.windows()).find(p => p.url().split('#')[0].endsWith('fixture.html'));
    await remote.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 100;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ff0011'; ctx.fillRect(0, 0, 100, 100);
      const img = document.createElement('img'); img.alt = 'sticker'; img.src = canvas.toDataURL('image/webp'); img.width = 100; document.querySelector('.messages').append(img);
    });
    await expect.poll(async () => (await local.evaluate(() => window.companion.status())).state.stickers.length, { timeout: 15000 }).toBe(25);
    await expect.poll(async () => (await local.evaluate(() => window.companion.status())).stickerTagging?.state).toBe('partial');
    await local.evaluate(() => window.companion.action({ type: 'retryStickerTags', excludedIds: [] }));
    await expect.poll(async () => (await local.evaluate(() => window.companion.status())).state.stickers.every(s => s.searchTerms.trim())).toBe(true);
    await toggle.click(); await expect(toggle).not.toBeChecked();
    await mkdir('.local/screenshots', { recursive: true });
    await local.screenshot({ path: '.local/screenshots/sticker-tagging-settings.png' });
    await local.evaluate(() => window.companion.action({ type: 'panel', panel: 'stickers' }));
    await local.screenshot({ path: '.local/screenshots/sticker-tagging.png' });
    console.log('PASS AI tagging: confirmation, Stop, batch partial/retry, Untagged, editor Save/Discard, and automatic new-only setting');
  } catch (error) { failed = true; throw error; }
  finally {
    let cleanupError;
    step('cleanup close');
    try { await closeApp(app, dir, 'tagging cleanup'); }
    catch (error) { console.error('Tagging cleanup:', error); cleanupError = error; }
    if (failed || cleanupError) await preserveDiagnostics(dir, 'tagging');
    try { await rm(dir, { recursive: true, force: true }); }
    catch (error) { console.error('Tagging data cleanup:', error); cleanupError ??= error; }
    if (!failed && cleanupError) throw cleanupError;
  }
}
