import { _electron as electron } from '@playwright/test';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const timedOutApps = new WeakSet();
const closeTimeout = 30000;

async function printStartupTail(dataDir) {
  const path = join(dataDir, 'diagnostics/startup.log');
  try { console.error(`TAIL ${path}\n${(await readFile(path, 'utf8')).trimEnd().split('\n').slice(-60).join('\n')}`); }
  catch (error) { console.error(`TAIL ${path}: ${error.code ?? error.message}`); }
}

export async function launchApp(options, dataDir) {
  try { return await electron.launch({ ...options, timeout: 30000 }); }
  catch (error) { await printStartupTail(dataDir); throw error; }
}

export async function closeApp(app, dataDir, label) {
  if (!app || timedOutApps.has(app)) return;
  const hang = new Error(`HANG closeApp ${label} after ${closeTimeout / 1000}s`);
  let timer;
  try {
    await Promise.race([Promise.resolve().then(() => app.close()), new Promise((_, reject) => { timer = setTimeout(() => reject(hang), closeTimeout); })]);
  } catch (error) {
    if (error !== hang) throw error;
    timedOutApps.add(app);
    console.error(hang.message);
    await printStartupTail(dataDir);
    const child = app.process();
    let alive = false;
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(child.pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') console.error(error); }
    }
    console.error(`Electron main PID ${child.pid}, alive=${alive}`);
    if (alive) {
      try { console.error(`SIGKILL Electron main PID ${child.pid}: ${child.kill('SIGKILL')}`); }
      catch (error) { console.error(`SIGKILL failed: ${error.message}`); }
    }
    throw hang;
  } finally { clearTimeout(timer); }
}

export async function preserveDiagnostics(dataDir, label) {
  const target = join('.local/desktop-diagnostics', label);
  try {
    await mkdir('.local/desktop-diagnostics', { recursive: true });
    await cp(join(dataDir, 'diagnostics'), target, { recursive: true });
    console.error(`Saved desktop diagnostics: ${target}`);
  } catch (error) { if (error.code !== 'ENOENT') console.error(`Could not save ${label} diagnostics: ${error.message}`); }
}
