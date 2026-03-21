/**
 * PlayShare Server
 * Real-time WebSocket signaling server for synchronized streaming + chat.
 * Rooms are identified by a short alphanumeric code.
 * Each room tracks members and the current playback state.
 */

const http = require('http');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 8765;

/** Drop oversized frames before JSON.parse (abuse / accidental huge payloads). */
const MAX_WS_MESSAGE_BYTES = parseInt(process.env.PLAYSHARE_MAX_MESSAGE_BYTES || '65536', 10);
/** Sliding window rate limit per connection (not per-IP). */
const RATE_WINDOW_MS = parseInt(process.env.PLAYSHARE_RATE_WINDOW_MS || '10000', 10);
const RATE_MAX_MESSAGES = parseInt(process.env.PLAYSHARE_RATE_MAX_MESSAGES || '400', 10);

function getServerUrl() {
  if (process.env.PLAYSHARE_PUBLIC_URL) return process.env.PLAYSHARE_PUBLIC_URL;
  const isIPv4 = (f) => f === 'IPv4' || f === 4;
  for (const nets of Object.values(os.networkInterfaces())) {
    if (!nets) continue;
    for (const net of nets) {
      if (isIPv4(net.family) && !net.internal && net.address) {
        return `ws://${net.address}:${PORT}`;
      }
    }
  }
  return `ws://localhost:${PORT}`;
}

// rooms: Map<roomCode, { host: clientId, members: Map<clientId, { ws, username, color }>, state: PlaybackState }>
const rooms = new Map();

/** Recent playback events per room (diagnostics / correlation). Capped; cleared when room empties. */
const roomDiagRings = new Map();
const ROOM_DIAG_RING_MAX = 50;

function pushRoomDiag(roomCode, entry) {
  let ring = roomDiagRings.get(roomCode);
  if (!ring) {
    ring = [];
    roomDiagRings.set(roomCode, ring);
  }
  ring.push(entry);
  if (ring.length > ROOM_DIAG_RING_MAX) ring.splice(0, ring.length - ROOM_DIAG_RING_MAX);
}

// clients: Map<ws, { clientId, roomCode, username, color }>
const clients = new Map();

const COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#BB8FCE', '#85C1E9', '#82E0AA', '#F0B27A'
];

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return 'ROOM' + Date.now().toString(36).slice(-4);  // fallback on collision storm
}

function broadcast(roomCode, message, excludeWs = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const data = JSON.stringify(message);
  for (const [, member] of room.members) {
    if (member.ws !== excludeWs && member.ws.readyState === WebSocket.OPEN) {
      member.ws.send(data);
    }
  }
}

function broadcastAll(roomCode, message) {
  broadcast(roomCode, message, null);
}

/** clientId → last telemetry row; does not replace canonical room.state (still host PLAY + host PLAYBACK_POSITION). */
function ensureRoomPositionMaps(room) {
  if (!room.positionReports) room.positionReports = new Map();
  if (room.lastPositionSnapshotBroadcastAt == null) room.lastPositionSnapshotBroadcastAt = 0;
}

const positionSnapshotTimers = new Map(); // roomCode → timeoutId
const POSITION_SNAPSHOT_MIN_INTERVAL_MS = parseInt(
  process.env.PLAYSHARE_POSITION_SNAPSHOT_MS || '1800',
  10
);
const POSITION_REPORT_STALE_MS = parseInt(process.env.PLAYSHARE_POSITION_STALE_MS || '12000', 10);

/** Periodic authoritative sync packets for viewer reconciliation (ms). */
const SYNC_BROADCAST_INTERVAL_MS = parseInt(process.env.PLAYSHARE_SYNC_BROADCAST_MS || '2000', 10);
const roomSyncIntervals = new Map(); // roomCode → IntervalId

function startRoomSyncBroadcast(roomCode) {
  if (roomSyncIntervals.has(roomCode)) return;
  const id = setInterval(() => {
    const room = rooms.get(roomCode);
    if (!room || room.members.size === 0) return;
    const sentAt = Date.now();
    const elapsed = room.state.playing ? (sentAt - room.state.updatedAt) / 1000 : 0;
    const currentTime = room.state.currentTime + elapsed;
    broadcastAll(roomCode, {
      type: 'sync',
      currentTime,
      state: room.state.playing ? 'playing' : 'paused',
      sentAt
    });
  }, SYNC_BROADCAST_INTERVAL_MS);
  roomSyncIntervals.set(roomCode, id);
}

