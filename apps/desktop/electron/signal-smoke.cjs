/**
 * Dev signaling smoke test (main process) — short-lived sockets for the Developer panel.
 * Payload shapes must stay aligned with server.js and shared/core/signaling-client.js.
 */
const WebSocket = require('ws');

const MSG = {
  CREATE_ROOM: 'CREATE_ROOM',
  JOIN_ROOM: 'JOIN_ROOM'
};

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

/**
 * @param {{ wsUrl: string, action: 'create' | 'join' | 'pair', username?: string, roomCode?: string, hostUsername?: string, guestUsername?: string, timeoutMs?: number }} raw
 */
function runSignalSmokeTest(raw) {
  if (raw.action === 'pair') return runPairSmokeTest(raw);

  const wsUrl = normalizeWsUrl(raw.wsUrl);
  const action = raw.action === 'join' ? 'join' : raw.action === 'create' ? 'create' : null;
  if (!action) return Promise.reject(new Error('action must be "create", "join", or "pair"'));

  const username = String(raw.username || 'DesktopSmoke').slice(0, 24);
  const roomCodeJoin =
    action === 'join'
      ? String(raw.roomCode || '')
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '')
          .slice(0, 8)
      : '';
  if (action === 'join' && !roomCodeJoin) {
    return Promise.reject(new Error('Room code is required to join'));
  }

  const timeoutMs = Math.min(Math.max(Number(raw.timeoutMs) || 15000, 3000), 60000);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => finish(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    const frames = [];
    let settled = false;

    function finish(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch (_) {}
      if (err) reject(err);
      else resolve(result);
    }

    ws.on('error', (e) => finish(e instanceof Error ? e : new Error(String(e))));

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      frames.push(msg);

      if (frames.length === 1) {
        if (msg.type !== 'SERVER_INFO') {
          return finish(new Error(`Expected SERVER_INFO as first frame, got "${msg.type}"`));
        }
        if (action === 'create') {
          ws.send(JSON.stringify({ type: MSG.CREATE_ROOM, username }));
        } else {
          ws.send(
            JSON.stringify({
              type: MSG.JOIN_ROOM,
              roomCode: roomCodeJoin,
              username,
              rejoinAfterDrop: true
            })
          );
        }
        return;
      }

      if (msg.type === 'ERROR') {
        return finish(new Error(msg.message || msg.code || 'Server returned ERROR'));
      }
      if (action === 'create' && msg.type === 'ROOM_CREATED') {
        return finish(null, {
          summary: 'Room created (socket closes — empty room is removed when host disconnects)',
          serverUrl: frames[0].serverUrl,
          roomCode: msg.roomCode,
          clientId: msg.clientId,
          frames,
          note: 'Use “Host + guest” in dev tools to verify join with host still connected.'
        });
      }
      if (action === 'join' && msg.type === 'ROOM_JOINED') {
        return finish(null, {
          summary: 'Joined room',
          serverUrl: frames[0].serverUrl,
          roomCode: msg.roomCode,
          clientId: msg.clientId,
          frames
        });
      }

      finish(new Error(`Unexpected frame after handshake: "${msg.type}"`));
    });
  });
}

/**
 * Two sockets: host creates, guest joins while host stays connected.
 */
function runPairSmokeTest(raw) {
  const wsUrl = normalizeWsUrl(raw.wsUrl);
  const hostUser = String(raw.hostUsername || raw.username || 'HostSmoke').slice(0, 24);
  const guestUser = String(raw.guestUsername || 'GuestSmoke').slice(0, 24);
  const timeoutMs = Math.min(Math.max(Number(raw.timeoutMs) || 20000, 5000), 90000);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);

    const wsHost = new WebSocket(wsUrl);
    /** @type {import('ws') | null} */
    let wsGuest = null;
    const hostFrames = [];
    const guestFrames = [];
    /** @type {string | null} */
    let roomCode = null;

    function finish(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        wsHost.close();
      } catch (_) {}
      try {
        if (wsGuest) wsGuest.close();
      } catch (_) {}
      if (err) reject(err);
      else resolve(result);
    }

    wsHost.on('error', (e) => finish(e instanceof Error ? e : new Error(String(e))));

    wsHost.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      hostFrames.push(msg);

      if (hostFrames.length === 1) {
        if (msg.type !== 'SERVER_INFO') {
          return finish(new Error(`Host: expected SERVER_INFO first, got "${msg.type}"`));
        }
        wsHost.send(JSON.stringify({ type: MSG.CREATE_ROOM, username: hostUser }));
        return;
      }

      if (msg.type === 'ERROR') {
        return finish(new Error(`Host: ${msg.message || msg.code || 'ERROR'}`));
      }

      if (msg.type === 'ROOM_CREATED' && !wsGuest) {
        roomCode = msg.roomCode;
        wsGuest = new WebSocket(wsUrl);
        wsGuest.on('error', (e) => finish(e instanceof Error ? e : new Error(String(e))));
        wsGuest.on('message', (guestData) => {
          let gm;
          try {
            gm = JSON.parse(guestData.toString());
          } catch {
            return;
          }
          guestFrames.push(gm);

          if (guestFrames.length === 1) {
            if (gm.type !== 'SERVER_INFO') {
              return finish(new Error(`Guest: expected SERVER_INFO first, got "${gm.type}"`));
            }
            wsGuest.send(
              JSON.stringify({
                type: MSG.JOIN_ROOM,
                roomCode,
                username: guestUser,
                rejoinAfterDrop: true
              })
            );
            return;
          }

          if (gm.type === 'ERROR') {
            return finish(new Error(`Guest: ${gm.message || gm.code || 'ERROR'}`));
          }

          if (gm.type === 'ROOM_JOINED') {
            return finish(null, {
              summary: 'Host created room and guest joined (2 peers)',
              roomCode: gm.roomCode,
              hostClientId: hostFrames[1]?.clientId,
              guestClientId: gm.clientId,
              hostFrames,
              guestFrames
            });
          }

          finish(new Error(`Guest: unexpected frame "${gm.type}"`));
        });
        return;
      }
    });
  });
}

module.exports = { runSignalSmokeTest };
