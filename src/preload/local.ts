import { contextBridge, ipcRenderer } from 'electron';
import { StatusCache } from '../core/status';
import type { DesktopAPI, StatusUpdate } from '../shared/model';
const api: DesktopAPI = {
  shieldReady: (nonce, reducedMotion) => ipcRenderer.invoke('companion:shield-ready', { nonce, reducedMotion }),
  shieldFaded: nonce => ipcRenderer.invoke('companion:shield-faded', nonce),
  status: async () => {
    const initial = new StatusCache().accept(await ipcRenderer.invoke('companion:status'));
    if (!initial) throw new Error('Incomplete controls status.');
    return initial;
  },
  models: (provider, refresh = false) => ipcRenderer.invoke('companion:models', provider, refresh),
  action: action => ipcRenderer.invoke('companion:action', action),
  subscribe: fn => {
    const listener = (_event: Electron.IpcRendererEvent, update: StatusUpdate) => fn(update);
    ipcRenderer.on('companion:status', listener);
    ipcRenderer.send('companion:subscribe');
    return () => { ipcRenderer.removeListener('companion:status', listener); };
  }
};
contextBridge.exposeInMainWorld('companion', api);