function stopRoomSyncBroadcast(roomCode) {
  const id = roomSyncIntervals.get(roomCode);
  if (id) {
    clearInterval(id);
    roomSyncIntervals.delete(roomCode);
  }
}

function isRoomHost(room, clientId) {
  return room && room.host === clientId;
}

function ensureAdBreakClients(room) {
  if (!room.adBreakClients) room.adBreakClients = new Set();
}

function activeAdBreaksList(room) {
  ensureAdBreakClients(room);
  return Array.from(room.adBreakClients);
}

/** When `hostOnlyControl` is on, only the host may send play/pause/seek (validated here, not only on client). */
function playbackControlAllowed(room, clientId) {
  if (!room) return false;
  if (!room.hostOnlyControl) return true;
  return isRoomHost(room, clientId);
}

function clearPositionSnapshotTimer(roomCode) {
  const tid = positionSnapshotTimers.get(roomCode);
  if (tid) {
    clearTimeout(tid);
    positionSnapshotTimers.delete(roomCode);
  }
}

function schedulePositionSnapshot(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  ensureRoomPositionMaps(room);
  if (positionSnapshotTimers.has(roomCode)) return;
  const now = Date.now();
  const elapsed = now - room.lastPositionSnapshotBroadcastAt;
  const delay = elapsed >= POSITION_SNAPSHOT_MIN_INTERVAL_MS ? 0 : POSITION_SNAPSHOT_MIN_INTERVAL_MS - elapsed;
  positionSnapshotTimers.set(
    roomCode,
    setTimeout(() => {
      positionSnapshotTimers.delete(roomCode);
      broadcastPositionSnapshot(roomCode);
    }, delay)
  );
}

function broadcastPositionSnapshot(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  ensureRoomPositionMaps(room);
  const wallMs = Date.now();
  room.lastPositionSnapshotBroadcastAt = wallMs;
  const canonElapsed = room.state.playing ? (wallMs - room.state.updatedAt) / 1000 : 0;
  const canonicalTime = room.state.currentTime + canonElapsed;
  const members = [];
  for (const [cid, rep] of room.positionReports.entries()) {
    members.push({
      clientId: cid,
      username: rep.username,
      isHost: cid === room.host,
      currentTime: rep.currentTime,
      playing: !!rep.playing,
      receivedAt: rep.receivedAt,
      stale: wallMs - rep.receivedAt > POSITION_REPORT_STALE_MS
    });
  }
  broadcastAll(roomCode, {
    type: 'POSITION_SNAPSHOT',
    roomCode,
    wallMs,
    canonical: {
      currentTime: canonicalTime,
      playing: !!room.state.playing,
      computedAt: wallMs
    },
    members
  });
}

