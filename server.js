/**
 * PlayShare Server
 * Real-time WebSocket signaling server for synchronized streaming + chat.
 * Rooms are identified by a short alphanumeric code.
 * Each room tracks members and the current playback state.
 */

const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (_) {
  /* dotenv is a normal dependency; catch only if module resolution fails */
}

const http = require('http');
const fs = require('fs');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');
const { handleDiagUpload, getSupabaseAdmin } = require('./platform/server/diag-upload');
const { handleDiagIntel } = require('./platform/server/diag-intel-http');
const { startDiagAiWorkerLoop } = require('./platform/server/diag-ai-worker');
const {
  getSpotlightTrendingWeek,
  searchMulti,
  getGenreList,
  discoverByGenre
} = require('./platform/server/tmdb-catalog');

const rawPort = String(process.env.PORT ?? '').trim();
const parsedPort = Number.parseInt(rawPort, 10);
/** True inside a Railway deployment container (not your laptop). */
const onRailway = Boolean(
  String(process.env.RAILWAY_ENVIRONMENT || '').trim() ||
    String(process.env.RAILWAY_PROJECT_ID || '').trim()
);
let PORT;
if (rawPort !== '' && Number.isFinite(parsedPort) && parsedPort > 0) {
  PORT = parsedPort;
} else if (onRailway) {
  console.error(
    '[PlayShare] FATAL: PORT is unset in a Railway container (RAILWAY_* env present). ' +
      'Delete any empty or wrong PORT variable in Railway; the platform injects PORT automatically. ' +
      'If the app listens on 8765 while the proxy uses another port, every request returns 502.'
  );
  process.exit(1);
} else {
  PORT = 8765;
}

/** Drop oversized frames before JSON.parse (abuse / accidental huge payloads). */
const MAX_WS_MESSAGE_BYTES = parseInt(process.env.PLAYSHARE_MAX_MESSAGE_BYTES || '65536', 10);
/** Sliding window rate limit per connection (not per-IP). */
const RATE_WINDOW_MS = parseInt(process.env.PLAYSHARE_RATE_WINDOW_MS || '10000', 10);
const RATE_MAX_MESSAGES = parseInt(process.env.PLAYSHARE_RATE_MAX_MESSAGES || '400', 10);

function getServerUrl() {
  if (process.env.PLAYSHARE_PUBLIC_URL) return process.env.PLAYSHARE_PUBLIC_URL;
  const railDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railDomain) return `wss://${railDomain.replace(/^https?:\/\//, '')}`;
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

// rooms: Map<roomCode, { host, members, state, titleSuggestions?: Map<string, { suggestedBy }>, … }>
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
  if (room.lastLaggardAnchorAt == null) room.lastLaggardAnchorAt = 0;
}

const positionSnapshotTimers = new Map(); // roomCode → timeoutId
const POSITION_SNAPSHOT_MIN_INTERVAL_MS = parseInt(
  process.env.PLAYSHARE_POSITION_SNAPSHOT_MS || '1800',
  10
);
/** Faster snapshot floor during adMode / elevated spread (bounded; keep Railway-friendly). */
const POSITION_SNAPSHOT_FAST_MS = parseInt(process.env.PLAYSHARE_POSITION_SNAPSHOT_FAST_MS || '1100', 10);
const POSITION_SNAPSHOT_SPREAD_BOOST_SEC = parseFloat(
  process.env.PLAYSHARE_POSITION_SNAPSHOT_SPREAD_BOOST_SEC || '4'
);
const POSITION_REPORT_STALE_MS = parseInt(process.env.PLAYSHARE_POSITION_STALE_MS || '12000', 10);

/**
 * Standard hard SYNC_STATE `correctionReason` values (keep aligned with content `sync-drift-config.js`).
 * Soft host heartbeats use `host_anchor_soft`.
 */
const CORRECTION_REASON = Object.freeze({
  JOIN: 'join',
  /** Existing members: pause at shared anchor when a new participant joins (fresh join only, not WS rejoin). */
  MEMBER_JOIN_SYNC: 'member_join_sync',
  LAGGARD_ANCHOR: 'laggard_anchor',
  AD_MODE_EXIT: 'ad_mode_exit',
  RECONNECT_SYNC: 'reconnect_sync',
  HOST_SEEK_SYNC: 'host_seek_sync',
  MANUAL_SYNC: 'manual_sync',
  HOST_ANCHOR_SOFT: 'host_anchor_soft'
});

function getAdaptivePositionSnapshotMinMs(room) {
  ensureRoomSyncPolicyFields(room);
  if (room.adMode) return Math.min(POSITION_SNAPSHOT_MIN_INTERVAL_MS, POSITION_SNAPSHOT_FAST_MS);
  const sp = room.lastObservedSpreadSec;
  if (typeof sp === 'number' && Number.isFinite(sp) && sp >= POSITION_SNAPSHOT_SPREAD_BOOST_SEC) {
    return Math.min(POSITION_SNAPSHOT_MIN_INTERVAL_MS, POSITION_SNAPSHOT_FAST_MS + 150);
  }
  return POSITION_SNAPSHOT_MIN_INTERVAL_MS;
}

/**
 * When fresh member extrapolated playheads differ by at least this many seconds, snap canonical
 * room state to the slowest (min) timeline and broadcast SYNC_STATE — avoids “ahead” peer (e.g.
 * finished ad first) pulling others forward or into bad seeks; everyone rewinds to the laggard.
 */
