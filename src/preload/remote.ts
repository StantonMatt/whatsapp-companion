import { ipcRenderer } from 'electron';
import { DomConnector } from '../connector/dom';
import type { RemoteCommand } from '../shared/connector';

// No contextBridge, window bindings, page postMessage listener, or privileged API exposure.
window.addEventListener('DOMContentLoaded', () => {
  const connector = new DomConnector(document, event => ipcRenderer.send('companion:event', event), nonce => ipcRenderer.invoke('companion:authorize-auto', nonce), nonce => ipcRenderer.invoke('companion:authorize-sticker', nonce));
  ipcRenderer.on('companion:command', (_event, command: RemoteCommand) => connector.command(command));
  connector.start();
  window.addEventListener('beforeunload', () => connector.stop(), { once: true });
});
