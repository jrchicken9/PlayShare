/**
 * PlayShare — main content script body (bundled).
 */
import { contentConstants as PS_C } from "./constants.js";
import {
  isVideoPage,
  runUrlJoinFromQuery,
  collectPageVideoElements,
  scoreVideoElement,
  attachVideoDomObserver
} from "./video-page.js";
import { formatTime } from "./format-time.js";
import {
  buildDiagnosticExport,
  computeCorrelationTraceDelivery,
  pushDiagTimeline,
  updateDriftEwm
} from "./diagnostics/helpers.js";
import { createVideoPlayerProfiler } from "./diagnostics/video-player-profiler.js";
import { getPlaybackProfile, getApplyDelayMs } from "./platform-profiles.js";
import { getSiteSyncAdapter } from "./sites/site-sync-adapter.js";
import {
  capturePrimeMissedAdDebugPayload,
  capturePrimePlayerSyncDebugPayload,
  getPrimeAdDetectionSnapshot,
  isPrimeMainPlayerShell,
  isPrimeVideoHostname,
  PRIME_AD_BREAK_MONITOR_OPTIONS,
  PRIME_SYNC_DEBUG_STORAGE_KEY,
  tryCapturePrimeVideoFramePng
} from "./sites/prime-video-sync.js";
import { createDrmSyncPromptHost } from "./drm-sync-prompt.js";
import { createAdBreakMonitor } from "./ad-detection.js";
import { wsUrlToHttpBase } from "./join-link-helpers.js";