const LAGGARD_ANCHOR_SPREAD_SEC = parseFloat(process.env.PLAYSHARE_LAGGARD_ANCHOR_SPREAD_SEC || '6');
const LAGGARD_ANCHOR_MIN_INTERVAL_MS = parseInt(
  process.env.PLAYSHARE_LAGGARD_ANCHOR_MIN_MS || '12000',
  10
);
/** While any peer reports an ad break, require a larger spread before laggard anchor (platform-agnostic). */
const AD_DIVERGENCE_SPREAD_MULT = parseFloat(process.env.PLAYSHARE_AD_DIVERGENCE_SPREAD_MULT || '1.7');
/** If this fraction of fresh telemetry rows are LOW confidence, skip laggard anchor (avoid bad seeks during unstable UI). */
const LOW_CONFIDENCE_ANCHOR_RATIO = parseFloat(process.env.PLAYSHARE_LOW_CONFIDENCE_ANCHOR_RATIO || '0.58');

/** Spread (seconds) across fresh reports to enter server-side divergence / suspected-ad isolation. */
const AD_MODE_ENTER_SPREAD_SEC = parseFloat(process.env.PLAYSHARE_AD_MODE_ENTER_SPREAD_SEC || '8');
/** Exit isolation when fresh spread falls below this (seconds). */
const AD_MODE_EXIT_SPREAD_SEC = parseFloat(process.env.PLAYSHARE_AD_MODE_EXIT_SPREAD_SEC || '2');
/** Max time to stay in adMode before forcing one exit correction (ms). */
const AD_MODE_MAX_MS = parseInt(process.env.PLAYSHARE_AD_MODE_MAX_MS || '90000', 10);
/** Enter adMode only if host has not seeked within this window (ms). */
const AD_MODE_HOST_SEEK_QUIET_MS = parseInt(process.env.PLAYSHARE_AD_MODE_HOST_SEEK_QUIET_MS || '3000', 10);
/** Enter adMode only if no hard spread correction recently (ms). */
const AD_MODE_ENTER_HARD_GAP_MS = parseInt(process.env.PLAYSHARE_AD_MODE_ENTER_HARD_GAP_MS || '5000', 10);
/** Min time between laggard / spread hard corrections (ms). */
const HARD_CORRECTION_MIN_GAP_MS = parseInt(process.env.PLAYSHARE_HARD_CORRECTION_MIN_GAP_MS || '6000', 10);
/** After a member joins, block spread-based hard corrections until this wall time (ms from join). */
const RECONNECT_SETTLE_MS = parseInt(process.env.PLAYSHARE_RECONNECT_SETTLE_MS || '5000', 10);

function normalizePositionConfidence(raw) {
  const c = String(raw || 'MEDIUM').toUpperCase();
  if (c === 'HIGH' || c === 'MEDIUM' || c === 'LOW') return c;
  return 'MEDIUM';
}

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
  ensureRoomSyncPolicyFields(room);
  if (positionSnapshotTimers.has(roomCode)) return;
  const now = Date.now();
  const minInterval = getAdaptivePositionSnapshotMinMs(room);
  const elapsed = now - room.lastPositionSnapshotBroadcastAt;
  const delay = elapsed >= minInterval ? 0 : minInterval - elapsed;
  positionSnapshotTimers.set(
    roomCode,
    setTimeout(() => {
      positionSnapshotTimers.delete(roomCode);
      broadcastPositionSnapshot(roomCode);
    }, delay)
  );
}

function extrapolatePositionReportTime(rep, wallMs) {
  const dt = Math.max(0, (wallMs - rep.receivedAt) / 1000);
  return rep.playing ? rep.currentTime + dt : rep.currentTime;
}

function ensureRoomSyncPolicyFields(room) {
  if (!room) return;
  if (room.adMode == null) room.adMode = false;
  if (room.adModeStartedAt == null) room.adModeStartedAt = 0;
  if (room.adModeReason == null) room.adModeReason = null;
  if (room.lastHostSeekAt == null) room.lastHostSeekAt = 0;
  if (room.lastHardCorrectionAt == null) room.lastHardCorrectionAt = 0;
  if (room.reconnectSettleUntil == null) room.reconnectSettleUntil = 0;
  if (room.lastObservedSpreadSec === undefined) room.lastObservedSpreadSec = null;
  if (!room.titleSuggestions) room.titleSuggestions = new Map();
}

/**
 * Position reports still within POSITION_REPORT_STALE_MS — sole source for spread / adMode decisions.
 * @returns {{ clientId: string, rep: object }[]}
 */
function getFreshPositionReports(room, now) {
  ensureRoomPositionMaps(room);
  const out = [];
  for (const [cid, rep] of room.positionReports.entries()) {
    if (!rep || typeof rep.currentTime !== 'number' || !Number.isFinite(rep.currentTime)) continue;
    if (now - rep.receivedAt > POSITION_REPORT_STALE_MS) continue;
    out.push({ clientId: cid, rep });
  }
  return out;
}

/** @returns {{ clientId: string, rep: object, ex: number }[]} */
function buildFreshExtrapolatedRows(room, wallMs) {
  const fresh = getFreshPositionReports(room, wallMs);
  const rows = [];
  for (const { clientId, rep } of fresh) {
    const ex = extrapolatePositionReportTime(rep, wallMs);
    if (!Number.isFinite(ex)) continue;
    rows.push({ clientId, rep, ex });
  }
  return rows;
}

/** @param {boolean} [diagOnly] if true, only pushRoomDiag (no console) — avoids spam during adMode hold. */
function syncPolicyLog(roomCode, event, detail, diagOnly) {
  const t = Date.now();
  const line = `[PlayShare/sync:${roomCode}] ${event}`;
  if (!diagOnly) {
    if (detail && typeof detail === 'object') console.log(line, detail);
    else if (detail != null) console.log(line, String(detail));
    else console.log(line);
  }
  try {
    pushRoomDiag(roomCode, { t, type: event, ...(typeof detail === 'object' && detail ? detail : {}) });
  } catch {
    /* ignore */
  }
}

function broadcastHardSyncState(roomCode, room, wallMs, playing, currentTime, correctionReason) {
  broadcastHardSyncStateExcept(roomCode, room, wallMs, playing, currentTime, correctionReason, null);
}

