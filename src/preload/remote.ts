import { ipcRenderer } from 'electron';
import { DomConnector } from '../connector/dom';
import { BootDetector } from '../connector/boot';
import { bootSessionSchema, type BootSession } from '../shared/boot';
import type { RemoteCommand } from '../shared/connector';

// Isolated preload only: no contextBridge, window bindings or page-callable API.
let connector: DomConnector | undefined;
let bootSession: BootSession | undefined;
let disposed = false;
function startConnector() {
  if (disposed || connector || !bootSession) return;
  try {
    connector = new DomConnector(document, event => ipcRenderer.send('companion:event', event), nonce => ipcRenderer.invoke('companion:authorize-auto', nonce), nonce => ipcRenderer.invoke('companion:authorize-sticker', nonce));
    connector.start();
    // Load completion can precede activation by up to 20s. Main must request
    // its nonce-tagged recovery snapshot only once commands can be handled.
    ipcRenderer.send('companion:connector-ready', bootSession);
  } catch {
    try { connector?.stop(); } catch { /* Partial activation must not escape into the page. */ }
    connector = undefined; ipcRenderer.send('companion:boot-error');
  }
}
ipcRenderer.on('companion:command', (_event, command: RemoteCommand) => { if (!disposed) connector?.command(command); });
const detector = new BootDetector(document, observation => {
  if (bootSession && !disposed) ipcRenderer.send('companion:boot-heartbeat', { ...bootSession, ...observation });
}, reason => {
  if (reason === 'timeout') ipcRenderer.send('companion:boot-deferral-expired', bootSession);
  // The connector's observer needs a body; activation remains one-shot.
  if (document.body) startConnector();
  else document.addEventListener('DOMContentLoaded', startConnector, { once: true });
});
void ipcRenderer.invoke('companion:boot-session').then(raw => {
  const session = bootSessionSchema.safeParse(raw);
  if (!session.success || disposed) { detector.stop(); return; }
  bootSession = session.data;
  detector.start();
}).catch(() => { detector.stop(); if (!disposed) ipcRenderer.send('companion:boot-error'); });
window.addEventListener('beforeunload', () => {
  disposed = true; detector.stop();
  document.removeEventListener('DOMContentLoaded', startConnector);
  try { connector?.stop(); } catch { /* Main owns view disposal. */ }
}, { once: true });
