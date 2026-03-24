importScripts('server-config.js');
importScripts('shared/streaming-hosts.generated.js');
importScripts('shared/diag-anonymize.js');

/**
 * PlayShare — Background Service Worker
 * Manages WebSocket connection lifecycle and message routing between
 * the popup, content scripts, and the sync server.
 * Server URL: from storage (set by join link) or default. Join links include server URL.
 */

let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
/** Run after WebSocket is OPEN — queued while CONNECTING or during overlapping connect() calls. */
const wsOpenWaiters = [];
/** True from starting storage read until this socket instance fires open or close (prevents duplicate sockets). */
let wsConnectInProgress = false;

function flushWsOpenWaiters() {
  while (wsOpenWaiters.length) {
    const cb = wsOpenWaiters.shift();
    try {
      if (typeof cb === 'function') cb();
    } catch (e) {
      console.error('[PlayShare] ws open waiter', e);
    }
  }
}
let lastHeartbeatSentAt = 0;
let lastRtt = null;  // ms — for latency compensation (avoids clock skew)
let roomState = null; // { roomCode, clientId, username, color, isHost, members, state }

/** Lifetime WebSocket stats (resets if service worker restarts). For diagnostic exports. */
let wsOpenCount = 0;
let wsCloseCount = 0;
let lastWsOpenedAt = null;
let lastWsClosedAt = null;
/** Count of dropped server messages (WebSocket not OPEN). Resets with service worker. */
let wsSendFailures = 0;
let lastWsSendFailureAt = null;
/** After a socket drop while in a room, re-send JOIN_ROOM on next open (server removes dead sockets). */
let needsAutoRejoin = false;
/** After auto-rejoin JOIN, content/bg do one-shot resync (host pushes position, viewer uses ROOM_JOINED + SYNC_REQUEST). */
let pendingReconnectResync = false;
/** When non-OPEN with an active room, wall-clock start for “still down” → “can’t reach server” messaging. */
let transportStallStartedAt = 0;
let transportStallBroadcastTimer = null;

const DEFAULT_SERVER_URL = typeof PLAYSHARE_SERVER_URL !== 'undefined' ? PLAYSHARE_SERVER_URL : 'wss://playshare-production.up.railway.app';

/**
 * HTTP origin for REST (e.g. POST /diag/upload). Uses only protocol + host (+ port);
 * strips any path on the WebSocket URL so we do not POST to …/wrongpath/diag/upload (404).
 */