/** Like `broadcastHardSyncState` but omit one socket (e.g. new joiner, who gets `ROOM_JOINED` separately). */
function broadcastHardSyncStateExcept(roomCode, room, wallMs, playing, currentTime, correctionReason, excludeWs) {
  const computedAt = Date.now();
  room.state = {
    playing: !!playing,
    currentTime,
    updatedAt: wallMs
  };
  room.lastHardCorrectionAt = wallMs;
  const sentAt = Date.now();
  const payload = {
    type: 'SYNC_STATE',
    state: {
      playing: !!playing,
      currentTime,
      computedAt,
      sentAt,
      syncKind: 'hard',
      correctionReason: correctionReason || null
    }
  };
  if (excludeWs) broadcast(roomCode, payload, excludeWs);
  else broadcastAll(roomCode, payload);
}

/**
 * Exit adMode: one hard correction — prefer fresh host telemetry, else slowest (laggard).
 * @param {{ clientId: string, rep: object, ex: number }[]} rows
 */
function applyAdModeExitCorrection(roomCode, room, wallMs, rows) {
  rows.sort((a, b) => a.ex - b.ex || String(a.clientId).localeCompare(String(b.clientId)));
  const lag = rows[0];
  const hostRow = rows.find((r) => r.clientId === room.host);
  const pick = hostRow || lag;
  const anchorTime = pick.ex;
  const anchorPlaying = !!pick.rep.playing;
  room.adMode = false;
  room.adModeStartedAt = 0;
  room.adModeReason = null;
  room.lastLaggardAnchorAt = wallMs;
  broadcastHardSyncState(roomCode, room, wallMs, anchorPlaying, anchorTime, CORRECTION_REASON.AD_MODE_EXIT);
  syncPolicyLog(roomCode, 'AD_MODE_EXIT', {
    spreadSec: +(Math.max(...rows.map((r) => r.ex)) - Math.min(...rows.map((r) => r.ex))).toFixed(3),
    usedHost: !!hostRow,
    anchorTime,
    anchorPlaying
  });
  return {
    applied: true,
    adModeExit: true,
    spreadSec: +(Math.max(...rows.map((r) => r.ex)) - Math.min(...rows.map((r) => r.ex))).toFixed(3),
    anchorTime,
    anchorPlaying,
    laggardClientId: lag.clientId,
    laggardUsername: lag.rep.username || null
  };
}

/** Exit adMode when fresh rows unavailable but timeout elapsed — use canonical room timeline. */
function applyAdModeExitCanonical(roomCode, room, wallMs) {
  const canonElapsed = room.state.playing ? (wallMs - room.state.updatedAt) / 1000 : 0;
  const t = room.state.currentTime + canonElapsed;
  room.adMode = false;
  room.adModeStartedAt = 0;
  room.adModeReason = null;
  room.lastLaggardAnchorAt = wallMs;
  broadcastHardSyncState(roomCode, room, wallMs, room.state.playing, t, CORRECTION_REASON.AD_MODE_EXIT);
  syncPolicyLog(roomCode, 'AD_MODE_EXIT', { reason: 'timeout_canonical_fallback', anchorTime: t });
  return {
    applied: true,
    adModeExit: true,
    spreadSec: null,
    anchorTime: t,
    anchorPlaying: room.state.playing,
    laggardClientId: null,
    laggardUsername: null
  };
}

/**
 * Spread / ad isolation + laggard anchor. Uses only fresh position reports for spread.
 * While room.adMode: no laggard anchor; exit via spread &lt; 2s or timeout → one hard SYNC_STATE.
 */