export function runPlayShareContent() {
  "use strict";

  if (window.__playshareLoaded) return;
  window.__playshareLoaded = true;

  if (!isVideoPage()) return;

  const isPrimeOrAmazon = /primevideo\.com|amazon\.(com|ca)/.test(location.hostname);
  if (!isPrimeOrAmazon && window !== window.top) return;

  runUrlJoinFromQuery();


  const hostname = location.hostname;
  const {
    SYNC_THRESHOLD,
    VIEWER_SYNC_INTERVAL_MS,
    SYNC_DRIFT_HARD_SEC,
    SYNC_DRIFT_SOFT_MIN_SEC,
    SOFT_SYNC_RATE_AHEAD,
    SOFT_SYNC_RATE_BEHIND,
    SOFT_SYNC_RESET_MS,
    POSITION_REPORT_INTERVAL_MS,
    CLUSTER_SYNC_SPREAD_SEC,
    COUNTDOWN_SECONDS,
    DIAG_DEBOUNCE_MS,
    DIAG_PEER_DEV_SHARE_MS,
    TIME_JUMP_THRESHOLD,
    PLAYBACK_ECHO_SUPPRESS_MS,
    SIDEBAR_WIDTH
  } = PS_C;
  const DIAG_EVENTS = new Set(PS_C.DIAG_EVENT_NAMES);
  /** Sync diagnostics overlay + floater; `false` in packaged builds via esbuild --define. */
  const diagnosticsUiEnabled = PLAYSHARE_CONTENT_DIAGNOSTICS;
  const platform = PS_C.detectPlatform(hostname);
  const playbackProfile = getPlaybackProfile(hostname, location.pathname);
  const siteSync = getSiteSyncAdapter(hostname, location.pathname);

  /**
   * Browsers only paint DOM inside `document.fullscreenElement` while fullscreen. Used for mounting
   * chat, toasts, and prompts. Raw `<video>` fullscreen cannot host HTML overlays (falls back to body).
   */
  function getFullscreenUiHost() {
    try {
      const fs =
        document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
      if (fs && fs instanceof HTMLElement && fs.tagName !== 'VIDEO') return fs;
    } catch {
      /* ignore */
    }
    return document.body;
  }

  const drmSyncPrompt = createDrmSyncPromptHost({ getMountParent: getFullscreenUiHost });

  // ── State ──────────────────────────────────────────────────────────────────
  let roomState = null;
  let video = null;
  let syncLock = false;       // prevent echo loops
  /** Wall time until which play/pause/seeked handlers ignore synthetic events from remote apply (see PLAYBACK_ECHO_SUPPRESS_MS). */
  let suppressPlaybackEchoUntil = 0;
  let lastSentTime = -1;
  /**
   * Last PLAY/PAUSE/SEEK we sent or applied remotely. Used so `onVideoPlay` time-dedupe does not
   * drop real resumes after SYNC_STATE (which updates lastSentTime to currentTime while paused).
   */
  let lastPlaybackOutboundKind = /** @type {'PLAY'|'PAUSE'|'SEEK'|null} */ (null);
  let lastAppliedState = { currentTime: 0, playing: false }; // for reverting non-host actions
  let sidebarVisible = false;
  let sidebarFrame = null;
  let sidebarToggleBtn = null;
  /** False until sidebar iframe posts READY — avoids dropping postMessage before the listener exists. */
  let sidebarIframeReady = false;
  /** @type {object[]} */
  const sidebarPendingPost = [];
  const SIDEBAR_POST_QUEUE_MAX = 120;
  const sidebarCompact = true;
  const sidebarPosition = 'right';

  let countdownInProgress = false;
  /** When set, reparented with other extension UI on fullscreen changes. */
  let countdownOverlayEl = null;

  let hostPositionInterval = null;
  let viewerSyncInterval = null;
  let viewerReconcileInterval = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let softPlaybackRateResetTimer = null;
  let videoDomDisconnect = null;
  /**
   * Host timeline anchor for viewers (position at `sentAt`, extrapolate while playing).
   * @type {{ currentTime: number, playing: boolean, sentAt: number } | null}
   */
  let hostAuthoritativeRef = null;
  /** @type {ReturnType<typeof createAdBreakMonitor>|null} */
  let adBreakMonitor = null;
  /** Peers currently in an ad (clientId → username). */
  const peersInAdBreak = new Map();
  /** We reported AD_BREAK_START and have not yet sent END. */
  let localAdBreakActive = false;
  let positionReportInterval = null;
  /** Dev: periodic DIAG_PEER_RECORDING_SAMPLE while a remote peer is recording profiler. */
  let peerRecordingSampleTimer = null;
  let clusterSyncBadge = null;
  let lastClusterSidebarKey = null;
  /** Host-only: wall-clock until which we skip synthetic SEEK from `timeupdate` jumps (see onVideoPlay). */
  let hostTimeupdateSeekSuppressUntil = 0;
  /** Prior tab WS open flag from background (for disconnect event counting). */
  let prevBgWsOpen = /** @type {boolean|undefined} */ (undefined);

  let lastSyncAt = 0;
  let lastTimeUpdatePos = -1;  // for detecting internal seeks (buffering/adaptive bitrate)
  let lastTimeUpdateCheckAt = 0;  // throttle jump detection
  let pendingSyncState = null;  // apply when video attaches (joiner's video not ready yet)
  /** @type {ReturnType<typeof setTimeout>|null} */
  let playbackOutboundCoalesceTimer = null;
  let lastLocalPlaybackWireAt = 0;
  /**
   * Last playing state we successfully wired to the room from this tab (PLAY/PAUSE send), or after
   * remote/sync apply. Used with Prime coalesce: polarity changes flush immediately; duplicate
   * play/pause events (same state) are skipped so rapid toggles are not collapsed into one wire.
   * @type {boolean|null}
   */
  let lastLocalWirePlayingSent = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let remotePlaybackDebounceTimer = null;
  /** @type {null | (() => void)} */
  let queuedRemotePlaybackApply = null;

  function syncPendingSyncStateDiagFlag() {
    diag.pendingSyncStateQueued = !!pendingSyncState;
  }

  function armPlaybackEchoSuppress(extraMs = 0) {
    const until = Date.now() + PLAYBACK_ECHO_SUPPRESS_MS + extraMs;
    suppressPlaybackEchoUntil = Math.max(suppressPlaybackEchoUntil, until);
  }

  function isPlaybackEchoSuppressed() {
    return Date.now() < suppressPlaybackEchoUntil;
  }

  /**
   * Skip wiring local play/pause to the room when the event is likely echo from our own apply.
   * Still allow the opposite direction during the window (user toggles quickly after an echoed PLAY/PAUSE).
   * @param {boolean} isPlayEvent
   */
  function shouldSuppressPlaybackOutboundEcho(isPlayEvent) {
    if (!isPlaybackEchoSuppressed()) return false;
    const v = findVideo() || video;
    if (!v) return true;
    if (isPlayEvent) {
      if (!v.paused && !lastAppliedState.playing) return false;
      return true;
    }
    if (v.paused && lastAppliedState.playing) return false;
    return true;
  }

  // ── Diagnostic state ───────────────────────────────────────────────────────
  const diag = {
    connectionStatus: 'unknown',
    connectionMessage: '',
    transportPhase: '',
    lastEvent: null,
    recentMessages: [],
    errors: [],
    videoAttached: false,
    maxMessages: 8,
    maxErrors: 5,
    tabHidden: typeof document !== 'undefined' && document.hidden,
    diagOverlayStale: false,
    panelMinimized: false,
    overlayWide: false,
    theme: 'dark',
    timing: {
      lastRttMs: null,
      /** @type {'playback'|'background_heartbeat'|null} */
      lastRttSource: null,
      driftEwmSec: 0,
      timeline: []
    },
    /** When server room trace was last received (client ms). */
    serverRoomTraceAt: null,
    findVideo: { cacheReturns: 0, fullScans: 0, invalidations: 0, videoAttachCount: 0 },
    videoHealthLast: null,
    timeupdateJumps: [],
    serverRoomTrace: [],
    _lastTuDiagAt: 0,
    _lastTuDiagPos: -1,
    /** For analytics export: when current room session started (client clock). */
    reportSession: { startedAt: null, roomCode: null },
    sidebar: {
      toggleReceived: 0,
      lastToggleAt: null,
      frameExists: false,
      toggleBtnExists: false,
      toggleBtnVisible: false
    },
    sync: {
      events: [],
      maxEvents: 80,
      eventFilter: '',
      metrics: { playSent: 0, playRecv: 0, playOk: 0, playFail: 0, pauseSent: 0, pauseRecv: 0, pauseOk: 0, pauseFail: 0, seekSent: 0, seekRecv: 0, seekOk: 0, seekFail: 0 },
      lastRecvAt: 0,
      testRunning: false,
      testResults: null,
      remoteApplyResults: [],
      maxRemoteResults: 30,
      peerReports: {},
      lastReportSentAt: 0,
      /** Recent automated sync test runs (for accurate “how was this captured?”). */
      testHistory: [],
      maxTestHistory: 8,
      /** Member join/leave + room attach, oldest trimmed (session narrative). */
      memberTimeline: [],
      maxMemberTimeline: 30
    },
    /** True when joiner is holding SYNC_STATE until <video> attaches. */
    pendingSyncStateQueued: false,
    /**
     * Content-script bridge counters (this tab only): sync state handling, host/viewer keepalive sends, chat, etc.
     */
    extensionOps: {
      syncStateInbound: 0,
      syncStateApplied: 0,
      syncStateDeferredNoVideo: 0,
      syncStateDeferredStaleOrMissing: 0,
      syncStateDeniedSyncLock: 0,
      syncStateDeniedPlaybackDebounce: 0,
      remoteApplyDeniedSyncLock: 0,
      remoteApplyDeniedPlaybackDebounce: 0,
      remoteApplyDeferredTabHidden: 0,
      localControlBlockedHostOnly: 0,
      syncStateFlushedOnVideoAttach: 0,
      hostPlaybackPositionSent: 0,
      viewerSyncRequestSent: 0,
      countdownStartRemote: 0,
      serverErrors: 0,
      wsDisconnectEvents: 0,
      chatReceived: 0,
      systemMsgsReceived: 0,
      playbackSystemMsgsDeduped: 0,
      positionReportSent: 0,
      positionSnapshotInbound: 0,
      drmSyncPromptsShown: 0,
      drmSyncConfirmed: 0,
      drmSeekSkippedUnderThreshold: 0,
      syncStateHeldForAd: 0,
      remotePlayHeldForAd: 0,
      remoteSeekHeldForAd: 0,
      /** Inbound PLAY/PAUSE/SEEK/SYNC_STATE ignored while our detector says we’re in a local ad. */
      remoteApplyIgnoredLocalAd: 0,
      syncStateIgnoredLocalAd: 0,
      /** Outbound play/pause/seek not sent during local ad (avoids pausing a peer who is also in an ad). */
      playbackOutboundSuppressedLocalAd: 0
    },
    /** Latest GET_DIAG.transport from the service worker (WebSocket lifecycle). */
    serviceWorkerTransport: null,
    /** chrome.runtime.sendMessage failures (tab → service worker). */
    messaging: {
      runtimeSendFailures: 0,
      runtimeLastErrorAt: null,
      runtimeLastErrorMessage: null,
      sendThrowCount: 0
    },
    /**
     * `<video>` rebuffering signals (CDN / adaptive vs sync). Counts persist until reset.
     */
    videoBuffering: {
      waiting: 0,
      stalled: 0,
      lastWaitingAt: null,
      lastStalledAt: null
    },
    /**
     * Room-wide playhead spread from POSITION_SNAPSHOT (null until first snapshot).
     * @type {null | { spreadSec: number|null, synced: boolean|null, playingMismatch: boolean, freshMemberCount: number, staleCount: number, roomMemberCount: number, label: string, wallMs: number }}
     */
    clusterSync: null,
    /** Dev: last “missed ad” capture from diagnostics CTA. */
    lastPrimeMissedAdCapture: /** @type {null | { at: number, clipboardOk: boolean }} */ (null),
    /**
     * Dev: while another tab records profiler, their clientId — we send DIAG_PEER_RECORDING_SAMPLE there.
     * @type {{ remoteCollectorClientId: string|null }}
     */
    profilerPeerCollection: { remoteCollectorClientId: null },
    /**
     * Dev: this tab recording profiler — samples from peers (by sender clientId).
     * @type {{ byClient: Record<string, { receivedAt: number, fromUsername: string, payload: Record<string, unknown> }[]> }}
     */
    peerRecordingSamples: { byClient: {} },
    /**
     * Prime-only live telemetry (adapter, ad heuristics, findVideo selector, reconcile drift).
     * @type {null | { adDetectorActive: boolean, adScore: number, adStrong: boolean, adReasons: string[], adChannels: { adCountdownUi: boolean, adTimerUi: boolean, playerAdControls: boolean, mediaSession: boolean }, inSdkShell: boolean, viewerDriftSec: number|null, selectorThatMatched: string|null, lastPollAt: number, extensionLocalAd: boolean, peersInAd: number }}
     */
    primeSync: siteSync.key === 'prime'
      ? {
          adDetectorActive: false,
          adScore: 0,
          adStrong: false,
          adReasons: /** @type {string[]} */ ([]),
          adChannels: { adCountdownUi: false, adTimerUi: false, playerAdControls: false, mediaSession: false },
          inSdkShell: false,
          viewerDriftSec: /** @type {number|null} */ (null),
          selectorThatMatched: /** @type {string|null} */ (null),
          lastPollAt: 0,
          extensionLocalAd: false,
          peersInAd: 0
        }
      : null,
    /** Sync console layout: icon strip vs full dashboard. */
    consoleView: /** @type {'compact' | 'detailed'} */ ('detailed'),
    /** Which blocks appear in detailed dashboard (moderator layout). */
    dashBlocks: {
      overview: true,
      alerts: true,
      prime: true,
      actions: true,
      multiplayer: true,
      server: true,
      technical: true,
      logs: true
    }
  };

  const DIAG_LS_CONSOLE_VIEW = 'playshare_diag_console_view';
  const DIAG_LS_DASH_BLOCKS = 'playshare_diag_dash_blocks';

  function hydrateDiagConsolePrefs() {
    try {
      const v = localStorage.getItem(DIAG_LS_CONSOLE_VIEW);
      if (v === 'compact' || v === 'detailed') diag.consoleView = v;
      const raw = localStorage.getItem(DIAG_LS_DASH_BLOCKS);
      if (raw) {
        const o = JSON.parse(raw);
        for (const k of Object.keys(diag.dashBlocks)) {
          if (typeof o[k] === 'boolean') diag.dashBlocks[k] = o[k];
        }
      }
    } catch {
      /* ignore */
    }
  }

  function persistDiagConsolePrefs() {
    try {
      localStorage.setItem(DIAG_LS_CONSOLE_VIEW, diag.consoleView);
      localStorage.setItem(DIAG_LS_DASH_BLOCKS, JSON.stringify(diag.dashBlocks));
    } catch {
      /* ignore */
    }
  }

  hydrateDiagConsolePrefs();

  /** Floating HUD on Prime pages when enabled in extension popup (`primeSyncDebugHud`). */
  let primeSyncDebugHud = false;
  /** @type {ReturnType<typeof setInterval>|null} */
  let primeTelemetryTimer = null;
  /** @type {HTMLDivElement|null} */
  let primeHudEl = null;

  /** Prefer attached `video` to avoid redundant findVideo() DOM work during telemetry ticks. */
  function videoElForPrimeTelemetry() {
    try {
      if (video && video.isConnected && video.tagName === 'VIDEO' && !isVideoStale(video)) return video;
    } catch {
      /* ignore */
    }
    return findVideo() || video;
  }

  function refreshPrimeSyncTelemetry() {
    if (!diag.primeSync) return;
    const v = videoElForPrimeTelemetry();
    try {
      const snap = getPrimeAdDetectionSnapshot(v);
      diag.primeSync.adDetectorActive = snap.likelyAd;
      diag.primeSync.adScore = snap.score;
      diag.primeSync.adStrong = snap.hasStrong;
      diag.primeSync.adReasons = snap.reasons.slice(0, 8);
      diag.primeSync.adChannels = { ...snap.channels };
      diag.primeSync.inSdkShell = isPrimeMainPlayerShell(v);
      diag.primeSync.extensionLocalAd = localAdBreakActive;
      diag.primeSync.peersInAd = peersInAdBreak.size;
      diag.primeSync.lastPollAt = Date.now();
    } catch {
      /* ignore */
    }
  }

  function ensurePrimeHudElement() {
    if (primeHudEl || siteSync.key !== 'prime' || !document.body) return;
    primeHudEl = document.createElement('div');
    primeHudEl.id = 'playshare-prime-sync-hud';
    primeHudEl.setAttribute('aria-live', 'polite');
    primeHudEl.style.cssText =
      'position:fixed;bottom:12px;right:12px;z-index:2147483646;max-width:min(340px,calc(100vw - 24px));' +
      'font:12px/1.4 system-ui,-apple-system,sans-serif;color:#e8f4fc;background:rgba(6,40,52,.92);' +
      'border:1px solid rgba(0,168,225,.45);border-radius:10px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.4);pointer-events:none;';
    try {
      document.body.appendChild(primeHudEl);
      reparentPlayShareUiForFullscreen();
    } catch {
      primeHudEl = null;
    }
  }

  function updatePrimeHudContent() {
    if (!primeHudEl || !diag.primeSync) return;
    const p = diag.primeSync;
    const drift = p.viewerDriftSec;
    let driftLine = '—';
    if (roomState?.isHost) driftLine = '— (you are host)';
    else if (typeof drift === 'number' && !Number.isNaN(drift)) {
      driftLine = `${drift >= 0 ? '+' : ''}${drift.toFixed(2)}s vs extrapolated host`;
    } else if (roomState && !roomState.isHost) driftLine = '— (waiting for host position)';
    const role = roomState?.isHost ? 'Host' : roomState ? 'Viewer' : 'No room';
    const sel = p.selectorThatMatched ? String(p.selectorThatMatched).replace(/</g, '') : '—';
    primeHudEl.innerHTML =
      '<div style="font-weight:600;margin-bottom:6px;color:#00A8E1">PlayShare · Prime sync</div>' +
      `<div>Role: ${role}</div>` +
      `<div>Video in main SDK shell: <strong>${p.inSdkShell ? 'yes' : 'no'}</strong></div>` +
      `<div>Ad (authoritative cues): <strong>${p.adDetectorActive ? 'yes' : 'no'}</strong> · channels×${p.adScore} · room pause: ${p.extensionLocalAd ? 'yes' : 'no'} · peers in ad: ${p.peersInAd}</div>` +
      `<div style="opacity:.88;font-size:11px;word-break:break-word">${p.adReasons && p.adReasons.length ? p.adReasons.join(', ') : '—'}</div>` +
      `<div>findVideo selector: <span style="word-break:break-all;opacity:.9">${sel}</span></div>` +
      `<div>Reconcile: <strong>${driftLine}</strong></div>` +
      '<div style="opacity:.85;margin-top:6px;font-size:11px">Popup: toggle “Prime sync HUD” off · <code>__playsharePrime.getStatus()</code></div>';
  }

  function updatePrimeHudVisibility() {
    if (siteSync.key !== 'prime') return;
    if (primeSyncDebugHud) {
      ensurePrimeHudElement();
      if (!primeHudEl) return;
      refreshPrimeSyncTelemetry();
      updatePrimeHudContent();
      primeHudEl.style.display = 'block';
    } else if (primeHudEl) {
      primeHudEl.style.display = 'none';
    }
    syncPrimeTelemetryPolling();
  }

  const PRIME_TELEMETRY_MS = 800;

  function stopPrimeTelemetryPolling() {
    if (primeTelemetryTimer) {
      clearInterval(primeTelemetryTimer);
      primeTelemetryTimer = null;
    }
  }

  /** Runs only while Prime HUD or dev diagnostics is open — avoids a perpetual background timer. */
  function syncPrimeTelemetryPolling() {
    if (siteSync.key !== 'prime') return;
    if (!primeSyncDebugHud && !diagVisible) {
      stopPrimeTelemetryPolling();
      return;
    }
    if (primeTelemetryTimer) return;
    primeTelemetryTimer = setInterval(() => {
      if (siteSync.key !== 'prime' || (!primeSyncDebugHud && !diagVisible)) {
        stopPrimeTelemetryPolling();
        return;
      }
      refreshPrimeSyncTelemetry();
      if (primeSyncDebugHud && primeHudEl && primeHudEl.style.display !== 'none') {
        updatePrimeHudContent();
      }
      if (diagVisible) scheduleDiagUpdate();
    }, PRIME_TELEMETRY_MS);
  }

  let diagDebounceTimer = null;
  function scheduleDiagUpdate() {
    if (!diagVisible || diagDebounceTimer) return;
    diagDebounceTimer = setTimeout(() => {
      diagDebounceTimer = null;
      if (diagVisible) updateDiagnosticOverlay();
    }, DIAG_DEBOUNCE_MS);
  }

  function diagLog(event, detail) {
    const entry = { t: Date.now(), event, detail };
    diag.lastEvent = entry;
    if (event === 'ERROR') {
      diag.errors.unshift(entry);
      diag.errors.length = Math.min(diag.errors.length, diag.maxErrors);
    } else if (DIAG_EVENTS.has(event)) {
      diag.recentMessages.unshift(entry);
      diag.recentMessages.length = Math.min(diag.recentMessages.length, diag.maxMessages);
    }
    scheduleDiagUpdate();
  }

  /** Platform-scoped logging for sync / DRM diagnostics. */
  function platformPlaybackLog(event, detail) {
    diagLog(event, { ...(detail || {}), handler: playbackProfile.handlerKey, drmPassive: playbackProfile.drmPassive });
  }

  function syncDiagRecord(opts) {
    const s = diag.sync;
    const entry = { t: Date.now(), ...opts };
    s.events.unshift(entry);
    s.events.length = Math.min(s.events.length, s.maxEvents);
    if (opts.type === 'play_sent') s.metrics.playSent++;
    if (opts.type === 'play_recv') { s.metrics.playRecv++; s.lastRecvAt = Date.now(); }
    if (opts.type === 'play_ok') s.metrics.playOk++;
    if (opts.type === 'play_fail') s.metrics.playFail++;
    if (opts.type === 'pause_sent') s.metrics.pauseSent++;
    if (opts.type === 'pause_recv') { s.metrics.pauseRecv++; s.lastRecvAt = Date.now(); }
    if (opts.type === 'pause_ok') s.metrics.pauseOk++;
    if (opts.type === 'pause_fail') s.metrics.pauseFail++;
    if (opts.type === 'seek_sent') s.metrics.seekSent++;
    if (opts.type === 'seek_recv') { s.metrics.seekRecv++; s.lastRecvAt = Date.now(); }
    if (opts.type === 'seek_ok') s.metrics.seekOk++;
    if (opts.type === 'seek_fail') s.metrics.seekFail++;
    scheduleDiagUpdate();
  }

  function sendDiagApplyResult(targetClientId, eventType, success, latency, correlationId) {
    if (!roomState?.clientId || !targetClientId) return;
    sendBg({
      source: 'playshare',
      type: 'DIAG_SYNC_APPLY_RESULT',
      targetClientId,
      fromClientId: roomState.clientId,
      fromUsername: roomState.username,
      eventType,
      success,
      latency,
      correlationId: correlationId || undefined,
      platform: platform.key,
      platformName: platform.name
    });
  }

  function sendDiagReport() {
    if (!roomState) return;
    const s = diag.sync;
    s.lastReportSentAt = Date.now();
    /** @type {Record<string, unknown>} */
    const payload = {
      source: 'playshare',
      type: 'DIAG_SYNC_REPORT',
      clientId: roomState.clientId,
      username: roomState.username,
      isHost: roomState.isHost,
      platform: platform.key,
      platformName: platform.name,
      metrics: { ...s.metrics },
      videoAttached: diag.videoAttached
    };
    if (diagnosticsUiEnabled) {
      try {
        payload.devDiag = buildPeerDevDiagSnapshot();
      } catch {
        payload.devDiag = { schema: 'playshare.peerDevDiag.v1', captureError: true };
      }
    }
    sendBg(payload);
  }

  function broadcastProfilerCollectionState(active) {
    if (!diagnosticsUiEnabled || !roomState?.clientId) return;
    sendBg({
      source: 'playshare',
      type: 'DIAG_PROFILER_COLLECTION',
      active: !!active,
      collectorClientId: roomState.clientId
    });
  }

  function stopPeerRecordingSampleLoop() {
    if (peerRecordingSampleTimer != null) {
      clearInterval(peerRecordingSampleTimer);
      peerRecordingSampleTimer = null;
    }
  }

  function sendPeerRecordingSampleOnce() {
    if (!diagnosticsUiEnabled || !roomState) return;
    const target = diag.profilerPeerCollection.remoteCollectorClientId;
    if (!target || target === roomState.clientId) return;
    try {
      sendBg({
        source: 'playshare',
        type: 'DIAG_PEER_RECORDING_SAMPLE',
        collectorClientId: target,
        payload: {
          devDiag: buildPeerDevDiagSnapshot(),
          syncMetrics: { ...diag.sync.metrics },
          videoAttached: diag.videoAttached,
          platform: platform.key,
          platformName: platform.name
        }
      });
    } catch {
      /* ignore */
    }
  }

  function startPeerRecordingSampleLoop() {
    stopPeerRecordingSampleLoop();
    if (!diagnosticsUiEnabled || !roomState) return;
    const target = diag.profilerPeerCollection.remoteCollectorClientId;
    if (!target || target === roomState.clientId) return;
    peerRecordingSampleTimer = setInterval(() => {
      sendPeerRecordingSampleOnce();
    }, DIAG_PEER_DEV_SHARE_MS);
    sendPeerRecordingSampleOnce();
  }

  /**
   * Collector tab: ingest compact diagnostics from dev peers during profiler recording.
   * @param {Record<string, unknown>} msg
   */
  function ingestPeerRecordingSample(msg) {
    if (!roomState || msg.collectorClientId !== roomState.clientId) return;
    const from = /** @type {string|undefined} */ (msg.fromClientId);
    if (!from || from === roomState.clientId) return;
    const row = {
      receivedAt: Date.now(),
      fromUsername: typeof msg.fromUsername === 'string' ? msg.fromUsername : '',
      payload:
        msg.payload && typeof msg.payload === 'object'
          ? /** @type {Record<string, unknown>} */ (msg.payload)
          : {}
    };
    const by = diag.peerRecordingSamples.byClient;
    if (!by[from]) by[from] = [];
    by[from].push(row);
    const cap = 36;
    while (by[from].length > cap) by[from].shift();
    scheduleDiagUpdate();
  }

  // ── Video element finder (with cache to reduce DOM queries) ───────────────────
  let cachedVideoEl = null;
  let cachedVideoDoc = null;

  function invalidateVideoCache() {
    cachedVideoEl = null;
    cachedVideoDoc = null;
    diag.findVideo.invalidations++;
  }

  function findVideo() {
    const isReady = (v) => v && v.tagName === 'VIDEO' && !isNaN(v.duration) && (v.duration > 0 || v.readyState >= 1);
    const isReadyRelaxed = (v) => v && v.tagName === 'VIDEO' && (v.readyState >= 2 || (v.duration > 0 && !isNaN(v.duration)));
    const doc = document;
    if (cachedVideoEl && cachedVideoDoc === doc) {
      try {
        if (cachedVideoEl.isConnected && (cachedVideoEl.readyState >= 1 || (cachedVideoEl.duration > 0 && !isNaN(cachedVideoEl.duration)))) {
          if (siteSync.shouldRefreshVideoCache?.(cachedVideoEl)) {
            invalidateVideoCache();
          } else {
            diag.findVideo.cacheReturns++;
            return cachedVideoEl;
          }
        }
      } catch {}
      invalidateVideoCache();
    }
    diag.findVideo.fullScans++;
    if (diag.primeSync) diag.primeSync.selectorThatMatched = null;
    function findInRoot(root, maxDepth = 3) {
      const v = root.querySelector?.('video');
      if (isReady(v)) return v;
      if (maxDepth <= 0) return null;
      const elements = root.querySelectorAll?.('*') || [];
      for (const el of elements) {
        if (el.shadowRoot) {
          const found = findInRoot(el.shadowRoot, maxDepth - 1);
          if (found) return found;
        }
      }
      return null;
    }
    const candidates = collectPageVideoElements(doc);
    candidates.sort((a, b) => {
      let sa = scoreVideoElement(a);
      let sb = scoreVideoElement(b);
      if (siteSync.adjustVideoCandidateScore) {
        sa = siteSync.adjustVideoCandidateScore(a, sa);
        sb = siteSync.adjustVideoCandidateScore(b, sb);
      }
      return sb - sa;
    });
    for (const el of candidates) {
      if (isReady(el)) {
        cachedVideoEl = el;
        cachedVideoDoc = doc;
        return el;
      }
    }
    if (playbackProfile.useRelaxedVideoReady) {
      for (const el of candidates) {
        if (isReadyRelaxed(el)) {
          cachedVideoEl = el;
          cachedVideoDoc = doc;
          return el;
        }
      }
    }
    const genericVideoSelectors = [
      'video',
      '.dv-player-main video',
      '.nf-player-container video',
      '.VideoPlayer video',
      '#dv-web-player video',
      '.webPlayerSDKContainer video',
      '.btm-media-client-element video',
      '#movie_player video',
      '.html5-main-video',
      'ytd-player video'
    ];
    const prioritySel = siteSync.getPriorityVideoSelectors?.() ?? [];
    const selectors = [...new Set([...prioritySel, ...genericVideoSelectors])];
    function pickBestVideoForSelector(sel, readyFn) {
      try {
        const list = document.querySelectorAll(sel);
        /** @type {HTMLVideoElement|null} */
        let best = null;
        let bestScore = -Infinity;
        for (const node of list) {
          if (!(node instanceof HTMLVideoElement)) continue;
          if (!readyFn(node)) continue;
          let s = scoreVideoElement(node);
          if (siteSync.adjustVideoCandidateScore) s = siteSync.adjustVideoCandidateScore(node, s);
          if (s > bestScore) {
            bestScore = s;
            best = node;
          }
        }
        return best;
      } catch {
        return null;
      }
    }
    for (const sel of selectors) {
      const el = pickBestVideoForSelector(sel, isReady);
      if (el) {
        if (diag.primeSync) diag.primeSync.selectorThatMatched = sel;
        cachedVideoEl = el;
        cachedVideoDoc = doc;
        return el;
      }
    }
    if (playbackProfile.useRelaxedVideoReady) {
      for (const sel of selectors) {
        const el = pickBestVideoForSelector(sel, isReadyRelaxed);
        if (el) {
          if (diag.primeSync) diag.primeSync.selectorThatMatched = sel;
          cachedVideoEl = el;
          cachedVideoDoc = doc;
          return el;
        }
      }
    }
    const shadowFound = findInRoot(document);
    if (shadowFound) {
      cachedVideoEl = shadowFound;
      cachedVideoDoc = doc;
      return shadowFound;
    }
    const all = document.querySelectorAll('video');
    for (const v of all) {
      if (isReady(v)) {
        cachedVideoEl = v;
        cachedVideoDoc = doc;
        return v;
      }
    }
    if (playbackProfile.useRelaxedVideoReady) {
      for (const v of all) {
        if (isReadyRelaxed(v)) {
          cachedVideoEl = v;
          cachedVideoDoc = doc;
          return v;
        }
      }
    }
    return null;
  }

  function attachVideo(v) {
    if (video === v) return;
    detachVideo();
    video = v;
    lastTimeUpdatePos = -1;
    // Use capture: false — never preventDefault/stopPropagation so platform player works normally
    video.addEventListener('play', onVideoPlay);
    video.addEventListener('pause', onVideoPause);
    video.addEventListener('seeked', onVideoSeeked);
    video.addEventListener('timeupdate', onVideoTimeUpdate);
    video.addEventListener('waiting', onVideoWaiting);
    video.addEventListener('stalled', onVideoStalled);
    diag.videoAttached = true;
    diag.findVideo.videoAttachCount++;
    if (roomState?.isHost) {
      sendBg({ source: 'playshare', type: 'SET_ROOM_VIDEO_URL', videoUrl: location.href });
      roomState.videoUrl = location.href;
      postSidebarRoomState();
    }
    // Apply pending sync when viewer joins before video was ready
    if (pendingSyncState && !roomState?.isHost) {
      diag.extensionOps.syncStateFlushedOnVideoAttach++;
      applySyncState(pendingSyncState);
      pendingSyncState = null;
      syncPendingSyncStateDiagFlag();
    }
    platformPlaybackLog('VIDEO_ATTACHED', {
      src: (v.src || v.currentSrc || '').slice(0, 60),
      readyState: v.readyState,
      paused: v.paused
    });
    if (roomState) startPositionReportInterval();
    if (roomState && !roomState.isHost) startViewerReconcileLoop();
    if (roomState) startAdBreakMonitorIfNeeded();
    try {
      getVideoProfiler().notifyVideoMayHaveChanged();
    } catch {
      /* ignore */
    }
  }

  /**
   * Per-snapshot sync + site context for video profiler exports (v3).
   * @param {Record<string, unknown>} snap
   * @param {HTMLVideoElement|null} v
   */
  function enrichVideoProfilerSnapshot(snap, v) {
    try {
      snap.playShare = {
        siteAdapterKey: siteSync.key,
        videoIsExtensionTarget: !!(v && video && v === video),
        driftEwmSec: diag.timing?.driftEwmSec ?? null,
        lastRttMs: diag.timing?.lastRttMs ?? null,
        lastRttSource: diag.timing?.lastRttSource ?? null,
        syncLock: !!syncLock,
        suppressPlaybackEchoUntil: suppressPlaybackEchoUntil > Date.now() ? suppressPlaybackEchoUntil : null,
        lastAppliedPlaying: !!lastAppliedState?.playing,
        lastAppliedTime:
          typeof lastAppliedState?.currentTime === 'number'
            ? +lastAppliedState.currentTime.toFixed(3)
            : null,
        lastSentTime: typeof lastSentTime === 'number' && lastSentTime >= 0 ? +lastSentTime.toFixed(3) : null,
        lastPlaybackOutboundKind: lastPlaybackOutboundKind,
        lastLocalWirePlayingSent,
        lastSyncAt: lastSyncAt || null,
        connectionStatus: diag.connectionStatus,
        transportPhase: diag.transportPhase ? String(diag.transportPhase) : '',
        inRoom: !!roomState,
        isHost: roomState ? !!roomState.isHost : null,
        roomMemberCount: roomState?.members?.length ?? null,
        hostOnlyControl: !!roomState?.hostOnlyControl,
        countdownOnPlay: !!roomState?.countdownOnPlay,
        localAdBreakActive: !!localAdBreakActive,
        peersInAdCount: peersInAdBreak.size,
        pendingSyncStateQueued: !!diag.pendingSyncStateQueued,
        tabHidden: !!diag.tabHidden,
        videoBuffering: { ...diag.videoBuffering },
        findVideo: { ...diag.findVideo },
        playApplyMismatch:
          v && typeof v.paused === 'boolean' ? lastAppliedState.playing === v.paused : null,
        timeVsLastAppliedDeltaSec:
          v && typeof v.currentTime === 'number' && typeof lastAppliedState.currentTime === 'number'
            ? +(v.currentTime - lastAppliedState.currentTime).toFixed(3)
            : null,
        extensionOps: {
          syncStateDeferredNoVideo: diag.extensionOps.syncStateDeferredNoVideo,
          syncStateDeferredStaleOrMissing: diag.extensionOps.syncStateDeferredStaleOrMissing,
          syncStateDeniedSyncLock: diag.extensionOps.syncStateDeniedSyncLock,
          syncStateDeniedPlaybackDebounce: diag.extensionOps.syncStateDeniedPlaybackDebounce,
          remoteApplyDeniedSyncLock: diag.extensionOps.remoteApplyDeniedSyncLock,
          remoteApplyDeniedPlaybackDebounce: diag.extensionOps.remoteApplyDeniedPlaybackDebounce,
          remoteApplyDeferredTabHidden: diag.extensionOps.remoteApplyDeferredTabHidden,
          localControlBlockedHostOnly: diag.extensionOps.localControlBlockedHostOnly,
          syncStateFlushedOnVideoAttach: diag.extensionOps.syncStateFlushedOnVideoAttach,
          remoteApplyIgnoredLocalAd: diag.extensionOps.remoteApplyIgnoredLocalAd,
          syncStateIgnoredLocalAd: diag.extensionOps.syncStateIgnoredLocalAd,
          playbackOutboundSuppressedLocalAd: diag.extensionOps.playbackOutboundSuppressedLocalAd,
          hostPlaybackPositionSent: diag.extensionOps.hostPlaybackPositionSent,
          viewerSyncRequestSent: diag.extensionOps.viewerSyncRequestSent,
          positionReportSent: diag.extensionOps.positionReportSent,
          positionSnapshotInbound: diag.extensionOps.positionSnapshotInbound,
          syncStateHeldForAd: diag.extensionOps.syncStateHeldForAd,
          remotePlayHeldForAd: diag.extensionOps.remotePlayHeldForAd,
          remoteSeekHeldForAd: diag.extensionOps.remoteSeekHeldForAd
        },
        clusterSync: diag.clusterSync
          ? {
              spreadSec: diag.clusterSync.spreadSec,
              synced: diag.clusterSync.synced,
              playingMismatch: diag.clusterSync.playingMismatch,
              freshMemberCount: diag.clusterSync.freshMemberCount,
              staleCount: diag.clusterSync.staleCount,
              roomMemberCount: diag.clusterSync.roomMemberCount
            }
          : null
      };
    } catch {
      snap.playShare = { readError: true };
    }

    if (siteSync.key === 'prime' && diag.primeSync) {
      refreshPrimeSyncTelemetry();
      try {
        const p = diag.primeSync;
        snap.primeTelemetry = {
          adDetectorActive: p.adDetectorActive,
          adScore: p.adScore,
          adStrong: p.adStrong,
          adReasons: (p.adReasons || []).slice(0, 8),
          adChannels: p.adChannels ? { ...p.adChannels } : null,
          inSdkShell: p.inSdkShell,
          viewerDriftSec: p.viewerDriftSec,
          selectorThatMatched: p.selectorThatMatched,
          extensionLocalAd: p.extensionLocalAd,
          peersInAd: p.peersInAd,
          lastPollAt: p.lastPollAt
        };
      } catch {
        snap.primeTelemetry = { readError: true };
      }
    }

    if (siteSync.key === 'prime' && v) {
      try {
        const adSnap = getPrimeAdDetectionSnapshot(v);
        snap.primePlayer = {
          inMainSdkShell: isPrimeMainPlayerShell(v),
          adLikely: adSnap.likelyAd,
          adScore: adSnap.score,
          adStrong: adSnap.hasStrong,
          adReasons: (adSnap.reasons || []).slice(0, 8),
          adChannels: adSnap.channels ? { ...adSnap.channels } : null
        };
      } catch {
        snap.primePlayer = { readError: true };
      }
    }
  }

  function buildVideoProfilerExportExtras() {
    const sw = diag.serviceWorkerTransport;
    const iv = playbackProfile;
    return {
      playShareSession: {
        room: roomState
          ? {
              code: roomState.roomCode,
              isHost: !!roomState.isHost,
              memberCount: roomState.members?.length ?? 0,
              hostOnlyControl: !!roomState.hostOnlyControl
            }
          : null,
        playbackOutboundNote:
          'PLAY/PAUSE: polarity-aware flush + immediate wire when lastLocalWirePlayingSent is null; duplicate same-state <video> events skipped. Echo-suppress window still allows opposite-direction toggles vs lastAppliedState.playing so rapid UI after an apply is not dropped.',
        playbackProfile: {
          handlerKey: iv.handlerKey,
          label: iv.label,
          hostPositionIntervalMs: iv.hostPositionIntervalMs,
          viewerReconcileIntervalMs: iv.viewerReconcileIntervalMs,
          applyDebounceMs: iv.applyDebounceMs,
          playbackOutboundCoalesceMs: iv.playbackOutboundCoalesceMs,
          syncStateApplyDelayMs: iv.syncStateApplyDelayMs,
          playbackSlackSec: iv.playbackSlackSec,
          timeJumpThresholdSec: iv.timeJumpThresholdSec,
          hostSeekSuppressAfterPlayMs: iv.hostSeekSuppressAfterPlayMs,
          syncRequestDelayMs: iv.syncRequestDelayMs,
          aggressiveRemoteSync: iv.aggressiveRemoteSync,
          drmPassive: iv.drmPassive,
          useRelaxedVideoReady: iv.useRelaxedVideoReady
        },
        syncMetricsTotals: { ...(diag.sync?.metrics || {}) },
        timeupdateJumpsRecent: (diag.timeupdateJumps || []).slice(-24),
        recentSyncEventKinds: (diag.sync?.events || []).slice(-20).map((e) => e.type),
        peerReportCount: Object.keys(diag.sync?.peerReports || {}).length,
        serviceWorkerTransport: sw
          ? {
              wsOpenCount: sw.wsOpenCount,
              wsCloseCount: sw.wsCloseCount,
              wsSendFailures: sw.wsSendFailures
            }
          : null,
        messaging: {
          runtimeSendFailures: diag.messaging.runtimeSendFailures,
          runtimeLastErrorAt: diag.messaging.runtimeLastErrorAt,
          sendThrowCount: diag.messaging.sendThrowCount
        }
      }
    };
  }

  /** @type {ReturnType<typeof createVideoPlayerProfiler>|null} */
  let videoProfilerController = null;
  function getVideoProfiler() {
    if (!videoProfilerController) {
      videoProfilerController = createVideoPlayerProfiler({
        getVideo: () => {
          try {
            if (video && video.isConnected && document.contains(video)) return video;
          } catch {
            /* ignore */
          }
          return findVideo();
        },
        enrichSnapshot: enrichVideoProfilerSnapshot,
        getExportExtras: buildVideoProfilerExportExtras,
        /** ~3.3 h of 3 s snapshots if the buffer fills; ring drops oldest while PlayShare keeps running. */
        snapshotIntervalMs: 3000,
        maxSnapshots: 4000,
        maxEvents: 20000
      });
    }
    return videoProfilerController;
  }

  /** Compact, JSON-safe blob for `DIAG_SYNC_REPORT.devDiag` (dev builds only). */
  function buildPeerDevDiagSnapshot() {
    let ver = '1.0.0';
    try {
      ver = chrome.runtime.getManifest()?.version || ver;
    } catch {
      /* ignore */
    }
    /** @type {{ ct: number|null, playing: boolean|null, rs: number|null }} */
    const playback = { ct: null, playing: null, rs: null };
    try {
      const v = findVideo() || video;
      if (v && v.tagName === 'VIDEO') {
        playback.ct =
          typeof v.currentTime === 'number' && Number.isFinite(v.currentTime) ? +v.currentTime.toFixed(2) : null;
        playback.playing = !v.paused;
        playback.rs = v.readyState;
      }
    } catch {
      /* ignore */
    }
    let videoProfiler = null;
    try {
      const st = getVideoProfiler().getStatus();
      videoProfiler = {
        recording: st.recording,
        snapshotCount: st.snapshotCount,
        eventCount: st.eventCount,
        playheadStallMarkers: st.playheadStallMarkers
      };
    } catch {
      videoProfiler = null;
    }
    const cs = diag.clusterSync;
    return {
      schema: 'playshare.peerDevDiag.v1',
      capturedAt: Date.now(),
      extensionVersion: ver,
      timing: {
        lastRttMs: diag.timing?.lastRttMs ?? null,
        lastRttSource: diag.timing?.lastRttSource ?? null,
        driftEwmSec: diag.timing?.driftEwmSec ?? null
      },
      transport: {
        connectionStatus: diag.connectionStatus,
        transportPhase: diag.transportPhase || ''
      },
      tabHidden: !!diag.tabHidden,
      clusterSync: cs
        ? {
            spreadSec: cs.spreadSec,
            synced: cs.synced,
            playingMismatch: cs.playingMismatch,
            freshMemberCount: cs.freshMemberCount,
            staleCount: cs.staleCount,
            label: cs.label ? String(cs.label).slice(0, 80) : null
          }
        : null,
      videoBuffering: {
        waiting: diag.videoBuffering?.waiting ?? 0,
        stalled: diag.videoBuffering?.stalled ?? 0
      },
      findVideo: {
        cacheReturns: diag.findVideo?.cacheReturns ?? 0,
        fullScans: diag.findVideo?.fullScans ?? 0,
        invalidations: diag.findVideo?.invalidations ?? 0,
        videoAttachCount: diag.findVideo?.videoAttachCount ?? 0
      },
      extensionOps: {
        hostPlaybackPositionSent: diag.extensionOps.hostPlaybackPositionSent,
        viewerSyncRequestSent: diag.extensionOps.viewerSyncRequestSent,
        positionReportSent: diag.extensionOps.positionReportSent,
        positionSnapshotInbound: diag.extensionOps.positionSnapshotInbound,
        wsDisconnectEvents: diag.extensionOps.wsDisconnectEvents,
        syncStateInbound: diag.extensionOps.syncStateInbound,
        remoteApplyDeniedSyncLock: diag.extensionOps.remoteApplyDeniedSyncLock,
        remoteApplyDeniedPlaybackDebounce: diag.extensionOps.remoteApplyDeniedPlaybackDebounce
      },
      playback,
      videoProfiler,
      pendingSyncStateQueued: !!diag.pendingSyncStateQueued
    };
  }

  function detachVideo() {
    stopAdBreakMonitor();
    stopPositionReportInterval();
    if (!video) return;
    resetVideoPlaybackRate(video);
    video.removeEventListener('play',   onVideoPlay);
    video.removeEventListener('pause',  onVideoPause);
    video.removeEventListener('seeked', onVideoSeeked);
    video.removeEventListener('timeupdate', onVideoTimeUpdate);
    video.removeEventListener('waiting', onVideoWaiting);
    video.removeEventListener('stalled', onVideoStalled);
    video = null;
    invalidateVideoCache();
    diag.videoAttached = false;
    hideClusterSyncBadge();
    if (roomState?.isHost) {
      roomState.videoUrl = null;
      sendBg({ source: 'playshare', type: 'SET_ROOM_VIDEO_URL', videoUrl: null });
      postSidebarRoomState();
    }
    try {
      getVideoProfiler().notifyVideoMayHaveChanged();
    } catch {
      /* ignore */
    }
  }

  // ── Video event handlers ───────────────────────────────────────────────────
  function startHostPositionHeartbeat() {
    stopHostPositionHeartbeat();
    if (!roomState?.isHost || !video) return;
    hostPositionInterval = setInterval(() => {
      if (!video || video.paused || !roomState?.isHost) {
        stopHostPositionHeartbeat();
        return;
      }
      sendBg({ source: 'playshare', type: 'PLAYBACK_POSITION', currentTime: video.currentTime });
    }, playbackProfile.hostPositionIntervalMs);
  }

  function stopHostPositionHeartbeat() {
    if (hostPositionInterval) {
      clearInterval(hostPositionInterval);
      hostPositionInterval = null;
    }
  }

  function startViewerSyncInterval() {
    stopViewerSyncInterval();
    if (roomState?.isHost || !roomState) return;
    viewerSyncInterval = setInterval(() => {
      if (!roomState) {
        stopViewerSyncInterval();
        return;
      }
      sendBg({ source: 'playshare', type: 'SYNC_REQUEST' });
    }, VIEWER_SYNC_INTERVAL_MS);
  }

  function stopViewerSyncInterval() {
    if (viewerSyncInterval) {
      clearInterval(viewerSyncInterval);
      viewerSyncInterval = null;
    }
  }

  /**
   * Viewer-only: timeline anchor for reconcile. `sentAt` must be the viewer's Date.now() when
   * `currentTime` was (or will be) true locally — never the host/server clock, or extrapolation
   * drifts by skew (often seconds) after PLAY/PAUSE/SEEK.
   */
  function ingestHostAuthoritativeSync(currentTime, playing, sentAt) {
    if (roomState?.isHost) return;
    hostAuthoritativeRef = {
      currentTime,
      playing: !!playing,
      sentAt: typeof sentAt === 'number' && sentAt > 0 ? sentAt : Date.now()
    };
  }

  function adHoldBlocksRemotePlayback() {
    return peersInAdBreak.size > 0 && !localAdBreakActive;
  }

  function waitingForPeerAdInteraction() {
    return peersInAdBreak.size > 0 && !localAdBreakActive;
  }

  function syncAdBreakSidebar() {
    if (!roomState) return;
    postSidebar({
      type: 'AD_BREAK_UI',
      local: localAdBreakActive,
      waiting: peersInAdBreak.size > 0,
      peerNames: [...peersInAdBreak.values()]
    });
  }

  function ingestPeerAdBreakStart(fromClientId, fromUsername) {
    if (!roomState || fromClientId === roomState.clientId) return;
    peersInAdBreak.set(fromClientId, fromUsername || 'Someone');
    const v = findVideo() || video;
    // If we’re already in our own ad, don’t force-pause — both sides in ad otherwise fight each other.
    if (v && !localAdBreakActive) {
      forcePause(v, playbackProfile.aggressiveRemoteSync);
    }
    stopViewerReconcileLoop();
    if (v) resetVideoPlaybackRate(v);
    syncAdBreakSidebar();
  }

  function ingestPeerAdBreakEnd(fromClientId) {
    peersInAdBreak.delete(fromClientId);
    if (peersInAdBreak.size === 0 && !localAdBreakActive && roomState) {
      sendBg({ source: 'playshare', type: 'SYNC_REQUEST' });
      if (!roomState.isHost) startViewerReconcileLoop();
    }
    syncAdBreakSidebar();
  }

  function stopAdBreakMonitor() {
    if (adBreakMonitor) {
      adBreakMonitor.stop();
      adBreakMonitor = null;
    }
  }

  function startAdBreakMonitorIfNeeded() {
    stopAdBreakMonitor();
    if (!roomState) return;
    const adMonitorOpts = isPrimeVideoHostname(hostname)
      ? {
          ...PRIME_AD_BREAK_MONITOR_OPTIONS,
          detectOverride: (_h, v) => getPrimeAdDetectionSnapshot(v).likelyAd
        }
      : {};
    adBreakMonitor = createAdBreakMonitor(
      hostname,
      () => findVideo() || video,
      {
        onEnter: () => {
          if (localAdBreakActive) return;
          localAdBreakActive = true;
          sendBg({ source: 'playshare', type: 'AD_BREAK_START' });
          syncAdBreakSidebar();
        },
        onExit: () => {
          if (!localAdBreakActive) return;
          localAdBreakActive = false;
          sendBg({ source: 'playshare', type: 'AD_BREAK_END' });
          syncAdBreakSidebar();
        }
      },
      adMonitorOpts
    );
    adBreakMonitor.start();
  }

  function stopViewerReconcileLoop() {
    if (viewerReconcileInterval) {
      clearInterval(viewerReconcileInterval);
      viewerReconcileInterval = null;
    }
    if (softPlaybackRateResetTimer) {
      clearTimeout(softPlaybackRateResetTimer);
      softPlaybackRateResetTimer = null;
    }
  }

  function resetVideoPlaybackRate(v) {
    if (!v || v.tagName !== 'VIDEO') return;
    safeVideoOp(() => { v.playbackRate = 1; });
  }

  function schedulePlaybackRateReset(v) {
    if (softPlaybackRateResetTimer) clearTimeout(softPlaybackRateResetTimer);
    softPlaybackRateResetTimer = setTimeout(() => {
      softPlaybackRateResetTimer = null;
      const el = findVideo() || v;
      resetVideoPlaybackRate(el);
    }, SOFT_SYNC_RESET_MS);
  }

  function runViewerReconcileTick() {
    if (syncLock || !roomState || roomState.isHost || document.hidden) return;
    if (localAdBreakActive) return;
    if (adHoldBlocksRemotePlayback()) return;
    if (!hostAuthoritativeRef || !hostAuthoritativeRef.sentAt) return;
    const v = findVideo() || video;
    if (!v || isVideoStale(v)) return;
    const now = Date.now();
    const ref = hostAuthoritativeRef;
    const target = ref.playing
      ? ref.currentTime + (now - ref.sentAt) / 1000
      : ref.currentTime;
    const drift = v.currentTime - target;
    const adrift = Math.abs(drift);
    if (diag.primeSync) diag.primeSync.viewerDriftSec = drift;
    const driftHard = playbackProfile.playbackSlackSec ?? SYNC_DRIFT_HARD_SEC;

    if (playbackProfile.drmPassive) {
      platformPlaybackLog('VIEWER_RECONCILE_POLL', { adriftSec: +adrift.toFixed(2), hostPlaying: ref.playing });
      if (adrift > playbackProfile.drmDesyncThresholdSec) {
        diag.extensionOps.drmSyncPromptsShown++;
        drmSyncPrompt.offer({
          headline: 'Sync to host?',
          detail: `About ${adrift.toFixed(1)}s off the room. Tap once to realign (low-frequency DRM-safe sync).`,
          minIntervalMs: 8000,
          onConfirm: () => {
            diag.extensionOps.drmSyncConfirmed++;
            syncLock = true;
            applyDrmViewerOneShot(v, target, ref.playing);
            setTimeout(() => { syncLock = false; }, 700);
          }
        });
      }
      resetVideoPlaybackRate(v);
      return;
    }

    if (!ref.playing) {
      if (adrift > driftHard) {
        armPlaybackEchoSuppress();
        safeVideoOp(() => { v.currentTime = target; lastTimeUpdatePos = target; });
      }
      resetVideoPlaybackRate(v);
      return;
    }

    if (adrift > driftHard) {
      armPlaybackEchoSuppress();
      safeVideoOp(() => {
        v.currentTime = target;
        lastTimeUpdatePos = target;
        v.playbackRate = 1;
      });
      return;
    }

    if (adrift < SYNC_DRIFT_SOFT_MIN_SEC) {
      if (Math.abs(v.playbackRate - 1) > 0.02) {
        resetVideoPlaybackRate(v);
      }
      return;
    }

    const want = drift > 0 ? SOFT_SYNC_RATE_AHEAD : SOFT_SYNC_RATE_BEHIND;
    if (Math.abs(v.playbackRate - want) > 0.02) {
      safeVideoOp(() => { v.playbackRate = want; });
    }
    schedulePlaybackRateReset(v);
  }

  function startViewerReconcileLoop() {
    stopViewerReconcileLoop();
    if (roomState?.isHost || !roomState) return;
    viewerReconcileInterval = setInterval(runViewerReconcileTick, playbackProfile.viewerReconcileIntervalMs);
  }

  function sendPositionReportOnce() {
    if (!roomState || !video || isVideoStale(video)) return;
    if (document.hidden) return;
    sendBg({
      source: 'playshare',
      type: 'POSITION_REPORT',
      currentTime: video.currentTime,
      playing: !video.paused
    });
  }

  function startPositionReportInterval() {
    stopPositionReportInterval();
    if (!roomState || !video) return;
    sendPositionReportOnce();
    positionReportInterval = setInterval(sendPositionReportOnce, POSITION_REPORT_INTERVAL_MS);
  }

  function stopPositionReportInterval() {
    if (positionReportInterval) {
      clearInterval(positionReportInterval);
      positionReportInterval = null;
    }
  }

  function extrapolateSnapshotMemberTime(m, wallMs) {
    const dt = Math.max(0, (wallMs - m.receivedAt) / 1000);
    return m.playing ? m.currentTime + dt : m.currentTime;
  }

  function evaluateClusterPositionSnapshot(msg) {
    const wallMs = typeof msg.wallMs === 'number' ? msg.wallMs : Date.now();
    const members = Array.isArray(msg.members) ? msg.members : [];
    const fresh = members.filter((m) => !m.stale);
    const staleCount = members.length - fresh.length;
    const roomMemberCount = roomState?.members?.length ?? 0;
    if (roomMemberCount < 2) {
      return {
        spreadSec: null,
        synced: null,
        playingMismatch: false,
        freshMemberCount: fresh.length,
        staleCount,
        roomMemberCount,
        label: 'Cluster: add another participant',
        wallMs
      };
    }
    if (fresh.length < 2) {
      return {
        spreadSec: null,
        synced: null,
        playingMismatch: false,
        freshMemberCount: fresh.length,
        staleCount,
        roomMemberCount,
        label: fresh.length === 0 ? 'Cluster: waiting for playhead reports' : 'Cluster: waiting for more reports',
        wallMs
      };
    }
    const playSet = new Set(fresh.map((m) => !!m.playing));
    if (playSet.size > 1) {
      return {
        spreadSec: null,
        synced: false,
        playingMismatch: true,
        freshMemberCount: fresh.length,
        staleCount,
        roomMemberCount,
        label: 'Cluster: play/pause mismatch',
        wallMs
      };
    }
    const times = fresh.map((m) => extrapolateSnapshotMemberTime(m, wallMs));
    const spread = Math.max(...times) - Math.min(...times);
    const synced = spread < CLUSTER_SYNC_SPREAD_SEC;
    return {
      spreadSec: spread,
      synced,
      playingMismatch: false,
      freshMemberCount: fresh.length,
      staleCount,
      roomMemberCount,
      label: synced
        ? `Cluster: synced (within ${CLUSTER_SYNC_SPREAD_SEC}s)`
        : `Cluster: ~${spread.toFixed(1)}s apart`,
      wallMs
    };
  }

  function hideClusterSyncBadge() {
    if (clusterSyncBadge) {
      clusterSyncBadge.remove();
      clusterSyncBadge = null;
    }
  }

  function ensureClusterSyncBadge() {
    if (clusterSyncBadge) return;
    clusterSyncBadge = document.createElement('div');
    clusterSyncBadge.id = 'ws-cluster-sync-badge';
    clusterSyncBadge.setAttribute('aria-live', 'polite');
    clusterSyncBadge.style.cssText = `
      position:fixed;bottom:20px;right:20px;z-index:2147483630;
      font-size:12px;font-family:system-ui,sans-serif;font-weight:600;
      padding:6px 12px;border-radius:20px;pointer-events:none;
      border:1px solid rgba(255,255,255,0.12);backdrop-filter:blur(8px);
      box-shadow:0 4px 16px rgba(0,0,0,0.35);transition:opacity 0.2s;
    `;
    document.body.appendChild(clusterSyncBadge);
    reparentPlayShareUiForFullscreen();
  }

  function updateClusterSyncBadge() {
    if (!roomState || !diag.videoAttached) {
      hideClusterSyncBadge();
      return;
    }
    const c = diag.clusterSync;
    ensureClusterSyncBadge();
    if (!c) {
      clusterSyncBadge.textContent = 'Sync: …';
      clusterSyncBadge.style.background = 'rgba(30,30,30,0.85)';
      clusterSyncBadge.style.color = '#ccc';
      return;
    }
    let short = 'Sync: …';
    if (c.playingMismatch) short = 'Sync: play/pause';
    else if (c.synced === true) short = 'Sync: ✓';
    else if (c.synced === false && c.spreadSec != null) short = `Sync: ~${c.spreadSec.toFixed(1)}s`;
    else if (c.synced === false) short = 'Sync: unsynced';
    else short = 'Sync: waiting';
    clusterSyncBadge.textContent = short;
    if (c.playingMismatch) {
      clusterSyncBadge.style.background = 'rgba(80,20,20,0.9)';
      clusterSyncBadge.style.color = '#ffccc8';
    } else if (c.synced === true) {
      clusterSyncBadge.style.background = 'rgba(20,60,40,0.9)';
      clusterSyncBadge.style.color = '#b8f5c8';
    } else if (c.synced === false) {
      clusterSyncBadge.style.background = 'rgba(60,50,15,0.9)';
      clusterSyncBadge.style.color = '#ffe08a';
    } else {
      clusterSyncBadge.style.background = 'rgba(35,35,40,0.88)';
      clusterSyncBadge.style.color = '#bdbdbd';
    }
  }

  function ingestPositionSnapshot(msg) {
    if (!roomState || msg.roomCode !== roomState.roomCode) return;
    diag.clusterSync = evaluateClusterPositionSnapshot(msg);
    diag.extensionOps.positionSnapshotInbound++;
    const c = diag.clusterSync;
    const sidebarKey = c ? `${c.label}|${c.synced}|${c.spreadSec}|${c.playingMismatch}` : '';
    if (sidebarKey !== lastClusterSidebarKey) {
      lastClusterSidebarKey = sidebarKey;
      postSidebar({
        type: 'CLUSTER_SYNC',
        synced: c?.synced ?? null,
        spreadSec: c?.spreadSec ?? null,
        playingMismatch: !!c?.playingMismatch,
        label: c?.label || ''
      });
    }
    updateClusterSyncBadge();
    scheduleDiagUpdate();
  }

  function updateVideoUrl() {
    if (roomState?.isHost && video) {
      sendBg({ source: 'playshare', type: 'SET_ROOM_VIDEO_URL', videoUrl: location.href });
      roomState.videoUrl = location.href;
      postSidebarRoomState();
    }
  }

  function canControlPlayback() {
    return !roomState?.hostOnlyControl || roomState?.isHost;
  }

  function clearPlaybackOutboundCoalesce() {
    if (playbackOutboundCoalesceTimer) {
      clearTimeout(playbackOutboundCoalesceTimer);
      playbackOutboundCoalesceTimer = null;
    }
  }

  function clearRemotePlaybackDebouncedQueue() {
    queuedRemotePlaybackApply = null;
    if (remotePlaybackDebounceTimer) {
      clearTimeout(remotePlaybackDebounceTimer);
      remotePlaybackDebounceTimer = null;
    }
  }

  /**
   * When remote PLAY/PAUSE/SEEK hits apply debounce, queue one retry with bypass so the latest
   * message is not dropped during rapid host toggles.
   */
  function scheduleDebouncedRemotePlaybackRetry(run) {
    queuedRemotePlaybackApply = run;
    if (remotePlaybackDebounceTimer) return;
    const debounceMs = playbackProfile.applyDebounceMs || 0;
    const delay = Math.max(debounceMs, 40) + 30;
    remotePlaybackDebounceTimer = setTimeout(() => {
      remotePlaybackDebounceTimer = null;
      const fn = queuedRemotePlaybackApply;
      queuedRemotePlaybackApply = null;
      if (typeof fn === 'function') fn();
    }, delay);
  }

  /** Send current local play/pause state to the room (trailing-edge coalesced on Prime). */
  function flushLocalPlaybackWireToRoom() {
    playbackOutboundCoalesceTimer = null;
    if (!roomState || syncLock || countdownInProgress) return;
    const v = findVideo() || video;
    if (!v) return;
    lastLocalPlaybackWireAt = Date.now();
    const t = v.currentTime;
    if (v.paused) {
      lastPlaybackOutboundKind = 'PAUSE';
      updateVideoUrl();
      syncDiagRecord({ type: 'pause_sent', currentTime: t });
      sendBg({ source: 'playshare', type: 'PAUSE', currentTime: t, sentAt: Date.now() });
      if (roomState.isHost) stopHostPositionHeartbeat();
      stopViewerSyncInterval();
      diagLog('PAUSE', { currentTime: t, source: 'local' });
      showToast('⏸ You paused');
    } else {
      lastSentTime = t;
      lastPlaybackOutboundKind = 'PLAY';
      updateVideoUrl();
      syncDiagRecord({ type: 'play_sent', currentTime: t });
      sendBg({ source: 'playshare', type: 'PLAY', currentTime: t, sentAt: Date.now() });
      diagLog('PLAY', { currentTime: t, source: 'local' });
      showToast('▶ You pressed play');
    }
    lastLocalWirePlayingSent = !v.paused;
  }

  function scheduleLocalPlaybackWireToRoom() {
    const ms = playbackProfile.playbackOutboundCoalesceMs ?? 0;
    if (ms <= 0) {
      flushLocalPlaybackWireToRoom();
      return;
    }
    if (Date.now() - lastLocalPlaybackWireAt >= ms) {
      flushLocalPlaybackWireToRoom();
      return;
    }
    if (playbackOutboundCoalesceTimer) clearTimeout(playbackOutboundCoalesceTimer);
    playbackOutboundCoalesceTimer = setTimeout(flushLocalPlaybackWireToRoom, ms);
  }

  function showCountdownOverlay(thenPlay) {
    if (countdownInProgress) return;
    countdownInProgress = true;
    // Force video to stay paused during countdown (platforms may try to resume)
    const forcePause = () => { if (video && !video.paused) safeVideoOp(() => { video.pause(); }); };
    const onPlaying = () => { forcePause(); };
    if (video) video.addEventListener('playing', onPlaying);
    const pauseGuard = setInterval(forcePause, 150);  // 150ms — responsive, less CPU than 80ms
    const clearGuard = () => {
      clearInterval(pauseGuard);
      if (video) video.removeEventListener('playing', onPlaying);
    };
    const overlay = document.createElement('div');
    overlay.id = 'ws-countdown-overlay';
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:2147483640;display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,0.6);pointer-events:none;contain:layout style paint;
    `;
    const num = document.createElement('div');
    num.style.cssText = `
      font-size:120px;font-weight:800;color:#fff;text-shadow:0 0 40px rgba(78,205,196,0.6);
      font-family:system-ui,sans-serif;animation:wsCountPulse 1s ease;
    `;
    overlay.appendChild(num);
    const style = document.createElement('style');
    style.textContent = `@keyframes wsCountPulse{0%{opacity:0;transform:scale(0.5)}50%{opacity:1;transform:scale(1.2)}100%{opacity:1;transform:scale(1)}}`;
    document.head.appendChild(style);
    document.body.appendChild(overlay);
    countdownOverlayEl = overlay;
    reparentPlayShareUiForFullscreen();
    let n = COUNTDOWN_SECONDS;
    num.textContent = n;
    const tick = () => {
      n--;
      if (n > 0) {
        num.textContent = n;
        num.style.animation = 'none';
        num.offsetHeight;
        num.style.animation = 'wsCountPulse 1s ease';
        setTimeout(tick, 1000);
      } else {
        overlay.remove();
        countdownOverlayEl = null;
        clearGuard();
        countdownInProgress = false;
        if (thenPlay && video) {
          syncLock = false;
          const t = video.currentTime;
          lastSentTime = t;
          updateVideoUrl();
          syncDiagRecord({ type: 'play_sent', currentTime: t });
          sendBg({ source: 'playshare', type: 'PLAY', currentTime: t, sentAt: Date.now() });
          lastPlaybackOutboundKind = 'PLAY';
          lastLocalWirePlayingSent = true;
          if (roomState.isHost) startHostPositionHeartbeat();
          safeVideoOp(() => { video.play().catch(() => {}); });
          showToast('▶ You pressed play');
        }
      }
    };
    setTimeout(tick, 1000);
  }

  function onVideoPlay() {
    if (roomState?.isHost) {
      hostTimeupdateSeekSuppressUntil = Date.now() + playbackProfile.hostSeekSuppressAfterPlayMs;
    }
    if (syncLock || !roomState) return;
    if (shouldSuppressPlaybackOutboundEcho(true)) return;
    if (localAdBreakActive) {
      diag.extensionOps.playbackOutboundSuppressedLocalAd++;
      return;
    }
    if (countdownInProgress) return;
    if (waitingForPeerAdInteraction()) {
      syncLock = true;
      safeVideoOp(() => { video.pause(); });
      setTimeout(() => { syncLock = false; }, 300);
      showToast('Waiting for others to finish their ad…');
      return;
    }
    if (!canControlPlayback()) {
      diag.extensionOps.localControlBlockedHostOnly++;
      showToast('Only the host can control playback');
      if (!playbackProfile.drmPassive) {
        syncLock = true;
        safeVideoOp(() => {
          video.currentTime = lastAppliedState.currentTime;
          if (!lastAppliedState.playing) video.pause();
        });
        setTimeout(() => { syncLock = false; }, 300);
      } else {
        drmSyncPrompt.offer({
          headline: 'Sync to host?',
          detail: 'Match the room once instead of starting playback yourself.',
          minIntervalMs: 10000,
          onConfirm: () => {
            if (!hostAuthoritativeRef) return;
            const v = findVideo() || video;
            if (!v) return;
            const now = Date.now();
            const ref = hostAuthoritativeRef;
            const t = ref.playing ? ref.currentTime + (now - ref.sentAt) / 1000 : ref.currentTime;
            diag.extensionOps.drmSyncConfirmed++;
            syncLock = true;
            applyDrmViewerOneShot(v, t, ref.playing);
            setTimeout(() => { syncLock = false; }, 600);
          }
        });
      }
      return;
    }
    const t = video.currentTime;
    const coalesceMs = playbackProfile.playbackOutboundCoalesceMs ?? 0;
    if (coalesceMs <= 0) {
      const allowPlayDespiteSameTime =
        lastPlaybackOutboundKind === 'PAUSE' || lastPlaybackOutboundKind === 'SEEK';
      if (!allowPlayDespiteSameTime && Math.abs(t - lastSentTime) < 0.3) return;
    }
    if (roomState.isHost && roomState.countdownOnPlay && !playbackProfile.drmPassive) {
      syncLock = true;
      safeVideoOp(() => { video.pause(); });
      requestAnimationFrame(() => safeVideoOp(() => { video.pause(); }));
      setTimeout(() => safeVideoOp(() => { video.pause(); }), 0);
      sendBg({ source: 'playshare', type: 'COUNTDOWN_START', currentTime: t });
      postSidebar({ type: 'COUNTDOWN_START', currentTime: t, fromUsername: roomState?.username });
      showCountdownOverlay(true);
      diagLog('PLAY', { currentTime: t, source: 'local', countdown: true });
      return;
    }
    if (lastLocalWirePlayingSent === true) return;
    if (lastLocalWirePlayingSent === false) {
      clearPlaybackOutboundCoalesce();
      flushLocalPlaybackWireToRoom();
      return;
    }
    clearPlaybackOutboundCoalesce();
    flushLocalPlaybackWireToRoom();
  }

  function onVideoPause() {
    if (syncLock || !roomState || countdownInProgress) return;
    if (shouldSuppressPlaybackOutboundEcho(false)) return;
    if (localAdBreakActive) {
      diag.extensionOps.playbackOutboundSuppressedLocalAd++;
      return;
    }
    if (!canControlPlayback()) {
      diag.extensionOps.localControlBlockedHostOnly++;
      showToast('Only the host can control playback');
      if (!playbackProfile.drmPassive) {
        syncLock = true;
        safeVideoOp(() => {
          video.currentTime = lastAppliedState.currentTime;
          if (lastAppliedState.playing) video.play().catch(() => {});
        });
        setTimeout(() => { syncLock = false; }, 300);
      } else {
        drmSyncPrompt.offer({
          headline: 'Sync to host?',
          detail: 'Match the room once instead of pausing yourself.',
          minIntervalMs: 10000,
          onConfirm: () => {
            if (!hostAuthoritativeRef) return;
            const v = findVideo() || video;
            if (!v) return;
            const now = Date.now();
            const ref = hostAuthoritativeRef;
            const t = ref.playing ? ref.currentTime + (now - ref.sentAt) / 1000 : ref.currentTime;
            diag.extensionOps.drmSyncConfirmed++;
            syncLock = true;
            applyDrmViewerOneShot(v, t, ref.playing);
            setTimeout(() => { syncLock = false; }, 600);
          }
        });
      }
      return;
    }
    if (lastLocalWirePlayingSent === false) return;
    if (lastLocalWirePlayingSent === true) {
      clearPlaybackOutboundCoalesce();
      flushLocalPlaybackWireToRoom();
      return;
    }
    clearPlaybackOutboundCoalesce();
    flushLocalPlaybackWireToRoom();
  }

  function onVideoWaiting() {
    const vb = diag.videoBuffering;
    vb.waiting++;
    vb.lastWaitingAt = Date.now();
    scheduleDiagUpdate();
  }

  function onVideoStalled() {
    const vb = diag.videoBuffering;
    vb.stalled++;
    vb.lastStalledAt = Date.now();
    scheduleDiagUpdate();
  }

  function onVideoSeeked() {
    // Prime *may* swap <video> on some setups; if our node is still in the tree, keep the cache.
    // Unconditional invalidate caused a full DOM scan + diag noise on every scrub while the same element survived.
    if (
      !video ||
      !video.isConnected ||
      !document.contains(video) ||
      (cachedVideoEl && video !== cachedVideoEl)
    ) {
      invalidateVideoCache();
    }
    if (syncLock || !roomState) return;
    if (isPlaybackEchoSuppressed()) return;
    if (localAdBreakActive) {
      diag.extensionOps.playbackOutboundSuppressedLocalAd++;
      return;
    }
    if (waitingForPeerAdInteraction()) {
      syncLock = true;
      safeVideoOp(() => { video.currentTime = lastAppliedState.currentTime; });
      setTimeout(() => { syncLock = false; }, 300);
      return;
    }
    if (!canControlPlayback()) {
      diag.extensionOps.localControlBlockedHostOnly++;
      showToast('Only the host can control playback');
      if (!playbackProfile.drmPassive) {
        syncLock = true;
        safeVideoOp(() => { video.currentTime = lastAppliedState.currentTime; });
        setTimeout(() => { syncLock = false; }, 300);
      }
      return;
    }
    const t = video.currentTime;
    if (Math.abs(t - lastSentTime) < 0.5) return;
    lastSentTime = t;
    lastPlaybackOutboundKind = 'SEEK';
    lastTimeUpdatePos = t;  // avoid duplicate send from onVideoTimeUpdate
    updateVideoUrl();
    syncDiagRecord({ type: 'seek_sent', currentTime: t });
    sendBg({ source: 'playshare', type: 'SEEK', currentTime: t, sentAt: Date.now() });
    diagLog('SEEK', { currentTime: t, source: 'local' });
    showToast(`⏩ Seeked to ${formatTime(t)}`);
  }

  function onVideoTimeUpdate() {
    if (video && roomState && !syncLock) {
      const nowJ = Date.now();
      if (nowJ - diag._lastTuDiagAt >= 350) {
        const prev = diag._lastTuDiagPos;
        const tj = video.currentTime;
        diag._lastTuDiagAt = nowJ;
        const tuJump = playbackProfile.timeJumpThresholdSec ?? TIME_JUMP_THRESHOLD;
        if (typeof prev === 'number' && prev >= 0 && Math.abs(tj - prev) > tuJump) {
          diag.timeupdateJumps.unshift({ t: nowJ, from: prev, to: tj, deltaSec: +(tj - prev).toFixed(2) });
          if (diag.timeupdateJumps.length > 20) diag.timeupdateJumps.pop();
        }
        diag._lastTuDiagPos = tj;
      }
    }
    if (!video || syncLock || !roomState?.isHost || !canControlPlayback()) return;
    const now = Date.now();
    if (now - lastTimeUpdateCheckAt < 500) return;  // throttle to ~2 checks/sec
    lastTimeUpdateCheckAt = now;
    const t = video.currentTime;
    const prev = lastTimeUpdatePos;
    lastTimeUpdatePos = t;
    if (Date.now() < hostTimeupdateSeekSuppressUntil) return;
    const hostJump = playbackProfile.timeJumpThresholdSec ?? TIME_JUMP_THRESHOLD;
    if (prev >= 0 && Math.abs(t - prev) > hostJump) {
      if (Math.abs(t - lastSentTime) < 0.5) return;
      lastSentTime = t;
      lastPlaybackOutboundKind = 'SEEK';
      syncDiagRecord({ type: 'seek_sent', currentTime: t, source: 'timeupdate' });
      sendBg({ source: 'playshare', type: 'SEEK', currentTime: t, sentAt: Date.now() });
      diagLog('SEEK', { currentTime: t, source: 'internal' });
    }
  }

  // ── Sync application (non-interfering: no preventDefault, wrapped in try-catch) ─
  function safeVideoOp(fn) {
    try { fn(); } catch (e) { /* avoid breaking platform player */ }
  }

  /** Single user-confirmed seek + play/pause for DRM services (no retry storms). */
  function applyDrmViewerOneShot(v, targetTime, wantPlaying) {
    if (!v || v.tagName !== 'VIDEO') return;
    armPlaybackEchoSuppress();
    platformPlaybackLog('DRM_USER_SYNC_APPLY', { targetTime, wantPlaying });
    safeVideoOp(() => {
      if (typeof targetTime === 'number' && !isNaN(targetTime) && targetTime >= 0) {
        v.currentTime = targetTime;
        lastTimeUpdatePos = targetTime;
      }
      if (wantPlaying) v.play().catch(() => {});
      else v.pause();
    });
  }

  function dispatchSpaceKey(target) {
    if (!target) return;
    const ev = new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, view: window });
    target.dispatchEvent(ev);
  }

  function simulateVideoClick(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('click', { ...opts, bubbles: true, view: window }));
  }

  /**
   * @param {HTMLVideoElement} v
   * @param {boolean} [aggressive] — false: one play() only (YouTube/Prime use true with UI fallbacks)
   */
  function forcePlay(v, aggressive) {
    if (!v || v.tagName !== 'VIDEO') return;
    const useAggressive = aggressive !== false;
    if (!useAggressive) {
      safeVideoOp(() => { v.play().catch(() => {}); });
      return;
    }
    safeVideoOp(() => { v.play().catch(() => {}); });
    requestAnimationFrame(() => safeVideoOp(() => { v.play().catch(() => {}); }));
    [150, 350, 550].forEach((ms, i) => {
      setTimeout(() => {
        const v2 = findVideo() || v;
        if (!v2 || !v2.paused) return;
        safeVideoOp(() => { v2.play().catch(() => {}); });
        simulateVideoClick(v2);
        const playSelectors = [
          '.nf-flat-button.nf-play', '.player-play-pause', '.player-control-button',
          '.ytp-play-button', 'button[aria-label="Play"]', '[aria-label*="Play"]', '[data-title="Play"]',
          '.atvwebplayersdk-playpause-button', '.atvwebplayersdk-player-controls button', '[class*="play"]'
        ];
        for (const sel of playSelectors) {
          const btn = document.querySelector(sel);
          if (btn && btn.offsetParent !== null) { safeVideoOp(() => { btn.click(); }); break; }
        }
        if (v2.paused && siteSync.onStillPausedAfterAggressivePlay) {
          siteSync.onStillPausedAfterAggressivePlay(v2, { dispatchSpaceKey });
        }
      }, ms);
    });
  }

  /**
   * @param {HTMLVideoElement} v
   * @param {boolean} [aggressive]
   */
  function forcePause(v, aggressive) {
    if (!v || v.tagName !== 'VIDEO') return;
    const useAggressive = aggressive !== false;
    if (!useAggressive) {
      safeVideoOp(() => { v.pause(); });
      return;
    }
    safeVideoOp(() => { v.pause(); });
    requestAnimationFrame(() => safeVideoOp(() => { v.pause(); }));
    [150, 350, 550].forEach((ms) => {
      setTimeout(() => {
        const v2 = findVideo() || v;
        if (!v2 || v2.paused) return;
        safeVideoOp(() => { v2.pause(); });
        simulateVideoClick(v2);
        const pauseSelectors = [
          '.nf-flat-button.nf-pause', '.player-play-pause', '.player-control-button',
          '.ytp-play-button', 'button[aria-label="Pause"]', '[aria-label*="Pause"]', '[data-title="Pause"]',
          '.atvwebplayersdk-playpause-button', '.atvwebplayersdk-player-controls button', '[class*="pause"]'
        ];
        for (const sel of pauseSelectors) {
          const btn = document.querySelector(sel);
          if (btn && btn.offsetParent !== null) { safeVideoOp(() => { btn.click(); }); break; }
        }
        if (!v2.paused && siteSync.onStillPlayingAfterAggressivePause) {
          siteSync.onStillPlayingAfterAggressivePause(v2, { dispatchSpaceKey });
        }
      }, ms);
    });
  }

  function getSyncThreshold() {
    if (playbackProfile.drmPassive) return playbackProfile.syncThresholdSoft;
    if (playbackProfile.playbackSlackSec != null) return playbackProfile.playbackSlackSec;
    return SYNC_THRESHOLD;
  }

  /**
   * Gate for applying remote PLAY/PAUSE/SEEK/SYNC_STATE. Count denials in extensionOps.
   */
  /**
   * @param {{ bypassPlaybackDebounce?: boolean } | undefined} remoteOpts
   */
  function getRemoteApplySyncGate(remoteOpts) {
    if (syncLock) return { ok: false, reason: 'sync_lock' };
    if (
      !remoteOpts?.bypassPlaybackDebounce &&
      playbackProfile.applyDebounceMs > 0 &&
      Date.now() - lastSyncAt < playbackProfile.applyDebounceMs
    ) {
      return { ok: false, reason: 'playback_debounce' };
    }
    return { ok: true, reason: null };
  }

  function canApplySync() {
    return getRemoteApplySyncGate().ok;
  }

  function applyPlayWhenReady(v, currentTime, onDone, aggressive) {
    safeVideoOp(() => { v.currentTime = currentTime; lastTimeUpdatePos = currentTime; });
    const doPlay = () => {
      forcePlay(findVideo() || v, aggressive);
      if (onDone) onDone();
    };
    if (v.seeking) {
      let done = false;
      const run = () => { if (done) return; done = true; doPlay(); };
      const onSeeked = () => { v.removeEventListener('seeked', onSeeked); clearTimeout(tid); run(); };
      v.addEventListener('seeked', onSeeked, { once: true });
      const tid = setTimeout(() => { v.removeEventListener('seeked', onSeeked); run(); }, 3000);
    } else {
      doPlay();
    }
  }

  function applyPlay(currentTime, fromUsername, fromClientId, sentAt, lastRtt, correlationId, serverTime, remoteOpts) {
    if (!video || isVideoStale(video)) return;
    const gate = getRemoteApplySyncGate(remoteOpts);
    if (!gate.ok) {
      if (gate.reason === 'sync_lock') diag.extensionOps.remoteApplyDeniedSyncLock++;
      else if (gate.reason === 'playback_debounce') {
        diag.extensionOps.remoteApplyDeniedPlaybackDebounce++;
        if (!remoteOpts?.bypassPlaybackDebounce) {
          scheduleDebouncedRemotePlaybackRetry(() => {
            applyPlay(currentTime, fromUsername, fromClientId, sentAt, lastRtt, correlationId, serverTime, {
              bypassPlaybackDebounce: true
            });
          });
        }
      }
      return;
    }
    if (localAdBreakActive) {
      diag.extensionOps.remoteApplyIgnoredLocalAd++;
      diagLog('PLAY', { currentTime, fromUsername, source: 'remote', skipped: true, reason: 'local_ad' });
      return;
    }
    const recvAt = Date.now();
    if (typeof lastRtt === 'number' && lastRtt > 0) {
      diag.timing.lastRttMs = lastRtt;
      diag.timing.lastRttSource = 'playback';
    }
    // Prefer RTT/2 (clock-skew safe) over recvAt-sentAt (assumes synced clocks)
    let targetTime = currentTime;
    if (typeof lastRtt === 'number' && lastRtt > 0) {
      targetTime = currentTime + (lastRtt / 2) / 1000;
    } else if (sentAt && typeof sentAt === 'number') {
      targetTime = currentTime + (recvAt - sentAt) / 1000;
    }
    if (!roomState?.isHost) {
      ingestHostAuthoritativeSync(targetTime, true, recvAt);
    }
    if (adHoldBlocksRemotePlayback()) {
      diag.extensionOps.remotePlayHeldForAd++;
      diagLog('PLAY', { currentTime: targetTime, fromUsername, source: 'remote', adHold: true });
      return;
    }
    clearRemotePlaybackDebouncedQueue();
    pushDiagTimeline(diag.timing.timeline, {
      kind: 'play_recv',
      correlationId: correlationId || null,
      targetTime,
      rttMs: lastRtt,
      serverTime,
      recvAt
    });
    syncDiagRecord({ type: 'play_recv', currentTime: targetTime, fromUsername, drift: Math.abs(video.currentTime - targetTime), correlationId });
    lastAppliedState = { currentTime: targetTime, playing: true };
    lastSentTime = targetTime;  // prevent echo when our play event fires after apply
    lastPlaybackOutboundKind = 'PLAY';
    lastLocalWirePlayingSent = true;
    lastSyncAt = Date.now();

    if (playbackProfile.drmPassive && !roomState?.isHost) {
      diag.extensionOps.drmSyncPromptsShown++;
      platformPlaybackLog('DRM_SYNC_OFFER', { kind: 'remote_play', targetTime, fromUsername });
      drmSyncPrompt.offer({
        headline: 'Sync to host?',
        detail: `${fromUsername || 'Host'} started playback. Tap once to jump to their time and play — avoids DRM playback errors.`,
        minIntervalMs: 6000,
        onConfirm: () => {
          diag.extensionOps.drmSyncConfirmed++;
          const v = findVideo() || video;
          if (!v || isVideoStale(v)) return;
          syncLock = true;
          applyDrmViewerOneShot(v, targetTime, true);
          postSidebar({ type: 'SYNC_QUALITY', drift: Math.abs(v.currentTime - targetTime) });
          setTimeout(() => { syncLock = false; }, 700);
        }
      });
      startViewerSyncInterval();
      diagLog('PLAY', { currentTime: targetTime, fromUsername, source: 'remote', drmPassive: true });
      return;
    }

    syncLock = true;
    if (roomState?.isHost) {
      hostTimeupdateSeekSuppressUntil = Date.now() + playbackProfile.hostSeekSuppressAfterPlayMs;
    }
    const driftBefore = Math.abs(video.currentTime - targetTime);
    const delay = getApplyDelayMs(lastRtt, playbackProfile);
    const doApply = () => {
      if (isVideoStale(video)) { syncLock = false; return; }
      const v = findVideo() || video;
      if (!v) { syncLock = false; return; }
      armPlaybackEchoSuppress();
      applyPlayWhenReady(v, targetTime, () => {
        postSidebar({ type: 'SYNC_QUALITY', drift: driftBefore });
        setTimeout(() => { syncLock = false; }, 800);  // 800ms: forcePlay retries at 150/350/550ms
        setTimeout(() => {
          const v2 = findVideo() || v;
          const ok = v2 && !v2.paused;
          const latency = Date.now() - recvAt;
          const driftAfter = v2 ? Math.abs(v2.currentTime - targetTime) : null;
          if (driftAfter != null) updateDriftEwm(diag.timing, driftAfter);
          pushDiagTimeline(diag.timing.timeline, {
            kind: ok ? 'play_apply_ok' : 'play_apply_fail',
            correlationId: correlationId || null,
            driftSec: driftAfter,
            latencyMs: latency
          });
          syncDiagRecord({ type: ok ? 'play_ok' : 'play_fail', currentTime: targetTime, fromUsername, latency, correlationId });
          if (fromClientId) sendDiagApplyResult(fromClientId, 'play', ok, latency, correlationId);
        }, 600);
      }, playbackProfile.aggressiveRemoteSync);
    };
    const runWhenReady = () => {
      if (document.hidden) {
        diag.extensionOps.remoteApplyDeferredTabHidden++;
        let done = false;
        const run = () => { if (done) return; done = true; doApply(); };
        const onVisible = () => { document.removeEventListener('visibilitychange', onVisible); clearTimeout(tid); run(); };
        document.addEventListener('visibilitychange', onVisible);
        const tid = setTimeout(() => { document.removeEventListener('visibilitychange', onVisible); run(); }, 5000);
      } else {
        doApply();
      }
    };
    setTimeout(runWhenReady, delay);
    if (roomState?.isHost) startHostPositionHeartbeat();
    else startViewerSyncInterval();
    diagLog('PLAY', { currentTime: targetTime, fromUsername, source: 'remote' });
    // Toast comes from server SYSTEM_MSG so it still shows if apply bails early (no video, debounce)
  }

  function applyPause(currentTime, fromUsername, fromClientId, lastRtt, correlationId, serverTime, sentAt, remoteOpts) {
    if (!video || isVideoStale(video)) return;
    const gate = getRemoteApplySyncGate(remoteOpts);
    if (!gate.ok) {
      if (gate.reason === 'sync_lock') diag.extensionOps.remoteApplyDeniedSyncLock++;
      else if (gate.reason === 'playback_debounce') {
        diag.extensionOps.remoteApplyDeniedPlaybackDebounce++;
        if (!remoteOpts?.bypassPlaybackDebounce) {
          scheduleDebouncedRemotePlaybackRetry(() => {
            applyPause(currentTime, fromUsername, fromClientId, lastRtt, correlationId, serverTime, sentAt, {
              bypassPlaybackDebounce: true
            });
          });
        }
      }
      return;
    }
    if (localAdBreakActive) {
      diag.extensionOps.remoteApplyIgnoredLocalAd++;
      diagLog('PAUSE', { currentTime, fromUsername, source: 'remote', skipped: true, reason: 'local_ad' });
      return;
    }
    const recvAt = Date.now();
    if (!roomState?.isHost) {
      ingestHostAuthoritativeSync(currentTime, false, recvAt);
    }
    if (typeof lastRtt === 'number' && lastRtt > 0) {
      diag.timing.lastRttMs = lastRtt;
      diag.timing.lastRttSource = 'playback';
    }
    clearRemotePlaybackDebouncedQueue();
    pushDiagTimeline(diag.timing.timeline, { kind: 'pause_recv', correlationId: correlationId || null, currentTime, serverTime, recvAt, rttMs: lastRtt });
    syncDiagRecord({ type: 'pause_recv', currentTime, fromUsername, drift: Math.abs(video.currentTime - currentTime), correlationId });
    lastAppliedState = { currentTime, playing: false };
    lastSentTime = currentTime;  // prevent echo when our pause event fires after apply
    lastPlaybackOutboundKind = 'PAUSE';
    lastLocalWirePlayingSent = false;
    lastSyncAt = Date.now();

    if (playbackProfile.drmPassive && !roomState?.isHost) {
      stopViewerSyncInterval();
      diag.extensionOps.drmSyncPromptsShown++;
      platformPlaybackLog('DRM_SYNC_OFFER', { kind: 'remote_pause', currentTime, fromUsername });
      drmSyncPrompt.offer({
        headline: 'Sync to host?',
        detail: `${fromUsername || 'Host'} paused. Tap once to align and pause — avoids DRM playback errors.`,
        minIntervalMs: 6000,
        onConfirm: () => {
          diag.extensionOps.drmSyncConfirmed++;
          const v = findVideo() || video;
          if (!v || isVideoStale(v)) return;
          syncLock = true;
          applyDrmViewerOneShot(v, currentTime, false);
          postSidebar({ type: 'SYNC_QUALITY', drift: Math.abs(v.currentTime - currentTime) });
          setTimeout(() => { syncLock = false; }, 600);
        }
      });
      diagLog('PAUSE', { currentTime, fromUsername, source: 'remote', drmPassive: true });
      return;
    }

    syncLock = true;
    const driftBefore = Math.abs(video.currentTime - currentTime);
    const delay = getApplyDelayMs(lastRtt, playbackProfile);
    const doApply = () => {
      if (isVideoStale(video)) { syncLock = false; return; }
      const v = findVideo() || video;
      if (!v) { syncLock = false; return; }
      armPlaybackEchoSuppress();
      safeVideoOp(() => {
        v.currentTime = currentTime;
        lastTimeUpdatePos = currentTime;
        forcePause(v, playbackProfile.aggressiveRemoteSync);
      });
      postSidebar({ type: 'SYNC_QUALITY', drift: driftBefore });
      setTimeout(() => { syncLock = false; }, 500);
      setTimeout(() => {
        const v2 = findVideo() || v;
        const ok = v2 && v2.paused;
        const latency = Date.now() - recvAt;
        const driftAfter = v2 ? Math.abs(v2.currentTime - currentTime) : null;
        if (driftAfter != null) updateDriftEwm(diag.timing, driftAfter);
        pushDiagTimeline(diag.timing.timeline, {
          kind: ok ? 'pause_apply_ok' : 'pause_apply_fail',
          correlationId: correlationId || null,
          driftSec: driftAfter,
          latencyMs: latency
        });
        syncDiagRecord({ type: ok ? 'pause_ok' : 'pause_fail', currentTime, fromUsername, latency, correlationId });
        if (fromClientId) sendDiagApplyResult(fromClientId, 'pause', ok, latency, correlationId);
      }, 600);
    };
    const runWhenReady = () => {
      if (document.hidden) {
        diag.extensionOps.remoteApplyDeferredTabHidden++;
        let done = false;
        const run = () => { if (done) return; done = true; doApply(); };
        const onVisible = () => { document.removeEventListener('visibilitychange', onVisible); clearTimeout(tid); run(); };
        document.addEventListener('visibilitychange', onVisible);
        const tid = setTimeout(() => { document.removeEventListener('visibilitychange', onVisible); run(); }, 5000);
      } else {
        doApply();
      }
    };
    setTimeout(runWhenReady, delay);
    if (roomState?.isHost) stopHostPositionHeartbeat();
    stopViewerSyncInterval();
    diagLog('PAUSE', { currentTime, fromUsername, source: 'remote' });
  }

  function applySeek(currentTime, fromUsername, fromClientId, lastRtt, correlationId, serverTime, remoteOpts) {
    if (!video || isVideoStale(video)) return;
    const gate = getRemoteApplySyncGate(remoteOpts);
    if (!gate.ok) {
      if (gate.reason === 'sync_lock') diag.extensionOps.remoteApplyDeniedSyncLock++;
      else if (gate.reason === 'playback_debounce') {
        diag.extensionOps.remoteApplyDeniedPlaybackDebounce++;
        if (!remoteOpts?.bypassPlaybackDebounce) {
          scheduleDebouncedRemotePlaybackRetry(() => {
            applySeek(currentTime, fromUsername, fromClientId, lastRtt, correlationId, serverTime, {
              bypassPlaybackDebounce: true
            });
          });
        }
      }
      return;
    }
    if (localAdBreakActive) {
      diag.extensionOps.remoteApplyIgnoredLocalAd++;
      diagLog('SEEK', { currentTime, fromUsername, source: 'remote', skipped: true, reason: 'local_ad' });
      return;
    }
    const recvAt = Date.now();
    if (typeof lastRtt === 'number' && lastRtt > 0) {
      diag.timing.lastRttMs = lastRtt;
      diag.timing.lastRttSource = 'playback';
    }
    pushDiagTimeline(diag.timing.timeline, { kind: 'seek_recv', correlationId: correlationId || null, currentTime, serverTime, recvAt, rttMs: lastRtt });
    syncDiagRecord({ type: 'seek_recv', currentTime, fromUsername, drift: Math.abs(video.currentTime - currentTime), correlationId });
    if (!roomState?.isHost) {
      ingestHostAuthoritativeSync(currentTime, lastAppliedState.playing, recvAt);
    }
    if (adHoldBlocksRemotePlayback()) {
      diag.extensionOps.remoteSeekHeldForAd++;
      diagLog('SEEK', { currentTime, fromUsername, source: 'remote', adHold: true });
      return;
    }
    clearRemotePlaybackDebouncedQueue();
    lastAppliedState = { ...lastAppliedState, currentTime };
    lastSyncAt = Date.now();
    lastSentTime = currentTime;
    lastPlaybackOutboundKind = 'SEEK';
    const driftBefore = Math.abs(video.currentTime - currentTime);

    if (playbackProfile.drmPassive && !roomState?.isHost) {
      if (driftBefore <= playbackProfile.drmDesyncThresholdSec) {
        diag.extensionOps.drmSeekSkippedUnderThreshold++;
        platformPlaybackLog('DRM_SEEK_SKIPPED', { driftSec: driftBefore, threshold: playbackProfile.drmDesyncThresholdSec });
        syncDiagRecord({ type: 'seek_ok', currentTime, fromUsername, latency: 0, correlationId, note: 'drm_skip_small_drift' });
        diagLog('SEEK', { currentTime, fromUsername, source: 'remote', drmPassive: true, skipped: true });
        return;
      }
      diag.extensionOps.drmSyncPromptsShown++;
      const wantPlaying = lastAppliedState.playing;
      platformPlaybackLog('DRM_SYNC_OFFER', { kind: 'remote_seek', currentTime, driftBefore, fromUsername });
      drmSyncPrompt.offer({
        headline: 'Sync to host?',
        detail: `${fromUsername || 'Host'} jumped ~${driftBefore.toFixed(1)}s. Tap once to seek — avoids DRM playback errors.`,
        minIntervalMs: 6000,
        onConfirm: () => {
          diag.extensionOps.drmSyncConfirmed++;
          const v = findVideo() || video;
          if (!v || isVideoStale(v)) return;
          syncLock = true;
          applyDrmViewerOneShot(v, currentTime, wantPlaying);
          postSidebar({ type: 'SYNC_QUALITY', drift: driftBefore });
          setTimeout(() => { syncLock = false; }, 600);
        }
      });
      diagLog('SEEK', { currentTime, fromUsername, source: 'remote', drmPassive: true });
      return;
    }

    syncLock = true;
    const delay = getApplyDelayMs(lastRtt, playbackProfile);
    const doApply = () => {
      if (isVideoStale(video)) { syncLock = false; return; }
      const v = findVideo() || video;
      if (v) {
        armPlaybackEchoSuppress();
        safeVideoOp(() => { v.currentTime = currentTime; });
        lastTimeUpdatePos = currentTime;  // avoid false jump from onVideoTimeUpdate
      }
      postSidebar({ type: 'SYNC_QUALITY', drift: driftBefore });
      setTimeout(() => { syncLock = false; }, 500);
      setTimeout(() => {
        const v2 = findVideo() || video;
        const ok = v2 && Math.abs(v2.currentTime - currentTime) < 1;
        const latency = Date.now() - recvAt;
        const driftAfter = v2 ? Math.abs(v2.currentTime - currentTime) : null;
        if (driftAfter != null) updateDriftEwm(diag.timing, driftAfter);
        pushDiagTimeline(diag.timing.timeline, {
          kind: ok ? 'seek_apply_ok' : 'seek_apply_fail',
          correlationId: correlationId || null,
          driftSec: driftAfter,
          latencyMs: latency
        });
        syncDiagRecord({ type: ok ? 'seek_ok' : 'seek_fail', currentTime, fromUsername, latency, correlationId });
        if (fromClientId) sendDiagApplyResult(fromClientId, 'seek', ok, latency, correlationId);
      }, 400);
    };
    const runWhenReady = () => {
      if (document.hidden) {
        diag.extensionOps.remoteApplyDeferredTabHidden++;
        let done = false;
        const run = () => { if (done) return; done = true; doApply(); };
        const onVisible = () => { document.removeEventListener('visibilitychange', onVisible); clearTimeout(tid); run(); };
        document.addEventListener('visibilitychange', onVisible);
        const tid = setTimeout(() => { document.removeEventListener('visibilitychange', onVisible); run(); }, 5000);
      } else {
        doApply();
      }
    };
    setTimeout(runWhenReady, delay);
    diagLog('SEEK', { currentTime, fromUsername, source: 'remote' });
  }

  /** True if this SYSTEM_MSG describes our own playback action (we already showed a local toast). */
  function isOwnPlaybackSystemMsg(text) {
    const u = roomState?.username;
    if (!u || !text) return false;
    return text === `▶ ${u} pressed play` ||
      text === `⏸ ${u} paused` ||
      text.startsWith(`⏩ ${u} seeked to `) ||
      text.startsWith(`📺 ${u}`) ||
      text.startsWith(`✓ ${u}'s ad break ended`);
  }

  function applySyncState(state) {
    if (!state) return;
    if (localAdBreakActive) {
      diag.extensionOps.syncStateIgnoredLocalAd++;
      return;
    }
    const refMs = state.sentAt != null ? state.sentAt : state.computedAt;
    const viewerSyncBaseTime = Date.now();
    const lrSync =
      typeof diag.timing.lastRttMs === 'number' && diag.timing.lastRttMs > 0
        ? diag.timing.lastRttMs
        : null;
    let targetTime = state.currentTime;
    if (state.playing) {
      if (lrSync != null) {
        targetTime = state.currentTime + (lrSync / 2) / 1000;
      } else if (refMs != null) {
        targetTime = state.currentTime + (viewerSyncBaseTime - refMs) / 1000;
      }
    }
    if (!roomState?.isHost) {
      ingestHostAuthoritativeSync(targetTime, !!state.playing, viewerSyncBaseTime);
    }
    if (adHoldBlocksRemotePlayback() && state.playing) {
      diag.extensionOps.syncStateHeldForAd++;
      return;
    }
    if (!video || isVideoStale(video)) {
      if (!roomState?.isHost) {
        pendingSyncState = state;
        diag.extensionOps.syncStateDeferredStaleOrMissing++;
        syncPendingSyncStateDiagFlag();
      }
      return;
    }
    const syncGate = getRemoteApplySyncGate();
    if (!syncGate.ok) {
      if (syncGate.reason === 'sync_lock') diag.extensionOps.syncStateDeniedSyncLock++;
      else if (syncGate.reason === 'playback_debounce') diag.extensionOps.syncStateDeniedPlaybackDebounce++;
      return;
    }
    lastAppliedState = { currentTime: targetTime, playing: !!state.playing };
    lastSentTime = targetTime;  // prevent echo when seek/play fires after apply
    lastPlaybackOutboundKind = state.playing ? 'PLAY' : 'PAUSE';
    lastLocalWirePlayingSent = !!state.playing;
    if (roomState?.isHost && state.playing) {
      hostTimeupdateSeekSuppressUntil = Date.now() + playbackProfile.hostSeekSuppressAfterPlayMs;
    }
    lastSyncAt = Date.now();
    const threshold = getSyncThreshold();
    const driftBefore = Math.abs(video.currentTime - targetTime);
    const localPlaying = !video.paused;
    const playMismatch = state.playing !== localPlaying;

    if (playbackProfile.drmPassive && !roomState?.isHost) {
      if (!playMismatch && driftBefore <= threshold) {
        if (state.playing) startViewerSyncInterval();
        else stopViewerSyncInterval();
        updateDriftEwm(diag.timing, driftBefore);
        pushDiagTimeline(diag.timing.timeline, {
          kind: 'sync_state_passive_ok',
          computedAt: state.computedAt ?? null,
          sentAt: state.sentAt ?? null,
          targetTime,
          playing: !!state.playing,
          driftBefore
        });
        postSidebar({ type: 'SYNC_QUALITY', drift: driftBefore });
        diagLog('SYNC_STATE', { playing: state.playing, currentTime: targetTime, computedAt: state.computedAt, sentAt: state.sentAt, drmPassive: true, note: 'within_threshold' });
        diag.extensionOps.syncStateApplied++;
        return;
      }
      diag.extensionOps.drmSyncPromptsShown++;
      platformPlaybackLog('DRM_SYNC_OFFER', { kind: 'sync_state', driftBefore, playMismatch });
      drmSyncPrompt.offer({
        headline: 'Sync to host?',
        detail: playMismatch
          ? 'Play/pause does not match the room. Tap once to align (avoids DRM errors).'
          : `About ${driftBefore.toFixed(1)}s off.`,
        minIntervalMs: 8000,
        onConfirm: () => {
          diag.extensionOps.drmSyncConfirmed++;
          const v = findVideo() || video;
          if (!v || isVideoStale(v)) return;
          const applyNow = Date.now();
          const applyTarget = state.playing
            ? targetTime + (applyNow - viewerSyncBaseTime) / 1000
            : state.currentTime;
          syncLock = true;
          applyDrmViewerOneShot(v, applyTarget, !!state.playing);
          lastAppliedState = { currentTime: applyTarget, playing: !!state.playing };
          lastLocalWirePlayingSent = !!state.playing;
          if (state.playing) startViewerSyncInterval();
          else stopViewerSyncInterval();
          const postDrift = Math.abs(v.currentTime - applyTarget);
          updateDriftEwm(diag.timing, postDrift);
          pushDiagTimeline(diag.timing.timeline, {
            kind: 'sync_state_applied',
            computedAt: state.computedAt ?? null,
            sentAt: state.sentAt ?? null,
            applyTarget,
            playing: !!state.playing,
            driftBefore,
            postDrift,
            drmUserConfirm: true
          });
          postSidebar({ type: 'SYNC_QUALITY', drift: driftBefore });
          diagLog('SYNC_STATE', { playing: state.playing, currentTime: applyTarget, computedAt: state.computedAt, sentAt: state.sentAt, drmUserConfirm: true });
          diag.extensionOps.syncStateApplied++;
          setTimeout(() => { syncLock = false; }, 700);
        }
      });
      diagLog('SYNC_STATE', { playing: state.playing, currentTime: targetTime, computedAt: state.computedAt, sentAt: state.sentAt, drmPassive: true, offered: true });
      return;
    }

    syncLock = true;
    const delay = playbackProfile.syncStateApplyDelayMs;
    setTimeout(() => {
      if (isVideoStale(video)) { syncLock = false; return; }
      const v = findVideo() || video;
      if (!v) { syncLock = false; return; }
      armPlaybackEchoSuppress();
      const applyNow = Date.now();
      const applyTarget = state.playing
        ? targetTime + (applyNow - viewerSyncBaseTime) / 1000
        : state.currentTime;
      safeVideoOp(() => {
        const diff = Math.abs(v.currentTime - applyTarget);
        if (diff > threshold) { v.currentTime = applyTarget; lastTimeUpdatePos = applyTarget; }
        lastAppliedState = { currentTime: applyTarget, playing: !!state.playing };
        lastLocalWirePlayingSent = !!state.playing;
        if (state.playing && v.paused) {
          forcePlay(v, playbackProfile.aggressiveRemoteSync);
          if (roomState?.isHost) startHostPositionHeartbeat();
          else startViewerSyncInterval();
        } else if (!state.playing && !v.paused) {
          forcePause(v, playbackProfile.aggressiveRemoteSync);
          if (roomState?.isHost) stopHostPositionHeartbeat();
          stopViewerSyncInterval();
        }
      });
      const postDrift = Math.abs(v.currentTime - applyTarget);
      updateDriftEwm(diag.timing, postDrift);
      pushDiagTimeline(diag.timing.timeline, {
        kind: 'sync_state_applied',
        computedAt: state.computedAt ?? null,
        sentAt: state.sentAt ?? null,
        applyTarget,
        playing: !!state.playing,
        driftBefore,
        postDrift
      });
      postSidebar({ type: 'SYNC_QUALITY', drift: driftBefore });
      diagLog('SYNC_STATE', { playing: state.playing, currentTime: applyTarget, computedAt: state.computedAt, sentAt: state.sentAt });
      diag.extensionOps.syncStateApplied++;
      setTimeout(() => { syncLock = false; }, 600);
    }, delay);
  }

  // ── Background messaging ───────────────────────────────────────────────────
  function sendBg(msg) {
    try {
      if (msg && msg.source === 'playshare') {
        if (msg.type === 'SYNC_REQUEST') diag.extensionOps.viewerSyncRequestSent++;
        else if (msg.type === 'PLAYBACK_POSITION') diag.extensionOps.hostPlaybackPositionSent++;
        else if (msg.type === 'POSITION_REPORT') diag.extensionOps.positionReportSent++;
      }
      chrome.runtime.sendMessage(msg, () => {
        const le = chrome.runtime.lastError;
        if (le) {
          diag.messaging.runtimeSendFailures++;
          diag.messaging.runtimeLastErrorAt = Date.now();
          diag.messaging.runtimeLastErrorMessage = le.message || 'unknown';
          scheduleDiagUpdate();
        }
      });
    } catch {
      diag.messaging.sendThrowCount++;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.source !== 'playshare-bg') return;

    switch (msg.type) {
      case 'ROOM_CREATED':
      case 'ROOM_JOINED': {
        const reconnectResync = !!msg.reconnectResync;
        roomState = { ...msg };
        delete roomState.reconnectResync;
        diag.connectionStatus = 'connected';
        if (diag.reportSession.roomCode !== msg.roomCode) {
          diag.reportSession = { startedAt: Date.now(), roomCode: msg.roomCode };
        }
        recordMemberChronology('room_session', {
          roomCode: msg.roomCode,
          memberCount: (msg.members || []).length,
          isHost: !!msg.isHost
        });
        diagLog('ROOM_JOINED', { roomCode: msg.roomCode, members: (msg.members || []).length });
        if (msg.isHost && video && !isVideoStale(video)) {
          roomState.videoUrl = location.href;
          sendBg({ source: 'playshare', type: 'SET_ROOM_VIDEO_URL', videoUrl: location.href });
        }

        const finalizeRoomJoined = () => {
          lastLocalPlaybackWireAt = 0;
          lastLocalWirePlayingSent = null;
          clearPlaybackOutboundCoalesce();
          clearRemotePlaybackDebouncedQueue();
          showSidebarToggle();
          openSidebar();
          // Sync joiner to host's playback position (apply now if video ready, else when it attaches)
          if (msg.state && !msg.isHost) {
            if (video) applySyncState(msg.state);
            else {
              pendingSyncState = msg.state;
              diag.extensionOps.syncStateDeferredNoVideo++;
              syncPendingSyncStateDiagFlag();
            }
          }
          const syncDelay = playbackProfile.syncRequestDelayMs;
          if (reconnectResync) {
            if (msg.isHost && video && !isVideoStale(video)) {
              setTimeout(() => {
                sendBg({ source: 'playshare', type: 'PLAYBACK_POSITION', currentTime: video.currentTime });
              }, Math.min(syncDelay, 120));
            } else if (!msg.isHost) {
              setTimeout(() => sendBg({ source: 'playshare', type: 'SYNC_REQUEST' }), syncDelay);
            }
          } else {
            setTimeout(() => sendBg({ source: 'playshare', type: 'SYNC_REQUEST' }), syncDelay);
          }
          postSidebarRoomState();
          showToast(`🎬 Joined room ${msg.roomCode}`);
          if (video) startPositionReportInterval();
          if (msg.isHost) stopViewerReconcileLoop();
          else startViewerReconcileLoop();
          seedActiveAdBreaksFromJoin(msg);
          if (video) startAdBreakMonitorIfNeeded();
        };

        if (msg.isHost) {
          chrome.storage.local.get(['playshareCountdownOnPlay'], (r) => {
            if (
              roomState &&
              roomState.roomCode === msg.roomCode &&
              typeof r.playshareCountdownOnPlay === 'boolean'
            ) {
              roomState.countdownOnPlay = r.playshareCountdownOnPlay;
              sendBg({
                source: 'playshare',
                type: 'UPDATE_COUNTDOWN_ON_PLAY',
                value: roomState.countdownOnPlay
              });
            }
            finalizeRoomJoined();
          });
        } else {
          finalizeRoomJoined();
        }
        break;
      }

      case 'ROOM_LEFT': {
        stopPeerRecordingSampleLoop();
        const leavingCollectorId = roomState?.clientId;
        if (diagnosticsUiEnabled && leavingCollectorId && getVideoProfiler().isRecording()) {
          try {
            sendBg({
              source: 'playshare',
              type: 'DIAG_PROFILER_COLLECTION',
              active: false,
              collectorClientId: leavingCollectorId
            });
          } catch {
            /* ignore */
          }
        }
        diag.profilerPeerCollection.remoteCollectorClientId = null;
        roomState = null;
        suppressPlaybackEchoUntil = 0;
        clearPlaybackOutboundCoalesce();
        clearRemotePlaybackDebouncedQueue();
        lastLocalPlaybackWireAt = 0;
        lastLocalWirePlayingSent = null;
        peersInAdBreak.clear();
        localAdBreakActive = false;
        stopAdBreakMonitor();
        pendingSyncState = null;
        syncPendingSyncStateDiagFlag();
        hostAuthoritativeRef = null;
        diag.reportSession = { startedAt: null, roomCode: null };
        stopHostPositionHeartbeat();
        stopViewerSyncInterval();
        stopViewerReconcileLoop();
        stopPositionReportInterval();
        diag.clusterSync = null;
        lastClusterSidebarKey = null;
        hideClusterSyncBadge();
        diagLog('ROOM_LEFT', {});
        hideSidebarToggle();
        closeSidebar();
        break;
      }

      case 'MEMBER_JOINED':
        recordMemberChronology('member_joined', { username: msg.username, clientIdShort: msg.clientId ? String(msg.clientId).slice(0, 8) + '…' : null });
        diagLog('MEMBER_JOINED', { username: msg.username });
        if (roomState && Array.isArray(msg.members)) roomState.members = msg.members;
        postSidebar({ type: 'MEMBER_JOINED', data: msg });
        showToast(`👋 ${msg.username} joined`);
        if (diagnosticsUiEnabled && getVideoProfiler().isRecording()) {
          broadcastProfilerCollectionState(true);
        }
        break;

      case 'MEMBER_LEFT':
        recordMemberChronology('member_left', { username: msg.username });
        diagLog('MEMBER_LEFT', { username: msg.username });
        if (msg.clientId) ingestPeerAdBreakEnd(msg.clientId);
        if (roomState && Array.isArray(msg.members)) roomState.members = msg.members;
        if (roomState && msg.newHostId) {
          roomState.isHost = roomState.clientId === msg.newHostId;
          postSidebarRoomState();
          if (roomState.isHost) {
            stopViewerReconcileLoop();
            if (video && !video.paused) startHostPositionHeartbeat();
          } else {
            startViewerReconcileLoop();
          }
        }
        postSidebar({ type: 'MEMBER_LEFT', data: msg });
        showToast(`👋 ${msg.username} left`);
        if (msg.clientId && diag.profilerPeerCollection.remoteCollectorClientId === msg.clientId) {
          diag.profilerPeerCollection.remoteCollectorClientId = null;
          stopPeerRecordingSampleLoop();
        }
        break;

      case 'PLAY':
        applyPlay(msg.currentTime, msg.fromUsername, msg.fromClientId, msg.sentAt, msg.lastRtt, msg.correlationId, msg.serverTime);
        break;

      case 'PAUSE':
        applyPause(msg.currentTime, msg.fromUsername, msg.fromClientId, msg.lastRtt, msg.correlationId, msg.serverTime, msg.sentAt);
        break;

      case 'sync':
        if (
          roomState &&
          !roomState.isHost &&
          !localAdBreakActive &&
          typeof msg.currentTime === 'number' &&
          Number.isFinite(msg.currentTime) &&
          (msg.state === 'playing' || msg.state === 'paused')
        ) {
          const syncIngestAt = Date.now();
          let syncPos = msg.currentTime;
          if (msg.state === 'playing') {
            const lr = diag.timing.lastRttMs;
            if (typeof lr === 'number' && lr > 0) {
              syncPos = msg.currentTime + (lr / 2) / 1000;
            }
          }
          ingestHostAuthoritativeSync(syncPos, msg.state === 'playing', syncIngestAt);
        }
        break;

      case 'AD_BREAK_START':
        if (msg.fromClientId && roomState) {
          ingestPeerAdBreakStart(msg.fromClientId, msg.fromUsername);
        }
        break;

      case 'AD_BREAK_END':
        if (msg.fromClientId) ingestPeerAdBreakEnd(msg.fromClientId);
        break;

      case 'SEEK':
        applySeek(msg.currentTime, msg.fromUsername, msg.fromClientId, msg.lastRtt, msg.correlationId, msg.serverTime);
        break;

      case 'SYNC_STATE':
        diag.extensionOps.syncStateInbound++;
        if (video) applySyncState(msg.state);
        else if (!roomState?.isHost) {
          pendingSyncState = msg.state;
          diag.extensionOps.syncStateDeferredNoVideo++;
          syncPendingSyncStateDiagFlag();
        }
        break;

      case 'CHAT':
        diag.extensionOps.chatReceived++;
        diagLog('CHAT', { from: msg.username, text: (msg.text || '').slice(0, 40) });
        postSidebar({ type: 'CHAT', data: msg });
        break;

      case 'REACTION':
        showFloatingReaction(msg.emoji, msg.color);
        break;

      case 'SYSTEM_MSG':
        diag.extensionOps.systemMsgsReceived++;
        if (msg.text) {
          postSidebar({ type: 'SYSTEM_MSG', text: msg.text });
          if (!isOwnPlaybackSystemMsg(msg.text)) showToast(msg.text);
          else diag.extensionOps.playbackSystemMsgsDeduped++;
        }
        break;

      case 'COUNTDOWN_START':
        if (msg.fromClientId !== roomState?.clientId) {
          diag.extensionOps.countdownStartRemote++;
          postSidebar({ type: 'COUNTDOWN_START', fromUsername: msg.fromUsername });
        }
        if (!roomState?.isHost) showCountdownOverlay(false);
        break;

      case 'DIAG_SYNC_APPLY_RESULT': {
        if (msg.targetClientId === roomState?.clientId) {
          const s = diag.sync;
          s.remoteApplyResults.unshift({
            t: Date.now(),
            fromClientId: msg.fromClientId,
            fromUsername: msg.fromUsername,
            eventType: msg.eventType,
            success: msg.success,
            latency: msg.latency,
            correlationId: msg.correlationId,
            platform: msg.platformName || msg.platform
          });
          s.remoteApplyResults.length = Math.min(s.remoteApplyResults.length, s.maxRemoteResults);
        }
        break;
      }

      case 'DIAG_ROOM_TRACE': {
        if (msg.entries && Array.isArray(msg.entries)) {
          diag.serverRoomTrace = msg.entries.slice(-40);
          diag.serverRoomTraceAt = Date.now();
          scheduleDiagUpdate();
        }
        break;
      }

      case 'POSITION_SNAPSHOT':
        ingestPositionSnapshot(msg);
        break;

      case 'DIAG_SYNC_REPORT': {
        if (msg.clientId && msg.clientId !== roomState?.clientId) {
          diag.sync.peerReports[msg.clientId] = {
            username: msg.username,
            isHost: msg.isHost,
            platform: msg.platformName || msg.platform,
            metrics: msg.metrics || {},
            videoAttached: msg.videoAttached,
            lastReceived: Date.now(),
            devDiag:
              msg.devDiag && typeof msg.devDiag === 'object'
                ? /** @type {Record<string, unknown>} */ (msg.devDiag)
                : null
          };
        }
        break;
      }

      case 'DIAG_PROFILER_COLLECTION': {
        if (!diagnosticsUiEnabled || !roomState) break;
        const coll = msg.collectorClientId;
        if (!coll) break;
        if (coll === roomState.clientId) {
          stopPeerRecordingSampleLoop();
          diag.profilerPeerCollection.remoteCollectorClientId = null;
          break;
        }
        if (msg.active) {
          diag.profilerPeerCollection.remoteCollectorClientId = coll;
          startPeerRecordingSampleLoop();
        } else if (diag.profilerPeerCollection.remoteCollectorClientId === coll) {
          diag.profilerPeerCollection.remoteCollectorClientId = null;
          stopPeerRecordingSampleLoop();
        }
        scheduleDiagUpdate();
        break;
      }

      case 'DIAG_PEER_RECORDING_SAMPLE':
        ingestPeerRecordingSample(/** @type {Record<string, unknown>} */ (msg));
        break;

      case 'TYPING_START':
      case 'TYPING_STOP':
        postSidebar({ type: msg.type, username: msg.username });
        break;

      case 'TOGGLE_SIDEBAR':
        diag.sidebar.toggleReceived++;
        diag.sidebar.lastToggleAt = Date.now();
        diagLog('TOGGLE_SIDEBAR', { count: diag.sidebar.toggleReceived });
        toggleSidebar();
        break;

      case 'SETTINGS_CHANGED':
        applySidebarLayout();
        break;

      case 'WS_STATUS': {
        if (prevBgWsOpen === true && !msg.open) diag.extensionOps.wsDisconnectEvents++;
        prevBgWsOpen = !!msg.open;
        diag.connectionStatus = msg.open ? 'connected' : 'disconnected';
        if (typeof msg.connectionMessage === 'string') diag.connectionMessage = msg.connectionMessage;
        if (typeof msg.transportPhase === 'string') diag.transportPhase = msg.transportPhase;
        postSidebar({
          type: 'EXTENSION_WS',
          open: !!msg.open,
          connectionMessage: msg.connectionMessage,
          transportPhase: msg.transportPhase
        });
        if (msg.transportPhase === 'unreachable') showToast('Server unavailable');
        break;
      }

      case 'ERROR':
        diag.extensionOps.serverErrors++;
        diagLog('ERROR', { message: msg.message || msg.code || 'Unknown error' });
        showToast(userVisibleServerErrorLine(msg));
        break;
    }
  });

  // ── Sidebar iframe ─────────────────────────────────────────────────────────
  function getSidebarWidth() {
    return sidebarCompact ? SIDEBAR_WIDTH.compact : SIDEBAR_WIDTH.full;
  }

  function applySidebarLayout() {
    const w = getSidebarWidth();
    const isRight = sidebarPosition === 'right';
    if (!sidebarFrame || !sidebarToggleBtn) return;

    const side = isRight ? 'right' : 'left';
    const opposite = isRight ? 'left' : 'right';

    sidebarFrame.style.width = w + 'px';
    sidebarFrame.style[side] = sidebarVisible ? '0' : '-' + w + 'px';
    sidebarFrame.style[opposite] = 'auto';
    sidebarFrame.style.transition = side + ' 0.35s cubic-bezier(0.4,0,0.2,1)';
    sidebarFrame.style.boxShadow = isRight ? '-8px 0 32px rgba(0,0,0,0.5)' : '8px 0 32px rgba(0,0,0,0.5)';

    sidebarToggleBtn.style[side] = '0';
    sidebarToggleBtn.style[opposite] = 'auto';
    sidebarToggleBtn.style.borderRadius = isRight ? '12px 0 0 12px' : '0 12px 12px 0';
    sidebarToggleBtn.style.boxShadow = isRight ? '-4px 0 20px rgba(0,0,0,0.4)' : '4px 0 20px rgba(0,0,0,0.4)';

    // Never modify page layout — sidebar overlays only (avoids breaking video player)
    document.documentElement.style.marginRight = '';
    document.documentElement.style.marginLeft = '';

    postSidebar({ type: 'SETTINGS', compact: true });
  }

  function injectSidebar() {
    if (sidebarFrame) return;

    // Toggle button
    sidebarToggleBtn = document.createElement('div');
    sidebarToggleBtn.id = 'ws-toggle-btn';
    const _brandMark = chrome.runtime.getURL('shared/brand-mark.png');
    sidebarToggleBtn.innerHTML = `
      <img src="${_brandMark}" width="26" height="26" alt="" role="presentation" draggable="false"
        style="display:block;object-fit:contain;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.45));" />
      <span id="ws-unread-badge" style="display:none">0</span>
    `;
    const isRight = sidebarPosition === 'right';
    const side = isRight ? 'right' : 'left';
    const borderRadius = isRight ? '12px 0 0 12px' : '0 12px 12px 0';
    sidebarToggleBtn.style.cssText = `
      position:fixed;${side}:0;top:50%;transform:translateY(-50%);
      width:48px;height:48px;background:linear-gradient(135deg,#E50914 0%,#c40812 100%);
      border-radius:${borderRadius};display:none;align-items:center;justify-content:center;
      cursor:pointer;z-index:2147483646;
      box-shadow:${isRight ? '-4px 0 20px' : '4px 0 20px'} rgba(0,0,0,0.4);
      transition:all 0.25s cubic-bezier(0.4,0,0.2,1);contain:layout style paint;
    `;
    sidebarToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleSidebar();
    });
    document.body.appendChild(sidebarToggleBtn);

    // Sidebar iframe
    const w = getSidebarWidth();
    sidebarFrame = document.createElement('iframe');
    sidebarIframeReady = false;
    sidebarPendingPost.length = 0;
    sidebarFrame.id = 'ws-sidebar-frame';
    sidebarFrame.src = chrome.runtime.getURL('sidebar/sidebar.html');
    sidebarFrame.style.cssText = `
      position:fixed;${side}:-${w}px;top:0;width:${w}px;height:100vh;
      border:none;z-index:2147483645;
      box-shadow:${isRight ? '-8px 0 32px' : '8px 0 32px'} rgba(0,0,0,0.5);
      transition:${side} 0.35s cubic-bezier(0.4,0,0.2,1);
      background:#0a0a0a;contain:layout style paint;
    `;
    document.body.appendChild(sidebarFrame);
    reparentPlayShareUiForFullscreen();
    diag.sidebar.frameExists = true;
    diag.sidebar.toggleBtnExists = true;
    diagLog('SIDEBAR_INJECT', {});

    // Listen for messages from sidebar iframe
    window.addEventListener('message', (e) => {
      if (e.data && e.data.source === 'playshare-sidebar') {
        handleSidebarMessage(e.data);
      }
    });
  }

  function handleSidebarMessage(msg) {
    switch (msg.type) {
      case 'CHAT':
        sendBg({ source: 'playshare', type: 'CHAT', text: msg.text });
        break;
      case 'TYPING_START':
      case 'TYPING_STOP':
        sendBg({ source: 'playshare', type: msg.type });
        break;
      case 'REACTION':
        sendBg({ source: 'playshare', type: 'REACTION', emoji: msg.emoji });
        showFloatingReaction(msg.emoji, roomState ? roomState.color : '#4ECDC4');
        break;
      case 'CLOSE_SIDEBAR':
        closeSidebar();
        break;
      case 'SET_COUNTDOWN_ON_PLAY':
        if (!roomState?.isHost) break;
        roomState.countdownOnPlay = !!msg.value;
        chrome.storage.local.set({ playshareCountdownOnPlay: roomState.countdownOnPlay });
        sendBg({ source: 'playshare', type: 'UPDATE_COUNTDOWN_ON_PLAY', value: roomState.countdownOnPlay });
        postSidebarRoomState();
        break;
      case 'AD_BREAK_MANUAL_START':
        if (!roomState || localAdBreakActive) break;
        localAdBreakActive = true;
        sendBg({ source: 'playshare', type: 'AD_BREAK_START' });
        syncAdBreakSidebar();
        break;
      case 'AD_BREAK_MANUAL_END':
        if (!roomState || !localAdBreakActive) break;
        localAdBreakActive = false;
        sendBg({ source: 'playshare', type: 'AD_BREAK_END' });
        stopAdBreakMonitor();
        startAdBreakMonitorIfNeeded();
        syncAdBreakSidebar();
        break;
      case 'COPY_INVITE_LINK':
        chrome.runtime.sendMessage({ source: 'playshare', type: 'GET_ROOM_LINK_DATA' }, (linkData) => {
          if (chrome.runtime.lastError) {
            showToast('Could not build invite link');
            return;
          }
          if (!linkData?.roomCode) {
            showToast('Join a room first');
            return;
          }
          const serverUrl = linkData.serverUrl;
          const httpBase = wsUrlToHttpBase(serverUrl);
          let httpJoinUrl = httpBase ? `${httpBase}/join?code=${linkData.roomCode}` : null;
          if (httpJoinUrl && linkData.videoUrl) httpJoinUrl += '&url=' + encodeURIComponent(linkData.videoUrl);
          const textToCopy = httpJoinUrl || linkData.roomCode;
          navigator.clipboard.writeText(textToCopy).then(() => {
            showToast(
              linkData.videoUrl
                ? 'Invite copied — opens video + room'
                : 'Invite copied — open a video page for one-tap join'
            );
          }).catch(() => {
            showToast('Could not copy to clipboard');
          });
        });
        break;
      case 'READY':
        markSidebarIframeReady();
        postSidebar({ type: 'SETTINGS', compact: true });
        chrome.runtime.sendMessage({ source: 'playshare', type: 'GET_DIAG' }, (res) => {
          mergeServiceWorkerDiag(res);
          postSidebar({
            type: 'EXTENSION_WS',
            open: !!(res && res.open),
            connectionMessage: res && res.connectionMessage,
            transportPhase: res && res.transportPhase
          });
          if (roomState) postSidebarRoomState();
        });
        break;
    }
  }

  function flushSidebarPendingPosts() {
    if (!sidebarFrame || !sidebarIframeReady) return;
    const win = sidebarFrame.contentWindow;
    if (!win) return;
    while (sidebarPendingPost.length > 0) {
      const msg = sidebarPendingPost.shift();
      try {
        win.postMessage({ source: 'playshare-content', ...msg }, '*');
      } catch {
        sidebarPendingPost.unshift(msg);
        break;
      }
    }
  }

  function markSidebarIframeReady() {
    if (sidebarIframeReady) return;
    sidebarIframeReady = true;
    flushSidebarPendingPosts();
  }

  function postSidebar(msg) {
    if (!sidebarFrame) return;
    const tryPost = () => {
      try {
        sidebarFrame.contentWindow.postMessage({ source: 'playshare-content', ...msg }, '*');
        return true;
      } catch {
        return false;
      }
    };
    if (!sidebarIframeReady) {
      if (sidebarPendingPost.length >= SIDEBAR_POST_QUEUE_MAX) sidebarPendingPost.shift();
      sidebarPendingPost.push(msg);
      return;
    }
    if (!tryPost()) {
      if (sidebarPendingPost.length >= SIDEBAR_POST_QUEUE_MAX) sidebarPendingPost.shift();
      sidebarPendingPost.push(msg);
    }
  }

  /** Sidebar payload: room + whether invite link includes a watch URL (ghost vs filled CTA). */
  function postSidebarRoomState() {
    if (!roomState) return;
    const hasInviteVideo = !!(
      roomState.videoUrl ||
      (roomState.isHost && video && !isVideoStale(video))
    );
    postSidebar({
      type: 'ROOM_STATE',
      data: { ...roomState, inviteLinkHasVideo: hasInviteVideo }
    });
    syncAdBreakSidebar();
  }

  function seedActiveAdBreaksFromJoin(msg) {
    peersInAdBreak.clear();
    const ids = msg.activeAdBreaks;
    if (!Array.isArray(ids) || !roomState) return;
    const members = msg.members || [];
    for (const cid of ids) {
      if (cid === roomState.clientId) continue;
      const m = members.find((x) => x.clientId === cid);
      ingestPeerAdBreakStart(cid, m?.username || 'Someone');
    }
  }

  function openSidebar() {
    if (!sidebarFrame) injectSidebar();
    sidebarVisible = true;
    diagLog('SIDEBAR_OPEN', { hasFrame: !!sidebarFrame });
    applySidebarLayout();
  }

  function closeSidebar() {
    if (!sidebarFrame) return;
    sidebarVisible = false;
    diagLog('SIDEBAR_CLOSE', {});
    applySidebarLayout();
  }

  function toggleSidebar() {
    if (sidebarVisible) closeSidebar();
    else openSidebar();
  }

  function showSidebarToggle() {
    if (!sidebarToggleBtn) injectSidebar();
    sidebarToggleBtn.style.display = 'flex';
    diag.sidebar.toggleBtnVisible = true;
  }

  function hideSidebarToggle() {
    if (sidebarToggleBtn) sidebarToggleBtn.style.display = 'none';
    diag.sidebar.toggleBtnVisible = false;
  }

  // ── Toast notifications ────────────────────────────────────────────────────
  let toastContainer = null;

  function showToast(text) {
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'ws-toast-container';
      toastContainer.style.cssText = `
        position:fixed;bottom:100px;left:50%;transform:translateX(-50%);
        z-index:2147483647;display:flex;flex-direction:column;align-items:center;gap:8px;
        pointer-events:none;contain:layout style paint;
      `;
      document.body.appendChild(toastContainer);
      reparentPlayShareUiForFullscreen();
    }

    const toast = document.createElement('div');
    toast.style.cssText = `
      background:rgba(10,10,10,0.92);color:#f0f0f0;
      padding:10px 18px;border-radius:24px;font-size:14px;font-family:sans-serif;
      border:1px solid rgba(255,255,255,0.08);backdrop-filter:blur(12px);
      animation:wsFadeIn 0.3s cubic-bezier(0.4,0,0.2,1);white-space:nowrap;
    `;
    toast.textContent = text;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  // ── Floating reactions ─────────────────────────────────────────────────────
  function showFloatingReaction(emoji, color) {
    const padding = 60;
    const sidebarW = sidebarVisible ? getSidebarWidth() : 0;
    const isRight = sidebarPosition === 'right';
    // Spawn only in the video area (avoid sidebar overlay)
    const minLeft = isRight ? padding : sidebarW + padding;
    const maxLeft = isRight ? window.innerWidth - sidebarW - padding : window.innerWidth - padding;
    const left = minLeft + Math.random() * Math.max(0, maxLeft - minLeft);
    const bottom = padding + Math.random() * (window.innerHeight * 0.35);
    const duration = 7;
    const el = document.createElement('div');
    el.style.cssText = `
      position:fixed;left:${left}px;bottom:${bottom}px;
      font-size:${36 + Math.random() * 16}px;z-index:2147483640;pointer-events:none;
      filter:drop-shadow(0 4px 12px rgba(0,0,0,0.4));
      animation:wsFloatUp ${duration}s cubic-bezier(0.25,0.5,0.5,1) forwards;
    `;
    el.textContent = emoji;
    getFullscreenUiHost().appendChild(el);
    setTimeout(() => el.remove(), duration * 1000);
  }

  // ── Diagnostic overlay ────────────────────────────────────────────────────
  let diagOverlay = null;
  let diagPanel = null;
  let diagVisible = false;
  let diagDrag = { active: false, dx: 0, dy: 0 };
  /** Filled by prepareDiagnosticSnapshotForExport() so JSON/text exports are comparable. */
  let diagExportCaptureContext = null;
  /** Dev diagnostics floater; hoisted for fullscreen reparenting. */
  let diagToggleBtn = null;

  /** Reparent extension UI into the fullscreen subtree (chat, toggles, toasts, dev HUD, DRM prompt). */
  function reparentPlayShareUiForFullscreen() {
    const host = getFullscreenUiHost();
    /** @type {[HTMLElement, string][]} */
    const layers = [
      [sidebarFrame, '2147483645'],
      [sidebarToggleBtn, '2147483646'],
      [clusterSyncBadge, '2147483630'],
      [primeHudEl, '2147483642'],
      [diagToggleBtn, '2147483643'],
      [toastContainer, '2147483644'],
      [countdownOverlayEl, '2147483641'],
      [diagOverlay, '2147483647']
    ];
    for (const [el, z] of layers) {
      if (!el) continue;
      try {
        if (el.parentElement !== host) host.appendChild(el);
        el.style.zIndex = z;
      } catch {
        try {
          document.body.appendChild(el);
        } catch {
          /* ignore */
        }
      }
    }
    try {
      drmSyncPrompt.reparentIfVisible();
    } catch {
      /* ignore */
    }
  }

  function recordMemberChronology(kind, detail) {
    const s = diag.sync;
    const row = { t: Date.now(), kind, ...detail };
    s.memberTimeline.unshift(row);
    if (s.memberTimeline.length > s.maxMemberTimeline) s.memberTimeline.length = s.maxMemberTimeline;
  }

  function mergeServiceWorkerDiag(res) {
    if (!res) return;
    if (res.connectionStatus) diag.connectionStatus = res.connectionStatus;
    if (typeof res.connectionMessage === 'string') diag.connectionMessage = res.connectionMessage;
    if (typeof res.transportPhase === 'string') diag.transportPhase = res.transportPhase;
    if (typeof res.lastRttMs === 'number' && res.lastRttMs > 0) {
      diag.timing.lastRttMs = res.lastRttMs;
      diag.timing.lastRttSource = 'background_heartbeat';
    }
    if (res.transport && typeof res.transport === 'object') {
      diag.serviceWorkerTransport = { ...res.transport };
    }
  }

  /** Popup/sidebar-aligned copy for server ERROR frames (no video heuristics). */
  function userVisibleServerErrorLine(msg) {
    const code = msg && msg.code;
    if (code === 'ROOM_NOT_FOUND') return 'Server unavailable — that room may have ended.';
    if (code === 'RATE_LIMIT') return 'Too many messages — slow down.';
    if (code === 'MESSAGE_TOO_LARGE') return 'Message too large.';
    return (msg && msg.message) || 'Something went wrong.';
  }

  function flushDiagFromBackground() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ source: 'playshare', type: 'GET_DIAG' }, (res) => {
          mergeServiceWorkerDiag(res);
          resolve(true);
        });
      } catch {
        resolve(false);
      }
    });
  }

  /** Best-effort: fresh WS RTT + server ring before export (for analyst accuracy). */
  async function prepareDiagnosticSnapshotForExport() {
    await flushDiagFromBackground();
    diagExportCaptureContext = {
      preparedAt: Date.now(),
      tabVisibility: typeof document !== 'undefined' ? document.visibilityState : null,
      documentHasFocus: typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : null,
      overlayOpen: !!diagVisible,
      preExportTraceRequested: false
    };
    sendBg({ source: 'playshare', type: 'DIAG_ROOM_TRACE_REQUEST' });
    diagExportCaptureContext.preExportTraceRequested = true;
    await new Promise((r) => setTimeout(r, 480));
    captureVideoHealthSnapshot();
  }

  function formatDiagTime(ts) {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return sec + 's ago';
    return Math.floor(sec / 60) + 'm ago';
  }

  function formatDiagTimeAgo(ts) {
    const ms = Date.now() - ts;
    if (ms < 1000) return ms + 'ms ago';
    return (ms / 1000).toFixed(1) + 's ago';
  }

  function resetSyncMetrics() {
    const s = diag.sync;
    s.events = [];
    s.metrics = { playSent: 0, playRecv: 0, playOk: 0, playFail: 0, pauseSent: 0, pauseRecv: 0, pauseOk: 0, pauseFail: 0, seekSent: 0, seekRecv: 0, seekOk: 0, seekFail: 0 };
    s.remoteApplyResults = [];
    s.peerReports = {};
    s.testResults = null;
    diag.timing.timeline = [];
    diag.timing.driftEwmSec = 0;
    diag.timeupdateJumps = [];
    diag.serverRoomTrace = [];
    diag.serverRoomTraceAt = null;
    diag.timing.lastRttSource = null;
    s.testHistory = [];
    s.memberTimeline = [];
    diag.findVideo = { cacheReturns: 0, fullScans: 0, invalidations: 0, videoAttachCount: diag.findVideo.videoAttachCount };
    diag.extensionOps = {
      syncStateInbound: 0,
      syncStateApplied: 0,
      syncStateDeferredNoVideo: 0,
      syncStateDeferredStaleOrMissing: 0,
      syncStateDeniedSyncLock: 0,
      syncStateDeniedPlaybackDebounce: 0,
      remoteApplyDeniedSyncLock: 0,
      remoteApplyDeniedPlaybackDebounce: 0,
      remoteApplyDeferredTabHidden: 0,
      localControlBlockedHostOnly: 0,
      syncStateFlushedOnVideoAttach: 0,
      hostPlaybackPositionSent: 0,
      viewerSyncRequestSent: 0,
      countdownStartRemote: 0,
      serverErrors: 0,
      wsDisconnectEvents: 0,
      chatReceived: 0,
      systemMsgsReceived: 0,
      playbackSystemMsgsDeduped: 0,
      positionReportSent: 0,
      positionSnapshotInbound: 0,
      drmSyncPromptsShown: 0,
      drmSyncConfirmed: 0,
      drmSeekSkippedUnderThreshold: 0
    };
    diag.messaging = {
      runtimeSendFailures: 0,
      runtimeLastErrorAt: null,
      runtimeLastErrorMessage: null,
      sendThrowCount: 0
    };
    diag.videoBuffering = {
      waiting: 0,
      stalled: 0,
      lastWaitingAt: null,
      lastStalledAt: null
    };
    diag.serviceWorkerTransport = null;
    diag.clusterSync = null;
    lastClusterSidebarKey = null;
    hideClusterSyncBadge();
    syncPendingSyncStateDiagFlag();
    diagExportCaptureContext = null;
    diag.peerRecordingSamples.byClient = {};
    updateDiagnosticOverlay();
  }

  function waitForPeerApply(prevRemoteLen, timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const s = diag.sync.remoteApplyResults;
        if (s.length > prevRemoteLen) return resolve(s[0]);
        if (Date.now() - t0 >= timeoutMs) return resolve(null);
        setTimeout(tick, 90);
      };
      tick();
    });
  }

  /** @param {number} [soakRounds=1] Run the 4-step sequence this many times (soak). */
  async function runSyncTest(soakRounds) {
    if (!video || isVideoStale(video)) {
      diagLog('ERROR', { message: 'No video — load a video first' });
      return;
    }
    if (!roomState) {
      diagLog('ERROR', { message: 'No room — join a room first' });
      return;
    }
    const rounds = Math.max(1, Math.min(20, Number(soakRounds) > 0 ? Number(soakRounds) : 1));
    const s = diag.sync;
    if (s.testRunning) return;
    s.testRunning = true;
    s.testResults = { steps: [], start: Date.now(), soakRounds: rounds, peerTimeouts: 0 };
    const btn = diagPanel?.querySelector('#diagSyncTest');
    const btnSoak = diagPanel?.querySelector('#diagSyncTestSoak');
    if (btn) btn.disabled = true;
    if (btnSoak) btnSoak.disabled = true;
    const memberCount = (roomState.members || []).length;
    const expectPeer = memberCount > 1;
    const peerTimeoutMs = 3200;

    for (let r = 0; r < rounds; r++) {
      const v = findVideo() || video;
      const steps = [
        { name: 'Pause', fn: () => { safeVideoOp(() => v.pause()); lastPlaybackOutboundKind = 'PAUSE'; lastSentTime = v.currentTime; syncDiagRecord({ type: 'pause_sent', currentTime: v.currentTime }); sendBg({ source: 'playshare', type: 'PAUSE', currentTime: v.currentTime, sentAt: Date.now() }); } },
        { name: 'Seek +0.5s', fn: () => { safeVideoOp(() => { v.currentTime = Math.min(v.currentTime + 0.5, v.duration || 9999); }); lastPlaybackOutboundKind = 'SEEK'; lastSentTime = v.currentTime; syncDiagRecord({ type: 'seek_sent', currentTime: v.currentTime }); sendBg({ source: 'playshare', type: 'SEEK', currentTime: v.currentTime, sentAt: Date.now() }); } },
        { name: 'Play', fn: () => { safeVideoOp(() => v.play().catch(() => {})); lastPlaybackOutboundKind = 'PLAY'; lastSentTime = v.currentTime; syncDiagRecord({ type: 'play_sent', currentTime: v.currentTime }); sendBg({ source: 'playshare', type: 'PLAY', currentTime: v.currentTime, sentAt: Date.now() }); } },
        { name: 'Pause', fn: () => { safeVideoOp(() => v.pause()); lastPlaybackOutboundKind = 'PAUSE'; lastSentTime = v.currentTime; syncDiagRecord({ type: 'pause_sent', currentTime: v.currentTime }); sendBg({ source: 'playshare', type: 'PAUSE', currentTime: v.currentTime, sentAt: Date.now() }); } }
      ];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const prevRemote = diag.sync.remoteApplyResults.length;
        step.fn();
        await new Promise((res) => setTimeout(res, 450));
        let peerRow = null;
        if (expectPeer) {
          peerRow = await waitForPeerApply(prevRemote, peerTimeoutMs);
          if (!peerRow) s.testResults.peerTimeouts++;
        }
        s.testResults.steps.push({
          name: rounds > 1 ? `[${r + 1}/${rounds}] ${step.name}` : step.name,
          t: Date.now() - s.testResults.start,
          peerReported: expectPeer ? !!peerRow : null,
          peerSuccess: peerRow ? !!peerRow.success : null,
          correlationId: peerRow?.correlationId || null
        });
      }
      if (r < rounds - 1) await new Promise((res) => setTimeout(res, 500));
  }

    s.testResults.done = true;
    s.testRunning = false;
    const th = s.testHistory;
    th.unshift({
      finishedAt: Date.now(),
      soakRounds: s.testResults.soakRounds,
      durationMs: Date.now() - s.testResults.start,
      peerTimeouts: s.testResults.peerTimeouts,
      memberCountAtRun: (roomState?.members || []).length,
      isHost: !!roomState?.isHost,
      platform: platform.key,
      steps: s.testResults.steps.map((step) => ({ ...step }))
    });
    if (th.length > s.maxTestHistory) th.length = s.maxTestHistory;
    if (btn) btn.disabled = false;
    if (btnSoak) btnSoak.disabled = false;
    updateDiagnosticOverlay();
  }

  function getSyncSuggestions() {
    const m = diag.sync.metrics;
    const rem = diag.sync.remoteApplyResults;
    const tips = [];
    const playTotal = m.playOk + m.playFail;
    const pauseTotal = m.pauseOk + m.pauseFail;
    const seekTotal = m.seekOk + m.seekFail;
    const remotePlay = rem.filter(r => r.eventType === 'play');
    const remotePlayFail = remotePlay.filter(r => !r.success).length;
    const remotePause = rem.filter(r => r.eventType === 'pause');
    const remotePauseFail = remotePause.filter(r => !r.success).length;
    if (playTotal > 0 && m.playFail / playTotal > 0.3) {
      tips.push({ level: 'warn', text: `Play sync failing here (${m.playFail}/${playTotal}). Prime/Netflix may need fallbacks.` });
    }
    if (remotePlay.length > 0 && remotePlayFail / remotePlay.length > 0.3) {
      tips.push({ level: 'warn', text: `Peers report play fail (${remotePlayFail}/${remotePlay.length}). Check their platform.` });
    }
    if (pauseTotal > 0 && m.pauseFail / pauseTotal > 0.3) {
      tips.push({ level: 'warn', text: `Pause sync failing here (${m.pauseFail}/${pauseTotal}). Try video.click fallback.` });
    }
    if (remotePause.length > 0 && remotePauseFail / remotePause.length > 0.3) {
      tips.push({ level: 'warn', text: `Peers report pause fail (${remotePauseFail}/${remotePause.length}). Check their platform.` });
    }
    if (seekTotal > 0 && m.seekFail / seekTotal > 0.3) {
      tips.push({ level: 'warn', text: `Seek sync drifting (${m.seekFail}/${seekTotal}). Platform may replace video element.` });
    }
    const avgLatency = rem.length > 0 ? Math.round(rem.reduce((a, r) => a + (r.latency || 0), 0) / rem.length) : 0;
    if (avgLatency > 0 && avgLatency < 2000) {
      tips.push({ level: 'info', text: `Avg round-trip latency: ${avgLatency}ms` });
    } else if (avgLatency >= 2000) {
      tips.push({ level: 'warn', text: `High latency: ${avgLatency}ms. Check network.` });
    }
    if (diag.tabHidden) {
      tips.push({ level: 'info', text: 'Tab hidden — remote sync may apply when the tab is visible again.' });
    }
    const vb = diag.videoBuffering;
    if ((vb.waiting > 8 || vb.stalled > 4) && playTotal + pauseTotal + seekTotal > 0) {
      tips.push({
        level: 'info',
        text: `Video rebuffering: waiting×${vb.waiting} stalled×${vb.stalled} — can look like sync issues; check CDN/adaptive vs extension.`
      });
    }
    const ge = diag.extensionOps;
    if ((ge.remoteApplyDeniedSyncLock || 0) + (ge.remoteApplyDeniedPlaybackDebounce || 0) >= 3) {
      tips.push({ level: 'info', text: 'Remote play/pause/seek sometimes gated (sync lock / playback debounce). See Extension bridge counters.' });
    }
    if (tips.length > 0 && siteSync.extraDiagTips) {
      for (const t of siteSync.extraDiagTips()) tips.push(t);
    }
    if ((playbackProfile.handlerKey === 'netflix' || playbackProfile.handlerKey === 'disney') && tips.length > 0) {
      tips.push({
        level: 'info',
        text: `${playbackProfile.label}: passive DRM-safe sync — use “Sync to host” when prompted; avoids player errors (e.g. M7375).`
      });
    }
    if (Object.keys(diag.sync.peerReports).length > 0) {
      tips.push({
        level: 'ok',
        text: `Receiving peer report(s) from ${Object.keys(diag.sync.peerReports).length} peer(s)${
          diagnosticsUiEnabled
            ? ' (sent when they open diagnostics or use Request peer report). While you record the video profiler, dev peers also push timed samples—those land in the unified export.'
            : ''
        }.`
      });
    }
    const cs = diag.clusterSync;
    if (cs && cs.playingMismatch) {
      tips.push({ level: 'warn', text: 'Room cluster: not everyone agrees on play vs pause (check badges).' });
    } else if (cs && cs.synced === false && cs.spreadSec != null) {
      tips.push({ level: 'warn', text: `Room cluster spread ~${cs.spreadSec.toFixed(1)}s — playback may need a moment or a manual seek.` });
    } else if (cs && cs.synced === true) {
      tips.push({ level: 'ok', text: `Room cluster looks aligned (within ${CLUSTER_SYNC_SPREAD_SEC}s).` });
    }
    if (tips.length === 0 && (playTotal + pauseTotal + seekTotal) > 0) {
      tips.push({ level: 'ok', text: 'Sync looks healthy. Open diagnostic on both devices for full view.' });
    }
    if (tips.length === 0) {
      tips.push({ level: 'info', text: 'Perform play/pause/seek with a partner. Open diagnostic on both devices.' });
    }
    return tips;
  }

  function captureVideoHealthSnapshot() {
    const v = findVideo() || video;
    if (!v) {
      diag.videoHealthLast = null;
      return;
    }
    const ranges = [];
    try {
      const b = v.buffered;
      for (let i = 0; i < Math.min(b.length, 6); i++) {
        ranges.push([+b.start(i).toFixed(1), +b.end(i).toFixed(1)]);
      }
    } catch {}
    diag.videoHealthLast = {
      at: Date.now(),
      readyState: v.readyState,
      paused: v.paused,
      seeking: v.seeking,
      playbackRate: v.playbackRate,
      currentTime: +v.currentTime.toFixed(2),
      duration: v.duration && !isNaN(v.duration) ? +v.duration.toFixed(0) : null,
      bufferedRanges: ranges,
      bufferingCounts: {
        waiting: diag.videoBuffering.waiting,
        stalled: diag.videoBuffering.stalled
      },
      currentSrc: v.currentSrc
        ? String(v.currentSrc).slice(0, 72) + (String(v.currentSrc).length > 72 ? '…' : '')
        : ''
    };
  }

  /** Machine-filled context for Prime JSON exports (pairing, environment, quick sync glance). */
  function buildPrimeSnapshotAutoContext() {
    let extVersion = '1.0.0';
    try {
      extVersion = chrome.runtime.getManifest()?.version || extVersion;
    } catch {
      /* ignore */
    }
    const path = typeof location !== 'undefined' ? location.pathname || '' : '';
    const host = (typeof location !== 'undefined' ? location.hostname : '').toLowerCase();
    let primePathKind = 'other';
    if (/primevideo\.com/.test(host)) {
      if (/\/detail\//i.test(path)) primePathKind = 'prime_detail';
      else if (/\/watch\//i.test(path)) primePathKind = 'prime_watch';
      else if (/\/region\//i.test(path)) primePathKind = 'prime_region';
    } else if (/amazon\.(com|ca)/.test(host)) {
      if (/\/gp\/video\/detail\//i.test(path)) primePathKind = 'amazon_gp_video_detail';
      else if (/\/gp\/video\/watch\//i.test(path)) primePathKind = 'amazon_gp_video_watch';
    }
    const ts = Date.now();
    const captureNonce = `${ts}-${Math.random().toString(36).slice(2, 9)}`;
    let pipActive = null;
    let fullscreenActive = null;
    let pageFocused = null;
    try {
      pipActive = !!document.pictureInPictureElement;
    } catch {
      /* ignore */
    }
    try {
      fullscreenActive = !!(document.fullscreenElement || document.webkitFullscreenElement);
    } catch {
      /* ignore */
    }
    try {
      pageFocused = typeof document.hasFocus === 'function' ? document.hasFocus() : null;
    } catch {
      /* ignore */
    }
    const inRoom = !!roomState;
    return {
      captureNonce,
      capturedAtMs: ts,
      extensionVersion: extVersion,
      pathname: path,
      primePathKind,
      pageFocused,
      pipActive,
      fullscreenActive,
      videoElementAttached: !!video,
      syncLockActive: !!syncLock,
      connectionStatus: diag.connectionStatus,
      driftEwmSec: diag.timing.driftEwmSec,
      roomRole: inRoom ? (roomState.isHost ? 'host' : 'viewer') : 'solo',
      roomCodeShort: inRoom && roomState.roomCode ? String(roomState.roomCode).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) : null
    };
  }

  function getDiagExportPayload() {
    let ver = '1.0.0';
    try {
      ver = chrome.runtime.getManifest()?.version || ver;
    } catch {}
    return buildDiagnosticExport({
      diag,
      roomState,
      platform,
      extVersion: ver,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      reportSession: diag.reportSession,
      pageHost: typeof location !== 'undefined' ? location.hostname : '',
      videoAttached: diag.videoAttached,
      captureContext: diagExportCaptureContext
    });
  }

  /**
   * Prime player/site digest (not the missed-ad export). Embedded in unified export under `primeSiteDebug`.
   * @returns {Promise<{ payload: object, frameBlob: Blob|null, autoCaptureContext: object }|null>}
   */
  async function buildPrimePlayerSyncExportBundle() {
    if (siteSync.key !== 'prime') return null;
    captureVideoHealthSnapshot();
    const v = findVideo() || video;
    const { blob: frameBlob, meta: frameMeta } = await tryCapturePrimeVideoFramePng(v);
    const iv = playbackProfile;
    let traceDeliveryEstimate = null;
    try {
      traceDeliveryEstimate = computeCorrelationTraceDelivery(diag);
    } catch (err) {
      traceDeliveryEstimate = { error: err && err.message ? err.message : String(err) };
    }
    const sw = diag.serviceWorkerTransport;
    const peerReportSummary = Object.entries(diag.sync.peerReports || {})
      .slice(0, 12)
      .map(([cid, r]) => ({
        clientShort: cid ? `${String(cid).slice(0, 10)}…` : null,
        username: r.username ?? null,
        platform: r.platform ?? null,
        isHost: !!r.isHost,
        lastReceived: r.lastReceived ?? null,
        metrics: r.metrics ? { ...r.metrics } : null
      }));
    const autoCaptureContext = buildPrimeSnapshotAutoContext();
    const multiUserSync = roomState
      ? {
          roomCode: roomState.roomCode,
          memberCount: (roomState.members || []).length,
          capturingUsername: roomState.username ?? null,
          clientIdSuffix: roomState.clientId ? String(roomState.clientId).slice(-10) : null,
          platform: { key: platform.key, name: platform.name },
          tab: {
            diagTabHidden: diag.tabHidden,
            documentHidden: typeof document !== 'undefined' ? document.hidden : null
          },
          transport: {
            connectionStatus: diag.connectionStatus,
            transportPhase: diag.transportPhase,
            serviceWorkerTransport: sw
              ? {
                  wsOpenCount: sw.wsOpenCount,
                  wsCloseCount: sw.wsCloseCount,
                  wsSendFailures: sw.wsSendFailures ?? 0,
                  serverHost: sw.serverHost || null
                }
              : null
          },
          clusterPlayback: diag.clusterSync,
          timing: {
            lastRttMs: diag.timing.lastRttMs,
            lastRttSource: diag.timing.lastRttSource,
            driftEwmSec: diag.timing.driftEwmSec
          },
          traceDeliveryEstimate,
          syncMetrics: { ...diag.sync.metrics },
          syncLastRecvAt: diag.sync.lastRecvAt || null,
          messaging: {
            runtimeSendFailures: diag.messaging.runtimeSendFailures,
            runtimeLastErrorMessage: diag.messaging.runtimeLastErrorMessage
              ? String(diag.messaging.runtimeLastErrorMessage).slice(0, 220)
              : null
          },
          telemetryOps: {
            hostPlaybackPositionSent: diag.extensionOps.hostPlaybackPositionSent,
            viewerSyncRequestSent: diag.extensionOps.viewerSyncRequestSent,
            positionReportSent: diag.extensionOps.positionReportSent,
            positionSnapshotInbound: diag.extensionOps.positionSnapshotInbound,
            wsDisconnectEvents: diag.extensionOps.wsDisconnectEvents,
            serverErrors: diag.extensionOps.serverErrors,
            syncStateInbound: diag.extensionOps.syncStateInbound,
            syncStateApplied: diag.extensionOps.syncStateApplied,
            remoteApplyDeferredTabHidden: diag.extensionOps.remoteApplyDeferredTabHidden
          },
          applyTimelineRecent: (diag.timing.timeline || []).slice(0, 28),
          serverRoomTraceRecent: (diag.serverRoomTrace || []).slice(-28),
          timeupdateJumpsRecent: (diag.timeupdateJumps || []).slice(-10),
          remoteApplyResultsRecent: (diag.sync.remoteApplyResults || []).slice(0, 14),
          peerReportSummary,
          reportSession: diag.reportSession
            ? { startedAt: diag.reportSession.startedAt, roomCode: diag.reportSession.roomCode }
            : null
        }
      : {
          note: 'not_in_room',
          transport: {
            connectionStatus: diag.connectionStatus,
            transportPhase: diag.transportPhase
          },
          traceDeliveryEstimate
        };
    const payload = capturePrimePlayerSyncDebugPayload({
      getVideo: () => findVideo() || video,
      frameCaptureMeta: frameMeta,
      localAdBreakActive,
      inRoom: !!roomState,
      isHost: !!roomState?.isHost,
      hostOnlyControl: !!roomState?.hostOnlyControl,
      countdownOnPlay: !!roomState?.countdownOnPlay,
      lastAppliedState: lastAppliedState ? { ...lastAppliedState } : null,
      lastSentTime,
      lastPlaybackOutboundKind,
      lastSyncAt,
      findVideoStats: { ...diag.findVideo },
      videoHealth: diag.videoHealthLast,
      viewerDriftSec: diag.primeSync?.viewerDriftSec ?? null,
      playbackTuning: {
        handlerKey: iv.handlerKey,
        label: iv.label,
        hostPositionIntervalMs: iv.hostPositionIntervalMs,
        viewerReconcileIntervalMs: iv.viewerReconcileIntervalMs,
        applyDebounceMs: iv.applyDebounceMs,
        playbackOutboundCoalesceMs: iv.playbackOutboundCoalesceMs,
        syncStateApplyDelayMs: iv.syncStateApplyDelayMs,
        playbackSlackSec: iv.playbackSlackSec,
        timeJumpThresholdSec: iv.timeJumpThresholdSec,
        hostSeekSuppressAfterPlayMs: iv.hostSeekSuppressAfterPlayMs,
        syncRequestDelayMs: iv.syncRequestDelayMs,
        aggressiveRemoteSync: iv.aggressiveRemoteSync,
        drmPassive: iv.drmPassive,
        useRelaxedVideoReady: iv.useRelaxedVideoReady
      },
      extensionOpsSubset: {
        remoteApplyDeniedPlaybackDebounce: diag.extensionOps.remoteApplyDeniedPlaybackDebounce,
        remoteApplyDeniedSyncLock: diag.extensionOps.remoteApplyDeniedSyncLock,
        syncStateDeniedPlaybackDebounce: diag.extensionOps.syncStateDeniedPlaybackDebounce,
        playbackOutboundSuppressedLocalAd: diag.extensionOps.playbackOutboundSuppressedLocalAd,
        remoteApplyIgnoredLocalAd: diag.extensionOps.remoteApplyIgnoredLocalAd
      },
      multiUserSync,
      autoCaptureContext
    });
    return { payload, frameBlob, autoCaptureContext };
  }

  /**
   * Dev: compact history of peer diagnostics pushed during this tab’s profiler recording (unified export).
   * @returns {Record<string, unknown>|null}
   */
  function buildPeerRecordingDiagnosticsForExport() {
    const by = diag.peerRecordingSamples.byClient;
    const clientIds = Object.keys(by);
    if (clientIds.length === 0) return null;
    /** @type {Array<Record<string, unknown>>} */
    const peers = [];
    for (const cid of clientIds) {
      const rows = by[cid];
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const first = rows[0];
      const last = rows[rows.length - 1];
      peers.push({
        fromClientId: cid,
        fromUsername: typeof first.fromUsername === 'string' ? first.fromUsername : '',
        sampleCount: rows.length,
        firstReceivedAt: first.receivedAt,
        lastReceivedAt: last.receivedAt,
        samples: rows.map((r) => {
          const p = r.payload && typeof r.payload === 'object' ? r.payload : {};
          return {
            receivedAt: r.receivedAt,
            syncMetrics: p.syncMetrics && typeof p.syncMetrics === 'object' ? p.syncMetrics : null,
            videoAttached: p.videoAttached,
            platform: p.platform,
            platformName: p.platformName,
            devDiag: p.devDiag && typeof p.devDiag === 'object' ? p.devDiag : null
          };
        })
      });
    }
    if (peers.length === 0) return null;
    return {
      schema: 'playshare.peerRecordingDiagnostics.v1',
      exportedAtMs: Date.now(),
      collectorRecording: getVideoProfiler().isRecording(),
      peers
    };
  }

  /**
   * Single JSON: extension sync report + video profiler session + Prime player/site digest (on Prime).
   * Does not include the separate Prime missed-ad-only export.
   * @param {{ compactProfiler?: boolean, includeProfilerVideoFrame?: boolean }} [opts]
   */
  async function getUnifiedPlayShareExportPayload(opts = {}) {
    await prepareDiagnosticSnapshotForExport();
    const extension = getDiagExportPayload();
    const videoPlayerProfiler = getVideoProfiler().buildExportPayload(buildVideoProfilerPageMeta(), {
      compact: !!opts.compactProfiler,
      includeVideoFrame: !!opts.includeProfilerVideoFrame
    });
    let primeSiteDebug = null;
    if (siteSync.key === 'prime') {
      try {
        const bundle = await buildPrimePlayerSyncExportBundle();
        if (bundle) primeSiteDebug = bundle.payload;
      } catch (e) {
        primeSiteDebug = {
          kind: 'playshare_prime_player_sync_debug_v1',
          captureError: e && e.message ? String(e.message) : String(e)
        };
      }
    }
    const peerRecordingDiagnostics = buildPeerRecordingDiagnosticsForExport();
    const pSnap = Array.isArray(videoPlayerProfiler.snapshots) ? videoPlayerProfiler.snapshots.length : 0;
    const peerDiagLine = peerRecordingDiagnostics
      ? ` Peer profiler samples: ${peerRecordingDiagnostics.peers.length} peer(s), ${(peerRecordingDiagnostics.peers).reduce((a, p) => a + (typeof p.sampleCount === 'number' ? p.sampleCount : 0), 0)} row(s).`
      : '';
    const appendix = `\n\n--- Unified JSON (Export report / Copy JSON) ---\nBundled: extension report (${extension.reportSchemaVersion || '?'} — sync metrics, extensionOps, service worker WS + connectionDetail, narrativeSummary), video profiler (${pSnap} snapshots in this file), ${
      siteSync.key === 'prime'
        ? primeSiteDebug && !primeSiteDebug.captureError
          ? 'Prime player/site digest.'
          : 'Prime digest capture failed (see primeSiteDebug.captureError).'
        : 'no Prime site block (not Prime).'
    }${peerDiagLine} Does not include the separate Prime missed-ad-only JSON.\n`;
    return {
      playshareUnifiedExport: '1.0',
      exportedAtMs: Date.now(),
      exportedAtIso: new Date().toISOString(),
      contains: {
        extensionSyncReport: true,
        videoPlayerProfiler: true,
        primeSiteDebug: !!(primeSiteDebug && !primeSiteDebug.captureError),
        primeSiteDebugCaptureFailed: !!(primeSiteDebug && primeSiteDebug.captureError),
        peerRecordingDiagnostics: !!peerRecordingDiagnostics,
        excludedPrimeMissedAdOnlyExport: true
      },
      narrativeSummary: (extension.narrativeSummary || '') + appendix,
      extension,
      videoPlayerProfiler,
      primeSiteDebug,
      peerRecordingDiagnostics
    };
  }

  async function copyDiagExport() {
    const payload = await getUnifiedPlayShareExportPayload();
    const json = JSON.stringify(payload, null, 2);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(json)
        .then(() => diagLog('DIAG_EXPORT', { copied: true, unified: true }))
        .catch(() => diagLog('ERROR', { message: 'Copy failed' }));
    } else {
      diagLog('ERROR', { message: 'Clipboard API unavailable' });
    }
  }

  async function downloadDiagExport() {
    const payload = await getUnifiedPlayShareExportPayload();
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const host =
      (payload.extension && payload.extension.pageHost
        ? String(payload.extension.pageHost)
        : typeof location !== 'undefined'
          ? location.hostname
          : 'page'
      ).replace(/[^a-z0-9.-]/gi, '_') || 'page';
    a.download = `playshare-unified-report-${host}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    diagLog('DIAG_EXPORT', { downloaded: true, unified: true });
  }

  function buildVideoProfilerPageMeta() {
    let ver = '1.0.0';
    try {
      ver = chrome.runtime.getManifest()?.version || ver;
    } catch {
      /* ignore */
    }
    return {
      hostname: typeof location !== 'undefined' ? location.hostname : '',
      pathname: typeof location !== 'undefined' ? location.pathname : '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      platformHandlerKey: playbackProfile.handlerKey,
      extensionVersion: ver
    };
  }

  function startVideoProfilerSession() {
    const v = findVideo() || video;
    if (!v) {
      diagLog('ERROR', { message: 'Video profiler: no <video> — start playback first' });
      return;
    }
    diag.peerRecordingSamples.byClient = {};
    getVideoProfiler().start();
    broadcastProfilerCollectionState(true);
    diagLog('DIAG', { videoProfiler: 'started', peerCollection: true });
    updateDiagnosticOverlay();
  }

  function stopVideoProfilerSession() {
    const wasRec = getVideoProfiler().isRecording();
    getVideoProfiler().stop();
    if (wasRec) broadcastProfilerCollectionState(false);
    diagLog('DIAG', { videoProfiler: 'stopped' });
    updateDiagnosticOverlay();
  }

  async function copyUnifiedExportCompactProfiler() {
    const payload = await getUnifiedPlayShareExportPayload({ compactProfiler: true });
    const json = JSON.stringify(payload, null, 2);
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(json);
        diagLog('DIAG_EXPORT', { unified: true, copied: true, compactProfiler: true });
      } catch {
        diagLog('ERROR', { message: 'Unified compact copy failed' });
      }
    } else {
      diagLog('ERROR', { message: 'Clipboard API unavailable' });
    }
  }

  async function downloadUnifiedExportWithProfilerFrame() {
    const payload = await getUnifiedPlayShareExportPayload({ includeProfilerVideoFrame: true });
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const host =
      (payload.extension && payload.extension.pageHost
        ? String(payload.extension.pageHost)
        : 'page'
      ).replace(/[^a-z0-9.-]/gi, '_') || 'page';
    a.download = `playshare-unified-report-${host}-videoframe-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    diagLog('DIAG_EXPORT', { downloaded: true, unified: true, withProfilerVideoFrame: true });
  }

  function clearVideoProfilerSession() {
    const wasRec = getVideoProfiler().isRecording();
    getVideoProfiler().clearSession();
    if (wasRec) broadcastProfilerCollectionState(false);
    stopPeerRecordingSampleLoop();
    diag.profilerPeerCollection.remoteCollectorClientId = null;
    diagLog('DIAG', { videoProfiler: 'cleared' });
    updateDiagnosticOverlay();
  }

  async function copyDiagNarrative() {
    await prepareDiagnosticSnapshotForExport();
    const extension = getDiagExportPayload();
    const st = getVideoProfiler().getStatus();
    const appendix = `\n\n--- Unified JSON ---\nUse **Export report** or **Copy JSON** for one file: extension report (${extension.reportSchemaVersion || '?'}), video profiler (${st.snapshotCount} snapshots), ${
      siteSync.key === 'prime' ? 'Prime player/site digest (captured at export).' : 'no Prime site block.'
    } Does not include the separate Prime missed-ad-only JSON.\n`;
    const narrative = (extension.narrativeSummary || '') + appendix;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(narrative)
        .then(() => diagLog('DIAG_EXPORT', { narrativeCopied: true, unified: true }))
        .catch(() => diagLog('ERROR', { message: 'Copy failed' }));
    } else {
      diagLog('ERROR', { message: 'Clipboard API unavailable' });
    }
  }

  async function downloadDiagNarrativeTxt() {
    await prepareDiagnosticSnapshotForExport();
    const extension = getDiagExportPayload();
    const st = getVideoProfiler().getStatus();
    const appendix = `\n\n--- Unified JSON ---\nUse **Export report** or **Copy JSON** for one file: extension report (${extension.reportSchemaVersion || '?'}), video profiler (${st.snapshotCount} snapshots), ${
      siteSync.key === 'prime' ? 'Prime player/site digest (captured at export).' : 'no Prime site block.'
    } Does not include the separate Prime missed-ad-only JSON.\n`;
    const narrative = (extension.narrativeSummary || '') + appendix;
    const blob = new Blob([narrative], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `playshare-sync-summary-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    diagLog('DIAG_EXPORT', { narrativeDownloaded: true, unified: true });
  }

  /**
   * Which diagnostic sections need attention (verbose blocks shown). Uses same signals as suggestions.
   * @param {{ level: string, text: string }[]} syncTips
   */
  function computeDiagCategoryIssues(syncTips) {
    const s = diag.sync;
    const m = s.metrics;
    const eo = diag.extensionOps;
    const vb = diag.videoBuffering;
    const cs = diag.clusterSync;
    const warnTips = syncTips.filter((t) => t.level === 'warn');

    const playT = m.playOk + m.playFail;
    const pauseT = m.pauseOk + m.pauseFail;
    const seekT = m.seekOk + m.seekFail;
    const playBad = playT > 0 && m.playFail / playT > 0.25;
    const pauseBad = pauseT > 0 && m.pauseFail / pauseT > 0.25;
    const seekBad = seekT > 0 && m.seekFail / seekT > 0.25;
    const remoteFail = (s.remoteApplyResults || []).some((r) => !r.success);

    const multiplayer =
      warnTips.length > 0 ||
      !!s.testRunning ||
      playBad ||
      pauseBad ||
      seekBad ||
      remoteFail ||
      !!cs?.playingMismatch ||
      (cs && cs.synced === false && cs.spreadSec != null && cs.spreadSec > CLUSTER_SYNC_SPREAD_SEC * 1.15);

    const server =
      diag.connectionStatus === 'disconnected' ||
      (diag.messaging?.runtimeSendFailures ?? 0) > 0 ||
      (eo.serverErrors ?? 0) > 0 ||
      (diag.serviceWorkerTransport && (diag.serviceWorkerTransport.wsSendFailures ?? 0) > 0);

    const drift = diag.timing.driftEwmSec;
    const technical =
      !diag.videoAttached ||
      (drift != null && drift > SYNC_DRIFT_SOFT_MIN_SEC) ||
      vb.waiting + vb.stalled > 5 ||
      diag.timeupdateJumps.length > 0 ||
      (eo.syncStateDeferredNoVideo ?? 0) > 18 ||
      (eo.syncStateDeferredStaleOrMissing ?? 0) > 18;

    const logs = diag.errors.length > 0 || (!!roomState && !sidebarFrame);

    let prime = false;
    if (siteSync.key === 'prime' && diag.primeSync) {
      const p = diag.primeSync;
      prime =
        !p.inSdkShell ||
        (typeof p.viewerDriftSec === 'number' && !Number.isNaN(p.viewerDriftSec) && Math.abs(p.viewerDriftSec) > 4);
    }

    return { multiplayer, server, technical, logs, prime };
  }

  function applyDiagSectionVisibility(issues) {
    if (!diagPanel) return;
    /** Full dashboard always shows metrics; compact strip uses category icons only. */
    const showAllMetrics = diag.consoleView === 'detailed';
    const map = [
      ['multiplayer', issues.multiplayer],
      ['server', issues.server],
      ['technical', issues.technical],
      ['logs', issues.logs],
      ['prime', issues.prime]
    ];
    for (const [key, hasIssue] of map) {
      const det = diagPanel.querySelector(`details[data-diag-sec="${key}"]`);
      const wrap = diagPanel.querySelector(`[data-diag-sec-wrap="${key}"]`);
      const quiet = diagPanel.querySelector(`[data-diag-quiet="${key}"]`);
      const body = diagPanel.querySelector(`[data-diag-body="${key}"]`);
      const badge = det?.querySelector('[data-diag-sec-badge]') || wrap?.querySelector('[data-diag-sec-badge]');
      if (quiet) quiet.style.display = showAllMetrics ? 'none' : hasIssue ? 'none' : 'block';
      if (body) body.style.display = showAllMetrics ? 'block' : hasIssue ? 'block' : 'none';
      if (badge) {
        badge.textContent = hasIssue ? 'Attention' : 'OK';
        badge.classList.toggle('ws-diag-badge-ok', !hasIssue);
        badge.classList.toggle('ws-diag-badge-warn', !!hasIssue);
      }
    }
  }

  function applyDashboardBlockVisibility() {
    if (!diagPanel) return;
    for (const el of diagPanel.querySelectorAll('[data-diag-dash-block]')) {
      const key = el.getAttribute('data-diag-dash-block');
      if (!key || !(key in diag.dashBlocks)) continue;
      el.style.display = diag.dashBlocks[key] ? '' : 'none';
    }
  }

  function syncDashLayoutCheckboxesFromDiag() {
    if (!diagPanel) return;
    const wrap = diagPanel.querySelector('[data-diag-dash-customize]');
    if (!wrap) return;
    for (const inp of wrap.querySelectorAll('input[data-dash-toggle]')) {
      const key = inp.getAttribute('data-dash-toggle');
      if (key && key in diag.dashBlocks) inp.checked = diag.dashBlocks[key];
    }
  }

  function closeDiagDashModal() {
    if (!diagPanel) return;
    const root = diagPanel.querySelector('#diagDashModalRoot');
    if (!root || root.hasAttribute('hidden')) return;
    root.setAttribute('hidden', '');
    root.setAttribute('aria-hidden', 'true');
    diagPanel.querySelector('#diagDashCustomizeOpen')?.focus();
  }

  function openDiagDashModal() {
    if (!diagPanel) return;
    const root = diagPanel.querySelector('#diagDashModalRoot');
    if (!root) return;
    syncDashLayoutCheckboxesFromDiag();
    root.removeAttribute('hidden');
    root.setAttribute('aria-hidden', 'false');
    const firstCb = diagPanel.querySelector('[data-diag-dash-customize] input[type="checkbox"]');
    (firstCb || diagPanel.querySelector('#diagDashCustomizeDone'))?.focus({ preventScroll: true });
  }

  function updateCompactConsoleStrip(catIssues) {
    if (!diagPanel) return;
    const setTile = (comp, hasIssue, line, ariaDetail) => {
      const tile = diagPanel.querySelector(`[data-diag-comp="${comp}"]`);
      if (!tile) return;
      tile.classList.toggle('ws-diag-comp-ok', !hasIssue);
      tile.classList.toggle('ws-diag-comp-warn', !!hasIssue);
      const lineEl = tile.querySelector(`[data-diag-comp-line="${comp}"]`);
      if (lineEl) lineEl.textContent = line;
      tile.setAttribute('aria-label', `${comp}: ${ariaDetail}`);
    };

    const cs = String(diag.connectionStatus || 'unknown');
    const syncIssue =
      diag.connectionStatus === 'disconnected' ||
      !!catIssues.multiplayer ||
      !!catIssues.server;
    const syncLine = `${diag.tabHidden ? 'tab hidden · ' : ''}${cs}`;
    setTile('sync', syncIssue, syncLine, `${syncIssue ? 'needs attention' : 'healthy'} · ${syncLine}`);

    let adIssue;
    let adLine;
    if (siteSync.key === 'prime' && diag.primeSync) {
      const p = diag.primeSync;
      adIssue = !!catIssues.prime || !p.inSdkShell;
      adLine = !p.inSdkShell ? 'Shell?' : p.adDetectorActive ? 'Ad UI' : 'Content';
    } else {
      adIssue = !!localAdBreakActive;
      adLine = localAdBreakActive ? 'Ad break' : 'Idle';
    }
    setTile('ad', adIssue, adLine, `${adIssue ? 'check' : 'ok'} · ${adLine}`);

    const vh = diag.videoHealthLast;
    const vidIssue = !!catIssues.technical || !diag.videoAttached;
    let vidLine = '—';
    if (!diag.videoAttached) vidLine = 'No video';
    else if (vh) vidLine = `RS${vh.readyState}${vh.paused ? ' · paused' : ''}`;
    else vidLine = 'Attached';
    setTile('video', vidIssue, vidLine, `${vidIssue ? 'needs attention' : 'healthy'} · ${vidLine}`);
  }

  function setDiagConsoleView(view) {
    if (view !== 'compact' && view !== 'detailed') return;
    diag.consoleView = view;
    if (diagPanel) {
      diagPanel.classList.toggle('ws-diag-view-compact', view === 'compact');
      diagPanel.classList.toggle('ws-diag-view-detailed', view === 'detailed');
      const tgl = diagPanel.querySelector('#diagConsoleViewToggle');
      if (tgl) {
        tgl.setAttribute('aria-pressed', view === 'detailed' ? 'true' : 'false');
        tgl.title =
          view === 'compact'
            ? 'Open full dashboard (session metrics & logs)'
            : 'Compact telemetry strip (icons only)';
      }
    }
    persistDiagConsolePrefs();
    if (diagVisible) {
      try {
        const st = getSyncSuggestions();
        applyDiagSectionVisibility(computeDiagCategoryIssues(st));
      } catch {
        /* ignore */
      }
    }
  }

  function updateDiagnosticOverlay() {
    if (!diagPanel || !diagVisible) return;

    const syncTips = getSyncSuggestions();
    const catIssues = computeDiagCategoryIssues(syncTips);

    diag.tabHidden = document.hidden;
    diag.diagOverlayStale = document.hidden;
    captureVideoHealthSnapshot();

    // Refresh sidebar state from actual variables
    diag.sidebar.frameExists = !!sidebarFrame;
    diag.sidebar.toggleBtnExists = !!sidebarToggleBtn;
    diag.sidebar.toggleBtnVisible = sidebarToggleBtn ? sidebarToggleBtn.style.display === 'flex' : false;

    const dashSummaryEl = diagPanel.querySelector('[data-diag="dash-summary"]');
    const dashAlertsEl = diagPanel.querySelector('[data-diag="dash-alerts"]');
    const sidebarEl = diagPanel.querySelector('[data-diag="sidebar"]');
    const msgsEl = diagPanel.querySelector('[data-diag="messages"]');
    const errsEl = diagPanel.querySelector('[data-diag="errors"]');

    if (dashSummaryEl) {
      const c = diag.connectionStatus;
      const s = diag.sync;
      const m = s.metrics;
      const ratePct = (ok, fail) => {
        const t = ok + fail;
        return t > 0 ? `${Math.round((ok / t) * 100)}%` : '—';
      };
      const roomOne = roomState
        ? `${roomState.roomCode} · ${roomState.isHost ? 'Host' : 'Viewer'} · ${(roomState.members || []).length} in room`
        : 'Not in a room';
      const rtt = diag.timing.lastRttMs != null ? `${Math.round(diag.timing.lastRttMs)} ms` : '—';
      const rttExtra =
        diag.timing.lastRttSource != null
          ? ` <span class="ws-diag-muted">(${String(diag.timing.lastRttSource).replace(/_/g, ' ')})</span>`
          : '';
      const drift = diag.timing.driftEwmSec != null ? `${diag.timing.driftEwmSec.toFixed(2)}s` : '—';
      const lastIn = s.lastRecvAt ? formatDiagTimeAgo(s.lastRecvAt) : 'never';
      const vb = diag.videoBuffering;
      const vh = diag.videoHealthLast;
      let videoInner = '';
      if (vh) {
        const ct = typeof vh.currentTime === 'number' ? vh.currentTime.toFixed(1) : '—';
        const dur = vh.duration != null ? vh.duration.toFixed(0) : '—';
        videoInner = `readyState <strong>${vh.readyState}</strong> · ${vh.paused ? 'paused' : 'playing'} · <code>t=${ct}s</code> / ${dur}s`;
      } else {
        videoInner = diag.videoAttached
          ? 'Attached (no snapshot yet)'
          : '<span class="ws-diag-warn">No &lt;video&gt;</span>';
      }
      const cs = diag.clusterSync;
      const clusterLine = cs ? cs.label : 'No cluster snapshot yet';
      const sw = diag.serviceWorkerTransport;
      const swShort = sw
        ? `WS open/close ${sw.wsOpenCount}/${sw.wsCloseCount} · send fail ${sw.wsSendFailures ?? 0}`
        : 'Overlay closed — open for SW stats';
      const eo = diag.extensionOps;
      const msgFail = diag.messaging.runtimeSendFailures ?? 0;
      const phaseStr =
        diag.transportPhase != null && String(diag.transportPhase).trim() !== ''
          ? String(diag.transportPhase).trim()
          : '';
      const connNorm = String(c).trim().toLowerCase();
      const connectionExtra =
        phaseStr && phaseStr.toLowerCase() !== connNorm
          ? ` <span class="ws-diag-muted">· ${phaseStr}</span>`
          : '';
      const anyAttention =
        catIssues.multiplayer ||
        catIssues.server ||
        catIssues.technical ||
        catIssues.logs ||
        (siteSync.key === 'prime' && catIssues.prime);

      let primeRow = '';
      if (siteSync.key === 'prime' && diag.primeSync) {
        const p = diag.primeSync;
        const driftP =
          typeof p.viewerDriftSec === 'number' && !Number.isNaN(p.viewerDriftSec)
            ? `${p.viewerDriftSec >= 0 ? '+' : ''}${p.viewerDriftSec.toFixed(2)}s`
            : '—';
        primeRow = `
          <div class="ws-diag-session-cell ws-diag-session-span2">
            <span class="ws-diag-session-label">Prime</span>
            <div>SDK shell <strong>${p.inSdkShell ? 'yes' : 'no'}</strong> · ${p.adDetectorActive ? '<span class="ws-diag-warn">Ad UI</span>' : 'Content'} · viewer Δhost <strong>${driftP}</strong> · ad score ${p.adScore}</div>
          </div>`;
      }

      dashSummaryEl.innerHTML = `
        <div class="ws-diag-session-grid">
          <div class="ws-diag-session-cell">
            <span class="ws-diag-session-label">Connection</span>
            <div><span class="ws-diag-chip ws-diag-chip-${['connected', 'disconnected', 'syncing', 'reconnecting'].includes(c) ? c : 'unknown'}">${c}</span>${connectionExtra}</div>
            <div class="ws-diag-session-sub">RTT <strong>${rtt}</strong>${rttExtra}</div>
          </div>
          <div class="ws-diag-session-cell">
            <span class="ws-diag-session-label">Room</span>
            <div>${roomOne}</div>
          </div>
          <div class="ws-diag-session-cell">
            <span class="ws-diag-session-label">Video</span>
            <div>${videoInner}</div>
            <div class="ws-diag-session-sub ws-diag-muted">Rebuffer: waiting×${vb.waiting} · stalled×${vb.stalled}</div>
          </div>
          <div class="ws-diag-session-cell">
            <span class="ws-diag-session-label">Sync applies (this tab)</span>
            <div>Post-apply drift (EWM) <strong>${drift}</strong> · last inbound <strong>${lastIn}</strong></div>
            <div class="ws-diag-session-sub ws-diag-muted">Play ${ratePct(m.playOk, m.playFail)} · Pause ${ratePct(m.pauseOk, m.pauseFail)} · Seek ${ratePct(m.seekOk, m.seekFail)}</div>
          </div>
          <div class="ws-diag-session-cell">
            <span class="ws-diag-session-label">Cluster playback</span>
            <div>${clusterLine}</div>
          </div>
          <div class="ws-diag-session-cell">
            <span class="ws-diag-session-label">Bridge &amp; service worker</span>
            <div class="ws-diag-session-sub">${swShort}</div>
            <div class="ws-diag-session-sub ws-diag-muted">Tab→BG fail ×${msgFail} · server err ×${eo.serverErrors} · SYNC_STATE deferred (no video) ${eo.syncStateDeferredNoVideo ?? 0}</div>
          </div>
          ${primeRow}
        </div>
        <div class="ws-diag-overview-compact ws-diag-overview-chips">
          <span class="ws-diag-chip ws-diag-chip-${diag.tabHidden ? 'syncing' : 'connected'}">${diag.tabHidden ? 'Tab hidden' : 'Tab active'}</span>
        </div>
        ${
          anyAttention
            ? '<div class="ws-diag-overview-hint ws-diag-warn">Some rows above or categories show <strong>Attention</strong> — use sections below to trace the path.</div>'
            : '<div class="ws-diag-overview-hint ws-diag-muted">Live session snapshot — expand categories as needed.</div>'
        }
        <div class="ws-diag-overview-hint ws-diag-muted" style="margin-top:6px">Full support bundle: <strong>Record &amp; export</strong> (just below) → step 1 record, step 2 export. Compact bar: <strong>Record</strong> + <strong>Export</strong>.</div>
      `;
    }
    if (dashAlertsEl) {
      const errN = diag.errors.length;
      const parts = [];
      if (errN) {
        parts.push(
          `<div class="ws-diag-alert ws-diag-warn">${errN} error${errN > 1 ? 's' : ''} — open <strong>Logs &amp; sidebar</strong>.</div>`
        );
      }
      for (const t of syncTips.filter((x) => x.level === 'warn').slice(0, 4)) {
        parts.push(`<div class="ws-diag-alert ws-diag-warn">${t.text}</div>`);
      }
      dashAlertsEl.innerHTML = parts.join('');
      dashAlertsEl.style.display = parts.length ? 'block' : 'none';
    }
    if (sidebarEl) {
      const s = diag.sidebar;
      const toggleAgo = s.lastToggleAt ? formatDiagTime(s.lastToggleAt) : 'never';
      sidebarEl.innerHTML = `
        <div>Sidebar: <span class="ws-diag-${sidebarVisible ? 'ok' : 'warn'}">${sidebarVisible ? 'Open' : 'Closed'}</span></div>
        <div>Frame: ${s.frameExists ? '✓' : '✗'} | Btn: ${s.toggleBtnVisible ? '✓' : '✗'}</div>
        <div>TOGGLE received: ${s.toggleReceived}x (${toggleAgo})</div>
        <div>Room: ${roomState ? 'yes' : 'no'} (need room for sidebar)</div>
      `;
    }
    if (msgsEl) {
      msgsEl.innerHTML = diag.recentMessages.length
        ? diag.recentMessages.slice(0, 5).map(m => {
            const d = m.detail ? (m.detail.fromUsername || m.detail.source || m.detail.text || '') : '';
            return `<div class="ws-diag-row">${m.event} ${d ? String(d).slice(0, 25) : ''} ${formatDiagTime(m.t)}</div>`;
          }).join('')
        : '<div class="ws-diag-row ws-diag-muted">No events yet</div>';
    }
    if (errsEl) {
      errsEl.innerHTML = diag.errors.length
        ? diag.errors.slice(0, 3).map(e => `<div class="ws-diag-row ws-diag-err">${e.detail?.message || e.event} ${formatDiagTime(e.t)}</div>`).join('')
        : '<div class="ws-diag-row ws-diag-muted">No errors</div>';
    }

    {
      const s = diag.sync;
      const m = s.metrics;
      const staleEl = diagPanel.querySelector('[data-diag="sync-stale"]');
      const profileLineEl = diagPanel.querySelector('[data-diag="sync-profile-line"]');
      const timingEl = diagPanel.querySelector('[data-diag="sync-timing"]');
      const videoHealthEl = diagPanel.querySelector('[data-diag="sync-video-health"]');
      const findVideoEl = diagPanel.querySelector('[data-diag="sync-findvideo"]');
      const tuJumpsEl = diagPanel.querySelector('[data-diag="sync-tujumps"]');
      const timelineEl = diagPanel.querySelector('[data-diag="sync-timeline"]');
      const serverTraceEl = diagPanel.querySelector('[data-diag="sync-server-trace"]');
      const thisDeviceEl = diagPanel.querySelector('[data-diag="sync-this-device"]');
      const extensionBridgeEl = diagPanel.querySelector('[data-diag="sync-extension-bridge"]');
      const metricsEl = diagPanel.querySelector('[data-diag="sync-metrics"]');
      const peersEl = diagPanel.querySelector('[data-diag="sync-peers"]');
      const remoteEl = diagPanel.querySelector('[data-diag="sync-remote-results"]');
      const suggestionsEl = diagPanel.querySelector('[data-diag="sync-suggestions"]');
      const eventsEl = diagPanel.querySelector('[data-diag="sync-events"]');
      const filterInp = diagPanel.querySelector('#diagEventFilter');
      if (filterInp && filterInp.value !== s.eventFilter) filterInp.value = s.eventFilter;

      if (staleEl) {
        if (diag.tabHidden) {
          staleEl.classList.add('visible');
          staleEl.textContent = 'Tab hidden — remote play/pause may wait until you return to this tab.';
        } else {
          staleEl.classList.remove('visible');
          staleEl.textContent = '';
        }
      }
      if (profileLineEl) {
        const iv = playbackProfile;
        profileLineEl.innerHTML = `<div class="ws-diag-row"><code>${iv.handlerKey}</code> · host pos ${iv.hostPositionIntervalMs}ms · reconcile ${iv.viewerReconcileIntervalMs}ms · apply debounce ${iv.applyDebounceMs}ms · outbound coalesce ${iv.playbackOutboundCoalesceMs ?? 0}ms · slack ${iv.playbackSlackSec != null ? iv.playbackSlackSec + 's' : '—'}</div>`;
      }
      if (timingEl) {
        const rtt = diag.timing.lastRttMs != null ? `${Math.round(diag.timing.lastRttMs)}ms` : '—';
        const ewm = diag.timing.driftEwmSec != null ? `${diag.timing.driftEwmSec.toFixed(3)}s` : '—';
        const lastRecv = s.lastRecvAt ? formatDiagTimeAgo(s.lastRecvAt) : 'never';
        const rttSrc = diag.timing.lastRttSource || '—';
        timingEl.innerHTML = `
          <div class="ws-diag-row">RTT <strong>${rtt}</strong> <span class="ws-diag-muted">(${rttSrc})</span></div>
          <div class="ws-diag-row">Drift EWM (post-apply): <strong>${ewm}</strong></div>
          <div class="ws-diag-row ws-diag-muted">Last inbound sync: ${lastRecv}</div>
        `;
      }
      if (videoHealthEl) {
        const h = diag.videoHealthLast;
        const vb = diag.videoBuffering;
        videoHealthEl.innerHTML = h
          ? `<div class="ws-diag-row">readyState ${h.readyState} | paused ${h.paused} | seeking ${h.seeking} | rate ${h.playbackRate}</div>
             <div class="ws-diag-row">t=${h.currentTime}s / ${h.duration != null ? h.duration + 's' : '—'}</div>
             <div class="ws-diag-row ws-diag-muted"><code>waiting</code>×${vb.waiting} <code>stalled</code>×${vb.stalled} (rebuffer — compare with sync applies)</div>
             <div class="ws-diag-row ws-diag-muted">buffered: ${(h.bufferedRanges || []).map((x) => `[${x[0]}-${x[1]}]`).join(' ') || '—'}</div>
             <div class="ws-diag-row ws-diag-muted">${h.currentSrc || '—'}</div>`
          : `<div class="ws-diag-row ws-diag-muted">No video element</div>
             <div class="ws-diag-row ws-diag-muted"><code>waiting</code>×${vb.waiting} <code>stalled</code>×${vb.stalled}</div>`;
      }
      const videoProfilerStatusEl = diagPanel.querySelector('[data-diag="video-profiler-status"]');
      if (videoProfilerStatusEl) {
        try {
          const st = getVideoProfiler().getStatus();
          const endMs = st.recording ? Date.now() : st.endedAtMs;
          const durSec =
            st.startedAtMs != null && endMs != null
              ? Math.max(0, Math.round((endMs - st.startedAtMs) / 1000))
              : null;
          const dur = durSec != null ? `${durSec}s` : '—';
          const rec = st.recording ? 'Recording' : st.startedAtMs != null ? 'Stopped' : 'Idle';
          const err = st.lastMediaError ? `${st.lastMediaError.name}` : 'none';
          const topCounts = Object.entries(st.eventTypeCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([k, n]) => `${k}×${n}`)
            .join(' · ');
          const um = st.userMarkerCount != null ? st.userMarkerCount : 0;
          const lim = st.recordingLimits;
          const capLine =
            lim && typeof lim.approxMaxWallMinutes === 'number'
              ? `Every ${lim.snapshotIntervalMs / 1000}s · keeps last <strong>${lim.maxSnapshots}</strong> snaps (~<strong>${lim.approxMaxWallMinutes}</strong> min wall if full) · max <strong>${lim.maxEvents}</strong> events (ring buffer).`
              : '';
          videoProfilerStatusEl.innerHTML = `<strong>${rec}</strong> · elapsed ${dur} · snapshots <strong>${st.snapshotCount}</strong> · events <strong>${st.eventCount}</strong> · markers <strong>${um}</strong><br/>
            <span class="ws-diag-muted">${capLine} Timeline is merged into the <strong>unified</strong> Export report / Copy JSON; stop recording to freeze samples. v3 — EME/PiP, frame callback sample, long tasks. Stall hints: ${st.playheadStallMarkers} · last media error: ${err}${topCounts ? ` · top events: ${topCounts}` : ''}</span>`;
        } catch {
          videoProfilerStatusEl.textContent = 'Profiler unavailable.';
        }
      }
      const recToggle = diagPanel.querySelector('#diagCompactRecordToggle');
      const recLabel = diagPanel.querySelector('[data-diag="compact-rec-label"]');
      const profilerStartBtn = diagPanel.querySelector('#diagVideoProfilerStart');
      const profilerStopBtn = diagPanel.querySelector('#diagVideoProfilerStop');
      const profilerMarkerBtn = diagPanel.querySelector('#diagVideoProfilerMarker');
      try {
        const recording = getVideoProfiler().isRecording();
        const v = findVideo() || video;
        const canStart = !!v;

        if (profilerStartBtn) {
          profilerStartBtn.disabled = recording || !canStart;
          profilerStartBtn.title = recording
            ? 'Already recording — use Stop when finished'
            : !canStart
              ? 'Start playback first — recording needs a video element'
              : 'Start capturing profiler snapshots into the unified export';
        }
        if (profilerStopBtn) {
          profilerStopBtn.disabled = !recording;
          profilerStopBtn.title = recording
            ? 'Stop capturing (freeze profiler timeline for export)'
            : 'Not recording — nothing to stop';
        }
        if (profilerMarkerBtn) {
          profilerMarkerBtn.disabled = !recording;
          profilerMarkerBtn.title = recording
            ? 'Add a labeled point in the JSON timeline'
            : 'Start recording first to add markers';
        }

        if (recToggle && recLabel) {
          recToggle.classList.toggle('ws-diag-compact-rec-active', recording);
          recToggle.setAttribute('aria-pressed', recording ? 'true' : 'false');
          recLabel.textContent = recording ? 'Stop' : 'Record';
          recToggle.disabled = recording ? false : !canStart;
          recToggle.title = recording
            ? 'Stop profiler recording'
            : !canStart
              ? 'Start playback first — then record'
              : 'Start profiler recording (included in unified export)';
        }
      } catch {
        if (profilerStartBtn) profilerStartBtn.disabled = false;
        if (profilerStopBtn) profilerStopBtn.disabled = true;
        if (profilerMarkerBtn) profilerMarkerBtn.disabled = true;
        if (recToggle) recToggle.disabled = false;
        if (recLabel) recLabel.textContent = 'Record';
      }
      if (findVideoEl) {
        const fv = diag.findVideo;
        findVideoEl.innerHTML = `<div class="ws-diag-row">cache hits: ${fv.cacheReturns} | full scans: ${fv.fullScans} | invalidations: ${fv.invalidations} | attaches: ${fv.videoAttachCount}</div>`;
      }
      const primeMissedStatusEl = diagPanel.querySelector('[data-diag="prime-missed-ad-status"]');
      if (primeMissedStatusEl) {
        if (diag.lastPrimeMissedAdCapture) {
          const c = diag.lastPrimeMissedAdCapture;
          primeMissedStatusEl.textContent = `Ad JSON: ${formatDiagTimeAgo(c.at)} · ${c.clipboardOk ? 'clipboard ok' : 'clipboard failed'}`;
        } else {
          primeMissedStatusEl.textContent = 'Ad JSON: not yet';
        }
      }
      const primeSummaryEl = diagPanel.querySelector('[data-diag="sync-prime-summary"]');
      const primeQuietEl = diagPanel.querySelector('[data-diag-quiet="prime"]');
      if (primeSummaryEl || primeQuietEl) {
        if (diag.primeSync) {
          refreshPrimeSyncTelemetry();
          const p = diag.primeSync;
          const drift =
            typeof p.viewerDriftSec === 'number' && !Number.isNaN(p.viewerDriftSec)
              ? `${p.viewerDriftSec >= 0 ? '+' : ''}${p.viewerDriftSec.toFixed(2)}s`
              : '—';
          const sel = p.selectorThatMatched ? String(p.selectorThatMatched).replace(/</g, '&lt;') : '—';
          const reasonsStr =
            p.adReasons && p.adReasons.length
              ? p.adReasons.map((r) => String(r).replace(/&/g, '&amp;').replace(/</g, '&lt;')).join(', ')
              : 'none';
          if (primeSummaryEl) {
            primeSummaryEl.innerHTML = `
            <div><span class="ws-diag-${p.inSdkShell ? 'ok' : 'warn'}">Shell ${p.inSdkShell ? '✓' : '?'}</span> · Ad cues <strong>${p.adScore}</strong> · <span class="ws-diag-${p.adDetectorActive ? 'warn' : 'ok'}">${p.adDetectorActive ? 'IN AD' : 'content'}</span> · room ad hold ${p.extensionLocalAd ? 'on' : 'off'} · peers in ad ${p.peersInAd}</div>
            <div class="ws-diag-muted" style="margin-top:4px">Channels: ${reasonsStr}</div>
            <div style="margin-top:4px">Viewer Δ host <strong>${drift}</strong> · <code>${sel}</code></div>
          `;
          }
          if (primeQuietEl) {
            primeQuietEl.textContent = `Shell ${p.inSdkShell ? 'OK' : 'check'} · ${p.adDetectorActive ? 'Ad UI' : 'Content'} · Δhost ${drift}`;
          }
        } else {
          if (primeSummaryEl) primeSummaryEl.innerHTML = '<span class="ws-diag-muted">Prime telemetry not active.</span>';
          if (primeQuietEl) primeQuietEl.textContent = 'Prime telemetry not active yet.';
        }
      }
      if (tuJumpsEl) {
        const jumps = diag.timeupdateJumps.slice(0, 6);
        tuJumpsEl.innerHTML = jumps.length
          ? jumps.map(j => `<div class="ws-diag-row">${j.deltaSec}s jump (${j.from}→${j.to}) ${formatDiagTimeAgo(j.t)}</div>`).join('')
          : '<div class="ws-diag-row ws-diag-muted">No large jumps logged</div>';
      }
      if (timelineEl) {
        const tl = (diag.timing.timeline || []).slice(0, 12);
        timelineEl.innerHTML = tl.length
          ? tl.map((e) => {
              const cid = e.correlationId ? String(e.correlationId).slice(0, 8) + '…' : '';
              const extra = [e.kind, e.driftSec != null ? `Δ${e.driftSec.toFixed(2)}s` : '', e.latencyMs != null ? `${e.latencyMs}ms` : '', cid ? `id:${cid}` : '']
                .filter(Boolean).join(' ');
              return `<div class="ws-diag-row ws-diag-muted">${extra} ${formatDiagTimeAgo(e.t)}</div>`;
            }).join('')
          : '<div class="ws-diag-row ws-diag-muted">No timeline entries</div>';
      }
      if (serverTraceEl) {
        const tr = (diag.serverRoomTrace || []).slice(-12).reverse();
        serverTraceEl.innerHTML = tr.length
          ? tr.map((e) => {
              const id = e.correlationId ? String(e.correlationId).slice(0, 8) + '…' : '';
              return `<div class="ws-diag-row">${e.type} ${e.fromUsername || ''} <span class="ws-diag-muted">${id}</span> ${formatDiagTimeAgo(e.t)}</div>`;
            }).join('')
          : '<div class="ws-diag-row ws-diag-muted">Open panel or tap Refresh to load server ring buffer</div>';
      }

      if (thisDeviceEl) {
        const pol =
          roomState != null
            ? `hostOnly ${roomState.hostOnlyControl ? 'on' : 'off'} · countdown ${roomState.countdownOnPlay ? 'on' : 'off'}`
            : '—';
        const cs = diag.clusterSync;
        const clusterLine = cs
          ? `<div class="ws-diag-row">${cs.label}${cs.staleCount ? ` · ${cs.staleCount} stale reports` : ''}${cs.freshMemberCount != null ? ` · ${cs.freshMemberCount} fresh` : ''}</div>`
          : '<div class="ws-diag-row ws-diag-muted">No cluster snapshot yet</div>';
        thisDeviceEl.innerHTML = `
          <div class="ws-diag-row">${platform.name} · Tab <strong>${diag.tabHidden ? 'hidden' : 'visible'}</strong></div>
          <div class="ws-diag-row ws-diag-muted">Room rules: ${pol}</div>
          ${clusterLine}
        `;
      }
      if (extensionBridgeEl) {
        const eo = diag.extensionOps;
        const sw = diag.serviceWorkerTransport;
        const msg = diag.messaging;
        const swLine = sw
          ? `SW WS opens ${sw.wsOpenCount} / closes ${sw.wsCloseCount} · send failures ${sw.wsSendFailures ?? 0} · ${sw.serverHost || '?'}`
          : 'SW transport: open overlay / export to refresh';
        extensionBridgeEl.innerHTML = `
          <div class="ws-diag-row">SYNC_STATE in <strong>${eo.syncStateInbound}</strong> · applied <strong>${eo.syncStateApplied}</strong> · deferred (no &lt;video&gt;) <strong>${eo.syncStateDeferredNoVideo}</strong> · deferred (stale) <strong>${eo.syncStateDeferredStaleOrMissing}</strong></div>
          <div class="ws-diag-row">SYNC_STATE denied: syncLock <strong>${eo.syncStateDeniedSyncLock}</strong> · playback debounce <strong>${eo.syncStateDeniedPlaybackDebounce}</strong> · flushed <strong>${eo.syncStateFlushedOnVideoAttach}</strong> · pending <strong>${diag.pendingSyncStateQueued ? 'yes' : 'no'}</strong></div>
          <div class="ws-diag-row">Remote PLAY/PAUSE/SEEK denied: syncLock <strong>${eo.remoteApplyDeniedSyncLock}</strong> · playback debounce <strong>${eo.remoteApplyDeniedPlaybackDebounce}</strong> · deferred (tab hidden path) <strong>${eo.remoteApplyDeferredTabHidden}</strong></div>
          <div class="ws-diag-row ws-diag-muted">DRM UI: prompts <strong>${eo.drmSyncPromptsShown}</strong> · confirmed <strong>${eo.drmSyncConfirmed}</strong> · seek skipped (&lt;thr) <strong>${eo.drmSeekSkippedUnderThreshold}</strong> · handler <strong>${playbackProfile.handlerKey}</strong></div>
          <div class="ws-diag-row ws-diag-muted">Local host-only blocks <strong>${eo.localControlBlockedHostOnly}</strong></div>
          <div class="ws-diag-row">Host position msgs <strong>${eo.hostPlaybackPositionSent}</strong> · viewer SYNC_REQUEST <strong>${eo.viewerSyncRequestSent}</strong> · POSITION_REPORT ×<strong>${eo.positionReportSent}</strong> · POSITION_SNAPSHOT in ×<strong>${eo.positionSnapshotInbound}</strong> · remote countdown <strong>${eo.countdownStartRemote}</strong></div>
          <div class="ws-diag-row ws-diag-muted">→ BG send: lastError ×${msg.runtimeSendFailures} · throws ×${msg.sendThrowCount}${msg.runtimeLastErrorMessage ? ` · ${String(msg.runtimeLastErrorMessage).slice(0, 48)}` : ''}</div>
          <div class="ws-diag-row ws-diag-muted">Chat in ${eo.chatReceived} · system ${eo.systemMsgsReceived} (playback dedupe ${eo.playbackSystemMsgsDeduped}) · ERROR ${eo.serverErrors} · tab WS_DISCONNECTED ${eo.wsDisconnectEvents}</div>
          <div class="ws-diag-row ws-diag-muted">${swLine}</div>
        `;
      }
      if (metricsEl) {
        const rate = (ok, fail) => {
          const t = ok + fail;
          return t > 0 ? `${Math.round((ok / t) * 100)}%` : '—';
        };
        const testExtra = s.testResults?.done && s.testResults.peerTimeouts != null
          ? `<div class="ws-diag-row ws-diag-muted">Soak: peer wait timeouts ${s.testResults.peerTimeouts}</div>`
          : '';
        metricsEl.innerHTML = `
          <div class="ws-diag-row"><strong>▶</strong> ${m.playOk}✓ ${m.playFail}✗ (${rate(m.playOk, m.playFail)}) · ${m.playSent}→sent ${m.playRecv}←in</div>
          <div class="ws-diag-row"><strong>⏸</strong> ${m.pauseOk}✓ ${m.pauseFail}✗ (${rate(m.pauseOk, m.pauseFail)}) · ${m.pauseSent}→ ${m.pauseRecv}←</div>
          <div class="ws-diag-row"><strong>⏩</strong> ${m.seekOk}✓ ${m.seekFail}✗ (${rate(m.seekOk, m.seekFail)}) · ${m.seekSent}→ ${m.seekRecv}←</div>
          ${s.testRunning ? '<div class="ws-diag-row ws-diag-warn">Sync test running…</div>' : ''}
          ${s.testResults?.done ? `<div class="ws-diag-row ws-diag-muted">Last test ${((Date.now() - s.testResults.start) / 1000).toFixed(1)}s${s.testResults.soakRounds > 1 ? ` ×${s.testResults.soakRounds}` : ''}</div>` : ''}
          ${testExtra}
        `;
      }
      if (peersEl) {
        const peers = Object.entries(s.peerReports);
        const sampleByPeer = diag.peerRecordingSamples.byClient;
        const sampleKeys = Object.keys(sampleByPeer);
        const peerSamplesLine =
          diagnosticsUiEnabled && sampleKeys.length > 0
            ? `<div class="ws-diag-row ws-diag-muted">Profiler peer samples (unified export): ${sampleKeys
                .map((cid) => {
                  const rows = sampleByPeer[cid];
                  const u = rows && rows[0] && typeof rows[0].fromUsername === 'string' ? rows[0].fromUsername : '';
                  return `${u || String(cid).slice(0, 8) + '…'} ×${rows?.length ?? 0}`;
                })
                .join(' · ')} · every ${DIAG_PEER_DEV_SHARE_MS / 1000}s while a dev peer records</div>`
            : '';
        const peerHint = diagnosticsUiEnabled
          ? ' Dev peers stream compact samples to the tab that is recording the video profiler; unified JSON includes them. Otherwise use Request peer report.'
          : '';
        peersEl.innerHTML =
          peerSamplesLine +
          (peers.length
            ? peers.map(([cid, r]) => {
              const ago = formatDiagTimeAgo(r.lastReceived);
              const pm = r.metrics || {};
              const pPlay = (pm.playOk || 0) + (pm.playFail || 0) > 0 ? ((pm.playOk || 0) / ((pm.playOk || 0) + (pm.playFail || 0)) * 100).toFixed(0) : '—';
              const pPause = (pm.pauseOk || 0) + (pm.pauseFail || 0) > 0 ? ((pm.pauseOk || 0) / ((pm.pauseOk || 0) + (pm.pauseFail || 0)) * 100).toFixed(0) : '—';
              const pSeek = (pm.seekOk || 0) + (pm.seekFail || 0) > 0 ? ((pm.seekOk || 0) / ((pm.seekOk || 0) + (pm.seekFail || 0)) * 100).toFixed(0) : '—';
              const dd = r.devDiag;
              let devLines = '';
              if (dd && typeof dd === 'object') {
                const tim = /** @type {{ lastRttMs?: number, lastRttSource?: string, driftEwmSec?: number }} */ (dd.timing || {});
                const tr = /** @type {{ connectionStatus?: string, transportPhase?: string }} */ (dd.transport || {});
                const cs = /** @type {{ spreadSec?: number, synced?: boolean }|null} */ (dd.clusterSync || null);
                const pb = /** @type {{ ct?: number|null, playing?: boolean|null, rs?: number|null }} */ (dd.playback || {});
                const vp = /** @type {{ snapshotCount?: number, recording?: boolean }|null} */ (dd.videoProfiler || null);
                const parts = [];
                if (typeof tim.lastRttMs === 'number') {
                  parts.push(
                    `RTT ${Math.round(tim.lastRttMs)}ms${tim.lastRttSource ? ` (${tim.lastRttSource})` : ''}`
                  );
                }
                if (typeof tim.driftEwmSec === 'number') parts.push(`drift EWM ${tim.driftEwmSec.toFixed(2)}s`);
                if (tr.connectionStatus) parts.push(`${tr.connectionStatus}${tr.transportPhase ? ` · ${tr.transportPhase}` : ''}`);
                if (cs && typeof cs.spreadSec === 'number') {
                  parts.push(`cluster Δ${cs.spreadSec.toFixed(2)}s${cs.synced ? ' ✓' : ''}`);
                }
                if (pb && pb.ct != null) {
                  parts.push(`t=${pb.ct}s${pb.playing ? ' ▶' : ' ⏸'}`);
                }
                if (vp && typeof vp.snapshotCount === 'number') {
                  parts.push(`profiler ${vp.snapshotCount} snaps${vp.recording ? ' · rec' : ''}`);
                }
                if (parts.length) {
                  devLines = `<div class="ws-diag-row ws-diag-muted" style="font-size:11px;line-height:1.35">${parts.join(' · ')}</div>`;
                }
              }
              return `<div class="ws-diag-peer">
                <div class="ws-diag-row">${r.username || cid} (${r.platform || '?'}) ${r.isHost ? '👑' : ''}</div>
                <div class="ws-diag-row ws-diag-muted">Play ${pPlay}% | Pause ${pPause}% | Seek ${pSeek}% | ${ago}</div>
                ${devLines}
              </div>`;
            }).join('')
            : `<div class="ws-diag-row ws-diag-muted">No peer report rows yet.${peerHint} Manual: Request peer report.</div>`);
      }
      if (remoteEl) {
        const rem = s.remoteApplyResults.slice(0, 10);
        remoteEl.innerHTML = rem.length
          ? rem.map(r => {
              const status = r.success ? '✓' : '✗';
              const ago = formatDiagTimeAgo(r.t);
              const cid = r.correlationId ? ` id:${String(r.correlationId).slice(0, 8)}…` : '';
              return `<div class="ws-diag-row ws-diag-${r.success ? 'ok' : 'err'}">${r.eventType}: ${r.fromUsername} → ${status} ${r.latency}ms (${r.platform})${cid} ${ago}</div>`;
            }).join('')
          : '<div class="ws-diag-row ws-diag-muted">When you send play/pause/seek, peers report back here</div>';
      }
      if (suggestionsEl) {
        suggestionsEl.innerHTML =
          syncTips.map((t) => `<div class="ws-diag-row ws-diag-${t.level}">${t.text}</div>`).join('') ||
          '<div class="ws-diag-row ws-diag-muted">No suggestions</div>';
      }
      if (eventsEl) {
        const filt = (s.eventFilter || '').trim().toLowerCase();
        const evs = s.events
          .filter((e) => !filt || `${e.type} ${e.fromUsername || ''} ${e.correlationId || ''}`.toLowerCase().includes(filt))
          .slice(0, 14);
        eventsEl.innerHTML = evs.length
          ? evs.map(e => {
              const type = e.type.replace('_', ' ');
              const extra = e.latency ? ` ${e.latency}ms` : e.drift ? ` drift ${e.drift.toFixed(1)}s` : '';
              const ago = formatDiagTimeAgo(e.t);
              const cid = e.correlationId ? ` [${String(e.correlationId).slice(0, 6)}]` : '';
              return `<div class="ws-diag-row ws-diag-sync-${e.type.replace(/_/g, '-')}">${type} ${e.fromUsername || ''}${cid} ${extra} ${ago}</div>`;
            }).join('')
          : '<div class="ws-diag-row ws-diag-muted">No sync events yet (adjust filter)</div>';
      }

      applyDiagSectionVisibility(catIssues);
      applyDashboardBlockVisibility();
      syncDashLayoutCheckboxesFromDiag();
      updateCompactConsoleStrip(catIssues);
    }
  }

  let diagRefreshInterval = null;

  function toggleDiagnostic() {
    if (!diagnosticsUiEnabled) return;
    diagVisible = !diagVisible;
    if (diagVisible) {
      if (!diagOverlay) injectDiagnosticOverlay();
      reparentPlayShareUiForFullscreen();
      diagOverlay.style.display = 'flex';
      diagOverlay.setAttribute('aria-hidden', 'false');
      try {
        chrome.runtime.sendMessage({ source: 'playshare', type: 'GET_DIAG' }, (res) => {
          mergeServiceWorkerDiag(res);
          updateDiagnosticOverlay();
        });
      } catch {}
      updateDiagnosticOverlay();
      diagRefreshInterval = setInterval(() => {
        try {
          chrome.runtime.sendMessage({ source: 'playshare', type: 'GET_DIAG' }, (res) => {
            mergeServiceWorkerDiag(res);
            updateDiagnosticOverlay();
          });
        } catch {
          updateDiagnosticOverlay();
        }
      }, 2000);
      sendDiagReport();
      sendBg({ source: 'playshare', type: 'DIAG_ROOM_TRACE_REQUEST' });
    } else if (diagOverlay) {
      closeDiagDashModal();
      diagOverlay.style.display = 'none';
      diagOverlay.setAttribute('aria-hidden', 'true');
      if (diagRefreshInterval) { clearInterval(diagRefreshInterval); diagRefreshInterval = null; }
    }
    if (siteSync.key === 'prime') syncPrimeTelemetryPolling();
  }

  function injectDiagnosticOverlay() {
    if (!diagnosticsUiEnabled || diagOverlay) return;

    diagOverlay = document.createElement('div');
    diagOverlay.id = 'ws-diag-overlay';
    diagOverlay.setAttribute('aria-hidden', 'true');
    diagOverlay.style.cssText = `
      display:none;position:fixed;z-index:2147483647;
      left:16px;bottom:16px;top:auto;right:auto;
      flex-direction:column;align-items:flex-start;gap:0;
      font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      font-size:13px;line-height:1.5;pointer-events:auto;
      max-width:calc(100vw - 24px);
    `;

    diagPanel = document.createElement('div');
    diagPanel.className = 'ws-diag-panel';
    diagPanel.setAttribute('role', 'dialog');
    diagPanel.setAttribute('aria-label', 'PlayShare sync analytics console');
    diagPanel.innerHTML = `
      <div class="ws-diag-header">
        <div class="ws-diag-header-accent" aria-hidden="true"></div>
        <div class="ws-diag-header-main">
          <button type="button" class="ws-diag-drag" title="Drag panel"><span class="ws-diag-drag-grip" aria-hidden="true"></span></button>
          <div class="ws-diag-header-center ws-diag-header-brand">
            <div class="ws-diag-header-title-row">
              <span class="ws-diag-title">Sync analytics</span>
              <span class="ws-diag-dev-badge">DEV</span>
            </div>
          </div>
          <div class="ws-diag-header-aside">
            <div class="ws-diag-header-icon-rail" role="toolbar" aria-label="Panel">
              <button type="button" class="ws-diag-icon-btn ws-diag-icon-customize" id="diagDashCustomizeOpen" title="Customize visible sections"></button>
              <button type="button" class="ws-diag-icon-btn" id="diagConsoleViewToggle" title="Dashboard ↔ compact strip" aria-pressed="true"><span class="ws-diag-icon-console-view" aria-hidden="true"></span></button>
              <button type="button" class="ws-diag-icon-btn" id="diagWideToggle" title="Wider panel"><span class="ws-diag-icon-wide" aria-hidden="true"></span></button>
              <button type="button" class="ws-diag-icon-btn ws-diag-minimize-btn" title="Minimize"><span class="ws-diag-icon-min" aria-hidden="true"></span></button>
              <button type="button" class="ws-diag-icon-btn ws-diag-close" title="Close (⌃⇧D)"><span class="ws-diag-icon-x" aria-hidden="true"></span></button>
            </div>
          </div>
        </div>
      </div>
      <div class="ws-diag-compact-root ws-diag-body-scroll">
        <div class="ws-diag-compact-components" role="group" aria-label="Sync, ad detection, video">
          <button type="button" class="ws-diag-comp-tile ws-diag-comp-ok" data-diag-comp="sync" title="Sync — open multiplayer &amp; transport in dashboard">
            <span class="ws-diag-comp-ic" aria-hidden="true"><svg class="ws-diag-comp-svg" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.96 7.96 0 0020 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.96 7.96 0 004 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg></span>
            <span class="ws-diag-comp-name">Sync</span>
            <span class="ws-diag-comp-line" data-diag-comp-line="sync"></span>
          </button>
          <button type="button" class="ws-diag-comp-tile ws-diag-comp-ok" data-diag-comp="ad" title="Ad detection — open Prime or technical in dashboard">
            <span class="ws-diag-comp-ic" aria-hidden="true"><svg class="ws-diag-comp-svg" viewBox="0 0 24 24"><path fill="currentColor" d="M18 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2zm0 14H6V6h12v12zm-8-9v6l4-3-4-3z"/></svg></span>
            <span class="ws-diag-comp-name">Ad</span>
            <span class="ws-diag-comp-line" data-diag-comp-line="ad"></span>
          </button>
          <button type="button" class="ws-diag-comp-tile ws-diag-comp-ok" data-diag-comp="video" title="Video — open technical in dashboard">
            <span class="ws-diag-comp-ic" aria-hidden="true"><svg class="ws-diag-comp-svg" viewBox="0 0 24 24"><path fill="currentColor" d="M17 10.5V7a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1v-3.5l4 4v-11l-4 4z"/></svg></span>
            <span class="ws-diag-comp-name">Video</span>
            <span class="ws-diag-comp-line" data-diag-comp-line="video"></span>
          </button>
        </div>
        <div class="ws-diag-compact-snaps">
          <button type="button" class="ws-diag-btn ws-diag-btn-sm ws-diag-compact-rec" id="diagCompactRecordToggle" aria-pressed="false" title="Start or stop session recording (video profiler — included in unified export)">
            <span class="ws-diag-rec-dot" aria-hidden="true"></span><span data-diag="compact-rec-label">Record</span>
          </button>
          ${
            siteSync.key === 'prime'
              ? `<button type="button" class="ws-diag-btn ws-diag-btn-sm ws-diag-btn-missed-ad diag-prime-missed-ad-btn" title="Missed-ad investigation only (not in unified export)">Ad snap</button>
            <button type="button" class="ws-diag-btn ws-diag-btn-sm ws-diag-btn-primary-compact" id="diagCompactUnifiedExport" title="Download full report: extension + recording + Prime">Export</button>`
              : '<button type="button" class="ws-diag-btn ws-diag-btn-sm ws-diag-btn-primary-compact" id="diagCompactExport" title="Download full report: extension + recording">Export</button>'
          }
        </div>
      </div>
      <div class="ws-diag-detailed-root ws-diag-body-scroll">
        <div data-diag="sync-stale" class="ws-diag-stale-banner" aria-live="polite"></div>

        <div data-diag-dash-block="overview">
        <div class="ws-diag-section-label">Session overview</div>
        <div data-diag="dash-summary" class="ws-diag-dash-summary"></div>
        </div>
        <div data-diag-dash-block="alerts">
        <div data-diag="dash-alerts" class="ws-diag-dash-alerts" aria-live="polite"></div>
        </div>

        <div data-diag-dash-block="actions" class="ws-diag-dash-actions-wrap">
        <div class="ws-diag-section-label">Record &amp; export</div>
        <div class="ws-diag-record-export-card">
          <p class="ws-diag-record-export-lead">Capture a <strong>single JSON</strong> for support: sync analytics, server connectivity, optional Prime digest, and <strong>video profiler snapshots</strong> from this session. Optional: <strong>Stop</strong> recording first to freeze the profiler timeline; export still works while recording.</p>
          <div class="ws-diag-workflow-steps">
            <div class="ws-diag-workflow-step">
              <div class="ws-diag-step-badge" aria-hidden="true">1</div>
              <div class="ws-diag-step-body">
                <div class="ws-diag-step-title">Record session</div>
                <div data-diag="video-profiler-status" class="ws-diag-row ws-diag-muted ws-diag-profiler-status-compact">Idle — press Start when the video is playing.</div>
                <div class="ws-diag-step-actions-row">
                  <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagVideoProfilerStart">Start recording</button>
                  <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagVideoProfilerStop">Stop</button>
                  <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagVideoProfilerMarker" title="Add a labeled point in the JSON timeline">Mark moment</button>
                  <button type="button" class="ws-diag-btn ws-diag-btn-ghost ws-diag-btn-sm" id="diagVideoProfilerClear" title="Discard captured snapshots and events">Clear session</button>
                </div>
              </div>
            </div>
            <div class="ws-diag-workflow-step">
              <div class="ws-diag-step-badge" aria-hidden="true">2</div>
              <div class="ws-diag-step-body">
                <div class="ws-diag-step-title">Save full report</div>
                <p class="ws-diag-step-hint ws-diag-muted">Refreshes RTT and server trace, then bundles everything into one file.</p>
                <div class="ws-diag-step-export-row">
                  <button type="button" class="ws-diag-btn" id="diagExportDownload" title="Unified JSON: extension + connectivity + profiler + Prime (on Prime)">Export report</button>
                  <details class="ws-diag-details ws-diag-details-more ws-diag-details-more-inline">
                    <summary class="ws-diag-more-summary">More formats &amp; tools</summary>
                    <div class="ws-diag-more-inner">
                      <div class="ws-diag-more-group">
                        <span class="ws-diag-more-label">Export</span>
                        <div class="ws-diag-actions ws-diag-actions-col">
                          <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagExportCopy" title="Same unified bundle as Export report">Copy JSON</button>
                          <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagExportCopyCompactProfiler" title="Unified JSON with trimmed profiler snapshots">Copy JSON (compact profiler)</button>
                          <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagExportDownloadWithProfilerFrame" title="Large file: embeds profiler JPEG when canvas is not DRM-blocked">Download + video frame</button>
                          <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagExportNarrativeCopy">Copy text summary</button>
                          <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagExportNarrativeDownload">Download .txt</button>
                        </div>
                      </div>
                      <div class="ws-diag-more-group">
                        <span class="ws-diag-more-label">Diagnostics</span>
                        <div class="ws-diag-actions ws-diag-actions-col">
                          <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagSyncTest">Sync test</button>
                          <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagSyncTestSoak">Sync test ×5</button>
                          <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagSyncReport">Request peer report</button>
                          <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagSyncReset">Reset metrics</button>
                          <button type="button" class="ws-diag-btn ws-diag-btn-ghost ws-diag-btn-sm" id="diagThemeToggle">Toggle theme</button>
                        </div>
                      </div>
                    </div>
                  </details>
                </div>
              </div>
            </div>
          </div>
        </div>
        </div>

        ${
          siteSync.key === 'prime'
            ? `<div class="ws-diag-prime-wrap" data-diag-sec-wrap="prime" data-diag-dash-block="prime">
          <div class="ws-diag-section-label ws-diag-sec-head-prime">
            <span>Prime</span>
            <span data-diag-sec-badge class="ws-diag-sec-badge ws-diag-badge-ok">OK</span>
          </div>
          <p class="ws-diag-sec-quiet" data-diag-quiet="prime">Prime player looks normal.</p>
          <div data-diag-body="prime">
            <div data-diag="sync-prime-summary" class="ws-diag-prime-summary"></div>
          </div>
          <div class="ws-diag-prime-snapshot-row">
            <button type="button" class="ws-diag-btn ws-diag-btn-sm ws-diag-btn-missed-ad diag-prime-missed-ad-btn" id="diagPrimeMissedAdCapture" title="Missed-ad investigation only — separate from unified export">Ad snapshot</button>
          </div>
          <div class="ws-diag-prime-status-compact ws-diag-muted" aria-live="polite">
            <span data-diag="prime-missed-ad-status"></span><span class="ws-diag-status-sep"> · </span><span>Prime player digest is included in <strong>Export report</strong> / <strong>Copy JSON</strong>.</span>
          </div>
        </div>`
            : ''
        }

        <div class="ws-diag-section-label ws-diag-section-label-tight">Categories</div>

        <details class="ws-diag-details" data-diag-sec="multiplayer" data-diag-dash-block="multiplayer" open>
          <summary class="ws-diag-sec-sum">
            <span class="ws-diag-sec-name">Multiplayer</span>
            <span data-diag-sec-badge class="ws-diag-sec-badge ws-diag-badge-ok">OK</span>
          </summary>
          <div class="ws-diag-card">
            <p class="ws-diag-sec-quiet" data-diag-quiet="multiplayer">No multiplayer sync issues detected.</p>
            <div data-diag-body="multiplayer">
              <span class="ws-diag-inline-label">Applies (this tab)</span>
              <div data-diag="sync-metrics" class="ws-diag-sync-block ws-diag-scrollbox-sm"></div>
              <span class="ws-diag-inline-label">Peers</span>
              <div data-diag="sync-peers" class="ws-diag-sync-block ws-diag-scrollbox-md"></div>
              <span class="ws-diag-inline-label">Remote results</span>
              <div data-diag="sync-remote-results" class="ws-diag-sync-block ws-diag-scrollbox-md"></div>
              <span class="ws-diag-inline-label">Suggestions</span>
              <div data-diag="sync-suggestions" class="ws-diag-sync-block ws-diag-scrollbox-sm"></div>
            </div>
          </div>
        </details>

        <details class="ws-diag-details" data-diag-sec="server" data-diag-dash-block="server" open>
          <summary class="ws-diag-sec-sum">
            <span class="ws-diag-sec-name">Server trace &amp; timeline</span>
            <span data-diag-sec-badge class="ws-diag-sec-badge ws-diag-badge-ok">OK</span>
          </summary>
          <div class="ws-diag-card">
            <p class="ws-diag-sec-quiet" data-diag-quiet="server">Transport and trace look healthy.</p>
            <div data-diag-body="server">
              <div class="ws-diag-actions">
                <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagRoomTraceRefresh">Refresh trace</button>
              </div>
              <span class="ws-diag-inline-label">Server</span>
              <div data-diag="sync-server-trace" class="ws-diag-sync-block ws-diag-scrollbox"></div>
              <span class="ws-diag-inline-label">Local timeline</span>
              <div data-diag="sync-timeline" class="ws-diag-sync-block ws-diag-scrollbox"></div>
            </div>
          </div>
        </details>

        <details class="ws-diag-details" data-diag-sec="technical" data-diag-dash-block="technical" open>
          <summary class="ws-diag-sec-sum">
            <span class="ws-diag-sec-name">Technical</span>
            <span data-diag-sec-badge class="ws-diag-sec-badge ws-diag-badge-ok">OK</span>
          </summary>
          <div class="ws-diag-card">
            <p class="ws-diag-sec-quiet" data-diag-quiet="technical">Timing, video, and counters look normal.</p>
            <div data-diag-body="technical">
              <span class="ws-diag-inline-label">Timing</span>
              <div data-diag="sync-timing" class="ws-diag-sync-block"></div>
              <span class="ws-diag-inline-label">Profile</span>
              <div data-diag="sync-profile-line" class="ws-diag-sync-block ws-diag-muted"></div>
              <span class="ws-diag-inline-label">Transport &amp; counters</span>
              <div data-diag="sync-extension-bridge" class="ws-diag-sync-block ws-diag-tech-dense"></div>
              <span class="ws-diag-inline-label">Video</span>
              <div data-diag="sync-video-health" class="ws-diag-sync-block"></div>
              <div class="ws-diag-sync-block ws-diag-muted" style="font-size:11px;line-height:1.45;margin-bottom:8px">
                <strong>Video profiler</strong> — use <strong>Record &amp; export</strong> above (steps 1–2). With other dev clients in the room, peer samples during recording show under <strong>Multiplayer → Peers</strong>.
              </div>
              <span class="ws-diag-inline-label">Device &amp; cluster</span>
              <div data-diag="sync-this-device" class="ws-diag-sync-block"></div>
              <span class="ws-diag-inline-label">findVideo</span>
              <div data-diag="sync-findvideo" class="ws-diag-sync-block"></div>
              <span class="ws-diag-inline-label">Timeupdate jumps</span>
              <div data-diag="sync-tujumps" class="ws-diag-sync-block ws-diag-scrollbox-sm"></div>
            </div>
          </div>
        </details>

        <details class="ws-diag-details" data-diag-sec="logs" data-diag-dash-block="logs" open>
          <summary class="ws-diag-sec-sum">
            <span class="ws-diag-sec-name">Logs &amp; sidebar</span>
            <span data-diag-sec-badge class="ws-diag-sec-badge ws-diag-badge-ok">OK</span>
          </summary>
          <div class="ws-diag-card">
            <p class="ws-diag-sec-quiet" data-diag-quiet="logs">No errors and sidebar is available.</p>
            <div data-diag-body="logs">
              <span class="ws-diag-inline-label">Sidebar</span>
              <div data-diag="sidebar" class="ws-diag-sidebar"></div>
              <div class="ws-diag-actions">
                <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagForceOpen">Force open sidebar</button>
              </div>
              <span class="ws-diag-inline-label">Sync event log</span>
              <label class="ws-diag-filter-label" for="diagEventFilter">Filter</label>
              <input type="search" id="diagEventFilter" class="ws-diag-filter" placeholder="play_recv, user, id…" autocomplete="off" />
              <div data-diag="sync-events" class="ws-diag-sync-block ws-diag-scrollbox-lg ws-diag-events"></div>
              <span class="ws-diag-inline-label">Recent messages</span>
              <div data-diag="messages" class="ws-diag-list ws-diag-scrollbox-sm"></div>
              <span class="ws-diag-inline-label">Errors</span>
              <div data-diag="errors" class="ws-diag-list ws-diag-scrollbox-sm"></div>
            </div>
          </div>
        </details>
      </div>
      <div id="diagDashModalRoot" class="ws-diag-dash-modal-root" hidden aria-hidden="true">
        <div class="ws-diag-dash-modal-backdrop" data-diag-dash-modal-dismiss tabindex="-1" aria-hidden="true"></div>
        <div class="ws-diag-dash-modal-panel" role="dialog" aria-modal="true" aria-labelledby="diagDashModalTitle" tabindex="-1">
          <div class="ws-diag-dash-modal-head">
            <h2 id="diagDashModalTitle" class="ws-diag-dash-modal-title">Customize dashboard</h2>
            <button type="button" class="ws-diag-dash-modal-x" id="diagDashCustomizeClose" aria-label="Close">×</button>
          </div>
          <p class="ws-diag-dash-modal-lead">Turn sections on or off in the detailed view. You can always reopen this from the header.</p>
          <div class="ws-diag-dash-toggles ws-diag-dash-modal-toggles" data-diag-dash-customize>
            <label class="ws-diag-dash-toggle"><input type="checkbox" data-dash-toggle="overview" checked /> Session overview</label>
            <label class="ws-diag-dash-toggle"><input type="checkbox" data-dash-toggle="alerts" checked /> Alerts</label>
            ${siteSync.key === 'prime' ? '<label class="ws-diag-dash-toggle"><input type="checkbox" data-dash-toggle="prime" checked /> Prime</label>' : ''}
            <label class="ws-diag-dash-toggle"><input type="checkbox" data-dash-toggle="actions" checked /> Record &amp; export</label>
            <label class="ws-diag-dash-toggle"><input type="checkbox" data-dash-toggle="multiplayer" checked /> Multiplayer</label>
            <label class="ws-diag-dash-toggle"><input type="checkbox" data-dash-toggle="server" checked /> Server &amp; timeline</label>
            <label class="ws-diag-dash-toggle"><input type="checkbox" data-dash-toggle="technical" checked /> Technical</label>
            <label class="ws-diag-dash-toggle"><input type="checkbox" data-dash-toggle="logs" checked /> Logs &amp; sidebar</label>
          </div>
          <div class="ws-diag-dash-modal-footer">
            <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagDashModalReset">Reset all sections</button>
            <button type="button" class="ws-diag-btn ws-diag-btn-sm" id="diagDashCustomizeDone">Done</button>
          </div>
        </div>
      </div>
    `;

    const diagDashModalOnEscape = (e) => {
      if (e.key !== 'Escape' || !diagVisible) return;
      const root = diagPanel.querySelector('#diagDashModalRoot');
      if (!root || root.hasAttribute('hidden')) return;
      e.preventDefault();
      e.stopPropagation();
      closeDiagDashModal();
    };
    document.addEventListener('keydown', diagDashModalOnEscape);

    const closeBtn = diagPanel.querySelector('.ws-diag-close');
    closeBtn.addEventListener('click', toggleDiagnostic);

    diagPanel.querySelector('.ws-diag-minimize-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      diag.panelMinimized = !diag.panelMinimized;
      if (diag.panelMinimized) closeDiagDashModal();
      diagPanel.classList.toggle('ws-diag-minimized', diag.panelMinimized);
    });

    diagPanel.querySelector('#diagWideToggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      diag.overlayWide = !diag.overlayWide;
      diagPanel.classList.toggle('ws-diag-wide', diag.overlayWide);
    });

    diagPanel.querySelector('#diagConsoleViewToggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      setDiagConsoleView(diag.consoleView === 'compact' ? 'detailed' : 'compact');
    });

    diagPanel.querySelector('#diagCompactExport')?.addEventListener('click', () => {
      downloadDiagExport().catch(() => diagLog('ERROR', { message: 'Export failed' }));
    });
    diagPanel.querySelector('#diagCompactUnifiedExport')?.addEventListener('click', () => {
      downloadDiagExport().catch(() => diagLog('ERROR', { message: 'Export failed' }));
    });
    diagPanel.querySelector('#diagCompactRecordToggle')?.addEventListener('click', () => {
      try {
        if (getVideoProfiler().isRecording()) stopVideoProfilerSession();
        else startVideoProfilerSession();
      } catch {
        diagLog('ERROR', { message: 'Profiler toggle failed' });
      }
      updateDiagnosticOverlay();
    });

    diagPanel.querySelector('#diagDashCustomizeOpen')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openDiagDashModal();
    });
    diagPanel.querySelector('#diagDashCustomizeClose')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeDiagDashModal();
    });
    diagPanel.querySelector('#diagDashCustomizeDone')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeDiagDashModal();
    });
    diagPanel.querySelector('#diagDashModalReset')?.addEventListener('click', (e) => {
      e.stopPropagation();
      for (const k of Object.keys(diag.dashBlocks)) diag.dashBlocks[k] = true;
      persistDiagConsolePrefs();
      applyDashboardBlockVisibility();
      syncDashLayoutCheckboxesFromDiag();
    });
    diagPanel.querySelector('#diagDashModalRoot')?.addEventListener('click', (e) => {
      const t = e.target;
      if (t instanceof Element && t.closest('[data-diag-dash-modal-dismiss]')) closeDiagDashModal();
    });

    diagPanel.addEventListener('change', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement) || t.type !== 'checkbox') return;
      const key = t.getAttribute('data-dash-toggle');
      if (!key || !(key in diag.dashBlocks)) return;
      diag.dashBlocks[key] = t.checked;
      persistDiagConsolePrefs();
      applyDashboardBlockVisibility();
    });

    diagPanel.addEventListener('click', (e) => {
      const compBtn = e.target.closest('[data-diag-comp]');
      if (compBtn && diagPanel.contains(compBtn)) {
        const comp = compBtn.getAttribute('data-diag-comp');
        if (!comp) return;
        e.preventDefault();
        setDiagConsoleView('detailed');
        const openSec = (sec) => {
          const det = diagPanel.querySelector(`details[data-diag-sec="${sec}"]`);
          if (det) {
            det.open = true;
            det.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
        };
        if (comp === 'sync') {
          openSec('multiplayer');
          return;
        }
        if (comp === 'ad') {
          if (siteSync.key === 'prime') {
            diagPanel.querySelector('[data-diag-sec-wrap="prime"]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          } else {
            openSec('technical');
          }
          return;
        }
        if (comp === 'video') {
          openSec('technical');
        }
        return;
      }
    });

    const dragBtn = diagPanel.querySelector('.ws-diag-drag');
    dragBtn?.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = diagOverlay.getBoundingClientRect();
      diagDrag.active = true;
      diagDrag.dx = e.clientX - r.left;
      diagDrag.dy = e.clientY - r.top;
    });

    document.addEventListener('mousemove', (e) => {
      if (!diagDrag.active || !diagOverlay) return;
      const nx = Math.max(4, Math.min(window.innerWidth - 80, e.clientX - diagDrag.dx));
      const ny = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - diagDrag.dy));
      diagOverlay.style.left = `${nx}px`;
      diagOverlay.style.top = `${ny}px`;
      diagOverlay.style.bottom = 'auto';
      diagOverlay.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { diagDrag.active = false; });

    const forceOpenBtn = diagPanel.querySelector('#diagForceOpen');
    if (forceOpenBtn) {
      forceOpenBtn.addEventListener('click', () => {
        if (!roomState) {
          diagLog('ERROR', { message: 'No room — join a room first' });
        } else {
          openSidebar();
          diagLog('SIDEBAR_OPEN', { source: 'force' });
        }
        updateDiagnosticOverlay();
      });
    }

    diagPanel.querySelector('#diagEventFilter')?.addEventListener('input', (ev) => {
      diag.sync.eventFilter = ev.target.value || '';
      updateDiagnosticOverlay();
    });
    diagPanel.querySelector('#diagRoomTraceRefresh')?.addEventListener('click', () => {
      sendBg({ source: 'playshare', type: 'DIAG_ROOM_TRACE_REQUEST' });
    });
    const primeMissedAdCaptureHandler = () => {
      if (siteSync.key !== 'prime') return;
      try {
        captureVideoHealthSnapshot();
        const autoCaptureContext = buildPrimeSnapshotAutoContext();
        const payload = capturePrimeMissedAdDebugPayload({
          getVideo: () => findVideo() || video,
          localAdBreakActive,
          inRoom: !!roomState,
          videoHealth: diag.videoHealthLast,
          autoCaptureContext
        });
        const json = JSON.stringify(payload, null, 2);
        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const rc = autoCaptureContext.roomCodeShort || 'noroom';
        a.download = `playshare-prime-missed-ad-${rc}-${autoCaptureContext.capturedAtMs}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        const finish = (clipboardOk) => {
          diag.lastPrimeMissedAdCapture = { at: Date.now(), clipboardOk };
          diagLog('DIAG_EXPORT', { primeMissedAdCapture: true, clipboardOk });
          updateDiagnosticOverlay();
        };
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(json).then(() => finish(true), () => finish(false));
        } else {
          finish(false);
        }
      } catch (e) {
        diagLog('ERROR', { message: e && e.message ? e.message : String(e) });
        updateDiagnosticOverlay();
      }
    };
    diagPanel.querySelectorAll('.diag-prime-missed-ad-btn').forEach((b) => {
      b.addEventListener('click', primeMissedAdCaptureHandler);
    });

    diagPanel.querySelector('#diagExportCopy')?.addEventListener('click', () => {
      copyDiagExport().catch(() => diagLog('ERROR', { message: 'Export failed' }));
    });
    diagPanel.querySelector('#diagExportDownload')?.addEventListener('click', () => {
      downloadDiagExport().catch(() => diagLog('ERROR', { message: 'Export failed' }));
    });
    diagPanel.querySelector('#diagExportCopyCompactProfiler')?.addEventListener('click', () => {
      copyUnifiedExportCompactProfiler().catch(() => diagLog('ERROR', { message: 'Export failed' }));
    });
    diagPanel.querySelector('#diagExportDownloadWithProfilerFrame')?.addEventListener('click', () => {
      downloadUnifiedExportWithProfilerFrame().catch(() => diagLog('ERROR', { message: 'Export failed' }));
    });
    diagPanel.querySelector('#diagExportNarrativeCopy')?.addEventListener('click', () => {
      copyDiagNarrative().catch(() => diagLog('ERROR', { message: 'Export failed' }));
    });
    diagPanel.querySelector('#diagExportNarrativeDownload')?.addEventListener('click', () => {
      downloadDiagNarrativeTxt().catch(() => diagLog('ERROR', { message: 'Export failed' }));
    });
    diagPanel.querySelector('#diagThemeToggle')?.addEventListener('click', () => {
      diag.theme = diag.theme === 'dark' ? 'light' : 'dark';
      diagPanel.classList.toggle('ws-diag-light', diag.theme === 'light');
      updateDiagnosticOverlay();
    });

    const diagSyncTest = diagPanel.querySelector('#diagSyncTest');
    if (diagSyncTest) diagSyncTest.addEventListener('click', () => runSyncTest(1));
    diagPanel.querySelector('#diagSyncTestSoak')?.addEventListener('click', () => runSyncTest(5));
    const diagSyncReport = diagPanel.querySelector('#diagSyncReport');
    if (diagSyncReport) diagSyncReport.addEventListener('click', () => { sendDiagReport(); updateDiagnosticOverlay(); });
    const diagSyncReset = diagPanel.querySelector('#diagSyncReset');
    if (diagSyncReset) diagSyncReset.addEventListener('click', resetSyncMetrics);

    diagPanel.querySelector('#diagVideoProfilerStart')?.addEventListener('click', () => {
      startVideoProfilerSession();
    });
    diagPanel.querySelector('#diagVideoProfilerStop')?.addEventListener('click', () => {
      stopVideoProfilerSession();
    });
    diagPanel.querySelector('#diagVideoProfilerMarker')?.addEventListener('click', () => {
      if (!getVideoProfiler().isRecording()) return;
      const raw = typeof window !== 'undefined' && window.prompt ? window.prompt('Marker label (optional):', '') : '';
      const note = raw != null ? String(raw).trim() : '';
      getVideoProfiler().dropMarker(note || undefined);
      updateDiagnosticOverlay();
    });
    diagPanel.querySelector('#diagVideoProfilerClear')?.addEventListener('click', () => {
      clearVideoProfilerSession();
    });

    diagOverlay.appendChild(diagPanel);
    diagPanel.classList.toggle('ws-diag-light', diag.theme === 'light');
    diagPanel.classList.toggle('ws-diag-minimized', diag.panelMinimized);
    diagPanel.classList.toggle('ws-diag-wide', diag.overlayWide);
    setDiagConsoleView(diag.consoleView);
    document.body.appendChild(diagOverlay);
    reparentPlayShareUiForFullscreen();

    const diagStyles = document.createElement('style');
    diagStyles.textContent = `
      .ws-diag-panel {
        --ws-diag-bg0:#0a0c10;
        --ws-diag-bg1:#12151c;
        --ws-diag-border:rgba(56,189,248,0.14);
        --ws-diag-text:#e8edf4;
        --ws-diag-muted:#8b95a8;
        --ws-diag-accent:#22d3ee;
        --ws-diag-accent-dim:rgba(34,211,238,0.12);
        --ws-diag-violet:#a78bfa;
        --ws-diag-surface:rgba(255,255,255,0.035);
        --ws-diag-surface2:rgba(255,255,255,0.055);
        background:linear-gradient(165deg, rgba(18,21,28,0.98) 0%, var(--ws-diag-bg0) 48%, #0d1016 100%);
        color:var(--ws-diag-text);
        border:1px solid var(--ws-diag-border);
        border-radius:16px;
        box-shadow:
          0 0 0 1px rgba(0,0,0,0.5),
          0 24px 48px -12px rgba(0,0,0,0.65),
          0 0 80px -20px rgba(34,211,238,0.08);
        position:relative;
        width:min(420px,calc(100vw - 20px));max-height:min(78vh,720px);
        overflow:hidden;display:flex;flex-direction:column;
        font-variant-numeric:tabular-nums;
        backdrop-filter:saturate(1.15) blur(20px);
        -webkit-backdrop-filter:saturate(1.15) blur(20px);
      }
      .ws-diag-panel.ws-diag-wide {
        width:min(720px,calc(100vw - 20px));max-height:min(85vh,800px);
      }
      .ws-diag-panel.ws-diag-view-compact {
        width:min(252px,calc(100vw - 20px));
        max-height:min(280px,48vh);
      }
      .ws-diag-panel.ws-diag-view-compact.ws-diag-wide {
        width:min(280px,calc(100vw - 20px));
      }
      .ws-diag-panel.ws-diag-view-compact .ws-diag-header-brand { display:none !important; }
      .ws-diag-panel.ws-diag-view-compact .ws-diag-header-accent { height:1px; }
      .ws-diag-panel.ws-diag-view-compact #diagDashCustomizeOpen { display:none !important; }
      .ws-diag-panel.ws-diag-view-compact #diagWideToggle { display:none !important; }
      .ws-diag-panel.ws-diag-view-compact .ws-diag-header {
        padding:5px 6px 5px;
        border-bottom-color:rgba(255,255,255,0.06);
      }
      .ws-diag-panel.ws-diag-view-compact .ws-diag-header-main {
        align-items:center;gap:6px;width:100%;
      }
      .ws-diag-panel.ws-diag-view-compact .ws-diag-drag {
        width:28px;height:28px;border-radius:8px;
      }
      .ws-diag-panel.ws-diag-view-compact .ws-diag-header-aside { margin-left:auto; }
      .ws-diag-panel.ws-diag-view-compact .ws-diag-header-icon-rail { padding:2px;gap:1px;border-radius:9px; }
      .ws-diag-panel.ws-diag-view-compact .ws-diag-header-icon-rail .ws-diag-icon-btn {
        width:28px;height:28px;border-radius:7px;
      }
      .ws-diag-panel.ws-diag-view-compact .ws-diag-compact-root { padding:8px 8px 10px; }
      .ws-diag-panel.ws-diag-view-detailed .ws-diag-compact-root { display:none !important; }
      .ws-diag-panel.ws-diag-view-compact .ws-diag-detailed-root { display:none !important; }
      .ws-diag-icon-console-view { display:inline-block; }
      .ws-diag-icon-console-view::after { content:'▭';font-size:15px;line-height:1;opacity:0.9; }
      .ws-diag-panel.ws-diag-view-compact .ws-diag-icon-console-view::after { content:'⊞'; }
      .ws-diag-compact-root.ws-diag-body-scroll,
      .ws-diag-detailed-root.ws-diag-body-scroll {
        flex:1;min-height:0;
      }
      .ws-diag-compact-root { padding:12px 14px 14px; }
      .ws-diag-compact-components {
        display:flex;flex-direction:row;justify-content:stretch;gap:6px;margin-bottom:10px;
      }
      .ws-diag-comp-tile {
        flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:4px;
        padding:8px 4px 6px;border-radius:10px;border:2px solid transparent;cursor:pointer;
        background:var(--ws-diag-surface);color:#e2e8f0;
        transition:border-color 0.15s,background 0.15s,box-shadow 0.15s,transform 0.12s,color 0.15s;
      }
      .ws-diag-comp-tile:hover { transform:translateY(-1px); }
      .ws-diag-comp-tile.ws-diag-comp-ok {
        border-color:rgba(52,211,153,0.5);
        box-shadow:0 0 0 1px rgba(52,211,153,0.08);
      }
      .ws-diag-comp-tile.ws-diag-comp-warn {
        border-color:rgba(250,204,21,0.85);
        background:rgba(66,52,11,0.28);
        color:#fef9c3;
        box-shadow:0 0 12px -5px rgba(250,204,21,0.4);
      }
      .ws-diag-comp-ic { display:flex;align-items:center;justify-content:center; }
      .ws-diag-comp-svg {
        width:20px;height:20px;display:block;opacity:0.9;pointer-events:none;
      }
      .ws-diag-comp-tile.ws-diag-comp-warn .ws-diag-comp-svg { opacity:1; }
      .ws-diag-comp-name {
        font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;
        color:var(--ws-diag-muted);
      }
      .ws-diag-comp-tile.ws-diag-comp-warn .ws-diag-comp-name { color:#fde68a; }
      .ws-diag-comp-line {
        font-size:9px;line-height:1.25;text-align:center;word-break:break-word;
        color:#94a3b8;max-width:100%;padding:0 2px;
      }
      .ws-diag-comp-tile.ws-diag-comp-warn .ws-diag-comp-line { color:#fef3c7; }
      .ws-diag-compact-snaps { display:flex;flex-wrap:wrap;gap:8px;justify-content:center;align-items:center; }
      .ws-diag-compact-rec {
        display:inline-flex;align-items:center;gap:6px;
        border:1px solid rgba(255,255,255,0.14);background:rgba(0,0,0,0.35);
      }
      .ws-diag-compact-rec .ws-diag-rec-dot {
        width:8px;height:8px;border-radius:50%;
        background:#64748b;box-shadow:0 0 0 2px rgba(100,116,139,0.35);
        transition:background 0.2s,box-shadow 0.2s;
      }
      .ws-diag-compact-rec.ws-diag-compact-rec-active {
        border-color:rgba(248,113,113,0.45);background:rgba(127,29,29,0.22);
      }
      .ws-diag-compact-rec.ws-diag-compact-rec-active .ws-diag-rec-dot {
        background:#f87171;box-shadow:0 0 0 2px rgba(248,113,113,0.4);
        animation:ws-diag-rec-pulse 1.4s ease-in-out infinite;
      }
      @keyframes ws-diag-rec-pulse {
        0%,100% { opacity:1; }
        50% { opacity:0.55; }
      }
      .ws-diag-btn-primary-compact {
        font-weight:600;
        border-color:rgba(129,140,248,0.45);
        background:linear-gradient(180deg, rgba(99,102,241,0.35) 0%, rgba(79,70,229,0.22) 100%);
      }
      .ws-diag-record-export-card {
        border-radius:14px;
        border:1px solid rgba(255,255,255,0.1);
        background:linear-gradient(165deg, rgba(30,27,75,0.35) 0%, rgba(15,23,42,0.5) 55%, rgba(15,23,42,0.35) 100%);
        padding:14px 16px 16px;
        margin:0 0 18px;
        box-shadow:0 0 28px -12px rgba(99,102,241,0.25);
      }
      .ws-diag-record-export-lead { font-size:11.5px;line-height:1.55;color:var(--ws-diag-muted);margin:0 0 14px; }
      .ws-diag-record-export-lead strong { color:#e2e8f0;font-weight:600; }
      .ws-diag-workflow-steps { display:flex;flex-direction:column;gap:16px; }
      .ws-diag-workflow-step {
        display:grid;grid-template-columns:34px 1fr;gap:4px 14px;align-items:start;
      }
      .ws-diag-step-badge {
        width:30px;height:30px;border-radius:50%;
        display:flex;align-items:center;justify-content:center;
        font-size:13px;font-weight:800;
        background:rgba(99,102,241,0.22);
        border:1px solid rgba(129,140,248,0.42);
        color:#c7d2fe;margin-top:2px;
      }
      .ws-diag-step-title { font-size:12.5px;font-weight:700;color:#f1f5f9;margin-bottom:4px; }
      .ws-diag-step-hint { font-size:11px;margin:0 0 8px;line-height:1.45; }
      .ws-diag-step-actions-row, .ws-diag-step-export-row {
        display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;
      }
      .ws-diag-profiler-status-compact { font-size:11px;line-height:1.45;margin-bottom:2px; }
      .ws-diag-details-more-inline { flex:1;min-width:160px;max-width:100%; }
      .ws-diag-dash-modal-root[hidden] { display:none !important; }
      .ws-diag-dash-modal-root:not([hidden]) {
        position:absolute;inset:0;z-index:30;
        display:flex;align-items:flex-end;justify-content:center;
        padding:10px;padding-bottom:14px;box-sizing:border-box;
        pointer-events:auto;
      }
      .ws-diag-dash-modal-backdrop {
        position:absolute;inset:0;
        background:rgba(2,6,12,0.62);
        backdrop-filter:blur(6px) saturate(1.1);
        -webkit-backdrop-filter:blur(6px) saturate(1.1);
      }
      .ws-diag-dash-modal-panel {
        position:relative;z-index:1;
        width:100%;max-width:380px;max-height:min(70vh,480px);
        overflow:auto;
        border-radius:14px;
        background:linear-gradient(180deg, rgba(22,26,34,0.98) 0%, rgba(14,17,24,0.99) 100%);
        border:1px solid rgba(255,255,255,0.1);
        box-shadow:0 20px 50px rgba(0,0,0,0.55),0 0 0 1px rgba(34,211,238,0.06);
        padding:16px 18px 14px;
      }
      .ws-diag-dash-modal-head {
        display:flex;align-items:flex-start;justify-content:space-between;gap:12px;
        margin-bottom:8px;
      }
      .ws-diag-dash-modal-title {
        margin:0;font-size:15px;font-weight:700;letter-spacing:-0.02em;color:#f1f5f9;line-height:1.25;
      }
      .ws-diag-dash-modal-x {
        flex-shrink:0;width:32px;height:32px;margin:-6px -4px 0 0;border-radius:10px;border:none;
        background:transparent;color:var(--ws-diag-muted);font-size:22px;line-height:1;cursor:pointer;
        display:flex;align-items:center;justify-content:center;
        transition:color 0.15s,background 0.15s;
      }
      .ws-diag-dash-modal-x:hover { color:#f8fafc;background:rgba(255,255,255,0.06); }
      .ws-diag-dash-modal-lead {
        margin:0 0 12px;font-size:11.5px;line-height:1.45;color:var(--ws-diag-muted);
      }
      .ws-diag-dash-modal-toggles { margin-bottom:14px; }
      .ws-diag-dash-modal-footer {
        display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;
        padding-top:12px;border-top:1px solid rgba(255,255,255,0.06);
      }
      .ws-diag-dash-toggles {
        display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;font-size:11px;
      }
      @media (max-width:400px) {
        .ws-diag-dash-toggles { grid-template-columns:1fr; }
      }
      .ws-diag-dash-toggle {
        display:flex;align-items:center;gap:8px;cursor:pointer;color:#b8c2d4;
      }
      .ws-diag-dash-toggle input { flex-shrink:0; }
      .ws-diag-header-accent {
        height:2px;
        background:linear-gradient(90deg, #22d3ee 0%, #818cf8 50%, #e879f9 100%);
        opacity:0.95;
      }
      .ws-diag-header {
        flex-shrink:0;
        padding:8px 10px 8px;
        background:linear-gradient(185deg, rgba(255,255,255,0.05) 0%, transparent 100%);
        border-bottom:1px solid rgba(255,255,255,0.07);
      }
      .ws-diag-header-main {
        display:flex;align-items:center;gap:10px;flex-wrap:wrap;
      }
      .ws-diag-drag {
        flex-shrink:0;width:30px;height:30px;border-radius:9px;
        border:1px solid rgba(255,255,255,0.08);
        background:var(--ws-diag-surface);
        color:var(--ws-diag-muted);
        cursor:grab;padding:0;display:flex;align-items:center;justify-content:center;
        transition:background 0.15s,border-color 0.15s,color 0.15s;
      }
      .ws-diag-drag:hover { border-color:rgba(34,211,238,0.35);color:var(--ws-diag-accent);background:var(--ws-diag-accent-dim); }
      .ws-diag-drag:active { cursor:grabbing; }
      .ws-diag-drag-grip {
        width:12px;height:16px;
        opacity:0.55;
        background:repeating-linear-gradient(
          180deg,
          currentColor 0px,
          currentColor 2px,
          transparent 2px,
          transparent 5px
        );
        border-radius:1px;
      }
      .ws-diag-header-center { flex:1;min-width:0; }
      .ws-diag-header-title-row {
        display:flex;align-items:center;gap:8px;flex-wrap:wrap;
      }
      .ws-diag-title {
        font-weight:700;font-size:14px;letter-spacing:-0.03em;
        color:#f8fafc;
      }
      .ws-diag-dev-badge {
        font-size:7px;font-weight:800;letter-spacing:0.12em;padding:3px 7px;border-radius:999px;
        background:linear-gradient(135deg, #6366f1 0%, #4f46e5 55%, #4338ca 100%);
        color:#eef2ff;
        box-shadow:0 1px 0 rgba(255,255,255,0.15) inset,0 2px 8px rgba(79,70,229,0.35);
      }
      .ws-diag-header-aside {
        display:flex;flex-direction:row;align-items:center;gap:8px;flex-shrink:0;margin-left:auto;
      }
      .ws-diag-icon-customize::after {
        content:'⚙';font-size:15px;line-height:1;opacity:0.88;
      }
      .ws-diag-header-icon-rail {
        display:flex;align-items:center;gap:2px;
        padding:3px;border-radius:10px;
        background:rgba(0,0,0,0.28);
        border:1px solid rgba(255,255,255,0.06);
      }
      .ws-diag-header-icon-rail .ws-diag-icon-btn {
        width:30px;height:30px;border-radius:8px;border:none;
        background:transparent;
      }
      .ws-diag-header-icon-rail .ws-diag-icon-btn:hover {
        background:rgba(255,255,255,0.08);
      }
      .ws-diag-icon-btn {
        width:34px;height:34px;border-radius:10px;
        border:1px solid rgba(255,255,255,0.08);
        background:var(--ws-diag-surface);
        color:var(--ws-diag-muted);
        cursor:pointer;padding:0;
        display:flex;align-items:center;justify-content:center;
        transition:background 0.15s,border-color 0.15s,color 0.15s,transform 0.12s;
      }
      .ws-diag-icon-btn:hover {
        color:#f1f5f9;
        border-color:rgba(34,211,238,0.4);
        background:var(--ws-diag-accent-dim);
        transform:translateY(-1px);
      }
      .ws-diag-icon-wide::after { content:'⤢';font-size:15px;line-height:1;opacity:0.9; }
      .ws-diag-icon-min::after { content:'―';font-size:13px;line-height:1;opacity:0.85;font-weight:600; }
      .ws-diag-icon-x::after { content:'×';font-size:20px;line-height:1;font-weight:300; }
      .ws-diag-panel kbd {
        display:inline-block;padding:2px 6px;margin:0 2px;font-size:10px;font-family:ui-monospace,monospace;
        background:var(--ws-diag-surface2);border:1px solid rgba(255,255,255,0.1);border-radius:6px;
        color:#cbd5e1;
      }
      .ws-diag-section-label {
        font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.11em;
        color:var(--ws-diag-muted);margin:4px 0 10px;
      }
      .ws-diag-dash-summary {
        padding:12px 12px;border-radius:12px;margin-bottom:10px;
        background:var(--ws-diag-surface2);
        border:1px solid rgba(255,255,255,0.06);
        border-left:3px solid var(--ws-diag-accent);
        box-shadow:0 1px 0 rgba(255,255,255,0.04) inset;
      }
      .ws-diag-session-grid {
        display:grid;
        grid-template-columns:1fr 1fr;
        gap:8px 10px;
        margin-bottom:10px;
        font-size:11px;line-height:1.45;color:#dce3ee;
      }
      @media (max-width:360px) {
        .ws-diag-session-grid { grid-template-columns:1fr; }
        .ws-diag-session-span2 { grid-column:1; }
      }
      .ws-diag-session-cell {
        background:rgba(0,0,0,0.22);
        border-radius:10px;
        padding:8px 10px;
        border:1px solid rgba(255,255,255,0.06);
      }
      .ws-diag-session-span2 { grid-column:1/-1; }
      .ws-diag-session-label {
        display:block;
        font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:0.1em;
        color:var(--ws-diag-muted);
        margin-bottom:5px;
      }
      .ws-diag-session-sub { font-size:10px;margin-top:4px;line-height:1.4; }
      .ws-diag-overview-chips { margin-top:2px; }
      .ws-diag-overview-compact {
        display:flex;flex-wrap:wrap;align-items:center;gap:10px 12px;
      }
      .ws-diag-overview-meta {
        font-size:12px;line-height:1.45;color:#dce3ee;
      }
      .ws-diag-overview-hint {
        font-size:11px;line-height:1.45;margin-top:10px;padding-top:10px;
        border-top:1px solid rgba(255,255,255,0.06);
      }
      .ws-diag-section-label-tight { margin-top:12px;margin-bottom:8px; }
      .ws-diag-sec-head-prime {
        display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;
        margin-bottom:8px;
      }
      .ws-diag-sec-head-prime .ws-diag-prime-label { font-size:13px;font-weight:600;color:#d1dae6;margin:0; }
      .ws-diag-details > summary.ws-diag-sec-sum {
        display:flex;flex-wrap:wrap;align-items:center;gap:10px;
      }
      .ws-diag-details > summary.ws-diag-sec-sum::after { margin-left:auto; }
      .ws-diag-sec-name { font-size:13px;font-weight:600;color:#d1dae6; }
      .ws-diag-sec-badge {
        font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;
        padding:3px 8px;border-radius:999px;border:1px solid transparent;
      }
      .ws-diag-badge-ok {
        color:#86efac;border-color:rgba(52,211,153,0.35);background:rgba(6,78,59,0.35);
      }
      .ws-diag-badge-warn {
        color:#fde047;border-color:rgba(250,204,21,0.35);background:rgba(66,52,11,0.35);
      }
      .ws-diag-sec-quiet {
        font-size:11px;line-height:1.45;color:var(--ws-diag-muted);margin:0 0 10px;
      }
      .ws-diag-chip-unknown {
        color:#c5d0e0;border-color:rgba(148,163,184,0.35);background:rgba(30,41,59,0.45);
      }
      .ws-diag-dash-line { font-size:12.5px;line-height:1.5;margin-top:8px;color:#dce3ee; }
      .ws-diag-dash-line:first-of-type { margin-top:0; }
      .ws-diag-dash-last {
        font-size:11px;margin-top:10px;padding-top:10px;
        border-top:1px solid rgba(255,255,255,0.06);color:var(--ws-diag-muted);
      }
      .ws-diag-dash-alerts { margin-bottom:12px; }
      .ws-diag-alert {
        font-size:11.5px;line-height:1.45;padding:10px 12px;border-radius:10px;margin-bottom:8px;
        background:rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.06);
      }
      .ws-diag-dash-actions {
        display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start;margin:14px 0 16px;
      }
      .ws-diag-details-more {
        margin:0;flex:1;min-width:148px;border-radius:12px;
        background:var(--ws-diag-surface);border:1px solid rgba(255,255,255,0.08);
      }
      .ws-diag-details-more > summary.ws-diag-more-summary {
        list-style:none;cursor:pointer;user-select:none;padding:12px 14px;
        font-size:12.5px;font-weight:600;color:#a8b4c8;
      }
      .ws-diag-details-more > summary.ws-diag-more-summary::-webkit-details-marker { display:none; }
      .ws-diag-details-more > summary.ws-diag-more-summary::after { content:'›';float:right;opacity:0.5;font-weight:400;transform:rotate(0deg);transition:transform 0.2s; }
      .ws-diag-details-more[open] > summary.ws-diag-more-summary::after { transform:rotate(90deg); }
      .ws-diag-more-inner { padding:0 12px 12px;border-top:1px solid rgba(255,255,255,0.06); }
      .ws-diag-more-group { margin-top:12px; }
      .ws-diag-more-group:first-child { margin-top:10px; }
      .ws-diag-more-label {
        display:block;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:0.1em;
        color:var(--ws-diag-muted);margin-bottom:8px;
      }
      .ws-diag-actions-col { flex-direction:column;align-items:stretch; }
      .ws-diag-actions-col .ws-diag-btn { width:100%;box-sizing:border-box;justify-content:center; }
      .ws-diag-chip-row { display:flex;flex-wrap:wrap;gap:8px;align-items:center; }
      .ws-diag-chip {
        font-size:11px;font-weight:600;padding:6px 11px;border-radius:999px;
        background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.08);color:#c5d0e0;
      }
      .ws-diag-chip-wide { flex:1;min-width:min(100%,200px);border-radius:10px;font-weight:500; }
      .ws-diag-chip-connected { color:#86efac;border-color:rgba(52,211,153,0.35);background:rgba(6,78,59,0.35); }
      .ws-diag-chip-disconnected { color:#fca5a5;border-color:rgba(248,113,113,0.35);background:rgba(127,29,29,0.28); }
      .ws-diag-chip-syncing, .ws-diag-chip-reconnecting { color:#fde047;border-color:rgba(250,204,21,0.3);background:rgba(66,52,11,0.35); }
      .ws-diag-prime-wrap {
        margin-bottom:16px;padding:14px;border-radius:12px;
        background:linear-gradient(135deg, rgba(15,23,42,0.55) 0%, rgba(0,0,0,0.25) 100%);
        border:1px solid rgba(129,140,248,0.2);
        box-shadow:0 0 24px -8px rgba(129,140,248,0.15);
      }
      .ws-diag-prime-summary { font-size:12px;line-height:1.55;color:#c8d0e0; }
      .ws-diag-prime-snapshot-row { display:flex;flex-wrap:wrap;gap:8px;margin-top:12px; }
      .ws-diag-prime-status-compact { font-size:10.5px;margin-top:10px;line-height:1.45;word-break:break-word;color:var(--ws-diag-muted); }
      .ws-diag-status-sep { opacity:0.4; }
      .ws-diag-btn-sm { padding:8px 13px;font-size:11.5px;border-radius:10px; }
      .ws-diag-tech-dense .ws-diag-row { font-size:10px;line-height:1.45;margin-bottom:4px; }
      .ws-diag-body-scroll {
        padding:14px 16px 18px;overflow-y:auto;overflow-x:hidden;
        flex:1;min-height:0;scroll-behavior:smooth;
      }
      .ws-diag-body-scroll::-webkit-scrollbar { width:8px; }
      .ws-diag-body-scroll::-webkit-scrollbar-track { background:transparent; }
      .ws-diag-body-scroll::-webkit-scrollbar-thumb {
        background:rgba(255,255,255,0.12);border-radius:8px;border:2px solid transparent;background-clip:padding-box;
      }
      .ws-diag-details {
        margin-bottom:10px;border-radius:12px;
        background:var(--ws-diag-surface);border:1px solid rgba(255,255,255,0.07);
        overflow:hidden;
      }
      .ws-diag-details > summary {
        list-style:none;cursor:pointer;user-select:none;
        padding:12px 14px;font-size:13px;font-weight:600;color:#d1dae6;
        border-left:3px solid transparent;
        transition:border-color 0.15s,background 0.15s;
      }
      .ws-diag-details > summary::-webkit-details-marker { display:none; }
      .ws-diag-details > summary::after { content:'›';float:right;opacity:0.45;font-weight:400;transition:transform 0.2s; }
      .ws-diag-details[open] > summary::after { transform:rotate(90deg);opacity:0.7; }
      .ws-diag-details[open] > summary {
        border-left-color:var(--ws-diag-accent);
        background:rgba(34,211,238,0.06);
        border-bottom:1px solid rgba(255,255,255,0.06);
      }
      .ws-diag-card { padding:12px 14px 14px; }
      .ws-diag-metrics-grid { display:grid;grid-template-columns:1fr 1fr;gap:10px; }
      .ws-diag-span-2 { grid-column:1/-1; }
      @media (max-width:480px) {
        .ws-diag-metrics-grid { grid-template-columns:1fr; }
        .ws-diag-span-2 { grid-column:1; }
      }
      .ws-diag-metric-block .ws-diag-metric-label {
        display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;
        color:var(--ws-diag-muted);margin-bottom:6px;
      }
      .ws-diag-inline-label {
        display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;
        color:var(--ws-diag-muted);margin:12px 0 8px;
      }
      .ws-diag-inline-label:first-child { margin-top:0; }
      .ws-diag-sync-block { font-size:11.5px;color:#9ca8bc;line-height:1.55; }
      .ws-diag-scrollbox,
      .ws-diag-scrollbox-sm,
      .ws-diag-scrollbox-md,
      .ws-diag-scrollbox-lg {
        overflow-y:auto;padding:8px 10px;border-radius:10px;
        background:rgba(0,0,0,0.45);border:1px solid rgba(255,255,255,0.06);
      }
      .ws-diag-scrollbox { max-height:100px; }
      .ws-diag-scrollbox-sm { max-height:88px; }
      .ws-diag-scrollbox-md { max-height:140px; }
      .ws-diag-scrollbox-lg { max-height:220px; }
      .ws-diag-events .ws-diag-row { font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px; }
      .ws-diag-last-line { margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.06); }
      .ws-diag-stale-banner {
        font-size:12px;padding:12px 14px;border-radius:12px;margin-bottom:12px;display:none;line-height:1.45;
      }
      .ws-diag-stale-banner.visible {
        display:block;
        background:linear-gradient(135deg, rgba(120,53,15,0.45) 0%, rgba(69,26,3,0.5) 100%);
        color:#fed7aa;border:1px solid rgba(251,191,36,0.35);
      }
      .ws-diag-filter-label {
        display:block;font-size:10px;font-weight:700;color:var(--ws-diag-muted);
        margin-bottom:6px;text-transform:uppercase;letter-spacing:0.06em;
      }
      .ws-diag-filter {
        width:100%;box-sizing:border-box;background:rgba(0,0,0,0.45);
        border:1px solid rgba(255,255,255,0.1);color:var(--ws-diag-text);
        border-radius:10px;padding:10px 12px;margin-bottom:10px;font-size:12.5px;
      }
      .ws-diag-filter:focus {
        outline:none;border-color:rgba(34,211,238,0.5);
        box-shadow:0 0 0 3px rgba(34,211,238,0.12);
      }
      .ws-diag-help { font-size:11px;color:#9ca8bc;margin:0 0 12px;line-height:1.45; }
      .ws-diag-help-tight { margin-bottom:6px; }
      .ws-diag-btn-missed-ad {
        background:linear-gradient(180deg, #fbbf24 0%, #d97706 100%) !important;
        color:#1c1917 !important;
        box-shadow:0 2px 12px rgba(217,119,6,0.4);
        border:none !important;
      }
      .ws-diag-btn-group { margin-bottom:12px; }
      .ws-diag-btn-group:last-child { margin-bottom:0; }
      .ws-diag-btn-group-label {
        display:block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;
        color:var(--ws-diag-muted);margin-bottom:6px;
      }
      .ws-diag-panel.ws-diag-minimized .ws-diag-body-scroll { display:none !important; }
      .ws-diag-panel.ws-diag-minimized { max-height:none; }
      .ws-diag-panel.ws-diag-minimized .ws-diag-header { border-bottom:none; }

      .ws-diag-panel.ws-diag-light {
        --ws-diag-bg0:#fafbfc;
        --ws-diag-bg1:#fff;
        --ws-diag-border:rgba(15,23,42,0.1);
        --ws-diag-text:#0f172a;
        --ws-diag-muted:#64748b;
        --ws-diag-accent:#0891b2;
        --ws-diag-accent-dim:rgba(8,145,178,0.08);
        --ws-diag-violet:#7c3aed;
        --ws-diag-surface:rgba(15,23,42,0.04);
        --ws-diag-surface2:rgba(15,23,42,0.06);
        background:linear-gradient(165deg, #ffffff 0%, #f8fafc 50%, #f1f5f9 100%);
        color:var(--ws-diag-text);
        border-color:#e2e8f0;
        box-shadow:0 24px 48px -12px rgba(15,23,42,0.12),0 0 0 1px rgba(15,23,42,0.04);
      }
      .ws-diag-panel.ws-diag-light .ws-diag-header-accent { opacity:1; }
      .ws-diag-panel.ws-diag-light .ws-diag-header {
        background:linear-gradient(180deg, rgba(255,255,255,0.9) 0%, rgba(248,250,252,0.95) 100%);
        border-bottom-color:#e2e8f0;
      }
      .ws-diag-panel.ws-diag-light.ws-diag-view-compact .ws-diag-header { border-bottom-color:#e2e8f0; }
      .ws-diag-panel.ws-diag-light .ws-diag-title { color:#0f172a; }
      .ws-diag-panel.ws-diag-light .ws-diag-session-cell {
        background:#fff;border-color:#e2e8f0;color:#334155;
      }
      .ws-diag-panel.ws-diag-light .ws-diag-session-label { color:#64748b; }
      .ws-diag-panel.ws-diag-light .ws-diag-header-icon-rail {
        background:rgba(15,23,42,0.05);border-color:#e2e8f0;
      }
      .ws-diag-panel.ws-diag-light .ws-diag-header-icon-rail .ws-diag-icon-btn:hover {
        background:rgba(15,23,42,0.06);
      }
      .ws-diag-panel.ws-diag-light .ws-diag-dash-modal-backdrop { background:rgba(15,23,42,0.35); }
      .ws-diag-panel.ws-diag-light .ws-diag-dash-modal-panel {
        background:#fff;border-color:#e2e8f0;
        box-shadow:0 24px 48px rgba(15,23,42,0.15);
      }
      .ws-diag-panel.ws-diag-light .ws-diag-dash-modal-title { color:#0f172a; }
      .ws-diag-panel.ws-diag-light .ws-diag-dash-modal-lead { color:var(--ws-diag-muted); }
      .ws-diag-panel.ws-diag-light .ws-diag-dash-modal-footer { border-top-color:#e2e8f0; }
      .ws-diag-panel.ws-diag-light .ws-diag-dash-modal-x:hover { background:#f1f5f9;color:#0f172a; }
      .ws-diag-panel.ws-diag-light kbd {
        background:#f1f5f9;border-color:#e2e8f0;color:#334155;
      }
      .ws-diag-panel.ws-diag-light .ws-diag-dash-summary {
        background:#fff;border-color:#e2e8f0;border-left-color:var(--ws-diag-accent);
        box-shadow:0 1px 2px rgba(15,23,42,0.04);
      }
      .ws-diag-panel.ws-diag-light .ws-diag-dash-line { color:#1e293b; }
      .ws-diag-panel.ws-diag-light .ws-diag-dash-last { border-top-color:#e2e8f0;color:var(--ws-diag-muted); }
      .ws-diag-panel.ws-diag-light .ws-diag-overview-meta { color:#334155; }
      .ws-diag-panel.ws-diag-light .ws-diag-overview-hint { border-top-color:#e2e8f0; }
      .ws-diag-panel.ws-diag-light .ws-diag-sec-name,
      .ws-diag-panel.ws-diag-light .ws-diag-sec-head-prime .ws-diag-prime-label { color:#0f172a; }
      .ws-diag-panel.ws-diag-light .ws-diag-badge-ok { background:#dcfce7;border-color:#86efac;color:#166534; }
      .ws-diag-panel.ws-diag-light .ws-diag-badge-warn { background:#fef9c3;border-color:#fde047;color:#854d0e; }
      .ws-diag-panel.ws-diag-light .ws-diag-chip-unknown { background:#f1f5f9;border-color:#cbd5e1;color:#475569; }
      .ws-diag-panel.ws-diag-light .ws-diag-record-export-card {
        background:linear-gradient(165deg, rgba(238,242,255,0.9) 0%, #fff 50%, #f8fafc 100%);
        border-color:#e2e8f0;box-shadow:0 2px 12px rgba(99,102,241,0.08);
      }
      .ws-diag-panel.ws-diag-light .ws-diag-record-export-lead strong { color:#0f172a; }
      .ws-diag-panel.ws-diag-light .ws-diag-step-badge {
        background:#eef2ff;border-color:#c7d2fe;color:#4338ca;
      }
      .ws-diag-panel.ws-diag-light .ws-diag-step-title { color:#0f172a; }
      .ws-diag-panel.ws-diag-light .ws-diag-compact-rec { background:#fff;border-color:#e2e8f0; }
      .ws-diag-panel.ws-diag-light .ws-diag-compact-rec.ws-diag-compact-rec-active {
        background:#fef2f2;border-color:#fecaca;
      }
      .ws-diag-panel.ws-diag-light .ws-diag-btn-primary-compact {
        background:linear-gradient(180deg, #eef2ff 0%, #e0e7ff 100%);
        border-color:#a5b4fc;color:#312e81;
      }
      .ws-diag-panel.ws-diag-light .ws-diag-details-more { background:#f8fafc;border-color:#e2e8f0; }
      .ws-diag-panel.ws-diag-light .ws-diag-details-more > summary.ws-diag-more-summary { color:#475569; }
      .ws-diag-panel.ws-diag-light .ws-diag-more-inner { border-top-color:#e2e8f0; }
      .ws-diag-panel.ws-diag-light .ws-diag-details { background:#f8fafc;border-color:#e2e8f0; }
      .ws-diag-panel.ws-diag-light .ws-diag-details > summary { color:#334155; }
      .ws-diag-panel.ws-diag-light .ws-diag-details[open] > summary {
        background:rgba(8,145,178,0.06);border-bottom-color:#e2e8f0;border-left-color:var(--ws-diag-accent);
      }
      .ws-diag-panel.ws-diag-light .ws-diag-scrollbox,
      .ws-diag-panel.ws-diag-light .ws-diag-scrollbox-sm,
      .ws-diag-panel.ws-diag-light .ws-diag-scrollbox-md,
      .ws-diag-panel.ws-diag-light .ws-diag-scrollbox-lg {
        background:#fff;border-color:#e2e8f0;color:#334155;
      }
      .ws-diag-panel.ws-diag-light .ws-diag-sync-block { color:#475569; }
      .ws-diag-panel.ws-diag-light .ws-diag-filter { background:#fff;border-color:#cbd5e1;color:#0f172a; }
      .ws-diag-panel.ws-diag-light .ws-diag-section-label { color:#64748b; }
      .ws-diag-panel.ws-diag-light .ws-diag-comp-tile { background:#f8fafc;color:#0f172a; }
      .ws-diag-panel.ws-diag-light .ws-diag-comp-tile.ws-diag-comp-ok { border-color:#22c55e;box-shadow:none; }
      .ws-diag-panel.ws-diag-light .ws-diag-comp-tile.ws-diag-comp-warn {
        border-color:#eab308;background:#fef9c3;color:#854d0e;box-shadow:none;
      }
      .ws-diag-panel.ws-diag-light .ws-diag-comp-name { color:#64748b; }
      .ws-diag-panel.ws-diag-light .ws-diag-comp-tile.ws-diag-comp-warn .ws-diag-comp-name { color:#854d0e; }
      .ws-diag-panel.ws-diag-light .ws-diag-comp-line { color:#64748b; }
      .ws-diag-panel.ws-diag-light .ws-diag-comp-tile.ws-diag-comp-warn .ws-diag-comp-line { color:#713f12; }
      .ws-diag-panel.ws-diag-light .ws-diag-dash-toggle { color:#475569; }
      .ws-diag-panel.ws-diag-light .ws-diag-chip { background:#f1f5f9;border-color:#e2e8f0;color:#334155; }
      .ws-diag-panel.ws-diag-light .ws-diag-chip-connected { background:#dcfce7;border-color:#86efac;color:#166534; }
      .ws-diag-panel.ws-diag-light .ws-diag-chip-disconnected { background:#fee2e2;border-color:#fca5a5;color:#991b1b; }
      .ws-diag-panel.ws-diag-light .ws-diag-prime-wrap {
        background:linear-gradient(135deg, #f5f3ff 0%, #faf5ff 100%);
        border-color:#ddd6fe;
        box-shadow:none;
      }
      .ws-diag-panel.ws-diag-light .ws-diag-prime-summary { color:#334155; }
      .ws-diag-panel.ws-diag-light .ws-diag-drag,
      .ws-diag-panel.ws-diag-light .ws-diag-icon-btn {
        background:#f1f5f9;border-color:#e2e8f0;color:#64748b;
      }
      .ws-diag-panel.ws-diag-light .ws-diag-drag:hover,
      .ws-diag-panel.ws-diag-light .ws-diag-icon-btn:hover {
        border-color:rgba(8,145,178,0.45);color:#0e7490;background:rgba(8,145,178,0.08);
      }
      .ws-diag-panel.ws-diag-light .ws-diag-stale-banner.visible {
        background:linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%);
        color:#92400e;border-color:#fcd34d;
      }
      .ws-diag-panel.ws-diag-light .ws-diag-alert {
        background:#f8fafc;border-color:#e2e8f0;color:#334155;
      }

      .ws-diag-list { font-size:11.5px;color:#9ca8bc; }
      .ws-diag-row { margin-bottom:5px; }
      .ws-diag-muted { color:var(--ws-diag-muted); }
      .ws-diag-err { color:#f87171; }
      .ws-diag-connected, .ws-diag-ok { color:#4ade80; }
      .ws-diag-disconnected { color:#f87171; }
      .ws-diag-warn { color:#fbbf24; }
      .ws-diag-info { color:#38bdf8; }
      .ws-diag-sidebar { font-size:11.5px;color:#9ca8bc; }
      .ws-diag-peer {
        margin-bottom:8px;padding:10px;background:var(--ws-diag-surface2);
        border-radius:10px;border:1px solid rgba(255,255,255,0.06);
      }
      .ws-diag-panel.ws-diag-light .ws-diag-peer { background:#fff;border-color:#e2e8f0; }
      .ws-diag-sync-play-ok, .ws-diag-sync-pause-ok, .ws-diag-sync-seek-ok { color:#4ade80; }
      .ws-diag-sync-play-fail, .ws-diag-sync-pause-fail, .ws-diag-sync-seek-fail { color:#f87171; }
      .ws-diag-sync-play-sent, .ws-diag-sync-pause-sent, .ws-diag-sync-seek-sent { color:#38bdf8; }
      .ws-diag-sync-play-recv, .ws-diag-sync-pause-recv, .ws-diag-sync-seek-recv { color:#fbbf24; }

      .ws-diag-actions { display:flex;flex-wrap:wrap;gap:8px;margin-top:6px; }
      .ws-diag-btn {
        border:none;border-radius:10px;padding:10px 16px;font-size:12.5px;font-weight:600;cursor:pointer;
        background:linear-gradient(180deg, #2dd4bf 0%, #0d9488 100%);
        color:#042f2e;
        box-shadow:0 2px 8px rgba(13,148,136,0.35),0 1px 0 rgba(255,255,255,0.2) inset;
        transition:filter 0.15s,transform 0.12s;
      }
      .ws-diag-btn:hover { filter:brightness(1.06);transform:translateY(-1px); }
      .ws-diag-btn:active { transform:translateY(0); }
      .ws-diag-btn:disabled { opacity:0.45;cursor:not-allowed;filter:none;transform:none; }
      .ws-diag-btn-secondary {
        background:var(--ws-diag-surface2);
        color:#e2e8f0;box-shadow:none;
        border:1px solid rgba(255,255,255,0.1);
      }
      .ws-diag-btn-secondary:hover { background:rgba(255,255,255,0.1);filter:none; }
      .ws-diag-panel.ws-diag-light .ws-diag-btn-secondary { background:#fff;color:#0f172a;border-color:#cbd5e1; }
      .ws-diag-panel.ws-diag-light .ws-diag-btn-secondary:hover { background:#f8fafc; }
      .ws-diag-btn-ghost {
        background:transparent;color:var(--ws-diag-muted);box-shadow:none;
        border:1px dashed rgba(255,255,255,0.18);
      }
      .ws-diag-btn-ghost:hover { color:#cbd5e1;border-style:solid;background:var(--ws-diag-surface);filter:none; }
      .ws-diag-panel.ws-diag-light .ws-diag-btn-ghost { color:#64748b;border-color:#94a3b8; }
      .ws-diag-panel.ws-diag-light .ws-diag-btn-ghost:hover { background:#f1f5f9;color:#334155; }
      .ws-diag-panel.ws-diag-light .ws-diag-btn {
        background:linear-gradient(180deg, #06b6d4 0%, #0891b2 100%);
        color:#fff;
        box-shadow:0 2px 8px rgba(8,145,178,0.35);
      }
    `;
    document.head.appendChild(diagStyles);
  }

  if (diagnosticsUiEnabled) {
    diagToggleBtn = document.createElement('button');
    diagToggleBtn.id = 'ws-diag-toggle';
    diagToggleBtn.title = 'Sync analytics (dev) — Ctrl+Shift+D';
    diagToggleBtn.textContent = '◆';
    diagToggleBtn.style.cssText = `
    position:fixed;bottom:16px;left:16px;z-index:2147483646;
    width:40px;height:40px;border-radius:12px;
    background:linear-gradient(165deg, rgba(22,26,34,0.96) 0%, rgba(10,12,16,0.98) 100%);
    border:1px solid rgba(34,211,238,0.28);
    color:#22d3ee;font-size:14px;line-height:1;cursor:pointer;font-weight:700;
    display:flex;align-items:center;justify-content:center;
    transition:background 0.2s,border-color 0.2s,color 0.2s,transform 0.15s,box-shadow 0.2s;
    box-shadow:0 4px 20px rgba(0,0,0,0.45),0 0 24px -6px rgba(34,211,238,0.25);
  `;
    diagToggleBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleDiagnostic(); });
    diagToggleBtn.addEventListener('mouseenter', () => {
      diagToggleBtn.style.background = 'linear-gradient(165deg, rgba(30,40,48,0.98) 0%, rgba(15,20,28,0.99) 100%)';
      diagToggleBtn.style.borderColor = 'rgba(34,211,238,0.5)';
      diagToggleBtn.style.color = '#67e8f9';
      diagToggleBtn.style.transform = 'translateY(-2px)';
      diagToggleBtn.style.boxShadow = '0 8px 28px rgba(0,0,0,0.5),0 0 32px -4px rgba(34,211,238,0.35)';
    });
    diagToggleBtn.addEventListener('mouseleave', () => {
      diagToggleBtn.style.background = 'linear-gradient(165deg, rgba(22,26,34,0.96) 0%, rgba(10,12,16,0.98) 100%)';
      diagToggleBtn.style.borderColor = 'rgba(34,211,238,0.28)';
      diagToggleBtn.style.color = '#22d3ee';
      diagToggleBtn.style.transform = 'translateY(0)';
      diagToggleBtn.style.boxShadow = '0 4px 20px rgba(0,0,0,0.45),0 0 24px -6px rgba(34,211,238,0.25)';
    });
    document.body.appendChild(diagToggleBtn);
    reparentPlayShareUiForFullscreen();

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        toggleDiagnostic();
      }
    });
  }

  // ── CSS animations ─────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    @keyframes wsFadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
    @keyframes wsFloatUp { 0% { opacity:1; transform:translateY(0) scale(1); } 70% { opacity:0.9; transform:translateY(-100vh) scale(1.2); } 100% { opacity:0; transform:translateY(-120vh) scale(1.3); } }
  `;
  document.head.appendChild(style);

  // ── Video polling ──────────────────────────────────────────────────────────
  function isVideoStale(v) {
    return !v || !v.isConnected || !document.contains(v);
  }
  function pollForVideo() {
    if (video && isVideoStale(video)) {
      detachVideo();
      setTimeout(pollForVideo, 150);
      return;
    }
    const v = findVideo();
    if (v && v !== video) attachVideo(v);
  }

  // Poll for video — throttled to avoid interfering with player
  let pollThrottle = null;
  function throttledPoll() {
    if (pollThrottle) return;
    pollThrottle = setTimeout(() => { pollThrottle = null; pollForVideo(); }, 300);
  }
  setInterval(pollForVideo, 2000);
  pollForVideo();

  // Observe DOM mutations (throttled) for SPA navigation
  if (videoDomDisconnect) videoDomDisconnect();
  videoDomDisconnect = attachVideoDomObserver(document.body, throttledPoll, 300);

  // ── Restore room state and settings on page load ───────────────────────────
  function applyRoomState(newState) {
    if (!newState) return;
    roomState = newState;
    if (diag.reportSession.roomCode !== newState.roomCode) {
      diag.reportSession = { startedAt: Date.now(), roomCode: newState.roomCode };
    }
    recordMemberChronology('room_restore', {
      roomCode: newState.roomCode,
      memberCount: (newState.members || []).length,
      isHost: !!newState.isHost,
      source: 'storage_or_tab'
    });
    const continueRestore = () => {
      injectSidebar();
      showSidebarToggle();
      openSidebar();
      const syncDelay = playbackProfile.syncRequestDelayMs;
      setTimeout(() => sendBg({ source: 'playshare', type: 'SYNC_REQUEST' }), syncDelay);
      diagLog('ROOM_JOINED', { roomCode: newState.roomCode, source: 'storage' });
      if (video) startPositionReportInterval();
      postSidebarRoomState();
      if (newState.isHost) stopViewerReconcileLoop();
      else startViewerReconcileLoop();
      seedActiveAdBreaksFromJoin(newState);
      if (video) startAdBreakMonitorIfNeeded();
    };
    if (newState.isHost) {
      chrome.storage.local.get(['playshareCountdownOnPlay'], (r) => {
        if (
          roomState &&
          roomState.roomCode === newState.roomCode &&
          typeof r.playshareCountdownOnPlay === 'boolean'
        ) {
          roomState.countdownOnPlay = r.playshareCountdownOnPlay;
          sendBg({
            source: 'playshare',
            type: 'UPDATE_COUNTDOWN_ON_PLAY',
            value: roomState.countdownOnPlay
          });
        }
        continueRestore();
      });
    } else {
      continueRestore();
    }
  }

  chrome.storage.local.get(['roomState'], (data) => {
    if (data.roomState) applyRoomState(data.roomState);
  });

  // Also request from background in case storage was slow
  chrome.runtime.sendMessage({ source: 'playshare', type: 'GET_STATE' }, (res) => {
    if (res?.roomState && !roomState) applyRoomState(res.roomState);
  });

  // Listen for room state changes (e.g. room created in popup while this tab is open)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (siteSync.key === 'prime' && changes[PRIME_SYNC_DEBUG_STORAGE_KEY]) {
      primeSyncDebugHud = !!changes[PRIME_SYNC_DEBUG_STORAGE_KEY].newValue;
      updatePrimeHudVisibility();
    }
    if (!changes.roomState) return;
    const newState = changes.roomState.newValue;
    if (newState) applyRoomState(newState);
    else {
      stopPeerRecordingSampleLoop();
      const cid = roomState?.clientId;
      if (diagnosticsUiEnabled && cid && getVideoProfiler().isRecording()) {
        try {
          sendBg({
            source: 'playshare',
            type: 'DIAG_PROFILER_COLLECTION',
            active: false,
            collectorClientId: cid
          });
        } catch {
          /* ignore */
        }
      }
      diag.profilerPeerCollection.remoteCollectorClientId = null;
      roomState = null;
      suppressPlaybackEchoUntil = 0;
      clearPlaybackOutboundCoalesce();
      clearRemotePlaybackDebouncedQueue();
      lastLocalPlaybackWireAt = 0;
      lastLocalWirePlayingSent = null;
      peersInAdBreak.clear();
      localAdBreakActive = false;
      stopAdBreakMonitor();
      pendingSyncState = null;
      syncPendingSyncStateDiagFlag();
      hostAuthoritativeRef = null;
      diag.reportSession = { startedAt: null, roomCode: null };
      stopHostPositionHeartbeat();
      stopViewerSyncInterval();
      stopViewerReconcileLoop();
      stopPositionReportInterval();
      diag.clusterSync = null;
      lastClusterSidebarKey = null;
      hideClusterSyncBadge();
      diagLog('ROOM_LEFT', { source: 'storage' });
      hideSidebarToggle();
      closeSidebar();
    }
  });

  document.addEventListener('visibilitychange', () => {
    diag.tabHidden = document.hidden;
    if (diagVisible) scheduleDiagUpdate();
    if (!document.hidden && roomState && video && !isVideoStale(video)) {
      sendPositionReportOnce();
    }
  });

  if (siteSync.key === 'prime') {
    try {
      chrome.storage.local.get({ [PRIME_SYNC_DEBUG_STORAGE_KEY]: false }, (d) => {
        primeSyncDebugHud = !!d[PRIME_SYNC_DEBUG_STORAGE_KEY];
        updatePrimeHudVisibility();
      });
      window.__playsharePrime = {
        getStatus() {
          refreshPrimeSyncTelemetry();
          const p = diag.primeSync;
          const v = videoElForPrimeTelemetry();
          return {
            adapterKey: siteSync.key,
            adDetectorHeuristic: p ? p.adDetectorActive : null,
            adScore: p ? p.adScore : null,
            adStrongSignal: p ? p.adStrong : null,
            adAuthoritative: p ? p.adDetectorActive : null,
            adReasons: p && p.adReasons ? [...p.adReasons] : [],
            adChannels: p && p.adChannels ? { ...p.adChannels } : null,
            adMonitor: {
              primeConsecutiveEnter: PRIME_AD_BREAK_MONITOR_OPTIONS.enterConsecutiveSamples,
              primeConsecutiveExit: PRIME_AD_BREAK_MONITOR_OPTIONS.exitConsecutiveSamples,
              primeMinHoldMs: PRIME_AD_BREAK_MONITOR_OPTIONS.minAdHoldMs,
              primeDebounceEnterMs: PRIME_AD_BREAK_MONITOR_OPTIONS.debounceEnterMs,
              primeDebounceExitMs: PRIME_AD_BREAK_MONITOR_OPTIONS.debounceExitMs
            },
            inMainSdkPlayerShell: p ? p.inSdkShell : null,
            extensionLocalAdBreak: localAdBreakActive,
            peersInAdBreakCount: peersInAdBreak.size,
            viewerDriftSec: p && typeof p.viewerDriftSec === 'number' ? p.viewerDriftSec : null,
            findVideoSelectorMatched: p ? p.selectorThatMatched : null,
            hostPositionIntervalMs: playbackProfile.hostPositionIntervalMs,
            viewerReconcileIntervalMs: playbackProfile.viewerReconcileIntervalMs,
            video: v
              ? {
                  currentTime: v.currentTime,
                  paused: v.paused,
                  readyState: v.readyState,
                  duration: v.duration
                }
              : null,
            room: roomState ? { code: roomState.roomCode, isHost: roomState.isHost } : null,
            help:
              'Prime: popup → “Prime sync HUD”. Dev diagnostics: Ctrl+Shift+D on the video tab (Sync tab = overview + snapshots).'
          };
        }
      };
    } catch {
      /* ignore */
    }
  }

  const onFullscreenChange = () => reparentPlayShareUiForFullscreen();
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  document.addEventListener('mozfullscreenchange', onFullscreenChange);
}