function sendTo(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function formatSeekTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function getMemberList(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return [];
  return Array.from(room.members.entries()).map(([id, m]) => ({
    clientId: id,
    username: m.username,
    color: m.color,
    isHost: id === room.host
  }));
}

function assignColor(roomCode) {
  const room = rooms.get(roomCode);
  const usedColors = new Set(Array.from(room.members.values()).map(m => m.color));
  const available = COLORS.filter(c => !usedColors.has(c));
  return available.length > 0 ? available[0] : COLORS[Math.floor(Math.random() * COLORS.length)];
}

function getHttpJoinUrl() {
  const u = getServerUrl();
  if (u.startsWith('wss://')) return `https://${u.slice(6)}`;
  if (u.startsWith('ws://')) return `http://${u.slice(5)}`;
  return u.replace(/^ws:/, 'http:');
}

const STREAMING_HOSTS = require('./shared/streaming-hosts.json').hostSubstrings;
function isValidVideoUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && STREAMING_HOSTS.some(h => url.hostname.includes(h));
  } catch { return false; }
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  if (url.pathname === '/join' && req.method === 'GET') {
    const code = (url.searchParams.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    let videoUrl = null;
    try { const r = url.searchParams.get('url'); if (r) videoUrl = decodeURIComponent(r); } catch {}
    const serverUrl = getServerUrl();
    const hasRoom = code.length >= 4 && rooms.has(code);
    const validVideo = videoUrl && isValidVideoUrl(videoUrl);
    const serverHost = serverUrl.replace(/^wss?:\/\//, '').split('/')[0];
    if (validVideo && hasRoom) {
      const sep = videoUrl.includes('?') ? '&' : '?';
      const redirectUrl = videoUrl + sep + 'playshare=' + code + '&ps_srv=' + encodeURIComponent(serverHost);
      const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="0;url=${redirectUrl.replace(/"/g, '&quot;')}"><title>Joining PlayShare…</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#eee}
.msg{text-align:center;padding:24px}.spinner{width:32px;height:32px;border:3px solid #333;border-top-color:#E50914;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}</style></head>
<body><div class="msg"><div class="spinner"></div><p>Opening video and joining room…</p></div></body></html>`;
      res.writeHead(302, { 'Location': redirectUrl });
      res.end();
      return;
    }
    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join PlayShare</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:24px;background:#0a0a0a;color:#eee}
h1{font-size:20px;margin:0 0 16px}.join-code{font-size:28px;font-weight:700;letter-spacing:4px;color:#E50914;margin:12px 0}
.info{background:#1a1a1a;padding:12px;border-radius:8px;font-size:13px;margin:12px 0;word-break:break-all}
.btn{display:inline-block;padding:10px 20px;background:#E50914;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;margin:4px}
.btn:hover{background:#c40812}.btn2{background:#333}.btn2:hover{background:#444}
.steps{margin:16px 0;padding-left:20px;line-height:1.8;color:#aaa}
.err{color:#E50914;margin:8px 0}.links{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}</style></head>
<body>
<h1>${hasRoom ? 'Join PlayShare room' : 'PlayShare'}</h1>
${code ? `<div class="join-code">${code}</div>` : ''}
${!hasRoom && code ? '<p class="err">Room not found. Check the code.</p>' : ''}
<div class="info"><strong>Server:</strong> <code id="serverUrl">${serverUrl}</code></div>
<button class="btn" onclick="copyAll()">Copy invite</button>
<button class="btn btn2" onclick="copyServer()">Copy server only</button>
<div class="links">
<a href="#" class="btn btn2" onclick="openSite('https://www.youtube.com');return false">Open YouTube</a>
<a href="#" class="btn btn2" onclick="openSite('https://www.netflix.com');return false">Open Netflix</a>
<a href="#" class="btn btn2" onclick="openSite('https://www.primevideo.com');return false">Open Prime</a>
</div>
<p class="steps">1. Copy invite above<br>2. Open PlayShare extension<br>3. Click "Paste invite" then "Join room"</p>
<script>
function copyAll(){navigator.clipboard.writeText('Server: '+document.getElementById('serverUrl').textContent+'\\nCode: '+'${code}');alert('Copied!');}
function copyServer(){navigator.clipboard.writeText(document.getElementById('serverUrl').textContent);alert('Copied!');}
function openSite(u){window.open(u,'_blank');}
</script></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

function rateLimitOk(meta) {
  const now = Date.now();
  if (!meta.rateWindowStart || now - meta.rateWindowStart > RATE_WINDOW_MS) {
    meta.rateWindowStart = now;
    meta.rateCount = 0;
  }
  meta.rateCount++;
  return meta.rateCount <= RATE_MAX_MESSAGES;
}

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  clients.set(ws, {
    clientId,
    roomCode: null,
    username: 'Viewer',
    color: '#FFFFFF',
    rateWindowStart: 0,
    rateCount: 0
  });

  console.log(`[+] Client connected: ${clientId}`);
  sendTo(ws, { type: 'SERVER_INFO', serverUrl: getServerUrl() });

  ws.on('message', (raw) => {
    const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
    if (size > MAX_WS_MESSAGE_BYTES) {
      try {
        sendTo(ws, { type: 'ERROR', code: 'MESSAGE_TOO_LARGE', message: 'Message exceeds server limit' });
      } catch {}
      ws.close(1009, 'Message too large');
      return;
    }

    const clientMeta = clients.get(ws);
    if (!clientMeta || !rateLimitOk(clientMeta)) {
      try {
        sendTo(ws, { type: 'ERROR', code: 'RATE_LIMIT', message: 'Too many messages; slow down' });
      } catch {}
      ws.close(1008, 'Rate limit');
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const client = clients.get(ws);
    if (!client) return;

    switch (msg.type) {

      // ── Room management ──────────────────────────────────────────────────
      case 'CREATE_ROOM': {
        const roomCode = generateRoomCode();
        const username = (msg.username || 'Host').slice(0, 24);
        const color = COLORS[0];
        const hostOnlyControl = !!msg.hostOnlyControl;
        const countdownOnPlay = !!msg.countdownOnPlay;
        rooms.set(roomCode, {
          host: clientId,
          hostOnlyControl,
          countdownOnPlay,
          members: new Map([[clientId, { ws, username, color }]]),
          state: { playing: false, currentTime: 0, updatedAt: Date.now() },
          adBreakClients: new Set()
        });
        startRoomSyncBroadcast(roomCode);
        client.roomCode = roomCode;
        client.username = username;
        client.color = color;
        sendTo(ws, {
          type: 'ROOM_CREATED',
          roomCode,
          clientId,
          username,
          color,
          isHost: true,
          hostOnlyControl,
          countdownOnPlay,
          members: getMemberList(roomCode),
          activeAdBreaks: []
        });
        console.log(`[ROOM] Created: ${roomCode} by ${username} (hostOnly: ${hostOnlyControl}, countdown: ${countdownOnPlay})`);
        break;
      }

      case 'JOIN_ROOM': {
        const roomCode = (msg.roomCode || '').toUpperCase().trim();
        const username = (msg.username || 'Viewer').slice(0, 24);
        if (!rooms.has(roomCode)) {
          sendTo(ws, { type: 'ERROR', code: 'ROOM_NOT_FOUND', message: 'Room not found. Check the code and try again.' });
          return;
        }
        const room = rooms.get(roomCode);
        const color = assignColor(roomCode);
        room.members.set(clientId, { ws, username, color });
        client.roomCode = roomCode;
        client.username = username;
        client.color = color;

        // Compute current state (add elapsed time if playing) — include computedAt for latency compensation
        const computedAt = Date.now();
        const elapsed = room.state.playing ? (computedAt - room.state.updatedAt) / 1000 : 0;
        const joinState = {
          playing: room.state.playing,
          currentTime: room.state.currentTime + elapsed,
          computedAt,
          sentAt: computedAt
        };

        // Send current state to the new joiner
        sendTo(ws, {
          type: 'ROOM_JOINED',
          roomCode,
          clientId,
          username,
          color,
          isHost: false,
          hostOnlyControl: room.hostOnlyControl,
          countdownOnPlay: room.countdownOnPlay,
          state: joinState,
          members: getMemberList(roomCode),
          activeAdBreaks: activeAdBreaksList(room)
        });

        // Notify existing members
        broadcast(roomCode, {
          type: 'MEMBER_JOINED',
          clientId,
          username,
          color,
          hostOnlyControl: room.hostOnlyControl,
          countdownOnPlay: room.countdownOnPlay,
          members: getMemberList(roomCode)
        }, ws);

        console.log(`[ROOM] ${username} joined: ${roomCode}`);
        break;
      }

      case 'LEAVE_ROOM': {
        handleLeave(ws, client);
        break;
      }

      // ── Playback sync ────────────────────────────────────────────────────
      case 'PLAY': {
        const room = rooms.get(client.roomCode);
        if (!room) return;
        if (!playbackControlAllowed(room, clientId)) return;
        room.state = { playing: true, currentTime: msg.currentTime || 0, updatedAt: Date.now() };
        const correlationId = uuidv4();
        const serverTime = Date.now();
        pushRoomDiag(client.roomCode, { t: serverTime, type: 'PLAY', correlationId, fromClientId: clientId, fromUsername: client.username });
        const playPayload = {
          type: 'PLAY',
          currentTime: msg.currentTime || 0,
          sentAt: msg.sentAt || Date.now(),
          serverTime,
          correlationId,
          fromClientId: clientId,
          fromUsername: client.username
        };
        broadcast(client.roomCode, playPayload, ws);
        broadcastAll(client.roomCode, { type: 'SYSTEM_MSG', text: `▶ ${client.username} pressed play` });
        break;
      }

      case 'PAUSE': {
        const room = rooms.get(client.roomCode);
        if (!room) return;
        if (!playbackControlAllowed(room, clientId)) return;
        room.state = { playing: false, currentTime: msg.currentTime || 0, updatedAt: Date.now() };
        const correlationId = uuidv4();
        const serverTime = Date.now();
        pushRoomDiag(client.roomCode, { t: serverTime, type: 'PAUSE', correlationId, fromClientId: clientId, fromUsername: client.username });
        const pausePayload = {
          type: 'PAUSE',
          currentTime: msg.currentTime || 0,
          sentAt: msg.sentAt || Date.now(),
          serverTime,
          correlationId,
          fromClientId: clientId,
          fromUsername: client.username
        };
        broadcast(client.roomCode, pausePayload, ws);
        broadcastAll(client.roomCode, { type: 'SYSTEM_MSG', text: `⏸ ${client.username} paused` });
        break;
      }

      case 'SEEK': {
        const room = rooms.get(client.roomCode);
        if (!room) return;
        if (!playbackControlAllowed(room, clientId)) return;
        const seekTime = msg.currentTime || 0;
        room.state.currentTime = seekTime;
        room.state.updatedAt = Date.now();
        const correlationId = uuidv4();
        const serverTime = Date.now();
        pushRoomDiag(client.roomCode, { t: serverTime, type: 'SEEK', correlationId, fromClientId: clientId, fromUsername: client.username });
        const seekPayload = {
          type: 'SEEK',
          currentTime: seekTime,
          sentAt: msg.sentAt || Date.now(),
          serverTime,
          correlationId,
          fromClientId: clientId,
          fromUsername: client.username
        };
        broadcast(client.roomCode, seekPayload, ws);
        const timeStr = formatSeekTime(seekTime);
        broadcastAll(client.roomCode, { type: 'SYSTEM_MSG', text: `⏩ ${client.username} seeked to ${timeStr}` });
        break;
      }

      case 'PLAYBACK_POSITION': {
        // Host-only: viewers must not overwrite room timeline or broadcast fake positions
        const room = rooms.get(client.roomCode);
        if (!room) return;
        if (room.host !== clientId) return;
        const t = msg.currentTime;
        if (typeof t === 'number' && t >= 0) {
          room.state.currentTime = t;
          room.state.updatedAt = Date.now();
          ensureRoomPositionMaps(room);
          room.positionReports.set(clientId, {
            username: client.username,
            isHost: true,
            currentTime: t,
            playing: !!room.state.playing,
            receivedAt: Date.now()
          });
          schedulePositionSnapshot(client.roomCode);
          // Broadcast position to viewers so they can correct drift (host excluded)
          const elapsed = room.state.playing ? (Date.now() - room.state.updatedAt) / 1000 : 0;
          const computedAt = Date.now();
          broadcast(client.roomCode, {
            type: 'SYNC_STATE',
            state: {
              playing: room.state.playing,
              currentTime: room.state.currentTime + elapsed,
              computedAt,
              sentAt: computedAt
            }
          }, ws);
        }
        break;
      }

      case 'POSITION_REPORT': {
        // Telemetry only: all clients report local timeline for multi-peer sync UI (spread / badges).
        if (!client.roomCode) return;
        const room = rooms.get(client.roomCode);
        if (!room) return;
        const t = msg.currentTime;
        if (typeof t !== 'number' || t < 0 || !Number.isFinite(t)) return;
        ensureRoomPositionMaps(room);
        room.positionReports.set(clientId, {
          username: client.username,
          isHost: room.host === clientId,
          currentTime: t,
          playing: !!msg.playing,
          receivedAt: Date.now()
        });
        schedulePositionSnapshot(client.roomCode);
        break;
      }

      case 'SYNC_REQUEST': {
        // A client asks for the current state (e.g. after reconnect)
        const room = rooms.get(client.roomCode);
        if (!room) return;
        const computedAt = Date.now();
        const elapsed = room.state.playing ? (computedAt - room.state.updatedAt) / 1000 : 0;
        sendTo(ws, {
          type: 'SYNC_STATE',
          state: {
            playing: room.state.playing,
            currentTime: room.state.currentTime + elapsed,
            computedAt,
            sentAt: computedAt
          }
        });
        break;
      }

      case 'HEARTBEAT': {
        sendTo(ws, { type: 'HEARTBEAT_ACK' });
        break;
      }

      case 'COUNTDOWN_START': {
        const room = rooms.get(client.roomCode);
        if (!room || !playbackControlAllowed(room, clientId)) return;
        broadcastAll(client.roomCode, {
          type: 'COUNTDOWN_START',
          currentTime: msg.currentTime || 0,
          fromClientId: clientId,
          fromUsername: client.username
        });
        break;
      }

      case 'AD_BREAK_START': {
        if (!client.roomCode) return;
        const room = rooms.get(client.roomCode);
        if (!room) return;
        ensureAdBreakClients(room);
        if (room.adBreakClients.has(clientId)) return;
        room.adBreakClients.add(clientId);
        const sentAt = Date.now();
        broadcastAll(client.roomCode, {
          type: 'AD_BREAK_START',
          fromClientId: clientId,
          fromUsername: client.username,
          sentAt
        });
        broadcastAll(client.roomCode, {
          type: 'SYSTEM_MSG',
          text: `📺 ${client.username} is watching an ad — others stay paused until it ends`
        });
        break;
      }

      case 'AD_BREAK_END': {
        if (!client.roomCode) return;
        const room = rooms.get(client.roomCode);
        if (!room) return;
        ensureAdBreakClients(room);
        if (!room.adBreakClients.has(clientId)) return;
        room.adBreakClients.delete(clientId);
        const sentAt = Date.now();
        broadcastAll(client.roomCode, {
          type: 'AD_BREAK_END',
          fromClientId: clientId,
          fromUsername: client.username,
          sentAt
        });
        broadcastAll(client.roomCode, {
          type: 'SYSTEM_MSG',
          text: `✓ ${client.username}'s ad break ended`
        });
        break;
      }

      case 'TYPING_START':
      case 'TYPING_STOP': {
        if (!client.roomCode) return;
        broadcast(client.roomCode, {
          type: msg.type,
          clientId,
          username: client.username
        }, ws);
        break;
      }

      case 'DIAG_ROOM_TRACE_REQUEST': {
        if (!client.roomCode) return;
        const ring = roomDiagRings.get(client.roomCode) || [];
        sendTo(ws, { type: 'DIAG_ROOM_TRACE', roomCode: client.roomCode, entries: ring.slice(-40) });
        break;
      }

      case 'DIAG_SYNC_APPLY_RESULT':
      case 'DIAG_SYNC_REPORT': {
        if (!client.roomCode) return;
        broadcastAll(client.roomCode, { ...msg, fromClientId: clientId });
        break;
      }

      // ── Chat ─────────────────────────────────────────────────────────────
      case 'CHAT': {
        if (!client.roomCode) return;
        const text = (msg.text || '').slice(0, 500);
        if (!text.trim()) return;
        broadcastAll(client.roomCode, {
          type: 'CHAT',
          clientId,
          username: client.username,
          color: client.color,
          text,
          timestamp: Date.now()
        });
        break;
      }

      // ── Reactions ────────────────────────────────────────────────────────
      case 'REACTION': {
        if (!client.roomCode) return;
        const emoji = (msg.emoji || '').slice(0, 4);
        broadcastAll(client.roomCode, {
          type: 'REACTION',
          clientId,
          username: client.username,
          color: client.color,
          emoji,
          timestamp: Date.now()
        });
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client) handleLeave(ws, client);
    clients.delete(ws);
    console.log(`[-] Client disconnected: ${clientId}`);
  });

  ws.on('error', (err) => {
    console.error(`[ERR] ${clientId}:`, err.message);
  });
});