function runSpreadSyncPolicy(roomCode, room, wallMs) {
  ensureRoomPositionMaps(room);
  ensureRoomSyncPolicyFields(room);
  if (
    !Number.isFinite(LAGGARD_ANCHOR_SPREAD_SEC) ||
    LAGGARD_ANCHOR_SPREAD_SEC <= 0 ||
    room.members.size < 2
  ) {
    room.lastObservedSpreadSec = null;
    return null;
  }

  const rows = buildFreshExtrapolatedRows(room, wallMs);
  let spread = 0;
  if (rows.length >= 2) {
    const extrapolated = rows.map((r) => r.ex);
    spread = Math.max(...extrapolated) - Math.min(...extrapolated);
    room.lastObservedSpreadSec = spread;
  } else {
    room.lastObservedSpreadSec = null;
  }

  if (room.adMode) {
    const elapsed = wallMs - room.adModeStartedAt;
    if (rows.length >= 2) {
      const shouldExit = spread < AD_MODE_EXIT_SPREAD_SEC || elapsed >= AD_MODE_MAX_MS;
      if (shouldExit) {
        return applyAdModeExitCorrection(roomCode, room, wallMs, rows);
      }
    } else if (elapsed >= AD_MODE_MAX_MS) {
      return applyAdModeExitCanonical(roomCode, room, wallMs);
    } else {
      syncPolicyLog(roomCode, 'AD_MODE_SKIP_EXIT', { reason: 'fresh_reports_lt_2_wait_timeout' }, true);
    }
    syncPolicyLog(
      roomCode,
      'AD_MODE_HOLD',
      {
        spreadSec: rows.length >= 2 ? +spread.toFixed(3) : null,
        elapsedMs: elapsed,
        reason: 'divergence_isolation_active'
      },
      true
    );
    return null;
  }

  if (rows.length < 2) return null;

  if (
    Number.isFinite(AD_MODE_ENTER_SPREAD_SEC) &&
    AD_MODE_ENTER_SPREAD_SEC > 0 &&
    spread >= AD_MODE_ENTER_SPREAD_SEC &&
    wallMs - room.lastHostSeekAt >= AD_MODE_HOST_SEEK_QUIET_MS &&
    wallMs - room.lastHardCorrectionAt >= AD_MODE_ENTER_HARD_GAP_MS
  ) {
    room.adMode = true;
    room.adModeStartedAt = wallMs;
    room.adModeReason = 'divergence_suspected_ad';
    syncPolicyLog(roomCode, 'AD_MODE_ENTER', {
      spreadSec: +spread.toFixed(3),
      reason: room.adModeReason
    });
    try {
      clearPositionSnapshotTimer(roomCode);
      schedulePositionSnapshot(roomCode);
    } catch {
      /* ignore */
    }
    return null;
  }

  if (wallMs < room.reconnectSettleUntil) {
    syncPolicyLog(roomCode, 'LAGGARD_SKIPPED', { reason: 'reconnect_settle', until: room.reconnectSettleUntil });
    return null;
  }
  if (wallMs - room.lastHardCorrectionAt < HARD_CORRECTION_MIN_GAP_MS) {
    syncPolicyLog(roomCode, 'LAGGARD_SKIPPED', {
      reason: 'hard_correction_cooldown',
      gapMs: wallMs - room.lastHardCorrectionAt
    });
    return null;
  }
  if (wallMs - room.lastLaggardAnchorAt < LAGGARD_ANCHOR_MIN_INTERVAL_MS) return null;

  const adIsolation = activeAdBreaksList(room).length > 0 ? AD_DIVERGENCE_SPREAD_MULT : 1;
  const spreadRequired = LAGGARD_ANCHOR_SPREAD_SEC * adIsolation;
  if (spread < spreadRequired) return null;

  let lowConf = 0;
  for (const r of rows) {
    if (normalizePositionConfidence(r.rep.confidence) === 'LOW') lowConf++;
  }
  if (rows.length >= 2 && lowConf / rows.length >= LOW_CONFIDENCE_ANCHOR_RATIO) {
    syncPolicyLog(roomCode, 'LAGGARD_SKIPPED', { reason: 'low_confidence_quorum' });
    return null;
  }

  rows.sort((a, b) => a.ex - b.ex || String(a.clientId).localeCompare(String(b.clientId)));
  const lag = rows[0];
  const anchorTime = lag.ex;
  const anchorPlaying = !!lag.rep.playing;

  room.lastLaggardAnchorAt = wallMs;
  broadcastHardSyncState(roomCode, room, wallMs, anchorPlaying, anchorTime, CORRECTION_REASON.LAGGARD_ANCHOR);
  syncPolicyLog(roomCode, 'LAGGARD_ANCHOR', {
    spreadSec: +spread.toFixed(3),
    laggardClientId: lag.clientId
  });

  return {
    applied: true,
    spreadSec: +spread.toFixed(3),
    anchorTime,
    anchorPlaying,
    laggardClientId: lag.clientId,
    laggardUsername: lag.rep.username || null,
    correctionReason: CORRECTION_REASON.LAGGARD_ANCHOR
  };
}

