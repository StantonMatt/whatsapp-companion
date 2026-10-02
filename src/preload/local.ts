import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, StatusUpdate } from '../shared/model';
const api: DesktopAPI = {
  shieldReady: (nonce, reducedMotion) => ipcRenderer.invoke('companion:shield-ready', { nonce, reducedMotion }),
  shieldFaded: nonce => ipcRenderer.invoke('companion:shield-faded', nonce),
  status: () => ipcRenderer.invoke('companion:status'),
  models: provider => ipcRenderer.invoke('companion:models', provider),
  action: action => ipcRenderer.invoke('companion:action', action),
  subscribe: fn => {
    const listener = (_event: Electron.IpcRendererEvent, update: StatusUpdate) => fn(update);
    ipcRenderer.on('companion:status', listener);
    return () => { ipcRenderer.removeListener('companion:status', listener); };
  }
};
contextBridge.exposeInMainWorld('companion', api);
