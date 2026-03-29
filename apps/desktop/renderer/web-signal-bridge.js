/**
 * Browser implementation of `window.playshareDesktop` — mirrors `electron/signal-session.cjs`
 * + preload IPC so the same renderer bundle can run on the marketing site at `/dashboard`.
 */
import { PlayShareSignalingClientType } from '../../../shared/core/signaling-client.js';

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

let watchMeta = {
  providerKey: '',
  titleNote: '',
  watchUrl: ''
};

function broadcastStatus(patch) {
  window.dispatchEvent(new CustomEvent('playshare-signal-status', { detail: patch }));
}

function emitFrame(msg) {
  window.dispatchEvent(new CustomEvent('playshare-signal-frame', { detail: msg }));
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: PlayShareSignalingClientType.HEARTBEAT }));
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
  const p = u.pathname || '/';
  if (p !== '/') out += p.replace(/\/$/, '');
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
    broadcastStatus({ serverSignalUrl: serverInfoPublicUrl });
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
    if (t === 'ROOM_CREATED') {
      watchMeta = { providerKey: '', titleNote: '', watchUrl: '' };
    } else if (t === 'ROOM_JOINED') {
      const sw = msg.sessionWatch;
      if (sw && typeof sw === 'object' && String(sw.watchUrl || '').trim()) {
        watchMeta = {
          providerKey: String(sw.providerKey || '').slice(0, 64),
          titleNote: String(sw.titleNote || '').slice(0, 200),
          watchUrl: String(sw.watchUrl || '').slice(0, 4000)
        };
      } else {
        watchMeta = { providerKey: '', titleNote: '', watchUrl: '' };
      }
    }
    broadcastStatus({ room: { ...room }, watch: { ...watchMeta }, lastError: null });
    return;
  }
  if (t === 'SESSION_WATCH') {
    const w = msg.watch;
    if (w == null) {
      watchMeta = { providerKey: '', titleNote: '', watchUrl: '' };
    } else if (typeof w === 'object') {
      watchMeta = {
        providerKey: String(w.providerKey || '').slice(0, 64),
        titleNote: String(w.titleNote || '').slice(0, 200),
        watchUrl: String(w.watchUrl || '').slice(0, 4000)
      };
    }
    broadcastStatus({ watch: { ...watchMeta } });
    return;
  }
  if (t === 'MEMBER_JOINED' || t === 'MEMBER_LEFT') {
    if (Array.isArray(msg.members)) {
      room.members = msg.members;
      broadcastStatus({ room: { ...room } });
    }
  }
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
      broadcastStatus({
        connected: true,
        connecting: false,
        wsUrl: url,
        room: { ...room },
        lastError: null
      });
      resolve({ ok: true });
      return;
    }

    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }

    connecting = true;
    activeWsUrl = url;
    resetRoomLocal();
    serverInfoPublicUrl = null;
    broadcastStatus({
      connected: false,
      connecting: true,
      wsUrl: url,
      room: { ...room },
      lastError: null
    });

    let s;
    try {
      s = new WebSocket(url);
    } catch (e) {
      connecting = false;
      lastError = e instanceof Error ? e.message : String(e);
      broadcastStatus({ connected: false, connecting: false, wsUrl: url, lastError });
      resolve({ ok: false, error: lastError });
      return;
    }

    ws = s;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      lastError = 'Connection timeout';
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }, 20000);

    s.addEventListener('close', () => {
      stopHeartbeat();
      clearTimeout(timer);
      const wasUrl = activeWsUrl;
      ws = null;
      activeWsUrl = null;
      connecting = false;
      if (!settled) {
        settled = true;
        const msg = lastError || 'Connection closed';
        lastError = msg;
        broadcastStatus({
          connected: false,
          connecting: false,
          wsUrl: wasUrl,
          room: { ...room },
          lastError: msg
        });
        resolve({ ok: false, error: msg });
        return;
      }
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

    s.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connecting = false;
      startHeartbeat();
      broadcastStatus({
        connected: true,
        connecting: false,
        wsUrl: url,
        room: { ...room },
        lastError: null
      });
      resolve({ ok: true });
    });

    s.addEventListener('error', () => {
      if (!settled) lastError = lastError || 'WebSocket error';
    });

    s.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : JSON.parse(String(ev.data));
      } catch {
        return;
      }
      applyIncomingMessage(msg);
      emitFrame(msg);
    });
  });
}

function leaveRoom() {
  if (ws && ws.readyState === WebSocket.OPEN && room.inRoom) {
    try {
      ws.send(JSON.stringify({ type: PlayShareSignalingClientType.LEAVE_ROOM }));
    } catch {
      /* ignore */
    }
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
      ws.close();
    } catch {
      /* ignore */
    }
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
 * Install browser bridge when not running under Electron preload.
 */
export function ensureWebPlayshareDesktop() {
  if (typeof window === 'undefined' || window.playshareDesktop) return;

  window.playshareDesktop = {
    channel: 'playshare-desktop-v2-web',
    platform: 'web',
    arch: 'browser',

    signalSmokeTest: () => Promise.resolve({ ok: false, error: 'Not available in the web dashboard' }),
    signalConnect: (payload) => {
      if (!payload?.wsUrl) return Promise.resolve({ ok: false, error: 'wsUrl required' });
      return connect(payload.wsUrl);
    },
    signalDisconnect: () => {
      disconnect();
      return Promise.resolve({ ok: true });
    },
    signalLeaveRoom: () => {
      leaveRoom();
      return Promise.resolve({ ok: true });
    },
    signalSend: (msg) => {
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
        return Promise.resolve({ ok: false, error: 'Invalid message' });
      }
      try {
        sendJson(msg);
        return Promise.resolve({ ok: true });
      } catch (err) {
        return Promise.resolve({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    },
    signalGetState: () => Promise.resolve(getState()),
    sessionSetWatch: (meta) => {
      setWatchMeta(meta || {});
      return Promise.resolve({ ok: true });
    },
    openExternal: (payload) => {
      const u = String(payload?.url || '').trim();
      if (!u) return Promise.resolve({ ok: false, error: 'url required' });
      try {
        const parsed = new URL(u);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return Promise.resolve({ ok: false, error: 'Only http(s) URLs allowed' });
        }
      } catch {
        return Promise.resolve({ ok: false, error: 'Invalid URL' });
      }
      try {
        window.open(u, '_blank', 'noopener,noreferrer');
        return Promise.resolve({ ok: true });
      } catch (e) {
        return Promise.resolve({
          ok: false,
          error: e instanceof Error ? e.message : String(e)
        });
      }
    }
  };
}