function broadcastPositionSnapshot(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  ensureRoomPositionMaps(room);
  const wallMs = Date.now();
  room.lastPositionSnapshotBroadcastAt = wallMs;

  ensureRoomSyncPolicyFields(room);
  let laggardAnchor = null;
  try {
    laggardAnchor = runSpreadSyncPolicy(roomCode, room, wallMs);
  } catch (e) {
    console.warn('[POSITION_SNAPSHOT] spread sync policy failed', e?.message || e);
  }

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
      confidence: normalizePositionConfidence(rep.confidence),
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
    members,
    laggardAnchor,
    roomSyncPolicy: {
      adMode: !!room.adMode,
      adModeReason: room.adModeReason,
      adModeStartedAt: room.adModeStartedAt,
      reconnectSettleUntil: room.reconnectSettleUntil,
      lastHardCorrectionAt: room.lastHardCorrectionAt,
      lastHostSeekAt: room.lastHostSeekAt
    }
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

const PRIVACY_HTML_PATH = path.join(__dirname, 'public', 'privacy.html');
let privacyPolicyHtml = '';
try {
  privacyPolicyHtml = fs.readFileSync(PRIVACY_HTML_PATH, 'utf8');
  console.log(`[PlayShare] Privacy policy: GET /privacy (${privacyPolicyHtml.length} bytes)`);
} catch (e) {
  console.warn('[PlayShare] public/privacy.html missing — /privacy will return 503:', e.message);
}

const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');
let homepageTemplate = '';
try {
  homepageTemplate = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  console.log(`[PlayShare] Homepage: GET / (${homepageTemplate.length} bytes template)`);
} catch (e) {
  console.warn('[PlayShare] public/index.html missing — / will stay health text:', e.message);
}

/** Escape double quotes for embedding in HTML attribute values. */
function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

const EXTENSION_ZIP_PATH = path.join(__dirname, 'public', 'install', 'playshare-extension.zip');
const EXTENSION_ZIP_URL_PATH = '/install/playshare-extension.zip';
const EXTENSION_VERSION_PATH = path.join(__dirname, 'public', 'install', 'playshare-extension.version');

function extensionZipAvailable() {
  try {
    const st = fs.statSync(EXTENSION_ZIP_PATH);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/** Safe fragment for HTML attributes (semver / manifest version). */
function sanitizeExtensionVersion(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 32) return '';
  return /^[0-9A-Za-z._+-]+$/.test(s) ? s : '';
}

/**
 * Version of the .zip offered at /install/playshare-extension.zip.
 * Prefer sidecar from `npm run package:extension`; else root manifest when zip exists (dev fallback).
 */
function readExtensionZipVersion() {
  if (!extensionZipAvailable()) return '';
  try {
    const line = fs.readFileSync(EXTENSION_VERSION_PATH, 'utf8').split(/\r?\n/)[0];
    const fromFile = sanitizeExtensionVersion(line);
    if (fromFile) return fromFile;
  } catch {}
  try {
    const manifestPath = path.join(__dirname, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return sanitizeExtensionVersion(m && m.version);
  } catch {
    return '';
  }
}

function catalogCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function tmdbApiKeyFromEnv() {
  const k = process.env.TMDB_API_KEY || process.env.PLAYSHARE_TMDB_API_KEY;
  return k && String(k).trim() ? String(k).trim() : '';
}

function renderHomepageHtml() {
  if (!homepageTemplate) return null;
  const storeUrl = String(process.env.PLAYSHARE_CHROME_STORE_URL || '').trim();
  const attrs = [];
  if (storeUrl) attrs.push(`data-chrome-store-url="${escapeHtmlAttr(storeUrl)}"`);
  if (extensionZipAvailable()) {
    attrs.push(`data-extension-zip-url="${escapeHtmlAttr(EXTENSION_ZIP_URL_PATH)}"`);
    const ver = readExtensionZipVersion();
    if (ver) attrs.push(`data-extension-zip-version="${escapeHtmlAttr(ver)}"`);
  }
  const bodyAttrs = attrs.length ? ` ${attrs.join(' ')}` : '';
  return homepageTemplate.replace('{{BODY_ATTRS}}', bodyAttrs);
}

const httpServer = http.createServer((req, res) => {
  // WebSocket clients hit `/` (or any path) with Upgrade: websocket — do not send 404 here or the
  // handshake fails (Railway/extension saw "Unexpected response code: 404").
  if (String(req.headers.upgrade || '').toLowerCase() === 'websocket') {
    return;
  }
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  if (
    (url.pathname === '/privacy' || url.pathname === '/privacy/') &&
    (req.method === 'GET' || req.method === 'HEAD')
  ) {
    if (!privacyPolicyHtml) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : 'Privacy policy unavailable.\n');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(req.method === 'HEAD' ? undefined : privacyPolicyHtml);
    return;
  }
  if (
    (url.pathname === EXTENSION_ZIP_URL_PATH || url.pathname === `${EXTENSION_ZIP_URL_PATH}/`) &&
    (req.method === 'GET' || req.method === 'HEAD')
  ) {
    if (!extensionZipAvailable()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        req.method === 'HEAD'
          ? undefined
          : 'Extension package not available. Run npm run package:extension and add playshare-extension.zip to public/install/ (or deploy with the Docker image that builds it).\n'
      );
      return;
    }
    let buf;
    try {
      buf = fs.readFileSync(EXTENSION_ZIP_PATH);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : 'Could not read extension package.\n');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="playshare-extension.zip"',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=600'
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
    return;
  }
  if (
    (url.pathname === '/' ||
      url.pathname === '/index.html' ||
      url.pathname === '/index.html/') &&
    (req.method === 'GET' || req.method === 'HEAD')
  ) {
    const html = renderHomepageHtml();
    if (html) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300'
      });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }
  }
  if (url.pathname === '/brand-mark.png' && req.method === 'GET') {
    const pngPath = path.join(__dirname, 'public', 'brand-mark.png');
    try {
      const buf = fs.readFileSync(pngPath);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400'
      });
      res.end(buf);
    } catch {
      res.writeHead(404);
      res.end();
    }
    return;
  }
  // PlayShare web app shell (static; run `npm run build:web` to generate `public/app/*`)
  if (
    (url.pathname === '/app' || url.pathname === '/app/') &&
    (req.method === 'GET' || req.method === 'HEAD')
  ) {
    const appIndex = path.join(__dirname, 'public', 'app', 'index.html');
    try {
      const html = fs.readFileSync(appIndex, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(req.method === 'HEAD' ? undefined : html);
    } catch {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        req.method === 'HEAD'
          ? undefined
          : 'Web app not built. Run: npm run build:web\n'
      );
    }
    return;
  }
  if (
    (url.pathname === '/app/index.html' || url.pathname === '/app/index.html/') &&
    (req.method === 'GET' || req.method === 'HEAD')
  ) {
    const appIndex = path.join(__dirname, 'public', 'app', 'index.html');
    try {
      const html = fs.readFileSync(appIndex, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(req.method === 'HEAD' ? undefined : html);
    } catch {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : 'Web app not built. Run: npm run build:web\n');
    }
    return;
  }
  if (url.pathname === '/app/bundle.js' && req.method === 'GET') {
    const bundlePath = path.join(__dirname, 'public', 'app', 'bundle.js');
    try {
      const buf = fs.readFileSync(bundlePath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(buf);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Web app bundle missing. Run: npm run build:web\n');
    }
    return;
  }
  if (url.pathname === '/app/app.css' && (req.method === 'GET' || req.method === 'HEAD')) {
    const cssPath = path.join(__dirname, 'public', 'app', 'app.css');
    try {
      const buf = fs.readFileSync(cssPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'public, max-age=300'
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : 'Web app CSS missing. Run: npm run build:web\n');
    }
    return;
  }
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
  // Health checks — use /health (plain text). GET / serves the marketing homepage when public/index.html exists.
  if (
    url.pathname === '/health' &&
    (req.method === 'GET' || req.method === 'HEAD')
  ) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : 'PlayShare signaling OK\n');
    return;
  }
  if (url.pathname === '/diag/upload' || url.pathname === '/diag/upload/') {
    if (req.method === 'OPTIONS' || req.method === 'POST') {
      handleDiagUpload(req, res).catch((e) => {
        console.error('[PlayShare/diag/upload]', e);
        try {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'internal' }));
        } catch {
          /* ignore */
        }
      });
      return;
    }
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
    return;
  }
  if (url.pathname.startsWith('/diag/intel')) {
    const base = `http://${req.headers.host || 'localhost'}`;
    handleDiagIntel(req, res, base).catch((e) => {
      console.error('[PlayShare/diag/intel]', e);
      try {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'internal' }));
      } catch {
        /* ignore */
      }
    });
    return;
  }
  if (
    url.pathname === '/' &&
    (req.method === 'GET' || req.method === 'HEAD') &&
    !homepageTemplate
  ) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : 'PlayShare signaling OK\n');
    return;
  }
  // TMDB proxy: PlayShare desktop app fetches catalog here (API key stays server-side; extension + web app omit this).
  if (url.pathname === '/api/catalog/spotlight' || url.pathname === '/api/catalog/spotlight/') {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', ...catalogCorsHeaders() };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, headers);
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
      return;
    }
    const apiKey = tmdbApiKeyFromEnv();
    if (!apiKey) {
      res.writeHead(503, headers);
      res.end(
        JSON.stringify({
          ok: false,
          error: 'tmdb_not_configured',
          message: 'Set TMDB_API_KEY (or PLAYSHARE_TMDB_API_KEY) on the server.'
        })
      );
      return;
    }
    const mediaRaw = (url.searchParams.get('media') || 'tv').toLowerCase();
    const media = mediaRaw === 'movie' ? 'movie' : 'tv';
    getSpotlightTrendingWeek(apiKey, media)
      .then((payload) => {
        res.writeHead(200, {
          ...headers,
          'Cache-Control': 'public, max-age=300'
        });
        res.end(JSON.stringify({ ok: true, ...payload }));
      })
      .catch((e) => {
        console.error('[PlayShare/api/catalog/spotlight]', e && e.message ? e.message : e);
        res.writeHead(502, headers);
        res.end(JSON.stringify({ ok: false, error: 'tmdb_upstream' }));
      });
    return;
  }
  if (url.pathname === '/api/catalog/search' || url.pathname === '/api/catalog/search/') {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', ...catalogCorsHeaders() };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, headers);
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
      return;
    }
    const apiKey = tmdbApiKeyFromEnv();
    if (!apiKey) {
      res.writeHead(503, headers);
      res.end(
        JSON.stringify({
          ok: false,
          error: 'tmdb_not_configured',
          message: 'Set TMDB_API_KEY (or PLAYSHARE_TMDB_API_KEY) on the server.'
        })
      );
      return;
    }
    const q = url.searchParams.get('q') || '';
    const page = url.searchParams.get('page') || '1';
    searchMulti(apiKey, q, page)
      .then((payload) => {
        res.writeHead(200, { ...headers, 'Cache-Control': 'public, max-age=120' });
        res.end(JSON.stringify({ ok: true, ...payload }));
      })
      .catch((e) => {
        console.error('[PlayShare/api/catalog/search]', e && e.message ? e.message : e);
        res.writeHead(502, headers);
        res.end(JSON.stringify({ ok: false, error: 'tmdb_upstream' }));
      });
    return;
  }
  if (url.pathname === '/api/catalog/genres' || url.pathname === '/api/catalog/genres/') {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', ...catalogCorsHeaders() };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, headers);
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
      return;
    }
    const apiKey = tmdbApiKeyFromEnv();
    if (!apiKey) {
      res.writeHead(503, headers);
      res.end(
        JSON.stringify({
          ok: false,
          error: 'tmdb_not_configured',
          message: 'Set TMDB_API_KEY (or PLAYSHARE_TMDB_API_KEY) on the server.'
        })
      );
      return;
    }
    const media = (url.searchParams.get('media') || 'tv').toLowerCase();
    if (media !== 'movie' && media !== 'tv') {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ ok: false, error: 'invalid_media' }));
      return;
    }
    getGenreList(apiKey, media)
      .then((payload) => {
        res.writeHead(200, { ...headers, 'Cache-Control': 'public, max-age=3600' });
        res.end(JSON.stringify({ ok: true, ...payload }));
      })
      .catch((e) => {
        console.error('[PlayShare/api/catalog/genres]', e && e.message ? e.message : e);
        res.writeHead(502, headers);
        res.end(JSON.stringify({ ok: false, error: 'tmdb_upstream' }));
      });
    return;
  }
  if (url.pathname === '/api/catalog/discover' || url.pathname === '/api/catalog/discover/') {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', ...catalogCorsHeaders() };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, headers);
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
      return;
    }
    const apiKey = tmdbApiKeyFromEnv();
    if (!apiKey) {
      res.writeHead(503, headers);
      res.end(
        JSON.stringify({
          ok: false,
          error: 'tmdb_not_configured',
          message: 'Set TMDB_API_KEY (or PLAYSHARE_TMDB_API_KEY) on the server.'
        })
      );
      return;
    }
    const media = (url.searchParams.get('media') || 'tv').toLowerCase();
    if (media !== 'movie' && media !== 'tv') {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ ok: false, error: 'invalid_media' }));
      return;
    }
    const genreRaw = url.searchParams.get('genre') || '';
    const genreId = parseInt(genreRaw, 10);
    if (!Number.isFinite(genreId) || genreId < 1) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ ok: false, error: 'invalid_genre' }));
      return;
    }
    const page = url.searchParams.get('page') || '1';
    discoverByGenre(apiKey, { media, genreId, page })
      .then((payload) => {
        res.writeHead(200, { ...headers, 'Cache-Control': 'public, max-age=300' });
        res.end(JSON.stringify({ ok: true, ...payload }));
      })
      .catch((e) => {
        console.error('[PlayShare/api/catalog/discover]', e && e.message ? e.message : e);
        res.writeHead(502, headers);
        res.end(JSON.stringify({ ok: false, error: 'tmdb_upstream' }));
      });
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
          adBreakClients: new Set(),
          adMode: false,
          adModeStartedAt: 0,
          adModeReason: null,
          lastHostSeekAt: 0,
          lastHardCorrectionAt: 0,
          reconnectSettleUntil: 0,
          titleSuggestions: new Map()
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
        ensureRoomSyncPolicyFields(room);
        room.reconnectSettleUntil = Date.now() + RECONNECT_SETTLE_MS;
        syncPolicyLog(roomCode, 'RECONNECT_SETTLE', { until: room.reconnectSettleUntil });
        const color = assignColor(roomCode);
        /** Members already in the room before this socket joins (1 = host only, 2+ = group). */
        const priorMemberCount = room.members.size;
        const rejoinAfterDrop = msg.rejoinAfterDrop === true;
        const pauseRoomForJoinSync = priorMemberCount >= 1 && !rejoinAfterDrop;

        room.members.set(clientId, { ws, username, color });
        client.roomCode = roomCode;
        client.username = username;
        client.color = color;

        const wallMs = Date.now();

        if (pauseRoomForJoinSync) {
          const elapsed = room.state.playing ? (wallMs - room.state.updatedAt) / 1000 : 0;
          const anchorTime = room.state.currentTime + elapsed;
          broadcastHardSyncStateExcept(
            roomCode,
            room,
            wallMs,
            false,
            anchorTime,
            CORRECTION_REASON.MEMBER_JOIN_SYNC,
            ws
          );
          syncPolicyLog(roomCode, 'MEMBER_JOIN_PAUSE_SYNC', { username, anchorTime: +anchorTime.toFixed(2) });
        }

        const computedAt = Date.now();
        const elapsedJoin = room.state.playing ? (computedAt - room.state.updatedAt) / 1000 : 0;
        const joinState = {
          playing: room.state.playing,
          currentTime: room.state.currentTime + elapsedJoin,
          computedAt,
          sentAt: computedAt,
          syncKind: 'hard',
          correctionReason: CORRECTION_REASON.JOIN
        };

        // Send current state to the new joiner (paused + anchor if we ran join sync)
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

        // Notify existing members (include activeAdBreaks so clients can resync if they missed AD_BREAK_*)
        broadcast(roomCode, {
          type: 'MEMBER_JOINED',
          clientId,
          username,
          color,
          hostOnlyControl: room.hostOnlyControl,
          countdownOnPlay: room.countdownOnPlay,
          members: getMemberList(roomCode),
          activeAdBreaks: activeAdBreaksList(room)
        }, ws);

        if (pauseRoomForJoinSync) {
          broadcastAll(roomCode, {
            type: 'SYSTEM_MSG',
            text: `📥 ${username} joined — playback paused so everyone matches the same moment`
          });
        }

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
        if (room.host === clientId) {
          ensureRoomSyncPolicyFields(room);
          room.lastHostSeekAt = Date.now();
          syncPolicyLog(client.roomCode, 'HOST_SEEK', { at: room.lastHostSeekAt });
        }
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
            confidence: 'HIGH',
            receivedAt: Date.now()
          });
          schedulePositionSnapshot(client.roomCode);
          // Broadcast position to viewers so they can correct drift (host excluded)
          const elapsed = room.state.playing ? (Date.now() - room.state.updatedAt) / 1000 : 0;
          const computedAt = Date.now();
          const sentAt = Date.now();
          broadcast(client.roomCode, {
            type: 'SYNC_STATE',
            state: {
              playing: room.state.playing,
              currentTime: room.state.currentTime + elapsed,
              computedAt,
              sentAt,
              syncKind: 'soft',
              correctionReason: CORRECTION_REASON.HOST_ANCHOR_SOFT
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
        ensureRoomSyncPolicyFields(room);
        const t = msg.currentTime;
        if (typeof t !== 'number' || t < 0 || !Number.isFinite(t)) return;
        ensureRoomPositionMaps(room);
        room.positionReports.set(clientId, {
          username: client.username,
          isHost: room.host === clientId,
          currentTime: t,
          playing: !!msg.playing,
          confidence: normalizePositionConfidence(msg.confidence),
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
        const sentAt = Date.now();
        sendTo(ws, {
          type: 'SYNC_STATE',
          state: {
            playing: room.state.playing,
            currentTime: room.state.currentTime + elapsed,
            computedAt,
            sentAt,
            syncKind: 'hard',
            correctionReason: CORRECTION_REASON.RECONNECT_SYNC
          }
        });
        break;
      }

      case 'HEARTBEAT': {
        // No server-side idle disconnect: closes usually mean client unload, network loss, or proxy/platform limits (e.g. hosting LB idle timeout — compare with client 5s heartbeats).
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

      case 'DIAG_PROFILER_COLLECTION':
      case 'DIAG_PEER_RECORDING_SAMPLE': {
        if (!client.roomCode) return;
        broadcastAll(client.roomCode, {
          ...msg,
          fromClientId: clientId,
          fromUsername: client.username
        });
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

      case 'TITLE_SUGGEST': {
        if (!client.roomCode) return;
        const title = (msg.title || '').trim().slice(0, 200);
        if (!title) return;
        const media = msg.media === 'movie' || msg.media === 'tv' ? msg.media : null;
        if (!media) return;
        const rawId = msg.tmdbId;
        const tmdbId =
          typeof rawId === 'number' && Number.isFinite(rawId)
            ? rawId
            : parseInt(String(rawId || ''), 10);
        if (!Number.isFinite(tmdbId) || tmdbId <= 0) return;
        let posterUrl = typeof msg.posterUrl === 'string' ? msg.posterUrl.trim().slice(0, 500) : '';
        if (posterUrl && !/^https:\/\//i.test(posterUrl)) posterUrl = '';
        const overview = (msg.overview || '').replace(/\s+/g, ' ').trim().slice(0, 280);
        const year = (msg.year != null ? String(msg.year) : '').replace(/[^\d]/g, '').slice(0, 4);
        const roomRef = rooms.get(client.roomCode);
        if (roomRef) {
          ensureRoomSyncPolicyFields(roomRef);
          const sk = `${media}:${tmdbId}`;
          roomRef.titleSuggestions.set(sk, { suggestedBy: clientId });
        }
        broadcastAll(client.roomCode, {
          type: 'TITLE_SUGGEST',
          clientId,
          username: client.username,
          color: client.color,
          title,
          media,
          tmdbId,
          overview,
          posterUrl: posterUrl || null,
          year: year || null,
          timestamp: Date.now()
        });
        break;
      }

      case 'TITLE_SUGGEST_REMOVE': {
        if (!client.roomCode) return;
        const roomRm = rooms.get(client.roomCode);
        if (!roomRm) return;
        ensureRoomSyncPolicyFields(roomRm);
        const mediaRm = msg.media === 'movie' || msg.media === 'tv' ? msg.media : null;
        if (!mediaRm) {
          try {
            sendTo(ws, { type: 'ERROR', code: 'BAD_REQUEST', message: 'Invalid media type.' });
          } catch {}
          return;
        }
        const rawIdRm = msg.tmdbId;
        const tmdbIdRm =
          typeof rawIdRm === 'number' && Number.isFinite(rawIdRm)
            ? rawIdRm
            : parseInt(String(rawIdRm || ''), 10);
        if (!Number.isFinite(tmdbIdRm) || tmdbIdRm <= 0) {
          try {
            sendTo(ws, { type: 'ERROR', code: 'BAD_REQUEST', message: 'Invalid title id.' });
          } catch {}
          return;
        }
        const skRm = `${mediaRm}:${tmdbIdRm}`;
        const metaRm = roomRm.titleSuggestions.get(skRm);
        if (!metaRm) {
          try {
            sendTo(ws, {
              type: 'ERROR',
              code: 'NOT_FOUND',
              message: 'That suggestion is not in this room anymore.'
            });
          } catch {}
          return;
        }
        if (clientId !== roomRm.host && clientId !== metaRm.suggestedBy) {
          try {
            sendTo(ws, {
              type: 'ERROR',
              code: 'FORBIDDEN',
              message: 'Only the host or the person who suggested it can remove this title.'
            });
          } catch {}
          return;
        }
        roomRm.titleSuggestions.delete(skRm);
        broadcastAll(client.roomCode, {
          type: 'TITLE_SUGGEST_REMOVED',
          media: mediaRm,
          tmdbId: tmdbIdRm,
          removedByClientId: clientId,
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

function logStartupBanner() {
  const lanWs = getServerUrl();
  console.log('✅ PlayShare server running (signaling host = this computer)');
  console.log(`   Extension on this machine: ws://localhost:${PORT}`);
  if (lanWs !== `ws://localhost:${PORT}`) {
    console.log(`   Phones & other PCs on your LAN: ${lanWs}`);
  }
  console.log(`   Join page: ${getHttpJoinUrl()}/join?code=XXXXXX`);
  if (privacyPolicyHtml) {
    console.log(`   Privacy policy: ${getHttpJoinUrl()}/privacy`);
  }
  try {
    const appShell = path.join(__dirname, 'public', 'app', 'index.html');
    fs.statSync(appShell);
    console.log(`   Web app shell: ${getHttpJoinUrl()}/app`);
  } catch {
    console.log('   Web app shell: (not built — run npm run build:web)');
  }
  if (homepageTemplate) {
    console.log(`   Homepage: ${getHttpJoinUrl()}/`);
    const store = String(process.env.PLAYSHARE_CHROME_STORE_URL || '').trim();
    if (extensionZipAvailable()) {
      const v = readExtensionZipVersion();
      console.log(
        `   Extension .zip: ${getHttpJoinUrl()}${EXTENSION_ZIP_URL_PATH}` + (v ? ` (v${v})` : '')
      );
    }
    if (!store) {
      console.log(
        '   Chrome Web Store: set PLAYSHARE_CHROME_STORE_URL when the listing is live (homepage shows both .zip and store options).'
      );
    }
    if (!extensionZipAvailable()) {
      console.log(
        '   (No .zip yet: run npm run package:extension and add public/install/playshare-extension.zip, or deploy the Docker image that builds it.)'
      );
    }
  }
}

console.log('[PlayShare] boot', {
  node: process.version,
  cwd: process.cwd(),
  PORT,
  onRailway,
  RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT || null
});

// Bind for Railway + Docker: prefer dual-stack (:: + IPv4-mapped) so mesh traffic over IPv4 or IPv6 reaches us.
let listenFallbackIpv4 = false;
function onListenError(err) {
  httpServer.removeListener('error', onListenError);
  if (!listenFallbackIpv4 && (err.code === 'EAFNOSUPPORT' || err.code === 'EINVAL')) {
    listenFallbackIpv4 = true;
    httpServer.on('error', onListenError);
    httpServer.listen(PORT, '0.0.0.0', finishListen);
    return;
  }
  if (err.code === 'EADDRINUSE') console.error('Port already in use:', err.message);
  else console.error('Server listen error:', err.message);
  process.exit(1);
}

function finishListen() {
  httpServer.removeListener('error', onListenError);
  const a = httpServer.address();
  if (a && typeof a === 'object') {
    console.log(`✅ Listening ${a.address}:${a.port} (${a.family})`);
  }
  const workerEnabled = String(process.env.PLAYSHARE_DIAG_AI_INLINE_WORKER || '1').trim().toLowerCase() !== '0';
  if (workerEnabled) {
    const supabase = getSupabaseAdmin();
    if (supabase) {
      const loop = startDiagAiWorkerLoop(supabase);
      console.log('[PlayShare/diag-ai-worker] inline loop started', loop.workerId);
    } else {
      console.log('[PlayShare/diag-ai-worker] inline loop skipped (Supabase not configured)');
    }
  } else {
    console.log('[PlayShare/diag-ai-worker] inline loop disabled via PLAYSHARE_DIAG_AI_INLINE_WORKER=0');
  }
  logStartupBanner();
}

httpServer.on('error', onListenError);
httpServer.listen({ port: PORT, host: '::', ipv6Only: false }, finishListen);