function handleLeave(ws, client) {
  const { clientId, roomCode, username } = client;
  if (!roomCode || !rooms.has(roomCode)) return;
  const room = rooms.get(roomCode);
  ensureAdBreakClients(room);
  if (room.adBreakClients.has(clientId)) {
    room.adBreakClients.delete(clientId);
    broadcastAll(roomCode, {
      type: 'AD_BREAK_END',
      fromClientId: clientId,
      fromUsername: username,
      sentAt: Date.now(),
      reason: 'disconnect'
    });
  }
  room.members.delete(clientId);
  client.roomCode = null;

  if (room.positionReports) room.positionReports.delete(clientId);

  if (room.members.size === 0) {
    clearPositionSnapshotTimer(roomCode);
    stopRoomSyncBroadcast(roomCode);
    rooms.delete(roomCode);
    roomDiagRings.delete(roomCode);
    console.log(`[ROOM] Deleted empty room: ${roomCode}`);
    return;
  }

  // If host left, promote the next member
  if (room.host === clientId) {
    room.host = room.members.keys().next().value;
    console.log(`[ROOM] New host in ${roomCode}: ${room.host}`);
  }

  broadcast(roomCode, {
    type: 'MEMBER_LEFT',
    clientId,
    username,
    newHostId: room.host,
    members: getMemberList(roomCode)
  });
}

httpServer.listen(PORT, '0.0.0.0', () => {
  const lanWs = getServerUrl();
  console.log('✅ PlayShare server running (signaling host = this computer)');
  console.log(`   Extension on this machine: ws://localhost:${PORT}`);
  if (lanWs !== `ws://localhost:${PORT}`) {
    console.log(`   Phones & other PCs on your LAN: ${lanWs}`);
  }
  console.log(`   Join page: ${getHttpJoinUrl()}/join?code=XXXXXX`);
});