function playShareHttpOriginFromServerUrl(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  let t = raw.trim();
  if (!t) return null;
  if (!/^wss?:\/\//i.test(t)) t = `wss://${t.replace(/^\/\//, '')}`;
  try {
    const u = new URL(t);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
    const httpProto = u.protocol === 'ws:' ? 'http:' : 'https:';
    return `${httpProto}//${u.host}`;
  } catch {
    return null;
  }
}

function clearTransportStallTimer() {
  if (transportStallBroadcastTimer) {
    clearTimeout(transportStallBroadcastTimer);
    transportStallBroadcastTimer = null;
  }
}

function scheduleTransportStallRefresh() {
  clearTransportStallTimer();
  transportStallBroadcastTimer = setTimeout(() => {
    transportStallBroadcastTimer = null;
    broadcastWsStatusToTabs();
  }, 12500);
}

/** Popup GET_DIAG + sidebar: human line + phase (no new sync logic). */
function buildWsStatusPayload() {
  const open = ws && ws.readyState === WebSocket.OPEN;
  if (open) {
    return { open: true, connectionMessage: 'Connected', transportPhase: 'connected' };
  }
  const connecting = ws && ws.readyState === WebSocket.CONNECTING;
  if (!roomState) {
    return { open: false, connectionMessage: 'Offline', transportPhase: 'offline' };
  }
  if (connecting || wsConnectInProgress) {
    return { open: false, connectionMessage: 'Connecting…', transportPhase: 'connecting' };
  }
  const stallMs = transportStallStartedAt ? Date.now() - transportStallStartedAt : 0;
  if (stallMs > 12000) {
    return { open: false, connectionMessage: "Can't reach server", transportPhase: 'unreachable' };
  }
  return { open: false, connectionMessage: 'Reconnecting…', transportPhase: 'reconnecting' };
}

function broadcastWsStatusToTabs() {
  const p = buildWsStatusPayload();
  broadcastToTabs({ type: 'WS_STATUS', ...p });
}

/** First install / empty storage: persist default so popup shows the same URL the service worker uses. */
function ensureDefaultServerUrlSeeded() {
  chrome.storage.local.get(['serverUrl'], (data) => {
    const u = data.serverUrl;
    if (u == null || String(u).trim() === '') {
      chrome.storage.local.set({ serverUrl: DEFAULT_SERVER_URL });
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaultServerUrlSeeded();
  // Move installs off the old localhost default when this build targets a household Mac server.
  chrome.storage.local.get(['serverUrl'], (data) => {
    const u = data.serverUrl != null ? String(data.serverUrl).trim() : '';
    const legacyLocal =
      u === 'ws://localhost:8765' ||
      u === 'ws://127.0.0.1:8765' ||
      /^ws:\/\/10\.0\.0\.\d+:8765\/?$/.test(u) ||
      /^ws:\/\/192\.168\.\d+\.\d+:8765\/?$/.test(u);
    if (DEFAULT_SERVER_URL.startsWith('wss://') && legacyLocal) {
      chrome.storage.local.set({ serverUrl: DEFAULT_SERVER_URL });
    }
  });
});
ensureDefaultServerUrlSeeded();

// ── WebSocket management ──────────────────────────────────────────────────────

function connect(onOpen) {
  if (typeof onOpen === 'function') wsOpenWaiters.push(onOpen);

  if (ws && ws.readyState === WebSocket.OPEN) {
    flushWsOpenWaiters();
    return;
  }

  if (ws && ws.readyState === WebSocket.CONNECTING) {
    return;
  }

  if (wsConnectInProgress) {
    return;
  }

  wsConnectInProgress = true;
  chrome.storage.local.get(['serverUrl'], (data) => {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        wsConnectInProgress = false;
        flushWsOpenWaiters();
        return;
      }
      if (ws && ws.readyState === WebSocket.CONNECTING) {
        wsConnectInProgress = false;
        return;
      }

      const url = data.serverUrl || DEFAULT_SERVER_URL;
      ws = new WebSocket(url);
      broadcastWsStatusToTabs();
      broadcastToPopup({ type: 'WS_STATUS', ...buildWsStatusPayload() });
      let opened = false;

      ws.onopen = () => {
        opened = true;
        wsConnectInProgress = false;
        console.log('[PlayShare] Connected to server');
        wsOpenCount++;
        lastWsOpenedAt = Date.now();
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        transportStallStartedAt = 0;
        clearTransportStallTimer();
        lastHeartbeatSentAt = Date.now();
        ws.send(JSON.stringify({ type: 'HEARTBEAT' }));
        startHeartbeat();
        flushWsOpenWaiters();

        if (roomState?.roomCode && roomState?.username && needsAutoRejoin) {
          needsAutoRejoin = false;
          pendingReconnectResync = true;
          ws.send(
            JSON.stringify({
              type: 'JOIN_ROOM',
              roomCode: roomState.roomCode,
              username: roomState.username
            })
          );
        } else {
          needsAutoRejoin = false;
        }

        broadcastWsStatusToTabs();
        const st = buildWsStatusPayload();
        broadcastToPopup({ type: 'WS_STATUS', ...st });
      };

      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        handleServerMessage(msg);
      };

      ws.onclose = () => {
        wsConnectInProgress = false;
        if (!opened && wsOpenWaiters.length) {
          console.warn('[PlayShare] WebSocket closed before open; pending actions dropped. Check server URL (on another PC use the host machine LAN IP, not localhost).');
          wsOpenWaiters.length = 0;
        }
        console.log('[PlayShare] Disconnected from server');
        wsCloseCount++;
        lastWsClosedAt = Date.now();
        stopHeartbeat();
        if (roomState) {
          needsAutoRejoin = true;
          transportStallStartedAt = Date.now();
          scheduleTransportStallRefresh();
        } else {
          transportStallStartedAt = 0;
          clearTransportStallTimer();
        }
        broadcastWsStatusToTabs();
        const st = buildWsStatusPayload();
        broadcastToPopup({ type: 'WS_STATUS', ...st });
        scheduleReconnect();
      };

      ws.onerror = () => {
        console.error(
          `[PlayShare] WebSocket failed for ${url}. ` +
            'net::ERR_CONNECTION_REFUSED means nothing accepted the connection — check Server URL in the popup (default is wss:// to Railway). For self-hosted, run `npm start` or use ws://your-server:port on the same network.'
        );
      };
    } catch (e) {
      wsConnectInProgress = false;
      console.error('[PlayShare] connect failed', e);
    }
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (roomState) connect();
  }, 3000);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      lastHeartbeatSentAt = Date.now();
      ws.send(JSON.stringify({ type: 'HEARTBEAT' }));
    }
  }, 5000);  // 5s for fresher RTT (was 20s)
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  wsSendFailures++;
  lastWsSendFailureAt = Date.now();
  return false;
}

