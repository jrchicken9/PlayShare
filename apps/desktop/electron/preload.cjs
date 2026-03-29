/**
 * Preload: expose a small, versioned bridge for the renderer (no Node in UI).
 */
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  channel: 'playshare-desktop-v2',
  platform: process.platform,
  arch: process.arch,

  /**
   * @param {{ wsUrl: string, action: 'create' | 'join' | 'pair', username?: string, roomCode?: string, hostUsername?: string, guestUsername?: string, timeoutMs?: number }} payload
   */
  signalSmokeTest: (payload) => ipcRenderer.invoke('playshare:signal-smoke-test', payload),

  signalConnect: (payload) => ipcRenderer.invoke('playshare:signal-connect', payload),
  signalDisconnect: () => ipcRenderer.invoke('playshare:signal-disconnect'),
  signalLeaveRoom: () => ipcRenderer.invoke('playshare:signal-leave-room'),
  signalSend: (msg) => ipcRenderer.invoke('playshare:signal-send', msg),
  signalGetState: () => ipcRenderer.invoke('playshare:signal-state'),
  sessionSetWatch: (meta) => ipcRenderer.invoke('playshare:session-set-watch', meta),
  openExternal: (payload) => ipcRenderer.invoke('playshare:open-external', payload)
};

ipcRenderer.on('playshare:signal-frame', (_e, msg) => {
  window.dispatchEvent(new CustomEvent('playshare-signal-frame', { detail: msg }));
});

ipcRenderer.on('playshare:signal-status', (_e, patch) => {
  window.dispatchEvent(new CustomEvent('playshare-signal-status', { detail: patch }));
});

contextBridge.exposeInMainWorld('playshareDesktop', api);
