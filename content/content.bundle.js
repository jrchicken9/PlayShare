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
    /** Let Prime settle after programmatic seek before play(). */
    PRIME_SYNC_STATE_APPLY_DELAY_MS: 220,
    PRIME_TIME_JUMP_THRESHOLD: 2,
    /** Host → server playhead anchor (keeps room.state fresh between events). */
    HOST_POSITION_INTERVAL_MS: 2500,
    /** Rare SYNC_REQUEST fallback when periodic server `sync` is unavailable. */
    VIEWER_SYNC_INTERVAL_MS: 2e4,
    /** Viewer reconciliation vs host timeline (hybrid continuous sync). */
    SYNC_RECONCILE_INTERVAL_MS: 2500,
    SYNC_DRIFT_HARD_SEC: 0.5,
    /** Below this magnitude, leave playbackRate at 1 (avoids endless micro-nudges). */
    SYNC_DRIFT_SOFT_MIN_SEC: 0.08,
    SOFT_SYNC_RATE_AHEAD: 0.95,
    SOFT_SYNC_RATE_BEHIND: 1.05,
    /** Reset playbackRate after soft nudge (ms). */
    SOFT_SYNC_RESET_MS: 2800,
    /** All peers send local playhead for cluster sync badge / spread (telemetry only on server). */
    POSITION_REPORT_INTERVAL_MS: 4e3,
    /** Max difference in extrapolated `currentTime` (seconds) to show “synced” for the room cluster. */
    CLUSTER_SYNC_SPREAD_SEC: 1.5,
    COUNTDOWN_SECONDS: 3,
    APPLY_DELAY_NETFLIX: 150,
    APPLY_DELAY_PRIME: 120,
    DIAG_DEBOUNCE_MS: 150,
    /**
     * After remote sync mutates the video element, ignore play/pause/seeked long enough that we
     * do not emit PLAY/SEEK (collaborative) or revert seeks (host-only) — avoids feedback loops
     * with periodic SYNC_STATE / sync packets.
     */
    PLAYBACK_ECHO_SUPPRESS_MS: 1300,
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
    const t = wsUrl.trim();
    if (/^wss:\/\//i.test(t)) return "https://" + t.slice(6).replace(/\/+$/, "");
    if (/^ws:\/\//i.test(t)) return "http://" + t.slice(5).replace(/\/+$/, "");
    return null;
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
      try {
        if (v.closest?.('.atvwebplayersdk-player-container, [class*="atvwebplayersdk-player"], [class*="webPlayerInner"]')) {
          score *= 1.85;
        }
      } catch {
      }
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
  var DIAGNOSTIC_REPORT_SCHEMA = "2.4";
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
  function computeCorrelationTraceDelivery(diag) {
    const trace = diag.serverRoomTrace || [];
    const timeline = diag.timing?.timeline || [];
    const recvKinds = /* @__PURE__ */ new Set(["play_recv", "pause_recv", "seek_recv"]);
    const byCorr = /* @__PURE__ */ new Map();
    for (const e of timeline) {
      const id = e.correlationId;
      if (!id || typeof id !== "string" || !recvKinds.has(e.kind)) continue;
      if (typeof e.recvAt !== "number" || !Number.isFinite(e.recvAt)) continue;
      const prev = byCorr.get(id);
      if (!prev || e.recvAt < prev.recvAt) {
        byCorr.set(id, { recvAt: e.recvAt, kind: e.kind });
      }
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
    if (jumps.length > 6) flags.push("many_large_timeupdate_jumps");
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
      timeupdateLargeJumps: jumps.length,
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
      hints.push("Large timeupdate jumps may indicate seeks/adaptive stream — may interact badly with sync thresholds.");
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
        `SYNC_STATE: in ${c.syncStateInbound ?? 0} · applied ${c.syncStateApplied ?? 0} · deferred(no video) ${c.syncStateDeferredNoVideo ?? 0} · deferred(stale) ${c.syncStateDeferredStaleOrMissing ?? 0} · flushed ${c.syncStateFlushedOnVideoAttach ?? 0}`
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
    if (payload.messaging && ((payload.messaging.runtimeSendFailures ?? 0) > 0 || (payload.messaging.sendThrowCount ?? 0) > 0)) {
      const m = payload.messaging;
      lines.push("--- Tab → service worker messaging ---");
      lines.push(`chrome.runtime.lastError ×${m.runtimeSendFailures ?? 0} · send threw ×${m.sendThrowCount ?? 0}`);
      if (m.runtimeLastErrorMessage) lines.push(`Last: ${m.runtimeLastErrorMessage}`);
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
    if (eb?.serviceWorkerTransport && typeof eb.serviceWorkerTransport === "object") {
      const t = eb.serviceWorkerTransport;
      lines.push("--- Service worker WebSocket (since worker start) ---");
      lines.push(
        `Opens ${t.wsOpenCount ?? 0} · closes ${t.wsCloseCount ?? 0} · send failures ${t.wsSendFailures ?? 0} · target ${t.serverHost ?? "—"} · last open ${t.lastWsOpenedAt != null ? new Date(t.lastWsOpenedAt).toISOString() : "—"} · last close ${t.lastWsClosedAt != null ? new Date(t.lastWsClosedAt).toISOString() : "—"}`
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
    lines.push(`Large timeupdate jumps logged: ${a.timeupdateLargeJumps ?? 0}`);
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
      howToUse: "Upload JSON or paste narrativeSummary. v2.3: apply denials (sync lock, Netflix debounce, tab-hidden deferral, host-only), messaging failures, WS send drops, video waiting/stalled, correlationTraceDelivery (trace vs recv). Export refreshes RTT + trace. No full URLs/chat.",
      note: "Redacted for privacy. sessionChronology + dataCompleteness describe how the test was run and what was clipped."
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
    applyDelayPrime: contentConstants.APPLY_DELAY_PRIME
  };
  function getPlaybackProfile(hostname, pathname) {
    const h = (hostname || "").toLowerCase();
    let profile = { ...BASE };
    if (/netflix\.com/.test(h)) {
      profile = {
        ...profile,
        handlerKey: "netflix",
        label: "Netflix",
        drmPassive: true,
        syncThresholdSoft: contentConstants.SYNC_THRESHOLD_NETFLIX,
        applyDebounceMs: contentConstants.SYNC_DEBOUNCE_MS,
        syncStateApplyDelayMs: 300,
        syncRequestDelayMs: 2e3
      };
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
    } else if (/primevideo\.com/.test(h) || /amazon\.(com|ca)/.test(h)) {
      profile = {
        ...profile,
        handlerKey: "prime",
        label: "Prime Video",
        /** Player often mounts before `duration` / readyState is final — pick best `<video>` earlier. */
        useRelaxedVideoReady: true,
        hostSeekSuppressAfterPlayMs: contentConstants.HOST_SEEK_SUPPRESS_AFTER_PLAY_MS_PRIME,
        syncRequestDelayMs: 900,
        /** Prime ignores a bare `video.play()` unless UI fallbacks run (see forcePlay). */
        aggressiveRemoteSync: true,
        syncStateApplyDelayMs: contentConstants.PRIME_SYNC_STATE_APPLY_DELAY_MS,
        applyDebounceMs: contentConstants.PRIME_APPLY_DEBOUNCE_MS,
        /** Looser seek / reconcile threshold than default 0.5s. */
        playbackSlackSec: contentConstants.SYNC_THRESHOLD_PRIME,
        timeJumpThresholdSec: contentConstants.PRIME_TIME_JUMP_THRESHOLD
      };
    }
    return profile;
  }
  function getApplyDelayMs(lastRtt, playbackProfile) {
    const forNetflix = playbackProfile.handlerKey === "netflix";
    const forPrime = playbackProfile.handlerKey === "prime";
    const platform = forNetflix ? playbackProfile.applyDelayNetflix : forPrime ? playbackProfile.applyDelayPrime : 0;
    return typeof lastRtt === "number" && lastRtt > 0 && lastRtt < platform ? lastRtt : platform;
  }

  // content/src/drm-sync-prompt.js
  function createDrmSyncPromptHost() {
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
      offer(opts) {
        const minIntervalMs = opts.minIntervalMs ?? 8e3;
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
        h.textContent = opts.headline || "Sync to host?";
        const d = document.createElement("div");
        d.style.cssText = "opacity:0.9;margin-bottom:12px";
        d.textContent = opts.detail || "";
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
            if (typeof opts.onConfirm === "function") opts.onConfirm();
          } catch {
          }
        });
        row.appendChild(btnCancel);
        row.appendChild(btnOk);
        wrap.appendChild(h);
        wrap.appendChild(d);
        wrap.appendChild(row);
        document.body.appendChild(wrap);
        activeEl = wrap;
      }
    };
  }

  // content/src/ad-detection.js
  function detectAdPlaying(hostname, video) {
    const h = (hostname || "").toLowerCase();
    try {
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
  function createAdBreakMonitor(hostname, getVideo, callbacks) {
    const debounceEnterMs = callbacks.debounceEnterMs ?? 650;
    const debounceExitMs = callbacks.debounceExitMs ?? 900;
    let intervalId = null;
    let inAd = false;
    let enterT = null;
    let exitT = null;
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
      const ad = detectAdPlaying(hostname, getVideo());
      if (ad) {
        clearExit();
        if (!inAd && !enterT) {
          enterT = setTimeout(() => {
            enterT = null;
            if (!inAd) {
              inAd = true;
              try {
                callbacks.onEnter();
              } catch {
              }
            }
          }, debounceEnterMs);
        }
      } else {
        clearEnter();
        if (inAd && !exitT) {
          exitT = setTimeout(() => {
            exitT = null;
            if (inAd) {
              inAd = false;
              try {
                callbacks.onExit();
              } catch {
              }
            }
          }, debounceExitMs);
        }
      }
    }
    return {
      start() {
        if (intervalId) return;
        intervalId = setInterval(tick, 400);
      },
      stop() {
        clearEnter();
        clearExit();
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
      POSITION_REPORT_INTERVAL_MS,
      CLUSTER_SYNC_SPREAD_SEC,
      COUNTDOWN_SECONDS,
      DIAG_DEBOUNCE_MS,
      TIME_JUMP_THRESHOLD,
      PLAYBACK_ECHO_SUPPRESS_MS,
      SIDEBAR_WIDTH
    } = contentConstants;
    const DIAG_EVENTS = new Set(contentConstants.DIAG_EVENT_NAMES);
    const platform = contentConstants.detectPlatform(hostname);
    const playbackProfile = getPlaybackProfile(hostname, location.pathname);
    const drmSyncPrompt = createDrmSyncPromptHost();
    let roomState = null;
    let video = null;
    let syncLock = false;
    let suppressPlaybackEchoUntil = 0;
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
    let hostPositionInterval = null;
    let viewerSyncInterval = null;
    let viewerReconcileInterval = null;
    let softPlaybackRateResetTimer = null;
    let videoDomDisconnect = null;
    let hostAuthoritativeRef = null;
    let adBreakMonitor = null;
    const peersInAdBreak = /* @__PURE__ */ new Map();
    let localAdBreakActive = false;
    let positionReportInterval = null;
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
      clusterSync: null
    };
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
      sendBg({
        source: "playshare",
        type: "DIAG_SYNC_REPORT",
        clientId: roomState.clientId,
        username: roomState.username,
        isHost: roomState.isHost,
        platform: platform.key,
        platformName: platform.name,
        metrics: { ...s.metrics },
        videoAttached: diag.videoAttached
      });
    }
    let cachedVideoEl = null;
    let cachedVideoDoc = null;
    function invalidateVideoCache() {
      cachedVideoEl = null;
      cachedVideoDoc = null;
      diag.findVideo.invalidations++;
    }
    function findVideo() {
      const isReady = (v) => v && v.tagName === "VIDEO" && !isNaN(v.duration) && (v.duration > 0 || v.readyState >= 1);
      const isReadyRelaxed = (v) => v && v.tagName === "VIDEO" && (v.readyState >= 2 || v.duration > 0 && !isNaN(v.duration));
      const doc = document;
      if (cachedVideoEl && cachedVideoDoc === doc) {
        try {
          if (cachedVideoEl.isConnected && (cachedVideoEl.readyState >= 1 || cachedVideoEl.duration > 0 && !isNaN(cachedVideoEl.duration))) {
            diag.findVideo.cacheReturns++;
            return cachedVideoEl;
          }
        } catch {
        }
        invalidateVideoCache();
      }
      diag.findVideo.fullScans++;
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
      candidates.sort((a, b) => scoreVideoElement(b) - scoreVideoElement(a));
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
      const selectors = [
        "video",
        ".atvwebplayersdk-video-canvas video",
        ".atvwebplayersdk-player-container video",
        ".webPlayerInner video",
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
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (isReady(el)) {
          cachedVideoEl = el;
          cachedVideoDoc = doc;
          return el;
        }
      }
      if (playbackProfile.useRelaxedVideoReady) {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (isReadyRelaxed(el)) {
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
      diag.findVideo.videoAttachCount++;
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
        sendBg({ source: "playshare", type: "SYNC_REQUEST" });
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
      adBreakMonitor = createAdBreakMonitor(hostname, () => findVideo() || video, {
        onEnter: () => {
          if (localAdBreakActive) return;
          localAdBreakActive = true;
          sendBg({ source: "playshare", type: "AD_BREAK_START" });
          syncAdBreakSidebar();
        },
        onExit: () => {
          if (!localAdBreakActive) return;
          localAdBreakActive = false;
          sendBg({ source: "playshare", type: "AD_BREAK_END" });
          syncAdBreakSidebar();
        }
      });
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
      if (!v || v.tagName !== "VIDEO") return;
      safeVideoOp(() => {
        v.playbackRate = 1;
      });
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
      const target = ref.playing ? ref.currentTime + (now - ref.sentAt) / 1e3 : ref.currentTime;
      const drift = v.currentTime - target;
      const adrift = Math.abs(drift);
      const driftHard = playbackProfile.playbackSlackSec ?? SYNC_DRIFT_HARD_SEC;
      if (playbackProfile.drmPassive) {
        platformPlaybackLog("VIEWER_RECONCILE_POLL", { adriftSec: +adrift.toFixed(2), hostPlaying: ref.playing });
        if (adrift > playbackProfile.drmDesyncThresholdSec) {
          diag.extensionOps.drmSyncPromptsShown++;
          drmSyncPrompt.offer({
            headline: "Sync to host?",
            detail: `About ${adrift.toFixed(1)}s off the room. Tap once to realign (low-frequency DRM-safe sync).`,
            minIntervalMs: 8e3,
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
      if (!ref.playing) {
        if (adrift > driftHard) {
          armPlaybackEchoSuppress();
          safeVideoOp(() => {
            v.currentTime = target;
            lastTimeUpdatePos = target;
          });
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
        safeVideoOp(() => {
          v.playbackRate = want;
        });
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
        source: "playshare",
        type: "POSITION_REPORT",
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
      diag.clusterSync = evaluateClusterPositionSnapshot(msg);
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
      if (isPlaybackEchoSuppressed()) return;
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
            detail: "Match the room once instead of starting playback yourself.",
            minIntervalMs: 1e4,
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
      const allowPlayDespiteSameTime = lastPlaybackOutboundKind === "PAUSE" || lastPlaybackOutboundKind === "SEEK";
      if (!allowPlayDespiteSameTime && Math.abs(t - lastSentTime) < 0.3) return;
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
      lastSentTime = t;
      lastPlaybackOutboundKind = "PLAY";
      updateVideoUrl();
      syncDiagRecord({ type: "play_sent", currentTime: t });
      sendBg({ source: "playshare", type: "PLAY", currentTime: t, sentAt: Date.now() });
      diagLog("PLAY", { currentTime: t, source: "local" });
      showToast("▶ You pressed play");
    }
    function onVideoPause() {
      if (syncLock || !roomState || countdownInProgress) return;
      if (isPlaybackEchoSuppressed()) return;
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
            detail: "Match the room once instead of pausing yourself.",
            minIntervalMs: 1e4,
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
      lastPlaybackOutboundKind = "PAUSE";
      updateVideoUrl();
      syncDiagRecord({ type: "pause_sent", currentTime: t });
      sendBg({ source: "playshare", type: "PAUSE", currentTime: t, sentAt: Date.now() });
      if (roomState.isHost) stopHostPositionHeartbeat();
      stopViewerSyncInterval();
      diagLog("PAUSE", { currentTime: t, source: "local" });
      showToast("⏸ You paused");
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
      if (!video || !video.isConnected || !document.contains(video) || cachedVideoEl && video !== cachedVideoEl) {
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
          diag._lastTuDiagAt = nowJ;
          const tuJump = playbackProfile.timeJumpThresholdSec ?? TIME_JUMP_THRESHOLD;
          if (typeof prev2 === "number" && prev2 >= 0 && Math.abs(tj - prev2) > tuJump) {
            diag.timeupdateJumps.unshift({ t: nowJ, from: prev2, to: tj, deltaSec: +(tj - prev2).toFixed(2) });
            if (diag.timeupdateJumps.length > 20) diag.timeupdateJumps.pop();
          }
          diag._lastTuDiagPos = tj;
        }
      }
      if (!video || syncLock || !roomState?.isHost || !canControlPlayback()) return;
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
          if (v2.paused && playbackProfile.handlerKey === "prime") {
            dispatchSpaceKey(v2);
            dispatchSpaceKey(v2.closest(".atvwebplayersdk-player-container") || document.body);
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
          if (!v2.paused && playbackProfile.handlerKey === "prime") {
            dispatchSpaceKey(v2);
            dispatchSpaceKey(v2.closest(".atvwebplayersdk-player-container") || document.body);
          }
        }, ms);
      });
    }
    function getSyncThreshold() {
      if (playbackProfile.drmPassive) return playbackProfile.syncThresholdSoft;
      if (playbackProfile.playbackSlackSec != null) return playbackProfile.playbackSlackSec;
      return SYNC_THRESHOLD;
    }
    function getRemoteApplySyncGate() {
      if (syncLock) return { ok: false, reason: "sync_lock" };
      if (playbackProfile.applyDebounceMs > 0 && Date.now() - lastSyncAt < playbackProfile.applyDebounceMs) {
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
    function applyPlay(currentTime, fromUsername, fromClientId, sentAt, lastRtt, correlationId, serverTime) {
      if (!video || isVideoStale(video)) return;
      const gate = getRemoteApplySyncGate();
      if (!gate.ok) {
        if (gate.reason === "sync_lock") diag.extensionOps.remoteApplyDeniedSyncLock++;
        else if (gate.reason === "playback_debounce") diag.extensionOps.remoteApplyDeniedPlaybackDebounce++;
        return;
      }
      if (localAdBreakActive) {
        diag.extensionOps.remoteApplyIgnoredLocalAd++;
        diagLog("PLAY", { currentTime, fromUsername, source: "remote", skipped: true, reason: "local_ad" });
        return;
      }
      const recvAt = Date.now();
      if (typeof lastRtt === "number" && lastRtt > 0) {
        diag.timing.lastRttMs = lastRtt;
        diag.timing.lastRttSource = "playback";
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
      pushDiagTimeline(diag.timing.timeline, {
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
      lastSyncAt = Date.now();
      if (playbackProfile.drmPassive && !roomState?.isHost) {
        diag.extensionOps.drmSyncPromptsShown++;
        platformPlaybackLog("DRM_SYNC_OFFER", { kind: "remote_play", targetTime, fromUsername });
        drmSyncPrompt.offer({
          headline: "Sync to host?",
          detail: `${fromUsername || "Host"} started playback. Tap once to jump to their time and play — avoids DRM playback errors.`,
          minIntervalMs: 6e3,
          onConfirm: () => {
            diag.extensionOps.drmSyncConfirmed++;
            const v = findVideo() || video;
            if (!v || isVideoStale(v)) return;
            syncLock = true;
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
            if (driftAfter != null) updateDriftEwm(diag.timing, driftAfter);
            pushDiagTimeline(diag.timing.timeline, {
              kind: ok ? "play_apply_ok" : "play_apply_fail",
              correlationId: correlationId || null,
              driftSec: driftAfter,
              latencyMs: latency
            });
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
    function applyPause(currentTime, fromUsername, fromClientId, lastRtt, correlationId, serverTime, sentAt) {
      if (!video || isVideoStale(video)) return;
      const gate = getRemoteApplySyncGate();
      if (!gate.ok) {
        if (gate.reason === "sync_lock") diag.extensionOps.remoteApplyDeniedSyncLock++;
        else if (gate.reason === "playback_debounce") diag.extensionOps.remoteApplyDeniedPlaybackDebounce++;
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
        diag.timing.lastRttMs = lastRtt;
        diag.timing.lastRttSource = "playback";
      }
      pushDiagTimeline(diag.timing.timeline, { kind: "pause_recv", correlationId: correlationId || null, currentTime, serverTime, recvAt, rttMs: lastRtt });
      syncDiagRecord({ type: "pause_recv", currentTime, fromUsername, drift: Math.abs(video.currentTime - currentTime), correlationId });
      lastAppliedState = { currentTime, playing: false };
      lastSentTime = currentTime;
      lastPlaybackOutboundKind = "PAUSE";
      lastSyncAt = Date.now();
      if (playbackProfile.drmPassive && !roomState?.isHost) {
        stopViewerSyncInterval();
        diag.extensionOps.drmSyncPromptsShown++;
        platformPlaybackLog("DRM_SYNC_OFFER", { kind: "remote_pause", currentTime, fromUsername });
        drmSyncPrompt.offer({
          headline: "Sync to host?",
          detail: `${fromUsername || "Host"} paused. Tap once to align and pause — avoids DRM playback errors.`,
          minIntervalMs: 6e3,
          onConfirm: () => {
            diag.extensionOps.drmSyncConfirmed++;
            const v = findVideo() || video;
            if (!v || isVideoStale(v)) return;
            syncLock = true;
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
        armPlaybackEchoSuppress();
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
          if (driftAfter != null) updateDriftEwm(diag.timing, driftAfter);
          pushDiagTimeline(diag.timing.timeline, {
            kind: ok ? "pause_apply_ok" : "pause_apply_fail",
            correlationId: correlationId || null,
            driftSec: driftAfter,
            latencyMs: latency
          });
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
    function applySeek(currentTime, fromUsername, fromClientId, lastRtt, correlationId, serverTime) {
      if (!video || isVideoStale(video)) return;
      const gate = getRemoteApplySyncGate();
      if (!gate.ok) {
        if (gate.reason === "sync_lock") diag.extensionOps.remoteApplyDeniedSyncLock++;
        else if (gate.reason === "playback_debounce") diag.extensionOps.remoteApplyDeniedPlaybackDebounce++;
        return;
      }
      if (localAdBreakActive) {
        diag.extensionOps.remoteApplyIgnoredLocalAd++;
        diagLog("SEEK", { currentTime, fromUsername, source: "remote", skipped: true, reason: "local_ad" });
        return;
      }
      const recvAt = Date.now();
      if (typeof lastRtt === "number" && lastRtt > 0) {
        diag.timing.lastRttMs = lastRtt;
        diag.timing.lastRttSource = "playback";
      }
      pushDiagTimeline(diag.timing.timeline, { kind: "seek_recv", correlationId: correlationId || null, currentTime, serverTime, recvAt, rttMs: lastRtt });
      syncDiagRecord({ type: "seek_recv", currentTime, fromUsername, drift: Math.abs(video.currentTime - currentTime), correlationId });
      if (!roomState?.isHost) {
        ingestHostAuthoritativeSync(currentTime, lastAppliedState.playing, recvAt);
      }
      if (adHoldBlocksRemotePlayback()) {
        diag.extensionOps.remoteSeekHeldForAd++;
        diagLog("SEEK", { currentTime, fromUsername, source: "remote", adHold: true });
        return;
      }
      lastAppliedState = { ...lastAppliedState, currentTime };
      lastSyncAt = Date.now();
      lastSentTime = currentTime;
      lastPlaybackOutboundKind = "SEEK";
      const driftBefore = Math.abs(video.currentTime - currentTime);
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
          detail: `${fromUsername || "Host"} jumped ~${driftBefore.toFixed(1)}s. Tap once to seek — avoids DRM playback errors.`,
          minIntervalMs: 6e3,
          onConfirm: () => {
            diag.extensionOps.drmSyncConfirmed++;
            const v = findVideo() || video;
            if (!v || isVideoStale(v)) return;
            syncLock = true;
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
      const doApply = () => {
        if (isVideoStale(video)) {
          syncLock = false;
          return;
        }
        const v = findVideo() || video;
        if (v) {
          armPlaybackEchoSuppress();
          safeVideoOp(() => {
            v.currentTime = currentTime;
          });
          lastTimeUpdatePos = currentTime;
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
          if (driftAfter != null) updateDriftEwm(diag.timing, driftAfter);
          pushDiagTimeline(diag.timing.timeline, {
            kind: ok ? "seek_apply_ok" : "seek_apply_fail",
            correlationId: correlationId || null,
            driftSec: driftAfter,
            latencyMs: latency
          });
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
      if (localAdBreakActive) {
        diag.extensionOps.syncStateIgnoredLocalAd++;
        return;
      }
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
      lastAppliedState = { currentTime: targetTime, playing: !!state.playing };
      lastSentTime = targetTime;
      lastPlaybackOutboundKind = state.playing ? "PLAY" : "PAUSE";
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
          return;
        }
        diag.extensionOps.drmSyncPromptsShown++;
        platformPlaybackLog("DRM_SYNC_OFFER", { kind: "sync_state", driftBefore, playMismatch });
        drmSyncPrompt.offer({
          headline: "Sync to host?",
          detail: playMismatch ? "Play/pause does not match the room. Tap once to align (avoids DRM errors)." : `About ${driftBefore.toFixed(1)}s off.`,
          minIntervalMs: 8e3,
          onConfirm: () => {
            diag.extensionOps.drmSyncConfirmed++;
            const v = findVideo() || video;
            if (!v || isVideoStale(v)) return;
            const applyNow = Date.now();
            const applyTarget = state.playing ? targetTime + (applyNow - viewerSyncBaseTime) / 1e3 : state.currentTime;
            syncLock = true;
            applyDrmViewerOneShot(v, applyTarget, !!state.playing);
            lastAppliedState = { currentTime: applyTarget, playing: !!state.playing };
            if (state.playing) startViewerSyncInterval();
            else stopViewerSyncInterval();
            const postDrift = Math.abs(v.currentTime - applyTarget);
            updateDriftEwm(diag.timing, postDrift);
            pushDiagTimeline(diag.timing.timeline, {
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
      setTimeout(() => {
        if (isVideoStale(video)) {
          syncLock = false;
          return;
        }
        const v = findVideo() || video;
        if (!v) {
          syncLock = false;
          return;
        }
        armPlaybackEchoSuppress();
        const applyNow = Date.now();
        const applyTarget = state.playing ? targetTime + (applyNow - viewerSyncBaseTime) / 1e3 : state.currentTime;
        safeVideoOp(() => {
          const diff = Math.abs(v.currentTime - applyTarget);
          if (diff > threshold) {
            v.currentTime = applyTarget;
            lastTimeUpdatePos = applyTarget;
          }
          lastAppliedState = { currentTime: applyTarget, playing: !!state.playing };
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
            } else {
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
        case "ROOM_LEFT":
          roomState = null;
          suppressPlaybackEchoUntil = 0;
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
          diagLog("ROOM_LEFT", {});
          hideSidebarToggle();
          closeSidebar();
          break;
        case "MEMBER_JOINED":
          recordMemberChronology("member_joined", { username: msg.username, clientIdShort: msg.clientId ? String(msg.clientId).slice(0, 8) + "…" : null });
          diagLog("MEMBER_JOINED", { username: msg.username });
          postSidebar({ type: "MEMBER_JOINED", data: msg });
          showToast(`👋 ${msg.username} joined`);
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
          break;
        case "PLAY":
          applyPlay(msg.currentTime, msg.fromUsername, msg.fromClientId, msg.sentAt, msg.lastRtt, msg.correlationId, msg.serverTime);
          break;
        case "PAUSE":
          applyPause(msg.currentTime, msg.fromUsername, msg.fromClientId, msg.lastRtt, msg.correlationId, msg.serverTime, msg.sentAt);
          break;
        case "sync":
          if (roomState && !roomState.isHost && !localAdBreakActive && typeof msg.currentTime === "number" && Number.isFinite(msg.currentTime) && (msg.state === "playing" || msg.state === "paused")) {
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
          if (msg.clientId && msg.clientId !== roomState?.clientId) {
            diag.sync.peerReports[msg.clientId] = {
              username: msg.username,
              isHost: msg.isHost,
              platform: msg.platformName || msg.platform,
              metrics: msg.metrics || {},
              videoAttached: msg.videoAttached,
              lastReceived: Date.now()
            };
          }
          break;
        }
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
          if (!roomState || localAdBreakActive) break;
          localAdBreakActive = true;
          sendBg({ source: "playshare", type: "AD_BREAK_START" });
          syncAdBreakSidebar();
          break;
        case "AD_BREAK_MANUAL_END":
          if (!roomState || !localAdBreakActive) break;
          localAdBreakActive = false;
          sendBg({ source: "playshare", type: "AD_BREAK_END" });
          stopAdBreakMonitor();
          startAdBreakMonitorIfNeeded();
          syncAdBreakSidebar();
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
      document.body.appendChild(el);
      setTimeout(() => el.remove(), duration * 1e3);
    }
    let diagOverlay = null;
    let diagPanel = null;
    let diagVisible = false;
    let diagDrag = { active: false, dx: 0, dy: 0 };
    let diagExportCaptureContext = null;
    function recordMemberChronology(kind, detail) {
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
      if (typeof res.lastRttMs === "number" && res.lastRttMs > 0) {
        diag.timing.lastRttMs = res.lastRttMs;
        diag.timing.lastRttSource = "background_heartbeat";
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
      if (playbackProfile.handlerKey === "prime" && tips.length > 0) {
        tips.push({ level: "info", text: "Prime Video: Use Space key + button clicks. Video element may be replaced on seek." });
      }
      if ((playbackProfile.handlerKey === "netflix" || playbackProfile.handlerKey === "disney") && tips.length > 0) {
        tips.push({
          level: "info",
          text: `${playbackProfile.label}: passive DRM-safe sync — use “Sync to host” when prompted; avoids player errors (e.g. M7375).`
        });
      }
      if (Object.keys(diag.sync.peerReports).length > 0) {
        tips.push({ level: "ok", text: `Receiving data from ${Object.keys(diag.sync.peerReports).length} peer(s).` });
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
    async function copyDiagExport() {
      await prepareDiagnosticSnapshotForExport();
      const json = JSON.stringify(getDiagExportPayload(), null, 2);
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(json).then(() => diagLog("DIAG_EXPORT", { copied: true })).catch(() => diagLog("ERROR", { message: "Copy failed" }));
      } else {
        diagLog("ERROR", { message: "Clipboard API unavailable" });
      }
    }
    async function downloadDiagExport() {
      await prepareDiagnosticSnapshotForExport();
      const payload = getDiagExportPayload();
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `playshare-sync-report-v${payload.reportSchemaVersion || "2"}-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      diagLog("DIAG_EXPORT", { downloaded: true });
    }
    async function copyDiagNarrative() {
      await prepareDiagnosticSnapshotForExport();
      const narrative = getDiagExportPayload().narrativeSummary || "";
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(narrative).then(() => diagLog("DIAG_EXPORT", { narrativeCopied: true })).catch(() => diagLog("ERROR", { message: "Copy failed" }));
      } else {
        diagLog("ERROR", { message: "Clipboard API unavailable" });
      }
    }
    async function downloadDiagNarrativeTxt() {
      await prepareDiagnosticSnapshotForExport();
      const narrative = getDiagExportPayload().narrativeSummary || "";
      const blob = new Blob([narrative], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `playshare-sync-summary-${Date.now()}.txt`;
      a.click();
      URL.revokeObjectURL(a.href);
      diagLog("DIAG_EXPORT", { narrativeDownloaded: true });
    }
    function updateDiagnosticOverlay() {
      if (!diagPanel || !diagVisible) return;
      diag.tabHidden = document.hidden;
      diag.diagOverlayStale = document.hidden;
      captureVideoHealthSnapshot();
      diag.sidebar.frameExists = !!sidebarFrame;
      diag.sidebar.toggleBtnExists = !!sidebarToggleBtn;
      diag.sidebar.toggleBtnVisible = sidebarToggleBtn ? sidebarToggleBtn.style.display === "flex" : false;
      const connEl = diagPanel.querySelector('[data-diag="connection"]');
      const roomEl = diagPanel.querySelector('[data-diag="room"]');
      const videoEl = diagPanel.querySelector('[data-diag="video"]');
      const lastEl = diagPanel.querySelector('[data-diag="last"]');
      const sidebarEl = diagPanel.querySelector('[data-diag="sidebar"]');
      const msgsEl = diagPanel.querySelector('[data-diag="messages"]');
      const errsEl = diagPanel.querySelector('[data-diag="errors"]');
      if (connEl) {
        const c = diag.connectionStatus;
        connEl.innerHTML = `Connection: <span class="ws-diag-${c}">${c}</span>`;
      }
      if (roomEl) {
        roomEl.textContent = roomState ? `Room: ${roomState.roomCode} | ${(roomState.members || []).length} members` : "Room: —";
      }
      if (videoEl) {
        videoEl.innerHTML = `Video: <span class="ws-diag-${diag.videoAttached ? "ok" : "warn"}">${diag.videoAttached ? "Attached" : "Not found"}</span>`;
      }
      if (lastEl && diag.lastEvent) {
        const e = diag.lastEvent;
        const d = e.detail ? e.detail.fromUsername || e.detail.source || JSON.stringify(e.detail).slice(0, 30) : "";
        lastEl.textContent = `Last: ${e.event} ${d ? "(" + d + ")" : ""} ${formatDiagTime(e.t)}`;
      } else if (lastEl) {
        lastEl.textContent = "Last: —";
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
      const syncTabContent = diagPanel?.querySelector('.ws-diag-tab-content[data-diag-tab="sync"]');
      if (syncTabContent?.classList.contains("active")) {
        const s = diag.sync;
        const m = s.metrics;
        const staleEl = diagPanel.querySelector('[data-diag="sync-stale"]');
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
            staleEl.textContent = "Tab hidden — sync apply may wait until visible; diagnostics still update.";
          } else {
            staleEl.classList.remove("visible");
            staleEl.textContent = "";
          }
        }
        if (timingEl) {
          const rtt = diag.timing.lastRttMs != null ? `${Math.round(diag.timing.lastRttMs)}ms` : "—";
          const ewm = diag.timing.driftEwmSec != null ? `${diag.timing.driftEwmSec.toFixed(3)}s` : "—";
          const lastRecv = s.lastRecvAt ? formatDiagTimeAgo(s.lastRecvAt) : "never";
          timingEl.innerHTML = `
          <div class="ws-diag-row">Last RTT (heartbeat): ${rtt}</div>
          <div class="ws-diag-row">Drift EWM (post-apply): ${ewm}</div>
          <div class="ws-diag-row ws-diag-muted">Last inbound sync event: ${lastRecv}</div>
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
        if (findVideoEl) {
          const fv = diag.findVideo;
          findVideoEl.innerHTML = `<div class="ws-diag-row">cache hits: ${fv.cacheReturns} | full scans: ${fv.fullScans} | invalidations: ${fv.invalidations} | attaches: ${fv.videoAttachCount}</div>`;
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
          const clusterLine = cs ? `<div class="ws-diag-row ws-diag-muted">Cluster: ${cs.label}${cs.staleCount ? ` · ${cs.staleCount} stale` : ""}</div>` : '<div class="ws-diag-row ws-diag-muted">Cluster: — (no snapshot yet)</div>';
          thisDeviceEl.innerHTML = `
          <div class="ws-diag-row">${platform.name} | ${roomState?.isHost ? "Host" : "Viewer"}</div>
          <div class="ws-diag-row">Video: ${diag.videoAttached ? "✓" : "✗"} | Room: ${roomState?.roomCode || "—"} | Tab: ${diag.tabHidden ? "hidden" : "visible"}</div>
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
          <div class="ws-diag-row">SYNC_STATE in <strong>${eo.syncStateInbound}</strong> · applied <strong>${eo.syncStateApplied}</strong> · deferred (no &lt;video&gt;) <strong>${eo.syncStateDeferredNoVideo}</strong> · deferred (stale) <strong>${eo.syncStateDeferredStaleOrMissing}</strong></div>
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
          const playRate = m.playOk + m.playFail > 0 ? (m.playOk / (m.playOk + m.playFail) * 100).toFixed(0) : "—";
          const pauseRate = m.pauseOk + m.pauseFail > 0 ? (m.pauseOk / (m.pauseOk + m.pauseFail) * 100).toFixed(0) : "—";
          const seekRate = m.seekOk + m.seekFail > 0 ? (m.seekOk / (m.seekOk + m.seekFail) * 100).toFixed(0) : "—";
          const testExtra = s.testResults?.done && s.testResults.peerTimeouts != null ? `<div class="ws-diag-row">Test peer wait timeouts: ${s.testResults.peerTimeouts} (need 2+ members for peer rows)</div>` : "";
          metricsEl.innerHTML = `
          <div class="ws-diag-row">Play: ${m.playSent} sent / ${m.playRecv} recv / ${m.playOk}✓ ${m.playFail}✗ (${playRate}%)</div>
          <div class="ws-diag-row">Pause: ${m.pauseSent} sent / ${m.pauseRecv} recv / ${m.pauseOk}✓ ${m.pauseFail}✗ (${pauseRate}%)</div>
          <div class="ws-diag-row">Seek: ${m.seekSent} sent / ${m.seekRecv} recv / ${m.seekOk}✓ ${m.seekFail}✗ (${seekRate}%)</div>
          ${s.testRunning ? '<div class="ws-diag-row ws-diag-warn">Test running…</div>' : ""}
          ${s.testResults?.done ? `<div class="ws-diag-row">Test done in ${((Date.now() - s.testResults.start) / 1e3).toFixed(1)}s${s.testResults.soakRounds > 1 ? ` (${s.testResults.soakRounds} rounds)` : ""}</div>` : ""}
          ${testExtra}
        `;
        }
        if (peersEl) {
          const peers = Object.entries(s.peerReports);
          peersEl.innerHTML = peers.length ? peers.map(([cid, r]) => {
            const ago = formatDiagTimeAgo(r.lastReceived);
            const pm = r.metrics || {};
            const pPlay = (pm.playOk || 0) + (pm.playFail || 0) > 0 ? ((pm.playOk || 0) / ((pm.playOk || 0) + (pm.playFail || 0)) * 100).toFixed(0) : "—";
            const pPause = (pm.pauseOk || 0) + (pm.pauseFail || 0) > 0 ? ((pm.pauseOk || 0) / ((pm.pauseOk || 0) + (pm.pauseFail || 0)) * 100).toFixed(0) : "—";
            const pSeek = (pm.seekOk || 0) + (pm.seekFail || 0) > 0 ? ((pm.seekOk || 0) / ((pm.seekOk || 0) + (pm.seekFail || 0)) * 100).toFixed(0) : "—";
            return `<div class="ws-diag-peer">
                <div class="ws-diag-row">${r.username || cid} (${r.platform || "?"}) ${r.isHost ? "👑" : ""}</div>
                <div class="ws-diag-row ws-diag-muted">Play ${pPlay}% | Pause ${pPause}% | Seek ${pSeek}% | ${ago}</div>
              </div>`;
          }).join("") : '<div class="ws-diag-row ws-diag-muted">No peer data. Open diagnostic on both devices & click "Request peer report"</div>';
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
          const tips = getSyncSuggestions();
          suggestionsEl.innerHTML = tips.map((t) => `<div class="ws-diag-row ws-diag-${t.level}">${t.text}</div>`).join("") || '<div class="ws-diag-row ws-diag-muted">No suggestions</div>';
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
      }
    }
    let diagRefreshInterval = null;
    function toggleDiagnostic() {
      diagVisible = !diagVisible;
      if (diagVisible) {
        if (!diagOverlay) injectDiagnosticOverlay();
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
        diagOverlay.style.display = "none";
        diagOverlay.setAttribute("aria-hidden", "true");
        if (diagRefreshInterval) {
          clearInterval(diagRefreshInterval);
          diagRefreshInterval = null;
        }
      }
    }
    function injectDiagnosticOverlay() {
      if (diagOverlay) return;
      diagOverlay = document.createElement("div");
      diagOverlay.id = "ws-diag-overlay";
      diagOverlay.setAttribute("aria-hidden", "true");
      diagOverlay.style.cssText = `
      display:none;position:fixed;z-index:2147483647;
      left:16px;bottom:16px;top:auto;right:auto;
      flex-direction:column;align-items:flex-start;gap:0;
      font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
      font-size:12px;line-height:1.45;pointer-events:auto;
      max-width:calc(100vw - 24px);
    `;
      diagPanel = document.createElement("div");
      diagPanel.className = "ws-diag-panel";
      diagPanel.setAttribute("role", "dialog");
      diagPanel.setAttribute("aria-label", "PlayShare sync diagnostics (developer tool)");
      diagPanel.innerHTML = `
      <div class="ws-diag-header">
        <div class="ws-diag-header-top">
          <button type="button" class="ws-diag-drag" title="Drag panel">⠿</button>
          <div class="ws-diag-brand">
            <span class="ws-diag-title">Sync diagnostics</span>
            <span class="ws-diag-dev-badge">DEV</span>
          </div>
          <div class="ws-diag-header-actions">
            <button type="button" class="ws-diag-icon-btn" id="diagWideToggle" title="Wider / narrower panel">⤢</button>
            <button type="button" class="ws-diag-icon-btn ws-diag-minimize-btn" title="Minimize">▁</button>
            <button type="button" class="ws-diag-icon-btn ws-diag-close" title="Close (Ctrl+Shift+D)">×</button>
          </div>
        </div>
        <p class="ws-diag-subhint">Internal only — refine sync · <kbd>⌃</kbd><kbd>⇧</kbd><kbd>D</kbd> toggles · not in release build</p>
        <div class="ws-diag-tab-row">
          <button type="button" class="ws-diag-tab active" data-diag-tab="general">General</button>
          <button type="button" class="ws-diag-tab" data-diag-tab="sync">Sync</button>
        </div>
      </div>
      <div class="ws-diag-tab-content active" data-diag-tab="general">
        <div class="ws-diag-body ws-diag-body-scroll">
          <details class="ws-diag-details" open>
            <summary>Connection & media</summary>
            <div class="ws-diag-card">
              <div data-diag="connection">Connection: —</div>
              <div data-diag="room">Room: —</div>
              <div data-diag="video">Video: —</div>
              <div data-diag="last" class="ws-diag-last-line">Last: —</div>
            </div>
          </details>
          <details class="ws-diag-details" open>
            <summary>Sidebar</summary>
            <div class="ws-diag-card">
              <div data-diag="sidebar" class="ws-diag-sidebar"></div>
              <div class="ws-diag-actions">
                <button type="button" class="ws-diag-btn ws-diag-btn-secondary" id="diagForceOpen">Force open sidebar</button>
              </div>
            </div>
          </details>
          <details class="ws-diag-details" open>
            <summary>Recent events</summary>
            <div data-diag="messages" class="ws-diag-list ws-diag-scrollbox-sm"></div>
          </details>
          <details class="ws-diag-details" open>
            <summary>Errors</summary>
            <div data-diag="errors" class="ws-diag-list ws-diag-scrollbox-sm"></div>
          </details>
        </div>
      </div>
      <div class="ws-diag-tab-content" data-diag-tab="sync">
        <div class="ws-diag-body ws-diag-body-scroll">
          <div data-diag="sync-stale" class="ws-diag-stale-banner" aria-live="polite"></div>

          <details class="ws-diag-details" open>
            <summary>Overview · timing · device</summary>
            <div class="ws-diag-card ws-diag-metrics-grid">
              <div class="ws-diag-metric-block">
                <span class="ws-diag-metric-label">Timing &amp; drift</span>
                <div data-diag="sync-timing" class="ws-diag-sync-block"></div>
              </div>
              <div class="ws-diag-metric-block">
                <span class="ws-diag-metric-label">This device</span>
                <div data-diag="sync-this-device" class="ws-diag-sync-block"></div>
              </div>
              <div class="ws-diag-metric-block ws-diag-span-2">
                <span class="ws-diag-metric-label">Extension bridge (counters)</span>
                <div data-diag="sync-extension-bridge" class="ws-diag-sync-block"></div>
              </div>
              <div class="ws-diag-metric-block ws-diag-span-2">
                <span class="ws-diag-metric-label">Video element</span>
                <div data-diag="sync-video-health" class="ws-diag-sync-block"></div>
              </div>
            </div>
          </details>

          <details class="ws-diag-details" open>
            <summary>Player &amp; DOM</summary>
            <div class="ws-diag-card">
              <span class="ws-diag-inline-label">findVideo cache</span>
              <div data-diag="sync-findvideo" class="ws-diag-sync-block ws-diag-scrollbox"></div>
              <span class="ws-diag-inline-label">Timeupdate jumps</span>
              <div data-diag="sync-tujumps" class="ws-diag-sync-block ws-diag-scrollbox"></div>
              <span class="ws-diag-inline-label">Apply timeline (local)</span>
              <div data-diag="sync-timeline" class="ws-diag-sync-block ws-diag-scrollbox"></div>
            </div>
          </details>

          <details class="ws-diag-details" open>
            <summary>Server trace</summary>
            <div class="ws-diag-card">
              <div data-diag="sync-server-trace" class="ws-diag-sync-block ws-diag-scrollbox"></div>
              <div class="ws-diag-actions">
                <button type="button" class="ws-diag-btn ws-diag-btn-secondary" id="diagRoomTraceRefresh">Refresh server trace</button>
              </div>
            </div>
          </details>

          <details class="ws-diag-details" open>
            <summary>Metrics · peers · remote applies</summary>
            <div class="ws-diag-card">
              <span class="ws-diag-inline-label">Counts (this device)</span>
              <div data-diag="sync-metrics" class="ws-diag-sync-block ws-diag-scrollbox"></div>
              <span class="ws-diag-inline-label">Peer snapshots</span>
              <div data-diag="sync-peers" class="ws-diag-sync-block ws-diag-scrollbox-md"></div>
              <span class="ws-diag-inline-label">Remote apply results</span>
              <div data-diag="sync-remote-results" class="ws-diag-sync-block ws-diag-scrollbox-md"></div>
              <span class="ws-diag-inline-label">Suggestions</span>
              <div data-diag="sync-suggestions" class="ws-diag-sync-block ws-diag-scrollbox-sm"></div>
            </div>
          </details>

          <details class="ws-diag-details" open>
            <summary>Live sync event log</summary>
            <div class="ws-diag-card">
              <label class="ws-diag-filter-label" for="diagEventFilter">Filter rows</label>
              <input type="search" id="diagEventFilter" class="ws-diag-filter" placeholder="e.g. play_recv, alice, correlation…" autocomplete="off" />
              <div data-diag="sync-events" class="ws-diag-sync-block ws-diag-scrollbox-lg ws-diag-events"></div>
            </div>
          </details>

          <details class="ws-diag-details" open>
            <summary>Export report · automated tests</summary>
            <div class="ws-diag-card">
              <p class="ws-diag-help">Exports are <strong>redacted</strong>. Each export <strong>refreshes RTT</strong> from the service worker and requests a <strong>fresh server trace</strong> (~0.5s) so analysts see a consistent snapshot.</p>
              <div class="ws-diag-btn-group">
                <span class="ws-diag-btn-group-label">Export</span>
                <div class="ws-diag-actions">
                  <button type="button" class="ws-diag-btn" id="diagExportCopy">Full JSON</button>
                  <button type="button" class="ws-diag-btn ws-diag-btn-secondary" id="diagExportDownload">Download .json</button>
                  <button type="button" class="ws-diag-btn ws-diag-btn-secondary" id="diagExportNarrativeCopy">Text summary</button>
                  <button type="button" class="ws-diag-btn ws-diag-btn-secondary" id="diagExportNarrativeDownload">Download .txt</button>
                </div>
              </div>
              <div class="ws-diag-btn-group">
                <span class="ws-diag-btn-group-label">Tests &amp; tools</span>
                <div class="ws-diag-actions">
                  <button type="button" class="ws-diag-btn" id="diagSyncTest">Run sync test</button>
                  <button type="button" class="ws-diag-btn ws-diag-btn-secondary" id="diagSyncTestSoak">Soak 5×</button>
                  <button type="button" class="ws-diag-btn ws-diag-btn-secondary" id="diagSyncReport">Peer report</button>
                  <button type="button" class="ws-diag-btn ws-diag-btn-secondary" id="diagSyncReset">Reset metrics</button>
                  <button type="button" class="ws-diag-btn ws-diag-btn-ghost" id="diagThemeToggle">Theme</button>
                </div>
              </div>
            </div>
          </details>
        </div>
      </div>
    `;
      const closeBtn = diagPanel.querySelector(".ws-diag-close");
      closeBtn.addEventListener("click", toggleDiagnostic);
      diagPanel.querySelector(".ws-diag-minimize-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        diag.panelMinimized = !diag.panelMinimized;
        diagPanel.classList.toggle("ws-diag-minimized", diag.panelMinimized);
      });
      diagPanel.querySelector("#diagWideToggle")?.addEventListener("click", (e) => {
        e.stopPropagation();
        diag.overlayWide = !diag.overlayWide;
        diagPanel.classList.toggle("ws-diag-wide", diag.overlayWide);
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
      diagPanel.querySelectorAll(".ws-diag-tab").forEach((tab) => {
        tab.addEventListener("click", () => {
          diagPanel.querySelectorAll(".ws-diag-tab").forEach((t) => t.classList.remove("active"));
          diagPanel.querySelectorAll(".ws-diag-tab-content").forEach((c) => c.classList.remove("active"));
          tab.classList.add("active");
          const target = diagPanel.querySelector(`.ws-diag-tab-content[data-diag-tab="${tab.dataset.diagTab}"]`);
          if (target) target.classList.add("active");
          updateDiagnosticOverlay();
        });
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
      diagPanel.querySelector("#diagExportCopy")?.addEventListener("click", () => {
        copyDiagExport().catch(() => diagLog("ERROR", { message: "Export failed" }));
      });
      diagPanel.querySelector("#diagExportDownload")?.addEventListener("click", () => {
        downloadDiagExport().catch(() => diagLog("ERROR", { message: "Export failed" }));
      });
      diagPanel.querySelector("#diagExportNarrativeCopy")?.addEventListener("click", () => {
        copyDiagNarrative().catch(() => diagLog("ERROR", { message: "Export failed" }));
      });
      diagPanel.querySelector("#diagExportNarrativeDownload")?.addEventListener("click", () => {
        downloadDiagNarrativeTxt().catch(() => diagLog("ERROR", { message: "Export failed" }));
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
      diagOverlay.appendChild(diagPanel);
      diagPanel.classList.toggle("ws-diag-light", diag.theme === "light");
      diagPanel.classList.toggle("ws-diag-minimized", diag.panelMinimized);
      diagPanel.classList.toggle("ws-diag-wide", diag.overlayWide);
      document.body.appendChild(diagOverlay);
      const diagStyles = document.createElement("style");
      diagStyles.textContent = `
      .ws-diag-panel kbd {
        display:inline-block;padding:1px 5px;margin:0 1px;font-size:10px;font-family:inherit;
        background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.2);border-radius:4px;
      }
      .ws-diag-panel.ws-diag-light kbd {
        background:#e2e8f0;border-color:#cbd5e1;color:#0f172a;
      }
      .ws-diag-panel {
        background:rgba(18,20,24,0.97);color:#e8eaed;
        border:1px solid rgba(78,205,196,0.35);border-radius:12px;
        box-shadow:0 12px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.3);
        width:min(420px,calc(100vw - 20px));max-height:min(78vh,720px);
        overflow:hidden;display:flex;flex-direction:column;
        font-variant-numeric: tabular-nums;
      }
      .ws-diag-panel.ws-diag-wide {
        width:min(720px,calc(100vw - 20px));max-height:min(85vh,800px);
      }
      .ws-diag-header {
        flex-shrink:0;
        padding:10px 12px 8px;
        background:linear-gradient(180deg, rgba(35,38,45,0.98) 0%, rgba(22,24,28,0.99) 100%);
        border-bottom:1px solid rgba(255,255,255,0.08);
      }
      .ws-diag-header-top {
        display:flex;align-items:center;gap:8px;
      }
      .ws-diag-drag {
        flex-shrink:0;width:28px;height:32px;border-radius:6px;
        border:1px dashed rgba(255,255,255,0.2);background:rgba(0,0,0,0.2);
        color:#888;font-size:14px;line-height:1;cursor:grab;padding:0;
      }
      .ws-diag-drag:active { cursor:grabbing; }
      .ws-diag-brand { flex:1;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap; }
      .ws-diag-title { font-weight:700;font-size:14px;letter-spacing:-0.02em;color:#f1f5f9; }
      .ws-diag-dev-badge {
        font-size:9px;font-weight:800;letter-spacing:0.06em;padding:2px 6px;border-radius:4px;
        background:#7c3aed;color:#fff;
      }
      .ws-diag-header-actions { display:flex;gap:4px;flex-shrink:0; }
      .ws-diag-icon-btn {
        width:32px;height:32px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);
        background:rgba(0,0,0,0.25);color:#94a3b8;font-size:16px;line-height:1;cursor:pointer;padding:0;
      }
      .ws-diag-icon-btn:hover { color:#fff;border-color:rgba(78,205,196,0.5);background:rgba(78,205,196,0.12); }
      .ws-diag-subhint {
        margin:8px 0 0 36px;font-size:11px;color:#64748b;line-height:1.35;
      }
      .ws-diag-tab-row {
        display:flex;gap:6px;margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);
      }
      .ws-diag-tab {
        flex:1;border:none;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:600;cursor:pointer;
        background:rgba(0,0,0,0.2);color:#94a3b8;
      }
      .ws-diag-tab:hover { color:#cbd5e1; }
      .ws-diag-tab.active {
        background:rgba(78,205,196,0.18);color:#4ECDC4;box-shadow:inset 0 0 0 1px rgba(78,205,196,0.35);
      }
      .ws-diag-tab-content { display:none;flex:1;min-height:0; }
      .ws-diag-tab-content.active { display:flex;flex-direction:column; }
      .ws-diag-body-scroll {
        padding:10px 12px 14px;overflow-y:auto;overflow-x:hidden;
        flex:1;min-height:0;
        scroll-behavior:smooth;
      }
      .ws-diag-details { margin-bottom:10px;border-radius:10px;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.06); }
      .ws-diag-details > summary {
        list-style:none;cursor:pointer;user-select:none;
        padding:10px 12px;font-size:12px;font-weight:700;color:#cbd5e1;
        border-radius:10px;
      }
      .ws-diag-details > summary::-webkit-details-marker { display:none; }
      .ws-diag-details > summary::after { content:'▸';float:right;opacity:0.45;font-weight:400; }
      .ws-diag-details[open] > summary::after { content:'▾'; }
      .ws-diag-details[open] > summary {
        border-bottom:1px solid rgba(255,255,255,0.06);border-radius:10px 10px 0 0;
      }
      .ws-diag-card {
        padding:10px 12px 12px;
      }
      .ws-diag-metrics-grid {
        display:grid;grid-template-columns:1fr 1fr;gap:10px;
      }
      .ws-diag-span-2 { grid-column:1/-1; }
      @media (max-width:480px) {
        .ws-diag-metrics-grid { grid-template-columns:1fr; }
        .ws-diag-span-2 { grid-column:1; }
      }
      .ws-diag-metric-block .ws-diag-metric-label {
        display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;
        color:#64748b;margin-bottom:6px;
      }
      .ws-diag-inline-label {
        display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;
        color:#64748b;margin:10px 0 6px;
      }
      .ws-diag-inline-label:first-child { margin-top:0; }
      .ws-diag-sync-block {
        font-size:11px;color:#94a3b8;line-height:1.5;
      }
      .ws-diag-scrollbox { max-height:100px;overflow-y:auto;padding:6px 8px;border-radius:8px;background:rgba(0,0,0,0.25); }
      .ws-diag-scrollbox-sm { max-height:88px;overflow-y:auto;padding:6px 8px;border-radius:8px;background:rgba(0,0,0,0.25); }
      .ws-diag-scrollbox-md { max-height:140px;overflow-y:auto;padding:6px 8px;border-radius:8px;background:rgba(0,0,0,0.25); }
      .ws-diag-scrollbox-lg { max-height:220px;overflow-y:auto;padding:6px 8px;border-radius:8px;background:rgba(0,0,0,0.25); }
      .ws-diag-events .ws-diag-row { font-family:ui-monospace,SFMono-Regular,monospace;font-size:10px; }
      .ws-diag-last-line { margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.06); }
      .ws-diag-stale-banner { font-size:11px;padding:10px 12px;border-radius:10px;margin-bottom:10px;display:none;line-height:1.4; }
      .ws-diag-stale-banner.visible {
        display:block;background:rgba(180,83,9,0.22);color:#fdba74;border:1px solid rgba(251,146,60,0.45);
      }
      .ws-diag-filter-label { display:block;font-size:10px;font-weight:700;color:#64748b;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.04em; }
      .ws-diag-filter {
        width:100%;box-sizing:border-box;background:rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.12);
        color:#e2e8f0;border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:12px;
      }
      .ws-diag-filter:focus { outline:none;border-color:rgba(78,205,196,0.55);box-shadow:0 0 0 2px rgba(78,205,196,0.15); }
      .ws-diag-help { font-size:11px;color:#94a3b8;margin:0 0 12px;line-height:1.45; }
      .ws-diag-btn-group { margin-bottom:12px; }
      .ws-diag-btn-group:last-child { margin-bottom:0; }
      .ws-diag-btn-group-label {
        display:block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;margin-bottom:6px;
      }
      .ws-diag-panel.ws-diag-minimized .ws-diag-tab-row,
      .ws-diag-panel.ws-diag-minimized .ws-diag-tab-content,
      .ws-diag-panel.ws-diag-minimized .ws-diag-subhint { display:none !important; }
      .ws-diag-panel.ws-diag-minimized { max-height:none; }
      .ws-diag-panel.ws-diag-minimized .ws-diag-header { border-bottom:none; }

      .ws-diag-panel.ws-diag-light {
        background:rgba(255,255,255,0.98);color:#0f172a;border-color:#cbd5e1;
        box-shadow:0 12px 40px rgba(15,23,42,0.12);
      }
      .ws-diag-panel.ws-diag-light .ws-diag-header {
        background:linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%);
        border-bottom-color:#e2e8f0;
      }
      .ws-diag-panel.ws-diag-light .ws-diag-title { color:#0f172a; }
      .ws-diag-panel.ws-diag-light .ws-diag-subhint { color:#64748b; }
      .ws-diag-panel.ws-diag-light .ws-diag-tab { background:#e2e8f0;color:#475569; }
      .ws-diag-panel.ws-diag-light .ws-diag-tab.active { background:#ccfbf1;color:#0f766e;box-shadow:inset 0 0 0 1px #5eead4; }
      .ws-diag-panel.ws-diag-light .ws-diag-details { background:#f8fafc;border-color:#e2e8f0; }
      .ws-diag-panel.ws-diag-light .ws-diag-details > summary { color:#334155; }
      .ws-diag-panel.ws-diag-light .ws-diag-scrollbox,
      .ws-diag-panel.ws-diag-light .ws-diag-scrollbox-sm,
      .ws-diag-panel.ws-diag-light .ws-diag-scrollbox-md,
      .ws-diag-panel.ws-diag-light .ws-diag-scrollbox-lg { background:#f1f5f9;color:#334155; }
      .ws-diag-panel.ws-diag-light .ws-diag-sync-block { color:#475569; }
      .ws-diag-panel.ws-diag-light .ws-diag-filter { background:#fff;border-color:#cbd5e1;color:#0f172a; }

      .ws-diag-list { font-size:11px;color:#94a3b8; }
      .ws-diag-row { margin-bottom:4px; }
      .ws-diag-muted { color:#64748b; }
      .ws-diag-err { color:#f87171; }
      .ws-diag-connected, .ws-diag-ok { color:#4ade80; }
      .ws-diag-disconnected { color:#f87171; }
      .ws-diag-warn { color:#fbbf24; }
      .ws-diag-info { color:#38bdf8; }
      .ws-diag-sidebar { font-size:11px;color:#94a3b8; }
      .ws-diag-peer { margin-bottom:8px;padding:8px;background:rgba(255,255,255,0.04);border-radius:8px;border:1px solid rgba(255,255,255,0.06); }
      .ws-diag-panel.ws-diag-light .ws-diag-peer { background:#fff;border-color:#e2e8f0; }
      .ws-diag-sync-play-ok, .ws-diag-sync-pause-ok, .ws-diag-sync-seek-ok { color:#4ade80; }
      .ws-diag-sync-play-fail, .ws-diag-sync-pause-fail, .ws-diag-sync-seek-fail { color:#f87171; }
      .ws-diag-sync-play-sent, .ws-diag-sync-pause-sent, .ws-diag-sync-seek-sent { color:#38bdf8; }
      .ws-diag-sync-play-recv, .ws-diag-sync-pause-recv, .ws-diag-sync-seek-recv { color:#fbbf24; }

      .ws-diag-actions { display:flex;flex-wrap:wrap;gap:8px;margin-top:4px; }
      .ws-diag-btn {
        border:none;border-radius:8px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;
        background:linear-gradient(180deg, #2dd4bf 0%, #14b8a6 100%);color:#0f172a;
        box-shadow:0 2px 6px rgba(20,184,166,0.35);
      }
      .ws-diag-btn:hover { filter:brightness(1.08); }
      .ws-diag-btn:disabled { opacity:0.45;cursor:not-allowed;filter:none; }
      .ws-diag-btn-secondary {
        background:rgba(255,255,255,0.08);color:#e2e8f0;box-shadow:none;border:1px solid rgba(255,255,255,0.12);
      }
      .ws-diag-btn-secondary:hover { background:rgba(255,255,255,0.12); }
      .ws-diag-panel.ws-diag-light .ws-diag-btn-secondary { background:#fff;color:#0f172a;border-color:#cbd5e1; }
      .ws-diag-btn-ghost { background:transparent;color:#94a3b8;box-shadow:none;border:1px dashed rgba(255,255,255,0.2); }
      .ws-diag-btn-ghost:hover { color:#cbd5e1;border-style:solid; }
      .ws-diag-panel.ws-diag-light .ws-diag-btn-ghost { color:#64748b;border-color:#94a3b8; }
    `;
      document.head.appendChild(diagStyles);
    }
    const diagToggleBtn = document.createElement("button");
    diagToggleBtn.id = "ws-diag-toggle";
    diagToggleBtn.title = "Sync diagnostics (dev) — Ctrl+Shift+D";
    diagToggleBtn.textContent = "⚙";
    diagToggleBtn.style.cssText = `
    position:fixed;bottom:16px;left:16px;z-index:2147483646;
    width:36px;height:36px;border-radius:10px;
    background:rgba(18,20,24,0.92);border:1px solid rgba(78,205,196,0.35);
    color:#4ECDC4;font-size:18px;line-height:1;cursor:pointer;
    display:flex;align-items:center;justify-content:center;
    transition:background 0.2s,color 0.2s,transform 0.15s;
    box-shadow:0 4px 16px rgba(0,0,0,0.35);
  `;
    diagToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDiagnostic();
    });
    diagToggleBtn.addEventListener("mouseenter", () => {
      diagToggleBtn.style.background = "rgba(30,40,40,0.98)";
      diagToggleBtn.style.color = "#5eead4";
      diagToggleBtn.style.transform = "scale(1.05)";
    });
    diagToggleBtn.addEventListener("mouseleave", () => {
      diagToggleBtn.style.background = "rgba(18,20,24,0.92)";
      diagToggleBtn.style.color = "#4ECDC4";
      diagToggleBtn.style.transform = "scale(1)";
    });
    document.body.appendChild(diagToggleBtn);
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "D") {
        e.preventDefault();
        toggleDiagnostic();
      }
    });
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
        setTimeout(() => sendBg({ source: "playshare", type: "SYNC_REQUEST" }), syncDelay);
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
      if (area !== "local" || !changes.roomState) return;
      const newState = changes.roomState.newValue;
      if (newState) applyRoomState(newState);
      else {
        roomState = null;
        peersInAdBreak.clear();
        localAdBreakActive = false;
        stopAdBreakMonitor();
        diag.reportSession = { startedAt: null, roomCode: null };
        hostAuthoritativeRef = null;
        stopPositionReportInterval();
        stopViewerReconcileLoop();
        diag.clusterSync = null;
        lastClusterSidebarKey = null;
        hideClusterSyncBadge();
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
  }

  // content/src/entry.js
  runPlayShareContent();
})();