// ── Server message handler ────────────────────────────────────────────────────

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'ROOM_CREATED':
      roomState = {
        roomCode: msg.roomCode,
        clientId: msg.clientId,
        username: msg.username,
        color: msg.color,
        isHost: msg.isHost,
        members: msg.members || [],
        state: msg.state || { playing: false, currentTime: 0 },
        videoUrl: roomState?.videoUrl || null,
        hostOnlyControl: msg.hostOnlyControl || false,
        countdownOnPlay: msg.countdownOnPlay || false
      };
      chrome.storage.local.set({ roomState });
      broadcastToTabs(msg);
      broadcastToPopup(msg);
      break;

    case 'ROOM_JOINED': {
      const isReconnect = pendingReconnectResync;
      pendingReconnectResync = false;
      roomState = {
        roomCode: msg.roomCode,
        clientId: msg.clientId,
        username: msg.username,
        color: msg.color,
        isHost: msg.isHost,
        members: msg.members || [],
        state: msg.state || { playing: false, currentTime: 0 },
        videoUrl: roomState?.videoUrl || null,
        hostOnlyControl: msg.hostOnlyControl || false,
        countdownOnPlay: msg.countdownOnPlay || false
      };
      chrome.storage.local.set({ roomState });
      broadcastToTabs({ ...msg, reconnectResync: isReconnect });
      broadcastToPopup(msg);
      break;
    }

    case 'MEMBER_JOINED':
    case 'MEMBER_LEFT':
      if (roomState) {
        roomState.members = msg.members || [];
        if (msg.hostOnlyControl !== undefined) roomState.hostOnlyControl = msg.hostOnlyControl;
        if (msg.countdownOnPlay !== undefined) roomState.countdownOnPlay = msg.countdownOnPlay;
        if (msg.type === 'MEMBER_LEFT' && msg.newHostId != null && roomState.clientId) {
          roomState.isHost = roomState.clientId === msg.newHostId;
        }
        chrome.storage.local.set({ roomState });
      }
      broadcastToTabs(msg);
      broadcastToPopup(msg);
      break;

    case 'PLAY':
    case 'PAUSE':
    case 'SEEK':
      if (roomState) roomState.state = { playing: msg.type === 'PLAY', currentTime: msg.currentTime || 0 };
      broadcastToTabs({ ...msg, lastRtt });
      break;

    case 'sync':
      if (roomState && typeof msg.currentTime === 'number') {
        roomState.state = {
          playing: msg.state === 'playing',
          currentTime: msg.currentTime
        };
      }
      broadcastToTabs({ ...msg, lastRtt });
      break;

    case 'SYNC_STATE':
      if (roomState && msg.state) roomState.state = msg.state;
      broadcastToTabs({ ...msg, lastRtt });
      break;

    case 'SYSTEM_MSG':
      broadcastToTabs(msg);
      break;

    case 'COUNTDOWN_START':
    case 'AD_BREAK_START':
    case 'AD_BREAK_END':
    case 'TYPING_START':
    case 'TYPING_STOP':
    case 'DIAG_SYNC_APPLY_RESULT':
    case 'DIAG_SYNC_REPORT':
    case 'DIAG_PROFILER_COLLECTION':
    case 'DIAG_PEER_RECORDING_SAMPLE':
    case 'DIAG_ROOM_TRACE':
    case 'POSITION_SNAPSHOT':
      broadcastToTabs(msg);
      break;

    case 'CHAT':
    case 'REACTION':
      broadcastToTabs(msg);
      break;

    case 'ERROR':
      if (pendingReconnectResync) pendingReconnectResync = false;
      broadcastToTabs(msg);
      broadcastToPopup(msg);
      break;

    case 'HEARTBEAT_ACK':
      if (lastHeartbeatSentAt > 0) {
        lastRtt = Date.now() - lastHeartbeatSentAt;
      }
      break;

    case 'SERVER_INFO':
      if (msg.serverUrl) {
        chrome.storage.local.set({ joinLinkServerUrl: msg.serverUrl });
      }
      break;

    default:
      broadcastToTabs(msg);
  }
}

