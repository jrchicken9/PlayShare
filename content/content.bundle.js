(() => {
  // content/src/constants.js
  var PLATFORMS = {
    netflix: { name: "Netflix", color: "#E50914", match: /netflix\.com/ },
    disney: { name: "Disney+", color: "#113CCF", match: /disneyplus\.com/ },
    prime: { name: "Prime Video", color: "#00A8E1", match: /primevideo\.com|amazon\.(com|ca)/ },
    crave: { name: "Crave", color: "#0099CC", match: /crave\.ca/ },
    hulu: { name: "Hulu", color: "#1CE783", match: /hulu\.com/ },
    max: { name: "Max", color: "#002BE7", match: /hbomax\.com|max\.com/ },
    peacock: { name: "Peacock", color: "#FFCC00", match: /peacocktv\.com/ },
    paramount: { name: "Paramount+", color: "#0064FF", match: /paramountplus\.com/ },
    appletv: { name: "Apple TV+", color: "#555555", match: /appletv\.apple\.com|tv\.apple\.com/ },
    youtube: { name: "YouTube", color: "#FF0000", match: /youtube\.com|youtu\.be/ }
  };
  var contentConstants = {
    SYNC_THRESHOLD: 0.5,
    /** Prime ABR / UI often looks 0.7–1.5s “off” vs room clock; avoid seek thrash. */
    SYNC_THRESHOLD_PRIME: 1.2,
    SYNC_THRESHOLD_NETFLIX: 2,
    SYNC_DEBOUNCE_MS: 800,
    /** Coalesce rapid SYNC_STATE + position packets on Prime. */
    PRIME_APPLY_DEBOUNCE_MS: 420,
    /**
     * Host/local: trailing-edge coalesce PLAY/PAUSE wires to the room (ms). Reduces out-of-order
     * bursts when the player fires events faster than peers can apply (0 = off).
     */
    PRIME_PLAYBACK_OUTBOUND_COALESCE_MS: 140,
    /** Let Prime settle after programmatic seek before play(). */
    PRIME_SYNC_STATE_APPLY_DELAY_MS: 220,
    PRIME_TIME_JUMP_THRESHOLD: 2,
    /** Host → server playhead anchor (keeps room.state fresh between events). */
    HOST_POSITION_INTERVAL_MS: 2500,
    /** Rare SYNC_REQUEST fallback when periodic server `sync` is unavailable. */
    VIEWER_SYNC_INTERVAL_MS: 2e4,
    /** Viewer reconciliation vs host timeline (hybrid continuous sync). */
    SYNC_RECONCILE_INTERVAL_MS: 2500,
    /** Prime: slightly faster host anchor + viewer reconcile (ABR/UI latency). */
    PRIME_HOST_POSITION_INTERVAL_MS: 2200,
    PRIME_VIEWER_RECONCILE_INTERVAL_MS: 2200,
    SYNC_DRIFT_HARD_SEC: 0.5,
    /** Below this magnitude, leave playbackRate at 1 (avoids endless micro-nudges). */
    SYNC_DRIFT_SOFT_MIN_SEC: 0.08,
    SOFT_SYNC_RATE_AHEAD: 0.95,
    SOFT_SYNC_RATE_BEHIND: 1.05,
    /** Reset playbackRate after soft nudge (ms). */
    SOFT_SYNC_RESET_MS: 2800,
    /** Align with SyncDecisionEngine soft-drift window + small margin. */
    VIEWER_SOFT_DRIFT_RESET_MS: 4720,
    /** All peers send local playhead for cluster sync badge / spread (telemetry only on server). */
    POSITION_REPORT_INTERVAL_MS: 4e3,
    /** Max difference in extrapolated `currentTime` (seconds) to show “synced” for the room cluster. */
    CLUSTER_SYNC_SPREAD_SEC: 1.5,
    COUNTDOWN_SECONDS: 3,
    APPLY_DELAY_NETFLIX: 150,
    APPLY_DELAY_PRIME: 120,
    DIAG_DEBOUNCE_MS: 150,
    /**
     * Dev build only: interval for `DIAG_PEER_RECORDING_SAMPLE` while a peer is recording the video
     * profiler (collector tab); samples are bundled into the unified export JSON.
     */
    DIAG_PEER_DEV_SHARE_MS: 12e3,
    /**
     * After remote sync mutates the video element, ignore play/pause/seeked long enough that we
     * do not emit PLAY/SEEK (collaborative) or revert seeks (host-only) — avoids feedback loops
     * with periodic SYNC_STATE / sync packets.
     */
    PLAYBACK_ECHO_SUPPRESS_MS: 1300,
    /**
     * After a pause sync that seeks the playhead, some players (notably Prime) call play() on seeked.
     * We must not treat that as “user resumed while room is paused” or we broadcast PLAY and fight peers.
     */
    PAUSE_SEEK_OUTBOUND_PLAY_SUPPRESS_MS: 3600,
    /** Prime: longer seek / MSE pipeline — autoplay-after-seek can arrive late. */
    PRIME_PAUSE_SEEK_OUTBOUND_PLAY_SUPPRESS_MS: 4500,
    TIME_JUMP_THRESHOLD: 1,
    /** Host: ignore auto-SEEK-from-timeupdate briefly after `play` (ABR/keyframe resume looks like a seek). */
    HOST_SEEK_SUPPRESS_AFTER_PLAY_MS: 1600,
    HOST_SEEK_SUPPRESS_AFTER_PLAY_MS_PRIME: 4200,
    SIDEBAR_WIDTH: { full: 360, compact: 280 },
    DIAG_EVENT_NAMES: [
      "PLAY",
      "PAUSE",
      "SEEK",
      "CHAT",
      "SYNC_STATE",
      "ROOM_JOINED",
      "ROOM_LEFT",
      "MEMBER_JOINED",
      "MEMBER_LEFT",
      "TOGGLE_SIDEBAR",
      "SIDEBAR_OPEN",
      "SIDEBAR_CLOSE",
      "SIDEBAR_INJECT"
    ],
    /** Dev-only bootstrap secret. The background exchanges it for a scoped upload token before POST /diag/upload. */
    DEFAULT_DIAG_UPLOAD_BEARER: "ibrahim1@",
    PLATFORMS,
    /** @param {string} hostname */
    detectPlatform(hostname) {
      const h = hostname || "";
      for (const [key, p] of Object.entries(PLATFORMS)) {
        if (p.match.test(h)) return { key, ...p };
      }
      return { key: "unknown", name: "Streaming", color: "#4ECDC4", match: null };
    }
  };

  // content/src/join-link-helpers.js
  function wsUrlToHttpBase(wsUrl) {
    if (!wsUrl || typeof wsUrl !== "string") return null;
    let t = wsUrl.trim();
    if (!t) return null;
    if (!/^wss?:\/\//i.test(t)) t = `wss://${t.replace(/^\/\//, "")}`;
    try {
      const u = new URL(t);
      if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
      const httpProto = u.protocol === "ws:" ? "http:" : "https:";
      return `${httpProto}//${u.host}`;
    } catch {
      return null;
    }
  }
  function wsUrlFromInvitePsSrv(srv) {
    if (srv == null || typeof srv !== "string") return null;
    let host = srv;
    try {
      host = decodeURIComponent(srv.trim());
    } catch {
      return null;
    }
    if (!host) return null;
    if (/^wss?:\/\//i.test(host)) return host;
    const firstSeg = host.split(":")[0];
    const isLocal = firstSeg === "localhost" || firstSeg === "127.0.0.1" || firstSeg === "[::1]" || firstSeg === "::1";
    if (isLocal) {
      if (/:\d+$/.test(host)) return "ws://" + host;
      return "ws://" + firstSeg + ":8765";
    }
    return "wss://" + host;
  }

  // content/src/video-page.js
  function isVideoPage() {
    const path = location.pathname.toLowerCase();
    const host = location.hostname.toLowerCase();
    if (/youtube\.com|youtu\.be/.test(host)) {
      return /\/watch(\?|$)/.test(path) || /\/shorts\//.test(path) || /\/embed\//.test(path) || host.includes("youtu.be") && path.length > 1;
    }
    if (/netflix\.com/.test(host)) return /\/watch\//.test(path) || /\/title\//.test(path);
    if (/disneyplus\.com/.test(host)) return /\/video\//.test(path) || /\/player\//.test(path);
    if (/primevideo\.com/.test(host)) return /\/detail\//.test(path) || /\/watch\//.test(path) || /\/region\//.test(path);
    if (/amazon\.(com|ca)/.test(host)) return /\/gp\/video\/detail\//.test(path) || /\/gp\/video\/watch\//.test(path);
    if (/crave\.ca/.test(host)) return /\/watch\//.test(path) || /\/movies\//.test(path) || /\/shows\//.test(path);
    if (/hulu\.com/.test(host)) return /\/watch\//.test(path);
    if (/hbomax\.com|max\.com/.test(host)) return /\/feature\//.test(path) || /\/watch\//.test(path) || /\/video\//.test(path);
    if (/peacocktv\.com/.test(host)) return /\/watch\//.test(path) || /\/movies\//.test(path) || /\/tv\//.test(path);
    if (/paramountplus\.com/.test(host)) return /\/video\//.test(path) || /\/watch\//.test(path);
    if (/appletv\.apple\.com|tv\.apple\.com/.test(host)) return /\/movie\//.test(path) || /\/tv-episode\//.test(path) || /\/watch\//.test(path);
    return false;
  }
  function runUrlJoinFromQuery() {
    const params = new URLSearchParams(location.search);
    const code = (params.get("playshare") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    const srv = params.get("ps_srv");
    if (code.length < 4 || !srv) return;
    const serverUrl = wsUrlFromInvitePsSrv(srv);
    if (!serverUrl) return;
    params.delete("playshare");
    params.delete("ps_srv");
    const newSearch = params.toString() ? "?" + params.toString() : "";
    try {
      history.replaceState(null, "", location.pathname + newSearch + location.hash);
    } catch {
    }
    chrome.storage.local.set({ serverUrl });
    chrome.storage.local.get(["username"], (d) => {
      const username = (d.username || "Viewer").slice(0, 24);
      chrome.runtime.sendMessage({ source: "playshare", type: "JOIN_ROOM", roomCode: code, username });
    });
  }
  function scoreVideoElement(v) {
    if (!v || v.tagName !== "VIDEO") return -Infinity;
    try {
      const rect = v.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      if (area < 4) return -Infinity;
      const style = window.getComputedStyle(v);
      let score = area;
      if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
        score *= 0.02;
      }
      if (rect.width < 200 || rect.height < 112) score *= 0.12;
      const vw = window.innerWidth || 1920;
      const vh = window.innerHeight || 1080;
      const visibleW = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
      const visibleH = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
      const visArea = visibleW * visibleH;
      score = Math.max(score * 0.08, visArea * 2.2);
      if (v.getAttribute("aria-hidden") === "true") score *= 0.25;
      if (!v.paused) score *= 1.35;
      if (v.muted && (rect.width < 320 || rect.height < 180)) score *= 0.4;
      return score;
    } catch {
      return -Infinity;
    }
  }
  function collectVideosFromRoot(root, depth, out, seen) {
    if (depth < 0 || !root) return;
    try {
      const vids = root.querySelectorAll?.("video");
      if (vids) {
        for (const el of vids) {
          if (seen.has(el)) continue;
          seen.add(el);
          out.push(el);
        }
      }
      if (depth > 0) {
        const elements = root.querySelectorAll?.("*") || [];
        for (const el of elements) {
          if (el.shadowRoot) collectVideosFromRoot(el.shadowRoot, depth - 1, out, seen);
        }
      }
    } catch {
    }
  }
  function collectPageVideoElements(doc = document) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    collectVideosFromRoot(doc, 5, out, seen);
    try {
      const iframes = doc.querySelectorAll("iframe");
      for (const fr of iframes) {
        try {
          const idoc = fr.contentDocument || fr.contentWindow?.document;
          if (idoc) collectVideosFromRoot(idoc, 4, out, seen);
        } catch {
        }
      }
    } catch {
    }
    return out;
  }
  function attachVideoDomObserver(root, onMaybeVideoTreeChanged, throttleMs = 300) {
    let tid = null;
    const schedule = () => {
      if (tid) return;
      tid = setTimeout(() => {
        tid = null;
        onMaybeVideoTreeChanged();
      }, throttleMs);
    };
    const obs = new MutationObserver(schedule);
    if (root) {
      obs.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "class", "style"]
      });
    }
    return () => {
      obs.disconnect();
      if (tid) clearTimeout(tid);
    };
  }

  // content/src/format-time.js
  function formatTime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor(s % 3600 / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
  }

  // content/src/diagnostics/helpers.js
  var DIAGNOSTIC_REPORT_SCHEMA = "2.5";
  function pushDiagTimeline(timeline, entry, maxLen = 40) {
    timeline.unshift({ t: Date.now(), ...entry });
    if (timeline.length > maxLen) timeline.length = maxLen;
  }
  function updateDriftEwm(timing, sampleSec, alpha = 0.25) {
    if (typeof sampleSec !== "number" || !Number.isFinite(sampleSec) || sampleSec < 0) return;
    const prev = timing.driftEwmSec ?? 0;
    timing.driftEwmSec = alpha * sampleSec + (1 - alpha) * prev;
  }
  function truncStr(s, max) {
    if (typeof s !== "string") return s;
    return s.length > max ? s.slice(0, Math.floor(max / 2)) + "…[truncated]" : s;
  }
  function applyRate(ok, fail) {
    const total = ok + fail;
    if (!total) return { ok, fail, total: 0, successRate: null };
    return { ok, fail, total, successRate: Math.round(ok / total * 1e4) / 1e4 };
  }
  function summarizeLatencies(msList) {
    if (!msList.length) {
      return { count: 0, min: null, max: null, avg: null, p50: null, p90: null };
    }
    const s = [...msList].sort((a, b) => a - b);
    const sum = msList.reduce((a, b) => a + b, 0);
    const p = (q) => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
    return {
      count: msList.length,
      min: s[0],
      max: s[s.length - 1],
      avg: Math.round(sum / msList.length),
      p50: p(0.5),
      p90: p(0.9)
    };
  }
  function ingestRecvForCorrelation(byCorr, e) {
    const recvKinds = /* @__PURE__ */ new Set(["play_recv", "pause_recv", "seek_recv"]);
    const kind = e.kind || e.type;
    if (!recvKinds.has(kind)) return;
    const id = e.correlationId;
    if (!id || typeof id !== "string") return;
    const recvAt = typeof e.recvAt === "number" && Number.isFinite(e.recvAt) ? e.recvAt : typeof e.t === "number" && Number.isFinite(e.t) ? e.t : null;
    if (recvAt == null) return;
    const prev = byCorr.get(id);
    if (!prev || recvAt < prev.recvAt) {
      byCorr.set(id, { recvAt, kind });
    }
  }
  function computeCorrelationTraceDelivery(diag) {
    const trace = diag.serverRoomTrace || [];
    const timeline = diag.timing?.timeline || [];
    const byCorr = /* @__PURE__ */ new Map();
    for (const e of timeline) {
      ingestRecvForCorrelation(byCorr, e);
    }
    for (const e of diag.sync?.events || []) {
      ingestRecvForCorrelation(byCorr, e);
    }
    const samples = [];
    let traceConsider = 0;
    for (const tr of trace) {
      if (!tr || !tr.correlationId || typeof tr.correlationId !== "string") continue;
      const typ = tr.type;
      if (typ !== "PLAY" && typ !== "PAUSE" && typ !== "SEEK") continue;
      traceConsider++;
      const m = byCorr.get(tr.correlationId);
      if (!m) continue;
      const serverT = typeof tr.t === "number" ? tr.t : null;
      if (serverT == null || !Number.isFinite(serverT)) continue;
      const oneWayMs = m.recvAt - serverT;
      if (!Number.isFinite(oneWayMs) || Math.abs(oneWayMs) > 12e4) continue;
      samples.push({
        correlationIdTrunc: truncStr(String(tr.correlationId), 22),
        type: typ,
        clientRecvMinusServerTraceMs: Math.round(oneWayMs)
      });
    }
    const latencies = samples.map((s) => s.clientRecvMinusServerTraceMs);
    const negN = latencies.filter((x) => x < -80).length;
    const clockSkewSuspected = latencies.length >= 3 && negN >= Math.max(2, Math.ceil(latencies.length * 0.35));
    return {
      matched: samples.length,
      traceEventsWithIdConsidered: traceConsider,
      clockSkewSuspected,
      samples: samples.slice(0, 20),
      summary: summarizeLatencies(latencies)
    };
  }
  function computeSyncAnalytics(diag, reportSession, roomMeta = null) {
    const m = diag.sync?.metrics || {};
    const memberCount = roomMeta?.memberCount ?? null;
    const isSoloSession = memberCount != null && memberCount <= 1;
    const events = diag.sync?.events || [];
    const remotes = diag.sync?.remoteApplyResults || [];
    const timeline = diag.timing?.timeline || [];
    const fv = diag.findVideo || {};
    const jumps = diag.timeupdateJumps || [];
    const significantTimeupdateJumps = jumps.filter(
      (j) => j && typeof j.deltaSec === "number" && Number.isFinite(j.deltaSec) && j.deltaSec > 3.5
    );
    const recvDrifts = events.map((e) => e.drift).filter((x) => typeof x === "number" && Number.isFinite(x));
    const recvDriftStats = (() => {
      if (!recvDrifts.length) return { count: 0, max: null, avg: null };
      const sum = recvDrifts.reduce((a, b) => a + b, 0);
      return { count: recvDrifts.length, max: +Math.max(...recvDrifts).toFixed(3), avg: +(sum / recvDrifts.length).toFixed(4) };
    })();
    const byTypeLat = { play: [], pause: [], seek: [] };
    for (const r of remotes) {
      const et = String(r.eventType || "").toLowerCase();
      if (typeof r.latency === "number" && byTypeLat[et]) byTypeLat[et].push(r.latency);
    }
    const allLat = remotes.map((r) => r.latency).filter((x) => typeof x === "number");
    const remoteOk = remotes.filter((r) => r.success).length;
    const remoteTotal = remotes.length;
    const eventTypeCounts = {};
    for (const e of events) {
      eventTypeCounts[e.type] = (eventTypeCounts[e.type] || 0) + 1;
    }
    const timelineKindCounts = {};
    for (const e of timeline) {
      const k = e.kind || "unknown";
      timelineKindCounts[k] = (timelineKindCounts[k] || 0) + 1;
    }
    const tsList = [
      ...events.map((e) => e.t),
      ...remotes.map((r) => r.t),
      ...timeline.map((e) => e.t)
    ].filter((x) => typeof x === "number");
    const observedSpanMs = tsList.length >= 2 ? Math.max(...tsList) - Math.min(...tsList) : tsList.length === 1 ? 0 : null;
    const sessionStartedAt = reportSession?.startedAt || null;
    const sessionDurationMs = sessionStartedAt ? Date.now() - sessionStartedAt : null;
    const flags = [];
    const playT = m.playOk + m.playFail;
    const pauseT = m.pauseOk + m.pauseFail;
    const seekT = m.seekOk + m.seekFail;
    if (playT >= 4 && m.playFail / playT > 0.2) flags.push("elevated_local_play_apply_failures");
    if (pauseT >= 4 && m.pauseFail / pauseT > 0.2) flags.push("elevated_local_pause_apply_failures");
    if (seekT >= 4 && m.seekFail / seekT > 0.2) flags.push("elevated_local_seek_apply_failures");
    if (remoteTotal >= 4 && remoteOk / remoteTotal < 0.75) flags.push("peers_report_many_apply_failures");
    if ((diag.timing?.driftEwmSec ?? 0) > 0.75) flags.push("high_drift_ewm_after_apply");
    if (recvDriftStats.max != null && recvDriftStats.max > 2) flags.push("large_pre_apply_recv_drift_observed");
    if ((fv.invalidations || 0) > 12) flags.push("frequent_findVideo_cache_invalidation");
    if (significantTimeupdateJumps.length > 6) flags.push("many_large_timeupdate_jumps");
    if (diag.tabHidden) flags.push("tab_hidden_at_export");
    if (!diag.videoAttached) flags.push("no_video_attached_at_export");
    if (isSoloSession) flags.push("solo_session_expected_gaps_in_remote_metrics");
    const eo = diag.extensionOps || {};
    const trSw = diag.serviceWorkerTransport;
    const deferredSync = (eo.syncStateDeferredNoVideo || 0) + (eo.syncStateDeferredStaleOrMissing || 0);
    if (deferredSync >= 6 && roomMeta && !roomMeta.isHost) {
      flags.push("joiner_deferred_sync_state_often");
    }
    if (trSw && (trSw.wsCloseCount || 0) >= 4) {
      flags.push("service_worker_ws_disconnects_frequent_since_start");
    }
    if ((eo.wsDisconnectEvents || 0) >= 4) {
      flags.push("content_tab_saw_many_ws_disconnected_events");
    }
    const correlationTraceDelivery = computeCorrelationTraceDelivery(diag);
    const vb = diag.videoBuffering || {};
    const msgDiag = diag.messaging || {};
    if ((vb.waiting || 0) > 25) flags.push("many_video_waiting_events_buffering_or_cdn");
    if ((vb.stalled || 0) > 12) flags.push("many_video_stalled_events_buffering_or_cdn");
    if ((msgDiag.runtimeSendFailures || 0) > 0 || (msgDiag.sendThrowCount || 0) > 0) {
      flags.push("content_script_messaging_failures_to_service_worker");
    }
    if ((trSw?.wsSendFailures || 0) > 0) {
      flags.push("service_worker_ws_send_failed_socket_not_open");
    }
    if (correlationTraceDelivery.clockSkewSuspected) {
      flags.push("correlation_trace_vs_client_recv_clock_skew_suspected");
    }
    const remoteDeny = (eo.remoteApplyDeniedSyncLock || 0) + (eo.remoteApplyDeniedNetflixDebounce || 0);
    if (remoteDeny >= 8) {
      flags.push("remote_apply_often_denied_sync_lock_or_netflix_debounce");
    }
    const tr = diag.sync?.testResults;
    const testSummary = tr?.done ? {
      soakRounds: tr.soakRounds || 1,
      durationSec: +((Date.now() - tr.start) / 1e3).toFixed(1),
      peerTimeouts: tr.peerTimeouts ?? 0,
      steps: (tr.steps || []).map((s) => ({
        name: s.name,
        peerSuccess: s.peerSuccess,
        peerReported: s.peerReported
      }))
    } : null;
    return {
      session: {
        reportSessionStartedAt: sessionStartedAt,
        roomCodeWhileInRoom: reportSession?.roomCode || null,
        sessionDurationSinceJoinMs: sessionDurationMs,
        observedEventSpreadMs: observedSpanMs
      },
      sessionContext: {
        memberCount,
        isSoloSession,
        isHost: roomMeta?.isHost ?? null
      },
      /** WebSocket signaling counters (local tab). Host often has recv=0 for own actions (server excludes sender). */
      signalingThisDevice: {
        play: { sent: m.playSent || 0, recv: m.playRecv || 0 },
        pause: { sent: m.pauseSent || 0, recv: m.pauseRecv || 0 },
        seek: { sent: m.seekSent || 0, recv: m.seekRecv || 0 }
      },
      applyOutcomesThisDevice: {
        play: applyRate(m.playOk, m.playFail),
        pause: applyRate(m.pauseOk, m.pauseFail),
        seek: applyRate(m.seekOk, m.seekFail)
      },
      recvDriftAtReceive: recvDriftStats,
      latencyMsPeerReported: {
        byEventType: {
          play: summarizeLatencies(byTypeLat.play),
          pause: summarizeLatencies(byTypeLat.pause),
          seek: summarizeLatencies(byTypeLat.seek)
        },
        all: summarizeLatencies(allLat)
      },
      peers: {
        applyReportsReceived: remoteTotal,
        applyReportsSuccess: remoteOk,
        successRate: remoteTotal ? Math.round(remoteOk / remoteTotal * 1e4) / 1e4 : null
      },
      correlation: {
        serverTraceSamples: (diag.serverRoomTrace || []).length,
        timelineSteps: timeline.length
      },
      extensionBridge: {
        contentScript: { ...eo || {} },
        serviceWorkerTransport: trSw ? { ...trSw } : null
      },
      correlationTraceDelivery,
      videoBuffering: { ...vb },
      messaging: {
        runtimeSendFailures: msgDiag.runtimeSendFailures ?? 0,
        runtimeLastErrorAt: msgDiag.runtimeLastErrorAt ?? null,
        runtimeLastErrorMessage: msgDiag.runtimeLastErrorMessage ? truncStr(String(msgDiag.runtimeLastErrorMessage), 72) : null,
        sendThrowCount: msgDiag.sendThrowCount ?? 0
      },
      videoFinder: {
        cacheReturns: fv.cacheReturns ?? 0,
        fullScans: fv.fullScans ?? 0,
        invalidations: fv.invalidations ?? 0,
        videoAttachCount: fv.videoAttachCount ?? 0
      },
      timeupdateJumpsLogged: jumps.length,
      timeupdateSignificantJumps: significantTimeupdateJumps.length,
      /** Count of jumps with delta > 3.5s (sparse timeupdate playback steps are excluded). */
      timeupdateLargeJumps: significantTimeupdateJumps.length,
      eventTypeCounts,
      timelineKindCounts,
      flags,
      automatedTest: testSummary
    };
  }
  function buildAnalystHints({
    m,
    flags,
    platformKey,
    memberCount,
    findVideoInvalidations = 0,
    hostOnlyControl = null
  }) {
    const hints = [];
    if (memberCount != null && memberCount <= 1) {
      hints.push(
        "Solo session (1 client): apply ok/fail, drift-at-receive, and peer reports stay empty — there is no second player to echo or report. Check signaling (sent/recv) below; add a second device to validate end-to-end sync."
      );
    }
    if (flags.includes("elevated_local_play_apply_failures")) {
      hints.push("Local play apply failures are high — review forcePlay / platform overlays and autoplay policy.");
    }
    if (flags.includes("peers_report_many_apply_failures")) {
      hints.push("Peers often report failed applies — compare platforms and check correlationIds across clients.");
    }
    if (flags.includes("frequent_findVideo_cache_invalidation")) {
      hints.push("Video element may be recreated often (SPA player) — consider re-attach and cache strategy.");
      const seeks = m.seekSent || 0;
      if (platformKey === "prime" && seeks >= 12 && findVideoInvalidations >= seeks - 5) {
        hints.push(
          "Prime: cache is invalidated on each seeked event — seek count and invalidation count often rise together during scrubbing; compare attaches (should stay low if the same <video> is reused)."
        );
      }
    }
    if (flags.includes("many_large_timeupdate_jumps")) {
      hints.push(
        "Many timeupdate discontinuities >3.5s — usually real seeks or stream jumps (not sparse ~2s player sampling); may interact badly with sync thresholds."
      );
    }
    if (flags.includes("joiner_deferred_sync_state_often")) {
      hints.push(
        "Joiner often queued SYNC_STATE (no video yet or stale element) — slow video attach or SPA player swaps; check extensionBridge counters and videoAttachCount."
      );
    }
    if (flags.includes("service_worker_ws_disconnects_frequent_since_start")) {
      hints.push(
        "Service worker reports many WebSocket closes since start — flaky network, server restarts, or laptop sleep; compare wsCloseCount with tab-level WS_DISCONNECTED."
      );
    }
    if (flags.includes("many_video_waiting_events_buffering_or_cdn") || flags.includes("many_video_stalled_events_buffering_or_cdn")) {
      hints.push(
        "High `waiting` / `stalled` on <video> — often CDN/adaptive rebuffering; compare timing with sync applies and correlationTraceDelivery so you do not blame sync alone."
      );
    }
    if (flags.includes("content_script_messaging_failures_to_service_worker")) {
      hints.push(
        "Some chrome.runtime.sendMessage calls failed (service worker asleep or extension context invalid); playback actions may not reach the server."
      );
    }
    if (flags.includes("service_worker_ws_send_failed_socket_not_open")) {
      hints.push("Service worker dropped outbound WS sends — socket was not OPEN; check wsSendFailures and reconnect timing.");
    }
    if (flags.includes("correlation_trace_vs_client_recv_clock_skew_suspected")) {
      hints.push(
        "Many negative server→client deltas in correlationTraceDelivery — device clocks may differ; use latency shape qualitatively, not absolute ms."
      );
    }
    if (flags.includes("remote_apply_often_denied_sync_lock_or_netflix_debounce")) {
      hints.push(
        "Remote PLAY/PAUSE/SEEK often blocked by sync lock or Netflix debounce — rapid events or overlapping local actions; see extensionOps.remoteApplyDenied*."
      );
    }
    if ((m.playRecv || 0) > (m.playSent || 0) + 2) {
      hints.push("More play_recv than play_sent — normal for viewers receiving host actions.");
    }
    if (hostOnlyControl === false && memberCount != null && memberCount > 1 && flags.includes("large_pre_apply_recv_drift_observed")) {
      hints.push(
        "hostOnlyControl=false: large “drift at receive” usually means another member’s playhead differed from yours when they sent PAUSE/PLAY (not wire latency). To measure transport-only drift, use host-only control or export from the viewer tab after a single host-driven seek."
      );
    }
    if (platformKey === "netflix") {
      hints.push("Netflix: debounce / threshold behavior may dominate; compare with metrics.playFail vs seek.");
    }
    if (platformKey === "prime") {
      hints.push("Prime Video: video element replacement and Space/click fallbacks are common pain points.");
    }
    return hints;
  }
  function buildNarrativeSummary(payload) {
    const a = payload.analytics || {};
    const ap = a.applyOutcomesThisDevice || {};
    const sig = a.signalingThisDevice || {};
    const room = payload.room;
    const ctx = a.sessionContext || {};
    const solo = !!ctx.isSoloSession;
    const lines = [];
    lines.push("=== PlayShare sync diagnostic (for analysis) ===");
    lines.push(`Report schema: ${payload.reportSchemaVersion} | Extension: ${payload.extensionVersion}`);
    lines.push(`Exported (UTC): ${payload.exportedAt}`);
    lines.push(`Platform: ${payload.platform?.name || payload.platform?.key || "—"} (${payload.platform?.key || "—"})`);
    lines.push(`Page host (category): ${payload.pageHost || "—"}`);
    lines.push(`Role: ${room?.isHost ? "host" : room ? "viewer" : "not in room"} | Members: ${room?.memberCount ?? "—"}`);
    if (room?.policies) {
      lines.push(
        `Room rules: hostOnlyControl=${!!room.policies.hostOnlyControl} · countdownOnPlay=${!!room.policies.countdownOnPlay}`
      );
    }
    if (solo) {
      lines.push("Session: SOLO — remote-apply and peer metrics require 2+ members.");
    }
    lines.push(`Connection: ${payload.connectionStatus} | Video attached: ${payload.videoAttached}`);
    const rttLine = payload.timing?.lastRttMs != null ? `${payload.timing.lastRttMs}ms (WS heartbeat RTT/2 used for sync)` : "— (not sampled in this snapshot; connect a few seconds — heartbeats ~5s)";
    const rttProv = payload.timing?.lastRttSource ? ` [${payload.timing.lastRttSource}]` : "";
    lines.push(`RTT last: ${rttLine}${rttProv} | Drift EWM: ${payload.timing?.driftEwmSec != null ? payload.timing.driftEwmSec.toFixed(4) + "s" : "—"} (after remote apply only)`);
    lines.push("");
    lines.push("--- Extension & server connectivity ---");
    const cd = payload.connectionDetail;
    const tabConn = `${payload.connectionStatus ?? "—"}${cd?.transportPhase ? ` · transport: ${cd.transportPhase}` : ""}`;
    lines.push(`Signaling socket (as seen by this tab): ${tabConn}`);
    if (cd?.connectionMessage) lines.push(`Transport detail: ${cd.connectionMessage}`);
    const swt = payload.serviceWorkerTransport;
    if (swt && typeof swt === "object") {
      lines.push(
        `Service worker WebSocket: host ${swt.serverHost ?? "—"} · readyState ${swt.wsReadyState ?? "—"} · opens ${swt.wsOpenCount ?? 0} · closes ${swt.wsCloseCount ?? 0} · send failures ${swt.wsSendFailures ?? 0}`
      );
      lines.push(
        `  last open: ${swt.lastWsOpenedAt != null ? new Date(swt.lastWsOpenedAt).toISOString() : "—"} · last close: ${swt.lastWsClosedAt != null ? new Date(swt.lastWsClosedAt).toISOString() : "—"}`
      );
    } else {
      lines.push("Service worker WebSocket: no snapshot (open Sync analytics once to refresh GET_DIAG).");
    }
    const msg = payload.messaging;
    lines.push(
      `Tab ↔ service worker messaging: runtime.lastError ×${msg?.runtimeSendFailures ?? 0} · send() threw ×${msg?.sendThrowCount ?? 0}${msg?.runtimeLastErrorMessage ? ` · last: ${msg.runtimeLastErrorMessage}` : ""}`
    );
    lines.push("");
    if (payload.capture) {
      const c = payload.capture;
      lines.push("--- How this snapshot was captured ---");
      lines.push(
        c.exportPreparedAtIso ? `Prepared at: ${c.exportPreparedAtIso} (GET_DIAG + ~0.5s trace wait + fresh video health)` : "Prepared at: — (export without full refresh — prefer overlay buttons)"
      );
      lines.push(`Tab: ${c.tabVisibility ?? "—"} | doc focus: ${c.documentHasFocus == null ? "—" : c.documentHasFocus} | overlay: ${c.overlayOpenDuringExport == null ? "—" : c.overlayOpenDuringExport}`);
      if (c.serverRoomTraceAgeMsAtExport != null) {
        lines.push(`Server trace age at export: ${(c.serverRoomTraceAgeMsAtExport / 1e3).toFixed(2)}s`);
      }
      lines.push(`RTT value source: ${c.lastRttProvenance ?? "—"}`);
      if (c.pendingSyncStateQueued != null) {
        lines.push(`Joiner pending SYNC_STATE queued: ${c.pendingSyncStateQueued ? "yes" : "no"}`);
      }
      lines.push("");
    }
    if (payload.dataCompleteness) {
      const d = payload.dataCompleteness;
      lines.push("--- Data completeness ---");
      lines.push(
        `sync events: ${d.syncEventsIncludedInExport}/${d.syncEventsStored} | remote apply rows: ${d.remoteApplyIncludedInExport}/${d.remoteApplyStored} | timeline: ${d.timelineIncludedInExport}/${d.timelineStored}`
      );
      lines.push(`Truncated for file size: ${d.anyTruncation ? "yes" : "no"}`);
      lines.push("");
    }
    const eb = a.extensionBridge;
    if (eb?.contentScript && Object.keys(eb.contentScript).length) {
      const c = eb.contentScript;
      lines.push("--- Extension bridge (this tab) ---");
      lines.push(
        `SYNC_STATE: in ${c.syncStateInbound ?? 0} · applied ${c.syncStateApplied ?? 0} · skip(redundant) ${c.syncStateSkippedRedundant ?? 0} · deferred(no video) ${c.syncStateDeferredNoVideo ?? 0} · deferred(stale) ${c.syncStateDeferredStaleOrMissing ?? 0} · flushed ${c.syncStateFlushedOnVideoAttach ?? 0}`
      );
      lines.push(
        `SYNC_STATE denied: syncLock ${c.syncStateDeniedSyncLock ?? 0} · Netflix debounce ${c.syncStateDeniedNetflixDebounce ?? 0}`
      );
      lines.push(
        `Remote apply denied: syncLock ${c.remoteApplyDeniedSyncLock ?? 0} · Netflix debounce ${c.remoteApplyDeniedNetflixDebounce ?? 0} · deferred(tab hidden path) ${c.remoteApplyDeferredTabHidden ?? 0}`
      );
      lines.push(`Local host-only blocks ${c.localControlBlockedHostOnly ?? 0}`);
      lines.push(
        `Keepalive: PLAYBACK_POSITION ×${c.hostPlaybackPositionSent ?? 0} · SYNC_REQUEST ×${c.viewerSyncRequestSent ?? 0} · remote countdown ×${c.countdownStartRemote ?? 0}`
      );
      lines.push(
        `Sidebar: chat in ${c.chatReceived ?? 0} · system ${c.systemMsgsReceived ?? 0} · playback toasts deduped ${c.playbackSystemMsgsDeduped ?? 0}`
      );
      lines.push(`Errors: server ERROR ×${c.serverErrors ?? 0} · tab WS_DISCONNECTED ×${c.wsDisconnectEvents ?? 0}`);
      lines.push("");
    }
    if (payload.videoBuffering && ((payload.videoBuffering.waiting ?? 0) > 0 || (payload.videoBuffering.stalled ?? 0) > 0)) {
      const v = payload.videoBuffering;
      lines.push("--- Video buffering (cumulative) ---");
      lines.push(`waiting ×${v.waiting ?? 0} · stalled ×${v.stalled ?? 0}`);
      lines.push("");
    }
    const ctd = a.correlationTraceDelivery;
    if (ctd && (ctd.matched > 0 || ctd.traceEventsWithIdConsidered > 0)) {
      lines.push("--- Server trace ↔ client recv (correlationId) ---");
      const s = ctd.summary || {};
      lines.push(
        `Matched ${ctd.matched}/${ctd.traceEventsWithIdConsidered} playback rows · clientRecv−serverTrace ms: n=${s.count ?? 0} avg=${s.avg ?? "—"} p50=${s.p50 ?? "—"} p90=${s.p90 ?? "—"}${ctd.clockSkewSuspected ? " · clock skew suspected" : ""}`
      );
      lines.push("");
    }
    if (payload.sessionChronology?.memberTimeline?.length) {
      lines.push("--- Session chronology (recent, redacted) ---");
      payload.sessionChronology.memberTimeline.slice(0, 12).forEach((row) => {
        const when = typeof row.t === "number" ? new Date(row.t).toISOString() : "?";
        lines.push(`• ${row.kind} ${row.username || row.roomCodeTrunc || ""} @ ${when}`);
      });
      lines.push("");
    }
    if (payload.sessionChronology?.recentAutomatedTestRuns?.length) {
      lines.push("--- Recent automated test runs (metadata) ---");
      payload.sessionChronology.recentAutomatedTestRuns.forEach((run, i) => {
        lines.push(`Run ${i + 1}: ${run.durationMs}ms soak=${run.soakRounds} members=${run.memberCountAtRun} host=${run.isHost} steps=${run.stepCount} peerTimeouts=${run.peerTimeouts}`);
      });
      lines.push("");
    }
    lines.push("--- Signaling (this tab; WS play/pause/seek messages) ---");
    for (const k of ["play", "pause", "seek"]) {
      const s = sig[k] || { sent: 0, recv: 0 };
      lines.push(`${k}: sent ${s.sent} | recv ${s.recv}${room?.isHost ? " (host: recv often 0 for own actions)" : ""}`);
    }
    lines.push("");
    lines.push("--- Apply verification (this device, after inbound sync) ---");
    for (const k of ["play", "pause", "seek"]) {
      const r = ap[k];
      if (r && r.total) lines.push(`${k}: ${r.ok} ok / ${r.fail} fail (${((r.successRate || 0) * 100).toFixed(1)}%)`);
      else if (solo) lines.push(`${k}: no inbound applies yet (solo — normal)`);
      else lines.push(`${k}: no completed apply checks (no inbound sync or not enough activity)`);
    }
    lines.push("");
    lines.push("--- Peer-reported applies (what others said after your actions) ---");
    const p = a.peers || {};
    if (solo) {
      lines.push("N/A with 1 member — need another client in the room to receive DIAG_SYNC_APPLY_RESULT.");
    } else {
      lines.push(`Reports: ${p.applyReportsReceived} | Success rate: ${p.successRate != null ? (p.successRate * 100).toFixed(1) + "%" : "—"}`);
      const lat = a.latencyMsPeerReported?.all;
      if (lat && lat.count) lines.push(`Latency (ms): n=${lat.count} avg=${lat.avg} p50=${lat.p50} p90=${lat.p90}`);
    }
    lines.push("");
    lines.push("--- Drift at receive (before apply) ---");
    const rd = a.recvDriftAtReceive;
    if (rd?.count) lines.push(`n=${rd.count} avg=${rd.avg}s max=${rd.max}s`);
    else if (solo) lines.push("no remote sync events (solo — expected)");
    else lines.push("no data");
    lines.push("");
    lines.push("--- Video / DOM ---");
    const vf = a.videoFinder || {};
    lines.push(`findVideo: hits ${vf.cacheReturns} scans ${vf.fullScans} invalidations ${vf.invalidations} attaches ${vf.videoAttachCount}`);
    lines.push(
      `Timeupdate jumps: significant (>3.5s) ${a.timeupdateSignificantJumps ?? a.timeupdateLargeJumps ?? 0} · raw ring ${a.timeupdateJumpsLogged ?? a.timeupdateLargeJumps ?? 0}`
    );
    lines.push("");
    if (a.flags?.length) {
      lines.push("--- Flags ---");
      a.flags.forEach((f) => lines.push(`! ${f}`));
      lines.push("");
    }
    if (a.analystHints?.length) {
      lines.push("--- Hints ---");
      a.analystHints.forEach((h) => lines.push(`• ${h}`));
      lines.push("");
    }
    if (a.automatedTest) {
      lines.push("--- Last automated sync test ---");
      lines.push(JSON.stringify(a.automatedTest, null, 2));
      if (solo) {
        lines.push("(peerSuccess / peerReported are null with 1 member — run again with a second client.)");
      }
      lines.push("");
    }
    lines.push(payload.howToUse || "");
    return lines.filter(Boolean).join("\n");
  }
  function buildDiagnosticExport({
    diag,
    roomState,
    platform,
    extVersion,
    userAgent,
    reportSession,
    pageHost,
    videoAttached,
    captureContext = null
  }) {
    const tl = diag.timing?.timeline || [];
    const evs = diag.sync?.events || [];
    const remotesFull = diag.sync?.remoteApplyResults || [];
    const traceFull = diag.serverRoomTrace || [];
    const tuFull = diag.timeupdateJumps || [];
    const evsLen = evs.length;
    const remLen = remotesFull.length;
    const tlLen = tl.length;
    const traceLen = traceFull.length;
    const nowMs = Date.now();
    const memberCount = roomState ? (roomState.members || []).length : 0;
    const analytics = computeSyncAnalytics(diag, reportSession, {
      memberCount,
      isHost: !!roomState?.isHost
    });
    analytics.analystHints = buildAnalystHints({
      m: diag.sync?.metrics || {},
      flags: analytics.flags,
      platformKey: platform?.key,
      memberCount,
      findVideoInvalidations: diag.findVideo?.invalidations ?? 0,
      hostOnlyControl: roomState?.hostOnlyControl != null ? !!roomState.hostOnlyControl : null
    });
    analytics.atExport = {
      serverRoomTraceAgeMs: diag.serverRoomTraceAt ? nowMs - diag.serverRoomTraceAt : null,
      hadPreExportRefresh: !!(captureContext && captureContext.preparedAt)
    };
    const dataCompleteness = {
      syncEventsStored: evsLen,
      syncEventsIncludedInExport: Math.min(80, evsLen),
      remoteApplyStored: remLen,
      remoteApplyIncludedInExport: Math.min(35, remLen),
      timelineStored: tlLen,
      timelineIncludedInExport: Math.min(60, tlLen),
      serverTraceEntriesInExport: Math.min(45, traceLen),
      timeupdateJumpsStored: tuFull.length,
      timeupdateJumpsIncludedInExport: Math.min(20, tuFull.length),
      anyTruncation: evsLen > 80 || remLen > 35 || tlLen > 60 || traceLen > 45 || tuFull.length > 20
    };
    const capture = {
      clientClockNote: "Timestamps are this browser client Date.now() unless labeled serverTime",
      exportPreparedAtIso: captureContext?.preparedAt ? new Date(captureContext.preparedAt).toISOString() : null,
      tabVisibility: captureContext?.tabVisibility ?? null,
      documentHasFocus: captureContext?.documentHasFocus ?? null,
      overlayOpenDuringExport: captureContext?.overlayOpen ?? null,
      preExportBackgroundRefresh: !!(captureContext && captureContext.preparedAt),
      preExportServerTraceRequested: !!captureContext?.preExportTraceRequested,
      lastRttProvenance: diag.timing?.lastRttSource ?? null,
      pendingSyncStateQueued: !!diag.pendingSyncStateQueued,
      serverRoomTraceReceivedAtIso: diag.serverRoomTraceAt ? new Date(diag.serverRoomTraceAt).toISOString() : null,
      serverRoomTraceAgeMsAtExport: diag.serverRoomTraceAt ? nowMs - diag.serverRoomTraceAt : null
    };
    const sessionChronology = {
      memberTimeline: (diag.sync.memberTimeline || []).slice(0, 25).map((row) => ({
        t: row.t,
        kind: row.kind,
        roomCodeTrunc: row.roomCode ? String(row.roomCode).slice(0, 4) + "…" : void 0,
        memberCount: row.memberCount,
        isHost: row.isHost,
        username: row.username ? truncStr(String(row.username), 20) : void 0,
        clientIdShort: row.clientIdShort,
        source: row.source
      })),
      recentAutomatedTestRuns: (diag.sync.testHistory || []).slice(0, 8).map((run) => ({
        finishedAt: run.finishedAt,
        soakRounds: run.soakRounds,
        durationMs: run.durationMs,
        peerTimeouts: run.peerTimeouts,
        memberCountAtRun: run.memberCountAtRun,
        isHost: run.isHost,
        platform: run.platform,
        stepCount: run.steps?.length ?? 0
      }))
    };
    const payload = {
      reportSchemaVersion: DIAGNOSTIC_REPORT_SCHEMA,
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      extensionVersion: extVersion || "unknown",
      userAgent: truncStr(userAgent || "", 120),
      platform: { key: platform.key, name: platform.name },
      pageHost: pageHost ? truncStr(String(pageHost), 48) : null,
      videoAttached: !!videoAttached,
      room: roomState ? {
        roomCode: roomState.roomCode,
        memberCount: (roomState.members || []).length,
        isHost: roomState.isHost,
        clientIdShort: roomState.clientId ? String(roomState.clientId).slice(0, 10) + "…" : null,
        policies: {
          hostOnlyControl: !!roomState.hostOnlyControl,
          countdownOnPlay: !!roomState.countdownOnPlay
        }
      } : null,
      pendingSyncStateQueued: !!diag.pendingSyncStateQueued,
      extensionOps: { ...diag.extensionOps || {} },
      serviceWorkerTransport: diag.serviceWorkerTransport ? { ...diag.serviceWorkerTransport } : null,
      messaging: diag.messaging ? {
        runtimeSendFailures: diag.messaging.runtimeSendFailures ?? 0,
        runtimeLastErrorAt: diag.messaging.runtimeLastErrorAt ?? null,
        runtimeLastErrorMessage: diag.messaging.runtimeLastErrorMessage ? truncStr(String(diag.messaging.runtimeLastErrorMessage), 80) : null,
        sendThrowCount: diag.messaging.sendThrowCount ?? 0
      } : null,
      videoBuffering: diag.videoBuffering ? {
        waiting: diag.videoBuffering.waiting ?? 0,
        stalled: diag.videoBuffering.stalled ?? 0,
        lastWaitingAt: diag.videoBuffering.lastWaitingAt ?? null,
        lastStalledAt: diag.videoBuffering.lastStalledAt ?? null
      } : null,
      connectionStatus: diag.connectionStatus,
      connectionDetail: {
        transportPhase: diag.transportPhase && String(diag.transportPhase).trim() ? truncStr(String(diag.transportPhase).trim(), 64) : null,
        connectionMessage: diag.connectionMessage && String(diag.connectionMessage).trim() ? truncStr(String(diag.connectionMessage).trim(), 200) : null
      },
      tabHidden: !!diag.tabHidden,
      diagOverlayStale: !!diag.diagOverlayStale,
      clusterSync: diag.clusterSync ? {
        spreadSec: diag.clusterSync.spreadSec,
        synced: diag.clusterSync.synced,
        playingMismatch: diag.clusterSync.playingMismatch,
        freshMemberCount: diag.clusterSync.freshMemberCount,
        staleCount: diag.clusterSync.staleCount,
        label: diag.clusterSync.label ? truncStr(String(diag.clusterSync.label), 64) : null,
        wallMs: diag.clusterSync.wallMs
      } : null,
      capture,
      dataCompleteness,
      sessionChronology,
      timing: {
        lastRttMs: diag.timing?.lastRttMs ?? null,
        lastRttSource: diag.timing?.lastRttSource ?? null,
        driftEwmSec: diag.timing?.driftEwmSec ?? null,
        timeline: tl.slice(0, 60)
      },
      findVideo: diag.findVideo || {},
      videoHealth: diag.videoHealthLast || null,
      timeupdateJumps: (diag.timeupdateJumps || []).slice(0, 20),
      sync: {
        metrics: { ...diag.sync?.metrics || {} },
        events: evs.slice(0, 80).map((e) => ({
          ...e,
          fromUsername: e.fromUsername ? truncStr(String(e.fromUsername), 24) : e.fromUsername
        })),
        remoteApplyResults: remotesFull.slice(0, 35).map((r) => ({
          ...r,
          fromUsername: r.fromUsername ? truncStr(String(r.fromUsername), 24) : r.fromUsername,
          correlationId: r.correlationId ? String(r.correlationId).slice(0, 12) + "…" : r.correlationId
        })),
        peerReportIds: Object.keys(diag.sync?.peerReports || {}).map((id) => id ? id.slice(0, 8) + "…" : id),
        peerReportsSummary: Object.entries(diag.sync?.peerReports || {}).map(([, pr]) => ({
          username: pr.username ? truncStr(String(pr.username), 20) : pr.username,
          isHost: pr.isHost,
          platform: pr.platform,
          videoAttached: pr.videoAttached,
          metrics: pr.metrics ? { ...pr.metrics } : {}
        }))
      },
      serverRoomTrace: traceFull.slice(0, 45).map((e) => ({
        ...e,
        fromUsername: e.fromUsername ? truncStr(String(e.fromUsername), 20) : e.fromUsername,
        correlationId: e.correlationId ? String(e.correlationId).slice(0, 12) + "…" : e.correlationId
      })),
      recentErrors: (diag.errors || []).slice(0, 8).map((e) => ({
        t: e.t,
        event: e.event,
        detail: e.detail && typeof e.detail === "object" ? { message: truncStr(String(e.detail.message || ""), 72) } : e.detail
      })),
      analytics,
      howToUse: "Upload JSON or paste narrativeSummary. v2.5: top “Extension & server connectivity” + extensionOps / serviceWorkerTransport / connectionDetail in JSON. v2.3+: apply denials, messaging failures, WS send drops, buffering, correlationTraceDelivery. Export refreshes RTT + trace. No full URLs/chat.",
      note: 'Redacted for privacy. sessionChronology + dataCompleteness describe how the test was run and what was clipped. When embedded under playshareUnifiedExport, this object is the "extension" slice alongside videoPlayerProfiler and (on Prime) primeSiteDebug.'
    };
    payload.narrativeSummary = buildNarrativeSummary({
      ...payload,
      analytics: payload.analytics,
      timing: payload.timing,
      platform: payload.platform,
      room: payload.room,
      connectionStatus: payload.connectionStatus,
      videoAttached: payload.videoAttached,
      extensionVersion: payload.extensionVersion,
      exportedAt: payload.exportedAt,
      reportSchemaVersion: payload.reportSchemaVersion,
      howToUse: payload.howToUse
    });
    return payload;
  }

  // content/src/diagnostics/video-player-profiler.js
  var PROFILER_SCHEMA = "playshare.videoPlayerProfiler.v4";
  var LARGE_DISCONTINUITY_SEC = 3.5;
  var DERIVED_FROZEN_DEBOUNCE_MS = 4200;
  var MEDIA_ERROR_NAMES = {
    1: "MEDIA_ERR_ABORTED",
    2: "MEDIA_ERR_NETWORK",
    3: "MEDIA_ERR_DECODE",
    4: "MEDIA_ERR_SRC_NOT_SUPPORTED"
  };
  function truncUrl(v, max) {
    const s = v == null ? "" : String(v);
    if (!s) return "";
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }
  function perfNowMs() {
    try {
      if (typeof performance !== "undefined" && typeof performance.now === "function") {
        return +performance.now().toFixed(1);
      }
    } catch {
    }
    return null;
  }
  function sanitizeDecisionDetail(d) {
    if (!d || typeof d !== "object") return {};
    const out = {};
    const keys = [
      "reason",
      "driftSec",
      "correctionReason",
      "handlerKey",
      "syncKind",
      "remoteKind",
      "kind",
      "rate",
      "absDrift",
      "driftSigned",
      "ok",
      "deltaSeek",
      "note",
      "durationMs",
      "correlationId",
      "branch",
      "snapshotAt"
    ];
    for (const k of keys) {
      if (!(k in d)) continue;
      const v = (
        /** @type {Record<string, unknown>} */
        d[k]
      );
      if (v == null) continue;
      if (typeof v === "number" && Number.isFinite(v)) {
        out[k] = Math.abs(v) > 1e5 ? v : +v.toFixed(Number.isInteger(v) ? 0 : 4);
      } else if (typeof v === "boolean") {
        out[k] = v;
      } else if (typeof v === "string") {
        out[k] = truncUrl(v, 96);
      }
    }
    return out;
  }
  function computeDeltaSummary(prev, cur) {
    if (!prev || !cur) return null;
    const d = {};
    if (prev.videoPresent !== cur.videoPresent) d.videoPresentChanged = true;
    const pct = prev.currentTime;
    const cct = cur.currentTime;
    if (typeof pct === "number" && typeof cct === "number" && Number.isFinite(pct) && Number.isFinite(cct)) {
      const dt = cct - pct;
      if (Math.abs(dt) > 1e-4) d.currentTimeDelta = +dt.toFixed(3);
    }
    const pb = prev.bufferAheadSec;
    const cb = cur.bufferAheadSec;
    if (typeof pb === "number" && typeof cb === "number" && Number.isFinite(pb) && Number.isFinite(cb)) {
      const db = cb - pb;
      if (Math.abs(db) > 0.02) d.bufferAheadDelta = +db.toFixed(2);
    }
    if (prev.playbackRate !== cur.playbackRate && typeof cur.playbackRate === "number") d.playbackRateChanged = true;
    if (prev.readyState !== cur.readyState) d.readyStateChanged = [prev.readyState, cur.readyState];
    if (prev.paused !== cur.paused) d.pausedChanged = true;
    if (prev.seeking !== cur.seeking) d.seekingChanged = true;
    const ps = typeof prev.currentSrc === "string" ? prev.currentSrc : "";
    const cs = typeof cur.currentSrc === "string" ? cur.currentSrc : "";
    if (ps !== cs && (ps || cs)) d.srcChanged = true;
    if (prev.documentVisibility !== cur.documentVisibility) d.visibilityChanged = true;
    return Object.keys(d).length ? d : null;
  }
  function adModeVisibleFromSnapshot(snap) {
    if (!snap || typeof snap !== "object") return false;
    try {
      const ps = snap.playShare;
      if (ps && typeof ps === "object" && /** @type {Record<string, unknown>} */
      ps.localAdBreakActive === true) {
        return true;
      }
      const nf = snap.netflixAd;
      if (nf && typeof nf === "object" && /** @type {Record<string, unknown>} */
      nf.extensionHeuristicAd === true) {
        return true;
      }
      const pr = snap.primePlayer;
      if (pr && typeof pr === "object") {
        const o = (
          /** @type {Record<string, unknown>} */
          pr
        );
        if (o.adLikely === true || o.adStrong === true) return true;
      }
      const pt = snap.primeTelemetry;
      if (pt && typeof pt === "object" && /** @type {Record<string, unknown>} */
      pt.extensionLocalAd === true) {
        return true;
      }
    } catch {
    }
    return false;
  }
  function bufferAheadSec(v) {
    try {
      const ct = v.currentTime;
      if (typeof ct !== "number" || !Number.isFinite(ct)) return null;
      const b = v.buffered;
      let inRange = 0;
      for (let i = 0; i < b.length; i++) {
        if (ct >= b.start(i) && ct <= b.end(i)) {
          inRange = Math.max(inRange, b.end(i) - ct);
        }
      }
      if (inRange > 0) return +inRange.toFixed(2);
      let ahead = 0;
      for (let i = 0; i < b.length; i++) {
        if (b.end(i) > ct) ahead = Math.max(ahead, b.end(i) - ct);
      }
      return ahead > 0 ? +ahead.toFixed(2) : 0;
    } catch {
      return null;
    }
  }
  function viewportOverlapRatio(v) {
    try {
      if (typeof window === "undefined") return null;
      const r = v.getBoundingClientRect();
      const iw = window.innerWidth;
      const ih = window.innerHeight;
      const ix = Math.max(0, Math.min(r.right, iw) - Math.max(r.left, 0));
      const iy = Math.max(0, Math.min(r.bottom, ih) - Math.max(r.top, 0));
      const inter = ix * iy;
      const area = r.width * r.height;
      return area > 0 ? +Math.min(1, inter / area).toFixed(3) : 0;
    } catch {
      return null;
    }
  }
  function videoDomContext(v) {
    try {
      const root = v.getRootNode();
      const inShadow = root instanceof ShadowRoot;
      return {
        inShadowRoot: inShadow,
        hostTag: inShadow && /** @type {ShadowRoot} */
        root.host ? (
          /** @type {ShadowRoot} */
          root.host.tagName
        ) : null
      };
    } catch {
      return { inShadowRoot: false, hostTag: null };
    }
  }
  function networkConnectionHint() {
    try {
      const nc = (
        /** @type {{ effectiveType?: string, downlink?: number, rtt?: number, saveData?: boolean }|undefined} */
        typeof navigator !== "undefined" ? navigator.connection : void 0
      );
      if (!nc) return null;
      return {
        effectiveType: nc.effectiveType != null ? String(nc.effectiveType) : null,
        downlinkMbps: typeof nc.downlink === "number" ? +nc.downlink.toFixed(2) : null,
        rttMs: typeof nc.rtt === "number" ? Math.round(nc.rtt) : null,
        saveData: !!nc.saveData
      };
    } catch {
      return null;
    }
  }
  function computeSessionRollup(snaps, evs) {
    const nums = [];
    let present = 0;
    let playing = 0;
    for (const s of snaps) {
      if (!s || typeof s !== "object") continue;
      const o = (
        /** @type {Record<string, unknown>} */
        s
      );
      if (o.videoPresent === true) {
        present++;
        if (o.paused === false) playing++;
      }
      const b = o.bufferAheadSec;
      if (typeof b === "number" && Number.isFinite(b)) nums.push(b);
    }
    nums.sort((a, b) => a - b);
    const sum = nums.reduce((a, b) => a + b, 0);
    let userMarkers = 0;
    let rebounds = 0;
    let srcChanges = 0;
    let longTaskEvents = 0;
    let decisionEvents = 0;
    let derivedTimelineEvents = 0;
    for (const e of evs) {
      const row = e && typeof e === "object" ? (
        /** @type {Record<string, unknown>} */
        e
      ) : null;
      const et = row ? String(row.type || "") : "";
      if (et === "user_marker") userMarkers++;
      if (et === "video_element_rebound") rebounds++;
      if (et === "current_src_changed") srcChanges++;
      if (et === "performance_longtask") longTaskEvents++;
      if (row && row.decision === true) decisionEvents++;
      if (row && row.derived === true) derivedTimelineEvents++;
    }
    return {
      snapshotsWithVideo: present,
      playingSampleRatio: present > 0 ? +(playing / present).toFixed(3) : null,
      bufferAheadSec: nums.length ? {
        min: nums[0],
        max: nums[nums.length - 1],
        median: nums[Math.floor(nums.length / 2)],
        avg: +(sum / nums.length).toFixed(2),
        samples: nums.length
      } : null,
      userMarkers,
      videoElementRebounds: rebounds,
      currentSrcChanges: srcChanges,
      performanceLongTaskEvents: longTaskEvents,
      decisionEvents,
      derivedTimelineEvents
    };
  }
  function captureEnvironmentSnapshot() {
    const out = {};
    try {
      if (typeof navigator !== "undefined") {
        out.languages = navigator.languages ? [...navigator.languages].slice(0, 10) : null;
        out.hardwareConcurrency = navigator.hardwareConcurrency ?? null;
        out.platform = String(navigator.platform || "").slice(0, 80);
        out.onLine = !!navigator.onLine;
        const dm = (
          /** @type {{ deviceMemory?: number }} */
          navigator
        );
        if (typeof dm.deviceMemory === "number") out.deviceMemoryGb = dm.deviceMemory;
      }
    } catch {
    }
    try {
      const pm = (
        /** @type {{ memory?: { usedJSHeapSize: number, totalJSHeapSize: number, jsHeapSizeLimit: number } }} */
        performance
      );
      if (pm.memory) {
        out.jsHeapUsedMb = +(pm.memory.usedJSHeapSize / 1048576).toFixed(1);
        out.jsHeapTotalMb = +(pm.memory.totalJSHeapSize / 1048576).toFixed(1);
        out.jsHeapLimitMb = +(pm.memory.jsHeapSizeLimit / 1048576).toFixed(0);
      }
    } catch {
    }
    try {
      const t = performance.timing;
      if (t && t.navigationStart > 0) {
        out.pageLoadAgeMs = Date.now() - t.navigationStart;
      }
    } catch {
    }
    try {
      out.contentScriptTopLevel = typeof window !== "undefined" ? window === window.top : null;
      out.devicePixelRatio = typeof window !== "undefined" && typeof window.devicePixelRatio === "number" ? +window.devicePixelRatio.toFixed(2) : null;
    } catch {
    }
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
        out.extensionContext = { runtimePresent: true };
      }
    } catch {
    }
    return out;
  }
  function capturePageChrome(trackedVideo) {
    try {
      const fs = document.fullscreenElement || document.webkitFullscreenElement || null;
      const pip = document.pictureInPictureElement || null;
      return {
        fullscreenElementTag: fs && fs instanceof Element ? fs.tagName : null,
        fullscreenElementId: fs && fs instanceof Element && fs.id ? String(fs.id).slice(0, 56) : null,
        fullscreenElementClass: fs && fs instanceof Element && typeof /** @type {Element} */
        fs.className === "string" ? String(
          /** @type {HTMLElement} */
          fs.className
        ).slice(0, 140) : null,
        pictureInPictureElementTag: pip && pip instanceof Element ? pip.tagName : null,
        pictureInPictureIsTrackedVideo: !!(trackedVideo && pip === trackedVideo)
      };
    } catch {
      return null;
    }
  }
  function captureActiveElementHint(v) {
    try {
      const a = document.activeElement;
      if (!a || !(a instanceof Element)) return null;
      const within = v && (a === v || typeof v.contains === "function" && /** @type {HTMLElement} */
      v.contains(a));
      return {
        tag: a.tagName,
        id: a.id ? String(a.id).slice(0, 48) : null,
        class: typeof /** @type {HTMLElement} */
        a.className === "string" ? String(a.className).slice(0, 100) : null,
        role: a.getAttribute("role"),
        withinTrackedVideo: !!within
      };
    } catch {
      return null;
    }
  }
  function captureVideoElementDeep(v) {
    const out = {
      tagName: v.tagName,
      id: v.id ? String(v.id).slice(0, 80) : "",
      classList: v.classList ? [...v.classList].slice(0, 28).map((c) => String(c).slice(0, 56)) : []
    };
    try {
      const attrs = {};
      const names = typeof v.getAttributeNames === "function" ? v.getAttributeNames() : [];
      for (const n of names.slice(0, 50)) {
        const val = v.getAttribute(n);
        attrs[String(n).slice(0, 64)] = val != null ? truncUrl(val, 140) : "";
      }
      out.attributes = attrs;
    } catch {
      out.attributes = {};
    }
    try {
      const ds = v.dataset;
      const data = {};
      for (const k of Object.keys(ds).slice(0, 28)) {
        data[k.slice(0, 48)] = truncUrl(String(ds[k] || ""), 96);
      }
      out.dataset = data;
    } catch {
      out.dataset = {};
    }
    try {
      const st = getComputedStyle(v);
      out.computedStyle = {
        display: st.display,
        visibility: st.visibility,
        opacity: st.opacity,
        objectFit: st.objectFit,
        pointerEvents: st.pointerEvents,
        zIndex: st.zIndex,
        position: st.position
      };
    } catch {
      out.computedStyle = null;
    }
    try {
      const chain = [];
      let el = (
        /** @type {Element|null} */
        v
      );
      for (let d = 0; d < 12 && el; d++) {
        const he = (
          /** @type {HTMLElement} */
          el
        );
        chain.push({
          tag: el.tagName,
          id: el.id ? String(el.id).slice(0, 48) : "",
          cls: typeof he.className === "string" ? he.className.slice(0, 120) : ""
        });
        el = el.parentElement;
      }
      out.ancestorChain = chain;
    } catch {
      out.ancestorChain = [];
    }
    try {
      out.closestPlayerHints = {
        atvSdk: !!v.closest?.('[class*="atvwebplayersdk" i]'),
        nfPlayer: !!v.closest?.('.nf-player-container, [class*="watch-video" i]'),
        youtube: !!v.closest?.(".html5-video-player, #movie_player"),
        disney: !!v.closest?.('[data-testid*="player" i], [class*="dplus-player" i], [class*="disney" i]')
      };
    } catch {
      out.closestPlayerHints = {};
    }
    return out;
  }
  function tryCaptureVideoFrameDataUrl(v) {
    if (!v || !(v instanceof HTMLVideoElement)) return { ok: false, reason: "no_video" };
    if (!v.videoWidth || !v.videoHeight) return { ok: false, reason: "no_decoded_frames" };
    try {
      const c = document.createElement("canvas");
      const maxW = 400;
      const scale = Math.min(1, maxW / v.videoWidth);
      c.width = Math.max(1, Math.round(v.videoWidth * scale));
      c.height = Math.max(1, Math.round(v.videoHeight * scale));
      const ctx = c.getContext("2d");
      if (!ctx) return { ok: false, reason: "no_canvas_context" };
      ctx.drawImage(v, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL("image/jpeg", 0.4);
      const maxLen = 24e4;
      if (dataUrl.length > maxLen) {
        return {
          ok: true,
          format: "jpeg",
          width: c.width,
          height: c.height,
          truncated: true,
          length: dataUrl.length,
          dataUrl: dataUrl.slice(0, maxLen)
        };
      }
      return { ok: true, format: "jpeg", width: c.width, height: c.height, length: dataUrl.length, dataUrl };
    } catch (e) {
      const name = e && typeof e === "object" && "name" in e ? String(
        /** @type {{name?:string}} */
        e.name
      ) : "";
      return { ok: false, reason: "canvas_security_or_error", detail: name.slice(0, 64) };
    }
  }
  function capturePlayerCapabilities(v) {
    const cap = {};
    try {
      cap.disablePictureInPicture = !!v.disablePictureInPicture;
      cap.disableRemotePlayback = !!v.disableRemotePlayback;
    } catch {
      cap.disablePictureInPicture = null;
      cap.disableRemotePlayback = null;
    }
    try {
      if (typeof document !== "undefined") {
        cap.pictureInPictureEnabled = !!document.pictureInPictureEnabled;
        const d = (
          /** @type {{ fullscreenEnabled?: boolean, webkitFullscreenEnabled?: boolean }} */
          document
        );
        cap.fullscreenEnabled = typeof d.fullscreenEnabled === "boolean" ? d.fullscreenEnabled : typeof d.webkitFullscreenEnabled === "boolean" ? d.webkitFullscreenEnabled : null;
      }
    } catch {
    }
    try {
      cap.emeMediaKeysAttached = !!/** @type {{ mediaKeys?: object|null }} */
      v.mediaKeys;
    } catch {
      cap.emeMediaKeysAttached = null;
    }
    try {
      if ("sinkId" in v) {
        const sid = (
          /** @type {{ sinkId?: string }} */
          v.sinkId
        );
        cap.sinkId = typeof sid === "string" ? truncUrl(sid, 96) : null;
      }
    } catch {
      cap.sinkId = null;
    }
    try {
      if (typeof v.getStartDate === "function") {
        const d = v.getStartDate();
        if (d instanceof Date && !Number.isNaN(d.getTime())) cap.broadcastStartDateMs = d.getTime();
      }
    } catch {
    }
    const webkit = {};
    for (const key of [
      "webkitVideoDecodedByteCount",
      "webkitAudioDecodedByteCount",
      "webkitDecodedFrameCount",
      "webkitDroppedFrameCount"
    ]) {
      try {
        if (key in v) {
          const n = Reflect.get(v, key);
          if (typeof n === "number" && Number.isFinite(n)) webkit[key] = n;
        }
      } catch {
      }
    }
    if (Object.keys(webkit).length) cap.webkitPipeline = webkit;
    return cap;
  }
  function captureMediaSessionSnapshot() {
    try {
      if (typeof navigator === "undefined" || !navigator.mediaSession) {
        return { available: false };
      }
      const ms = navigator.mediaSession;
      const md = ms.metadata;
      return {
        available: true,
        playbackState: ms.playbackState || null,
        title: md && md.title ? truncUrl(md.title, 120) : null,
        artist: md && md.artist ? truncUrl(md.artist, 96) : null,
        album: md && md.album ? truncUrl(md.album, 96) : null
      };
    } catch {
      return { available: false, readError: true };
    }
  }
  function captureVideoSnapshot(v) {
    const at = Date.now();
    const mono = perfNowMs();
    if (!v || !(v instanceof HTMLVideoElement)) {
      const absent = { at, perfNowMs: mono, videoPresent: false };
      try {
        absent.documentVisibility = typeof document !== "undefined" ? document.visibilityState || "" : "";
        absent.documentHidden = typeof document !== "undefined" ? !!document.hidden : null;
        absent.pageHasFocus = typeof document !== "undefined" && typeof document.hasFocus === "function" ? document.hasFocus() : null;
      } catch {
      }
      absent.mediaSession = captureMediaSessionSnapshot();
      try {
        absent.pageChrome = capturePageChrome(null);
        absent.activeElement = captureActiveElementHint(null);
      } catch {
      }
      try {
        if (typeof window !== "undefined") {
          absent.windowInner = { w: window.innerWidth, h: window.innerHeight };
        }
      } catch {
      }
      try {
        if (typeof document !== "undefined") {
          const d = (
            /** @type {{ pictureInPictureEnabled?: boolean, fullscreenEnabled?: boolean, webkitFullscreenEnabled?: boolean }} */
            document
          );
          absent.documentPlayerApi = {
            pictureInPictureEnabled: !!d.pictureInPictureEnabled,
            fullscreenEnabled: typeof d.fullscreenEnabled === "boolean" ? d.fullscreenEnabled : typeof d.webkitFullscreenEnabled === "boolean" ? d.webkitFullscreenEnabled : null
          };
        }
      } catch {
      }
      return absent;
    }
    const snap = {
      at,
      perfNowMs: mono,
      videoPresent: true,
      readyState: v.readyState,
      networkState: v.networkState,
      paused: v.paused,
      ended: v.ended,
      seeking: v.seeking,
      muted: v.muted,
      defaultMuted: v.defaultMuted,
      volume: typeof v.volume === "number" ? +v.volume.toFixed(3) : null,
      playbackRate: v.playbackRate,
      defaultPlaybackRate: v.defaultPlaybackRate,
      currentTime: typeof v.currentTime === "number" && Number.isFinite(v.currentTime) ? +v.currentTime.toFixed(3) : null,
      duration: typeof v.duration === "number" && Number.isFinite(v.duration) && !Number.isNaN(v.duration) ? +v.duration.toFixed(2) : null,
      videoWidth: v.videoWidth || 0,
      videoHeight: v.videoHeight || 0,
      currentSrc: truncUrl(v.currentSrc, 120),
      src: truncUrl(v.getAttribute("src") || v.src || "", 120),
      crossOrigin: v.crossOrigin || null,
      preload: v.preload || null,
      loop: !!v.loop,
      playsInline: "playsInline" in v ? !!/** @type {HTMLVideoElement} */
      v.playsInline : null,
      autoplay: !!v.autoplay,
      controls: !!v.controls,
      poster: truncUrl(v.poster || "", 80)
    };
    try {
      const r = v.getBoundingClientRect();
      const iw = typeof window !== "undefined" ? window.innerWidth : 0;
      const ih = typeof window !== "undefined" ? window.innerHeight : 0;
      snap.layout = {
        offsetW: v.offsetWidth,
        offsetH: v.offsetHeight,
        clientW: v.clientWidth,
        clientH: v.clientHeight,
        rect: { x: +r.x.toFixed(0), y: +r.y.toFixed(0), w: +r.width.toFixed(0), h: +r.height.toFixed(0) }
      };
      snap.inViewportApprox = ih > 0 && iw > 0 && r.bottom > 0 && r.right > 0 && r.top < ih && r.left < iw;
    } catch {
    }
    try {
      snap.pictureInPicture = typeof document !== "undefined" && document.pictureInPictureElement === v ? true : false;
    } catch {
      snap.pictureInPicture = null;
    }
    try {
      if ("webkitPresentationMode" in v) {
        snap.webkitPresentationMode = /** @type {{ webkitPresentationMode?: string }} */
        v.webkitPresentationMode;
      }
    } catch {
    }
    try {
      if ("preservesPitch" in v) snap.preservesPitch = !!/** @type {{ preservesPitch?: boolean }} */
      v.preservesPitch;
    } catch {
    }
    try {
      const rp = (
        /** @type {{ remote?: { state?: string } }} */
        v.remote
      );
      if (rp && typeof rp.state === "string") snap.remotePlayback = { state: rp.state };
    } catch {
    }
    try {
      snap.documentVisibility = typeof document !== "undefined" ? document.visibilityState || "" : "";
      snap.documentHidden = typeof document !== "undefined" ? !!document.hidden : null;
      snap.pageHasFocus = typeof document !== "undefined" && typeof document.hasFocus === "function" ? document.hasFocus() : null;
    } catch {
    }
    snap.mediaSession = captureMediaSessionSnapshot();
    snap.bufferAheadSec = bufferAheadSec(v);
    snap.viewportOverlapRatio = viewportOverlapRatio(v);
    snap.videoDom = videoDomContext(v);
    snap.network = networkConnectionHint();
    try {
      snap.pageChrome = capturePageChrome(v);
      snap.activeElement = captureActiveElementHint(v);
      snap.videoElement = captureVideoElementDeep(v);
    } catch {
    }
    try {
      const b = v.buffered;
      const br = [];
      const n = Math.min(b.length, 24);
      for (let i = 0; i < n; i++) {
        br.push([+b.start(i).toFixed(2), +b.end(i).toFixed(2)]);
      }
      snap.bufferedRanges = br;
      snap.bufferedRangeCount = b.length;
    } catch {
      snap.bufferedRanges = [];
    }
    try {
      const s = v.seekable;
      const sr = [];
      const n = Math.min(s.length, 12);
      for (let i = 0; i < n; i++) {
        sr.push([+s.start(i).toFixed(2), +s.end(i).toFixed(2)]);
      }
      snap.seekableRanges = sr;
    } catch {
      snap.seekableRanges = [];
    }
    try {
      const p = v.played;
      const pr = [];
      const n = Math.min(p.length, 12);
      for (let i = 0; i < n; i++) {
        pr.push([+p.start(i).toFixed(2), +p.end(i).toFixed(2)]);
      }
      snap.playedRanges = pr;
    } catch {
      snap.playedRanges = [];
    }
    try {
      if (typeof v.getVideoPlaybackQuality === "function") {
        const q = v.getVideoPlaybackQuality();
        snap.playbackQuality = {
          totalVideoFrames: q.totalVideoFrames ?? null,
          droppedVideoFrames: q.droppedVideoFrames ?? null,
          corruptedVideoFrames: q.corruptedVideoFrames ?? null,
          creationTime: q.creationTime != null ? +q.creationTime.toFixed(1) : null
        };
      }
    } catch {
    }
    try {
      const vt = v.videoTracks;
      if (vt && vt.length !== void 0) {
        snap.videoTracks = [];
        for (let i = 0; i < Math.min(vt.length, 8); i++) {
          const t = vt[i];
          snap.videoTracks.push({
            id: t.id || "",
            kind: t.kind || "",
            label: truncUrl(t.label, 40),
            language: t.language || "",
            selected: !!t.selected
          });
        }
      }
    } catch {
    }
    try {
      const atTracks = v.audioTracks;
      if (atTracks && atTracks.length !== void 0) {
        snap.audioTracks = [];
        for (let i = 0; i < Math.min(atTracks.length, 8); i++) {
          const t = atTracks[i];
          snap.audioTracks.push({
            id: t.id || "",
            kind: t.kind || "",
            label: truncUrl(t.label, 40),
            language: t.language || "",
            enabled: !!t.enabled
          });
        }
      }
    } catch {
    }
    try {
      const tt = v.textTracks;
      if (tt && tt.length !== void 0) {
        snap.textTracks = [];
        for (let i = 0; i < Math.min(tt.length, 12); i++) {
          const t = tt[i];
          let cueCount = (
            /** @type {number|null} */
            null
          );
          let activeCueCount = (
            /** @type {number|null} */
            null
          );
          try {
            if (t.cues) cueCount = t.cues.length;
          } catch {
            cueCount = null;
          }
          try {
            if (t.activeCues) activeCueCount = t.activeCues.length;
          } catch {
            activeCueCount = null;
          }
          snap.textTracks.push({
            kind: t.kind || "",
            label: truncUrl(t.label, 48),
            language: t.language || "",
            mode: t.mode || "",
            cueCount,
            activeCueCount
          });
        }
      }
    } catch {
    }
    try {
      snap.playerCapabilities = capturePlayerCapabilities(v);
    } catch {
      snap.playerCapabilities = { readError: true };
    }
    return snap;
  }
  function createProgressionTracker() {
    let lastTuWall = 0;
    let lastTuCt = (
      /** @type {number|null} */
      null
    );
    let sumGap = 0;
    let gapCount = 0;
    let maxGap = 0;
    let zeroAdvanceWhilePlayingCount = 0;
    let largeDiscontinuityCount = 0;
    let expectedAdvanceSec = 0;
    let actualAdvanceSec = 0;
    let frozenWhilePlayingCount = 0;
    return {
      reset() {
        lastTuWall = 0;
        lastTuCt = null;
        sumGap = 0;
        gapCount = 0;
        maxGap = 0;
        zeroAdvanceWhilePlayingCount = 0;
        largeDiscontinuityCount = 0;
        expectedAdvanceSec = 0;
        actualAdvanceSec = 0;
        frozenWhilePlayingCount = 0;
      },
      /**
       * @param {HTMLVideoElement} v
       * @param {number} wallMs
       */
      onTimeupdate(v, wallMs) {
        const ct = typeof v.currentTime === "number" && Number.isFinite(v.currentTime) ? v.currentTime : null;
        const paused = !!v.paused;
        const seeking = !!v.seeking;
        const rate = typeof v.playbackRate === "number" && v.playbackRate > 0 ? v.playbackRate : 1;
        if (lastTuWall > 0 && wallMs > lastTuWall && wallMs - lastTuWall < 12e4) {
          const gap = wallMs - lastTuWall;
          sumGap += gap;
          gapCount += 1;
          if (gap > maxGap) maxGap = gap;
        }
        if (typeof ct === "number" && lastTuCt != null && !seeking) {
          const dct = ct - lastTuCt;
          if (!paused && Math.abs(dct) > LARGE_DISCONTINUITY_SEC) largeDiscontinuityCount += 1;
        }
        if (!paused && !seeking && typeof ct === "number" && lastTuCt != null && lastTuWall > 0) {
          const wallSec = (wallMs - lastTuWall) / 1e3;
          if (wallSec > 0 && wallSec < 60) {
            const dct = ct - lastTuCt;
            if (Math.abs(dct) < LARGE_DISCONTINUITY_SEC) {
              expectedAdvanceSec += wallSec * rate;
              actualAdvanceSec += dct;
            }
          }
        }
        lastTuWall = wallMs;
        lastTuCt = ct;
      },
      onFrozenHeuristic() {
        frozenWhilePlayingCount += 1;
        zeroAdvanceWhilePlayingCount += 1;
      },
      getSummary() {
        const averageTimeupdateGapMs = gapCount ? +(sumGap / gapCount).toFixed(1) : null;
        const expectedVsActualAdvanceRatio = expectedAdvanceSec > 0.25 && Number.isFinite(actualAdvanceSec) ? +(actualAdvanceSec / expectedAdvanceSec).toFixed(3) : null;
        return {
          averageTimeupdateGapMs,
          maxTimeupdateGapMs: maxGap > 0 ? maxGap : null,
          timeupdateGapSampleCount: gapCount,
          zeroAdvanceWhilePlayingCount,
          largeDiscontinuityCount,
          expectedVsActualAdvanceRatio,
          frozenWhilePlayingCount
        };
      }
    };
  }
  function createVideoPlayerProfiler(opts) {
    const getVideo = opts.getVideo;
    const enrichSnapshot = typeof opts.enrichSnapshot === "function" ? opts.enrichSnapshot : null;
    const getExportExtras = typeof opts.getExportExtras === "function" ? opts.getExportExtras : null;
    const snapshotIntervalMs = Math.max(500, opts.snapshotIntervalMs ?? 3e3);
    const maxSnapshots = Math.min(2e4, Math.max(50, opts.maxSnapshots ?? 4e3));
    const maxEvents = Math.min(5e4, Math.max(200, opts.maxEvents ?? 2e4));
    const stallCheckIntervalMs = Math.max(200, opts.stallCheckIntervalMs ?? 500);
    const timeupdateLogMinIntervalMs = Math.max(500, opts.timeupdateLogMinIntervalMs ?? 2e3);
    const progressLogMinIntervalMs = Math.max(500, opts.progressLogMinIntervalMs ?? 2e3);
    const events = [];
    const eventTypeCounts = {};
    const snapshots = [];
    let recording = false;
    let startedAtMs = (
      /** @type {number|null} */
      null
    );
    let endedAtMs = (
      /** @type {number|null} */
      null
    );
    let snapshotEnrichContext = (
      /** @type {{ userMarker?: boolean, seq?: number, note?: string }|null} */
      null
    );
    let snapshotTimerId = null;
    let stallTimerId = null;
    let boundEl = null;
    let lastTimeupdateLogAt = 0;
    let lastProgressLogAt = 0;
    let stallPrev = null;
    let playheadStallMarkers = 0;
    let lastMediaError = null;
    let lastPlaybackQualitySample = null;
    let sessionMonoOrigin = (
      /** @type {number|null} */
      null
    );
    let lastSrcFinger = "";
    let userMarkerSeq = 0;
    const progression = createProgressionTracker();
    let bufferRecoveryActive = false;
    let bufferRecoveryStartAt = 0;
    let lastDerivedFrozenAt = 0;
    let lastAdModeVisible = null;
    let lastSnapshotBrief = null;
    let playbackRateNudgeActive = false;
    let pageHideHandler = null;
    function pushDerived(type, detail = {}) {
      if (!recording) return;
      const row = { type: String(type).slice(0, 72), derived: true, ...detail };
      pushEvent(row);
    }
    function endBufferRecovery(reason) {
      if (!bufferRecoveryActive) return;
      const now = Date.now();
      pushDerived("buffer_recovery_end", {
        durationMs: Math.min(6e5, now - bufferRecoveryStartAt),
        reason: truncUrl(String(reason || ""), 48)
      });
      bufferRecoveryActive = false;
    }
    function considerDerivedFromMediaEvent(type, v) {
      if (!recording || !v || !(v instanceof HTMLVideoElement)) return;
      if (type === "waiting" || type === "stalled") {
        if (!v.paused && !v.ended && !bufferRecoveryActive) {
          bufferRecoveryActive = true;
          bufferRecoveryStartAt = Date.now();
          pushDerived("buffer_recovery_start", {
            from: type,
            currentTime: typeof v.currentTime === "number" ? +v.currentTime.toFixed(3) : null,
            readyState: v.readyState,
            playbackRate: v.playbackRate
          });
        }
        return;
      }
      if (bufferRecoveryActive && (type === "playing" || type === "canplaythrough" || type === "seeked" || type === "pause" || type === "emptied" || type === "abort")) {
        endBufferRecovery(type);
      }
    }
    function snapshotBriefFromSnap(snap) {
      return {
        currentTime: snap.currentTime,
        bufferAheadSec: snap.bufferAheadSec,
        playbackRate: snap.playbackRate,
        readyState: snap.readyState,
        paused: snap.paused,
        seeking: snap.seeking,
        currentSrc: snap.currentSrc,
        documentVisibility: snap.documentVisibility,
        videoPresent: snap.videoPresent
      };
    }
    function recordDecisionEvent(type, detail) {
      if (!recording) return;
      const t = String(type || "unknown").slice(0, 72);
      const base = sanitizeDecisionDetail(detail);
      pushEvent({ type: t, decision: true, ...base });
    }
    function recordRemoteSyncApplyPhase(phase, detail) {
      if (!recording) return;
      const p = phase === "end" ? "end" : "start";
      const base = sanitizeDecisionDetail(detail);
      pushDerived(p === "start" ? "remote_sync_apply_start" : "remote_sync_apply_end", base);
    }
    function recordPlaybackRateNudgePhase(phase, detail) {
      if (!recording) return;
      const p = phase === "end" ? "end" : "start";
      const base = sanitizeDecisionDetail(detail);
      if (p === "start") {
        playbackRateNudgeActive = true;
        pushDerived("playback_rate_nudge_start", base);
      } else {
        if (!playbackRateNudgeActive) return;
        playbackRateNudgeActive = false;
        pushDerived("playback_rate_nudge_end", base);
      }
    }
    function pushEvent(ev) {
      const t = typeof ev.t === "number" ? ev.t : Date.now();
      const type = String(ev.type || "unknown");
      eventTypeCounts[type] = (eventTypeCounts[type] || 0) + 1;
      const mono = perfNowMs();
      const row = {
        t,
        ...ev,
        ...mono != null && sessionMonoOrigin != null ? { monoMs: +(mono - sessionMonoOrigin).toFixed(1) } : {}
      };
      events.push(row);
      while (events.length > maxEvents) events.shift();
    }
    let lastIntersectionSample = null;
    let ioObserver = null;
    let longTaskObs = null;
    function disconnectIntersectionObserver() {
      if (ioObserver) {
        try {
          ioObserver.disconnect();
        } catch {
        }
        ioObserver = null;
      }
      lastIntersectionSample = null;
    }
    function attachIntersectionObserver(v) {
      disconnectIntersectionObserver();
      if (!recording || !v || !(v instanceof HTMLVideoElement)) return;
      try {
        ioObserver = new IntersectionObserver(
          (entries) => {
            if (!recording || !entries.length) return;
            const e = entries[entries.length - 1];
            const br = e.boundingClientRect;
            const ir = e.intersectionRect;
            lastIntersectionSample = {
              at: Date.now(),
              intersectionRatio: +e.intersectionRatio.toFixed(3),
              isIntersecting: e.isIntersecting,
              boundingClientRect: {
                x: +br.x.toFixed(0),
                y: +br.y.toFixed(0),
                w: +br.width.toFixed(0),
                h: +br.height.toFixed(0)
              },
              intersectionRect: {
                x: +ir.x.toFixed(0),
                y: +ir.y.toFixed(0),
                w: +ir.width.toFixed(0),
                h: +ir.height.toFixed(0)
              }
            };
          },
          { threshold: [0, 0.01, 0.1, 0.25, 0.5, 0.75, 1] }
        );
        ioObserver.observe(v);
      } catch {
        ioObserver = null;
      }
    }
    function disconnectLongTaskObserver() {
      if (longTaskObs) {
        try {
          longTaskObs.disconnect();
        } catch {
        }
        longTaskObs = null;
      }
    }
    function attachLongTaskObserver() {
      disconnectLongTaskObserver();
      if (!recording) return;
      try {
        const PO = typeof PerformanceObserver !== "undefined" ? PerformanceObserver : null;
        if (!PO) return;
        longTaskObs = new PerformanceObserver((list) => {
          if (!recording) return;
          for (const e of list.getEntries()) {
            pushEvent({
              type: "performance_longtask",
              durationMs: +e.duration.toFixed(1),
              startTimeMs: +e.startTime.toFixed(1),
              name: String(e.name || "longtask").slice(0, 96)
            });
          }
        });
        longTaskObs.observe({ type: "longtask", buffered: true });
      } catch {
        longTaskObs = null;
      }
    }
    function pushSnapshot() {
      const v = getVideo();
      const snap = (
        /** @type {Record<string, unknown>} */
        captureVideoSnapshot(v)
      );
      if (lastIntersectionSample) {
        snap.intersectionObserver = { ...lastIntersectionSample };
      }
      if (lastVideoFrameCallbackSample) {
        snap.videoFrameCallback = { ...lastVideoFrameCallbackSample };
      }
      const q = snap.playbackQuality;
      if (q && typeof q === "object" && lastPlaybackQualitySample) {
        const t0 = lastPlaybackQualitySample.totalVideoFrames;
        const d0 = lastPlaybackQualitySample.droppedVideoFrames;
        const t1 = (
          /** @type {{ totalVideoFrames?: number }} */
          q.totalVideoFrames
        );
        const d1 = (
          /** @type {{ droppedVideoFrames?: number }} */
          q.droppedVideoFrames
        );
        if (typeof t1 === "number" && typeof d1 === "number" && typeof t0 === "number" && typeof d0 === "number") {
          snap.playbackQualityDelta = {
            totalVideoFramesDelta: t1 - t0,
            droppedVideoFramesDelta: d1 - d0
          };
        }
      }
      if (q && typeof q === "object") {
        const tq = (
          /** @type {{ totalVideoFrames?: number, droppedVideoFrames?: number }} */
          q
        );
        lastPlaybackQualitySample = {
          totalVideoFrames: typeof tq.totalVideoFrames === "number" ? tq.totalVideoFrames : null,
          droppedVideoFrames: typeof tq.droppedVideoFrames === "number" ? tq.droppedVideoFrames : null
        };
      }
      if (typeof snap.perfNowMs === "number" && sessionMonoOrigin != null) {
        snap.monoSinceSessionStartMs = +(snap.perfNowMs - sessionMonoOrigin).toFixed(1);
      }
      if (v && v instanceof HTMLVideoElement && recording) {
        const finger = String(v.currentSrc || "").slice(0, 96);
        if (lastSrcFinger && finger && finger !== lastSrcFinger) {
          pushEvent({
            type: "current_src_changed",
            from: truncUrl(lastSrcFinger, 72),
            to: truncUrl(finger, 72)
          });
          pushDerived("src_swap_detected", {
            from: truncUrl(lastSrcFinger, 72),
            to: truncUrl(finger, 72)
          });
        }
        if (finger) lastSrcFinger = finger;
      }
      const enrichCtx = snapshotEnrichContext;
      snapshotEnrichContext = null;
      if (enrichSnapshot) {
        try {
          enrichSnapshot(snap, v, enrichCtx);
        } catch {
        }
      }
      try {
        const vis = adModeVisibleFromSnapshot(
          /** @type {Record<string, unknown>} */
          snap
        );
        if (lastAdModeVisible === null) {
          lastAdModeVisible = vis;
        } else if (lastAdModeVisible !== vis) {
          if (vis) pushDerived("ad_mode_visible_start", { snapshotAt: snap.at });
          else pushDerived("ad_mode_visible_end", { snapshotAt: snap.at });
          lastAdModeVisible = vis;
        }
      } catch {
      }
      const brief = snapshotBriefFromSnap(
        /** @type {Record<string, unknown>} */
        snap
      );
      const deltaSummary = computeDeltaSummary(lastSnapshotBrief, brief);
      if (deltaSummary) {
        snap.deltaSummary = deltaSummary;
      }
      lastSnapshotBrief = brief;
      snapshots.push(snap);
      while (snapshots.length > maxSnapshots) snapshots.shift();
    }
    const videoListenerNames = [
      "play",
      "pause",
      "playing",
      "waiting",
      "stalled",
      "seeking",
      "seeked",
      "timeupdate",
      "loadedmetadata",
      "loadeddata",
      "canplay",
      "canplaythrough",
      "progress",
      "suspend",
      "abort",
      "error",
      "emptied",
      "ratechange",
      "durationchange",
      "volumechange",
      "ended",
      "resize",
      "enterpictureinpicture",
      "leavepictureinpicture",
      "encrypted",
      "waitingforkey"
    ];
    let vfcHandle = null;
    let vfcEl = null;
    let lastVideoFrameCallbackSample = null;
    function stopVideoFrameMetrics() {
      if (vfcEl != null && vfcHandle != null) {
        try {
          if (typeof vfcEl.cancelVideoFrameCallback === "function") {
            vfcEl.cancelVideoFrameCallback(vfcHandle);
          }
        } catch {
        }
      }
      vfcHandle = null;
      vfcEl = null;
    }
    function startVideoFrameMetrics(el) {
      stopVideoFrameMetrics();
      lastVideoFrameCallbackSample = null;
      if (!recording || !el || typeof el.requestVideoFrameCallback !== "function") return;
      vfcEl = el;
      const tick = (now, metadata) => {
        if (!recording || boundEl !== el) return;
        try {
          const md = metadata && typeof metadata === "object" ? (
            /** @type {Record<string, unknown>} */
            metadata
          ) : {};
          lastVideoFrameCallbackSample = {
            at: Date.now(),
            perfNowMs: typeof now === "number" ? +now.toFixed(3) : null,
            mediaTime: typeof md.mediaTime === "number" ? +/** @type {number} */
            md.mediaTime.toFixed(4) : null,
            presentationTime: typeof md.presentationTime === "number" ? +/** @type {number} */
            md.presentationTime.toFixed(3) : null,
            presentedWidth: typeof md.width === "number" ? md.width : null,
            presentedHeight: typeof md.height === "number" ? md.height : null
          };
        } catch {
        }
        if (!recording || boundEl !== el) return;
        try {
          vfcHandle = el.requestVideoFrameCallback(tick);
        } catch {
          vfcHandle = null;
        }
      };
      try {
        vfcHandle = el.requestVideoFrameCallback(tick);
      } catch {
        vfcHandle = null;
        vfcEl = null;
      }
    }
    function onVideoError(e) {
      const el = (
        /** @type {HTMLVideoElement} */
        e.target
      );
      try {
        const err = el.error;
        lastMediaError = err;
        const code = err ? err.code : -1;
        pushEvent({
          type: "error",
          mediaErrorCode: code,
          mediaErrorName: MEDIA_ERROR_NAMES[
            /** @type {1|2|3|4} */
            code
          ] || `UNKNOWN_${code}`,
          message: err && err.message ? truncUrl(err.message, 160) : ""
        });
      } catch {
        pushEvent({ type: "error", mediaErrorCode: -1, mediaErrorName: "UNKNOWN", message: "" });
      }
    }
    function onVideoGeneric(e) {
      const type = e.type;
      const v = (
        /** @type {HTMLVideoElement} */
        e.target
      );
      const now = Date.now();
      if (type === "timeupdate") {
        try {
          progression.onTimeupdate(v, now);
        } catch {
        }
        if (now - lastTimeupdateLogAt < timeupdateLogMinIntervalMs) return;
        lastTimeupdateLogAt = now;
      }
      if (type === "progress") {
        if (now - lastProgressLogAt < progressLogMinIntervalMs) return;
        lastProgressLogAt = now;
      }
      considerDerivedFromMediaEvent(type, v);
      pushEvent({
        t: now,
        type,
        currentTime: typeof v.currentTime === "number" ? +v.currentTime.toFixed(3) : null,
        paused: v.paused,
        seeking: v.seeking,
        readyState: v.readyState,
        playbackRate: v.playbackRate
      });
    }
    function unbindVideo() {
      if (!boundEl) return;
      stopVideoFrameMetrics();
      boundEl.removeEventListener("error", onVideoError);
      for (const n of videoListenerNames) {
        if (n === "error") continue;
        boundEl.removeEventListener(n, onVideoGeneric);
      }
      boundEl = null;
    }
    function bindVideo(v) {
      if (v === boundEl) return;
      const prevEl = boundEl;
      unbindVideo();
      if (!v || !(v instanceof HTMLVideoElement)) return;
      boundEl = v;
      if (recording && prevEl instanceof HTMLVideoElement && prevEl !== v) {
        pushEvent({
          type: "video_element_rebound",
          prevSrc: truncUrl(prevEl.currentSrc, 80),
          newSrc: truncUrl(v.currentSrc, 80)
        });
        lastSrcFinger = "";
      }
      boundEl.addEventListener("error", onVideoError);
      for (const n of videoListenerNames) {
        if (n === "error") continue;
        boundEl.addEventListener(n, onVideoGeneric);
      }
      if (recording) {
        attachIntersectionObserver(boundEl);
        startVideoFrameMetrics(boundEl);
      }
    }
    function syncBoundVideo() {
      const v = getVideo();
      bindVideo(v);
    }
    function onVisibilityChange() {
      if (!recording) return;
      try {
        pushEvent({
          type: "page_visibility",
          hidden: document.hidden,
          visibilityState: document.visibilityState || ""
        });
      } catch {
      }
    }
    function onFullscreenChange() {
      if (!recording) return;
      try {
        const fs = document.fullscreenElement || document.webkitFullscreenElement || null;
        pushEvent({
          type: "page_fullscreen",
          active: !!fs,
          tag: fs && fs instanceof Element ? fs.tagName : null
        });
      } catch {
      }
    }
    let visHandler = null;
    let fsHandler = null;
    let winFocusHandler = null;
    let winBlurHandler = null;
    let winResizeHandler = null;
    function onWindowFocus() {
      if (!recording) return;
      try {
        pushEvent({ type: "page_window_focus", hasFocus: true });
      } catch {
      }
    }
    function onWindowBlur() {
      if (!recording) return;
      try {
        pushEvent({ type: "page_window_focus", hasFocus: false });
      } catch {
      }
    }
    function onWindowResize() {
      if (!recording) return;
      try {
        if (typeof window === "undefined") return;
        pushEvent({ type: "window_resize", innerWidth: window.innerWidth, innerHeight: window.innerHeight });
      } catch {
      }
    }
    function onPageHide() {
      if (!recording) return;
      try {
        pushEvent({ type: "page_lifecycle", phase: "pagehide" });
      } catch {
      }
    }
    function startPageListeners() {
      if (typeof document === "undefined") return;
      visHandler = onVisibilityChange;
      fsHandler = onFullscreenChange;
      document.addEventListener("visibilitychange", visHandler);
      document.addEventListener("fullscreenchange", fsHandler);
      try {
        document.addEventListener("webkitfullscreenchange", fsHandler);
      } catch {
      }
      if (typeof window !== "undefined") {
        winFocusHandler = onWindowFocus;
        winBlurHandler = onWindowBlur;
        winResizeHandler = onWindowResize;
        window.addEventListener("focus", winFocusHandler);
        window.addEventListener("blur", winBlurHandler);
        window.addEventListener("resize", winResizeHandler);
        pageHideHandler = onPageHide;
        window.addEventListener("pagehide", pageHideHandler);
      }
    }
    function stopPageListeners() {
      if (typeof document === "undefined") return;
      if (visHandler) document.removeEventListener("visibilitychange", visHandler);
      if (fsHandler) {
        document.removeEventListener("fullscreenchange", fsHandler);
        try {
          document.removeEventListener("webkitfullscreenchange", fsHandler);
        } catch {
        }
      }
      visHandler = null;
      fsHandler = null;
      if (typeof window !== "undefined") {
        if (winFocusHandler) window.removeEventListener("focus", winFocusHandler);
        if (winBlurHandler) window.removeEventListener("blur", winBlurHandler);
        if (winResizeHandler) window.removeEventListener("resize", winResizeHandler);
        if (pageHideHandler) window.removeEventListener("pagehide", pageHideHandler);
      }
      winFocusHandler = null;
      winBlurHandler = null;
      winResizeHandler = null;
      pageHideHandler = null;
    }
    function stallTick() {
      if (!recording) return;
      syncBoundVideo();
      const v = getVideo();
      const now = Date.now();
      if (!v || v.paused || v.seeking || !v.playbackRate) {
        stallPrev = null;
        return;
      }
      const ct = v.currentTime;
      if (typeof ct !== "number" || !Number.isFinite(ct)) {
        stallPrev = null;
        return;
      }
      if (!stallPrev) {
        stallPrev = { t: now, ct };
        return;
      }
      const wallSec = (now - stallPrev.t) / 1e3;
      const deltaCt = ct - stallPrev.ct;
      const expected = wallSec * v.playbackRate;
      if (wallSec >= 0.45 && expected > 0.08 && deltaCt < expected * 0.22) {
        playheadStallMarkers++;
        pushEvent({
          type: "playhead_stall_heuristic",
          wallSec: +wallSec.toFixed(3),
          deltaCurrentTime: +deltaCt.toFixed(4),
          expectedAdvance: +expected.toFixed(4),
          playbackRate: v.playbackRate,
          readyState: v.readyState
        });
        try {
          progression.onFrozenHeuristic();
        } catch {
        }
        if (now - lastDerivedFrozenAt >= DERIVED_FROZEN_DEBOUNCE_MS) {
          lastDerivedFrozenAt = now;
          pushDerived("video_frozen_but_not_paused", {
            wallSec: +wallSec.toFixed(3),
            deltaCurrentTime: +deltaCt.toFixed(4),
            expectedAdvance: +expected.toFixed(4),
            playbackRate: v.playbackRate,
            readyState: v.readyState
          });
        }
      }
      stallPrev = { t: now, ct };
    }
    function snapshotTick() {
      if (!recording) return;
      syncBoundVideo();
      pushSnapshot();
    }
    return {
      start() {
        if (recording) return;
        events.length = 0;
        snapshots.length = 0;
        for (const k of Object.keys(eventTypeCounts)) delete eventTypeCounts[k];
        lastTimeupdateLogAt = 0;
        lastProgressLogAt = 0;
        lastVideoFrameCallbackSample = null;
        stallPrev = null;
        playheadStallMarkers = 0;
        lastMediaError = null;
        lastPlaybackQualitySample = null;
        lastSrcFinger = "";
        userMarkerSeq = 0;
        progression.reset();
        bufferRecoveryActive = false;
        bufferRecoveryStartAt = 0;
        lastDerivedFrozenAt = 0;
        lastAdModeVisible = null;
        lastSnapshotBrief = null;
        playbackRateNudgeActive = false;
        sessionMonoOrigin = perfNowMs();
        endedAtMs = null;
        startedAtMs = Date.now();
        recording = true;
        syncBoundVideo();
        pushEvent({
          type: "session_start",
          snapshotIntervalMs,
          maxSnapshots,
          maxEvents,
          schema: PROFILER_SCHEMA
        });
        pushSnapshot();
        attachLongTaskObserver();
        startPageListeners();
        onVisibilityChange();
        snapshotTimerId = setInterval(snapshotTick, snapshotIntervalMs);
        stallTimerId = setInterval(stallTick, stallCheckIntervalMs);
      },
      stop() {
        if (!recording) return;
        recording = false;
        endedAtMs = Date.now();
        if (snapshotTimerId) {
          clearInterval(snapshotTimerId);
          snapshotTimerId = null;
        }
        if (stallTimerId) {
          clearInterval(stallTimerId);
          stallTimerId = null;
        }
        stopPageListeners();
        pushEvent({ type: "session_stop" });
        pushSnapshot();
        disconnectIntersectionObserver();
        disconnectLongTaskObserver();
        unbindVideo();
      },
      /** Call when <video> may have been swapped while recording */
      notifyVideoMayHaveChanged() {
        if (recording) syncBoundVideo();
      },
      /**
       * Annotate the timeline (e.g. “ad started”, “sync broke”) — adds an event and an extra snapshot.
       * @param {string} [note]
       */
      dropMarker(note) {
        if (!recording) return false;
        userMarkerSeq += 1;
        const label = note != null && String(note).trim() !== "" ? truncUrl(String(note).trim(), 140) : `marker_${userMarkerSeq}`;
        pushEvent({ type: "user_marker", seq: userMarkerSeq, note: label });
        snapshotEnrichContext = { userMarker: true, seq: userMarkerSeq, note: label };
        pushSnapshot();
        return true;
      },
      isRecording() {
        return recording;
      },
      getStatus() {
        const maxWallMin = Math.max(1, Math.round(maxSnapshots * snapshotIntervalMs / 6e4));
        return {
          recording,
          startedAtMs,
          endedAtMs,
          snapshotCount: snapshots.length,
          eventCount: events.length,
          eventTypeCounts: { ...eventTypeCounts },
          userMarkerCount: eventTypeCounts.user_marker ?? 0,
          playheadStallMarkers,
          recordingLimits: {
            snapshotIntervalMs,
            maxSnapshots,
            maxEvents,
            /** Wall-time span represented if the snapshot buffer is full (ring drops oldest). */
            approxMaxWallMinutes: maxWallMin
          },
          lastMediaError: lastMediaError ? {
            code: lastMediaError.code,
            name: MEDIA_ERROR_NAMES[
              /** @type {1|2|3|4} */
              lastMediaError.code
            ] || `UNKNOWN_${lastMediaError.code}`,
            message: lastMediaError.message ? truncUrl(lastMediaError.message, 120) : ""
          } : null,
          progressionQuality: progression.getSummary()
        };
      },
      /**
       * @param {object} pageMeta
       * @param {string} [pageMeta.hostname]
       * @param {string} [pageMeta.pathname]
       * @param {string} [pageMeta.userAgent]
       * @param {string} [pageMeta.platformHandlerKey]
       * @param {string} [pageMeta.extensionVersion]
       * @param {{ compact?: boolean, includeVideoFrame?: boolean }} [exportOpts]
       */
      buildExportPayload(pageMeta = {}, exportOpts = {}) {
        const compact = !!exportOpts.compact;
        const includeVideoFrame = !!exportOpts.includeVideoFrame;
        const st = this.getStatus();
        const rollup = computeSessionRollup(snapshots, events);
        const capMin = Math.max(1, Math.round(maxSnapshots * snapshotIntervalMs / 6e4));
        let snapOut = snapshots.slice();
        if (compact && snapOut.length > 520) {
          snapOut = snapOut.slice(-520);
        }
        if (compact && snapOut.length > 1) {
          for (let i = 0; i < snapOut.length - 1; i++) {
            const s = snapOut[i];
            if (s && typeof s === "object" && "videoElement" in /** @type {object} */
            s) {
              delete /** @type {Record<string, unknown>} */
              s.videoElement;
            }
          }
        }
        const payload = {
          schema: PROFILER_SCHEMA,
          exportedAtMs: Date.now(),
          exportOptions: { compact, includeVideoFrame },
          session: {
            startedAtMs,
            endedAtMs,
            recording,
            sessionMonoOriginMs: sessionMonoOrigin,
            environment: captureEnvironmentSnapshot(),
            options: {
              snapshotIntervalMs,
              maxSnapshots,
              maxEvents,
              stallCheckIntervalMs,
              timeupdateLogMinIntervalMs,
              progressLogMinIntervalMs
            },
            summary: {
              snapshotCount: snapshots.length,
              eventCount: events.length,
              eventTypeCounts: { ...eventTypeCounts },
              playheadStallMarkers: st.playheadStallMarkers,
              lastMediaError: st.lastMediaError,
              progressionQuality: progression.getSummary()
            },
            timelineCapacity: {
              snapshotIntervalMs,
              maxSnapshots,
              maxEvents,
              approxMaxWallMinutesIfBufferFull: capMin,
              ringBufferBehavior: "When snapshot or event caps are reached, oldest rows are removed; recording and the extension continue."
            },
            rollup
          },
          page: {
            hostname: pageMeta.hostname != null ? String(pageMeta.hostname) : "",
            pathname: pageMeta.pathname != null ? String(pageMeta.pathname) : "",
            userAgent: pageMeta.userAgent != null ? truncUrl(pageMeta.userAgent, 220) : "",
            platformHandlerKey: pageMeta.platformHandlerKey != null ? String(pageMeta.platformHandlerKey) : "",
            extensionVersion: pageMeta.extensionVersion != null ? String(pageMeta.extensionVersion) : ""
          },
          snapshots: snapOut,
          events: events.slice()
        };
        if (includeVideoFrame) {
          payload.videoFrame = tryCaptureVideoFrameDataUrl(getVideo());
        }
        if (getExportExtras) {
          try {
            const x = getExportExtras();
            if (x && typeof x === "object") Object.assign(payload, x);
          } catch {
          }
        }
        return payload;
      },
      clearSession() {
        const wasRec = recording;
        if (wasRec) this.stop();
        events.length = 0;
        snapshots.length = 0;
        for (const k of Object.keys(eventTypeCounts)) delete eventTypeCounts[k];
        startedAtMs = null;
        endedAtMs = null;
        playheadStallMarkers = 0;
        lastMediaError = null;
        stallPrev = null;
        lastSrcFinger = "";
        sessionMonoOrigin = null;
        userMarkerSeq = 0;
        lastVideoFrameCallbackSample = null;
        progression.reset();
        bufferRecoveryActive = false;
        bufferRecoveryStartAt = 0;
        lastDerivedFrozenAt = 0;
        lastAdModeVisible = null;
        lastSnapshotBrief = null;
        playbackRateNudgeActive = false;
        disconnectIntersectionObserver();
        disconnectLongTaskObserver();
        unbindVideo();
      },
      recordDecisionEvent,
      /** @param {'start'|'end'} phase @param {Record<string, unknown>|null|undefined} [detail] */
      recordRemoteSyncApply(phase, detail) {
        recordRemoteSyncApplyPhase(phase, detail);
      },
      /** @param {'start'|'end'} phase @param {Record<string, unknown>|null|undefined} [detail] */
      recordPlaybackRateNudge(phase, detail) {
        recordPlaybackRateNudgePhase(phase, detail);
      }
    };
  }

  // content/src/sites/prime-video-sync.js
  var PRIME_SYNC_HANDLER_KEY = "prime";
  var PRIME_SYNC_DEBUG_STORAGE_KEY = "primeSyncDebugHud";
  var PRIME_PRIORITY_VIDEO_SELECTORS = [
    ".atvwebplayersdk-video-canvas video",
    ".atvwebplayersdk-player-container video",
    ".webPlayerInner video"
  ];
  function isPrimeVideoHostname(hostname) {
    const h = (hostname || "").toLowerCase();
    return /primevideo\.com/.test(h) || /amazon\.(com|ca)/.test(h);
  }
  function getPrimePlaybackProfilePatch() {
    return {
      handlerKey: PRIME_SYNC_HANDLER_KEY,
      label: "Prime Video",
      useRelaxedVideoReady: true,
      hostPositionIntervalMs: contentConstants.PRIME_HOST_POSITION_INTERVAL_MS,
      viewerReconcileIntervalMs: contentConstants.PRIME_VIEWER_RECONCILE_INTERVAL_MS,
      hostSeekSuppressAfterPlayMs: contentConstants.HOST_SEEK_SUPPRESS_AFTER_PLAY_MS_PRIME,
      syncRequestDelayMs: 900,
      aggressiveRemoteSync: true,
      syncStateApplyDelayMs: contentConstants.PRIME_SYNC_STATE_APPLY_DELAY_MS,
      applyDebounceMs: contentConstants.PRIME_APPLY_DEBOUNCE_MS,
      playbackOutboundCoalesceMs: contentConstants.PRIME_PLAYBACK_OUTBOUND_COALESCE_MS,
      playbackSlackSec: contentConstants.SYNC_THRESHOLD_PRIME,
      timeJumpThresholdSec: contentConstants.PRIME_TIME_JUMP_THRESHOLD,
      pauseSeekOutboundPlaySuppressMs: contentConstants.PRIME_PAUSE_SEEK_OUTBOUND_PLAY_SUPPRESS_MS
    };
  }
  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    } catch {
      return false;
    }
  }
  function primePlayerShellRoot() {
    try {
      return document.querySelector(".atvwebplayersdk-player-container") || document.querySelector('[class*="atvwebplayersdk-player" i]');
    } catch {
      return null;
    }
  }
  function isPrimeCaptionsSubtree(el) {
    try {
      return !!el.closest?.(
        '.atvwebplayersdk-captions-overlay, [class*="atvwebplayersdk-captions" i], .atvwebplayersdk-text-track-container'
      );
    } catch {
      return false;
    }
  }
  function channelAdCountdownUi() {
    try {
      const nodes = document.querySelectorAll(
        '[class*="adtimeindicator" i], [class*="AdTimeIndicator" i], .atvwebplayersdk-adtimeindicator-text'
      );
      for (const el of nodes) {
        if (isPrimeCaptionsSubtree(el)) continue;
        if (!isVisible(el)) continue;
        const t = (el.textContent || "").trim().toLowerCase();
        if (!t) continue;
        if (/resume|program|continue|back (soon|in|shortly)|will return|ends in|return(s)? in|\d+\s*:\s*\d|:\d{2}\b|\d+\s*(s|sec|seconds)\b/.test(
          t
        )) {
          return true;
        }
      }
    } catch {
    }
    return false;
  }
  function channelPrimeAdTimerChrome() {
    try {
      const selectors = [
        '[class*="atvwebplayersdk-ad-timer" i]',
        '[class*="atvwebplayersdk-go-ad-free" i]'
      ];
      const seen = /* @__PURE__ */ new Set();
      for (const sel of selectors) {
        let nodes;
        try {
          nodes = document.querySelectorAll(sel);
        } catch {
          continue;
        }
        for (const el of nodes) {
          if (!(el instanceof Element) || seen.has(el)) continue;
          seen.add(el);
          if (isPrimeCaptionsSubtree(el)) continue;
          if (!isVisible(el)) continue;
          const al = (el.getAttribute("aria-label") || "").toLowerCase();
          if (/\bad playing\b/.test(al)) return true;
          const compact = (el.textContent || "").replace(/\s+/g, "").toLowerCase();
          if (/^ad\d+:\d{2}/.test(compact)) return true;
          if (/goadfree/.test(compact)) return true;
          const cls = typeof el.className === "string" ? el.className : el.classList ? [...el.classList].join(" ") : "";
          if (/atvwebplayersdk-go-ad-free/i.test(cls)) return true;
        }
      }
    } catch {
    }
    return false;
  }
  function channelPlayerAdControls() {
    const root = primePlayerShellRoot();
    if (!root) return false;
    try {
      const nodes = root.querySelectorAll('button, [role="button"]');
      for (const el of nodes) {
        if (isPrimeCaptionsSubtree(el)) continue;
        if (!isVisible(el)) continue;
        const al = (el.getAttribute("aria-label") || "").toLowerCase();
        if (!al) continue;
        if (/\bskip\b.*\bad\b|^skip ad|\bskip ads\b|\badvertisement\b/.test(al)) return true;
      }
    } catch {
    }
    return false;
  }
  function channelMediaSessionAd() {
    try {
      const m = navigator.mediaSession?.metadata;
      if (!m) return false;
      const title = String(m.title || "").trim();
      const artist = String(m.artist || "").trim();
      if (!title && !artist) return false;
      if (/^advertisement[s]?$/i.test(title)) return true;
      if (/^commercial(\s|$)/i.test(title)) return true;
      if (/^ad\s*\d+\s*of\s*\d+/i.test(title)) return true;
      if (/^\(\s*ad\s*\)/i.test(title)) return true;
      return false;
    } catch {
      return false;
    }
  }
  function getPrimeAdDetectionSnapshot(_video) {
    const channels = {
      adCountdownUi: channelAdCountdownUi(),
      adTimerUi: channelPrimeAdTimerChrome(),
      playerAdControls: channelPlayerAdControls(),
      mediaSession: channelMediaSessionAd()
    };
    const reasons = (
      /** @type {string[]} */
      Object.entries(channels).filter(([, on]) => on).map(([k]) => k)
    );
    const authoritativeInAd = reasons.length > 0;
    return {
      likelyAd: authoritativeInAd,
      authoritativeInAd,
      score: reasons.length,
      reasons,
      hasStrong: authoritativeInAd,
      channels
    };
  }
  function detectPrimeVideoAd(video) {
    return getPrimeAdDetectionSnapshot(video).likelyAd;
  }
  function getPrimePlaybackConfidence(video) {
    if (!video || video.tagName !== "VIDEO") return "LOW";
    if (getPrimeAdDetectionSnapshot(video).likelyAd) return "LOW";
    try {
      if (video.seeking) return "LOW";
    } catch {
    }
    return "HIGH";
  }
  function summarizePlayerShell(root, opts = {}) {
    const maxNodes = opts.maxNodes ?? 90;
    const maxDepth = opts.maxDepth ?? 14;
    if (!root) return null;
    const nodes = [];
    let count = 0;
    function walk(el, depth) {
      if (!el || el.nodeType !== 1 || count >= maxNodes || depth > maxDepth) return;
      count++;
      let cls = "";
      try {
        if (typeof el.className === "string") cls = el.className;
        else if (el.classList) cls = [...el.classList].join(" ");
        else if (el.className && typeof el.className.baseVal === "string") cls = el.className.baseVal;
      } catch {
        cls = "";
      }
      const al = el.getAttribute("aria-label");
      const tid = el.getAttribute("data-testid");
      let textLeaf = "";
      if (el.childNodes.length === 1 && el.firstChild?.nodeType === 3) {
        textLeaf = String(el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 140);
      }
      nodes.push({
        depth,
        tag: el.tagName?.toLowerCase(),
        class: cls.slice(0, 220),
        ariaLabel: al ? String(al).slice(0, 220) : void 0,
        dataTestId: tid ? String(tid).slice(0, 120) : void 0,
        textLeaf: textLeaf || void 0,
        visible: isVisible(el)
      });
      for (const ch of el.children) {
        walk(ch, depth + 1);
        if (count >= maxNodes) return;
      }
    }
    walk(root, 0);
    return { truncated: count >= maxNodes, nodeCount: count, nodes };
  }
  function extractPrimePlayerUiSummary(shell) {
    if (!shell) return null;
    const out = { titleText: null, captionSnippet: null, loadingOverlayVisible: null };
    try {
      const t = shell.querySelector('.atvwebplayersdk-title-text, [class*="atvwebplayersdk-title-text"]');
      if (t) {
        const s = String(t.textContent || "").replace(/\s+/g, " ").trim().slice(0, 220);
        if (s) out.titleText = s;
      }
    } catch {
    }
    try {
      const c = shell.querySelector('.atvwebplayersdk-captions-text, [class*="atvwebplayersdk-captions-text"]');
      if (c) {
        const s = String(c.textContent || "").replace(/\s+/g, " ").trim().slice(0, 280);
        if (s) out.captionSnippet = s;
      }
    } catch {
    }
    try {
      const sp = shell.querySelector('.atvwebplayersdk-loadingspinner-overlay, [class*="loadingspinner-overlay"]');
      out.loadingOverlayVisible = sp ? isVisible(sp) : null;
    } catch {
    }
    return out;
  }
  function derivePrimeSyncDebugNotes(ctx, v, videoCandidates) {
    const notes = [];
    const pv = videoCandidates?.pageVideos || [];
    const inShell = pv.filter((x) => x.inMainSdkShell);
    const playing = inShell.filter((x) => !x.paused);
    const paused = inShell.filter((x) => x.paused);
    if (inShell.length >= 2 && playing.length >= 1 && paused.length >= 1) {
      notes.push({
        code: "prime_multi_video_mixed_state",
        detail: `${inShell.length} <video> near main shell (${playing.length} playing, ${paused.length} paused). Confirm findVideo() uses the playing element.`,
        pageVideoIndices: { playing: playing.map((x) => x.index), paused: paused.map((x) => x.index) }
      });
    }
    const la = ctx.lastAppliedState;
    if (la && v && v.tagName === "VIDEO") {
      try {
        const dt = Math.abs(v.currentTime - (Number(la.currentTime) || 0));
        const playMismatch = Boolean(la.playing) !== !v.paused;
        if (playMismatch || dt > 3) {
          notes.push({
            code: "extension_state_vs_video_mismatch",
            detail: `lastAppliedState t=${la.currentTime} playing=${la.playing} vs video t=${v.currentTime.toFixed(2)} paused=${v.paused}.`,
            deltaSec: +dt.toFixed(2),
            playMismatch,
            lastSyncAtAgeMs: typeof ctx.lastSyncAt === "number" && ctx.lastSyncAt > 1 ? Date.now() - ctx.lastSyncAt : null
          });
        }
      } catch {
      }
    }
    if (typeof ctx.lastSyncAt === "number" && ctx.lastSyncAt > 1) {
      const age = Date.now() - ctx.lastSyncAt;
      if (age > 15e3) {
        notes.push({
          code: "sync_apply_stale",
          detail: `No SYNC_STATE apply in ~${Math.round(age / 1e3)}s (extension lastAppliedState may lag).`
        });
      }
    }
    const fm = ctx.frameCaptureMeta;
    if (fm?.attempted && fm?.likelyDrmBlackOrBlank) {
      notes.push({
        code: "frame_png_likely_drm_blank",
        detail: "Attached frame PNG is often solid black under Widevine; use title/caption/video timings here instead of pixels."
      });
    }
    return { notes };
  }
  function collectAdRelatedHints() {
    const selectors = [
      '[class*="ad" i]',
      '[class*="Ad" i]',
      '[aria-label*="ad" i]',
      '[data-testid*="ad" i]',
      '[data-testid*="Ad" i]'
    ];
    const seen = /* @__PURE__ */ new Set();
    const rows = [];
    try {
      for (const sel of selectors) {
        let els;
        try {
          els = document.querySelectorAll(sel);
        } catch {
          continue;
        }
        for (const el of els) {
          if (!(el instanceof Element) || seen.has(el) || rows.length >= 45) continue;
          seen.add(el);
          const inShell = !!el.closest?.(
            '.atvwebplayersdk-player-container, [class*="atvwebplayersdk" i], .webPlayerInner'
          );
          rows.push({
            matchedBy: sel,
            tag: el.tagName?.toLowerCase(),
            class: String(el.className || "").slice(0, 180),
            ariaLabel: el.getAttribute("aria-label")?.slice(0, 180),
            dataTestId: el.getAttribute("data-testid")?.slice(0, 120),
            textPreview: String(el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
            visible: isVisible(el),
            inPlayerOrSdk: inShell
          });
        }
      }
    } catch {
    }
    return rows;
  }
  function safeVideoSrcSummary(v) {
    try {
      const s = v.currentSrc || v.src || "";
      if (!s) return null;
      if (s.startsWith("blob:")) return "blob:…";
      if (s.length > 120) return `${s.slice(0, 80)}…`;
      return s;
    } catch {
      return null;
    }
  }
  function rectSummary(el) {
    try {
      const r = el.getBoundingClientRect();
      return {
        x: +r.x.toFixed(0),
        y: +r.y.toFixed(0),
        w: +r.width.toFixed(0),
        h: +r.height.toFixed(0)
      };
    } catch {
      return null;
    }
  }
  function videoElementSyncDigest(v) {
    if (!v || v.tagName !== "VIDEO") return null;
    const bufferedRanges = [];
    try {
      const b = v.buffered;
      for (let i = 0; i < b.length; i++) {
        bufferedRanges.push([+b.start(i).toFixed(2), +b.end(i).toFixed(2)]);
      }
    } catch {
    }
    try {
      return {
        inMainSdkShell: isPrimeMainPlayerShell(v),
        paused: v.paused,
        ended: v.ended,
        muted: v.muted,
        volume: v.volume,
        playbackRate: v.playbackRate,
        currentTime: +v.currentTime.toFixed(3),
        duration: v.duration && !isNaN(v.duration) ? +v.duration.toFixed(2) : null,
        readyState: v.readyState,
        networkState: v.networkState,
        seeking: v.seeking,
        videoWidth: v.videoWidth,
        videoHeight: v.videoHeight,
        clientWidth: v.clientWidth,
        clientHeight: v.clientHeight,
        rect: rectSummary(v),
        currentSrcSummary: safeVideoSrcSummary(v),
        bufferedRanges: bufferedRanges.slice(0, 24)
      };
    } catch {
      return null;
    }
  }
  function videoCandidateLite(el, index) {
    return {
      index,
      inMainSdkShell: isPrimeMainPlayerShell(el),
      paused: el.paused,
      currentTime: +el.currentTime.toFixed(2),
      rect: rectSummary(el),
      visible: isVisible(el),
      videoWxH: el.videoWidth && el.videoHeight ? `${el.videoWidth}×${el.videoHeight}` : null
    };
  }
  function collectPrimeVideoCandidates(getVideo) {
    const priorityMatches = [];
    for (const sel of PRIME_PRIORITY_VIDEO_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        if (el && el.tagName === "VIDEO") priorityMatches.push({ selector: sel, ...videoCandidateLite(el) });
      } catch {
      }
    }
    const shell = primePlayerShellRoot();
    if (priorityMatches.length === 0 && shell) {
      let gi = 0;
      try {
        for (const el of document.querySelectorAll("video")) {
          if (!(el instanceof HTMLVideoElement)) continue;
          if (videoGeometricallyAlignedWithPrimeShell(el, shell)) {
            priorityMatches.push({
              selector: "__primeShellGeometry__",
              ...videoCandidateLite(el, gi++)
            });
          }
        }
      } catch {
      }
    }
    const pageVideos = [];
    try {
      let i = 0;
      for (const el of document.querySelectorAll("video")) {
        if (i >= 14) break;
        if (el instanceof HTMLVideoElement) pageVideos.push(videoCandidateLite(el, i));
        i++;
      }
    } catch {
    }
    const gv = typeof getVideo === "function" ? getVideo() : null;
    return {
      priorityMatches,
      pageVideos,
      primaryDigest: gv && gv.tagName === "VIDEO" ? videoElementSyncDigest(gv) : null
    };
  }
  function collectPlaybackControlHints() {
    const root = primePlayerShellRoot();
    if (!root) return [];
    const hints = [];
    try {
      let n = 0;
      const nodes = root.querySelectorAll('button, [role="button"]');
      for (const el of nodes) {
        if (n >= 42) break;
        if (!isVisible(el)) continue;
        const al = (el.getAttribute("aria-label") || "").slice(0, 140);
        const cls = String(el.className || "").slice(0, 140);
        if (!/play|pause|fullscreen|rewind|forward|skip|closed caption|subtitle|settings|theater|pip|picture/i.test(`${al} ${cls}`)) continue;
        hints.push({
          tag: el.tagName.toLowerCase(),
          ariaLabel: al || void 0,
          class: cls || void 0
        });
        n++;
      }
    } catch {
    }
    return hints;
  }
  function tryCapturePrimeVideoFramePng(v) {
    return new Promise((resolve) => {
      const meta = { attempted: true, ok: false };
      if (!v || v.tagName !== "VIDEO") {
        meta.reason = "no_video";
        resolve({ blob: null, meta });
        return;
      }
      try {
        const vw = v.videoWidth;
        const vh = v.videoHeight;
        meta.sourceVideoW = vw;
        meta.sourceVideoH = vh;
        if (!vw || !vh) {
          meta.reason = "no_video_dimensions";
          resolve({ blob: null, meta });
          return;
        }
        const maxW = 720;
        const maxH = 405;
        const scale = Math.min(1, maxW / vw, maxH / vh);
        const w = Math.max(2, Math.floor(vw * scale));
        const h = Math.max(2, Math.floor(vh * scale));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        if (!ctx) {
          meta.reason = "no_canvas_context";
          resolve({ blob: null, meta });
          return;
        }
        ctx.drawImage(v, 0, 0, w, h);
        meta.canvasW = w;
        meta.canvasH = h;
        let likelyBlank = false;
        try {
          const img = ctx.getImageData(0, 0, Math.min(48, w), Math.min(48, h));
          let sum = 0;
          const step = 16;
          let samples = 0;
          for (let i = 0; i < img.data.length; i += step) {
            sum += img.data[i] + img.data[i + 1] + img.data[i + 2];
            samples++;
          }
          const avg = samples ? sum / (samples * 3) : 0;
          likelyBlank = avg < 5;
        } catch {
          likelyBlank = true;
        }
        meta.likelyDrmBlackOrBlank = likelyBlank;
        c.toBlob(
          (blob) => {
            meta.ok = !!blob;
            if (!blob) meta.reason = meta.reason || "toBlob_null";
            resolve({ blob, meta });
          },
          "image/png",
          0.92
        );
      } catch (e) {
        const err = (
          /** @type {Error & { name?: string }} */
          e
        );
        meta.reason = err && err.name === "SecurityError" ? "security_error_tainted_canvas" : String(err?.message || err);
        resolve({ blob: null, meta });
      }
    });
  }
  function getClientNetworkHints() {
    try {
      const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (!c) return null;
      return {
        effectiveType: c.effectiveType,
        downlinkMbps: c.downlink,
        rttMs: c.rtt,
        saveData: !!c.saveData
      };
    } catch {
      return null;
    }
  }
  function capturePrimePlayerSyncDebugPayload(ctx = {}) {
    const getV = typeof ctx.getVideo === "function" ? ctx.getVideo : () => null;
    const v = getV();
    const snapshot = getPrimeAdDetectionSnapshot(v);
    let mediaSession = null;
    try {
      const m = navigator.mediaSession?.metadata;
      if (m) {
        mediaSession = {
          title: m.title != null ? String(m.title) : null,
          artist: m.artist != null ? String(m.artist) : null,
          album: m.album != null ? String(m.album) : null
        };
      }
    } catch {
    }
    const shell = primePlayerShellRoot();
    const shellDigest = summarizePlayerShell(shell, { maxNodes: 110, maxDepth: 15 });
    const videoCandidates = collectPrimeVideoCandidates(getV);
    const playerUiSummary = extractPrimePlayerUiSummary(shell);
    const syncDebugNotes = derivePrimeSyncDebugNotes(ctx, v, videoCandidates);
    return {
      kind: "playshare_prime_player_sync_debug_v1",
      meta: {
        capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
        href: typeof location !== "undefined" ? location.href : "",
        hostname: typeof location !== "undefined" ? location.hostname : "",
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
        visibilityState: typeof document !== "undefined" ? document.visibilityState : "",
        viewport: typeof window !== "undefined" ? { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio } : null,
        /** Minutes behind UTC; compare across peers for clock-skew suspicion with `multiUserSync.traceDeliveryEstimate`. */
        timezoneOffsetMin: typeof Date !== "undefined" ? (/* @__PURE__ */ new Date()).getTimezoneOffset() : null,
        clientNetworkHints: getClientNetworkHints()
      },
      frameCapture: ctx.frameCaptureMeta || { attempted: false },
      /** Title / caption / loading overlay — mirrors what the user sees when DRM blocks frame PNG. */
      playerUiSummary,
      /** Actionable mismatches (multi-video, stale sync, DRM frame). */
      syncDebugNotes,
      /** Filled by the content script: path kind, PiP/fullscreen, extension version, capture id — no manual notes required. */
      autoCaptureContext: ctx.autoCaptureContext ?? null,
      extension: {
        inRoom: !!ctx.inRoom,
        isHost: !!ctx.isHost,
        hostOnlyControl: !!ctx.hostOnlyControl,
        countdownOnPlay: !!ctx.countdownOnPlay,
        lastAppliedState: ctx.lastAppliedState ?? null,
        lastSentTime: ctx.lastSentTime,
        lastPlaybackOutboundKind: ctx.lastPlaybackOutboundKind ?? null,
        lastSyncAtAgeMs: typeof ctx.lastSyncAt === "number" && ctx.lastSyncAt > 1 ? Date.now() - ctx.lastSyncAt : null,
        localAdBreakActive: !!ctx.localAdBreakActive,
        findVideo: ctx.findVideoStats || null,
        videoHealth: ctx.videoHealth || null,
        viewerDriftSec: ctx.viewerDriftSec ?? null,
        extensionOps: ctx.extensionOpsSubset || null
      },
      playbackTuning: ctx.playbackTuning || null,
      primeAdDetection: snapshot,
      mediaSession,
      videoElement: v && v.tagName === "VIDEO" ? videoElementSyncDigest(v) : null,
      videoCandidates,
      playerShellDigest: shellDigest,
      playbackControlHints: collectPlaybackControlHints(),
      /**
       * Room + Railway/WebSocket path + multi-peer playback telemetry (from content script).
       * Correlate exports: same `room.roomCode`, nearby `meta.capturedAt`, compare `traceDeliveryEstimate` & `clusterPlayback`.
       */
      multiUserSync: ctx.multiUserSync ?? null
    };
  }
  function capturePrimeMissedAdDebugPayload(ctx = {}) {
    const getV = typeof ctx.getVideo === "function" ? ctx.getVideo : () => null;
    const v = getV();
    const snapshot = getPrimeAdDetectionSnapshot(v);
    let mediaSession = null;
    try {
      const m = navigator.mediaSession?.metadata;
      if (m) {
        mediaSession = {
          title: m.title != null ? String(m.title) : null,
          artist: m.artist != null ? String(m.artist) : null,
          album: m.album != null ? String(m.album) : null
        };
      }
    } catch {
    }
    const shell = primePlayerShellRoot();
    const shellDigest = summarizePlayerShell(shell, { maxNodes: 100, maxDepth: 15 });
    let videoDigest = null;
    if (v && v.tagName === "VIDEO") {
      try {
        videoDigest = {
          readyState: v.readyState,
          paused: v.paused,
          currentTime: +v.currentTime.toFixed(2),
          duration: v.duration && !isNaN(v.duration) ? +v.duration.toFixed(1) : null,
          muted: v.muted
        };
      } catch {
      }
    }
    return {
      kind: "playshare_prime_missed_ad_debug_v1",
      meta: {
        capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
        href: typeof location !== "undefined" ? location.href : "",
        hostname: typeof location !== "undefined" ? location.hostname : ""
      },
      extension: {
        localAdBreakActiveReported: !!ctx.localAdBreakActive,
        inRoom: !!ctx.inRoom,
        videoHealth: ctx.videoHealth || null
      },
      primeAdDetection: snapshot,
      mediaSession,
      playerShellDigest: shellDigest,
      adRelatedHints: collectAdRelatedHints(),
      videoElement: videoDigest,
      autoCaptureContext: ctx.autoCaptureContext ?? null
    };
  }
  function videoGeometricallyAlignedWithPrimeShell(v, shell) {
    if (!shell || !v) return false;
    try {
      const vr = v.getBoundingClientRect();
      const sr = shell.getBoundingClientRect();
      if (vr.width < 8 || vr.height < 8 || sr.width < 8 || sr.height < 8) return false;
      const ix = Math.max(0, Math.min(vr.right, sr.right) - Math.max(vr.left, sr.left));
      const iy = Math.max(0, Math.min(vr.bottom, sr.bottom) - Math.max(vr.top, sr.top));
      const inter = ix * iy;
      const vArea = vr.width * vr.height;
      const overlapRatio = vArea > 0 ? inter / vArea : 0;
      if (overlapRatio >= 0.35) return true;
      const cx = vr.left + vr.width / 2;
      const cy = vr.top + vr.height / 2;
      return cx >= sr.left && cx <= sr.right && cy >= sr.top && cy <= sr.bottom;
    } catch {
      return false;
    }
  }
  function isPrimeMainPlayerShell(v) {
    if (!v || v.tagName !== "VIDEO") return false;
    try {
      if (v.closest?.('.atvwebplayersdk-player-container, [class*="atvwebplayersdk-player"], [class*="webPlayerInner"]')) return true;
      const shell = primePlayerShellRoot();
      return videoGeometricallyAlignedWithPrimeShell(v, shell);
    } catch {
      return false;
    }
  }
  function adjustPrimeVideoCandidateScore(v, score) {
    if (!v || v.tagName !== "VIDEO" || !isFinite(score)) return score;
    let s = score;
    if (isPrimeMainPlayerShell(v)) {
      s *= 1.85;
      try {
        const dim = v.videoWidth > 32 && v.videoHeight > 32;
        if (v.paused && v.currentTime < 0.08 && !dim) s *= 0.14;
      } catch {
      }
    }
    return s;
  }
  function primeShouldRefreshVideoCache(v) {
    if (!v || v.tagName !== "VIDEO") return false;
    try {
      if (!isPrimeMainPlayerShell(v)) return false;
      if (!v.paused || v.currentTime > 0.25) return false;
      if (v.videoWidth > 48 && v.videoHeight > 48) return false;
      for (const el of document.querySelectorAll("video")) {
        if (el === v || !(el instanceof HTMLVideoElement)) continue;
        if (!isPrimeMainPlayerShell(el)) continue;
        if (el.paused || el.currentTime < 0.5) continue;
        if (el.videoWidth > 48 && el.videoHeight > 48) return true;
      }
    } catch {
    }
    return false;
  }
  function primeStillPausedAfterAggressivePlay(v2, helpers) {
    helpers.dispatchSpaceKey(v2);
    helpers.dispatchSpaceKey(v2.closest(".atvwebplayersdk-player-container") || document.body);
  }
  function primeStillPlayingAfterAggressivePause(v2, helpers) {
    helpers.dispatchSpaceKey(v2);
    helpers.dispatchSpaceKey(v2.closest(".atvwebplayersdk-player-container") || document.body);
  }
  function primeExtraDiagTips() {
    return [
      {
        level: "info",
        text: "Prime: Space / UI clicks if sync lags; video node may swap. HUD + __playsharePrime.getStatus() in popup footer / console."
      },
      {
        level: "info",
        text: "Ad breaks: room sync uses only Amazon’s on-screen ad cues + media metadata (no generic class guessing). Use sidebar manual ad controls if detection misses a break."
      }
    ];
  }
  var PRIME_AD_BREAK_MONITOR_OPTIONS = {
    debounceEnterMs: 260,
    debounceExitMs: 1e3,
    enterConsecutiveSamples: 1,
    exitConsecutiveSamples: 3,
    minAdHoldMs: 1800
  };
  var primeSiteSyncAdapter = Object.freeze({
    key: PRIME_SYNC_HANDLER_KEY,
    getPlaybackConfidence: ({ video }) => getPrimePlaybackConfidence(video),
    remoteApplyIgnoreLocalMs: 650,
    microCorrectionIgnoreSec: 0.65,
    rapidSeekRejectWindowMs: 2200,
    rapidSeekMaxInWindow: 5,
    skipRemoteSeekWhileVideoSeeking: true,
    getPriorityVideoSelectors: () => PRIME_PRIORITY_VIDEO_SELECTORS,
    adjustVideoCandidateScore: adjustPrimeVideoCandidateScore,
    shouldRefreshVideoCache: primeShouldRefreshVideoCache,
    onStillPausedAfterAggressivePlay: primeStillPausedAfterAggressivePlay,
    onStillPlayingAfterAggressivePause: primeStillPlayingAfterAggressivePause,
    extraDiagTips: primeExtraDiagTips
  });

  // content/src/sites/netflix-sync.js
  var NETFLIX_SYNC_HANDLER_KEY = "netflix";
  var NETFLIX_PRIORITY_VIDEO_SELECTORS = [
    ".watch-video--player-view video",
    ".watch-video video",
    '[data-uia="video-canvas"] video',
    ".watch-video--player-view .VideoContainer video",
    'div[data-uia="player"] video'
  ];
  function isLikelyVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      const st = window.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    } catch {
      return false;
    }
  }
  function tryNetflixPlaybackUi(v, wantPlaying) {
    if (!v || v.tagName !== "VIDEO") return false;
    const wantPause = !wantPlaying;
    if (wantPlaying && v.paused) {
      const playSel = [
        '[data-uia="player-play-pause-play"]',
        'button[data-uia="player-play-pause-play"]',
        ".button-nfplayerPlay",
        'button[aria-label="Play"]',
        'button[aria-label*="Play" i]'
      ];
      for (const sel of playSel) {
        const el = document.querySelector(sel);
        if (isLikelyVisible(el)) {
          try {
            el.click();
            return true;
          } catch {
          }
        }
      }
    }
    if (wantPause && !v.paused) {
      const pauseSel = [
        '[data-uia="player-play-pause-pause"]',
        'button[data-uia="player-play-pause-pause"]',
        ".button-nfplayerPause",
        'button[aria-label="Pause"]',
        'button[aria-label*="Pause" i]'
      ];
      for (const sel of pauseSel) {
        const el = document.querySelector(sel);
        if (isLikelyVisible(el)) {
          try {
            el.click();
            return true;
          } catch {
          }
        }
      }
    }
    const toggleSel = ['[data-uia="player-play-pause-button"]', 'button[data-uia="control-play-pause-play-pause"]'];
    for (const sel of toggleSel) {
      const el = document.querySelector(sel);
      if (!isLikelyVisible(el)) continue;
      if (wantPlaying && v.paused || wantPause && !v.paused) {
        try {
          el.click();
          return true;
        } catch {
        }
      }
    }
    return false;
  }
  function applyNetflixDrmViewerOneShot(v, targetTime, wantPlaying) {
    if (!v || v.tagName !== "VIDEO") return;
    try {
      if (typeof targetTime === "number" && Number.isFinite(targetTime) && targetTime >= 0) {
        v.currentTime = targetTime;
      }
    } catch {
    }
    if (tryNetflixPlaybackUi(v, wantPlaying)) return;
    try {
      if (wantPlaying) v.play().catch(() => {
      });
      else v.pause();
    } catch {
    }
  }
  function adjustNetflixVideoCandidateScore(v, score) {
    try {
      let el = v;
      for (let d = 0; d < 8 && el; d++) {
        if (!el.parentElement) break;
        el = el.parentElement;
        const cls = el.className && typeof el.className === "string" ? el.className : "";
        if (/watch-video|player-view|VideoContainer|watchVideo/i.test(cls)) {
          return score * 1.55;
        }
        if (el.getAttribute?.("data-uia") === "video-canvas") return score * 1.45;
      }
    } catch {
    }
    return score;
  }
  function onStillPausedAfterAggressivePlay(_v, { dispatchSpaceKey }) {
    const root = document.querySelector(".watch-video--player-view") || document.querySelector(".watch-video") || document.querySelector('[data-uia="player"]');
    if (root) dispatchSpaceKey(root);
  }
  function onStillPlayingAfterAggressivePause(_v, { dispatchSpaceKey }) {
    const root = document.querySelector(".watch-video--player-view") || document.querySelector(".watch-video") || document.querySelector('[data-uia="player"]');
    if (root) dispatchSpaceKey(root);
  }
  var netflixSiteSyncAdapter = Object.freeze({
    key: NETFLIX_SYNC_HANDLER_KEY,
    getPlaybackConfidence: ({ video }) => getNetflixPlaybackConfidence(video),
    remoteApplyIgnoreLocalMs: 1150,
    microCorrectionIgnoreSec: 1,
    rapidSeekRejectWindowMs: 2800,
    rapidSeekMaxInWindow: 4,
    skipRemoteSeekWhileVideoSeeking: true,
    getPriorityVideoSelectors: () => [...NETFLIX_PRIORITY_VIDEO_SELECTORS],
    adjustVideoCandidateScore: adjustNetflixVideoCandidateScore,
    onStillPausedAfterAggressivePlay,
    onStillPlayingAfterAggressivePause,
    extraDiagTips: () => [
      {
        level: "warn",
        text: "Netflix (Cadmium): PlayShare uses **Netflix-specific** sync — confirm with “Sync” when prompted. Error **M7375** often means the player rejected extension interference; avoid stacking multiple video extensions and prefer one manual sync."
      },
      {
        level: "info",
        text: "If auto-detect misses: sidebar **Watching ad** / **Ad finished**, or set **keyboard shortcuts** (chrome://extensions → PlayShare). DOM: `ads-info-container` + ordinal **Ad N of M**, slash counts, mm:ss or seconds on `ads-info-time`."
      }
    ]
  });
  function isNetflixHostname(hostname) {
    return /netflix\.com/.test(String(hostname || "").toLowerCase());
  }
  function getNetflixPlaybackConfidence(video) {
    if (!video || video.tagName !== "VIDEO") return "LOW";
    if (detectNetflixAdPlaying(video)) return "LOW";
    try {
      if (video.seeking) return "MEDIUM";
      if (video.readyState != null && video.readyState < 3) return "MEDIUM";
    } catch {
    }
    return "HIGH";
  }
  function visibleNetflixAdsCountdownActive(surface) {
    if (!surface || typeof surface.querySelector !== "function") return false;
    try {
      const timeEl = surface.querySelector('[data-uia="ads-info-time"]');
      if (!timeEl || !isLikelyVisible(timeEl)) return false;
      const raw = (timeEl.textContent || "").trim();
      const tt = raw.replace(/\s+/g, "");
      if (!tt || !/\d/.test(tt)) return false;
      if (/^0{1,2}:0{1,2}$/.test(tt)) return false;
      if (/\d{1,2}:\d{2}/.test(tt)) return true;
      if (/^\d{1,3}$/.test(tt)) {
        const sec = +tt;
        if (sec >= 1 && sec <= 600 && visibleNetflixAdsOrdinalPod(surface)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }
  function visibleNetflixAdsOrdinalPod(surface) {
    if (!surface || typeof surface.querySelector !== "function") return false;
    try {
      const c = surface.querySelector('[data-uia="ads-info-container"]');
      if (!c || !isLikelyVisible(c)) return false;
      const norm = (s) => s.replace(/[\s\u00a0\u2007\u202f]+/g, " ").trim();
      const blob = norm(c.textContent || "");
      const aria = norm(c.getAttribute("aria-label") || "");
      const combined = `${blob} ${aria}`;
      return /\bAd\s*\d{1,3}\s+of\s+\d{1,3}\b/i.test(combined);
    } catch {
      return false;
    }
  }
  function visibleNetflixAdsPodProgress(surface) {
    if (!surface || typeof surface.querySelector !== "function") return false;
    try {
      const el = surface.querySelector('[data-uia="ads-info-count"]');
      if (!el || !isLikelyVisible(el)) return false;
      const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
      const compact = raw.replace(/\s+/g, "");
      let m = /^(\d{1,3})\/(\d{1,3})$/.exec(compact);
      if (m) {
        const cur = +m[1];
        const tot = +m[2];
        return Number.isFinite(cur) && Number.isFinite(tot) && tot >= 1 && cur >= 1 && cur <= tot;
      }
      m = /\bAd\s*(\d{1,3})\s+of\s+(\d{1,3})\b/i.exec(raw);
      if (m) {
        const cur = +m[1];
        const tot = +m[2];
        return Number.isFinite(cur) && Number.isFinite(tot) && tot >= 1 && cur >= 1 && cur <= tot;
      }
      return false;
    } catch {
      return false;
    }
  }
  function netflixAdsStripSupportsLoneAdLabel(surface) {
    return visibleNetflixAdsCountdownActive(surface) || visibleNetflixAdsPodProgress(surface) || visibleNetflixAdsOrdinalPod(surface);
  }
  function detectNetflixAdPlaying(video) {
    const root = document.querySelector(".watch-video--player-view") || document.querySelector(".watch-video") || document.getElementById("appMountPoint") || document.body;
    const surface = document.querySelector(".watch-video--player-view") || document.querySelector(".watch-video") || document.getElementById("appMountPoint");
    if (visibleNetflixAdsOrdinalPod(surface)) return true;
    if (visibleNetflixAdsPodProgress(surface)) return true;
    if (visibleNetflixAdsCountdownActive(surface)) return true;
    const tryVisible = (sel) => {
      try {
        const el = root.querySelector(sel);
        return isLikelyVisible(el) ? el : null;
      } catch {
        return null;
      }
    };
    const uiaHints = [
      '[data-uia*="advertisement" i]',
      '[data-uia*="ad-badge" i]',
      '[data-uia*="adBadge" i]',
      '[data-uia*="ad-label" i]',
      '[data-uia*="adLabel" i]',
      '[data-uia*="ad-timer" i]',
      '[data-uia*="adTimer" i]',
      '[data-uia*="ad-break" i]',
      '[data-uia*="adBreak" i]',
      '[data-uia*="player-ad" i]',
      '[data-uia*="playerAd" i]',
      '[data-uia*="skip-ad" i]',
      '[data-uia*="skipAd" i]',
      '[data-uia*="ad-progress" i]'
    ];
    for (const sel of uiaHints) {
      if (tryVisible(sel)) return true;
    }
    const classHints = [
      '[class*="ad-break" i]',
      '[class*="adbreak" i]',
      '[class*="advertisement" i]',
      '[class*="AdTimer" i]',
      '[class*="ad-timer" i]',
      '[class*="player-ad" i]',
      '[class*="PlayerAd" i]'
    ];
    for (const sel of classHints) {
      if (tryVisible(sel)) return true;
    }
    const ariaHints = [
      '[aria-label*="Advertisement" i]',
      '[aria-label^="Ad ·" i]',
      '[aria-label*="Ad ·" i]',
      '[aria-label*="Ad, " i]'
    ];
    for (const sel of ariaHints) {
      if (tryVisible(sel)) return true;
    }
    try {
      const adAria = root.querySelectorAll('[aria-label^="Ad " i]');
      for (let i = 0; i < adAria.length; i++) {
        const n = adAria[i];
        if (!isLikelyVisible(n)) continue;
        const al = (n.getAttribute("aria-label") || "").trim();
        if (al.length >= 10 || /\d/.test(al)) return true;
      }
    } catch {
    }
    if (video && video.closest) {
      try {
        const near = video.closest(
          '[class*="ad-break" i], [class*="adbreak" i], [class*="advertisement" i], [data-ad-state], [data-uia*="ad-break" i], [data-uia*="player-ad" i]'
        );
        if (near && isLikelyVisible(near)) return true;
      } catch {
      }
      try {
        let el = video;
        for (let d = 0; d < 16 && el; d++) {
          const cls = el.className && typeof el.className === "string" ? el.className : "";
          const aria = el.getAttribute?.("aria-label") || "";
          const uia = el.getAttribute?.("data-uia") || "";
          const blob = `${cls} ${aria} ${uia}`;
          if (/\bad[\s_-]?break\b/i.test(blob)) return true;
          if (!/ads-info|modular-ads|adsinfo/i.test(uia) && /player[\s_-]?ad/i.test(uia)) return true;
          if (aria && aria.length < 140 && /\badvertisement\b/i.test(aria)) return true;
          el = el.parentElement;
        }
      } catch {
      }
    }
    try {
      if (surface) {
        const nodes = surface.querySelectorAll("span, div, p, button");
        const cap = Math.min(nodes.length, 280);
        for (let i = 0; i < cap; i++) {
          const el = nodes[i];
          if (!isLikelyVisible(el)) continue;
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (t.length < 2 || t.length > 56) continue;
          if (/^Advertisement\b/i.test(t)) return true;
          if (/\bAd\s*\d{1,3}\s+of\s+\d{1,3}\b/i.test(t)) return true;
          if (/\bAd\s*[·•]\s*\d/.test(t)) return true;
          if (/^Ad\b/i.test(t) && /\d/.test(t)) return true;
          if (/^Ad\b/i.test(t) && t.length >= 10) return true;
          if (/^Ad$/i.test(t) && netflixAdsStripSupportsLoneAdLabel(surface)) return true;
        }
      }
    } catch {
    }
    return false;
  }
  function captureNetflixAdProfilerHints(video) {
    const cut = (s, n) => {
      const x = s == null ? "" : String(s);
      return x.length > n ? `${x.slice(0, n)}…` : x;
    };
    const out = {
      heuristicAd: detectNetflixAdPlaying(video),
      playerShellClass: (
        /** @type {string|null} */
        null
      ),
      videoIntrinsic: (
        /** @type {{ w: number, h: number }|null} */
        null
      ),
      visibleDataUia: (
        /** @type {string[]} */
        []
      ),
      ariaAdRelated: (
        /** @type {string[]} */
        []
      ),
      shortTextHits: (
        /** @type {string[]} */
        []
      ),
      classNameAdHints: (
        /** @type {string[]} */
        []
      ),
      idAdHints: (
        /** @type {string[]} */
        []
      )
    };
    try {
      if (video && video.videoWidth && video.videoHeight) {
        out.videoIntrinsic = { w: video.videoWidth, h: video.videoHeight };
      }
    } catch {
    }
    if (video) {
      try {
        let el = video;
        for (let d = 0; d < 18 && el; d++) {
          const cls = typeof el.className === "string" ? el.className : "";
          if (/\b(active|inactive|passive)\b/.test(cls) && /default-ltr-/.test(cls)) {
            out.playerShellClass = cut(cls, 160);
            break;
          }
          el = el.parentElement;
        }
      } catch {
      }
    }
    const surface = document.querySelector(".watch-video--player-view") || document.querySelector(".watch-video") || document.getElementById("appMountPoint");
    if (!surface) return out;
    try {
      const uiaNodes = surface.querySelectorAll("[data-uia]");
      const uiaSeen = /* @__PURE__ */ new Set();
      for (let i = 0; i < uiaNodes.length && out.visibleDataUia.length < 50; i++) {
        const n = uiaNodes[i];
        if (!isLikelyVisible(n)) continue;
        const u = cut(n.getAttribute("data-uia") || "", 100);
        if (!u || uiaSeen.has(u)) continue;
        uiaSeen.add(u);
        out.visibleDataUia.push(u);
      }
    } catch {
    }
    try {
      const withAria = surface.querySelectorAll("[aria-label]");
      for (let i = 0; i < withAria.length && out.ariaAdRelated.length < 24; i++) {
        const n = withAria[i];
        if (!isLikelyVisible(n)) continue;
        const al = n.getAttribute("aria-label") || "";
        if (al.length < 2 || al.length > 160) continue;
        if (!/\b(ad|advertisement|sponsor)\b/i.test(al)) continue;
        const c = cut(al, 140);
        if (!out.ariaAdRelated.includes(c)) out.ariaAdRelated.push(c);
      }
    } catch {
    }
    try {
      const nodes = surface.querySelectorAll("span, div, p, button, a");
      const cap = Math.min(nodes.length, 400);
      const textSeen = /* @__PURE__ */ new Set();
      for (let i = 0; i < cap && out.shortTextHits.length < 24; i++) {
        const el = nodes[i];
        if (!isLikelyVisible(el)) continue;
        const t = cut((el.textContent || "").replace(/\s+/g, " ").trim(), 64);
        if (t.length < 2 || t.length > 60) continue;
        if (!/^Advertisement\b/i.test(t) && !/\bAd\s*\d{1,3}\s+of\s+\d{1,3}\b/i.test(t) && !/\bAd\s*[·•]\s*\d/.test(t) && !/\d:\d{2}\s*Ad\b/i.test(t) && !(/^Ad\b/i.test(t) && /\d/.test(t)) && !(/^Ad\b/i.test(t) && t.length >= 10) && !(/^Ad$/i.test(t) && netflixAdsStripSupportsLoneAdLabel(surface))) {
          continue;
        }
        if (textSeen.has(t)) continue;
        textSeen.add(t);
        out.shortTextHits.push(t);
      }
    } catch {
    }
    try {
      const all = surface.querySelectorAll("[class]");
      const seen = /* @__PURE__ */ new Set();
      for (let i = 0; i < all.length && out.classNameAdHints.length < 30; i++) {
        const n = all[i];
        if (!isLikelyVisible(n)) continue;
        const cls = typeof n.className === "string" ? n.className : "";
        if (!cls || cls.length < 4 || !/\bad/i.test(cls)) continue;
        const c = cut(cls.replace(/\s+/g, " ").trim(), 120);
        if (!seen.has(c)) {
          seen.add(c);
          out.classNameAdHints.push(c);
        }
      }
    } catch {
    }
    try {
      const idNodes = surface.querySelectorAll("[id]");
      for (let i = 0; i < idNodes.length && out.idAdHints.length < 16; i++) {
        const n = idNodes[i];
        if (!isLikelyVisible(n)) continue;
        const id = n.id ? cut(n.id, 80) : "";
        if (!id || !/\bad/i.test(id)) continue;
        if (!out.idAdHints.includes(id)) out.idAdHints.push(id);
      }
    } catch {
    }
    return out;
  }
  function getNetflixPlaybackProfilePatch() {
    return {
      handlerKey: NETFLIX_SYNC_HANDLER_KEY,
      label: "Netflix",
      /** Still uses passive viewer path (prompted apply), but logic is Netflix-scoped in app + adapter. */
      drmPassive: true,
      /** Never use multi-retry forcePlay/forcePause storms on Cadmium. */
      aggressiveRemoteSync: false,
      syncThresholdSoft: contentConstants.SYNC_THRESHOLD_NETFLIX,
      applyDebounceMs: contentConstants.SYNC_DEBOUNCE_MS,
      syncStateApplyDelayMs: 300,
      syncRequestDelayMs: 2e3,
      /** Longer gaps reduce prompt spam (M7375 risk is partly “too much automation”). */
      drmPromptPlayMinIntervalMs: 9e3,
      drmPromptPauseSeekMinIntervalMs: 9e3,
      drmPromptSyncStateMinIntervalMs: 12e3,
      drmReconcilePromptMinIntervalMs: 16e3
    };
  }

  // content/src/platform-profiles.js
  var BASE = {
    handlerKey: "default",
    label: "Streaming",
    drmPassive: false,
    useRelaxedVideoReady: false,
    hostPositionIntervalMs: contentConstants.HOST_POSITION_INTERVAL_MS,
    viewerReconcileIntervalMs: contentConstants.SYNC_RECONCILE_INTERVAL_MS,
    hostSeekSuppressAfterPlayMs: contentConstants.HOST_SEEK_SUPPRESS_AFTER_PLAY_MS,
    drmDesyncThresholdSec: 2.5,
    syncThresholdSoft: contentConstants.SYNC_THRESHOLD,
    applyDebounceMs: 0,
    aggressiveRemoteSync: false,
    syncStateApplyDelayMs: 0,
    syncRequestDelayMs: 500,
    applyDelayNetflix: contentConstants.APPLY_DELAY_NETFLIX,
    applyDelayPrime: contentConstants.APPLY_DELAY_PRIME,
    /** 0 = send every local PLAY/PAUSE immediately. */
    playbackOutboundCoalesceMs: 0,
    pauseSeekOutboundPlaySuppressMs: contentConstants.PAUSE_SEEK_OUTBOUND_PLAY_SUPPRESS_MS
  };
  function getPlaybackProfile(hostname, pathname) {
    const h = (hostname || "").toLowerCase();
    let profile = { ...BASE };
    if (isNetflixHostname(h)) {
      profile = { ...profile, ...getNetflixPlaybackProfilePatch() };
    } else if (/disneyplus\.com/.test(h)) {
      profile = {
        ...profile,
        handlerKey: "disney",
        label: "Disney+",
        drmPassive: true,
        syncThresholdSoft: contentConstants.SYNC_THRESHOLD_NETFLIX,
        applyDebounceMs: contentConstants.SYNC_DEBOUNCE_MS,
        syncRequestDelayMs: 1500
      };
    } else if (isPrimeVideoHostname(h)) {
      profile = { ...profile, ...getPrimePlaybackProfilePatch() };
    }
    return profile;
  }
  function getApplyDelayMs(lastRtt, playbackProfile) {
    const forNetflix = playbackProfile.handlerKey === "netflix";
    const forPrime = playbackProfile.handlerKey === "prime";
    const platform = forNetflix ? playbackProfile.applyDelayNetflix : forPrime ? playbackProfile.applyDelayPrime : 0;
    return typeof lastRtt === "number" && lastRtt > 0 && lastRtt < platform ? lastRtt : platform;
  }

  // content/src/sites/site-sync-adapter.js
  var defaultSiteSyncAdapter = Object.freeze({
    key: "default",
    getPlaybackConfidence: () => "MEDIUM",
    remoteApplyIgnoreLocalMs: 700,
    adjustVideoCandidateScore: void 0,
    shouldRefreshVideoCache: void 0,
    onStillPausedAfterAggressivePlay: void 0,
    onStillPlayingAfterAggressivePause: void 0,
    extraDiagTips: void 0
  });
  function getSiteSyncAdapter(hostname, _pathname = "") {
    if (isPrimeVideoHostname(hostname)) return primeSiteSyncAdapter;
    if (isNetflixHostname(hostname)) return netflixSiteSyncAdapter;
    return defaultSiteSyncAdapter;
  }

  // content/src/sites/netflix-ad-state-machine.js
  var USER_IDLE_MS = 800;
  var MUTATION_THROTTLE_MS = 220;
  var TICK_MS = 400;
  var LOG_THROTTLE_MS = 2e3;
  var ENTER_CONFIDENCE = 0.7;
  var EXIT_CONFIDENCE = 0.3;
  var EXIT_MIN_HOLD_MS = 2e3;
  var SYSTEM_SEEK_WINDOW_MS = 4500;
  var SHORT_SEGMENT_MEDIA_SEC = 45;
  var SHORT_SEGMENT_BOOST_MS = 3500;
  function createNetflixAdStateMachine(options) {
    const { getVideo, onEnterAd, onExitAd, log: logOptional } = options;
    let phase = "CONTENT";
    let lastPhaseChangeAt = Date.now();
    let lastUserInteractionAt = Date.now();
    let lastCt = (
      /** @type {number} */
      -1
    );
    let segmentMediaStart = (
      /** @type {number|null} */
      null
    );
    let segmentWallStart = (
      /** @type {number|null} */
      null
    );
    let systemSeekUntil = 0;
    let shortSegmentBoostUntil = 0;
    let lastConfidence = 0;
    let lastBreakdown = {};
    let tickId = null;
    let mo = null;
    let mutationThrottleTimer = 0;
    let lastLogAt = 0;
    let boundVideo = null;
    let onSeeking = (
      /** @type {((this: HTMLVideoElement, ev: Event) => void) | null} */
      null
    );
    let onTu = (
      /** @type {((this: HTMLVideoElement, ev: Event) => void) | null} */
      null
    );
    let onPlaying = (
      /** @type {((this: HTMLVideoElement, ev: Event) => void) | null} */
      null
    );
    let onPause = (
      /** @type {((this: HTMLVideoElement, ev: Event) => void) | null} */
      null
    );
    function isSystemDriven() {
      return Date.now() - lastUserInteractionAt > USER_IDLE_MS;
    }
    function bumpUserInteraction() {
      lastUserInteractionAt = Date.now();
    }
    function onUserIntentCapture(e) {
      try {
        const t = (
          /** @type {Node|null} */
          e.target
        );
        if (t && t instanceof Element) {
          const tag = t.tagName;
          if (tag === "INPUT" || tag === "TEXTAREA" || t.closest?.('[contenteditable="true"]')) return;
        }
      } catch {
      }
      bumpUserInteraction();
    }
    function watchSurface() {
      return document.querySelector(".watch-video--player-view") || document.querySelector(".watch-video") || document.getElementById("appMountPoint") || document.body;
    }
    function detectNetflixAdTextHeuristic(root) {
      if (!root || !("innerText" in root)) return false;
      try {
        const t = String(root.innerText || "").slice(0, 12e3).toLowerCase();
        if (!/\bad\b/.test(t)) return false;
        return t.includes("resume") || t.includes("second") || t.includes("will resume") || /\d+\s+of\s+\d+/.test(t) || t.includes("advertisement");
      } catch {
        return false;
      }
    }
    function computeConfidence() {
      const v = getVideo();
      const surface = watchSurface();
      const structured = !!(v && detectNetflixAdPlaying(v));
      const textBlob = detectNetflixAdTextHeuristic(surface instanceof HTMLElement ? surface : null);
      let score = 0;
      const breakdown = { structured: 0, textBlob: 0, systemSeek: 0, shortSegment: 0 };
      if (structured) {
        breakdown.structured = 0.7;
        score += 0.7;
      } else if (textBlob) {
        breakdown.textBlob = 0.55;
        score += 0.55;
      }
      const now = Date.now();
      if (now < systemSeekUntil) {
        breakdown.systemSeek = 0.3;
        score += 0.3;
      }
      if (now < shortSegmentBoostUntil) {
        breakdown.shortSegment = 0.2;
        score += 0.2;
      }
      score = Math.min(1, score);
      lastBreakdown = breakdown;
      lastConfidence = score;
      return score;
    }
    function updateAdState() {
      const conf = computeConfidence();
      const now = Date.now();
      if (phase === "CONTENT") {
        if (conf >= ENTER_CONFIDENCE) {
          phase = "AD";
          lastPhaseChangeAt = now;
          onEnterAd();
        }
      } else {
        const heldLongEnough = now - lastPhaseChangeAt >= EXIT_MIN_HOLD_MS;
        const low = conf < EXIT_CONFIDENCE;
        if (heldLongEnough && low) {
          phase = "CONTENT";
          lastPhaseChangeAt = now;
          onExitAd();
        }
      }
      if (now - lastLogAt >= LOG_THROTTLE_MS) {
        lastLogAt = now;
        const payload = {
          state: phase,
          confidence: +conf.toFixed(2),
          breakdown: { ...lastBreakdown },
          systemDriven: isSystemDriven()
        };
        console.log("[AdDetection] state:", phase, "confidence:", +conf.toFixed(2), "breakdown:", { ...lastBreakdown });
        try {
          logOptional?.(payload);
        } catch {
        }
      }
    }
    function scheduleMutationTick() {
      if (mutationThrottleTimer) return;
      mutationThrottleTimer = window.setTimeout(() => {
        mutationThrottleTimer = 0;
        updateAdState();
      }, MUTATION_THROTTLE_MS);
    }
    function bindVideoListeners(v) {
      if (!v || boundVideo === v) return;
      unbindVideoListeners();
      boundVideo = v;
      lastCt = typeof v.currentTime === "number" && Number.isFinite(v.currentTime) ? v.currentTime : -1;
      onTu = function onTuHandler() {
        const ct = this.currentTime;
        if (typeof ct === "number" && Number.isFinite(ct)) lastCt = ct;
      };
      onSeeking = function onSeekingHandler() {
        const el = this;
        const to = el.currentTime;
        if (typeof to !== "number" || !Number.isFinite(to) || typeof lastCt !== "number" || lastCt < 0) return;
        const jump = Math.abs(to - lastCt);
        if (jump > 2 && isSystemDriven()) {
          systemSeekUntil = Date.now() + SYSTEM_SEEK_WINDOW_MS;
        }
      };
      onPlaying = function onPlayingHandler() {
        const el = this;
        if (isSystemDriven() && typeof el.currentTime === "number" && Number.isFinite(el.currentTime)) {
          segmentMediaStart = el.currentTime;
          segmentWallStart = Date.now();
        }
      };
      onPause = function onPauseHandler() {
        const el = this;
        if (segmentMediaStart != null && segmentWallStart != null && typeof el.currentTime === "number" && Number.isFinite(el.currentTime) && isSystemDriven() && Math.abs((el.playbackRate || 1) - 1) < 0.05) {
          const dur = el.currentTime - segmentMediaStart;
          if (dur > 0.5 && dur < SHORT_SEGMENT_MEDIA_SEC) {
            shortSegmentBoostUntil = Date.now() + SHORT_SEGMENT_BOOST_MS;
          }
        }
        segmentMediaStart = null;
        segmentWallStart = null;
      };
      v.addEventListener("timeupdate", onTu);
      v.addEventListener("seeking", onSeeking);
      v.addEventListener("playing", onPlaying);
      v.addEventListener("pause", onPause);
    }
    function unbindVideoListeners() {
      if (boundVideo && onTu) {
        try {
          boundVideo.removeEventListener("timeupdate", onTu);
          boundVideo.removeEventListener("seeking", onSeeking);
          boundVideo.removeEventListener("playing", onPlaying);
          boundVideo.removeEventListener("pause", onPause);
        } catch {
        }
      }
      boundVideo = null;
      onSeeking = null;
      onTu = null;
      onPlaying = null;
      onPause = null;
    }
    const intentEvents = ["click", "keydown", "pointerdown", "touchstart"];
    return {
      start() {
        this.stop();
        phase = "CONTENT";
        lastPhaseChangeAt = Date.now();
        lastUserInteractionAt = Date.now();
        systemSeekUntil = 0;
        shortSegmentBoostUntil = 0;
        intentEvents.forEach((evt) => {
          document.addEventListener(evt, onUserIntentCapture, true);
        });
        try {
          mo = new MutationObserver(() => {
            scheduleMutationTick();
          });
          mo.observe(document.body, { childList: true, subtree: true, characterData: true });
        } catch {
          mo = null;
        }
        tickId = window.setInterval(() => {
          const v = getVideo();
          if (v) bindVideoListeners(v);
          updateAdState();
        }, TICK_MS);
        updateAdState();
      },
      stop() {
        if (tickId) {
          clearInterval(tickId);
          tickId = null;
        }
        if (mutationThrottleTimer) {
          clearTimeout(mutationThrottleTimer);
          mutationThrottleTimer = 0;
        }
        if (mo) {
          try {
            mo.disconnect();
          } catch {
          }
          mo = null;
        }
        intentEvents.forEach((evt) => {
          document.removeEventListener(evt, onUserIntentCapture, true);
        });
        unbindVideoListeners();
      },
      /** @returns {NetflixAdPhase} */
      getPhase() {
        return phase;
      },
      isAd() {
        return phase === "AD";
      },
      getDebugSnapshot() {
        return {
          phase,
          confidence: lastConfidence,
          breakdown: { ...lastBreakdown },
          lastPhaseChangeAt,
          systemSeekUntil,
          shortSegmentBoostUntil
        };
      }
    };
  }

  // content/src/drm-sync-prompt.js
  function createDrmSyncPromptHost(opts = {}) {
    const getMountParent = typeof opts.getMountParent === "function" ? opts.getMountParent : () => document.body;
    let lastOfferAt = 0;
    let activeEl = null;
    function dismiss() {
      if (activeEl && activeEl.parentNode) activeEl.parentNode.removeChild(activeEl);
      activeEl = null;
    }
    return {
      /**
       * @param {{ headline?: string, detail?: string, minIntervalMs?: number, onConfirm?: () => void }} opts
       */
      offer(opts2) {
        const minIntervalMs = opts2.minIntervalMs ?? 8e3;
        const now = Date.now();
        if (now - lastOfferAt < minIntervalMs) return;
        lastOfferAt = now;
        if (activeEl) dismiss();
        const wrap = document.createElement("div");
        wrap.setAttribute("role", "dialog");
        wrap.style.cssText = [
          "position:fixed",
          "z-index:2147483647",
          "right:16px",
          "bottom:16px",
          "max-width:320px",
          "padding:14px 16px",
          "border-radius:12px",
          "background:rgba(18,20,24,0.96)",
          "color:#e8eaed",
          "font:13px/1.45 system-ui,sans-serif",
          "box-shadow:0 8px 32px rgba(0,0,0,0.55)",
          "border:1px solid rgba(255,255,255,0.1)"
        ].join(";");
        const h = document.createElement("div");
        h.style.cssText = "font-weight:700;margin-bottom:8px;font-size:14px";
        h.textContent = opts2.headline || "Sync to host?";
        const d = document.createElement("div");
        d.style.cssText = "opacity:0.9;margin-bottom:12px";
        d.textContent = opts2.detail || "";
        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
        const btnCancel = document.createElement("button");
        btnCancel.type = "button";
        btnCancel.textContent = "Not now";
        btnCancel.style.cssText = "padding:8px 12px;border-radius:8px;border:1px solid #444;background:transparent;color:#ccc;cursor:pointer;font:inherit";
        const btnOk = document.createElement("button");
        btnOk.type = "button";
        btnOk.textContent = "Sync";
        btnOk.style.cssText = "padding:8px 14px;border-radius:8px;border:none;background:#E50914;color:#fff;cursor:pointer;font:inherit;font-weight:600";
        btnCancel.addEventListener("click", () => dismiss());
        btnOk.addEventListener("click", () => {
          dismiss();
          try {
            if (typeof opts2.onConfirm === "function") opts2.onConfirm();
          } catch {
          }
        });
        row.appendChild(btnCancel);
        row.appendChild(btnOk);
        wrap.appendChild(h);
        wrap.appendChild(d);
        wrap.appendChild(row);
        try {
          getMountParent().appendChild(wrap);
        } catch {
          try {
            document.body.appendChild(wrap);
          } catch {
          }
        }
        activeEl = wrap;
      },
      /** Call on fullscreen changes so an open prompt stays in the top layer. */
      reparentIfVisible() {
        if (!activeEl || !activeEl.parentNode) return;
        const p = getMountParent();
        try {
          if (activeEl.parentElement !== p) p.appendChild(activeEl);
        } catch {
        }
      }
    };
  }

  // content/src/ad-detection.js
  function detectAdPlaying(hostname, video) {
    const h = (hostname || "").toLowerCase();
    try {
      if (isPrimeVideoHostname(h)) return detectPrimeVideoAd(video);
      if (isNetflixHostname(h)) return detectNetflixAdPlaying(video);
      if (/youtube\.com|youtu\.be/.test(h)) return detectYouTubeAd();
      if (/hulu\.com/.test(h)) return detectHuluAd();
      if (/crave\.ca/.test(h)) return detectCraveAd();
      if (/peacocktv\.com/.test(h)) return detectPeacockAd();
      if (video && video.closest && video.closest('[class*="ad-break" i], [class*="adbreak" i], [data-ad-state]')) {
        return true;
      }
    } catch {
    }
    return false;
  }
  function visibleEl(sel, root = document) {
    const el = root.querySelector(sel);
    if (!el) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  }
  function detectYouTubeAd() {
    if (visibleEl(".ytp-ad-module")) return true;
    if (visibleEl(".ytp-ad-player-overlay")) return true;
    if (visibleEl(".ytp-ad-text-overlay")) return true;
    const player = document.querySelector(".html5-video-player");
    if (player && (player.classList.contains("ad-showing") || player.classList.contains("ytp-ad-mode"))) return true;
    return false;
  }
  function detectHuluAd() {
    return visibleEl('[data-testid="ad-ui"], .AdModule__container, [class*="AdBadge"]');
  }
  function detectCraveAd() {
    return visibleEl('[class*="advertisement" i], [class*="ad-break" i]');
  }
  function detectPeacockAd() {
    return visibleEl('[class*="AdSlot" i], [class*="ad-indicator" i]');
  }
  function createAdBreakMonitor(hostname, getVideo, callbacks, monitorOptions = {}) {
    const debounceEnterMs = monitorOptions.debounceEnterMs ?? callbacks.debounceEnterMs ?? 650;
    const debounceExitMs = monitorOptions.debounceExitMs ?? callbacks.debounceExitMs ?? 900;
    const enterNeed = Math.max(1, monitorOptions.enterConsecutiveSamples ?? 1);
    const exitNeed = Math.max(1, monitorOptions.exitConsecutiveSamples ?? 1);
    const minAdHoldMs = Math.max(0, monitorOptions.minAdHoldMs ?? 0);
    let intervalId = null;
    let inAd = false;
    let enterT = null;
    let exitT = null;
    let consecOn = 0;
    let consecOff = 0;
    let adEnteredAt = 0;
    function rawDetect() {
      const video = getVideo();
      if (monitorOptions.detectOverride) {
        return monitorOptions.detectOverride(hostname, video);
      }
      return detectAdPlaying(hostname, video);
    }
    function clearEnter() {
      if (enterT) {
        clearTimeout(enterT);
        enterT = null;
      }
    }
    function clearExit() {
      if (exitT) {
        clearTimeout(exitT);
        exitT = null;
      }
    }
    function tick() {
      const ad = rawDetect();
      if (ad) {
        consecOn = Math.min(consecOn + 1, 99);
        consecOff = 0;
      } else {
        consecOff = Math.min(consecOff + 1, 99);
        consecOn = 0;
      }
      const enterArmed = consecOn >= enterNeed;
      const exitArmed = consecOff >= exitNeed;
      if (!inAd) {
        clearExit();
        if (enterArmed) {
          if (!enterT) {
            enterT = setTimeout(() => {
              enterT = null;
              if (inAd) return;
              if (!rawDetect()) return;
              inAd = true;
              adEnteredAt = Date.now();
              try {
                callbacks.onEnter();
              } catch {
              }
            }, debounceEnterMs);
          }
        } else {
          clearEnter();
        }
      } else {
        clearEnter();
        const holdOk = !minAdHoldMs || Date.now() - adEnteredAt >= minAdHoldMs;
        if (exitArmed && holdOk) {
          if (!exitT) {
            exitT = setTimeout(() => {
              exitT = null;
              if (!inAd) return;
              if (rawDetect()) return;
              inAd = false;
              try {
                callbacks.onExit();
              } catch {
              }
            }, debounceExitMs);
          }
        } else {
          clearExit();
        }
      }
    }
    return {
      start() {
        if (intervalId) return;
        tick();
        try {
          setTimeout(tick, 100);
        } catch {
        }
        intervalId = setInterval(tick, 400);
      },
      stop() {
        clearEnter();
        clearExit();
        consecOn = 0;
        consecOff = 0;
        adEnteredAt = 0;
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
        if (inAd) {
          inAd = false;
          try {
            callbacks.onExit();
          } catch {
          }
        }
      }
    };
  }

  // content/src/sync-drift-config.js
  var CORRECTION_REASONS = Object.freeze({
    JOIN: "join",
    LAGGARD_ANCHOR: "laggard_anchor",
    AD_MODE_EXIT: "ad_mode_exit",
    RECONNECT_SYNC: "reconnect_sync",
    HOST_SEEK_SYNC: "host_seek_sync",
    MANUAL_SYNC: "manual_sync",
    HOST_ANCHOR_SOFT: "host_anchor_soft"
  });
  function getDriftThresholds(handlerKey) {
    switch (handlerKey) {
      case "netflix":
        return {
          enableSoftPlaybackRateDrift: false,
          ignoreBelow: 0.8,
          softBandMax: 1.8,
          hardAbove: 2.5,
          rateBehind: [1.02, 1.04],
          rateAhead: [0.96, 0.98],
          microSeekMin: 1,
          convergingEpsilon: 0.07
        };
      case "prime":
        return {
          enableSoftPlaybackRateDrift: true,
          ignoreBelow: 0.5,
          softBandMax: 2.5,
          hardAbove: 2.5,
          rateBehind: [1.02, 1.05],
          rateAhead: [0.95, 0.98],
          microSeekMin: 0.65,
          convergingEpsilon: 0.08
        };
      default:
        return {
          enableSoftPlaybackRateDrift: true,
          ignoreBelow: 0.45,
          softBandMax: 2.5,
          hardAbove: 2.5,
          rateBehind: [1.02, 1.05],
          rateAhead: [0.95, 0.98],
          microSeekMin: 0.5,
          convergingEpsilon: 0.08
        };
    }
  }
  function classifyDriftTier(absDrift, handlerKey) {
    const th = getDriftThresholds(handlerKey);
    if (absDrift < th.ignoreBelow) return "ignore";
    if (absDrift <= th.softBandMax) return "soft";
    return "hard";
  }

  // content/src/sync-decision-engine.js
  var AD_MODE_ESSENTIAL_HARD = /* @__PURE__ */ new Set([
    CORRECTION_REASONS.JOIN,
    CORRECTION_REASONS.AD_MODE_EXIT,
    CORRECTION_REASONS.LAGGARD_ANCHOR,
    CORRECTION_REASONS.RECONNECT_SYNC,
    CORRECTION_REASONS.MANUAL_SYNC,
    CORRECTION_REASONS.HOST_SEEK_SYNC
  ]);
  var SOFT_DRIFT_TIMEOUT_MS = 4500;
  function createSyncDecisionEngine({
    getSiteSyncAdapter: getSiteSyncAdapter2,
    getHandlerKey,
    getRoomSyncPolicy,
    getDrmPassive
  }) {
    let lastRemoteApplyAt = 0;
    let lastRemoteTimelineMsgAt = 0;
    let clientReconnectSettleUntil = 0;
    const recentRemoteSeekTs = [];
    const driftAbsSamples = [];
    let softDriftState = { active: false, rate: 1, until: 0, lastSign: 0 };
    function handlerKey() {
      try {
        return typeof getHandlerKey === "function" ? String(getHandlerKey() || "default") : "default";
      } catch {
        return "default";
      }
    }
    function roomPolicy() {
      try {
        return typeof getRoomSyncPolicy === "function" ? getRoomSyncPolicy() : null;
      } catch {
        return null;
      }
    }
    function drmPassive() {
      try {
        return typeof getDrmPassive === "function" ? !!getDrmPassive() : false;
      } catch {
        return false;
      }
    }
    function adapter() {
      try {
        return typeof getSiteSyncAdapter2 === "function" ? getSiteSyncAdapter2() : {};
      } catch {
        return {};
      }
    }
    function remoteIgnoreLocalMs() {
      const ms = adapter().remoteApplyIgnoreLocalMs;
      return typeof ms === "number" && ms > 0 ? ms : 750;
    }
    function serverReconnectSettling() {
      const p = roomPolicy();
      const u = p && typeof p.reconnectSettleUntil === "number" ? p.reconnectSettleUntil : 0;
      return u > 0 && Date.now() < u;
    }
    function isHardPriorityRemote(ctx = {}) {
      const cr = ctx.correctionReason;
      if (ctx.fromRoomJoin || cr === CORRECTION_REASONS.JOIN) return true;
      if (ctx.syncKind !== "hard") return false;
      return cr === CORRECTION_REASONS.AD_MODE_EXIT || cr === CORRECTION_REASONS.LAGGARD_ANCHOR || cr === CORRECTION_REASONS.RECONNECT_SYNC || cr === CORRECTION_REASONS.MANUAL_SYNC || cr === CORRECTION_REASONS.HOST_SEEK_SYNC;
    }
    function recordDriftSample(absDrift) {
      const x = typeof absDrift === "number" && Number.isFinite(absDrift) ? absDrift : 0;
      driftAbsSamples.push(x);
      while (driftAbsSamples.length > 8) driftAbsSamples.shift();
    }
    function isAlreadyConverging(ctx) {
      const th = getDriftThresholds(handlerKey());
      const absDrift = ctx.absDrift;
      if (ctx.playMatches && absDrift < th.ignoreBelow * 1.15) return true;
      if (driftAbsSamples.length >= 2) {
        const a = driftAbsSamples[driftAbsSamples.length - 2];
        const b = driftAbsSamples[driftAbsSamples.length - 1];
        if (b < a - th.convergingEpsilon) return true;
      }
      return false;
    }
    function shouldApplyRemoteState(ctx) {
      const hard = isHardPriorityRemote(ctx);
      const now = Date.now();
      const p = roomPolicy();
      const adMode = !!(p && p.adMode);
      if (adMode && ctx.syncKind === "hard") {
        const cr = ctx.correctionReason;
        if (!cr || !AD_MODE_ESSENTIAL_HARD.has(String(cr))) {
          return { ok: false, reason: "server_ad_mode" };
        }
      }
      const settling = now < clientReconnectSettleUntil || serverReconnectSettling();
      if (settling && !hard) {
        if (ctx.kind === "SEEK" && typeof ctx.driftSec === "number" && ctx.driftSec < 2.5) {
          return { ok: false, reason: "reconnect_settle" };
        }
        if (ctx.kind === "SYNC_STATE" && ctx.syncKind === "soft") {
          return { ok: false, reason: "reconnect_settle" };
        }
        if (ctx.isRedundantWithLocal) {
          return { ok: false, reason: "reconnect_settle" };
        }
      }
      if (!hard && (ctx.kind === "SEEK" || ctx.kind === "SYNC_STATE") && typeof ctx.driftSec === "number" && isAlreadyConverging({ absDrift: ctx.driftSec, playMatches: ctx.playMatches })) {
        return { ok: false, reason: "already_converging" };
      }
      const cd = remoteIgnoreLocalMs();
      if (now - lastRemoteApplyAt < cd && !hard) {
        const th = getDriftThresholds(handlerKey());
        const relax = ctx.hostAnchorSoft && ctx.kind === "SYNC_STATE" && ctx.syncKind === "soft" && ctx.driftSec < 1.6;
        if (!relax && typeof ctx.driftSec === "number" && ctx.driftSec < Math.max(5, th.hardAbove)) {
          return { ok: false, reason: "apply_cooldown" };
        }
      }
      if (handlerKey() === "netflix" && drmPassive() && !hard) {
        const th = getDriftThresholds("netflix");
        if (typeof ctx.driftSec === "number" && ctx.driftSec < th.ignoreBelow && ctx.playMatches) {
          return { ok: false, reason: "netflix_safety_noop" };
        }
      }
      return { ok: true, reason: "allow" };
    }
    function noteRemoteApply(meta = {}) {
      lastRemoteApplyAt = Date.now();
      const t = meta.sentAt ?? meta.serverTime;
      if (typeof t === "number" && t > 0) {
        lastRemoteTimelineMsgAt = Math.max(lastRemoteTimelineMsgAt, t);
      }
      softDriftState = { active: false, rate: 1, until: 0, lastSign: 0 };
    }
    function shouldSuppressLocalPlaybackOutbound() {
      return Date.now() - lastRemoteApplyAt < remoteIgnoreLocalMs();
    }
    function shouldAcceptRoomSyncTick(msg) {
      if (!msg || typeof msg.sentAt !== "number") return true;
      return msg.sentAt >= lastRemoteTimelineMsgAt - 400;
    }
    function shouldApplyRemoteSeek(deltaSec) {
      const th = getDriftThresholds(handlerKey());
      const micro = th.microSeekMin;
      if (micro > 0 && Math.abs(deltaSec) < micro) {
        return { ok: false, reason: "micro_correction" };
      }
      const a = adapter();
      const win = a.rapidSeekRejectWindowMs;
      const max = a.rapidSeekMaxInWindow;
      if (typeof win === "number" && win > 0 && typeof max === "number" && max > 0) {
        const now = Date.now();
        while (recentRemoteSeekTs.length && now - recentRemoteSeekTs[0] > win) {
          recentRemoteSeekTs.shift();
        }
        if (recentRemoteSeekTs.length >= max) {
          return { ok: false, reason: "rapid_seek" };
        }
      }
      return { ok: true, reason: null };
    }
    function recordRemoteSeekCommitted() {
      recentRemoteSeekTs.push(Date.now());
    }
    function shouldSkipSeekWhileVideoSeeking(v) {
      if (!adapter().skipRemoteSeekWhileVideoSeeking) return false;
      try {
        return !!(v && v.seeking);
      } catch {
        return false;
      }
    }
    function beginReconnectSettle(ms = 5e3) {
      clientReconnectSettleUntil = Date.now() + ms;
    }
    function isReconnectSettling() {
      return Date.now() < clientReconnectSettleUntil;
    }
    function tickSoftDriftPlaybackRate(ctx) {
      const th = getDriftThresholds(handlerKey());
      const p = roomPolicy();
      const adMode = !!(p && p.adMode);
      const now = Date.now();
      const disable = !th.enableSoftPlaybackRateDrift || adMode || isReconnectSettling() || serverReconnectSettling() || ctx.videoPaused || !ctx.hostPlaying;
      if (disable) {
        if (softDriftState.active) {
          softDriftState = { active: false, rate: 1, until: 0, lastSign: 0 };
          return { action: "reset", log: "policy_or_pause" };
        }
        return { action: "none" };
      }
      const adrift = Math.abs(ctx.driftSigned);
      const softFloor = Math.max(0.4, th.ignoreBelow);
      if (adrift < softFloor) {
        if (softDriftState.active) {
          softDriftState = { active: false, rate: 1, until: 0, lastSign: 0 };
          return { action: "reset", log: "below_soft_floor", absDrift: adrift };
        }
        return { action: "none" };
      }
      if (adrift > th.softBandMax) {
        if (softDriftState.active) {
          softDriftState = { active: false, rate: 1, until: 0, lastSign: 0 };
          return { action: "reset", log: "hard_band", absDrift: adrift };
        }
        return { action: "none" };
      }
      const sign = ctx.driftSigned > 0 ? 1 : ctx.driftSigned < 0 ? -1 : 0;
      if (sign === 0) return { action: "none" };
      const [rLo, rHi] = sign > 0 ? th.rateAhead : th.rateBehind;
      const wantRate = (rLo + rHi) / 2;
      if (softDriftState.active && softDriftState.lastSign === sign && now < softDriftState.until) {
        return { action: "hold", rate: softDriftState.rate, absDrift: adrift };
      }
      softDriftState = {
        active: true,
        rate: wantRate,
        until: now + SOFT_DRIFT_TIMEOUT_MS,
        lastSign: sign
      };
      return { action: "start", rate: wantRate, absDrift: adrift };
    }
    function resetSession() {
      lastRemoteApplyAt = 0;
      lastRemoteTimelineMsgAt = 0;
      clientReconnectSettleUntil = 0;
      recentRemoteSeekTs.length = 0;
      driftAbsSamples.length = 0;
      softDriftState = { active: false, rate: 1, until: 0, lastSign: 0 };
    }
    return {
      CORRECTION_REASONS,
      classifyDriftTier: (absDrift) => classifyDriftTier(absDrift, handlerKey()),
      getDriftThresholds: () => getDriftThresholds(handlerKey()),
      isHardPriorityRemote,
      isAlreadyConverging,
      recordDriftSample,
      shouldApplyRemoteState,
      noteRemoteApply,
      shouldSuppressLocalPlaybackOutbound,
      shouldAcceptRoomSyncTick,
      shouldApplyRemoteSeek,
      recordRemoteSeekCommitted,
      shouldSkipSeekWhileVideoSeeking,
      beginReconnectSettle,
      isReconnectSettling,
      serverReconnectSettling,
      tickSoftDriftPlaybackRate,
      resetSession
    };
  }

  // content/src/app.js
  function runPlayShareContent() {
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
      VIEWER_SOFT_DRIFT_RESET_MS,
      POSITION_REPORT_INTERVAL_MS,
      CLUSTER_SYNC_SPREAD_SEC,
      COUNTDOWN_SECONDS,
      DIAG_DEBOUNCE_MS,
      DIAG_PEER_DEV_SHARE_MS,
      TIME_JUMP_THRESHOLD,
      PLAYBACK_ECHO_SUPPRESS_MS,
      PAUSE_SEEK_OUTBOUND_PLAY_SUPPRESS_MS,
      SIDEBAR_WIDTH,
      DEFAULT_DIAG_UPLOAD_BEARER
    } = contentConstants;
    const DIAG_EVENTS = new Set(contentConstants.DIAG_EVENT_NAMES);
    let diagnosticsUiEnabled = false;
    const platform = contentConstants.detectPlatform(hostname);
    const playbackProfile = getPlaybackProfile(hostname, location.pathname);
    const siteSync = getSiteSyncAdapter(hostname, location.pathname);
    const syncDecision = createSyncDecisionEngine({
      getSiteSyncAdapter: () => siteSync,
      getHandlerKey: () => playbackProfile.handlerKey,
      getRoomSyncPolicy: () => diag.lastRoomSyncPolicy,
      getDrmPassive: () => !!playbackProfile.drmPassive
    });
    function getFullscreenUiHost() {
      try {
        const fs = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
        if (fs && fs instanceof HTMLElement && fs.tagName !== "VIDEO") return fs;
      } catch {
      }
      return document.body;
    }
    const drmSyncPrompt = createDrmSyncPromptHost({ getMountParent: getFullscreenUiHost });
    let roomState = null;
    let video = null;
    let syncLock = false;
    let suppressPlaybackEchoUntil = 0;
    let suppressOutboundPlayWhileRoomPausedUntil = 0;
    let lastSentTime = -1;
    let lastPlaybackOutboundKind = (
      /** @type {'PLAY'|'PAUSE'|'SEEK'|null} */
      null
    );
    let lastAppliedState = { currentTime: 0, playing: false };
    let sidebarVisible = false;
    let sidebarFrame = null;
    let sidebarToggleBtn = null;
    let sidebarIframeReady = false;
    const sidebarPendingPost = [];
    const SIDEBAR_POST_QUEUE_MAX = 120;
    const sidebarCompact = true;
    const sidebarPosition = "right";
    let countdownInProgress = false;
    let countdownOverlayEl = null;
    let hostPositionInterval = null;
    let viewerSyncInterval = null;
    let viewerReconcileInterval = null;
    let softPlaybackRateResetTimer = null;
    let videoDomDisconnect = null;
    let hostAuthoritativeRef = null;
    let adBreakMonitor = null;
    let netflixAdStateMachine = null;
    const peersInAdBreak = /* @__PURE__ */ new Map();
    let localAdBreakActive = false;
    let positionReportInterval = null;
    let peerRecordingSampleTimer = null;
    let clusterSyncBadge = null;
    let lastClusterSidebarKey = null;
    let hostTimeupdateSeekSuppressUntil = 0;
    let prevBgWsOpen = (
      /** @type {boolean|undefined} */
      void 0
    );
    let lastSyncAt = 0;
    let lastTimeUpdatePos = -1;
    let lastTimeUpdateCheckAt = 0;
    let pendingSyncState = null;
    let playbackOutboundCoalesceTimer = null;
    let lastLocalPlaybackWireAt = 0;
    let lastLocalWirePlayingSent = null;
    let remotePlaybackDebounceTimer = null;
    let queuedRemotePlaybackApply = null;
    function syncPendingSyncStateDiagFlag() {
      diag.pendingSyncStateQueued = !!pendingSyncState;
    }
    function armPlaybackEchoSuppress(extraMs = 0) {
      const until = Date.now() + PLAYBACK_ECHO_SUPPRESS_MS + extraMs;
      suppressPlaybackEchoUntil = Math.max(suppressPlaybackEchoUntil, until);
    }
    function armPauseSeekAutoplayPlaySuppress() {
      const ms = playbackProfile.pauseSeekOutboundPlaySuppressMs ?? PAUSE_SEEK_OUTBOUND_PLAY_SUPPRESS_MS;
      suppressOutboundPlayWhileRoomPausedUntil = Math.max(suppressOutboundPlayWhileRoomPausedUntil, Date.now() + ms);
    }
    function isPlaybackEchoSuppressed() {
      return Date.now() < suppressPlaybackEchoUntil;
    }
    function shouldSuppressPlaybackOutboundEcho(isPlayEvent) {
      const v = findVideo() || video;
      if (isPlayEvent && v && !v.paused && !lastAppliedState.playing) {
        if (Date.now() < suppressOutboundPlayWhileRoomPausedUntil) return true;
      }
      if (!isPlaybackEchoSuppressed()) return false;
      if (!v) return true;
      if (isPlayEvent) {
        if (!v.paused && !lastAppliedState.playing) return false;
        return true;
      }
      if (v.paused && lastAppliedState.playing) return false;
      return true;
    }
    const EXTENSION_OPS_DEFAULTS = {
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
      remoteApplyIgnoredLocalAd: 0,
      syncStateIgnoredLocalAd: 0,
      playbackOutboundSuppressedLocalAd: 0,
      syncStateSkippedRedundant: 0,
      remoteSeekSuppressedDecision: 0,
      remoteSeekSuppressedVideoSeeking: 0,
      syncDecisionRejectedReconnectSettle: 0,
      syncDecisionRejectedCooldown: 0,
      syncDecisionRejectedServerAdMode: 0,
      syncDecisionRejectedConverging: 0,
      syncDecisionNetflixSafetyNoop: 0,
      softDriftPlaybackStarts: 0,
      softDriftPlaybackResets: 0
    };
    const MESSAGING_DEFAULTS = {
      runtimeSendFailures: 0,
      runtimeLastErrorAt: null,
      runtimeLastErrorMessage: null,
      sendThrowCount: 0
    };
    const extensionOpsStore = { ...EXTENSION_OPS_DEFAULTS };
    const messagingStore = { ...MESSAGING_DEFAULTS };
    let diagExportAccumulateActive = () => false;
    const diag = {
      connectionStatus: "unknown",
      connectionMessage: "",
      transportPhase: "",
      lastEvent: null,
      recentMessages: [],
      errors: [],
      videoAttached: false,
      maxMessages: 8,
      maxErrors: 5,
      tabHidden: typeof document !== "undefined" && document.hidden,
      diagOverlayStale: false,
      panelMinimized: false,
      overlayWide: false,
      theme: "dark",
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
        eventFilter: "",
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
       * Content-script bridge counters (this tab only). Writes are ignored unless
       * `diagExportAccumulateActive()` (profiler recording, or stopped session pending upload).
       */
      extensionOps: extensionOpsStore,
      /** Latest GET_DIAG.transport from the service worker (WebSocket lifecycle). */
      serviceWorkerTransport: null,
      /** chrome.runtime.sendMessage failures — gated like extensionOps. */
      messaging: messagingStore,
      /** After Stop until successful DB upload (or Clear); keeps export buffers warm for Send/auto-send. */
      profilerExportPending: false,
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
      /** Last `roomSyncPolicy` from server POSITION_SNAPSHOT (adMode, settle, etc.). */
      lastRoomSyncPolicy: (
        /** @type {null | Record<string, unknown>} */
        null
      ),
      /** Edge-detect server adMode for one-shot client logs. */
      _wasServerAdMode: false,
      /** Dev: last “missed ad” capture from diagnostics CTA. */
      lastPrimeMissedAdCapture: (
        /** @type {null | { at: number, clipboardOk: boolean }} */
        null
      ),
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
      primeSync: siteSync.key === "prime" ? {
        adDetectorActive: false,
        adScore: 0,
        adStrong: false,
        adReasons: (
          /** @type {string[]} */
          []
        ),
        adChannels: { adCountdownUi: false, adTimerUi: false, playerAdControls: false, mediaSession: false },
        inSdkShell: false,
        viewerDriftSec: (
          /** @type {number|null} */
          null
        ),
        selectorThatMatched: (
          /** @type {string|null} */
          null
        ),
        lastPollAt: 0,
        extensionLocalAd: false,
        peersInAd: 0
      } : null,
      /** Sync console layout: icon strip vs full dashboard. */
      consoleView: (
        /** @type {'compact' | 'detailed'} */
        "detailed"
      ),
      /** Which blocks appear in detailed dashboard (moderator layout). */
      dashBlocks: {
        overview: true,
        alerts: true,
        prime: true,
        multiplayer: true,
        server: true,
        technical: true,
        logs: true
      },
      /** Resolved `/diag/intel/explorer` URL for the intelligence dashboard button. */
      _intelExplorerUrl: ""
    };
    const DIAG_LS_CONSOLE_VIEW = "playshare_diag_console_view";
    const DIAG_LS_DASH_BLOCKS = "playshare_diag_dash_blocks";
    function hydrateDiagConsolePrefs() {
      try {
        const v = localStorage.getItem(DIAG_LS_CONSOLE_VIEW);
        if (v === "compact" || v === "detailed") diag.consoleView = v;
        const raw = localStorage.getItem(DIAG_LS_DASH_BLOCKS);
        if (raw) {
          const o = JSON.parse(raw);
          for (const k of Object.keys(diag.dashBlocks)) {
            if (typeof o[k] === "boolean") diag.dashBlocks[k] = o[k];
          }
        }
      } catch {
      }
    }
    function persistDiagConsolePrefs() {
      try {
        localStorage.setItem(DIAG_LS_CONSOLE_VIEW, diag.consoleView);
        localStorage.setItem(DIAG_LS_DASH_BLOCKS, JSON.stringify(diag.dashBlocks));
      } catch {
      }
    }
    hydrateDiagConsolePrefs();
    let primeSyncDebugHud = false;
    let playShareDevelopmentInstall = false;
    let primeTelemetryTimer = null;
    let primeHudEl = null;
    function videoElForPrimeTelemetry() {
      try {
        if (video && video.isConnected && video.tagName === "VIDEO" && !isVideoStale(video)) return video;
      } catch {
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
      }
    }
    function ensurePrimeHudElement() {
      if (primeHudEl || siteSync.key !== "prime" || !document.body) return;
      primeHudEl = document.createElement("div");
      primeHudEl.id = "playshare-prime-sync-hud";
      primeHudEl.setAttribute("aria-live", "polite");
      primeHudEl.style.cssText = "position:fixed;bottom:12px;right:12px;z-index:2147483646;max-width:min(340px,calc(100vw - 24px));font:12px/1.4 system-ui,-apple-system,sans-serif;color:#e8f4fc;background:rgba(6,40,52,.92);border:1px solid rgba(0,168,225,.45);border-radius:10px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.4);pointer-events:none;";
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
      let driftLine = "—";
      if (roomState?.isHost) driftLine = "— (you are host)";
      else if (typeof drift === "number" && !Number.isNaN(drift)) {
        driftLine = `${drift >= 0 ? "+" : ""}${drift.toFixed(2)}s vs extrapolated host`;
      } else if (roomState && !roomState.isHost) driftLine = "— (waiting for host position)";
      const role = roomState?.isHost ? "Host" : roomState ? "Viewer" : "No room";
      const sel = p.selectorThatMatched ? String(p.selectorThatMatched).replace(/</g, "") : "—";
      primeHudEl.innerHTML = `<div style="font-weight:600;margin-bottom:6px;color:#00A8E1">PlayShare · Prime sync</div><div>Role: ${role}</div><div>Video in main SDK shell: <strong>${p.inSdkShell ? "yes" : "no"}</strong></div><div>Ad (authoritative cues): <strong>${p.adDetectorActive ? "yes" : "no"}</strong> · channels×${p.adScore} · room pause: ${p.extensionLocalAd ? "yes" : "no"} · peers in ad: ${p.peersInAd}</div><div style="opacity:.88;font-size:11px;word-break:break-word">${p.adReasons && p.adReasons.length ? p.adReasons.join(", ") : "—"}</div><div>findVideo selector: <span style="word-break:break-all;opacity:.9">${sel}</span></div><div>Reconcile: <strong>${driftLine}</strong></div><div style="opacity:.85;margin-top:6px;font-size:11px">Popup: toggle “Prime sync HUD” off · <code>__playsharePrime.getStatus()</code></div>`;
    }
    function updatePrimeHudVisibility() {
      if (siteSync.key !== "prime") return;
      if (primeSyncDebugHud) {
        ensurePrimeHudElement();
        if (!primeHudEl) return;
        refreshPrimeSyncTelemetry();
        updatePrimeHudContent();
        primeHudEl.style.display = "block";
      } else if (primeHudEl) {
        primeHudEl.style.display = "none";
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
    function syncPrimeTelemetryPolling() {
      if (siteSync.key !== "prime") return;
      if (!primeSyncDebugHud && !diagVisible) {
        stopPrimeTelemetryPolling();
        return;
      }
      if (primeTelemetryTimer) return;
      primeTelemetryTimer = setInterval(() => {
        if (siteSync.key !== "prime" || !primeSyncDebugHud && !diagVisible) {
          stopPrimeTelemetryPolling();
          return;
        }
        refreshPrimeSyncTelemetry();
        if (primeSyncDebugHud && primeHudEl && primeHudEl.style.display !== "none") {
          updatePrimeHudContent();
        }
        if (diagVisible) scheduleDiagUpdate();
      }, PRIME_TELEMETRY_MS);
    }
    function refreshPrimeDebugHudFromStorage() {
      if (siteSync.key !== "prime") return;
      chrome.storage.local.get({ [PRIME_SYNC_DEBUG_STORAGE_KEY]: false }, (d) => {
        primeSyncDebugHud = playShareDevelopmentInstall && !!d[PRIME_SYNC_DEBUG_STORAGE_KEY];
        updatePrimeHudVisibility();
      });
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
      if (!diagExportAccumulateActive() && event !== "ERROR") return;
      const entry = { t: Date.now(), event, detail };
      diag.lastEvent = entry;
      if (event === "ERROR") {
        diag.errors.unshift(entry);
        diag.errors.length = Math.min(diag.errors.length, diag.maxErrors);
      } else if (DIAG_EVENTS.has(event)) {
        diag.recentMessages.unshift(entry);
        diag.recentMessages.length = Math.min(diag.recentMessages.length, diag.maxMessages);
      }
      scheduleDiagUpdate();
    }
    function platformPlaybackLog(event, detail) {
      diagLog(event, { ...detail || {}, handler: playbackProfile.handlerKey, drmPassive: playbackProfile.drmPassive });
    }
    function syncDiagRecord(opts) {
      if (!diagExportAccumulateActive()) return;
      const s = diag.sync;
      const entry = { t: Date.now(), ...opts };
      s.events.unshift(entry);
      s.events.length = Math.min(s.events.length, s.maxEvents);
      if (opts.type === "play_sent") s.metrics.playSent++;
      if (opts.type === "play_recv") {
        s.metrics.playRecv++;
        s.lastRecvAt = Date.now();
      }
      if (opts.type === "play_ok") s.metrics.playOk++;
      if (opts.type === "play_fail") s.metrics.playFail++;
      if (opts.type === "pause_sent") s.metrics.pauseSent++;
      if (opts.type === "pause_recv") {
        s.metrics.pauseRecv++;
        s.lastRecvAt = Date.now();
      }
      if (opts.type === "pause_ok") s.metrics.pauseOk++;
      if (opts.type === "pause_fail") s.metrics.pauseFail++;
      if (opts.type === "seek_sent") s.metrics.seekSent++;
      if (opts.type === "seek_recv") {
        s.metrics.seekRecv++;
        s.lastRecvAt = Date.now();
      }
      if (opts.type === "seek_ok") s.metrics.seekOk++;
      if (opts.type === "seek_fail") s.metrics.seekFail++;
      scheduleDiagUpdate();
    }
    function sendDiagApplyResult(targetClientId, eventType, success, latency, correlationId) {
      if (!roomState?.clientId || !targetClientId) return;
      sendBg({
        source: "playshare",
        type: "DIAG_SYNC_APPLY_RESULT",
        targetClientId,
        fromClientId: roomState.clientId,
        fromUsername: roomState.username,
        eventType,
        success,
        latency,
        correlationId: correlationId || void 0,
        platform: platform.key,
        platformName: platform.name
      });
    }
    function sendDiagReport() {
      if (!roomState) return;
      const s = diag.sync;
      s.lastReportSentAt = Date.now();
      const payload = {
        source: "playshare",
        type: "DIAG_SYNC_REPORT",
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
          payload.devDiag = { schema: "playshare.peerDevDiag.v1", captureError: true };
        }
      }
      sendBg(payload);
    }
    function broadcastProfilerCollectionState(active) {
      if (!diagnosticsUiEnabled || !roomState?.clientId) return;
      sendBg({
        source: "playshare",
        type: "DIAG_PROFILER_COLLECTION",
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
          source: "playshare",
          type: "DIAG_PEER_RECORDING_SAMPLE",
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
    function ingestPeerRecordingSample(msg) {
      try {
        if (!getVideoProfiler().isRecording()) return;
      } catch {
        return;
      }
      if (!roomState || msg.collectorClientId !== roomState.clientId) return;
      const from = (
        /** @type {string|undefined} */
        msg.fromClientId
      );
      if (!from || from === roomState.clientId) return;
      const row = {
        receivedAt: Date.now(),
        fromUsername: typeof msg.fromUsername === "string" ? msg.fromUsername : "",
        payload: msg.payload && typeof msg.payload === "object" ? (
          /** @type {Record<string, unknown>} */
          msg.payload
        ) : {}
      };
      const by = diag.peerRecordingSamples.byClient;
      if (!by[from]) by[from] = [];
      by[from].push(row);
      const cap = 36;
      while (by[from].length > cap) by[from].shift();
      scheduleDiagUpdate();
    }
    let cachedVideoEl = null;
    let cachedVideoDoc = null;
    function invalidateVideoCache() {
      cachedVideoEl = null;
      cachedVideoDoc = null;
      if (diagExportAccumulateActive()) diag.findVideo.invalidations++;
    }
    function findVideo() {
      const isReady = (v) => v && v.tagName === "VIDEO" && !isNaN(v.duration) && (v.duration > 0 || v.readyState >= 1);
      const isReadyRelaxed = (v) => v && v.tagName === "VIDEO" && (v.readyState >= 2 || v.duration > 0 && !isNaN(v.duration));
      const doc = document;
      if (cachedVideoEl && cachedVideoDoc === doc) {
        try {
          if (cachedVideoEl.isConnected && (cachedVideoEl.readyState >= 1 || cachedVideoEl.duration > 0 && !isNaN(cachedVideoEl.duration))) {
            if (siteSync.shouldRefreshVideoCache?.(cachedVideoEl)) {
              invalidateVideoCache();
            } else {
              if (diagExportAccumulateActive()) diag.findVideo.cacheReturns++;
              return cachedVideoEl;
            }
          }
        } catch {
        }
        invalidateVideoCache();
      }
      if (diagExportAccumulateActive()) diag.findVideo.fullScans++;
      if (diag.primeSync) diag.primeSync.selectorThatMatched = null;
      function findInRoot(root, maxDepth = 3) {
        const v = root.querySelector?.("video");
        if (isReady(v)) return v;
        if (maxDepth <= 0) return null;
        const elements = root.querySelectorAll?.("*") || [];
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
        "video",
        ".dv-player-main video",
        ".nf-player-container video",
        ".VideoPlayer video",
        "#dv-web-player video",
        ".webPlayerSDKContainer video",
        ".btm-media-client-element video",
        "#movie_player video",
        ".html5-main-video",
        "ytd-player video"
      ];
      const prioritySel = siteSync.getPriorityVideoSelectors?.() ?? [];
      const selectors = [.../* @__PURE__ */ new Set([...prioritySel, ...genericVideoSelectors])];
      function pickBestVideoForSelector(sel, readyFn) {
        try {
          const list = document.querySelectorAll(sel);
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
      const all = document.querySelectorAll("video");
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
      video.addEventListener("play", onVideoPlay);
      video.addEventListener("pause", onVideoPause);
      video.addEventListener("seeked", onVideoSeeked);
      video.addEventListener("timeupdate", onVideoTimeUpdate);
      video.addEventListener("waiting", onVideoWaiting);
      video.addEventListener("stalled", onVideoStalled);
      diag.videoAttached = true;
      if (diagExportAccumulateActive()) diag.findVideo.videoAttachCount++;
      if (roomState?.isHost) {
        sendBg({ source: "playshare", type: "SET_ROOM_VIDEO_URL", videoUrl: location.href });
        roomState.videoUrl = location.href;
        postSidebarRoomState();
      }
      if (pendingSyncState && !roomState?.isHost) {
        diag.extensionOps.syncStateFlushedOnVideoAttach++;
        applySyncState(pendingSyncState);
        pendingSyncState = null;
        syncPendingSyncStateDiagFlag();
      }
      platformPlaybackLog("VIDEO_ATTACHED", {
        src: (v.src || v.currentSrc || "").slice(0, 60),
        readyState: v.readyState,
        paused: v.paused
      });
      if (roomState) startPositionReportInterval();
      if (roomState && !roomState.isHost) startViewerReconcileLoop();
      if (roomState) startAdBreakMonitorIfNeeded();
      try {
        getVideoProfiler().notifyVideoMayHaveChanged();
      } catch {
      }
    }
    function enrichVideoProfilerSnapshot(snap, v, ctx) {
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
          lastAppliedTime: typeof lastAppliedState?.currentTime === "number" ? +lastAppliedState.currentTime.toFixed(3) : null,
          lastSentTime: typeof lastSentTime === "number" && lastSentTime >= 0 ? +lastSentTime.toFixed(3) : null,
          lastPlaybackOutboundKind,
          lastLocalWirePlayingSent,
          lastSyncAt: lastSyncAt || null,
          connectionStatus: diag.connectionStatus,
          transportPhase: diag.transportPhase ? String(diag.transportPhase) : "",
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
          playApplyMismatch: v && typeof v.paused === "boolean" ? lastAppliedState.playing === v.paused : null,
          timeVsLastAppliedDeltaSec: v && typeof v.currentTime === "number" && typeof lastAppliedState.currentTime === "number" ? +(v.currentTime - lastAppliedState.currentTime).toFixed(3) : null,
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
          clusterSync: diag.clusterSync ? {
            spreadSec: diag.clusterSync.spreadSec,
            synced: diag.clusterSync.synced,
            playingMismatch: diag.clusterSync.playingMismatch,
            freshMemberCount: diag.clusterSync.freshMemberCount,
            staleCount: diag.clusterSync.staleCount,
            roomMemberCount: diag.clusterSync.roomMemberCount
          } : null
        };
      } catch {
        snap.playShare = { readError: true };
      }
      if (siteSync.key === "prime" && diag.primeSync) {
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
      if (siteSync.key === "prime" && v) {
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
      if (siteSync.key === "netflix" && v) {
        try {
          snap.netflixAd = {
            extensionHeuristicAd: detectNetflixAdPlaying(v),
            adStateMachine: netflixAdStateMachine ? netflixAdStateMachine.getDebugSnapshot() : null
          };
          if (ctx?.userMarker) {
            snap.netflixAd.userMarkerSeq = ctx.seq;
            snap.netflixAd.userMarkerNote = ctx.note;
            snap.netflixAd.domHints = captureNetflixAdProfilerHints(v);
          }
        } catch {
          snap.netflixAd = { readError: true };
        }
      }
    }
    function buildVideoProfilerExportExtras() {
      const sw = diag.serviceWorkerTransport;
      const iv = playbackProfile;
      return {
        playShareSession: {
          room: roomState ? {
            code: roomState.roomCode,
            isHost: !!roomState.isHost,
            memberCount: roomState.members?.length ?? 0,
            hostOnlyControl: !!roomState.hostOnlyControl
          } : null,
          playbackOutboundNote: "PLAY/PAUSE: polarity-aware flush + immediate wire when lastLocalWirePlayingSent is null; duplicate same-state <video> events skipped. Echo-suppress window still allows opposite-direction toggles vs lastAppliedState.playing so rapid UI after an apply is not dropped.",
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
          syncMetricsTotals: { ...diag.sync?.metrics || {} },
          timeupdateJumpsRecent: (diag.timeupdateJumps || []).slice(-24),
          recentSyncEventKinds: (diag.sync?.events || []).slice(-20).map((e) => e.type),
          peerReportCount: Object.keys(diag.sync?.peerReports || {}).length,
          serviceWorkerTransport: sw ? {
            wsOpenCount: sw.wsOpenCount,
            wsCloseCount: sw.wsCloseCount,
            wsSendFailures: sw.wsSendFailures
          } : null,
          messaging: {
            runtimeSendFailures: diag.messaging.runtimeSendFailures,
            runtimeLastErrorAt: diag.messaging.runtimeLastErrorAt,
            sendThrowCount: diag.messaging.sendThrowCount
          }
        }
      };
    }
    let videoProfilerController = null;
    function getVideoProfiler() {
      if (!videoProfilerController) {
        videoProfilerController = createVideoPlayerProfiler({
          getVideo: () => {
            try {
              if (video && video.isConnected && document.contains(video)) return video;
            } catch {
            }
            return findVideo();
          },
          enrichSnapshot: enrichVideoProfilerSnapshot,
          getExportExtras: buildVideoProfilerExportExtras,
          /** ~3.3 h of 3 s snapshots if the buffer fills; ring drops oldest while PlayShare keeps running. */
          snapshotIntervalMs: 3e3,
          maxSnapshots: 4e3,
          maxEvents: 2e4
        });
      }
      return videoProfilerController;
    }
    diagExportAccumulateActive = function diagExportAccumulateActiveImpl() {
      try {
        if (getVideoProfiler().isRecording()) return true;
      } catch {
      }
      return !!diag.profilerExportPending;
    };
    diag.extensionOps = new Proxy(extensionOpsStore, {
      set(target, prop, value, receiver) {
        if (!diagExportAccumulateActive()) return true;
        return Reflect.set(target, prop, value, receiver);
      },
      get(target, prop, receiver) {
        return Reflect.get(target, prop, receiver);
      }
    });
    diag.messaging = new Proxy(messagingStore, {
      set(target, prop, value, receiver) {
        if (!diagExportAccumulateActive()) return true;
        return Reflect.set(target, prop, value, receiver);
      },
      get(target, prop, receiver) {
        return Reflect.get(target, prop, receiver);
      }
    });
    function maybeSetPlaybackDiagRtt(ms, src) {
      if (!diagExportAccumulateActive()) return;
      diag.timing.lastRttMs = ms;
      diag.timing.lastRttSource = src;
    }
    function maybeUpdateDriftEwm(sampleSec, alpha) {
      if (!diagExportAccumulateActive()) return;
      updateDriftEwm(diag.timing, sampleSec, alpha);
    }
    function recordDiagTimeline(timeline, entry, maxLen) {
      if (!diagExportAccumulateActive()) return;
      pushDiagTimeline(timeline, entry, maxLen);
    }
    function profilerIfRecording(fn) {
      try {
        const p = getVideoProfiler();
        if (p.isRecording()) fn(p);
      } catch {
      }
    }
    function profilerMapSyncDecisionReject(reason) {
      const m = {
        apply_cooldown: "correction_rejected_cooldown",
        already_converging: "correction_rejected_converging",
        server_ad_mode: "correction_rejected_ad_mode",
        reconnect_settle: "correction_rejected_reconnect_settle",
        netflix_safety_noop: "correction_rejected_netflix_safety"
      };
      return m[reason] || "remote_correction_rejected";
    }
    function profilerEmitDecision(type, detail) {
      profilerIfRecording((p) => p.recordDecisionEvent(type, detail));
    }
    function profilerEmitRemoteSync(phase, detail) {
      profilerIfRecording((p) => p.recordRemoteSyncApply(phase, detail));
    }
    function profilerEmitRateNudge(phase, detail) {
      profilerIfRecording((p) => p.recordPlaybackRateNudge(phase, detail));
    }
    function profilerEmitSyncRejection(remoteKind, dec, extra) {
      if (!dec || dec.ok) return;
      profilerEmitDecision(profilerMapSyncDecisionReject(dec.reason), {
        remoteKind,
        reason: dec.reason,
        ...extra && typeof extra === "object" ? extra : {}
      });
    }
    function buildPeerDevDiagSnapshot() {
      let ver = "1.0.0";
      try {
        ver = chrome.runtime.getManifest()?.version || ver;
      } catch {
      }
      const playback = { ct: null, playing: null, rs: null };
      try {
        const v = findVideo() || video;
        if (v && v.tagName === "VIDEO") {
          playback.ct = typeof v.currentTime === "number" && Number.isFinite(v.currentTime) ? +v.currentTime.toFixed(2) : null;
          playback.playing = !v.paused;
          playback.rs = v.readyState;
        }
      } catch {
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
        schema: "playshare.peerDevDiag.v1",
        capturedAt: Date.now(),
        extensionVersion: ver,
        timing: {
          lastRttMs: diag.timing?.lastRttMs ?? null,
          lastRttSource: diag.timing?.lastRttSource ?? null,
          driftEwmSec: diag.timing?.driftEwmSec ?? null
        },
        transport: {
          connectionStatus: diag.connectionStatus,
          transportPhase: diag.transportPhase || ""
        },
        tabHidden: !!diag.tabHidden,
        clusterSync: cs ? {
          spreadSec: cs.spreadSec,
          synced: cs.synced,
          playingMismatch: cs.playingMismatch,
          freshMemberCount: cs.freshMemberCount,
          staleCount: cs.staleCount,
          label: cs.label ? String(cs.label).slice(0, 80) : null
        } : null,
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
      video.removeEventListener("play", onVideoPlay);
      video.removeEventListener("pause", onVideoPause);
      video.removeEventListener("seeked", onVideoSeeked);
      video.removeEventListener("timeupdate", onVideoTimeUpdate);
      video.removeEventListener("waiting", onVideoWaiting);
      video.removeEventListener("stalled", onVideoStalled);
      video = null;
      invalidateVideoCache();
      diag.videoAttached = false;
      hideClusterSyncBadge();
      if (roomState?.isHost) {
        roomState.videoUrl = null;
        sendBg({ source: "playshare", type: "SET_ROOM_VIDEO_URL", videoUrl: null });
        postSidebarRoomState();
      }
      try {
        getVideoProfiler().notifyVideoMayHaveChanged();
      } catch {
      }
    }
    function startHostPositionHeartbeat() {
      stopHostPositionHeartbeat();
      if (!roomState?.isHost || !video) return;
      hostPositionInterval = setInterval(() => {
        if (!video || video.paused || !roomState?.isHost) {
          stopHostPositionHeartbeat();
          return;
        }
        sendBg({ source: "playshare", type: "PLAYBACK_POSITION", currentTime: video.currentTime });
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
        sendBg({ source: "playshare", type: "SYNC_REQUEST" });
      }, VIEWER_SYNC_INTERVAL_MS);
    }
    function stopViewerSyncInterval() {
      if (viewerSyncInterval) {
        clearInterval(viewerSyncInterval);
        viewerSyncInterval = null;
      }
    }
    function ingestHostAuthoritativeSync(currentTime, playing, sentAt) {
      if (roomState?.isHost) return;
      hostAuthoritativeRef = {
        currentTime,
        playing: !!playing,
        sentAt: typeof sentAt === "number" && sentAt > 0 ? sentAt : Date.now()
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
        type: "AD_BREAK_UI",
        local: localAdBreakActive,
        waiting: peersInAdBreak.size > 0,
        peerNames: [...peersInAdBreak.values()]
      });
    }
    function pausePlaybackIfPeersStillInAd() {
      const v = findVideo() || video;
      if (peersInAdBreak.size > 0 && v && !isVideoStale(v)) {
        forcePause(v, playbackProfile.aggressiveRemoteSync);
        stopViewerReconcileLoop();
        resetVideoPlaybackRate(v);
      }
    }
    function ingestPeerAdBreakStart(fromClientId, fromUsername) {
      if (!roomState || fromClientId === roomState.clientId) return;
      peersInAdBreak.set(fromClientId, fromUsername || "Someone");
      const v = findVideo() || video;
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
        if (!roomState.isHost) sendBg({ source: "playshare", type: "SYNC_REQUEST" });
        if (!roomState.isHost) startViewerReconcileLoop();
      }
      syncAdBreakSidebar();
    }
    function stopAdBreakMonitor() {
      if (adBreakMonitor) {
        adBreakMonitor.stop();
        adBreakMonitor = null;
      }
      if (netflixAdStateMachine) {
        netflixAdStateMachine.stop();
        netflixAdStateMachine = null;
      }
    }
    function startAdBreakMonitorIfNeeded() {
      stopAdBreakMonitor();
      if (!roomState) return;
      const onAdEnter = () => {
        if (localAdBreakActive) return;
        localAdBreakActive = true;
        sendBg({ source: "playshare", type: "AD_BREAK_START" });
        syncAdBreakSidebar();
      };
      const onAdExit = () => {
        if (!localAdBreakActive) return;
        localAdBreakActive = false;
        sendBg({ source: "playshare", type: "AD_BREAK_END" });
        syncAdBreakSidebar();
        pausePlaybackIfPeersStillInAd();
      };
      if (isNetflixHostname(hostname)) {
        netflixAdStateMachine = createNetflixAdStateMachine({
          getVideo: () => findVideo() || video,
          onEnterAd: onAdEnter,
          onExitAd: onAdExit,
          log: (d) => platformPlaybackLog("NETFLIX_AD_STATE", d)
        });
        netflixAdStateMachine.start();
        return;
      }
      const adMonitorOpts = isPrimeVideoHostname(hostname) ? {
        ...PRIME_AD_BREAK_MONITOR_OPTIONS,
        detectOverride: (_h, v) => getPrimeAdDetectionSnapshot(v).likelyAd
      } : {};
      adBreakMonitor = createAdBreakMonitor(
        hostname,
        () => findVideo() || video,
        {
          onEnter: onAdEnter,
          onExit: onAdExit
        },
        adMonitorOpts
      );
      adBreakMonitor.start();
    }
    function applyManualAdBreakStart(fromShortcut) {
      if (!roomState || localAdBreakActive) return;
      stopAdBreakMonitor();
      localAdBreakActive = true;
      sendBg({ source: "playshare", type: "AD_BREAK_START" });
      syncAdBreakSidebar();
      if (fromShortcut) showToast("📺 Ad break started — room notified");
    }
    function applyManualAdBreakEnd(fromShortcut) {
      if (!roomState || !localAdBreakActive) return;
      localAdBreakActive = false;
      sendBg({ source: "playshare", type: "AD_BREAK_END" });
      stopAdBreakMonitor();
      startAdBreakMonitorIfNeeded();
      syncAdBreakSidebar();
      pausePlaybackIfPeersStillInAd();
      if (fromShortcut) showToast("✓ Ad break ended — room notified");
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
      if (!v || v.tagName !== "VIDEO") return;
      safeVideoOp(() => {
        v.playbackRate = 1;
      });
    }
    function schedulePlaybackRateReset(v, delayMs) {
      const delay = typeof delayMs === "number" ? delayMs : SOFT_SYNC_RESET_MS;
      if (softPlaybackRateResetTimer) clearTimeout(softPlaybackRateResetTimer);
      softPlaybackRateResetTimer = setTimeout(() => {
        softPlaybackRateResetTimer = null;
        const el = findVideo() || v;
        profilerEmitRateNudge("end", { reason: "scheduled_reset" });
        resetVideoPlaybackRate(el);
      }, delay);
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
      const target = ref.playing ? ref.currentTime + (now - ref.sentAt) / 1e3 : ref.currentTime;
      const drift = v.currentTime - target;
      const adrift = Math.abs(drift);
      syncDecision.recordDriftSample(adrift);
      if (diag.primeSync) diag.primeSync.viewerDriftSec = drift;
      const vb = diag.videoBuffering;
      const viewerBufferCalm = (!vb.lastWaitingAt || now - vb.lastWaitingAt > 2e3) && (!vb.lastStalledAt || now - vb.lastStalledAt > 2e3);
      if (playbackProfile.drmPassive) {
        platformPlaybackLog("VIEWER_RECONCILE_POLL", { adriftSec: +adrift.toFixed(2), hostPlaying: ref.playing });
        if (adrift > playbackProfile.drmDesyncThresholdSec) {
          diag.extensionOps.drmSyncPromptsShown++;
          drmSyncPrompt.offer({
            headline: "Sync to host?",
            detail: `About ${adrift.toFixed(1)}s off the room. Tap once to realign (low-frequency DRM-safe sync).${drmSyncPromptNetflixNote()}`,
            minIntervalMs: drmSyncPromptMinInterval("reconcile"),
            onConfirm: () => {
              diag.extensionOps.drmSyncConfirmed++;
              syncLock = true;
              applyDrmViewerOneShot(v, target, ref.playing);
              setTimeout(() => {
                syncLock = false;
              }, 700);
            }
          });
        }
        resetVideoPlaybackRate(v);
        return;
      }
      if (ref.playing && v.paused) {
        armPlaybackEchoSuppress();
        forcePlay(v, playbackProfile.aggressiveRemoteSync);
        if (roomState?.isHost) startHostPositionHeartbeat();
        else startViewerSyncInterval();
      }
      const thDr = syncDecision.getDriftThresholds();
      const tier = syncDecision.classifyDriftTier(adrift);
      if (!ref.playing) {
        if (!v.paused) {
          armPlaybackEchoSuppress();
          forcePause(v, playbackProfile.aggressiveRemoteSync);
          stopViewerSyncInterval();
        }
        if (tier === "hard" && viewerBufferCalm && adrift >= thDr.hardAbove - 1e-6) {
          profilerEmitDecision("hard_correction_selected", {
            driftSec: adrift,
            handlerKey: playbackProfile.handlerKey,
            branch: "paused_host"
          });
          armPlaybackEchoSuppress();
          safeVideoOp(() => {
            v.currentTime = target;
            lastTimeUpdatePos = target;
          });
        }
        resetVideoPlaybackRate(v);
        return;
      }
      if (tier === "hard" && viewerBufferCalm) {
        if (softPlaybackRateResetTimer) {
          clearTimeout(softPlaybackRateResetTimer);
          softPlaybackRateResetTimer = null;
        }
        resetVideoPlaybackRate(v);
        profilerEmitDecision("hard_correction_selected", {
          driftSec: adrift,
          handlerKey: playbackProfile.handlerKey,
          branch: "playing_host"
        });
        armPlaybackEchoSuppress();
        safeVideoOp(() => {
          v.currentTime = target;
          lastTimeUpdatePos = target;
          v.playbackRate = 1;
        });
        return;
      }
      if (!viewerBufferCalm) return;
      if (tier === "ignore") {
        const sd0 = syncDecision.tickSoftDriftPlaybackRate({
          driftSigned: drift,
          hostPlaying: ref.playing,
          videoPaused: v.paused
        });
        if (sd0.action === "reset") {
          profilerEmitRateNudge("end", { reason: sd0.log || "tier_ignore_reset" });
          resetVideoPlaybackRate(v);
          diag.extensionOps.softDriftPlaybackResets++;
          platformPlaybackLog("SOFT_DRIFT_RESET", { reason: sd0.log, absDrift: sd0.absDrift });
        }
        return;
      }
      const sd = syncDecision.tickSoftDriftPlaybackRate({
        driftSigned: drift,
        hostPlaying: ref.playing,
        videoPaused: v.paused
      });
      if (sd.action === "reset") {
        profilerEmitRateNudge("end", { reason: sd.log || "soft_reset" });
        resetVideoPlaybackRate(v);
        diag.extensionOps.softDriftPlaybackResets++;
        platformPlaybackLog("SOFT_DRIFT_RESET", { reason: sd.log, absDrift: sd.absDrift });
        return;
      }
      if (sd.action === "start") {
        diag.extensionOps.softDriftPlaybackStarts++;
        profilerEmitDecision("soft_drift_selected", {
          absDrift: sd.absDrift,
          rate: sd.rate,
          handlerKey: playbackProfile.handlerKey
        });
        profilerEmitRateNudge("start", { rate: sd.rate, absDrift: sd.absDrift, driftSigned: drift });
        platformPlaybackLog("SOFT_DRIFT_START", { rate: sd.rate, absDrift: sd.absDrift, driftSigned: drift });
        safeVideoOp(() => {
          v.playbackRate = sd.rate;
        });
        schedulePlaybackRateReset(v, VIEWER_SOFT_DRIFT_RESET_MS);
        return;
      }
      if (sd.action === "hold" && typeof sd.rate === "number") {
        if (Math.abs(v.playbackRate - sd.rate) > 0.02) {
          platformPlaybackLog("SOFT_DRIFT_HOLD", { rate: sd.rate, absDrift: sd.absDrift });
          safeVideoOp(() => {
            v.playbackRate = sd.rate;
          });
        }
        schedulePlaybackRateReset(v, VIEWER_SOFT_DRIFT_RESET_MS);
      }
    }
    function startViewerReconcileLoop() {
      stopViewerReconcileLoop();
      if (roomState?.isHost || !roomState) return;
      viewerReconcileInterval = setInterval(runViewerReconcileTick, playbackProfile.viewerReconcileIntervalMs);
    }
    function sendPositionReportOnce() {
      if (!roomState || !video || isVideoStale(video)) return;
      if (document.hidden) return;
      let confidence = "MEDIUM";
      try {
        confidence = siteSync.getPlaybackConfidence ? siteSync.getPlaybackConfidence({ video }) : "MEDIUM";
      } catch {
        confidence = "MEDIUM";
      }
      sendBg({
        source: "playshare",
        type: "POSITION_REPORT",
        currentTime: video.currentTime,
        playing: !video.paused,
        confidence
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
      const dt = Math.max(0, (wallMs - m.receivedAt) / 1e3);
      return m.playing ? m.currentTime + dt : m.currentTime;
    }
    function evaluateClusterPositionSnapshot(msg) {
      const wallMs = typeof msg.wallMs === "number" ? msg.wallMs : Date.now();
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
          label: "Cluster: add another participant",
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
          label: fresh.length === 0 ? "Cluster: waiting for playhead reports" : "Cluster: waiting for more reports",
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
          label: "Cluster: play/pause mismatch",
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
        label: synced ? `Cluster: synced (within ${CLUSTER_SYNC_SPREAD_SEC}s)` : `Cluster: ~${spread.toFixed(1)}s apart`,
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
      clusterSyncBadge = document.createElement("div");
      clusterSyncBadge.id = "ws-cluster-sync-badge";
      clusterSyncBadge.setAttribute("aria-live", "polite");
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
        clusterSyncBadge.textContent = "Sync: …";
        clusterSyncBadge.style.background = "rgba(30,30,30,0.85)";
        clusterSyncBadge.style.color = "#ccc";
        return;
      }
      let short = "Sync: …";
      if (c.playingMismatch) short = "Sync: play/pause";
      else if (c.synced === true) short = "Sync: ✓";
      else if (c.synced === false && c.spreadSec != null) short = `Sync: ~${c.spreadSec.toFixed(1)}s`;
      else if (c.synced === false) short = "Sync: unsynced";
      else short = "Sync: waiting";
      clusterSyncBadge.textContent = short;
      if (c.playingMismatch) {
        clusterSyncBadge.style.background = "rgba(80,20,20,0.9)";
        clusterSyncBadge.style.color = "#ffccc8";
      } else if (c.synced === true) {
        clusterSyncBadge.style.background = "rgba(20,60,40,0.9)";
        clusterSyncBadge.style.color = "#b8f5c8";
      } else if (c.synced === false) {
        clusterSyncBadge.style.background = "rgba(60,50,15,0.9)";
        clusterSyncBadge.style.color = "#ffe08a";
      } else {
        clusterSyncBadge.style.background = "rgba(35,35,40,0.88)";
        clusterSyncBadge.style.color = "#bdbdbd";
      }
    }
    function ingestPositionSnapshot(msg) {
      if (!roomState || msg.roomCode !== roomState.roomCode) return;
      if (msg.roomSyncPolicy && typeof msg.roomSyncPolicy === "object") {
        diag.lastRoomSyncPolicy = { ...msg.roomSyncPolicy, wallMs: msg.wallMs };
        const am = !!msg.roomSyncPolicy.adMode;
        if (am && !diag._wasServerAdMode) {
          platformPlaybackLog("SERVER_AD_MODE_ENTER", {
            reason: msg.roomSyncPolicy.adModeReason,
            startedAt: msg.roomSyncPolicy.adModeStartedAt,
            wallMs: msg.wallMs
          });
        }
        if (!am && diag._wasServerAdMode) {
          platformPlaybackLog("SERVER_AD_MODE_CLEARED", { wallMs: msg.wallMs });
        }
        diag._wasServerAdMode = am;
      }
      diag.clusterSync = evaluateClusterPositionSnapshot(msg);
      if (msg.laggardAnchor?.adModeExit) {
        platformPlaybackLog("SERVER_AD_MODE_EXIT_CORRECTION", {
          spreadSec: msg.laggardAnchor.spreadSec,
          anchorTime: msg.laggardAnchor.anchorTime
        });
      }
      if (msg.laggardAnchor?.applied && diag.clusterSync) {
        const sp = msg.laggardAnchor.spreadSec;
        diag.clusterSync = {
          ...diag.clusterSync,
          label: typeof sp === "number" ? `Cluster: aligned to slowest (was ~${sp.toFixed(1)}s apart)` : "Cluster: aligned to slowest playhead",
          laggardAnchorApplied: true
        };
        platformPlaybackLog("LAGGARD_ANCHOR", {
          spreadSec: msg.laggardAnchor.spreadSec,
          anchorTime: msg.laggardAnchor.anchorTime,
          anchorPlaying: msg.laggardAnchor.anchorPlaying
        });
      }
      diag.extensionOps.positionSnapshotInbound++;
      const c = diag.clusterSync;
      const sidebarKey = c ? `${c.label}|${c.synced}|${c.spreadSec}|${c.playingMismatch}` : "";
      if (sidebarKey !== lastClusterSidebarKey) {
        lastClusterSidebarKey = sidebarKey;
        postSidebar({
          type: "CLUSTER_SYNC",
          synced: c?.synced ?? null,
          spreadSec: c?.spreadSec ?? null,
          playingMismatch: !!c?.playingMismatch,
          label: c?.label || ""
        });
      }
      updateClusterSyncBadge();
      scheduleDiagUpdate();
    }
    function updateVideoUrl() {
      if (roomState?.isHost && video) {
        sendBg({ source: "playshare", type: "SET_ROOM_VIDEO_URL", videoUrl: location.href });
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
    function scheduleDebouncedRemotePlaybackRetry(run) {
      queuedRemotePlaybackApply = run;
      if (remotePlaybackDebounceTimer) return;
      const debounceMs = playbackProfile.applyDebounceMs || 0;
      const delay = Math.max(debounceMs, 40) + 30;
      remotePlaybackDebounceTimer = setTimeout(() => {
        remotePlaybackDebounceTimer = null;
        const fn = queuedRemotePlaybackApply;
        queuedRemotePlaybackApply = null;
        if (typeof fn === "function") fn();
      }, delay);
    }
    function flushLocalPlaybackWireToRoom() {
      playbackOutboundCoalesceTimer = null;
      if (!roomState || syncLock || countdownInProgress) return;
      if (syncDecision.shouldSuppressLocalPlaybackOutbound()) return;
      const v = findVideo() || video;
      if (!v) return;
      lastLocalPlaybackWireAt = Date.now();
      const t = v.currentTime;
      if (v.paused) {
        lastPlaybackOutboundKind = "PAUSE";
        updateVideoUrl();
        syncDiagRecord({ type: "pause_sent", currentTime: t });
        sendBg({ source: "playshare", type: "PAUSE", currentTime: t, sentAt: Date.now() });
        if (roomState.isHost) stopHostPositionHeartbeat();
        stopViewerSyncInterval();
        diagLog("PAUSE", { currentTime: t, source: "local" });
        showToast("⏸ You paused");
      } else {
        lastSentTime = t;
        lastPlaybackOutboundKind = "PLAY";
        updateVideoUrl();
        syncDiagRecord({ type: "play_sent", currentTime: t });
        sendBg({ source: "playshare", type: "PLAY", currentTime: t, sentAt: Date.now() });
        diagLog("PLAY", { currentTime: t, source: "local" });
        showToast("▶ You pressed play");
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
      const forcePause2 = () => {
        if (video && !video.paused) safeVideoOp(() => {
          video.pause();
        });
      };
      const onPlaying = () => {
        forcePause2();
      };
      if (video) video.addEventListener("playing", onPlaying);
      const pauseGuard = setInterval(forcePause2, 150);
      const clearGuard = () => {
        clearInterval(pauseGuard);
        if (video) video.removeEventListener("playing", onPlaying);
      };
      const overlay = document.createElement("div");
      overlay.id = "ws-countdown-overlay";
      overlay.style.cssText = `
      position:fixed;inset:0;z-index:2147483640;display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,0.6);pointer-events:none;contain:layout style paint;
    `;
      const num = document.createElement("div");
      num.style.cssText = `
      font-size:120px;font-weight:800;color:#fff;text-shadow:0 0 40px rgba(78,205,196,0.6);
      font-family:system-ui,sans-serif;animation:wsCountPulse 1s ease;
    `;
      overlay.appendChild(num);
      const style2 = document.createElement("style");
      style2.textContent = `@keyframes wsCountPulse{0%{opacity:0;transform:scale(0.5)}50%{opacity:1;transform:scale(1.2)}100%{opacity:1;transform:scale(1)}}`;
      document.head.appendChild(style2);
      document.body.appendChild(overlay);
      countdownOverlayEl = overlay;
      reparentPlayShareUiForFullscreen();
      let n = COUNTDOWN_SECONDS;
      num.textContent = n;
      const tick = () => {
        n--;
        if (n > 0) {
          num.textContent = n;
          num.style.animation = "none";
          num.offsetHeight;
          num.style.animation = "wsCountPulse 1s ease";
          setTimeout(tick, 1e3);
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
            syncDiagRecord({ type: "play_sent", currentTime: t });
            sendBg({ source: "playshare", type: "PLAY", currentTime: t, sentAt: Date.now() });
            lastPlaybackOutboundKind = "PLAY";
            lastLocalWirePlayingSent = true;
            if (roomState.isHost) startHostPositionHeartbeat();
            safeVideoOp(() => {
              video.play().catch(() => {
              });
            });
            showToast("▶ You pressed play");
          }
        }
      };
      setTimeout(tick, 1e3);
    }
    function onVideoPlay() {
      if (roomState?.isHost) {
        hostTimeupdateSeekSuppressUntil = Date.now() + playbackProfile.hostSeekSuppressAfterPlayMs;
      }
      if (syncLock || !roomState) return;
      if (syncDecision.shouldSuppressLocalPlaybackOutbound()) return;
      if (shouldSuppressPlaybackOutboundEcho(true)) return;
      if (localAdBreakActive) {
        diag.extensionOps.playbackOutboundSuppressedLocalAd++;
        return;
      }
      if (countdownInProgress) return;
      if (waitingForPeerAdInteraction()) {
        syncLock = true;
        safeVideoOp(() => {
          video.pause();
        });
        setTimeout(() => {
          syncLock = false;
        }, 300);
        showToast("Waiting for others to finish their ad…");
        return;
      }
      if (!canControlPlayback()) {
        diag.extensionOps.localControlBlockedHostOnly++;
        showToast("Only the host can control playback");
        if (!playbackProfile.drmPassive) {
          syncLock = true;
          safeVideoOp(() => {
            video.currentTime = lastAppliedState.currentTime;
            if (!lastAppliedState.playing) video.pause();
          });
          setTimeout(() => {
            syncLock = false;
          }, 300);
        } else {
          drmSyncPrompt.offer({
            headline: "Sync to host?",
            detail: `Match the room once instead of starting playback yourself.${drmSyncPromptNetflixNote()}`,
            minIntervalMs: drmSyncPromptMinInterval("host_only"),
            onConfirm: () => {
              if (!hostAuthoritativeRef) return;
              const v = findVideo() || video;
              if (!v) return;
              const now = Date.now();
              const ref = hostAuthoritativeRef;
              const t2 = ref.playing ? ref.currentTime + (now - ref.sentAt) / 1e3 : ref.currentTime;
              diag.extensionOps.drmSyncConfirmed++;
              syncLock = true;
              applyDrmViewerOneShot(v, t2, ref.playing);
              setTimeout(() => {
                syncLock = false;
              }, 600);
            }
          });
        }
        return;
      }
      const t = video.currentTime;
      const coalesceMs = playbackProfile.playbackOutboundCoalesceMs ?? 0;
      if (coalesceMs <= 0) {
        const allowPlayDespiteSameTime = lastPlaybackOutboundKind === "PAUSE" || lastPlaybackOutboundKind === "SEEK";
        if (!allowPlayDespiteSameTime && Math.abs(t - lastSentTime) < 0.3) return;
      }
      if (roomState.isHost && roomState.countdownOnPlay && !playbackProfile.drmPassive) {
        syncLock = true;
        safeVideoOp(() => {
          video.pause();
        });
        requestAnimationFrame(() => safeVideoOp(() => {
          video.pause();
        }));
        setTimeout(() => safeVideoOp(() => {
          video.pause();
        }), 0);
        sendBg({ source: "playshare", type: "COUNTDOWN_START", currentTime: t });
        postSidebar({ type: "COUNTDOWN_START", currentTime: t, fromUsername: roomState?.username });
        showCountdownOverlay(true);
        diagLog("PLAY", { currentTime: t, source: "local", countdown: true });
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
      if (syncDecision.shouldSuppressLocalPlaybackOutbound()) return;
      if (shouldSuppressPlaybackOutboundEcho(false)) return;
      if (localAdBreakActive) {
        diag.extensionOps.playbackOutboundSuppressedLocalAd++;
        return;
      }
      if (!canControlPlayback()) {
        diag.extensionOps.localControlBlockedHostOnly++;
        showToast("Only the host can control playback");
        if (!playbackProfile.drmPassive) {
          syncLock = true;
          safeVideoOp(() => {
            video.currentTime = lastAppliedState.currentTime;
            if (lastAppliedState.playing) video.play().catch(() => {
            });
          });
          setTimeout(() => {
            syncLock = false;
          }, 300);
        } else {
          drmSyncPrompt.offer({
            headline: "Sync to host?",
            detail: `Match the room once instead of pausing yourself.${drmSyncPromptNetflixNote()}`,
            minIntervalMs: drmSyncPromptMinInterval("host_only"),
            onConfirm: () => {
              if (!hostAuthoritativeRef) return;
              const v = findVideo() || video;
              if (!v) return;
              const now = Date.now();
              const ref = hostAuthoritativeRef;
              const t = ref.playing ? ref.currentTime + (now - ref.sentAt) / 1e3 : ref.currentTime;
              diag.extensionOps.drmSyncConfirmed++;
              syncLock = true;
              applyDrmViewerOneShot(v, t, ref.playing);
              setTimeout(() => {
                syncLock = false;
              }, 600);
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
      if (!diagExportAccumulateActive()) return;
      const vb = diag.videoBuffering;
      vb.waiting++;
      vb.lastWaitingAt = Date.now();
      scheduleDiagUpdate();
    }
    function onVideoStalled() {
      if (!diagExportAccumulateActive()) return;
      const vb = diag.videoBuffering;
      vb.stalled++;
      vb.lastStalledAt = Date.now();
      scheduleDiagUpdate();
    }
    function onVideoSeeked() {
      if (!video || !video.isConnected || !document.contains(video) || cachedVideoEl && video !== cachedVideoEl) {
        invalidateVideoCache();
      }
      if (syncLock || !roomState) return;
      if (isPlaybackEchoSuppressed()) return;
      if (syncDecision.shouldSuppressLocalPlaybackOutbound()) return;
      if (localAdBreakActive) {
        diag.extensionOps.playbackOutboundSuppressedLocalAd++;
        return;
      }
      if (waitingForPeerAdInteraction()) {
        syncLock = true;
        safeVideoOp(() => {
          video.currentTime = lastAppliedState.currentTime;
        });
        setTimeout(() => {
          syncLock = false;
        }, 300);
        return;
      }
      if (!canControlPlayback()) {
        diag.extensionOps.localControlBlockedHostOnly++;
        showToast("Only the host can control playback");
        if (!playbackProfile.drmPassive) {
          syncLock = true;
          safeVideoOp(() => {
            video.currentTime = lastAppliedState.currentTime;
          });
          setTimeout(() => {
            syncLock = false;
          }, 300);
        }
        return;
      }
      const t = video.currentTime;
      if (Math.abs(t - lastSentTime) < 0.5) return;
      lastSentTime = t;
      lastPlaybackOutboundKind = "SEEK";
      lastTimeUpdatePos = t;
      updateVideoUrl();
      syncDiagRecord({ type: "seek_sent", currentTime: t });
      sendBg({ source: "playshare", type: "SEEK", currentTime: t, sentAt: Date.now() });
      diagLog("SEEK", { currentTime: t, source: "local" });
      showToast(`⏩ Seeked to ${formatTime(t)}`);
    }
    function onVideoTimeUpdate() {
      if (video && roomState && !syncLock) {
        const nowJ = Date.now();
        if (nowJ - diag._lastTuDiagAt >= 350) {
          const prev2 = diag._lastTuDiagPos;
          const tj = video.currentTime;
          const lastWall = diag._lastTuDiagAt;
          diag._lastTuDiagAt = nowJ;
          const tuJump = playbackProfile.timeJumpThresholdSec ?? TIME_JUMP_THRESHOLD;
          const dtWallSec = typeof lastWall === "number" && lastWall > 0 ? (nowJ - lastWall) / 1e3 : 0;
          const rate = video.playbackRate || 1;
          const expectedAdvance = video.paused ? 0 : dtWallSec * rate;
          const dynamicTuThreshold = Math.max(tuJump, expectedAdvance + 0.5);
          if (diagExportAccumulateActive() && typeof prev2 === "number" && prev2 >= 0 && Math.abs(tj - prev2) > dynamicTuThreshold) {
            diag.timeupdateJumps.unshift({ t: nowJ, from: prev2, to: tj, deltaSec: +(tj - prev2).toFixed(2) });
            if (diag.timeupdateJumps.length > 20) diag.timeupdateJumps.pop();
          }
          diag._lastTuDiagPos = tj;
        }
      }
      if (!video || syncLock || !roomState?.isHost || !canControlPlayback()) return;
      if (localAdBreakActive) return;
      const now = Date.now();
      if (now - lastTimeUpdateCheckAt < 500) return;
      lastTimeUpdateCheckAt = now;
      const t = video.currentTime;
      const prev = lastTimeUpdatePos;
      lastTimeUpdatePos = t;
      if (Date.now() < hostTimeupdateSeekSuppressUntil) return;
      const hostJump = playbackProfile.timeJumpThresholdSec ?? TIME_JUMP_THRESHOLD;
      if (prev >= 0 && Math.abs(t - prev) > hostJump) {
        if (Math.abs(t - lastSentTime) < 0.5) return;
        lastSentTime = t;
        lastPlaybackOutboundKind = "SEEK";
        syncDiagRecord({ type: "seek_sent", currentTime: t, source: "timeupdate" });
        sendBg({ source: "playshare", type: "SEEK", currentTime: t, sentAt: Date.now() });
        diagLog("SEEK", { currentTime: t, source: "internal" });
      }
    }
    function safeVideoOp(fn) {
      try {
        fn();
      } catch (e) {
      }
    }
    function applyDrmViewerOneShot(v, targetTime, wantPlaying) {
      if (!v || v.tagName !== "VIDEO") return;
      armPlaybackEchoSuppress();
      if (playbackProfile.handlerKey === "netflix") {
        platformPlaybackLog("NETFLIX_USER_SYNC_APPLY", { targetTime, wantPlaying });
        applyNetflixDrmViewerOneShot(v, targetTime, wantPlaying);
        if (typeof targetTime === "number" && Number.isFinite(targetTime) && targetTime >= 0) {
          lastTimeUpdatePos = targetTime;
        }
        return;
      }
      platformPlaybackLog("DRM_USER_SYNC_APPLY", { targetTime, wantPlaying });
      safeVideoOp(() => {
        if (typeof targetTime === "number" && !isNaN(targetTime) && targetTime >= 0) {
          v.currentTime = targetTime;
          lastTimeUpdatePos = targetTime;
        }
        if (wantPlaying) v.play().catch(() => {
        });
        else v.pause();
      });
    }
    function dispatchSpaceKey(target) {
      if (!target) return;
      const ev = new KeyboardEvent("keydown", { key: " ", code: "Space", keyCode: 32, which: 32, bubbles: true, view: window });
      target.dispatchEvent(ev);
    }
    function simulateVideoClick(el) {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.dispatchEvent(new MouseEvent("click", { ...opts, bubbles: true, view: window }));
    }
    function forcePlay(v, aggressive) {
      if (!v || v.tagName !== "VIDEO") return;
      const useAggressive = aggressive !== false;
      if (!useAggressive) {
        safeVideoOp(() => {
          v.play().catch(() => {
          });
        });
        return;
      }
      safeVideoOp(() => {
        v.play().catch(() => {
        });
      });
      requestAnimationFrame(() => safeVideoOp(() => {
        v.play().catch(() => {
        });
      }));
      [150, 350, 550].forEach((ms, i) => {
        setTimeout(() => {
          const v2 = findVideo() || v;
          if (!v2 || !v2.paused) return;
          safeVideoOp(() => {
            v2.play().catch(() => {
            });
          });
          simulateVideoClick(v2);
          const playSelectors = [
            ".nf-flat-button.nf-play",
            ".player-play-pause",
            ".player-control-button",
            ".ytp-play-button",
            'button[aria-label="Play"]',
            '[aria-label*="Play"]',
            '[data-title="Play"]',
            ".atvwebplayersdk-playpause-button",
            ".atvwebplayersdk-player-controls button",
            '[class*="play"]'
          ];
          for (const sel of playSelectors) {
            const btn = document.querySelector(sel);
            if (btn && btn.offsetParent !== null) {
              safeVideoOp(() => {
                btn.click();
              });
              break;
            }
          }
          if (v2.paused && siteSync.onStillPausedAfterAggressivePlay) {
            siteSync.onStillPausedAfterAggressivePlay(v2, { dispatchSpaceKey });
          }
        }, ms);
      });
    }
    function forcePause(v, aggressive) {
      if (!v || v.tagName !== "VIDEO") return;
      const useAggressive = aggressive !== false;
      if (!useAggressive) {
        safeVideoOp(() => {
          v.pause();
        });
        return;
      }
      safeVideoOp(() => {
        v.pause();
      });
      requestAnimationFrame(() => safeVideoOp(() => {
        v.pause();
      }));
      [150, 350, 550].forEach((ms) => {
        setTimeout(() => {
          const v2 = findVideo() || v;
          if (!v2 || v2.paused) return;
          safeVideoOp(() => {
            v2.pause();
          });
          simulateVideoClick(v2);
          const pauseSelectors = [
            ".nf-flat-button.nf-pause",
            ".player-play-pause",
            ".player-control-button",
            ".ytp-play-button",
            'button[aria-label="Pause"]',
            '[aria-label*="Pause"]',
            '[data-title="Pause"]',
            ".atvwebplayersdk-playpause-button",
            ".atvwebplayersdk-player-controls button",
            '[class*="pause"]'
          ];
          for (const sel of pauseSelectors) {
            const btn = document.querySelector(sel);
            if (btn && btn.offsetParent !== null) {
              safeVideoOp(() => {
                btn.click();
              });
              break;
            }
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
    function drmSyncPromptMinInterval(kind) {
      const p = playbackProfile;
      const fallbacks = { play: 6e3, pause: 6e3, seek: 6e3, sync_state: 8e3, reconcile: 8e3, host_only: 1e4 };
      const profileKey = kind === "play" ? "drmPromptPlayMinIntervalMs" : kind === "pause" || kind === "seek" ? "drmPromptPauseSeekMinIntervalMs" : kind === "sync_state" ? "drmPromptSyncStateMinIntervalMs" : kind === "reconcile" ? "drmReconcilePromptMinIntervalMs" : null;
      if (profileKey && typeof p[profileKey] === "number" && p[profileKey] > 0) return p[profileKey];
      return fallbacks[kind] ?? 8e3;
    }
    function drmSyncPromptNetflixNote() {
      return playbackProfile.handlerKey === "netflix" ? " Netflix may show error M7375 if extensions automate playback too often — only tap Sync when you want to align." : "";
    }
    function getRemoteApplySyncGate(remoteOpts) {
      if (syncLock) return { ok: false, reason: "sync_lock" };
      if (!remoteOpts?.bypassPlaybackDebounce && playbackProfile.applyDebounceMs > 0 && Date.now() - lastSyncAt < playbackProfile.applyDebounceMs) {
        return { ok: false, reason: "playback_debounce" };
      }
      return { ok: true, reason: null };
    }
    function canApplySync() {
      return getRemoteApplySyncGate().ok;
    }
    function applyPlayWhenReady(v, currentTime, onDone, aggressive) {
      safeVideoOp(() => {
        v.currentTime = currentTime;
        lastTimeUpdatePos = currentTime;
      });
      const doPlay = () => {
        forcePlay(findVideo() || v, aggressive);
        if (onDone) onDone();
      };
      if (v.seeking) {
        let done = false;
        const run = () => {
          if (done) return;
          done = true;
          doPlay();
        };
        const onSeeked = () => {
          v.removeEventListener("seeked", onSeeked);
          clearTimeout(tid);
          run();
        };
        v.addEventListener("seeked", onSeeked, { once: true });
        const tid = setTimeout(() => {
          v.removeEventListener("seeked", onSeeked);
          run();
        }, 3e3);
      } else {
        doPlay();
      }
    }
    function applyPlay(currentTime, fromUsername, fromClientId, sentAt, lastRtt, correlationId, serverTime, remoteOpts) {
      if (!video || isVideoStale(video)) return;
      const gate = getRemoteApplySyncGate(remoteOpts);
      if (!gate.ok) {
        if (gate.reason === "sync_lock") diag.extensionOps.remoteApplyDeniedSyncLock++;
        else if (gate.reason === "playback_debounce") {
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
        diagLog("PLAY", { currentTime, fromUsername, source: "remote", skipped: true, reason: "local_ad" });
        return;
      }
      const recvAt = Date.now();
      if (typeof lastRtt === "number" && lastRtt > 0) {
        maybeSetPlaybackDiagRtt(lastRtt, "playback");
      }
      let targetTime = currentTime;
      if (typeof lastRtt === "number" && lastRtt > 0) {
        targetTime = currentTime + lastRtt / 2 / 1e3;
      } else if (sentAt && typeof sentAt === "number") {
        targetTime = currentTime + (recvAt - sentAt) / 1e3;
      }
      if (!roomState?.isHost) {
        ingestHostAuthoritativeSync(targetTime, true, recvAt);
      }
      if (adHoldBlocksRemotePlayback()) {
        diag.extensionOps.remotePlayHeldForAd++;
        diagLog("PLAY", { currentTime: targetTime, fromUsername, source: "remote", adHold: true });
        return;
      }
      profilerEmitDecision("remote_correction_received", {
        remoteKind: "PLAY",
        driftSec: Math.abs(video.currentTime - targetTime),
        handlerKey: playbackProfile.handlerKey
      });
      {
        const driftSec = Math.abs(video.currentTime - targetTime);
        syncDecision.recordDriftSample(driftSec);
        const dec = syncDecision.shouldApplyRemoteState({
          kind: "PLAY",
          syncKind: "playback_event",
          correctionReason: null,
          driftSec,
          isRedundantWithLocal: !video.paused && driftSec < 2,
          playMatches: !video.paused
        });
        if (!dec.ok) {
          if (dec.reason === "reconnect_settle") diag.extensionOps.syncDecisionRejectedReconnectSettle++;
          else if (dec.reason === "apply_cooldown") diag.extensionOps.syncDecisionRejectedCooldown++;
          else if (dec.reason === "server_ad_mode") diag.extensionOps.syncDecisionRejectedServerAdMode++;
          else if (dec.reason === "already_converging") diag.extensionOps.syncDecisionRejectedConverging++;
          else if (dec.reason === "netflix_safety_noop") diag.extensionOps.syncDecisionNetflixSafetyNoop++;
          platformPlaybackLog("SYNC_DECISION_REJECT", { remoteKind: "PLAY", reason: dec.reason, driftSec });
          if (playbackProfile.handlerKey === "netflix") {
            platformPlaybackLog("NETFLIX_SYNC_SAFETY", { kind: "PLAY", reason: dec.reason, driftSec });
          }
          profilerEmitSyncRejection("PLAY", dec, { driftSec });
          diagLog("PLAY", { currentTime: targetTime, fromUsername, source: "remote", skipped: true, syncDecision: dec.reason });
          return;
        }
      }
      clearRemotePlaybackDebouncedQueue();
      recordDiagTimeline(diag.timing.timeline, {
        kind: "play_recv",
        correlationId: correlationId || null,
        targetTime,
        rttMs: lastRtt,
        serverTime,
        recvAt
      });
      syncDiagRecord({ type: "play_recv", currentTime: targetTime, fromUsername, drift: Math.abs(video.currentTime - targetTime), correlationId });
      lastAppliedState = { currentTime: targetTime, playing: true };
      lastSentTime = targetTime;
      lastPlaybackOutboundKind = "PLAY";
      lastLocalWirePlayingSent = true;
      lastSyncAt = Date.now();
      if (playbackProfile.drmPassive && !roomState?.isHost) {
        diag.extensionOps.drmSyncPromptsShown++;
        platformPlaybackLog("DRM_SYNC_OFFER", { kind: "remote_play", targetTime, fromUsername });
        drmSyncPrompt.offer({
          headline: "Sync to host?",
          detail: `${fromUsername || "Host"} started playback. Tap once to jump to their time and play — avoids DRM playback errors.${drmSyncPromptNetflixNote()}`,
          minIntervalMs: drmSyncPromptMinInterval("play"),
          onConfirm: () => {
            diag.extensionOps.drmSyncConfirmed++;
            const v = findVideo() || video;
            if (!v || isVideoStale(v)) return;
            syncLock = true;
            syncDecision.noteRemoteApply({ serverTime, sentAt });
            applyDrmViewerOneShot(v, targetTime, true);
            postSidebar({ type: "SYNC_QUALITY", drift: Math.abs(v.currentTime - targetTime) });
            setTimeout(() => {
              syncLock = false;
            }, 700);
          }
        });
        startViewerSyncInterval();
        diagLog("PLAY", { currentTime: targetTime, fromUsername, source: "remote", drmPassive: true });
        return;
      }
      syncLock = true;
      if (roomState?.isHost) {
        hostTimeupdateSeekSuppressUntil = Date.now() + playbackProfile.hostSeekSuppressAfterPlayMs;
      }
      const driftBefore = Math.abs(video.currentTime - targetTime);
      const delay = getApplyDelayMs(lastRtt, playbackProfile);
      const playApplyT0 = Date.now();
      const doApply = () => {
        if (isVideoStale(video)) {
          syncLock = false;
          return;
        }
        const v = findVideo() || video;
        if (!v) {
          syncLock = false;
          return;
        }
        profilerEmitRemoteSync("start", { remoteKind: "PLAY", driftSec: driftBefore });
        syncDecision.noteRemoteApply({ serverTime, sentAt });
        armPlaybackEchoSuppress();
        applyPlayWhenReady(v, targetTime, () => {
          postSidebar({ type: "SYNC_QUALITY", drift: driftBefore });
          setTimeout(() => {
            syncLock = false;
          }, 800);
          setTimeout(() => {
            const v2 = findVideo() || v;
            const ok = v2 && !v2.paused;
            const latency = Date.now() - recvAt;
            const driftAfter = v2 ? Math.abs(v2.currentTime - targetTime) : null;
            if (driftAfter != null) maybeUpdateDriftEwm(driftAfter);
            recordDiagTimeline(diag.timing.timeline, {
              kind: ok ? "play_apply_ok" : "play_apply_fail",
              correlationId: correlationId || null,
              driftSec: driftAfter,
              latencyMs: latency
            });
            profilerEmitRemoteSync("end", {
              remoteKind: "PLAY",
              ok,
              durationMs: Date.now() - playApplyT0,
              driftSec: driftAfter
            });
            if (ok) {
              profilerEmitDecision("remote_correction_applied", {
                remoteKind: "PLAY",
                driftSec: driftAfter
              });
            }
            syncDiagRecord({ type: ok ? "play_ok" : "play_fail", currentTime: targetTime, fromUsername, latency, correlationId });
            if (fromClientId) sendDiagApplyResult(fromClientId, "play", ok, latency, correlationId);
          }, 600);
        }, playbackProfile.aggressiveRemoteSync);
      };
      const runWhenReady = () => {
        if (document.hidden) {
          diag.extensionOps.remoteApplyDeferredTabHidden++;
          let done = false;
          const run = () => {
            if (done) return;
            done = true;
            doApply();
          };
          const onVisible = () => {
            document.removeEventListener("visibilitychange", onVisible);
            clearTimeout(tid);
            run();
          };
          document.addEventListener("visibilitychange", onVisible);
          const tid = setTimeout(() => {
            document.removeEventListener("visibilitychange", onVisible);
            run();
          }, 5e3);
        } else {
          doApply();
        }
      };
      setTimeout(runWhenReady, delay);
      if (roomState?.isHost) startHostPositionHeartbeat();
      else startViewerSyncInterval();
      diagLog("PLAY", { currentTime: targetTime, fromUsername, source: "remote" });
    }
    function applyPause(currentTime, fromUsername, fromClientId, lastRtt, correlationId, serverTime, sentAt, remoteOpts) {
      if (!video || isVideoStale(video)) return;
      const gate = getRemoteApplySyncGate(remoteOpts);
      if (!gate.ok) {
        if (gate.reason === "sync_lock") diag.extensionOps.remoteApplyDeniedSyncLock++;
        else if (gate.reason === "playback_debounce") {
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
        diagLog("PAUSE", { currentTime, fromUsername, source: "remote", skipped: true, reason: "local_ad" });
        return;
      }
      const recvAt = Date.now();
      if (!roomState?.isHost) {
        ingestHostAuthoritativeSync(currentTime, false, recvAt);
      }
      if (typeof lastRtt === "number" && lastRtt > 0) {
        maybeSetPlaybackDiagRtt(lastRtt, "playback");
      }
      profilerEmitDecision("remote_correction_received", {
        remoteKind: "PAUSE",
        driftSec: Math.abs(video.currentTime - currentTime),
        handlerKey: playbackProfile.handlerKey
      });
      {
        const driftSec = Math.abs(video.currentTime - currentTime);
        syncDecision.recordDriftSample(driftSec);
        const dec = syncDecision.shouldApplyRemoteState({
          kind: "PAUSE",
          syncKind: "playback_event",
          correctionReason: null,
          driftSec,
          isRedundantWithLocal: video.paused && driftSec < 2,
          playMatches: video.paused
        });
        if (!dec.ok) {
          if (dec.reason === "reconnect_settle") diag.extensionOps.syncDecisionRejectedReconnectSettle++;
          else if (dec.reason === "apply_cooldown") diag.extensionOps.syncDecisionRejectedCooldown++;
          else if (dec.reason === "server_ad_mode") diag.extensionOps.syncDecisionRejectedServerAdMode++;
          else if (dec.reason === "already_converging") diag.extensionOps.syncDecisionRejectedConverging++;
          else if (dec.reason === "netflix_safety_noop") diag.extensionOps.syncDecisionNetflixSafetyNoop++;
          platformPlaybackLog("SYNC_DECISION_REJECT", { remoteKind: "PAUSE", reason: dec.reason, driftSec });
          if (playbackProfile.handlerKey === "netflix") {
            platformPlaybackLog("NETFLIX_SYNC_SAFETY", { kind: "PAUSE", reason: dec.reason, driftSec });
          }
          profilerEmitSyncRejection("PAUSE", dec, { driftSec });
          diagLog("PAUSE", { currentTime, fromUsername, source: "remote", skipped: true, syncDecision: dec.reason });
          return;
        }
      }
      clearRemotePlaybackDebouncedQueue();
      recordDiagTimeline(diag.timing.timeline, { kind: "pause_recv", correlationId: correlationId || null, currentTime, serverTime, recvAt, rttMs: lastRtt });
      syncDiagRecord({ type: "pause_recv", currentTime, fromUsername, drift: Math.abs(video.currentTime - currentTime), correlationId });
      lastAppliedState = { currentTime, playing: false };
      lastSentTime = currentTime;
      lastPlaybackOutboundKind = "PAUSE";
      lastLocalWirePlayingSent = false;
      lastSyncAt = Date.now();
      if (playbackProfile.drmPassive && !roomState?.isHost) {
        stopViewerSyncInterval();
        diag.extensionOps.drmSyncPromptsShown++;
        platformPlaybackLog("DRM_SYNC_OFFER", { kind: "remote_pause", currentTime, fromUsername });
        drmSyncPrompt.offer({
          headline: "Sync to host?",
          detail: `${fromUsername || "Host"} paused. Tap once to align and pause — avoids DRM playback errors.${drmSyncPromptNetflixNote()}`,
          minIntervalMs: drmSyncPromptMinInterval("pause"),
          onConfirm: () => {
            diag.extensionOps.drmSyncConfirmed++;
            const v = findVideo() || video;
            if (!v || isVideoStale(v)) return;
            syncLock = true;
            syncDecision.noteRemoteApply({ serverTime, sentAt });
            applyDrmViewerOneShot(v, currentTime, false);
            postSidebar({ type: "SYNC_QUALITY", drift: Math.abs(v.currentTime - currentTime) });
            setTimeout(() => {
              syncLock = false;
            }, 600);
          }
        });
        diagLog("PAUSE", { currentTime, fromUsername, source: "remote", drmPassive: true });
        return;
      }
      syncLock = true;
      const driftBefore = Math.abs(video.currentTime - currentTime);
      const delay = getApplyDelayMs(lastRtt, playbackProfile);
      const pauseApplyT0 = Date.now();
      const doApply = () => {
        if (isVideoStale(video)) {
          syncLock = false;
          return;
        }
        const v = findVideo() || video;
        if (!v) {
          syncLock = false;
          return;
        }
        profilerEmitRemoteSync("start", { remoteKind: "PAUSE", driftSec: driftBefore });
        syncDecision.noteRemoteApply({ serverTime, sentAt });
        armPlaybackEchoSuppress();
        armPauseSeekAutoplayPlaySuppress();
        safeVideoOp(() => {
          v.currentTime = currentTime;
          lastTimeUpdatePos = currentTime;
          forcePause(v, playbackProfile.aggressiveRemoteSync);
        });
        postSidebar({ type: "SYNC_QUALITY", drift: driftBefore });
        setTimeout(() => {
          syncLock = false;
        }, 500);
        setTimeout(() => {
          const v2 = findVideo() || v;
          const ok = v2 && v2.paused;
          const latency = Date.now() - recvAt;
          const driftAfter = v2 ? Math.abs(v2.currentTime - currentTime) : null;
          if (driftAfter != null) maybeUpdateDriftEwm(driftAfter);
          recordDiagTimeline(diag.timing.timeline, {
            kind: ok ? "pause_apply_ok" : "pause_apply_fail",
            correlationId: correlationId || null,
            driftSec: driftAfter,
            latencyMs: latency
          });
          profilerEmitRemoteSync("end", {
            remoteKind: "PAUSE",
            ok,
            durationMs: Date.now() - pauseApplyT0,
            driftSec: driftAfter
          });
          if (ok) {
            profilerEmitDecision("remote_correction_applied", {
              remoteKind: "PAUSE",
              driftSec: driftAfter
            });
          }
          syncDiagRecord({ type: ok ? "pause_ok" : "pause_fail", currentTime, fromUsername, latency, correlationId });
          if (fromClientId) sendDiagApplyResult(fromClientId, "pause", ok, latency, correlationId);
        }, 600);
      };
      const runWhenReady = () => {
        if (document.hidden) {
          diag.extensionOps.remoteApplyDeferredTabHidden++;
          let done = false;
          const run = () => {
            if (done) return;
            done = true;
            doApply();
          };
          const onVisible = () => {
            document.removeEventListener("visibilitychange", onVisible);
            clearTimeout(tid);
            run();
          };
          document.addEventListener("visibilitychange", onVisible);
          const tid = setTimeout(() => {
            document.removeEventListener("visibilitychange", onVisible);
            run();
          }, 5e3);
        } else {
          doApply();
        }
      };
      setTimeout(runWhenReady, delay);
      if (roomState?.isHost) stopHostPositionHeartbeat();
      stopViewerSyncInterval();
      diagLog("PAUSE", { currentTime, fromUsername, source: "remote" });
    }
    function applySeek(currentTime, fromUsername, fromClientId, lastRtt, correlationId, serverTime, remoteOpts) {
      if (!video || isVideoStale(video)) return;
      const gate = getRemoteApplySyncGate(remoteOpts);
      if (!gate.ok) {
        if (gate.reason === "sync_lock") diag.extensionOps.remoteApplyDeniedSyncLock++;
        else if (gate.reason === "playback_debounce") {
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
        diagLog("SEEK", { currentTime, fromUsername, source: "remote", skipped: true, reason: "local_ad" });
        return;
      }
      const vPre = findVideo() || video;
      if (syncDecision.shouldSkipSeekWhileVideoSeeking(vPre)) {
        diag.extensionOps.remoteSeekSuppressedVideoSeeking++;
        diagLog("SEEK", { currentTime, fromUsername, source: "remote", skipped: true, reason: "video_seeking" });
        return;
      }
      const deltaSeek = vPre && !isVideoStale(vPre) ? vPre.currentTime - currentTime : 0;
      const seekDec = syncDecision.shouldApplyRemoteSeek(deltaSeek);
      if (!seekDec.ok) {
        diag.extensionOps.remoteSeekSuppressedDecision++;
        if (playbackProfile.handlerKey === "netflix") {
          platformPlaybackLog("NETFLIX_SYNC_SAFETY", { kind: "SEEK", reason: seekDec.reason, deltaSeek });
        }
        profilerEmitDecision("remote_correction_rejected", {
          remoteKind: "SEEK",
          reason: seekDec.reason,
          deltaSeek
        });
        diagLog("SEEK", { currentTime, fromUsername, source: "remote", skipped: true, reason: seekDec.reason });
        return;
      }
      const recvAt = Date.now();
      if (typeof lastRtt === "number" && lastRtt > 0) {
        maybeSetPlaybackDiagRtt(lastRtt, "playback");
      }
      profilerEmitDecision("remote_correction_received", {
        remoteKind: "SEEK",
        driftSec: Math.abs(video.currentTime - currentTime),
        handlerKey: playbackProfile.handlerKey
      });
      recordDiagTimeline(diag.timing.timeline, { kind: "seek_recv", correlationId: correlationId || null, currentTime, serverTime, recvAt, rttMs: lastRtt });
      syncDiagRecord({ type: "seek_recv", currentTime, fromUsername, drift: Math.abs(video.currentTime - currentTime), correlationId });
      if (!roomState?.isHost) {
        ingestHostAuthoritativeSync(currentTime, lastAppliedState.playing, recvAt);
      }
      if (adHoldBlocksRemotePlayback()) {
        diag.extensionOps.remoteSeekHeldForAd++;
        diagLog("SEEK", { currentTime, fromUsername, source: "remote", adHold: true });
        return;
      }
      clearRemotePlaybackDebouncedQueue();
      lastAppliedState = { ...lastAppliedState, currentTime };
      lastSyncAt = Date.now();
      lastSentTime = currentTime;
      lastPlaybackOutboundKind = "SEEK";
      const driftBefore = Math.abs(video.currentTime - currentTime);
      syncDecision.recordDriftSample(driftBefore);
      {
        const decSt = syncDecision.shouldApplyRemoteState({
          kind: "SEEK",
          syncKind: "playback_event",
          correctionReason: null,
          driftSec: driftBefore,
          playMatches: !!lastAppliedState.playing === !video.paused
        });
        if (!decSt.ok) {
          if (decSt.reason === "reconnect_settle") diag.extensionOps.syncDecisionRejectedReconnectSettle++;
          else if (decSt.reason === "apply_cooldown") diag.extensionOps.syncDecisionRejectedCooldown++;
          else if (decSt.reason === "server_ad_mode") diag.extensionOps.syncDecisionRejectedServerAdMode++;
          else if (decSt.reason === "already_converging") diag.extensionOps.syncDecisionRejectedConverging++;
          else if (decSt.reason === "netflix_safety_noop") diag.extensionOps.syncDecisionNetflixSafetyNoop++;
          platformPlaybackLog("SYNC_DECISION_REJECT", { remoteKind: "SEEK", reason: decSt.reason, driftSec: driftBefore });
          if (playbackProfile.handlerKey === "netflix") {
            platformPlaybackLog("NETFLIX_SYNC_SAFETY", { kind: "SEEK", reason: decSt.reason, driftSec: driftBefore });
          }
          profilerEmitSyncRejection("SEEK", decSt, { driftSec: driftBefore });
          diagLog("SEEK", { currentTime, fromUsername, source: "remote", skipped: true, syncDecision: decSt.reason });
          return;
        }
      }
      if (playbackProfile.drmPassive && !roomState?.isHost) {
        if (driftBefore <= playbackProfile.drmDesyncThresholdSec) {
          diag.extensionOps.drmSeekSkippedUnderThreshold++;
          platformPlaybackLog("DRM_SEEK_SKIPPED", { driftSec: driftBefore, threshold: playbackProfile.drmDesyncThresholdSec });
          syncDiagRecord({ type: "seek_ok", currentTime, fromUsername, latency: 0, correlationId, note: "drm_skip_small_drift" });
          diagLog("SEEK", { currentTime, fromUsername, source: "remote", drmPassive: true, skipped: true });
          return;
        }
        diag.extensionOps.drmSyncPromptsShown++;
        const wantPlaying = lastAppliedState.playing;
        platformPlaybackLog("DRM_SYNC_OFFER", { kind: "remote_seek", currentTime, driftBefore, fromUsername });
        drmSyncPrompt.offer({
          headline: "Sync to host?",
          detail: `${fromUsername || "Host"} jumped ~${driftBefore.toFixed(1)}s. Tap once to seek — avoids DRM playback errors.${drmSyncPromptNetflixNote()}`,
          minIntervalMs: drmSyncPromptMinInterval("seek"),
          onConfirm: () => {
            diag.extensionOps.drmSyncConfirmed++;
            const v = findVideo() || video;
            if (!v || isVideoStale(v)) return;
            syncLock = true;
            syncDecision.noteRemoteApply({ serverTime });
            syncDecision.recordRemoteSeekCommitted();
            applyDrmViewerOneShot(v, currentTime, wantPlaying);
            postSidebar({ type: "SYNC_QUALITY", drift: driftBefore });
            setTimeout(() => {
              syncLock = false;
            }, 600);
          }
        });
        diagLog("SEEK", { currentTime, fromUsername, source: "remote", drmPassive: true });
        return;
      }
      syncLock = true;
      const delay = getApplyDelayMs(lastRtt, playbackProfile);
      const seekApplyT0 = Date.now();
      const doApply = () => {
        if (isVideoStale(video)) {
          syncLock = false;
          return;
        }
        const v = findVideo() || video;
        profilerEmitRemoteSync("start", { remoteKind: "SEEK", driftSec: driftBefore });
        syncDecision.noteRemoteApply({ serverTime });
        if (v) {
          armPlaybackEchoSuppress();
          safeVideoOp(() => {
            v.currentTime = currentTime;
          });
          lastTimeUpdatePos = currentTime;
          syncDecision.recordRemoteSeekCommitted();
        }
        postSidebar({ type: "SYNC_QUALITY", drift: driftBefore });
        setTimeout(() => {
          syncLock = false;
        }, 500);
        setTimeout(() => {
          const v2 = findVideo() || video;
          const ok = v2 && Math.abs(v2.currentTime - currentTime) < 1;
          const latency = Date.now() - recvAt;
          const driftAfter = v2 ? Math.abs(v2.currentTime - currentTime) : null;
          if (driftAfter != null) maybeUpdateDriftEwm(driftAfter);
          recordDiagTimeline(diag.timing.timeline, {
            kind: ok ? "seek_apply_ok" : "seek_apply_fail",
            correlationId: correlationId || null,
            driftSec: driftAfter,
            latencyMs: latency
          });
          profilerEmitRemoteSync("end", {
            remoteKind: "SEEK",
            ok,
            durationMs: Date.now() - seekApplyT0,
            driftSec: driftAfter
          });
          if (ok) {
            profilerEmitDecision("remote_correction_applied", {
              remoteKind: "SEEK",
              driftSec: driftAfter
            });
          }
          syncDiagRecord({ type: ok ? "seek_ok" : "seek_fail", currentTime, fromUsername, latency, correlationId });
          if (fromClientId) sendDiagApplyResult(fromClientId, "seek", ok, latency, correlationId);
        }, 400);
      };
      const runWhenReady = () => {
        if (document.hidden) {
          diag.extensionOps.remoteApplyDeferredTabHidden++;
          let done = false;
          const run = () => {
            if (done) return;
            done = true;
            doApply();
          };
          const onVisible = () => {
            document.removeEventListener("visibilitychange", onVisible);
            clearTimeout(tid);
            run();
          };
          document.addEventListener("visibilitychange", onVisible);
          const tid = setTimeout(() => {
            document.removeEventListener("visibilitychange", onVisible);
            run();
          }, 5e3);
        } else {
          doApply();
        }
      };
      setTimeout(runWhenReady, delay);
      diagLog("SEEK", { currentTime, fromUsername, source: "remote" });
    }
    function isOwnPlaybackSystemMsg(text) {
      const u = roomState?.username;
      if (!u || !text) return false;
      return text === `▶ ${u} pressed play` || text === `⏸ ${u} paused` || text.startsWith(`⏩ ${u} seeked to `) || text.startsWith(`📺 ${u}`) || text.startsWith(`✓ ${u}'s ad break ended`);
    }
    function applySyncState(state) {
      if (!state) return;
      const syncKind = state.syncKind === "soft" ? "soft" : "hard";
      if (localAdBreakActive) {
        diag.extensionOps.syncStateIgnoredLocalAd++;
        return;
      }
      profilerEmitDecision("remote_correction_received", {
        remoteKind: "SYNC_STATE",
        syncKind,
        correctionReason: state.correctionReason != null ? String(state.correctionReason).slice(0, 64) : null,
        handlerKey: playbackProfile.handlerKey
      });
      const refMs = state.sentAt != null ? state.sentAt : state.computedAt;
      const viewerSyncBaseTime = Date.now();
      const lrSync = typeof diag.timing.lastRttMs === "number" && diag.timing.lastRttMs > 0 ? diag.timing.lastRttMs : null;
      let targetTime = state.currentTime;
      if (state.playing) {
        if (lrSync != null) {
          targetTime = state.currentTime + lrSync / 2 / 1e3;
        } else if (refMs != null) {
          targetTime = state.currentTime + (viewerSyncBaseTime - refMs) / 1e3;
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
        if (syncGate.reason === "sync_lock") diag.extensionOps.syncStateDeniedSyncLock++;
        else if (syncGate.reason === "playback_debounce") diag.extensionOps.syncStateDeniedPlaybackDebounce++;
        return;
      }
      const localPlayingPre = !video.paused;
      const playMismatchPre = state.playing !== localPlayingPre;
      {
        const driftPre = Math.abs(video.currentTime - targetTime);
        syncDecision.recordDriftSample(driftPre);
        const syncDec = syncDecision.shouldApplyRemoteState({
          kind: "SYNC_STATE",
          syncKind,
          correctionReason: state.correctionReason,
          driftSec: driftPre,
          fromRoomJoin: state.correctionReason === syncDecision.CORRECTION_REASONS.JOIN,
          playMatches: !playMismatchPre,
          hostAnchorSoft: state.correctionReason === syncDecision.CORRECTION_REASONS.HOST_ANCHOR_SOFT
        });
        if (!syncDec.ok) {
          if (syncDec.reason === "reconnect_settle") diag.extensionOps.syncDecisionRejectedReconnectSettle++;
          else if (syncDec.reason === "apply_cooldown") diag.extensionOps.syncDecisionRejectedCooldown++;
          else if (syncDec.reason === "server_ad_mode") diag.extensionOps.syncDecisionRejectedServerAdMode++;
          else if (syncDec.reason === "already_converging") diag.extensionOps.syncDecisionRejectedConverging++;
          else if (syncDec.reason === "netflix_safety_noop") diag.extensionOps.syncDecisionNetflixSafetyNoop++;
          platformPlaybackLog("SYNC_DECISION_REJECT", {
            remoteKind: "SYNC_STATE",
            reason: syncDec.reason,
            syncKind,
            correctionReason: state.correctionReason,
            driftSec: driftPre
          });
          if (playbackProfile.handlerKey === "netflix") {
            platformPlaybackLog("NETFLIX_SYNC_SAFETY", { kind: "SYNC_STATE", reason: syncDec.reason, driftSec: driftPre });
          }
          profilerEmitSyncRejection("SYNC_STATE", syncDec, {
            driftSec: driftPre,
            syncKind,
            correctionReason: state.correctionReason
          });
          diagLog("SYNC_STATE", {
            playing: state.playing,
            currentTime: targetTime,
            skipped: true,
            syncDecision: syncDec.reason
          });
          return;
        }
      }
      if (syncDecision.isHardPriorityRemote({
        syncKind,
        correctionReason: state.correctionReason,
        fromRoomJoin: state.correctionReason === syncDecision.CORRECTION_REASONS.JOIN
      })) {
        platformPlaybackLog("SYNC_DECISION_ALLOW", {
          kind: "SYNC_STATE",
          syncKind,
          correctionReason: state.correctionReason
        });
      }
      const localPlaying = localPlayingPre;
      const playMismatch = playMismatchPre;
      if (playbackProfile.drmPassive && !roomState?.isHost && syncKind === "soft") {
        lastAppliedState = { currentTime: targetTime, playing: !!state.playing };
        lastSentTime = targetTime;
        lastPlaybackOutboundKind = state.playing ? "PLAY" : "PAUSE";
        lastLocalWirePlayingSent = !!state.playing;
        lastSyncAt = Date.now();
        syncDecision.noteRemoteApply({ sentAt: state.sentAt ?? state.computedAt, serverTime: state.sentAt });
        if (state.playing) startViewerSyncInterval();
        else stopViewerSyncInterval();
        const driftW = Math.abs(video.currentTime - targetTime);
        maybeUpdateDriftEwm(driftW);
        postSidebar({ type: "SYNC_QUALITY", drift: driftW });
        diag.extensionOps.syncStateApplied++;
        profilerEmitDecision("remote_correction_applied", {
          remoteKind: "SYNC_STATE",
          syncKind,
          correctionReason: state.correctionReason,
          driftSec: driftW,
          note: "soft_ref_only"
        });
        diagLog("SYNC_STATE", {
          playing: state.playing,
          currentTime: targetTime,
          computedAt: state.computedAt,
          sentAt: state.sentAt,
          drmPassive: true,
          note: "soft_ref_only"
        });
        return;
      }
      lastAppliedState = { currentTime: targetTime, playing: !!state.playing };
      lastSentTime = targetTime;
      lastPlaybackOutboundKind = state.playing ? "PLAY" : "PAUSE";
      lastLocalWirePlayingSent = !!state.playing;
      if (roomState?.isHost && state.playing) {
        hostTimeupdateSeekSuppressUntil = Date.now() + playbackProfile.hostSeekSuppressAfterPlayMs;
      }
      lastSyncAt = Date.now();
      const threshold = getSyncThreshold();
      const effectiveSyncThreshold = syncKind === "soft" ? Math.max(threshold, 3.5) : threshold;
      const driftBefore = Math.abs(video.currentTime - targetTime);
      if (!playbackProfile.drmPassive && !roomState?.isHost && !playMismatch && driftBefore <= effectiveSyncThreshold) {
        if (state.playing) startViewerSyncInterval();
        else stopViewerSyncInterval();
        maybeUpdateDriftEwm(driftBefore);
        postSidebar({ type: "SYNC_QUALITY", drift: driftBefore });
        diag.extensionOps.syncStateSkippedRedundant++;
        profilerEmitDecision("no_op_selected", {
          remoteKind: "SYNC_STATE",
          syncKind,
          reason: "skip_redundant",
          driftSec: driftBefore
        });
        diagLog("SYNC_STATE", {
          playing: state.playing,
          currentTime: targetTime,
          computedAt: state.computedAt,
          sentAt: state.sentAt,
          note: "skip_redundant"
        });
        return;
      }
      if (playbackProfile.drmPassive && !roomState?.isHost) {
        if (!playMismatch && driftBefore <= effectiveSyncThreshold) {
          if (state.playing) startViewerSyncInterval();
          else stopViewerSyncInterval();
          maybeUpdateDriftEwm(driftBefore);
          recordDiagTimeline(diag.timing.timeline, {
            kind: "sync_state_passive_ok",
            computedAt: state.computedAt ?? null,
            sentAt: state.sentAt ?? null,
            targetTime,
            playing: !!state.playing,
            driftBefore
          });
          postSidebar({ type: "SYNC_QUALITY", drift: driftBefore });
          diagLog("SYNC_STATE", { playing: state.playing, currentTime: targetTime, computedAt: state.computedAt, sentAt: state.sentAt, drmPassive: true, note: "within_threshold" });
          diag.extensionOps.syncStateApplied++;
          profilerEmitDecision("no_op_selected", {
            remoteKind: "SYNC_STATE",
            syncKind,
            reason: "within_threshold_drm",
            driftSec: driftBefore
          });
          return;
        }
        diag.extensionOps.drmSyncPromptsShown++;
        platformPlaybackLog("DRM_SYNC_OFFER", { kind: "sync_state", driftBefore, playMismatch });
        drmSyncPrompt.offer({
          headline: "Sync to host?",
          detail: (playMismatch ? "Play/pause does not match the room. Tap once to align (avoids DRM errors)." : `About ${driftBefore.toFixed(1)}s off.`) + drmSyncPromptNetflixNote(),
          minIntervalMs: drmSyncPromptMinInterval("sync_state"),
          onConfirm: () => {
            diag.extensionOps.drmSyncConfirmed++;
            const v = findVideo() || video;
            if (!v || isVideoStale(v)) return;
            const applyNow = Date.now();
            const applyTarget = state.playing ? targetTime + (applyNow - viewerSyncBaseTime) / 1e3 : state.currentTime;
            syncLock = true;
            syncDecision.noteRemoteApply({ sentAt: state.sentAt ?? state.computedAt, serverTime: state.sentAt });
            applyDrmViewerOneShot(v, applyTarget, !!state.playing);
            lastAppliedState = { currentTime: applyTarget, playing: !!state.playing };
            lastLocalWirePlayingSent = !!state.playing;
            if (state.playing) startViewerSyncInterval();
            else stopViewerSyncInterval();
            const postDrift = Math.abs(v.currentTime - applyTarget);
            maybeUpdateDriftEwm(postDrift);
            recordDiagTimeline(diag.timing.timeline, {
              kind: "sync_state_applied",
              computedAt: state.computedAt ?? null,
              sentAt: state.sentAt ?? null,
              applyTarget,
              playing: !!state.playing,
              driftBefore,
              postDrift,
              drmUserConfirm: true
            });
            postSidebar({ type: "SYNC_QUALITY", drift: driftBefore });
            diagLog("SYNC_STATE", { playing: state.playing, currentTime: applyTarget, computedAt: state.computedAt, sentAt: state.sentAt, drmUserConfirm: true });
            diag.extensionOps.syncStateApplied++;
            setTimeout(() => {
              syncLock = false;
            }, 700);
          }
        });
        diagLog("SYNC_STATE", { playing: state.playing, currentTime: targetTime, computedAt: state.computedAt, sentAt: state.sentAt, drmPassive: true, offered: true });
        return;
      }
      syncLock = true;
      const delay = playbackProfile.syncStateApplyDelayMs;
      const syncStateApplyT0 = Date.now();
      profilerEmitRemoteSync("start", {
        remoteKind: "SYNC_STATE",
        syncKind,
        correctionReason: state.correctionReason,
        driftSec: driftBefore
      });
      setTimeout(() => {
        if (isVideoStale(video)) {
          syncLock = false;
          profilerEmitRemoteSync("end", {
            remoteKind: "SYNC_STATE",
            ok: false,
            durationMs: Date.now() - syncStateApplyT0,
            reason: "stale_video"
          });
          return;
        }
        const v = findVideo() || video;
        if (!v) {
          syncLock = false;
          profilerEmitRemoteSync("end", {
            remoteKind: "SYNC_STATE",
            ok: false,
            durationMs: Date.now() - syncStateApplyT0,
            reason: "no_video"
          });
          return;
        }
        syncDecision.noteRemoteApply({ sentAt: state.sentAt ?? state.computedAt, serverTime: state.sentAt });
        armPlaybackEchoSuppress();
        const applyNow = Date.now();
        const applyTarget = state.playing ? targetTime + (applyNow - viewerSyncBaseTime) / 1e3 : state.currentTime;
        safeVideoOp(() => {
          const diff = Math.abs(v.currentTime - applyTarget);
          let didSeek = false;
          if (diff > effectiveSyncThreshold) {
            v.currentTime = applyTarget;
            lastTimeUpdatePos = applyTarget;
            didSeek = true;
          }
          lastAppliedState = { currentTime: applyTarget, playing: !!state.playing };
          lastLocalWirePlayingSent = !!state.playing;
          if (!state.playing && didSeek) armPauseSeekAutoplayPlaySuppress();
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
        maybeUpdateDriftEwm(postDrift);
        recordDiagTimeline(diag.timing.timeline, {
          kind: "sync_state_applied",
          computedAt: state.computedAt ?? null,
          sentAt: state.sentAt ?? null,
          applyTarget,
          playing: !!state.playing,
          driftBefore,
          postDrift
        });
        postSidebar({ type: "SYNC_QUALITY", drift: driftBefore });
        diagLog("SYNC_STATE", { playing: state.playing, currentTime: applyTarget, computedAt: state.computedAt, sentAt: state.sentAt });
        diag.extensionOps.syncStateApplied++;
        profilerEmitRemoteSync("end", {
          remoteKind: "SYNC_STATE",
          ok: true,
          durationMs: Date.now() - syncStateApplyT0,
          driftSec: postDrift
        });
        profilerEmitDecision("remote_correction_applied", {
          remoteKind: "SYNC_STATE",
          syncKind,
          correctionReason: state.correctionReason,
          driftSec: postDrift
        });
        setTimeout(() => {
          syncLock = false;
        }, 600);
      }, delay);
    }
    function sendBg(msg) {
      try {
        if (msg && msg.source === "playshare") {
          if (msg.type === "SYNC_REQUEST") diag.extensionOps.viewerSyncRequestSent++;
          else if (msg.type === "PLAYBACK_POSITION") diag.extensionOps.hostPlaybackPositionSent++;
          else if (msg.type === "POSITION_REPORT") diag.extensionOps.positionReportSent++;
        }
        chrome.runtime.sendMessage(msg, () => {
          const le = chrome.runtime.lastError;
          if (le) {
            diag.messaging.runtimeSendFailures++;
            diag.messaging.runtimeLastErrorAt = Date.now();
            diag.messaging.runtimeLastErrorMessage = le.message || "unknown";
            scheduleDiagUpdate();
          }
        });
      } catch {
        diag.messaging.sendThrowCount++;
      }
    }
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.source === "playshare-bg") {
        if (msg.type === "COMMAND_MANUAL_AD_START") {
          applyManualAdBreakStart(!!msg.viaShortcut);
          return;
        }
        if (msg.type === "COMMAND_MANUAL_AD_END") {
          applyManualAdBreakEnd(!!msg.viaShortcut);
          return;
        }
      }
      if (msg.source !== "playshare-bg") return;
      switch (msg.type) {
        case "ROOM_CREATED":
        case "ROOM_JOINED": {
          const reconnectResync = !!msg.reconnectResync;
          roomState = { ...msg };
          delete roomState.reconnectResync;
          diag.connectionStatus = "connected";
          if (diag.reportSession.roomCode !== msg.roomCode) {
            diag.reportSession = { startedAt: Date.now(), roomCode: msg.roomCode };
          }
          recordMemberChronology("room_session", {
            roomCode: msg.roomCode,
            memberCount: (msg.members || []).length,
            isHost: !!msg.isHost
          });
          diagLog("ROOM_JOINED", { roomCode: msg.roomCode, members: (msg.members || []).length });
          if (msg.isHost && video && !isVideoStale(video)) {
            roomState.videoUrl = location.href;
            sendBg({ source: "playshare", type: "SET_ROOM_VIDEO_URL", videoUrl: location.href });
          }
          const finalizeRoomJoined = () => {
            syncDecision.resetSession();
            if (reconnectResync) {
              syncDecision.beginReconnectSettle(5e3);
              platformPlaybackLog("CLIENT_RECONNECT_SETTLE", { ms: 5e3 });
            }
            lastLocalPlaybackWireAt = 0;
            lastLocalWirePlayingSent = null;
            clearPlaybackOutboundCoalesce();
            clearRemotePlaybackDebouncedQueue();
            showSidebarToggle();
            openSidebar();
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
                  sendBg({ source: "playshare", type: "PLAYBACK_POSITION", currentTime: video.currentTime });
                }, Math.min(syncDelay, 120));
              } else if (!msg.isHost) {
                setTimeout(() => sendBg({ source: "playshare", type: "SYNC_REQUEST" }), syncDelay);
              }
            } else if (!msg.isHost) {
              setTimeout(() => sendBg({ source: "playshare", type: "SYNC_REQUEST" }), syncDelay);
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
            chrome.storage.local.get(["playshareCountdownOnPlay"], (r) => {
              if (roomState && roomState.roomCode === msg.roomCode && typeof r.playshareCountdownOnPlay === "boolean") {
                roomState.countdownOnPlay = r.playshareCountdownOnPlay;
                sendBg({
                  source: "playshare",
                  type: "UPDATE_COUNTDOWN_ON_PLAY",
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
        case "ROOM_LEFT": {
          syncDecision.resetSession();
          stopPeerRecordingSampleLoop();
          const leavingCollectorId = roomState?.clientId;
          if (diagnosticsUiEnabled && leavingCollectorId && getVideoProfiler().isRecording()) {
            try {
              sendBg({
                source: "playshare",
                type: "DIAG_PROFILER_COLLECTION",
                active: false,
                collectorClientId: leavingCollectorId
              });
            } catch {
            }
          }
          diag.profilerPeerCollection.remoteCollectorClientId = null;
          roomState = null;
          suppressPlaybackEchoUntil = 0;
          suppressOutboundPlayWhileRoomPausedUntil = 0;
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
          diag.lastRoomSyncPolicy = null;
          diag._wasServerAdMode = false;
          lastClusterSidebarKey = null;
          hideClusterSyncBadge();
          diagLog("ROOM_LEFT", {});
          hideSidebarToggle();
          closeSidebar();
          break;
        }
        case "MEMBER_JOINED":
          recordMemberChronology("member_joined", { username: msg.username, clientIdShort: msg.clientId ? String(msg.clientId).slice(0, 8) + "…" : null });
          diagLog("MEMBER_JOINED", { username: msg.username });
          if (roomState && Array.isArray(msg.members)) roomState.members = msg.members;
          postSidebar({ type: "MEMBER_JOINED", data: msg });
          showToast(`👋 ${msg.username} joined`);
          if (diagnosticsUiEnabled && getVideoProfiler().isRecording()) {
            broadcastProfilerCollectionState(true);
          }
          break;
        case "MEMBER_LEFT":
          recordMemberChronology("member_left", { username: msg.username });
          diagLog("MEMBER_LEFT", { username: msg.username });
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
          postSidebar({ type: "MEMBER_LEFT", data: msg });
          showToast(`👋 ${msg.username} left`);
          if (msg.clientId && diag.profilerPeerCollection.remoteCollectorClientId === msg.clientId) {
            diag.profilerPeerCollection.remoteCollectorClientId = null;
            stopPeerRecordingSampleLoop();
          }
          break;
        case "PLAY":
          applyPlay(msg.currentTime, msg.fromUsername, msg.fromClientId, msg.sentAt, msg.lastRtt, msg.correlationId, msg.serverTime);
          break;
        case "PAUSE":
          applyPause(msg.currentTime, msg.fromUsername, msg.fromClientId, msg.lastRtt, msg.correlationId, msg.serverTime, msg.sentAt);
          break;
        case "sync":
          if (roomState && !roomState.isHost && !localAdBreakActive && syncDecision.shouldAcceptRoomSyncTick(msg) && typeof msg.currentTime === "number" && Number.isFinite(msg.currentTime) && (msg.state === "playing" || msg.state === "paused")) {
            const syncIngestAt = Date.now();
            let syncPos = msg.currentTime;
            if (msg.state === "playing") {
              const lr = diag.timing.lastRttMs;
              if (typeof lr === "number" && lr > 0) {
                syncPos = msg.currentTime + lr / 2 / 1e3;
              }
            }
            ingestHostAuthoritativeSync(syncPos, msg.state === "playing", syncIngestAt);
          }
          break;
        case "AD_BREAK_START":
          if (msg.fromClientId && roomState) {
            ingestPeerAdBreakStart(msg.fromClientId, msg.fromUsername);
          }
          break;
        case "AD_BREAK_END":
          if (msg.fromClientId) ingestPeerAdBreakEnd(msg.fromClientId);
          break;
        case "SEEK":
          applySeek(msg.currentTime, msg.fromUsername, msg.fromClientId, msg.lastRtt, msg.correlationId, msg.serverTime);
          break;
        case "SYNC_STATE":
          diag.extensionOps.syncStateInbound++;
          if (video) applySyncState(msg.state);
          else if (!roomState?.isHost) {
            pendingSyncState = msg.state;
            diag.extensionOps.syncStateDeferredNoVideo++;
            syncPendingSyncStateDiagFlag();
          }
          break;
        case "CHAT":
          diag.extensionOps.chatReceived++;
          diagLog("CHAT", { from: msg.username, text: (msg.text || "").slice(0, 40) });
          postSidebar({ type: "CHAT", data: msg });
          break;
        case "REACTION":
          showFloatingReaction(msg.emoji, msg.color);
          break;
        case "SYSTEM_MSG":
          diag.extensionOps.systemMsgsReceived++;
          if (msg.text) {
            postSidebar({ type: "SYSTEM_MSG", text: msg.text });
            if (!isOwnPlaybackSystemMsg(msg.text)) showToast(msg.text);
            else diag.extensionOps.playbackSystemMsgsDeduped++;
          }
          break;
        case "COUNTDOWN_START":
          if (msg.fromClientId !== roomState?.clientId) {
            diag.extensionOps.countdownStartRemote++;
            postSidebar({ type: "COUNTDOWN_START", fromUsername: msg.fromUsername });
          }
          if (!roomState?.isHost) showCountdownOverlay(false);
          break;
        case "DIAG_SYNC_APPLY_RESULT": {
          if (!diagExportAccumulateActive()) break;
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
        case "DIAG_ROOM_TRACE": {
          if (!diagExportAccumulateActive()) break;
          if (msg.entries && Array.isArray(msg.entries)) {
            diag.serverRoomTrace = msg.entries.slice(-40);
            diag.serverRoomTraceAt = Date.now();
            scheduleDiagUpdate();
          }
          break;
        }
        case "POSITION_SNAPSHOT":
          ingestPositionSnapshot(msg);
          break;
        case "DIAG_SYNC_REPORT": {
          if (!diagExportAccumulateActive()) break;
          if (msg.clientId && msg.clientId !== roomState?.clientId) {
            diag.sync.peerReports[msg.clientId] = {
              username: msg.username,
              isHost: msg.isHost,
              platform: msg.platformName || msg.platform,
              metrics: msg.metrics || {},
              videoAttached: msg.videoAttached,
              lastReceived: Date.now(),
              devDiag: msg.devDiag && typeof msg.devDiag === "object" ? (
                /** @type {Record<string, unknown>} */
                msg.devDiag
              ) : null
            };
          }
          break;
        }
        case "DIAG_PROFILER_COLLECTION": {
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
        case "DIAG_PEER_RECORDING_SAMPLE":
          ingestPeerRecordingSample(
            /** @type {Record<string, unknown>} */
            msg
          );
          break;
        case "TYPING_START":
        case "TYPING_STOP":
          postSidebar({ type: msg.type, username: msg.username });
          break;
        case "TOGGLE_SIDEBAR":
          diag.sidebar.toggleReceived++;
          diag.sidebar.lastToggleAt = Date.now();
          diagLog("TOGGLE_SIDEBAR", { count: diag.sidebar.toggleReceived });
          toggleSidebar();
          break;
        case "SETTINGS_CHANGED":
          applySidebarLayout();
          break;
        case "WS_STATUS": {
          if (prevBgWsOpen === true && !msg.open) diag.extensionOps.wsDisconnectEvents++;
          prevBgWsOpen = !!msg.open;
          diag.connectionStatus = msg.open ? "connected" : "disconnected";
          if (typeof msg.connectionMessage === "string") diag.connectionMessage = msg.connectionMessage;
          if (typeof msg.transportPhase === "string") diag.transportPhase = msg.transportPhase;
          postSidebar({
            type: "EXTENSION_WS",
            open: !!msg.open,
            connectionMessage: msg.connectionMessage,
            transportPhase: msg.transportPhase
          });
          if (msg.transportPhase === "unreachable") showToast("Server unavailable");
          break;
        }
        case "ERROR":
          diag.extensionOps.serverErrors++;
          diagLog("ERROR", { message: msg.message || msg.code || "Unknown error" });
          showToast(userVisibleServerErrorLine(msg));
          break;
      }
    });
    function getSidebarWidth() {
      return sidebarCompact ? SIDEBAR_WIDTH.compact : SIDEBAR_WIDTH.full;
    }
    function applySidebarLayout() {
      const w = getSidebarWidth();
      const isRight = sidebarPosition === "right";
      if (!sidebarFrame || !sidebarToggleBtn) return;
      const side = isRight ? "right" : "left";
      const opposite = isRight ? "left" : "right";
      sidebarFrame.style.width = w + "px";
      sidebarFrame.style[side] = sidebarVisible ? "0" : "-" + w + "px";
      sidebarFrame.style[opposite] = "auto";
      sidebarFrame.style.transition = side + " 0.35s cubic-bezier(0.4,0,0.2,1)";
      sidebarFrame.style.boxShadow = isRight ? "-8px 0 32px rgba(0,0,0,0.5)" : "8px 0 32px rgba(0,0,0,0.5)";
      sidebarToggleBtn.style[side] = "0";
      sidebarToggleBtn.style[opposite] = "auto";
      sidebarToggleBtn.style.borderRadius = isRight ? "12px 0 0 12px" : "0 12px 12px 0";
      sidebarToggleBtn.style.boxShadow = isRight ? "-4px 0 20px rgba(0,0,0,0.4)" : "4px 0 20px rgba(0,0,0,0.4)";
      document.documentElement.style.marginRight = "";
      document.documentElement.style.marginLeft = "";
      postSidebar({ type: "SETTINGS", compact: true });
    }
    function injectSidebar() {
      if (sidebarFrame) return;
      sidebarToggleBtn = document.createElement("div");
      sidebarToggleBtn.id = "ws-toggle-btn";
      const _brandMark = chrome.runtime.getURL("shared/brand-mark.png");
      sidebarToggleBtn.innerHTML = `
      <img src="${_brandMark}" width="26" height="26" alt="" role="presentation" draggable="false"
        style="display:block;object-fit:contain;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.45));" />
      <span id="ws-unread-badge" style="display:none">0</span>
    `;
      const isRight = sidebarPosition === "right";
      const side = isRight ? "right" : "left";
      const borderRadius = isRight ? "12px 0 0 12px" : "0 12px 12px 0";
      sidebarToggleBtn.style.cssText = `
      position:fixed;${side}:0;top:50%;transform:translateY(-50%);
      width:48px;height:48px;background:linear-gradient(135deg,#E50914 0%,#c40812 100%);
      border-radius:${borderRadius};display:none;align-items:center;justify-content:center;
      cursor:pointer;z-index:2147483646;
      box-shadow:${isRight ? "-4px 0 20px" : "4px 0 20px"} rgba(0,0,0,0.4);
      transition:all 0.25s cubic-bezier(0.4,0,0.2,1);contain:layout style paint;
    `;
      sidebarToggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleSidebar();
      });
      document.body.appendChild(sidebarToggleBtn);
      const w = getSidebarWidth();
      sidebarFrame = document.createElement("iframe");
      sidebarIframeReady = false;
      sidebarPendingPost.length = 0;
      sidebarFrame.id = "ws-sidebar-frame";
      sidebarFrame.src = chrome.runtime.getURL("sidebar/sidebar.html");
      sidebarFrame.style.cssText = `
      position:fixed;${side}:-${w}px;top:0;width:${w}px;height:100vh;
      border:none;z-index:2147483645;
      box-shadow:${isRight ? "-8px 0 32px" : "8px 0 32px"} rgba(0,0,0,0.5);
      transition:${side} 0.35s cubic-bezier(0.4,0,0.2,1);
      background:#0a0a0a;contain:layout style paint;
    `;
      document.body.appendChild(sidebarFrame);
      reparentPlayShareUiForFullscreen();
      diag.sidebar.frameExists = true;
      diag.sidebar.toggleBtnExists = true;
      diagLog("SIDEBAR_INJECT", {});
      window.addEventListener("message", (e) => {
        if (e.data && e.data.source === "playshare-sidebar") {
          handleSidebarMessage(e.data);
        }
      });
    }
    function handleSidebarMessage(msg) {
      switch (msg.type) {
        case "CHAT":
          sendBg({ source: "playshare", type: "CHAT", text: msg.text });
          break;
        case "TYPING_START":
        case "TYPING_STOP":
          sendBg({ source: "playshare", type: msg.type });
          break;
        case "REACTION":
          sendBg({ source: "playshare", type: "REACTION", emoji: msg.emoji });
          showFloatingReaction(msg.emoji, roomState ? roomState.color : "#4ECDC4");
          break;
        case "CLOSE_SIDEBAR":
          closeSidebar();
          break;
        case "SET_COUNTDOWN_ON_PLAY":
          if (!roomState?.isHost) break;
          roomState.countdownOnPlay = !!msg.value;
          chrome.storage.local.set({ playshareCountdownOnPlay: roomState.countdownOnPlay });
          sendBg({ source: "playshare", type: "UPDATE_COUNTDOWN_ON_PLAY", value: roomState.countdownOnPlay });
          postSidebarRoomState();
          break;
        case "AD_BREAK_MANUAL_START":
          applyManualAdBreakStart(false);
          break;
        case "AD_BREAK_MANUAL_END":
          applyManualAdBreakEnd(false);
          break;
        case "COPY_INVITE_LINK":
          chrome.runtime.sendMessage({ source: "playshare", type: "GET_ROOM_LINK_DATA" }, (linkData) => {
            if (chrome.runtime.lastError) {
              showToast("Could not build invite link");
              return;
            }
            if (!linkData?.roomCode) {
              showToast("Join a room first");
              return;
            }
            const serverUrl = linkData.serverUrl;
            const httpBase = wsUrlToHttpBase(serverUrl);
            let httpJoinUrl = httpBase ? `${httpBase}/join?code=${linkData.roomCode}` : null;
            if (httpJoinUrl && linkData.videoUrl) httpJoinUrl += "&url=" + encodeURIComponent(linkData.videoUrl);
            const textToCopy = httpJoinUrl || linkData.roomCode;
            navigator.clipboard.writeText(textToCopy).then(() => {
              showToast(
                linkData.videoUrl ? "Invite copied — opens video + room" : "Invite copied — open a video page for one-tap join"
              );
            }).catch(() => {
              showToast("Could not copy to clipboard");
            });
          });
          break;
        case "READY":
          markSidebarIframeReady();
          postSidebar({ type: "SETTINGS", compact: true });
          chrome.runtime.sendMessage({ source: "playshare", type: "GET_DIAG" }, (res) => {
            mergeServiceWorkerDiag(res);
            postSidebar({
              type: "EXTENSION_WS",
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
          win.postMessage({ source: "playshare-content", ...msg }, "*");
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
          sidebarFrame.contentWindow.postMessage({ source: "playshare-content", ...msg }, "*");
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
    function postSidebarRoomState() {
      if (!roomState) return;
      const hasInviteVideo = !!(roomState.videoUrl || roomState.isHost && video && !isVideoStale(video));
      postSidebar({
        type: "ROOM_STATE",
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
        ingestPeerAdBreakStart(cid, m?.username || "Someone");
      }
    }
    function openSidebar() {
      if (!sidebarFrame) injectSidebar();
      sidebarVisible = true;
      diagLog("SIDEBAR_OPEN", { hasFrame: !!sidebarFrame });
      applySidebarLayout();
    }
    function closeSidebar() {
      if (!sidebarFrame) return;
      sidebarVisible = false;
      diagLog("SIDEBAR_CLOSE", {});
      applySidebarLayout();
    }
    function toggleSidebar() {
      if (sidebarVisible) closeSidebar();
      else openSidebar();
    }
    function showSidebarToggle() {
      if (!sidebarToggleBtn) injectSidebar();
      sidebarToggleBtn.style.display = "flex";
      diag.sidebar.toggleBtnVisible = true;
    }
    function hideSidebarToggle() {
      if (sidebarToggleBtn) sidebarToggleBtn.style.display = "none";
      diag.sidebar.toggleBtnVisible = false;
    }
    let toastContainer = null;
    function showToast(text) {
      if (!toastContainer) {
        toastContainer = document.createElement("div");
        toastContainer.id = "ws-toast-container";
        toastContainer.style.cssText = `
        position:fixed;bottom:100px;left:50%;transform:translateX(-50%);
        z-index:2147483647;display:flex;flex-direction:column;align-items:center;gap:8px;
        pointer-events:none;contain:layout style paint;
      `;
        document.body.appendChild(toastContainer);
        reparentPlayShareUiForFullscreen();
      }
      const toast = document.createElement("div");
      toast.style.cssText = `
      background:rgba(10,10,10,0.92);color:#f0f0f0;
      padding:10px 18px;border-radius:24px;font-size:14px;font-family:sans-serif;
      border:1px solid rgba(255,255,255,0.08);backdrop-filter:blur(12px);
      animation:wsFadeIn 0.3s cubic-bezier(0.4,0,0.2,1);white-space:nowrap;
    `;
      toast.textContent = text;
      toastContainer.appendChild(toast);
      setTimeout(() => toast.remove(), 3e3);
    }
    function showFloatingReaction(emoji, color) {
      const padding = 60;
      const sidebarW = sidebarVisible ? getSidebarWidth() : 0;
      const isRight = sidebarPosition === "right";
      const minLeft = isRight ? padding : sidebarW + padding;
      const maxLeft = isRight ? window.innerWidth - sidebarW - padding : window.innerWidth - padding;
      const left = minLeft + Math.random() * Math.max(0, maxLeft - minLeft);
      const bottom = padding + Math.random() * (window.innerHeight * 0.35);
      const duration = 7;
      const el = document.createElement("div");
      el.style.cssText = `
      position:fixed;left:${left}px;bottom:${bottom}px;
      font-size:${36 + Math.random() * 16}px;z-index:2147483640;pointer-events:none;
      filter:drop-shadow(0 4px 12px rgba(0,0,0,0.4));
      animation:wsFloatUp ${duration}s cubic-bezier(0.25,0.5,0.5,1) forwards;
    `;
      el.textContent = emoji;
      getFullscreenUiHost().appendChild(el);
      setTimeout(() => el.remove(), duration * 1e3);
    }
    let diagOverlay = null;
    let diagPanel = null;
    let diagVisible = false;
    let diagDrag = { active: false, dx: 0, dy: 0 };
    let diagExportCaptureContext = null;
    let diagToggleBtn = null;
    function reparentPlayShareUiForFullscreen() {
      const host = getFullscreenUiHost();
      const layers = [
        [sidebarFrame, "2147483645"],
        [sidebarToggleBtn, "2147483646"],
        [clusterSyncBadge, "2147483630"],
        [primeHudEl, "2147483642"],
        [diagToggleBtn, "2147483643"],
        [toastContainer, "2147483644"],
        [countdownOverlayEl, "2147483641"],
        [diagOverlay, "2147483647"]
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
          }
        }
      }
      try {
        drmSyncPrompt.reparentIfVisible();
      } catch {
      }
    }
    function recordMemberChronology(kind, detail) {
      if (!diagExportAccumulateActive()) return;
      const s = diag.sync;
      const row = { t: Date.now(), kind, ...detail };
      s.memberTimeline.unshift(row);
      if (s.memberTimeline.length > s.maxMemberTimeline) s.memberTimeline.length = s.maxMemberTimeline;
    }
    function mergeServiceWorkerDiag(res) {
      if (!res) return;
      if (res.connectionStatus) diag.connectionStatus = res.connectionStatus;
      if (typeof res.connectionMessage === "string") diag.connectionMessage = res.connectionMessage;
      if (typeof res.transportPhase === "string") diag.transportPhase = res.transportPhase;
      if (!diagExportAccumulateActive()) return;
      if (typeof res.lastRttMs === "number" && res.lastRttMs > 0) {
        maybeSetPlaybackDiagRtt(res.lastRttMs, "background_heartbeat");
      }
      if (res.transport && typeof res.transport === "object") {
        diag.serviceWorkerTransport = { ...res.transport };
      }
    }
    function userVisibleServerErrorLine(msg) {
      const code = msg && msg.code;
      if (code === "ROOM_NOT_FOUND") return "Server unavailable — that room may have ended.";
      if (code === "RATE_LIMIT") return "Too many messages — slow down.";
      if (code === "MESSAGE_TOO_LARGE") return "Message too large.";
      return msg && msg.message || "Something went wrong.";
    }
    function flushDiagFromBackground() {
      return new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ source: "playshare", type: "GET_DIAG" }, (res) => {
            mergeServiceWorkerDiag(res);
            resolve(true);
          });
        } catch {
          resolve(false);
        }
      });
    }
    async function prepareDiagnosticSnapshotForExport() {
      await flushDiagFromBackground();
      diagExportCaptureContext = {
        preparedAt: Date.now(),
        tabVisibility: typeof document !== "undefined" ? document.visibilityState : null,
        documentHasFocus: typeof document !== "undefined" && typeof document.hasFocus === "function" ? document.hasFocus() : null,
        overlayOpen: !!diagVisible,
        preExportTraceRequested: false
      };
      sendBg({ source: "playshare", type: "DIAG_ROOM_TRACE_REQUEST" });
      diagExportCaptureContext.preExportTraceRequested = true;
      await new Promise((r) => setTimeout(r, 480));
      captureVideoHealthSnapshot();
    }
    function formatDiagTime(ts) {
      const sec = Math.floor((Date.now() - ts) / 1e3);
      if (sec < 60) return sec + "s ago";
      return Math.floor(sec / 60) + "m ago";
    }
    function formatDiagTimeAgo(ts) {
      const ms = Date.now() - ts;
      if (ms < 1e3) return ms + "ms ago";
      return (ms / 1e3).toFixed(1) + "s ago";
    }
    function resetSyncMetrics() {
      diag.profilerExportPending = false;
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
      Object.assign(extensionOpsStore, EXTENSION_OPS_DEFAULTS);
      Object.assign(messagingStore, MESSAGING_DEFAULTS);
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
    async function runSyncTest(soakRounds) {
      if (!video || isVideoStale(video)) {
        diagLog("ERROR", { message: "No video — load a video first" });
        return;
      }
      if (!roomState) {
        diagLog("ERROR", { message: "No room — join a room first" });
        return;
      }
      const rounds = Math.max(1, Math.min(20, Number(soakRounds) > 0 ? Number(soakRounds) : 1));
      const s = diag.sync;
      if (s.testRunning) return;
      s.testRunning = true;
      s.testResults = { steps: [], start: Date.now(), soakRounds: rounds, peerTimeouts: 0 };
      const btn = diagPanel?.querySelector("#diagSyncTest");
      const btnSoak = diagPanel?.querySelector("#diagSyncTestSoak");
      if (btn) btn.disabled = true;
      if (btnSoak) btnSoak.disabled = true;
      const memberCount = (roomState.members || []).length;
      const expectPeer = memberCount > 1;
      const peerTimeoutMs = 3200;
      for (let r = 0; r < rounds; r++) {
        const v = findVideo() || video;
        const steps = [
          { name: "Pause", fn: () => {
            safeVideoOp(() => v.pause());
            lastPlaybackOutboundKind = "PAUSE";
            lastSentTime = v.currentTime;
            syncDiagRecord({ type: "pause_sent", currentTime: v.currentTime });
            sendBg({ source: "playshare", type: "PAUSE", currentTime: v.currentTime, sentAt: Date.now() });
          } },
          { name: "Seek +0.5s", fn: () => {
            safeVideoOp(() => {
              v.currentTime = Math.min(v.currentTime + 0.5, v.duration || 9999);
            });
            lastPlaybackOutboundKind = "SEEK";
            lastSentTime = v.currentTime;
            syncDiagRecord({ type: "seek_sent", currentTime: v.currentTime });
            sendBg({ source: "playshare", type: "SEEK", currentTime: v.currentTime, sentAt: Date.now() });
          } },
          { name: "Play", fn: () => {
            safeVideoOp(() => v.play().catch(() => {
            }));
            lastPlaybackOutboundKind = "PLAY";
            lastSentTime = v.currentTime;
            syncDiagRecord({ type: "play_sent", currentTime: v.currentTime });
            sendBg({ source: "playshare", type: "PLAY", currentTime: v.currentTime, sentAt: Date.now() });
          } },
          { name: "Pause", fn: () => {
            safeVideoOp(() => v.pause());
            lastPlaybackOutboundKind = "PAUSE";
            lastSentTime = v.currentTime;
            syncDiagRecord({ type: "pause_sent", currentTime: v.currentTime });
            sendBg({ source: "playshare", type: "PAUSE", currentTime: v.currentTime, sentAt: Date.now() });
          } }
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
      const remotePlay = rem.filter((r) => r.eventType === "play");
      const remotePlayFail = remotePlay.filter((r) => !r.success).length;
      const remotePause = rem.filter((r) => r.eventType === "pause");
      const remotePauseFail = remotePause.filter((r) => !r.success).length;
      if (playTotal > 0 && m.playFail / playTotal > 0.3) {
        tips.push({ level: "warn", text: `Play sync failing here (${m.playFail}/${playTotal}). Prime/Netflix may need fallbacks.` });
      }
      if (remotePlay.length > 0 && remotePlayFail / remotePlay.length > 0.3) {
        tips.push({ level: "warn", text: `Peers report play fail (${remotePlayFail}/${remotePlay.length}). Check their platform.` });
      }
      if (pauseTotal > 0 && m.pauseFail / pauseTotal > 0.3) {
        tips.push({ level: "warn", text: `Pause sync failing here (${m.pauseFail}/${pauseTotal}). Try video.click fallback.` });
      }
      if (remotePause.length > 0 && remotePauseFail / remotePause.length > 0.3) {
        tips.push({ level: "warn", text: `Peers report pause fail (${remotePauseFail}/${remotePause.length}). Check their platform.` });
      }
      if (seekTotal > 0 && m.seekFail / seekTotal > 0.3) {
        tips.push({ level: "warn", text: `Seek sync drifting (${m.seekFail}/${seekTotal}). Platform may replace video element.` });
      }
      const avgLatency = rem.length > 0 ? Math.round(rem.reduce((a, r) => a + (r.latency || 0), 0) / rem.length) : 0;
      if (avgLatency > 0 && avgLatency < 2e3) {
        tips.push({ level: "info", text: `Avg round-trip latency: ${avgLatency}ms` });
      } else if (avgLatency >= 2e3) {
        tips.push({ level: "warn", text: `High latency: ${avgLatency}ms. Check network.` });
      }
      if (diag.tabHidden) {
        tips.push({ level: "info", text: "Tab hidden — remote sync may apply when the tab is visible again." });
      }
      const vb = diag.videoBuffering;
      if ((vb.waiting > 8 || vb.stalled > 4) && playTotal + pauseTotal + seekTotal > 0) {
        tips.push({
          level: "info",
          text: `Video rebuffering: waiting×${vb.waiting} stalled×${vb.stalled} — can look like sync issues; check CDN/adaptive vs extension.`
        });
      }
      const ge = diag.extensionOps;
      if ((ge.remoteApplyDeniedSyncLock || 0) + (ge.remoteApplyDeniedPlaybackDebounce || 0) >= 3) {
        tips.push({ level: "info", text: "Remote play/pause/seek sometimes gated (sync lock / playback debounce). See Extension bridge counters." });
      }
      if (tips.length > 0 && siteSync.extraDiagTips) {
        for (const t of siteSync.extraDiagTips()) tips.push(t);
      }
      if (playbackProfile.handlerKey === "disney" && tips.length > 0) {
        tips.push({
          level: "info",
          text: "Disney+: passive DRM-safe sync — use “Sync to host” when prompted."
        });
      }
      if (Object.keys(diag.sync.peerReports).length > 0) {
        tips.push({
          level: "ok",
          text: `Receiving peer report(s) from ${Object.keys(diag.sync.peerReports).length} peer(s)${diagnosticsUiEnabled ? " (sent when they open diagnostics or use Request peer report). While you record the video profiler, dev peers also push timed samples—those land in the unified export." : ""}.`
        });
      }
      const cs = diag.clusterSync;
      if (cs && cs.playingMismatch) {
        tips.push({ level: "warn", text: "Room cluster: not everyone agrees on play vs pause (check badges)." });
      } else if (cs && cs.synced === false && cs.spreadSec != null) {
        tips.push({ level: "warn", text: `Room cluster spread ~${cs.spreadSec.toFixed(1)}s — playback may need a moment or a manual seek.` });
      } else if (cs && cs.synced === true) {
        tips.push({ level: "ok", text: `Room cluster looks aligned (within ${CLUSTER_SYNC_SPREAD_SEC}s).` });
      }
      if (tips.length === 0 && playTotal + pauseTotal + seekTotal > 0) {
        tips.push({ level: "ok", text: "Sync looks healthy. Open diagnostic on both devices for full view." });
      }
      if (tips.length === 0) {
        tips.push({ level: "info", text: "Perform play/pause/seek with a partner. Open diagnostic on both devices." });
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
      } catch {
      }
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
        currentSrc: v.currentSrc ? String(v.currentSrc).slice(0, 72) + (String(v.currentSrc).length > 72 ? "…" : "") : ""
      };
    }
    function buildPrimeSnapshotAutoContext() {
      let extVersion = "1.0.0";
      try {
        extVersion = chrome.runtime.getManifest()?.version || extVersion;
      } catch {
      }
      const path = typeof location !== "undefined" ? location.pathname || "" : "";
      const host = (typeof location !== "undefined" ? location.hostname : "").toLowerCase();
      let primePathKind = "other";
      if (/primevideo\.com/.test(host)) {
        if (/\/detail\//i.test(path)) primePathKind = "prime_detail";
        else if (/\/watch\//i.test(path)) primePathKind = "prime_watch";
        else if (/\/region\//i.test(path)) primePathKind = "prime_region";
      } else if (/amazon\.(com|ca)/.test(host)) {
        if (/\/gp\/video\/detail\//i.test(path)) primePathKind = "amazon_gp_video_detail";
        else if (/\/gp\/video\/watch\//i.test(path)) primePathKind = "amazon_gp_video_watch";
      }
      const ts = Date.now();
      const captureNonce = `${ts}-${Math.random().toString(36).slice(2, 9)}`;
      let pipActive = null;
      let fullscreenActive = null;
      let pageFocused = null;
      try {
        pipActive = !!document.pictureInPictureElement;
      } catch {
      }
      try {
        fullscreenActive = !!(document.fullscreenElement || document.webkitFullscreenElement);
      } catch {
      }
      try {
        pageFocused = typeof document.hasFocus === "function" ? document.hasFocus() : null;
      } catch {
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
        roomRole: inRoom ? roomState.isHost ? "host" : "viewer" : "solo",
        roomCodeShort: inRoom && roomState.roomCode ? String(roomState.roomCode).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) : null
      };
    }
    function getDiagExportPayload() {
      let ver = "1.0.0";
      try {
        ver = chrome.runtime.getManifest()?.version || ver;
      } catch {
      }
      return buildDiagnosticExport({
        diag,
        roomState,
        platform,
        extVersion: ver,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
        reportSession: diag.reportSession,
        pageHost: typeof location !== "undefined" ? location.hostname : "",
        videoAttached: diag.videoAttached,
        captureContext: diagExportCaptureContext
      });
    }
    async function buildPrimePlayerSyncExportBundle() {
      if (siteSync.key !== "prime") return null;
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
      const peerReportSummary = Object.entries(diag.sync.peerReports || {}).slice(0, 12).map(([cid, r]) => ({
        clientShort: cid ? `${String(cid).slice(0, 10)}…` : null,
        username: r.username ?? null,
        platform: r.platform ?? null,
        isHost: !!r.isHost,
        lastReceived: r.lastReceived ?? null,
        metrics: r.metrics ? { ...r.metrics } : null
      }));
      const autoCaptureContext = buildPrimeSnapshotAutoContext();
      const multiUserSync = roomState ? {
        roomCode: roomState.roomCode,
        memberCount: (roomState.members || []).length,
        capturingUsername: roomState.username ?? null,
        clientIdSuffix: roomState.clientId ? String(roomState.clientId).slice(-10) : null,
        platform: { key: platform.key, name: platform.name },
        tab: {
          diagTabHidden: diag.tabHidden,
          documentHidden: typeof document !== "undefined" ? document.hidden : null
        },
        transport: {
          connectionStatus: diag.connectionStatus,
          transportPhase: diag.transportPhase,
          serviceWorkerTransport: sw ? {
            wsOpenCount: sw.wsOpenCount,
            wsCloseCount: sw.wsCloseCount,
            wsSendFailures: sw.wsSendFailures ?? 0,
            serverHost: sw.serverHost || null
          } : null
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
          runtimeLastErrorMessage: diag.messaging.runtimeLastErrorMessage ? String(diag.messaging.runtimeLastErrorMessage).slice(0, 220) : null
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
        reportSession: diag.reportSession ? { startedAt: diag.reportSession.startedAt, roomCode: diag.reportSession.roomCode } : null
      } : {
        note: "not_in_room",
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
    function buildPeerRecordingDiagnosticsForExport() {
      const by = diag.peerRecordingSamples.byClient;
      const clientIds = Object.keys(by);
      if (clientIds.length === 0) return null;
      const peers = [];
      for (const cid of clientIds) {
        const rows = by[cid];
        if (!Array.isArray(rows) || rows.length === 0) continue;
        const first = rows[0];
        const last = rows[rows.length - 1];
        peers.push({
          fromClientId: cid,
          fromUsername: typeof first.fromUsername === "string" ? first.fromUsername : "",
          sampleCount: rows.length,
          firstReceivedAt: first.receivedAt,
          lastReceivedAt: last.receivedAt,
          samples: rows.map((r) => {
            const p = r.payload && typeof r.payload === "object" ? r.payload : {};
            return {
              receivedAt: r.receivedAt,
              syncMetrics: p.syncMetrics && typeof p.syncMetrics === "object" ? p.syncMetrics : null,
              videoAttached: p.videoAttached,
              platform: p.platform,
              platformName: p.platformName,
              devDiag: p.devDiag && typeof p.devDiag === "object" ? p.devDiag : null
            };
          })
        });
      }
      if (peers.length === 0) return null;
      return {
        schema: "playshare.peerRecordingDiagnostics.v1",
        exportedAtMs: Date.now(),
        collectorRecording: getVideoProfiler().isRecording(),
        peers
      };
    }
    async function getUnifiedPlayShareExportPayload(opts = {}) {
      await prepareDiagnosticSnapshotForExport();
      const extension = getDiagExportPayload();
      const videoPlayerProfiler = getVideoProfiler().buildExportPayload(buildVideoProfilerPageMeta(), {
        compact: !!opts.compactProfiler,
        includeVideoFrame: !!opts.includeProfilerVideoFrame
      });
      let primeSiteDebug = null;
      if (siteSync.key === "prime" && diagExportAccumulateActive()) {
        try {
          const bundle = await buildPrimePlayerSyncExportBundle();
          if (bundle) primeSiteDebug = bundle.payload;
        } catch (e) {
          primeSiteDebug = {
            kind: "playshare_prime_player_sync_debug_v1",
            captureError: e && e.message ? String(e.message) : String(e)
          };
        }
      }
      const peerRecordingDiagnostics = buildPeerRecordingDiagnosticsForExport();
      const pSnap = Array.isArray(videoPlayerProfiler.snapshots) ? videoPlayerProfiler.snapshots.length : 0;
      const peerDiagLine = peerRecordingDiagnostics ? ` Peer profiler samples: ${peerRecordingDiagnostics.peers.length} peer(s), ${peerRecordingDiagnostics.peers.reduce((a, p) => a + (typeof p.sampleCount === "number" ? p.sampleCount : 0), 0)} row(s).` : "";
      const appendix = `

--- Unified JSON (server upload) ---
Client extension version: ${extension.extensionVersion || "unknown"} · report schema ${extension.reportSchemaVersion || "?"}
Bundled: extension report (${extension.reportSchemaVersion || "?"} — sync metrics, extensionOps, service worker WS + connectionDetail, narrativeSummary), video profiler (${pSnap} snapshots in this file), ${siteSync.key === "prime" ? primeSiteDebug && !primeSiteDebug.captureError ? "Prime player/site digest." : "Prime digest capture failed (see primeSiteDebug.captureError)." : "no Prime site block (not Prime)."}${peerDiagLine} Does not include the separate Prime missed-ad-only JSON.
`;
      return {
        playshareUnifiedExport: "1.0",
        exportedAtMs: Date.now(),
        exportedAtIso: (/* @__PURE__ */ new Date()).toISOString(),
        contains: {
          extensionSyncReport: true,
          videoPlayerProfiler: true,
          primeSiteDebug: !!(primeSiteDebug && !primeSiteDebug.captureError),
          primeSiteDebugCaptureFailed: !!(primeSiteDebug && primeSiteDebug.captureError),
          peerRecordingDiagnostics: !!peerRecordingDiagnostics,
          excludedPrimeMissedAdOnlyExport: true
        },
        narrativeSummary: (extension.narrativeSummary || "") + appendix,
        extension,
        videoPlayerProfiler,
        primeSiteDebug,
        peerRecordingDiagnostics
      };
    }
    function mergeEnrichmentForDiagUpload(payload) {
      try {
        const th = syncDecision.getDriftThresholds();
        payload.enrichment = {
          syncConfigSnapshot: {
            handlerKey: playbackProfile.handlerKey,
            drmPassive: !!playbackProfile.drmPassive,
            aggressiveRemoteSync: !!playbackProfile.aggressiveRemoteSync,
            viewerReconcileIntervalMs: playbackProfile.viewerReconcileIntervalMs,
            drmDesyncThresholdSec: playbackProfile.drmDesyncThresholdSec,
            syncStateApplyDelayMs: playbackProfile.syncStateApplyDelayMs,
            positionReportIntervalMs: POSITION_REPORT_INTERVAL_MS,
            driftThresholds: th && typeof th === "object" ? { ...th } : null
          }
        };
      } catch {
        payload.enrichment = { syncConfigSnapshot: { handlerKey: playbackProfile.handlerKey } };
      }
    }
    async function uploadAnonymizedDiagnosticExport() {
      const opt = await new Promise((r) => chrome.storage.local.get(["playshare_diag_upload_opt_in"], r));
      if (!opt.playshare_diag_upload_opt_in) {
        diagLog("ERROR", { message: "Diagnostic upload: enable opt-in checkbox first", kind: "diag_upload" });
        showToast("Turn on “Allow uploads to my server” first, then try again.");
        return;
      }
      const payload = await getUnifiedPlayShareExportPayload({ compactProfiler: true });
      mergeEnrichmentForDiagUpload(payload);
      let ver = "1.0.0";
      try {
        ver = chrome.runtime.getManifest()?.version || ver;
      } catch {
      }
      payload.uploadClient = {
        extensionVersion: ver,
        diagnosticReportSchema: DIAGNOSTIC_REPORT_SCHEMA
      };
      const tr = await new Promise((r) => chrome.storage.local.get(["playshare_diag_test_run_id"], r));
      chrome.runtime.sendMessage(
        {
          source: "playshare",
          type: "DIAG_UPLOAD_UNIFIED",
          payload,
          hashSecrets: {
            roomCode: roomState?.roomCode ?? null,
            clientId: roomState?.clientId ?? null,
            username: roomState?.username ?? null
          },
          extensionVersion: ver,
          platformHandlerKey: playbackProfile.handlerKey,
          diagnosticReportSchema: DIAGNOSTIC_REPORT_SCHEMA,
          testRunId: tr.playshare_diag_test_run_id || null
        },
        (res) => {
          const le = chrome.runtime.lastError;
          if (le) {
            diagLog("ERROR", { message: le.message || "Upload failed", kind: "diag_upload" });
            showToast("Upload failed (extension bridge).");
            return;
          }
          if (res && res.ok && res.reportId) {
            diagLog("DIAG_UPLOAD", { ok: true, reportId: res.reportId, persisted: res.persisted });
            showToast(
              res.persisted ? `Anonymized report uploaded · ${String(res.reportId).slice(0, 8)}…` : `Report accepted · ${String(res.reportId).slice(0, 8)}… (server storage not configured)`
            );
            if (res.persisted === true) resetCapturedDiagnosticSessionAfterUpload();
          } else {
            diagLog("ERROR", {
              message: res?.error || res?.detail || "Upload rejected",
              status: res?.status,
              uploadUrl: res?.uploadUrl,
              kind: "diag_upload"
            });
            const st = res?.status;
            const errCode = res?.error || Array.isArray(res?.reasons) && res.reasons[0] || "";
            const u404 = st === 404 ? " Server has no POST /diag/upload (deploy latest server) or the signaling URL included a path — use host only, e.g. wss://your.railway.app" : "";
            const u503 = st === 503 && String(errCode).includes("hash_salt") ? " Set env PLAYSHARE_DIAG_HASH_SALT on the server (16+ random characters) in Railway, then redeploy." : st === 503 ? " Server misconfigured or unavailable (check Railway logs)." : "";
            const u401 = st === 401 && /unauthorized/i.test(String(errCode)) ? " Refresh the upload access secret in Analytics so the extension can mint a fresh scoped upload token, or remove the upload secret env vars on the server." : "";
            const u500store = st === 500 && /storage_failed|summary_failed/i.test(String(errCode)) ? " In Supabase SQL editor, run migrations under supabase/migrations (diag_reports_raw, diag_reports_summary, …). Confirm Railway SUPABASE_URL matches that project. See Railway logs for the exact Postgres error." : "";
            const detailStr = res?.detail != null ? String(res.detail).trim() : "";
            const detailHint = detailStr.length > 0 ? ` — ${detailStr.slice(0, 140)}${detailStr.length > 140 ? "…" : ""}` : "";
            showToast(
              `Upload failed${st ? ` (${st})` : ""}${errCode ? `: ${errCode}` : ""}${detailHint}.${u404}${u503}${u401}${u500store}`
            );
          }
        }
      );
    }
    function buildVideoProfilerPageMeta() {
      let ver = "1.0.0";
      try {
        ver = chrome.runtime.getManifest()?.version || ver;
      } catch {
      }
      return {
        hostname: typeof location !== "undefined" ? location.hostname : "",
        pathname: typeof location !== "undefined" ? location.pathname : "",
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
        platformHandlerKey: playbackProfile.handlerKey,
        extensionVersion: ver
      };
    }
    function startVideoProfilerSession() {
      const v = findVideo() || video;
      if (!v) {
        diagLog("ERROR", { message: "Video profiler: no <video> — start playback first" });
        return;
      }
      resetSyncMetrics();
      diag.profilerExportPending = false;
      diag.peerRecordingSamples.byClient = {};
      getVideoProfiler().start();
      broadcastProfilerCollectionState(true);
      diagLog("DIAG", { videoProfiler: "started", peerCollection: true });
      updateDiagnosticOverlay();
    }
    function stopVideoProfilerSession() {
      const wasRec = getVideoProfiler().isRecording();
      getVideoProfiler().stop();
      if (wasRec) diag.profilerExportPending = true;
      if (wasRec) broadcastProfilerCollectionState(false);
      diagLog("DIAG", { videoProfiler: "stopped" });
      updateDiagnosticOverlay();
      if (wasRec) void maybeAutoUploadAfterProfilerStop();
    }
    function resetCapturedDiagnosticSessionAfterUpload() {
      diag.profilerExportPending = false;
      const wasRec = getVideoProfiler().isRecording();
      getVideoProfiler().clearSession();
      if (wasRec) broadcastProfilerCollectionState(false);
      stopPeerRecordingSampleLoop();
      diag.profilerPeerCollection.remoteCollectorClientId = null;
      diag.peerRecordingSamples.byClient = {};
      diagExportCaptureContext = null;
      diagLog("DIAG_UPLOAD", { clearedLocalCapture: true });
      updateDiagnosticOverlay();
    }
    async function maybeAutoUploadAfterProfilerStop() {
      try {
        const r = await new Promise(
          (resolve) => chrome.storage.local.get(["playshare_diag_upload_opt_in", "playshare_diag_auto_upload_on_stop"], resolve)
        );
        if (!r.playshare_diag_upload_opt_in || !r.playshare_diag_auto_upload_on_stop) return;
        await uploadAnonymizedDiagnosticExport();
      } catch {
      }
    }
    function clearVideoProfilerSession() {
      diag.profilerExportPending = false;
      const wasRec = getVideoProfiler().isRecording();
      getVideoProfiler().clearSession();
      if (wasRec) broadcastProfilerCollectionState(false);
      stopPeerRecordingSampleLoop();
      diag.profilerPeerCollection.remoteCollectorClientId = null;
      diag.peerRecordingSamples.byClient = {};
      diagExportCaptureContext = null;
      diagLog("DIAG", { videoProfiler: "cleared" });
      updateDiagnosticOverlay();
    }
    function computeDiagCategoryIssues(syncTips) {
      const s = diag.sync;
      const m = s.metrics;
      const eo = diag.extensionOps;
      const vb = diag.videoBuffering;
      const cs = diag.clusterSync;
      const warnTips = syncTips.filter((t) => t.level === "warn");
      const playT = m.playOk + m.playFail;
      const pauseT = m.pauseOk + m.pauseFail;
      const seekT = m.seekOk + m.seekFail;
      const playBad = playT > 0 && m.playFail / playT > 0.25;
      const pauseBad = pauseT > 0 && m.pauseFail / pauseT > 0.25;
      const seekBad = seekT > 0 && m.seekFail / seekT > 0.25;
      const remoteFail = (s.remoteApplyResults || []).some((r) => !r.success);
      const multiplayer = warnTips.length > 0 || !!s.testRunning || playBad || pauseBad || seekBad || remoteFail || !!cs?.playingMismatch || cs && cs.synced === false && cs.spreadSec != null && cs.spreadSec > CLUSTER_SYNC_SPREAD_SEC * 1.15;
      const server = diag.connectionStatus === "disconnected" || (diag.messaging?.runtimeSendFailures ?? 0) > 0 || (eo.serverErrors ?? 0) > 0 || diag.serviceWorkerTransport && (diag.serviceWorkerTransport.wsSendFailures ?? 0) > 0;
      const drift = diag.timing.driftEwmSec;
      const technical = !diag.videoAttached || drift != null && drift > SYNC_DRIFT_SOFT_MIN_SEC || vb.waiting + vb.stalled > 5 || diag.timeupdateJumps.length > 0 || (eo.syncStateDeferredNoVideo ?? 0) > 18 || (eo.syncStateDeferredStaleOrMissing ?? 0) > 18;
      const logs = diag.errors.length > 0 || !!roomState && !sidebarFrame;
      let prime = false;
      if (siteSync.key === "prime" && diag.primeSync) {
        const p = diag.primeSync;
        prime = !p.inSdkShell || typeof p.viewerDriftSec === "number" && !Number.isNaN(p.viewerDriftSec) && Math.abs(p.viewerDriftSec) > 4;
      }
      return { multiplayer, server, technical, logs, prime };
    }
    function applyDiagSectionVisibility(issues) {
      if (!diagPanel) return;
      const showAllMetrics = true;
      const map = [
        ["multiplayer", issues.multiplayer],
        ["server", issues.server],
        ["technical", issues.technical],
        ["logs", issues.logs],
        ["prime", issues.prime]
      ];
      for (const [key, hasIssue] of map) {
        const det = diagPanel.querySelector(`details[data-diag-sec="${key}"]`);
        const wrap = diagPanel.querySelector(`[data-diag-sec-wrap="${key}"]`);
        const quiet = diagPanel.querySelector(`[data-diag-quiet="${key}"]`);
        const body = diagPanel.querySelector(`[data-diag-body="${key}"]`);
        const badge = det?.querySelector("[data-diag-sec-badge]") || wrap?.querySelector("[data-diag-sec-badge]");
        if (quiet) quiet.style.display = showAllMetrics ? "none" : hasIssue ? "none" : "block";
        if (body) body.style.display = showAllMetrics ? "block" : hasIssue ? "block" : "none";
        if (badge) {
          badge.textContent = hasIssue ? "Attention" : "OK";
          badge.classList.toggle("ws-diag-badge-ok", !hasIssue);
          badge.classList.toggle("ws-diag-badge-warn", !!hasIssue);
        }
      }
    }
    function applyDashboardBlockVisibility() {
      if (!diagPanel) return;
      for (const el of diagPanel.querySelectorAll("[data-diag-dash-block]")) {
        const key = el.getAttribute("data-diag-dash-block");
        if (!key || !(key in diag.dashBlocks)) continue;
        el.style.display = diag.dashBlocks[key] ? "" : "none";
      }
    }
    function syncDashLayoutCheckboxesFromDiag() {
      if (!diagPanel) return;
      const wrap = diagPanel.querySelector("[data-diag-dash-customize]");
      if (!wrap) return;
      for (const inp of wrap.querySelectorAll("input[data-dash-toggle]")) {
        const key = inp.getAttribute("data-dash-toggle");
        if (key && key in diag.dashBlocks) inp.checked = diag.dashBlocks[key];
      }
    }
    function closeDiagDashModal() {
      if (!diagPanel) return;
      const root = diagPanel.querySelector("#diagDashModalRoot");
      if (!root || root.hasAttribute("hidden")) return;
      root.setAttribute("hidden", "");
      root.setAttribute("aria-hidden", "true");
      diagPanel.querySelector("#diagDashCustomizeOpen")?.focus();
    }
    function openDiagDashModal() {
      if (!diagPanel) return;
      const root = diagPanel.querySelector("#diagDashModalRoot");
      if (!root) return;
      syncDashLayoutCheckboxesFromDiag();
      root.removeAttribute("hidden");
      root.setAttribute("aria-hidden", "false");
      const firstCb = diagPanel.querySelector('[data-diag-dash-customize] input[type="checkbox"]');
      (firstCb || diagPanel.querySelector("#diagDashCustomizeDone"))?.focus({ preventScroll: true });
    }
    function updateCompactConsoleStrip(catIssues) {
      if (!diagPanel) return;
      const setTile = (comp, hasIssue, line, ariaDetail) => {
        const tile = diagPanel.querySelector(`[data-diag-comp="${comp}"]`);
        if (!tile) return;
        tile.classList.toggle("ws-diag-comp-ok", !hasIssue);
        tile.classList.toggle("ws-diag-comp-warn", !!hasIssue);
        const lineEl = tile.querySelector(`[data-diag-comp-line="${comp}"]`);
        if (lineEl) lineEl.textContent = line;
        tile.setAttribute("aria-label", `${comp}: ${ariaDetail}`);
      };
      const cs = String(diag.connectionStatus || "unknown");
      const syncIssue = diag.connectionStatus === "disconnected" || !!catIssues.multiplayer || !!catIssues.server;
      const syncLine = `${diag.tabHidden ? "tab hidden · " : ""}${cs}`;
      setTile("sync", syncIssue, syncLine, `${syncIssue ? "needs attention" : "healthy"} · ${syncLine}`);
      let adIssue;
      let adLine;
      if (siteSync.key === "prime" && diag.primeSync) {
        const p = diag.primeSync;
        adIssue = !!catIssues.prime || !p.inSdkShell;
        adLine = !p.inSdkShell ? "Shell?" : p.adDetectorActive ? "Ad UI" : "Content";
      } else {
        adIssue = !!localAdBreakActive;
        adLine = localAdBreakActive ? "Ad break" : "Idle";
      }
      setTile("ad", adIssue, adLine, `${adIssue ? "check" : "ok"} · ${adLine}`);
      const vh = diag.videoHealthLast;
      const vidIssue = !!catIssues.technical || !diag.videoAttached;
      let vidLine = "—";
      if (!diag.videoAttached) vidLine = "No video";
      else if (vh) vidLine = `RS${vh.readyState}${vh.paused ? " · paused" : ""}`;
      else vidLine = "Attached";
      setTile("video", vidIssue, vidLine, `${vidIssue ? "needs attention" : "healthy"} · ${vidLine}`);
    }
    function setDiagConsoleView(view) {
      if (view !== "compact" && view !== "detailed") return;
      diag.consoleView = view;
      if (diagPanel) {
        diagPanel.classList.toggle("ws-diag-view-compact", view === "compact");
        diagPanel.classList.toggle("ws-diag-view-detailed", view === "detailed");
        const tgl = diagPanel.querySelector("#diagConsoleViewToggle");
        if (tgl) {
          tgl.setAttribute("aria-pressed", view === "detailed" ? "true" : "false");
          tgl.title = view === "compact" ? "Open full dashboard (session metrics & logs)" : "Compact telemetry strip (icons only)";
        }
      }
      persistDiagConsolePrefs();
      if (diagVisible) {
        try {
          const st = getSyncSuggestions();
          applyDiagSectionVisibility(computeDiagCategoryIssues(st));
        } catch {
        }
      }
    }
    function refreshIntelExplorerLink() {
      if (!diagPanel) return;
      const urlEl = diagPanel.querySelector("[data-diag-intel-url]");
      const openBtn = diagPanel.querySelector("#diagOpenIntelExplorer");
      if (!urlEl) return;
      try {
        chrome.storage.local.get(["serverUrl"], (d) => {
          const raw = d.serverUrl && String(d.serverUrl).trim() || "";
          let httpBase = null;
          if (raw) {
            const normalized = /^wss?:\/\//i.test(raw) ? raw : `wss://${raw.replace(/^\/\//, "")}`;
            httpBase = wsUrlToHttpBase(normalized);
          }
          const full = httpBase ? `${String(httpBase).replace(/\/+$/, "")}/diag/intel/explorer` : "";
          diag._intelExplorerUrl = full;
          urlEl.textContent = full || "Set server URL in the extension (same as sync).";
          if (openBtn) {
            openBtn.disabled = !full;
            openBtn.title = full ? "Open intelligence dashboard in a new tab" : "Set server URL in the extension first";
          }
        });
      } catch {
      }
    }
    function updateDiagnosticOverlay() {
      if (!diagPanel || !diagVisible) return;
      refreshIntelExplorerLink();
      const uploadOpt = diagPanel.querySelector("#diagUploadOptIn");
      const uploadAutoStop = diagPanel.querySelector("#diagUploadAutoStop");
      if (uploadOpt && !uploadOpt.dataset.bound) {
        uploadOpt.dataset.bound = "1";
        try {
          chrome.storage.local.get(["playshare_diag_upload_opt_in", "playshare_diag_auto_upload_on_stop"], (r) => {
            uploadOpt.checked = !!r.playshare_diag_upload_opt_in;
            if (uploadAutoStop) {
              uploadAutoStop.checked = !!r.playshare_diag_auto_upload_on_stop;
              uploadAutoStop.disabled = !uploadOpt.checked;
            }
          });
          uploadOpt.addEventListener("change", () => {
            const on = !!uploadOpt.checked;
            chrome.storage.local.set({ playshare_diag_upload_opt_in: on });
            if (uploadAutoStop) {
              if (!on) {
                uploadAutoStop.checked = false;
                chrome.storage.local.set({ playshare_diag_auto_upload_on_stop: false });
              }
              uploadAutoStop.disabled = !on;
            }
          });
        } catch {
        }
      }
      if (uploadAutoStop && !uploadAutoStop.dataset.bound) {
        uploadAutoStop.dataset.bound = "1";
        try {
          uploadAutoStop.addEventListener("change", () => {
            let auto = !!uploadAutoStop.checked;
            if (auto && uploadOpt && !uploadOpt.checked) {
              uploadOpt.checked = true;
              chrome.storage.local.set({ playshare_diag_upload_opt_in: true });
              uploadAutoStop.disabled = false;
            }
            if (!uploadOpt?.checked) auto = false;
            chrome.storage.local.set({ playshare_diag_auto_upload_on_stop: auto });
          });
        } catch {
        }
      }
      const uploadBearerInp = diagPanel.querySelector("#diagUploadBearer");
      if (uploadBearerInp && !uploadBearerInp.dataset.bound) {
        uploadBearerInp.dataset.bound = "1";
        try {
          chrome.storage.local.get(["playshare_diag_upload_bearer"], (r) => {
            const stored = r.playshare_diag_upload_bearer != null ? String(r.playshare_diag_upload_bearer).trim() : "";
            uploadBearerInp.value = stored || DEFAULT_DIAG_UPLOAD_BEARER;
          });
          uploadBearerInp.addEventListener("change", () => {
            const t = String(uploadBearerInp.value || "").trim();
            chrome.storage.local.remove([
              "playshare_diag_upload_session_token",
              "playshare_diag_upload_session_expires_at"
            ]);
            if (!t || t === DEFAULT_DIAG_UPLOAD_BEARER) chrome.storage.local.remove("playshare_diag_upload_bearer");
            else chrome.storage.local.set({ playshare_diag_upload_bearer: t });
          });
        } catch {
        }
      }
      const syncTips = getSyncSuggestions();
      const catIssues = computeDiagCategoryIssues(syncTips);
      diag.tabHidden = document.hidden;
      diag.diagOverlayStale = document.hidden;
      captureVideoHealthSnapshot();
      diag.sidebar.frameExists = !!sidebarFrame;
      diag.sidebar.toggleBtnExists = !!sidebarToggleBtn;
      diag.sidebar.toggleBtnVisible = sidebarToggleBtn ? sidebarToggleBtn.style.display === "flex" : false;
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
          return t > 0 ? `${Math.round(ok / t * 100)}%` : "—";
        };
        const roomOne = roomState ? `${roomState.roomCode} · ${roomState.isHost ? "Host" : "Viewer"} · ${(roomState.members || []).length} in room` : "Not in a room";
        const rtt = diag.timing.lastRttMs != null ? `${Math.round(diag.timing.lastRttMs)} ms` : "—";
        const rttExtra = diag.timing.lastRttSource != null ? ` <span class="ws-diag-muted">(${String(diag.timing.lastRttSource).replace(/_/g, " ")})</span>` : "";
        const drift = diag.timing.driftEwmSec != null ? `${diag.timing.driftEwmSec.toFixed(2)}s` : "—";
        const lastIn = s.lastRecvAt ? formatDiagTimeAgo(s.lastRecvAt) : "never";
        const vb = diag.videoBuffering;
        const vh = diag.videoHealthLast;
        let videoInner = "";
        if (vh) {
          const ct = typeof vh.currentTime === "number" ? vh.currentTime.toFixed(1) : "—";
          const dur = vh.duration != null ? vh.duration.toFixed(0) : "—";
          videoInner = `readyState <strong>${vh.readyState}</strong> · ${vh.paused ? "paused" : "playing"} · <code>t=${ct}s</code> / ${dur}s`;
        } else {
          videoInner = diag.videoAttached ? "Attached (no snapshot yet)" : '<span class="ws-diag-warn">No &lt;video&gt;</span>';
        }
        const cs = diag.clusterSync;
        const clusterLine = cs ? cs.label : "No cluster snapshot yet";
        const sw = diag.serviceWorkerTransport;
        const swShort = sw ? `WS open/close ${sw.wsOpenCount}/${sw.wsCloseCount} · send fail ${sw.wsSendFailures ?? 0}` : "Overlay closed — open for SW stats";
        const eo = diag.extensionOps;
        const msgFail = diag.messaging.runtimeSendFailures ?? 0;
        const phaseStr = diag.transportPhase != null && String(diag.transportPhase).trim() !== "" ? String(diag.transportPhase).trim() : "";
        const connNorm = String(c).trim().toLowerCase();
        const connectionExtra = phaseStr && phaseStr.toLowerCase() !== connNorm ? ` <span class="ws-diag-muted">· ${phaseStr}</span>` : "";
        const anyAttention = catIssues.multiplayer || catIssues.server || catIssues.technical || catIssues.logs || siteSync.key === "prime" && catIssues.prime;
        let primeRow = "";
        if (siteSync.key === "prime" && diag.primeSync) {
          const p = diag.primeSync;
          const driftP = typeof p.viewerDriftSec === "number" && !Number.isNaN(p.viewerDriftSec) ? `${p.viewerDriftSec >= 0 ? "+" : ""}${p.viewerDriftSec.toFixed(2)}s` : "—";
          primeRow = `
          <div class="ws-diag-session-cell ws-diag-session-span2">
            <span class="ws-diag-session-label">Prime</span>
            <div>SDK shell <strong>${p.inSdkShell ? "yes" : "no"}</strong> · ${p.adDetectorActive ? '<span class="ws-diag-warn">Ad UI</span>' : "Content"} · viewer Δhost <strong>${driftP}</strong> · ad score ${p.adScore}</div>
          </div>`;
        }
        dashSummaryEl.innerHTML = `
        <div class="ws-diag-session-grid">
          <div class="ws-diag-session-cell">
            <span class="ws-diag-session-label">Connection</span>
            <div><span class="ws-diag-chip ws-diag-chip-${["connected", "disconnected", "syncing", "reconnecting"].includes(c) ? c : "unknown"}">${c}</span>${connectionExtra}</div>
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
          <span class="ws-diag-chip ws-diag-chip-${diag.tabHidden ? "syncing" : "connected"}">${diag.tabHidden ? "Tab hidden" : "Tab active"}</span>
        </div>
        ${anyAttention ? '<div class="ws-diag-overview-hint ws-diag-warn">Some rows above or categories show <strong>Attention</strong> — use sections below to trace the path.</div>' : '<div class="ws-diag-overview-hint ws-diag-muted">Live session snapshot — expand categories as needed.</div>'}
        <div class="ws-diag-overview-hint ws-diag-muted" style="margin-top:6px">Full support bundle: <strong>Record &amp; export</strong> (just below) → step 1 record, step 2 export. Compact bar: <strong>Record</strong> + <strong>Export</strong>.</div>
      `;
      }
      if (dashAlertsEl) {
        const errN = diag.errors.length;
        const parts = [];
        if (errN) {
          parts.push(
            `<div class="ws-diag-alert ws-diag-warn">${errN} error${errN > 1 ? "s" : ""} — open <strong>Logs &amp; sidebar</strong>.</div>`
          );
        }
        for (const t of syncTips.filter((x) => x.level === "warn").slice(0, 4)) {
          parts.push(`<div class="ws-diag-alert ws-diag-warn">${t.text}</div>`);
        }
        dashAlertsEl.innerHTML = parts.join("");
        dashAlertsEl.style.display = parts.length ? "block" : "none";
      }
      if (sidebarEl) {
        const s = diag.sidebar;
        const toggleAgo = s.lastToggleAt ? formatDiagTime(s.lastToggleAt) : "never";
        sidebarEl.innerHTML = `
        <div>Sidebar: <span class="ws-diag-${sidebarVisible ? "ok" : "warn"}">${sidebarVisible ? "Open" : "Closed"}</span></div>
        <div>Frame: ${s.frameExists ? "✓" : "✗"} | Btn: ${s.toggleBtnVisible ? "✓" : "✗"}</div>
        <div>TOGGLE received: ${s.toggleReceived}x (${toggleAgo})</div>
        <div>Room: ${roomState ? "yes" : "no"} (need room for sidebar)</div>
      `;
      }
      if (msgsEl) {
        msgsEl.innerHTML = diag.recentMessages.length ? diag.recentMessages.slice(0, 5).map((m) => {
          const d = m.detail ? m.detail.fromUsername || m.detail.source || m.detail.text || "" : "";
          return `<div class="ws-diag-row">${m.event} ${d ? String(d).slice(0, 25) : ""} ${formatDiagTime(m.t)}</div>`;
        }).join("") : '<div class="ws-diag-row ws-diag-muted">No events yet</div>';
      }
      if (errsEl) {
        errsEl.innerHTML = diag.errors.length ? diag.errors.slice(0, 3).map((e) => `<div class="ws-diag-row ws-diag-err">${e.detail?.message || e.event} ${formatDiagTime(e.t)}</div>`).join("") : '<div class="ws-diag-row ws-diag-muted">No errors</div>';
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
        const filterInp = diagPanel.querySelector("#diagEventFilter");
        if (filterInp && filterInp.value !== s.eventFilter) filterInp.value = s.eventFilter;
        if (staleEl) {
          if (diag.tabHidden) {
            staleEl.classList.add("visible");
            staleEl.textContent = "Tab hidden — remote play/pause may wait until you return to this tab.";
          } else {
            staleEl.classList.remove("visible");
            staleEl.textContent = "";
          }
        }
        if (profileLineEl) {
          const iv = playbackProfile;
          profileLineEl.innerHTML = `<div class="ws-diag-row"><code>${iv.handlerKey}</code> · host pos ${iv.hostPositionIntervalMs}ms · reconcile ${iv.viewerReconcileIntervalMs}ms · apply debounce ${iv.applyDebounceMs}ms · outbound coalesce ${iv.playbackOutboundCoalesceMs ?? 0}ms · slack ${iv.playbackSlackSec != null ? iv.playbackSlackSec + "s" : "—"}</div>`;
        }
        if (timingEl) {
          const rtt = diag.timing.lastRttMs != null ? `${Math.round(diag.timing.lastRttMs)}ms` : "—";
          const ewm = diag.timing.driftEwmSec != null ? `${diag.timing.driftEwmSec.toFixed(3)}s` : "—";
          const lastRecv = s.lastRecvAt ? formatDiagTimeAgo(s.lastRecvAt) : "never";
          const rttSrc = diag.timing.lastRttSource || "—";
          timingEl.innerHTML = `
          <div class="ws-diag-row">RTT <strong>${rtt}</strong> <span class="ws-diag-muted">(${rttSrc})</span></div>
          <div class="ws-diag-row">Drift EWM (post-apply): <strong>${ewm}</strong></div>
          <div class="ws-diag-row ws-diag-muted">Last inbound sync: ${lastRecv}</div>
        `;
        }
        if (videoHealthEl) {
          const h = diag.videoHealthLast;
          const vb = diag.videoBuffering;
          videoHealthEl.innerHTML = h ? `<div class="ws-diag-row">readyState ${h.readyState} | paused ${h.paused} | seeking ${h.seeking} | rate ${h.playbackRate}</div>
             <div class="ws-diag-row">t=${h.currentTime}s / ${h.duration != null ? h.duration + "s" : "—"}</div>
             <div class="ws-diag-row ws-diag-muted"><code>waiting</code>×${vb.waiting} <code>stalled</code>×${vb.stalled} (rebuffer — compare with sync applies)</div>
             <div class="ws-diag-row ws-diag-muted">buffered: ${(h.bufferedRanges || []).map((x) => `[${x[0]}-${x[1]}]`).join(" ") || "—"}</div>
             <div class="ws-diag-row ws-diag-muted">${h.currentSrc || "—"}</div>` : `<div class="ws-diag-row ws-diag-muted">No video element</div>
             <div class="ws-diag-row ws-diag-muted"><code>waiting</code>×${vb.waiting} <code>stalled</code>×${vb.stalled}</div>`;
        }
        const recToggle = diagPanel.querySelector("#diagCompactRecordToggle");
        const recLabel = diagPanel.querySelector('[data-diag="compact-rec-label"]');
        const profilerMarkerBtn = diagPanel.querySelector("#diagVideoProfilerMarker");
        try {
          const recording = getVideoProfiler().isRecording();
          const v = findVideo() || video;
          const canStart = !!v;
          if (profilerMarkerBtn) {
            profilerMarkerBtn.disabled = !recording;
            profilerMarkerBtn.title = recording ? "Add a labeled point in the JSON timeline" : "Start recording first to add markers";
          }
          if (recToggle && recLabel) {
            recToggle.classList.toggle("ws-diag-compact-rec-active", recording);
            recToggle.setAttribute("aria-pressed", recording ? "true" : "false");
            recLabel.textContent = recording ? "Stop" : "Record";
            recToggle.disabled = recording ? false : !canStart;
            recToggle.title = recording ? "Stop recording (may trigger auto-upload to intelligence pipeline)" : !canStart ? "Start playback first — then record" : "Start profiler recording for export + optional server intelligence";
          }
        } catch {
          if (profilerMarkerBtn) profilerMarkerBtn.disabled = true;
          if (recToggle) recToggle.disabled = false;
          if (recLabel) recLabel.textContent = "Record";
        }
        if (findVideoEl) {
          const fv = diag.findVideo;
          findVideoEl.innerHTML = `<div class="ws-diag-row">cache hits: ${fv.cacheReturns} | full scans: ${fv.fullScans} | invalidations: ${fv.invalidations} | attaches: ${fv.videoAttachCount}</div>`;
        }
        const primeMissedStatusEl = diagPanel.querySelector('[data-diag="prime-missed-ad-status"]');
        if (primeMissedStatusEl) {
          if (diag.lastPrimeMissedAdCapture) {
            const c = diag.lastPrimeMissedAdCapture;
            primeMissedStatusEl.textContent = `Ad JSON: ${formatDiagTimeAgo(c.at)} · ${c.clipboardOk ? "clipboard ok" : "clipboard failed"}`;
          } else {
            primeMissedStatusEl.textContent = "Ad JSON: not yet";
          }
        }
        const primeSummaryEl = diagPanel.querySelector('[data-diag="sync-prime-summary"]');
        const primeQuietEl = diagPanel.querySelector('[data-diag-quiet="prime"]');
        if (primeSummaryEl || primeQuietEl) {
          if (diag.primeSync) {
            refreshPrimeSyncTelemetry();
            const p = diag.primeSync;
            const drift = typeof p.viewerDriftSec === "number" && !Number.isNaN(p.viewerDriftSec) ? `${p.viewerDriftSec >= 0 ? "+" : ""}${p.viewerDriftSec.toFixed(2)}s` : "—";
            const sel = p.selectorThatMatched ? String(p.selectorThatMatched).replace(/</g, "&lt;") : "—";
            const reasonsStr = p.adReasons && p.adReasons.length ? p.adReasons.map((r) => String(r).replace(/&/g, "&amp;").replace(/</g, "&lt;")).join(", ") : "none";
            if (primeSummaryEl) {
              primeSummaryEl.innerHTML = `
            <div><span class="ws-diag-${p.inSdkShell ? "ok" : "warn"}">Shell ${p.inSdkShell ? "✓" : "?"}</span> · Ad cues <strong>${p.adScore}</strong> · <span class="ws-diag-${p.adDetectorActive ? "warn" : "ok"}">${p.adDetectorActive ? "IN AD" : "content"}</span> · room ad hold ${p.extensionLocalAd ? "on" : "off"} · peers in ad ${p.peersInAd}</div>
            <div class="ws-diag-muted" style="margin-top:4px">Channels: ${reasonsStr}</div>
            <div style="margin-top:4px">Viewer Δ host <strong>${drift}</strong> · <code>${sel}</code></div>
          `;
            }
            if (primeQuietEl) {
              primeQuietEl.textContent = `Shell ${p.inSdkShell ? "OK" : "check"} · ${p.adDetectorActive ? "Ad UI" : "Content"} · Δhost ${drift}`;
            }
          } else {
            if (primeSummaryEl) primeSummaryEl.innerHTML = '<span class="ws-diag-muted">Prime telemetry not active.</span>';
            if (primeQuietEl) primeQuietEl.textContent = "Prime telemetry not active yet.";
          }
        }
        if (tuJumpsEl) {
          const jumps = diag.timeupdateJumps.slice(0, 6);
          tuJumpsEl.innerHTML = jumps.length ? jumps.map((j) => `<div class="ws-diag-row">${j.deltaSec}s jump (${j.from}→${j.to}) ${formatDiagTimeAgo(j.t)}</div>`).join("") : '<div class="ws-diag-row ws-diag-muted">No large jumps logged</div>';
        }
        if (timelineEl) {
          const tl = (diag.timing.timeline || []).slice(0, 12);
          timelineEl.innerHTML = tl.length ? tl.map((e) => {
            const cid = e.correlationId ? String(e.correlationId).slice(0, 8) + "…" : "";
            const extra = [e.kind, e.driftSec != null ? `Δ${e.driftSec.toFixed(2)}s` : "", e.latencyMs != null ? `${e.latencyMs}ms` : "", cid ? `id:${cid}` : ""].filter(Boolean).join(" ");
            return `<div class="ws-diag-row ws-diag-muted">${extra} ${formatDiagTimeAgo(e.t)}</div>`;
          }).join("") : '<div class="ws-diag-row ws-diag-muted">No timeline entries</div>';
        }
        if (serverTraceEl) {
          const tr = (diag.serverRoomTrace || []).slice(-12).reverse();
          serverTraceEl.innerHTML = tr.length ? tr.map((e) => {
            const id = e.correlationId ? String(e.correlationId).slice(0, 8) + "…" : "";
            return `<div class="ws-diag-row">${e.type} ${e.fromUsername || ""} <span class="ws-diag-muted">${id}</span> ${formatDiagTimeAgo(e.t)}</div>`;
          }).join("") : '<div class="ws-diag-row ws-diag-muted">Open panel or tap Refresh to load server ring buffer</div>';
        }
        if (thisDeviceEl) {
          const pol = roomState != null ? `hostOnly ${roomState.hostOnlyControl ? "on" : "off"} · countdown ${roomState.countdownOnPlay ? "on" : "off"}` : "—";
          const cs = diag.clusterSync;
          const clusterLine = cs ? `<div class="ws-diag-row">${cs.label}${cs.staleCount ? ` · ${cs.staleCount} stale reports` : ""}${cs.freshMemberCount != null ? ` · ${cs.freshMemberCount} fresh` : ""}</div>` : '<div class="ws-diag-row ws-diag-muted">No cluster snapshot yet</div>';
          thisDeviceEl.innerHTML = `
          <div class="ws-diag-row">${platform.name} · Tab <strong>${diag.tabHidden ? "hidden" : "visible"}</strong></div>
          <div class="ws-diag-row ws-diag-muted">Room rules: ${pol}</div>
          ${clusterLine}
        `;
        }
        if (extensionBridgeEl) {
          const eo = diag.extensionOps;
          const sw = diag.serviceWorkerTransport;
          const msg = diag.messaging;
          const swLine = sw ? `SW WS opens ${sw.wsOpenCount} / closes ${sw.wsCloseCount} · send failures ${sw.wsSendFailures ?? 0} · ${sw.serverHost || "?"}` : "SW transport: open overlay / export to refresh";
          extensionBridgeEl.innerHTML = `
          <div class="ws-diag-row">SYNC_STATE in <strong>${eo.syncStateInbound}</strong> · applied <strong>${eo.syncStateApplied}</strong> · skip (redundant) <strong>${eo.syncStateSkippedRedundant ?? 0}</strong> · deferred (no &lt;video&gt;) <strong>${eo.syncStateDeferredNoVideo}</strong> · deferred (stale) <strong>${eo.syncStateDeferredStaleOrMissing}</strong></div>
          <div class="ws-diag-row">Remote SEEK skipped (decision engine) <strong>${eo.remoteSeekSuppressedDecision ?? 0}</strong> · while &lt;video&gt;.seeking <strong>${eo.remoteSeekSuppressedVideoSeeking ?? 0}</strong></div>
          <div class="ws-diag-row">SyncDecisionEngine reject: reconnect settle <strong>${eo.syncDecisionRejectedReconnectSettle ?? 0}</strong> · apply cooldown <strong>${eo.syncDecisionRejectedCooldown ?? 0}</strong></div>
          <div class="ws-diag-row">SYNC_STATE denied: syncLock <strong>${eo.syncStateDeniedSyncLock}</strong> · playback debounce <strong>${eo.syncStateDeniedPlaybackDebounce}</strong> · flushed <strong>${eo.syncStateFlushedOnVideoAttach}</strong> · pending <strong>${diag.pendingSyncStateQueued ? "yes" : "no"}</strong></div>
          <div class="ws-diag-row">Remote PLAY/PAUSE/SEEK denied: syncLock <strong>${eo.remoteApplyDeniedSyncLock}</strong> · playback debounce <strong>${eo.remoteApplyDeniedPlaybackDebounce}</strong> · deferred (tab hidden path) <strong>${eo.remoteApplyDeferredTabHidden}</strong></div>
          <div class="ws-diag-row ws-diag-muted">DRM UI: prompts <strong>${eo.drmSyncPromptsShown}</strong> · confirmed <strong>${eo.drmSyncConfirmed}</strong> · seek skipped (&lt;thr) <strong>${eo.drmSeekSkippedUnderThreshold}</strong> · handler <strong>${playbackProfile.handlerKey}</strong></div>
          <div class="ws-diag-row ws-diag-muted">Local host-only blocks <strong>${eo.localControlBlockedHostOnly}</strong></div>
          <div class="ws-diag-row">Host position msgs <strong>${eo.hostPlaybackPositionSent}</strong> · viewer SYNC_REQUEST <strong>${eo.viewerSyncRequestSent}</strong> · POSITION_REPORT ×<strong>${eo.positionReportSent}</strong> · POSITION_SNAPSHOT in ×<strong>${eo.positionSnapshotInbound}</strong> · remote countdown <strong>${eo.countdownStartRemote}</strong></div>
          <div class="ws-diag-row ws-diag-muted">→ BG send: lastError ×${msg.runtimeSendFailures} · throws ×${msg.sendThrowCount}${msg.runtimeLastErrorMessage ? ` · ${String(msg.runtimeLastErrorMessage).slice(0, 48)}` : ""}</div>
          <div class="ws-diag-row ws-diag-muted">Chat in ${eo.chatReceived} · system ${eo.systemMsgsReceived} (playback dedupe ${eo.playbackSystemMsgsDeduped}) · ERROR ${eo.serverErrors} · tab WS_DISCONNECTED ${eo.wsDisconnectEvents}</div>
          <div class="ws-diag-row ws-diag-muted">${swLine}</div>
        `;
        }
        if (metricsEl) {
          const rate = (ok, fail) => {
            const t = ok + fail;
            return t > 0 ? `${Math.round(ok / t * 100)}%` : "—";
          };
          const testExtra = s.testResults?.done && s.testResults.peerTimeouts != null ? `<div class="ws-diag-row ws-diag-muted">Soak: peer wait timeouts ${s.testResults.peerTimeouts}</div>` : "";
          metricsEl.innerHTML = `
          <div class="ws-diag-row"><strong>▶</strong> ${m.playOk}✓ ${m.playFail}✗ (${rate(m.playOk, m.playFail)}) · ${m.playSent}→sent ${m.playRecv}←in</div>
          <div class="ws-diag-row"><strong>⏸</strong> ${m.pauseOk}✓ ${m.pauseFail}✗ (${rate(m.pauseOk, m.pauseFail)}) · ${m.pauseSent}→ ${m.pauseRecv}←</div>
          <div class="ws-diag-row"><strong>⏩</strong> ${m.seekOk}✓ ${m.seekFail}✗ (${rate(m.seekOk, m.seekFail)}) · ${m.seekSent}→ ${m.seekRecv}←</div>
          ${s.testRunning ? '<div class="ws-diag-row ws-diag-warn">Sync test running…</div>' : ""}
          ${s.testResults?.done ? `<div class="ws-diag-row ws-diag-muted">Last test ${((Date.now() - s.testResults.start) / 1e3).toFixed(1)}s${s.testResults.soakRounds > 1 ? ` ×${s.testResults.soakRounds}` : ""}</div>` : ""}
          ${testExtra}
        `;
        }
        if (peersEl) {
          const peers = Object.entries(s.peerReports);
          const sampleByPeer = diag.peerRecordingSamples.byClient;
          const sampleKeys = Object.keys(sampleByPeer);
          const peerSamplesLine = diagnosticsUiEnabled && sampleKeys.length > 0 ? `<div class="ws-diag-row ws-diag-muted">Profiler peer samples (unified export): ${sampleKeys.map((cid) => {
            const rows = sampleByPeer[cid];
            const u = rows && rows[0] && typeof rows[0].fromUsername === "string" ? rows[0].fromUsername : "";
            return `${u || String(cid).slice(0, 8) + "…"} ×${rows?.length ?? 0}`;
          }).join(" · ")} · every ${DIAG_PEER_DEV_SHARE_MS / 1e3}s while a dev peer records</div>` : "";
          const peerHint = diagnosticsUiEnabled ? " Dev peers stream compact samples to the tab that is recording the video profiler; unified JSON includes them. Otherwise use Request peer report." : "";
          peersEl.innerHTML = peerSamplesLine + (peers.length ? peers.map(([cid, r]) => {
            const ago = formatDiagTimeAgo(r.lastReceived);
            const pm = r.metrics || {};
            const pPlay = (pm.playOk || 0) + (pm.playFail || 0) > 0 ? ((pm.playOk || 0) / ((pm.playOk || 0) + (pm.playFail || 0)) * 100).toFixed(0) : "—";
            const pPause = (pm.pauseOk || 0) + (pm.pauseFail || 0) > 0 ? ((pm.pauseOk || 0) / ((pm.pauseOk || 0) + (pm.pauseFail || 0)) * 100).toFixed(0) : "—";
            const pSeek = (pm.seekOk || 0) + (pm.seekFail || 0) > 0 ? ((pm.seekOk || 0) / ((pm.seekOk || 0) + (pm.seekFail || 0)) * 100).toFixed(0) : "—";
            const dd = r.devDiag;
            let devLines = "";
            if (dd && typeof dd === "object") {
              const tim = (
                /** @type {{ lastRttMs?: number, lastRttSource?: string, driftEwmSec?: number }} */
                dd.timing || {}
              );
              const tr = (
                /** @type {{ connectionStatus?: string, transportPhase?: string }} */
                dd.transport || {}
              );
              const cs = (
                /** @type {{ spreadSec?: number, synced?: boolean }|null} */
                dd.clusterSync || null
              );
              const pb = (
                /** @type {{ ct?: number|null, playing?: boolean|null, rs?: number|null }} */
                dd.playback || {}
              );
              const vp = (
                /** @type {{ snapshotCount?: number, recording?: boolean }|null} */
                dd.videoProfiler || null
              );
              const parts = [];
              if (typeof tim.lastRttMs === "number") {
                parts.push(
                  `RTT ${Math.round(tim.lastRttMs)}ms${tim.lastRttSource ? ` (${tim.lastRttSource})` : ""}`
                );
              }
              if (typeof tim.driftEwmSec === "number") parts.push(`drift EWM ${tim.driftEwmSec.toFixed(2)}s`);
              if (tr.connectionStatus) parts.push(`${tr.connectionStatus}${tr.transportPhase ? ` · ${tr.transportPhase}` : ""}`);
              if (cs && typeof cs.spreadSec === "number") {
                parts.push(`cluster Δ${cs.spreadSec.toFixed(2)}s${cs.synced ? " ✓" : ""}`);
              }
              if (pb && pb.ct != null) {
                parts.push(`t=${pb.ct}s${pb.playing ? " ▶" : " ⏸"}`);
              }
              if (vp && typeof vp.snapshotCount === "number") {
                parts.push(`profiler ${vp.snapshotCount} snaps${vp.recording ? " · rec" : ""}`);
              }
              if (parts.length) {
                devLines = `<div class="ws-diag-row ws-diag-muted" style="font-size:11px;line-height:1.35">${parts.join(" · ")}</div>`;
              }
            }
            return `<div class="ws-diag-peer">
                <div class="ws-diag-row">${r.username || cid} (${r.platform || "?"}) ${r.isHost ? "👑" : ""}</div>
                <div class="ws-diag-row ws-diag-muted">Play ${pPlay}% | Pause ${pPause}% | Seek ${pSeek}% | ${ago}</div>
                ${devLines}
              </div>`;
          }).join("") : `<div class="ws-diag-row ws-diag-muted">No peer report rows yet.${peerHint} Manual: Request peer report.</div>`);
        }
        if (remoteEl) {
          const rem = s.remoteApplyResults.slice(0, 10);
          remoteEl.innerHTML = rem.length ? rem.map((r) => {
            const status = r.success ? "✓" : "✗";
            const ago = formatDiagTimeAgo(r.t);
            const cid = r.correlationId ? ` id:${String(r.correlationId).slice(0, 8)}…` : "";
            return `<div class="ws-diag-row ws-diag-${r.success ? "ok" : "err"}">${r.eventType}: ${r.fromUsername} → ${status} ${r.latency}ms (${r.platform})${cid} ${ago}</div>`;
          }).join("") : '<div class="ws-diag-row ws-diag-muted">When you send play/pause/seek, peers report back here</div>';
        }
        if (suggestionsEl) {
          suggestionsEl.innerHTML = syncTips.map((t) => `<div class="ws-diag-row ws-diag-${t.level}">${t.text}</div>`).join("") || '<div class="ws-diag-row ws-diag-muted">No suggestions</div>';
        }
        if (eventsEl) {
          const filt = (s.eventFilter || "").trim().toLowerCase();
          const evs = s.events.filter((e) => !filt || `${e.type} ${e.fromUsername || ""} ${e.correlationId || ""}`.toLowerCase().includes(filt)).slice(0, 14);
          eventsEl.innerHTML = evs.length ? evs.map((e) => {
            const type = e.type.replace("_", " ");
            const extra = e.latency ? ` ${e.latency}ms` : e.drift ? ` drift ${e.drift.toFixed(1)}s` : "";
            const ago = formatDiagTimeAgo(e.t);
            const cid = e.correlationId ? ` [${String(e.correlationId).slice(0, 6)}]` : "";
            return `<div class="ws-diag-row ws-diag-sync-${e.type.replace(/_/g, "-")}">${type} ${e.fromUsername || ""}${cid} ${extra} ${ago}</div>`;
          }).join("") : '<div class="ws-diag-row ws-diag-muted">No sync events yet (adjust filter)</div>';
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
        diagOverlay.style.display = "flex";
        diagOverlay.setAttribute("aria-hidden", "false");
        try {
          chrome.runtime.sendMessage({ source: "playshare", type: "GET_DIAG" }, (res) => {
            mergeServiceWorkerDiag(res);
            updateDiagnosticOverlay();
          });
        } catch {
        }
        updateDiagnosticOverlay();
        diagRefreshInterval = setInterval(() => {
          try {
            chrome.runtime.sendMessage({ source: "playshare", type: "GET_DIAG" }, (res) => {
              mergeServiceWorkerDiag(res);
              updateDiagnosticOverlay();
            });
          } catch {
            updateDiagnosticOverlay();
          }
        }, 2e3);
        sendDiagReport();
        sendBg({ source: "playshare", type: "DIAG_ROOM_TRACE_REQUEST" });
      } else if (diagOverlay) {
        closeDiagDashModal();
        diagOverlay.style.display = "none";
        diagOverlay.setAttribute("aria-hidden", "true");
        if (diagRefreshInterval) {
          clearInterval(diagRefreshInterval);
          diagRefreshInterval = null;
        }
      }
      if (siteSync.key === "prime") syncPrimeTelemetryPolling();
    }
    function mountDeveloperDiagnosticsUi() {
      if (diagToggleBtn) return;
      diagToggleBtn = document.createElement("button");
      diagToggleBtn.id = "ws-diag-toggle";
      diagToggleBtn.title = "Analytics & intelligence (dev) — Ctrl+Shift+D";
      diagToggleBtn.textContent = "◆";
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
      diagToggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleDiagnostic();
      });
      diagToggleBtn.addEventListener("mouseenter", () => {
        diagToggleBtn.style.background = "linear-gradient(165deg, rgba(30,40,48,0.98) 0%, rgba(15,20,28,0.99) 100%)";
        diagToggleBtn.style.borderColor = "rgba(34,211,238,0.5)";
        diagToggleBtn.style.color = "#67e8f9";
        diagToggleBtn.style.transform = "translateY(-2px)";
        diagToggleBtn.style.boxShadow = "0 8px 28px rgba(0,0,0,0.5),0 0 32px -4px rgba(34,211,238,0.35)";
      });
      diagToggleBtn.addEventListener("mouseleave", () => {
        diagToggleBtn.style.background = "linear-gradient(165deg, rgba(22,26,34,0.96) 0%, rgba(10,12,16,0.98) 100%)";
        diagToggleBtn.style.borderColor = "rgba(34,211,238,0.28)";
        diagToggleBtn.style.color = "#22d3ee";
        diagToggleBtn.style.transform = "translateY(0)";
        diagToggleBtn.style.boxShadow = "0 4px 20px rgba(0,0,0,0.45),0 0 24px -6px rgba(34,211,238,0.25)";
      });
      document.body.appendChild(diagToggleBtn);
      reparentPlayShareUiForFullscreen();
      document.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "D") {
          e.preventDefault();
          toggleDiagnostic();
        }
      });
    }
    function injectDiagnosticOverlay() {
      if (!diagnosticsUiEnabled || diagOverlay) return;
      diagOverlay = document.createElement("div");
      diagOverlay.id = "ws-diag-overlay";
      diagOverlay.setAttribute("aria-hidden", "true");
      diagOverlay.style.cssText = `
      display:none;position:fixed;z-index:2147483647;
      left:16px;bottom:16px;top:auto;right:auto;
      flex-direction:column;align-items:flex-start;gap:0;
      font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      font-size:13px;line-height:1.5;pointer-events:auto;
      max-width:calc(100vw - 24px);
    `;
      diagPanel = document.createElement("div");
      diagPanel.className = "ws-diag-panel";
      diagPanel.setAttribute("role", "dialog");
      diagPanel.setAttribute("aria-label", "PlayShare analytics and diagnostic intelligence");
      diagPanel.innerHTML = `
      <div class="ws-diag-header">
        <div class="ws-diag-header-accent" aria-hidden="true"></div>
        <div class="ws-diag-header-main">
          <button type="button" class="ws-diag-drag" title="Drag panel"><span class="ws-diag-drag-grip" aria-hidden="true"></span></button>
          <div class="ws-diag-header-center ws-diag-header-brand">
            <div class="ws-diag-header-title-row">
              <span class="ws-diag-title">Analytics</span>
              <span class="ws-diag-dev-badge">DEV</span>
            </div>
          </div>
          <div class="ws-diag-header-aside">
            <div class="ws-diag-header-icon-rail" role="toolbar" aria-label="Panel">
              <button type="button" class="ws-diag-icon-btn" id="diagWideToggle" title="Wider panel"><span class="ws-diag-icon-wide" aria-hidden="true"></span></button>
              <button type="button" class="ws-diag-icon-btn ws-diag-minimize-btn" title="Minimize"><span class="ws-diag-icon-min" aria-hidden="true"></span></button>
              <button type="button" class="ws-diag-icon-btn ws-diag-close" title="Close (⌃⇧D)"><span class="ws-diag-icon-x" aria-hidden="true"></span></button>
            </div>
          </div>
        </div>
      </div>
      <div class="ws-diag-simplified-body ws-diag-body-scroll">
        <div class="ws-diag-simple-card ws-diag-simple-card-unified">
          <div class="ws-diag-simple-card-title">Record &amp; send</div>
          <p class="ws-diag-simple-card-sub ws-diag-simple-card-sub-tight">Capture a session and upload anonymized diagnostics to your PlayShare server (same host as sync).</p>
          <div class="ws-diag-unified-record-row">
            <button type="button" class="ws-diag-btn ws-diag-btn-hero-rec ws-diag-unified-rec" id="diagCompactRecordToggle" aria-pressed="false" title="Start or stop session recording">
              <span class="ws-diag-rec-dot" aria-hidden="true"></span><span data-diag="compact-rec-label">Record</span>
            </button>
          </div>
          <div class="ws-diag-simple-inline-tools ws-diag-unified-tools">
            <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagVideoProfilerMarker" title="Add a marker while recording">Mark</button>
            <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagVideoProfilerClear" title="Discard captured data without saving">Clear</button>
            ${siteSync.key === "prime" ? `<button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm ws-diag-btn-missed-ad diag-prime-missed-ad-btn" title="Prime ad-debug JSON (separate file)">Ad snap</button>` : ""}
          </div>
          <div class="ws-diag-report-divider ws-diag-unified-divider" aria-hidden="true"></div>
          <label class="ws-diag-simple-check"><input type="checkbox" id="diagUploadOptIn" /><span>Allow uploads to my server</span></label>
          <label class="ws-diag-simple-check"><input type="checkbox" id="diagUploadAutoStop" /><span>Send automatically when I stop recording</span></label>
          <div class="ws-diag-upload-token-block">
            <label class="ws-diag-filter-label" for="diagUploadBearer">Upload access secret</label>
            <input type="text" id="diagUploadBearer" class="ws-diag-filter" placeholder="Used once to mint a scoped upload token from your server" autocomplete="off" spellcheck="false" />
            <p class="ws-diag-simple-card-sub ws-diag-upload-token-hint">If your server has no upload secret, leave this empty. Uploads do not require being in a live room; this secret is exchanged for a scoped token.</p>
          </div>
          <button type="button" class="ws-diag-btn ws-diag-btn-primary ws-diag-btn-sm ws-diag-unified-send-btn" id="diagUploadAnonymized">Send now</button>
        </div>

        <div class="ws-diag-simple-card ws-diag-simple-card-intel">
          <div class="ws-diag-simple-card-title">Intelligence</div>
          <div class="ws-diag-simple-btn-row">
            <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagOpenIntelExplorer" disabled>Open dashboard</button>
            <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagCopyIntelUrl">Copy link</button>
          </div>
          <details class="ws-diag-details ws-diag-details-more ws-diag-intel-url-details">
            <summary class="ws-diag-more-summary">Show URL</summary>
            <div class="ws-diag-intel-url-box" style="margin-top:8px"><code class="ws-diag-intel-url" data-diag-intel-url>…</code></div>
          </details>
        </div>

        <div id="ws-diag-advanced-gate" class="ws-diag-advanced-gate">
          <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagRevealAdvancedConsole" title="Detailed multiplayer, server, and sync metrics">Live sync console…</button>
        </div>
        <div class="ws-diag-advanced-details" id="ws-diag-advanced-console" hidden>
          <div class="ws-diag-advanced-inner">
            <div class="ws-diag-advanced-toolbar">
              <button type="button" class="ws-diag-btn ws-diag-btn-ghost ws-diag-btn-sm" id="diagHideAdvancedConsole" title="Hide live sync console">Hide</button>
              <button type="button" class="ws-diag-btn ws-diag-btn-ghost ws-diag-btn-sm" id="diagDashCustomizeOpen">Section layout…</button>
              <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagSyncTest">Sync test</button>
              <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagSyncTestSoak">Test ×5</button>
              <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagSyncReport">Peer report</button>
              <button type="button" class="ws-diag-btn ws-diag-btn-secondary ws-diag-btn-sm" id="diagSyncReset">Reset</button>
              <button type="button" class="ws-diag-btn ws-diag-btn-ghost ws-diag-btn-sm" id="diagThemeToggle">Theme</button>
            </div>
        <div data-diag="sync-stale" class="ws-diag-stale-banner" aria-live="polite"></div>

        <div data-diag-dash-block="overview">
        <div class="ws-diag-section-label">Session overview</div>
        <div data-diag="dash-summary" class="ws-diag-dash-summary"></div>
        </div>
        <div data-diag-dash-block="alerts">
        <div data-diag="dash-alerts" class="ws-diag-dash-alerts" aria-live="polite"></div>
        </div>

        ${siteSync.key === "prime" ? `<div class="ws-diag-prime-wrap" data-diag-sec-wrap="prime" data-diag-dash-block="prime">
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
            <span data-diag="prime-missed-ad-status"></span><span class="ws-diag-status-sep"> · </span><span>Prime digest is included in <strong>Send now</strong> / auto-send uploads.</span>
          </div>
        </div>` : ""}

        <div class="ws-diag-section-label ws-diag-section-label-tight">Live metrics</div>

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
                <strong>Video profiler</strong> — use <strong>Record</strong> at the top of this panel. Peer samples during recording appear under <strong>Multiplayer → Peers</strong> below.
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
        </div>
      </div>
      <div id="diagDashModalRoot" class="ws-diag-dash-modal-root" hidden aria-hidden="true">
        <div class="ws-diag-dash-modal-backdrop" data-diag-dash-modal-dismiss tabindex="-1" aria-hidden="true"></div>
        <div class="ws-diag-dash-modal-panel" role="dialog" aria-modal="true" aria-labelledby="diagDashModalTitle" tabindex="-1">
          <div class="ws-diag-dash-modal-head">
            <h2 id="diagDashModalTitle" class="ws-diag-dash-modal-title">Customize dashboard</h2>
            <button type="button" class="ws-diag-dash-modal-x" id="diagDashCustomizeClose" aria-label="Close">×</button>
          </div>
          <p class="ws-diag-dash-modal-lead">Show or hide sections inside the <strong>live sync console</strong>.</p>
          <div class="ws-diag-dash-toggles ws-diag-dash-modal-toggles" data-diag-dash-customize>
            <label class="ws-diag-dash-toggle"><input type="checkbox" data-dash-toggle="overview" checked /> Session overview</label>
            <label class="ws-diag-dash-toggle"><input type="checkbox" data-dash-toggle="alerts" checked /> Alerts</label>
            ${siteSync.key === "prime" ? '<label class="ws-diag-dash-toggle"><input type="checkbox" data-dash-toggle="prime" checked /> Prime</label>' : ""}
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
        if (e.key !== "Escape" || !diagVisible) return;
        const root = diagPanel.querySelector("#diagDashModalRoot");
        if (!root || root.hasAttribute("hidden")) return;
        e.preventDefault();
        e.stopPropagation();
        closeDiagDashModal();
      };
      document.addEventListener("keydown", diagDashModalOnEscape);
      const closeBtn = diagPanel.querySelector(".ws-diag-close");
      closeBtn.addEventListener("click", toggleDiagnostic);
      diagPanel.querySelector(".ws-diag-minimize-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        diag.panelMinimized = !diag.panelMinimized;
        if (diag.panelMinimized) closeDiagDashModal();
        diagPanel.classList.toggle("ws-diag-minimized", diag.panelMinimized);
      });
      diagPanel.querySelector("#diagWideToggle")?.addEventListener("click", (e) => {
        e.stopPropagation();
        diag.overlayWide = !diag.overlayWide;
        diagPanel.classList.toggle("ws-diag-wide", diag.overlayWide);
      });
      diagPanel.querySelector("#diagOpenIntelExplorer")?.addEventListener("click", () => {
        const u = diag._intelExplorerUrl;
        if (u) window.open(u, "_blank", "noopener,noreferrer");
      });
      diagPanel.querySelector("#diagCopyIntelUrl")?.addEventListener("click", async () => {
        const u = diag._intelExplorerUrl;
        if (!u) return;
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(u);
            showToast("Intelligence link copied");
          }
        } catch {
        }
      });
      diagPanel.querySelector("#diagCompactRecordToggle")?.addEventListener("click", () => {
        try {
          if (getVideoProfiler().isRecording()) stopVideoProfilerSession();
          else startVideoProfilerSession();
        } catch {
          diagLog("ERROR", { message: "Profiler toggle failed" });
        }
        updateDiagnosticOverlay();
      });
      diagPanel.querySelector("#diagRevealAdvancedConsole")?.addEventListener("click", () => {
        const shell = diagPanel.querySelector("#ws-diag-advanced-console");
        const gate = diagPanel.querySelector("#ws-diag-advanced-gate");
        shell?.removeAttribute("hidden");
        gate?.setAttribute("hidden", "");
        updateDiagnosticOverlay();
        queueMicrotask(() => shell?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      });
      diagPanel.querySelector("#diagHideAdvancedConsole")?.addEventListener("click", () => {
        const shell = diagPanel.querySelector("#ws-diag-advanced-console");
        const gate = diagPanel.querySelector("#ws-diag-advanced-gate");
        shell?.setAttribute("hidden", "");
        gate?.removeAttribute("hidden");
      });
      diagPanel.querySelector("#diagDashCustomizeOpen")?.addEventListener("click", (e) => {
        e.stopPropagation();
        openDiagDashModal();
      });
      diagPanel.querySelector("#diagDashCustomizeClose")?.addEventListener("click", (e) => {
        e.stopPropagation();
        closeDiagDashModal();
      });
      diagPanel.querySelector("#diagDashCustomizeDone")?.addEventListener("click", (e) => {
        e.stopPropagation();
        closeDiagDashModal();
      });
      diagPanel.querySelector("#diagDashModalReset")?.addEventListener("click", (e) => {
        e.stopPropagation();
        for (const k of Object.keys(diag.dashBlocks)) diag.dashBlocks[k] = true;
        persistDiagConsolePrefs();
        applyDashboardBlockVisibility();
        syncDashLayoutCheckboxesFromDiag();
      });
      diagPanel.querySelector("#diagDashModalRoot")?.addEventListener("click", (e) => {
        const t = e.target;
        if (t instanceof Element && t.closest("[data-diag-dash-modal-dismiss]")) closeDiagDashModal();
      });
      diagPanel.addEventListener("change", (e) => {
        const t = e.target;
        if (!(t instanceof HTMLInputElement) || t.type !== "checkbox") return;
        const key = t.getAttribute("data-dash-toggle");
        if (!key || !(key in diag.dashBlocks)) return;
        diag.dashBlocks[key] = t.checked;
        persistDiagConsolePrefs();
        applyDashboardBlockVisibility();
      });
      diagPanel.addEventListener("click", (e) => {
        const compBtn = e.target.closest("[data-diag-comp]");
        if (compBtn && diagPanel.contains(compBtn)) {
          const comp = compBtn.getAttribute("data-diag-comp");
          if (!comp) return;
          e.preventDefault();
          setDiagConsoleView("detailed");
          const openSec = (sec) => {
            const det = diagPanel.querySelector(`details[data-diag-sec="${sec}"]`);
            if (det) {
              det.open = true;
              det.scrollIntoView({ block: "nearest", behavior: "smooth" });
            }
          };
          if (comp === "sync") {
            openSec("multiplayer");
            return;
          }
          if (comp === "ad") {
            if (siteSync.key === "prime") {
              diagPanel.querySelector('[data-diag-sec-wrap="prime"]')?.scrollIntoView({ block: "nearest", behavior: "smooth" });
            } else {
              openSec("technical");
            }
            return;
          }
          if (comp === "video") {
            openSec("technical");
          }
          return;
        }
      });
      const dragBtn = diagPanel.querySelector(".ws-diag-drag");
      dragBtn?.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const r = diagOverlay.getBoundingClientRect();
        diagDrag.active = true;
        diagDrag.dx = e.clientX - r.left;
        diagDrag.dy = e.clientY - r.top;
      });
      document.addEventListener("mousemove", (e) => {
        if (!diagDrag.active || !diagOverlay) return;
        const nx = Math.max(4, Math.min(window.innerWidth - 80, e.clientX - diagDrag.dx));
        const ny = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - diagDrag.dy));
        diagOverlay.style.left = `${nx}px`;
        diagOverlay.style.top = `${ny}px`;
        diagOverlay.style.bottom = "auto";
        diagOverlay.style.right = "auto";
      });
      document.addEventListener("mouseup", () => {
        diagDrag.active = false;
      });
      const forceOpenBtn = diagPanel.querySelector("#diagForceOpen");
      if (forceOpenBtn) {
        forceOpenBtn.addEventListener("click", () => {
          if (!roomState) {
            diagLog("ERROR", { message: "No room — join a room first" });
          } else {
            openSidebar();
            diagLog("SIDEBAR_OPEN", { source: "force" });
          }
          updateDiagnosticOverlay();
        });
      }
      diagPanel.querySelector("#diagEventFilter")?.addEventListener("input", (ev) => {
        diag.sync.eventFilter = ev.target.value || "";
        updateDiagnosticOverlay();
      });
      diagPanel.querySelector("#diagRoomTraceRefresh")?.addEventListener("click", () => {
        sendBg({ source: "playshare", type: "DIAG_ROOM_TRACE_REQUEST" });
      });
      const primeMissedAdCaptureHandler = () => {
        if (siteSync.key !== "prime") return;
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
          const blob = new Blob([json], { type: "application/json;charset=utf-8" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          const rc = autoCaptureContext.roomCodeShort || "noroom";
          a.download = `playshare-prime-missed-ad-${rc}-${autoCaptureContext.capturedAtMs}.json`;
          a.click();
          URL.revokeObjectURL(a.href);
          const finish = (clipboardOk) => {
            diag.lastPrimeMissedAdCapture = { at: Date.now(), clipboardOk };
            diagLog("DIAG_EXPORT", { primeMissedAdCapture: true, clipboardOk });
            updateDiagnosticOverlay();
          };
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(json).then(() => finish(true), () => finish(false));
          } else {
            finish(false);
          }
        } catch (e) {
          diagLog("ERROR", { message: e && e.message ? e.message : String(e) });
          updateDiagnosticOverlay();
        }
      };
      diagPanel.querySelectorAll(".diag-prime-missed-ad-btn").forEach((b) => {
        b.addEventListener("click", primeMissedAdCaptureHandler);
      });
      diagPanel.querySelector("#diagUploadAnonymized")?.addEventListener("click", () => {
        uploadAnonymizedDiagnosticExport().catch(
          (e) => diagLog("ERROR", { message: e && e.message ? e.message : String(e), kind: "diag_upload" })
        );
      });
      diagPanel.querySelector("#diagThemeToggle")?.addEventListener("click", () => {
        diag.theme = diag.theme === "dark" ? "light" : "dark";
        diagPanel.classList.toggle("ws-diag-light", diag.theme === "light");
        updateDiagnosticOverlay();
      });
      const diagSyncTest = diagPanel.querySelector("#diagSyncTest");
      if (diagSyncTest) diagSyncTest.addEventListener("click", () => runSyncTest(1));
      diagPanel.querySelector("#diagSyncTestSoak")?.addEventListener("click", () => runSyncTest(5));
      const diagSyncReport = diagPanel.querySelector("#diagSyncReport");
      if (diagSyncReport) diagSyncReport.addEventListener("click", () => {
        sendDiagReport();
        updateDiagnosticOverlay();
      });
      const diagSyncReset = diagPanel.querySelector("#diagSyncReset");
      if (diagSyncReset) diagSyncReset.addEventListener("click", resetSyncMetrics);
      diagPanel.querySelector("#diagVideoProfilerMarker")?.addEventListener("click", () => {
        if (!getVideoProfiler().isRecording()) return;
        const raw = typeof window !== "undefined" && window.prompt ? window.prompt("Marker label (optional):", "") : "";
        const note = raw != null ? String(raw).trim() : "";
        getVideoProfiler().dropMarker(note || void 0);
        updateDiagnosticOverlay();
      });
      diagPanel.querySelector("#diagVideoProfilerClear")?.addEventListener("click", () => {
        clearVideoProfilerSession();
      });
      diagOverlay.appendChild(diagPanel);
      diagPanel.classList.toggle("ws-diag-light", diag.theme === "light");
      diagPanel.classList.toggle("ws-diag-minimized", diag.panelMinimized);
      diagPanel.classList.toggle("ws-diag-wide", diag.overlayWide);
      diagPanel.classList.add("ws-diag-simplified");
      diagPanel.classList.remove("ws-diag-view-compact");
      diagPanel.classList.add("ws-diag-view-detailed");
      diag.consoleView = "detailed";
      setDiagConsoleView("detailed");
      document.body.appendChild(diagOverlay);
      reparentPlayShareUiForFullscreen();
      const diagStyles = document.createElement("style");
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
      .ws-diag-panel.ws-diag-light .ws-diag-simple-card-unified {
        background:linear-gradient(180deg, rgba(224,242,254,0.55) 0%, #fff 50%);
        border-color:rgba(6,182,212,0.28);
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
      .ws-diag-panel.ws-diag-simplified {
        width:min(400px,calc(100vw - 20px));
        max-height:min(82vh,760px);
      }
      .ws-diag-panel.ws-diag-simplified.ws-diag-wide {
        width:min(520px,calc(100vw - 20px));
      }
      .ws-diag-simplified-body {
        padding:14px 16px 16px;
        display:flex;
        flex-direction:column;
        gap:10px;
      }
      .ws-diag-simple-lead {
        margin:0;
        font-size:12px;
        line-height:1.5;
        color:var(--ws-diag-muted);
      }
      .ws-diag-simple-lead-min {
        font-size:11px;
        line-height:1.4;
      }
      .ws-diag-simple-card-unified {
        border-color:rgba(34,211,238,0.22);
        background:linear-gradient(180deg, rgba(34,211,238,0.06) 0%, var(--ws-diag-surface) 48%);
      }
      .ws-diag-simple-card-sub-tight {
        margin:0 0 8px !important;
      }
      .ws-diag-unified-record-row { width:100%; }
      .ws-diag-unified-rec {
        width:100%;
        box-sizing:border-box;
        justify-content:center;
        min-height:44px;
      }
      .ws-diag-btn-hero-rec {
        display:inline-flex;
        align-items:center;
        gap:8px;
        padding:10px 16px;
        font-weight:600;
        font-size:13px;
        border-radius:10px;
        background:linear-gradient(165deg, rgba(34,211,238,0.22), rgba(34,211,238,0.08));
        border:1px solid rgba(34,211,238,0.35);
        color:#ecfeff;
      }
      .ws-diag-btn-hero-rec.ws-diag-compact-rec-active {
        background:linear-gradient(165deg, rgba(248,113,113,0.25), rgba(239,68,68,0.12));
        border-color:rgba(248,113,113,0.45);
      }
      .ws-diag-simple-inline-tools {
        display:flex;
        flex-wrap:wrap;
        gap:6px;
        align-items:center;
        margin-top:4px;
      }
      .ws-diag-unified-tools { margin-top:6px;margin-bottom:0; }
      .ws-diag-report-divider {
        height:1px;
        margin:12px 0 8px;
        background:rgba(148,163,184,0.15);
      }
      .ws-diag-unified-divider { margin:8px 0 6px; }
      .ws-diag-unified-send-btn { margin-top:8px; }
      .ws-diag-intel-url-details { margin-top:8px; }
      .ws-diag-simple-card {
        background:var(--ws-diag-surface);
        border:1px solid rgba(148,163,184,0.12);
        border-radius:12px;
        padding:12px 14px;
      }
      .ws-diag-simple-card-intel {
        border-color:rgba(167,139,250,0.25);
        background:rgba(167,139,250,0.06);
      }
      .ws-diag-simple-card-intel .ws-diag-simple-btn-row { margin-top:8px; }
      .ws-diag-simple-card-title {
        font-size:12px;
        font-weight:700;
        letter-spacing:0.04em;
        text-transform:uppercase;
        color:#cbd5e1;
        margin:0 0 4px;
      }
      .ws-diag-simple-card-sub {
        margin:0 0 10px;
        font-size:11px;
        line-height:1.45;
        color:var(--ws-diag-muted);
      }
      .ws-diag-simple-btn-row {
        display:flex;
        flex-wrap:wrap;
        gap:6px;
        align-items:center;
      }
      .ws-diag-simple-check {
        display:flex;
        align-items:flex-start;
        gap:8px;
        font-size:11px;
        line-height:1.45;
        color:var(--ws-diag-muted);
        margin:6px 0 0;
        cursor:pointer;
      }
      .ws-diag-simple-check input { margin-top:2px; flex-shrink:0; }
      .ws-diag-upload-token-block { margin-top:10px; }
      .ws-diag-upload-token-block .ws-diag-filter { width:100%; max-width:100%; box-sizing:border-box; }
      .ws-diag-upload-token-hint { margin:4px 0 0 !important; font-size:10px !important; }
      .ws-diag-code-inline {
        font-size:10px;
        padding:1px 4px;
        border-radius:4px;
        background:rgba(0,0,0,0.25);
      }
      .ws-diag-intel-url-box {
        padding:8px 10px;
        border-radius:8px;
        background:rgba(0,0,0,0.28);
        border:1px solid rgba(148,163,184,0.15);
        overflow:hidden;
      }
      .ws-diag-intel-url {
        display:block;
        font-size:10px;
        line-height:1.4;
        word-break:break-all;
        color:#94a3b8;
      }
      .ws-diag-advanced-gate { margin-top:2px; }
      .ws-diag-advanced-details {
        border-radius:10px;
        border:1px dashed rgba(148,163,184,0.22);
        padding:2px 10px 10px;
        margin-top:8px;
        background:rgba(0,0,0,0.12);
      }
      .ws-diag-advanced-inner { padding-top:4px; }
      .ws-diag-advanced-toolbar {
        display:flex;
        flex-wrap:wrap;
        gap:6px;
        margin-bottom:12px;
        padding-bottom:10px;
        border-bottom:1px solid rgba(148,163,184,0.12);
      }
      .ws-diag-simple-more summary { font-size:11px; }
    `;
      document.head.appendChild(diagStyles);
    }
    const style = document.createElement("style");
    style.textContent = `
    @keyframes wsFadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
    @keyframes wsFloatUp { 0% { opacity:1; transform:translateY(0) scale(1); } 70% { opacity:0.9; transform:translateY(-100vh) scale(1.2); } 100% { opacity:0; transform:translateY(-120vh) scale(1.3); } }
  `;
    document.head.appendChild(style);
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
    let pollThrottle = null;
    function throttledPoll() {
      if (pollThrottle) return;
      pollThrottle = setTimeout(() => {
        pollThrottle = null;
        pollForVideo();
      }, 300);
    }
    setInterval(pollForVideo, 2e3);
    pollForVideo();
    if (videoDomDisconnect) videoDomDisconnect();
    videoDomDisconnect = attachVideoDomObserver(document.body, throttledPoll, 300);
    function applyRoomState(newState) {
      if (!newState) return;
      roomState = newState;
      if (diag.reportSession.roomCode !== newState.roomCode) {
        diag.reportSession = { startedAt: Date.now(), roomCode: newState.roomCode };
      }
      recordMemberChronology("room_restore", {
        roomCode: newState.roomCode,
        memberCount: (newState.members || []).length,
        isHost: !!newState.isHost,
        source: "storage_or_tab"
      });
      const continueRestore = () => {
        injectSidebar();
        showSidebarToggle();
        openSidebar();
        const syncDelay = playbackProfile.syncRequestDelayMs;
        if (!newState.isHost) {
          setTimeout(() => sendBg({ source: "playshare", type: "SYNC_REQUEST" }), syncDelay);
        }
        diagLog("ROOM_JOINED", { roomCode: newState.roomCode, source: "storage" });
        if (video) startPositionReportInterval();
        postSidebarRoomState();
        if (newState.isHost) stopViewerReconcileLoop();
        else startViewerReconcileLoop();
        seedActiveAdBreaksFromJoin(newState);
        if (video) startAdBreakMonitorIfNeeded();
      };
      if (newState.isHost) {
        chrome.storage.local.get(["playshareCountdownOnPlay"], (r) => {
          if (roomState && roomState.roomCode === newState.roomCode && typeof r.playshareCountdownOnPlay === "boolean") {
            roomState.countdownOnPlay = r.playshareCountdownOnPlay;
            sendBg({
              source: "playshare",
              type: "UPDATE_COUNTDOWN_ON_PLAY",
              value: roomState.countdownOnPlay
            });
          }
          continueRestore();
        });
      } else {
        continueRestore();
      }
    }
    chrome.storage.local.get(["roomState"], (data) => {
      if (data.roomState) applyRoomState(data.roomState);
    });
    chrome.runtime.sendMessage({ source: "playshare", type: "GET_STATE" }, (res) => {
      if (res?.roomState && !roomState) applyRoomState(res.roomState);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (siteSync.key === "prime" && changes[PRIME_SYNC_DEBUG_STORAGE_KEY]) {
        primeSyncDebugHud = playShareDevelopmentInstall && !!changes[PRIME_SYNC_DEBUG_STORAGE_KEY].newValue;
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
              source: "playshare",
              type: "DIAG_PROFILER_COLLECTION",
              active: false,
              collectorClientId: cid
            });
          } catch {
          }
        }
        diag.profilerPeerCollection.remoteCollectorClientId = null;
        roomState = null;
        suppressPlaybackEchoUntil = 0;
        suppressOutboundPlayWhileRoomPausedUntil = 0;
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
        diagLog("ROOM_LEFT", { source: "storage" });
        hideSidebarToggle();
        closeSidebar();
      }
    });
    document.addEventListener("visibilitychange", () => {
      diag.tabHidden = document.hidden;
      if (diagVisible) scheduleDiagUpdate();
      if (!document.hidden && roomState && video && !isVideoStale(video)) {
        sendPositionReportOnce();
      }
    });
    function attachPrimeDevConsole() {
      if (siteSync.key !== "prime" || !playShareDevelopmentInstall || window.__playsharePrime) return;
      try {
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
              viewerDriftSec: p && typeof p.viewerDriftSec === "number" ? p.viewerDriftSec : null,
              findVideoSelectorMatched: p ? p.selectorThatMatched : null,
              hostPositionIntervalMs: playbackProfile.hostPositionIntervalMs,
              viewerReconcileIntervalMs: playbackProfile.viewerReconcileIntervalMs,
              video: v ? {
                currentTime: v.currentTime,
                paused: v.paused,
                readyState: v.readyState,
                duration: v.duration
              } : null,
              room: roomState ? { code: roomState.roomCode, isHost: roomState.isHost } : null,
              help: "Prime: popup → “Prime sync HUD” (unpacked extension only). Dev diagnostics: Ctrl+Shift+D."
            };
          }
        };
      } catch {
      }
    }
    function runPlayShareDeveloperInstallGate() {
      const finishGate = () => {
        refreshPrimeDebugHudFromStorage();
        attachPrimeDevConsole();
      };
      try {
        chrome.runtime.sendMessage({ source: "playshare", type: "GET_DEV_INSTALL" }, (res) => {
          if (chrome.runtime.lastError) {
            playShareDevelopmentInstall = false;
            diagnosticsUiEnabled = false;
            finishGate();
            return;
          }
          playShareDevelopmentInstall = !!(res && res.developmentInstall);
          diagnosticsUiEnabled = playShareDevelopmentInstall;
          if (diagnosticsUiEnabled) mountDeveloperDiagnosticsUi();
          finishGate();
        });
      } catch {
        playShareDevelopmentInstall = false;
        diagnosticsUiEnabled = false;
        finishGate();
      }
    }
    runPlayShareDeveloperInstallGate();
    const onFullscreenChange = () => reparentPlayShareUiForFullscreen();
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    document.addEventListener("mozfullscreenchange", onFullscreenChange);
  }

  // content/src/entry.js
  runPlayShareContent();
})();
