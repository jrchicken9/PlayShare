/**
 * PlayShare desktop shell — Electron main process (Windows + macOS).
 * Renderer runs sandboxed with preload-only IPC hooks for future lobby/signaling work.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { runSignalSmokeTest } = require('./signal-smoke.cjs');
const signalSession = require('./signal-session.cjs');

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 560,
    show: false,
    title: 'PlayShare',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc() {
  signalSession.registerIpc(ipcMain);

  ipcMain.handle('playshare:signal-smoke-test', async (_evt, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'Invalid payload' };
    }
    try {
      const result = await runSignalSmokeTest(payload);
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

app.whenReady().then(() => {
  registerIpc();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