// ── Tab communication ─────────────────────────────────────────────────────────

const _psCfg = globalThis.PLAYSHARE_STREAMING_CONFIG;
const CONTENT_SCRIPT_URLS = _psCfg.tabQueryPatterns;
const STREAMING_HOSTS = new Set(_psCfg.hostSubstrings);

function isStreamingTab(url) {
  if (!url || url.startsWith('chrome://')) return false;
  for (const h of STREAMING_HOSTS) { if (url.includes(h)) return true; }
  return false;
}

const PLAYBACK_MSG_TYPES = new Set(['PLAY', 'PAUSE', 'SEEK', 'SYNC_STATE', 'sync', 'COUNTDOWN_START']);

function broadcastToTabs(msg) {
  const isPlaybackMsg = PLAYBACK_MSG_TYPES.has(msg.type);
  if (isPlaybackMsg && roomState) {
    chrome.tabs.query({ active: true, currentWindow: true }, (activeTabs) => {
      const active = activeTabs[0];
      if (active?.id && isStreamingTab(active.url)) {
        chrome.tabs.sendMessage(active.id, { source: 'playshare-bg', ...msg }).catch(() => {
          chrome.tabs.query({ url: CONTENT_SCRIPT_URLS }, (tabs) => {
            for (const tab of tabs) {
              if (tab.id) chrome.tabs.sendMessage(tab.id, { source: 'playshare-bg', ...msg }).catch(() => {});
            }
          });
        });
        return;
      }
      chrome.tabs.query({ url: CONTENT_SCRIPT_URLS }, (tabs) => {
        for (const tab of tabs) {
          if (tab.id) chrome.tabs.sendMessage(tab.id, { source: 'playshare-bg', ...msg }).catch(() => {});
        }
      });
    });
  } else {
    chrome.tabs.query({ url: CONTENT_SCRIPT_URLS }, (tabs) => {
      for (const tab of tabs) {
        if (tab.id && tab.url && !tab.url.startsWith('chrome://')) {
          chrome.tabs.sendMessage(tab.id, { source: 'playshare-bg', ...msg }).catch(() => {});
        }
      }
    });
  }
}

function broadcastToPopup(msg) {
  try {
    chrome.runtime.sendMessage({ source: 'playshare-bg', ...msg }).catch(() => {});
  } catch {}
}

