/**
 * Persistent PlayShare signaling WebSocket in the main process (same JSON types as server.js).
 * Forwards frames to renderer via CustomEvent dispatch from preload.
 */
const WebSocket = require('ws');
const { BrowserWindow, shell } = require('electron');

/** @type {WebSocket | null} */
let ws = null;
/** @type {string | null} */
let activeWsUrl = null;
/** @type {ReturnType<typeof setInterval> | null} */
let heartbeatTimer = null;

let connecting = false;
/** @type {string | null} */
let lastError = null;
/** @type {string | null} */
let serverInfoPublicUrl = null;

/** @type {{ inRoom: boolean, roomCode: string | null, clientId: string | null, username: string | null, isHost: boolean, members: object[] }} */
let room = {
  inRoom: false,
  roomCode: null,
  clientId: null,
  username: null,
  isHost: false,
  members: []
};

/** Local MVP metadata — not enforced by server; optional CHAT announce only. */
let watchMeta = {
  providerKey: '',
  titleNote: '',
  watchUrl: ''
};

function broadcastStatus(patch) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('playshare:signal-status', patch);
  }
}

function emitFrame(msg) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('playshare:signal-frame', msg);
  }
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'HEARTBEAT' }));
    }
  }, 25000);
}

function normalizeWsUrl(url) {
  let t = String(url || '').trim();
  if (!t) throw new Error('WebSocket URL is required');
  t = t.replace(/^\/+/, '');
  if (/^https:\/\//i.test(t)) t = `wss://${t.slice(8)}`;
  else if (/^http:\/\//i.test(t)) t = `ws://${t.slice(7)}`;
  if (!/^wss?:\/\//i.test(t)) t = `wss://${t.replace(/^\/+/, '')}`;
  let u;
  try {
    u = new URL(t);
  } catch {
    throw new Error('Invalid WebSocket URL');
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error('Invalid WebSocket URL');
  let out = `${u.protocol}//${u.host}`;
  const path = u.pathname || '/';
  if (path !== '/') out += path.replace(/\/$/, '');
  if (u.search) out += u.search;
  return out;
}

function resetRoomLocal() {
  room = {
    inRoom: false,
    roomCode: null,
    clientId: null,
    username: null,
    isHost: false,
    members: []
  };
}

function applyIncomingMessage(msg) {
  const t = msg && msg.type;
  if (t === 'SERVER_INFO') {
    serverInfoPublicUrl = msg.serverUrl || null;
    return;
  }
  if (t === 'ERROR') {
    lastError = msg.message || msg.code || 'Server error';
    broadcastStatus({ lastError });
    return;
  }
  if (t === 'ROOM_CREATED' || t === 'ROOM_JOINED') {
    lastError = null;
    room = {
      inRoom: true,
      roomCode: msg.roomCode || null,
      clientId: msg.clientId || null,
      username: typeof msg.username === 'string' ? msg.username : null,
      isHost: !!msg.isHost,
      members: Array.isArray(msg.members) ? msg.members : []
    };
    broadcastStatus({ room: { ...room }, lastError: null });
    return;
  }
  if (t === 'MEMBER_JOINED' || t === 'MEMBER_LEFT') {
    if (Array.isArray(msg.members)) {
      room.members = msg.members;
      broadcastStatus({ room: { ...room } });
    }
    return;
  }
}

function attachSocketHandlers(socket) {
  socket.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    applyIncomingMessage(msg);
    emitFrame(msg);
  });

  socket.on('close', () => {
    stopHeartbeat();
    const wasUrl = activeWsUrl;
    ws = null;
    activeWsUrl = null;
    connecting = false;
    if (room.inRoom) {
      lastError = lastError || 'Disconnected from signaling server';
      resetRoomLocal();
    }
    broadcastStatus({
      connected: false,
      connecting: false,
      wsUrl: wasUrl,
      room: { ...room },
      lastError
    });
  });

}

/**
 * @param {string} wsUrl
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
function connect(wsUrl) {
  return new Promise((resolve) => {
    lastError = null;
    const url = normalizeWsUrl(wsUrl);
    if (ws && ws.readyState === WebSocket.OPEN && activeWsUrl === url) {
      broadcastStatus({ connected: true, connecting: false, wsUrl: url, room: { ...room }, lastError: null });
      resolve({ ok: true });
      return;
    }

    if (ws) {
      try {
        ws.removeAllListeners();
        ws.close();
      } catch (_) {}
      ws = null;
    }

    connecting = true;
    activeWsUrl = url;
    resetRoomLocal();
    serverInfoPublicUrl = null;
    broadcastStatus({ connected: false, connecting: true, wsUrl: url, room: { ...room }, lastError: null });

    const w = new WebSocket(url);
    ws = w;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      connecting = false;
      try {
        w.close();
      } catch (_) {}
      lastError = 'Connection timeout';
      ws = null;
      broadcastStatus({ connected: false, connecting: false, wsUrl: url, lastError });
      resolve({ ok: false, error: lastError });
    }, 20000);

    w.once('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connecting = false;
      startHeartbeat();
      broadcastStatus({ connected: true, connecting: false, wsUrl: url, room: { ...room }, lastError: null });
      resolve({ ok: true });
    });

    w.once('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connecting = false;
      ws = null;
      const err = e instanceof Error ? e.message : String(e);
      lastError = err;
      broadcastStatus({ connected: false, connecting: false, wsUrl: url, lastError: err });
      resolve({ ok: false, error: err });
    });

    attachSocketHandlers(w);
  });
}

function leaveRoom() {
  if (ws && ws.readyState === WebSocket.OPEN && room.inRoom) {
    try {
      ws.send(JSON.stringify({ type: 'LEAVE_ROOM' }));
    } catch (_) {}
  }
  resetRoomLocal();
  lastError = null;
  broadcastStatus({ room: { ...room }, lastError: null });
}

function disconnect() {
  stopHeartbeat();
  resetRoomLocal();
  serverInfoPublicUrl = null;
  const prevUrl = activeWsUrl;
  activeWsUrl = null;
  connecting = false;
  if (ws) {
    try {
      ws.removeAllListeners();
      ws.close();
    } catch (_) {}
    ws = null;
  }
  lastError = null;
  broadcastStatus({
    connected: false,
    connecting: false,
    wsUrl: prevUrl,
    room: { ...room },
    lastError: null
  });
}

/**
 * @param {object} msg
 */
function sendJson(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Not connected');
  }
  ws.send(JSON.stringify(msg));
}

function getState() {
  return {
    connected: !!(ws && ws.readyState === WebSocket.OPEN),
    connecting,
    wsUrl: activeWsUrl,
    serverSignalUrl: serverInfoPublicUrl,
    lastError,
    room: { ...room },
    watch: { ...watchMeta }
  };
}

function setWatchMeta(meta) {
  if (!meta || typeof meta !== 'object') return;
  watchMeta = {
    providerKey: String(meta.providerKey || '').slice(0, 64),
    titleNote: String(meta.titleNote || '').slice(0, 200),
    watchUrl: String(meta.watchUrl || '').slice(0, 4000)
  };
  broadcastStatus({ watch: { ...watchMeta } });
}

/**
 * @param {string} url
 */
function openExternalSafe(url) {
  const s = String(url || '').trim();
  if (!s) throw new Error('URL required');
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) URLs allowed');
  return shell.openExternal(s);
}

function registerIpc(ipcMain) {
  ipcMain.handle('playshare:signal-connect', async (_e, payload) => {
    if (!payload?.wsUrl) return { ok: false, error: 'wsUrl required' };
    try {
      return await connect(payload.wsUrl);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, error };
    }
  });

  ipcMain.handle('playshare:signal-disconnect', () => {
    disconnect();
    return { ok: true };
  });

  ipcMain.handle('playshare:signal-leave-room', () => {
    leaveRoom();
    return { ok: true };
  });

  ipcMain.handle('playshare:signal-send', (_e, msg) => {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      return { ok: false, error: 'Invalid message' };
    }
    try {
      sendJson(msg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('playshare:signal-state', () => getState());

  ipcMain.handle('playshare:session-set-watch', (_e, meta) => {
    setWatchMeta(meta || {});
    return { ok: true };
  });

  ipcMain.handle('playshare:open-external', async (_e, payload) => {
    if (!payload?.url) return { ok: false, error: 'url required' };
    try {
      await openExternalSafe(payload.url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

module.exports = {
  connect,
  disconnect,
  leaveRoom,
  sendJson,
  getState,
  setWatchMeta,
  registerIpc,
  openExternalSafe
};
