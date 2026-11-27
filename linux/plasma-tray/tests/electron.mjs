import { _electron as electron, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Must run through service.py --electron under Xvfb + dbus-run-session.
// All windows/data are disposable; the remote fixture sends no messages.
const run = promisify(execFile);
const scratch = join(homedir(), '.cache/agent-scratch/whatsapp-companion');
await mkdir(scratch, { recursive: true });
const directory = await mkdtemp(join(scratch, 'plasma-reveal-'));
const env = { ...process.env, WAYLAND_DISPLAY: '' };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ chromiumSandbox: true, env, timeout: 30000,
    args: [resolve('.'), '--fixture', '--hidden', '--ozone-platform=x11', '--disable-gpu', `--data-dir=${directory}`] });
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
  await expect.poll(async () => (await app.windows()).some(page => page.url().endsWith('/fixture.html'))).toBe(true);
  const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
  expect(await visible()).toBe(false);
  const helper = join(dirname(fileURLToPath(import.meta.url)), 'reveal.py');
  for (let count = 0; count < 2; count++) {
    const result = await run('/usr/bin/python3', [helper], { env, timeout: 10000 });
    process.stdout.write(result.stdout);
    await expect.poll(visible).toBe(true);
  }
  console.log('PASS real D-Bus hidden-arm → Activate opens a hidden Electron window and leaves an already visible window shown');
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