// ── Message listener (from popup / content scripts) ───────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.source !== 'playshare') return;

  switch (msg.type) {
    case 'CREATE_ROOM':
      needsAutoRejoin = false;
      pendingReconnectResync = false;
      connect(() => send({ type: 'CREATE_ROOM', username: msg.username, hostOnlyControl: msg.hostOnlyControl, countdownOnPlay: msg.countdownOnPlay }));
      sendResponse({ ok: true });
      break;

    case 'JOIN_ROOM':
      needsAutoRejoin = false;
      pendingReconnectResync = false;
      connect(() => send({ type: 'JOIN_ROOM', roomCode: msg.roomCode, username: msg.username }));
      sendResponse({ ok: true });
      break;

    case 'LEAVE_ROOM':
      send({ type: 'LEAVE_ROOM' });
      roomState = null;
      needsAutoRejoin = false;
      pendingReconnectResync = false;
      transportStallStartedAt = 0;
      clearTransportStallTimer();
      chrome.storage.local.remove('roomState');
      broadcastToTabs({ type: 'ROOM_LEFT' });
      broadcastToPopup({ type: 'ROOM_LEFT' });
      broadcastWsStatusToTabs();
      broadcastToPopup({ type: 'WS_STATUS', ...buildWsStatusPayload() });
      sendResponse({ ok: true });
      break;

    case 'PLAY':
    case 'PAUSE':
    case 'SEEK':
    case 'COUNTDOWN_START': {
      if (roomState && roomState.hostOnlyControl && !roomState.isHost) {
        sendResponse({ ok: false, error: 'NOT_HOST' });
        break;
      }
      send(msg);
      sendResponse({ ok: true });
      break;
    }

    case 'PLAYBACK_POSITION':
      if (roomState && !roomState.isHost) {
        sendResponse({ ok: false, error: 'NOT_HOST' });
        break;
      }
      send(msg);
      sendResponse({ ok: true });
      break;

    case 'AD_BREAK_START':
    case 'AD_BREAK_END':
      send(msg);
      sendResponse({ ok: true });
      break;

    case 'POSITION_REPORT':
    case 'TYPING_START':
    case 'TYPING_STOP':
    case 'DIAG_SYNC_APPLY_RESULT':
    case 'DIAG_SYNC_REPORT':
    case 'DIAG_PROFILER_COLLECTION':
    case 'DIAG_PEER_RECORDING_SAMPLE':
    case 'DIAG_ROOM_TRACE_REQUEST':
      send(msg);
      sendResponse({ ok: true });
      break;

    case 'CHAT':
    case 'REACTION':
      send(msg);
      sendResponse({ ok: true });
      break;

    case 'SYNC_REQUEST':
      send({ type: 'SYNC_REQUEST' });
      sendResponse({ ok: true });
      break;

    case 'UPDATE_COUNTDOWN_ON_PLAY':
      if (roomState) {
        roomState.countdownOnPlay = !!msg.value;
        chrome.storage.local.set({ roomState });
      }
      sendResponse({ ok: true });
      break;

    case 'GET_STATE':
      sendResponse({ roomState });
      break;

    case 'REQUEST_WS_RECONNECT':
      connect();
      sendResponse({ ok: true });
      break;

    case 'DIAG_UPLOAD_UNIFIED': {
      (async () => {
        try {
          const data = await chrome.storage.local.get(['serverUrl']);
          const raw = (data.serverUrl && String(data.serverUrl).trim()) || DEFAULT_SERVER_URL;
          const httpOrigin = playShareHttpOriginFromServerUrl(raw) || playShareHttpOriginFromServerUrl(DEFAULT_SERVER_URL);
          if (!httpOrigin) {
            sendResponse({ ok: false, status: 0, error: 'invalid_server_url' });
            return;
          }
          const uploadUrl = `${httpOrigin}/diag/upload`;
          const anon = await self.diagAnonymizePlayShareUnifiedExport(msg.payload, msg.hashSecrets || {});
          if (msg.enrichment && typeof msg.enrichment === 'object') {
            anon.enrichment = msg.enrichment;
          }
          const envelope = {
            schema: 'playshare.diagUploadEnvelope.v1',
            reportKind: 'unified_anonymized',
            extensionVersion: String(msg.extensionVersion || '').slice(0, 32),
            platformHandlerKey: String(msg.platformHandlerKey || '').slice(0, 48),
            diagnosticReportSchema: String(msg.diagnosticReportSchema || '').slice(0, 16),
            testRunId: msg.testRunId ? String(msg.testRunId).slice(0, 64) : null,
            payload: anon
          };
          const extraTok = await chrome.storage.local.get(['playshare_diag_upload_bearer']);
          const bearer =
            (extraTok.playshare_diag_upload_bearer && String(extraTok.playshare_diag_upload_bearer).trim()) || '';
          /** @type {Record<string, string>} */
          const headers = { 'Content-Type': 'application/json' };
          if (bearer) headers.Authorization = `Bearer ${bearer}`;
          const r = await fetch(uploadUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(envelope)
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            console.warn('[PlayShare] diag upload failed', r.status, uploadUrl, j && j.error ? j.error : '');
          }
          sendResponse({ ok: r.ok, status: r.status, uploadUrl, ...j });
        } catch (e) {
          sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
        }
      })();
      return true;
    }

    case 'GET_DIAG':
      chrome.storage.local.get(['serverUrl'], (data) => {
        let serverHost = null;
        try {
          const raw = data.serverUrl || DEFAULT_SERVER_URL;
          const normalized = /^wss?:\/\//i.test(raw) ? raw : `ws://${raw.replace(/^\/\//, '')}`;
          const u = new URL(normalized);
          serverHost = u.hostname + (u.port ? `:${u.port}` : '');
        } catch {
          serverHost = null;
        }
        const wsPayload = buildWsStatusPayload();
        sendResponse({
          ...wsPayload,
          connectionStatus: ws && ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
          roomState,
          lastRttMs: typeof lastRtt === 'number' && lastRtt > 0 ? lastRtt : null,
          transport: {
            wsOpenCount,
            wsCloseCount,
            lastWsOpenedAt,
            lastWsClosedAt,
            serverHost,
            wsSendFailures,
            lastWsSendFailureAt,
            /** OPEN=1 per spec; omit raw number if you prefer not to leak implementation detail */
            wsReadyState: ws ? ws.readyState : null
          }
        });
      });
      return true;

    case 'SET_ROOM_VIDEO_URL':
      if (roomState) {
        if (Object.prototype.hasOwnProperty.call(msg, 'videoUrl')) {
          const v = msg.videoUrl;
          roomState.videoUrl = v && String(v).trim() ? v : null;
        }
        chrome.storage.local.set({ roomState });
      }
      sendResponse({ ok: true });
      break;

    case 'GET_ROOM_LINK_DATA':
      chrome.storage.local.get(['joinLinkServerUrl', 'serverUrl'], (data) => {
        const serverUrl = data.joinLinkServerUrl || data.serverUrl || DEFAULT_SERVER_URL;
        const result = { roomCode: roomState?.roomCode, videoUrl: roomState?.videoUrl, serverUrl };
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tab = tabs[0];
          if (tab?.url && isStreamingTab(tab.url)) {
            result.videoUrl = result.videoUrl || tab.url;
          }
          sendResponse(result);
        });
      });
      return true;

    case 'TOGGLE_SIDEBAR_ACTIVE':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab?.id) {
          console.warn('[PlayShare] TOGGLE_SIDEBAR_ACTIVE: No active tab');
          sendResponse({ ok: false, error: 'NO_TAB' });
          return;
        }
        if (!tab.url || tab.url.startsWith('chrome://')) {
          console.warn('[PlayShare] TOGGLE_SIDEBAR_ACTIVE: Active tab is not a web page:', tab.url);
          sendResponse({ ok: false, error: 'NOT_WEB_PAGE' });
          return;
        }
        const isStreaming = isStreamingTab(tab.url);
        if (!isStreaming) {
          console.warn('[PlayShare] TOGGLE_SIDEBAR_ACTIVE: Active tab is not a streaming site. Open Netflix/YouTube etc first:', tab.url);
          sendResponse({ ok: false, error: 'NOT_STREAMING' });
          return;
        }
        chrome.tabs.sendMessage(tab.id, { source: 'playshare-bg', type: 'TOGGLE_SIDEBAR' })
          .then(() => {
            console.log('[PlayShare] TOGGLE_SIDEBAR sent to tab', tab.id);
            sendResponse({ ok: true });
          })
          .catch((err) => {
            console.warn('[PlayShare] TOGGLE_SIDEBAR failed:', err.message);
            sendResponse({ ok: false, error: 'SEND_FAILED' });
          });
      });
      return true;

    default:
      sendResponse({ ok: false });
  }
  return true; // keep channel open for async
});

// Restore state on service worker restart
chrome.storage.local.get('roomState', ({ roomState: saved }) => {
  if (saved) {
    roomState = saved;
    needsAutoRejoin = true;
    connect();
  }
});

// When a streaming tab finishes loading, send room state so content script shows sidebar
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab?.url || !roomState) return;
  if (!isStreamingTab(tab.url)) return;
  chrome.tabs.sendMessage(tabId, { source: 'playshare-bg', type: 'ROOM_JOINED', ...roomState }).catch(() => {});
});

/** Fallback when Netflix (etc.) auto ad-detect misses — user can rebind in chrome://extensions/shortcuts */
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'manual_ad_break_start' && command !== 'manual_ad_break_end') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id || !tab.url || tab.url.startsWith('chrome://')) return;
    if (!isStreamingTab(tab.url)) return;
    const type =
      command === 'manual_ad_break_start' ? 'COMMAND_MANUAL_AD_START' : 'COMMAND_MANUAL_AD_END';
    chrome.tabs.sendMessage(tab.id, { source: 'playshare-bg', type, viaShortcut: true }).catch(() => {});
  });
});
