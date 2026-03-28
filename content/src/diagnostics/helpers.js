/**
 * Pure helpers for diagnostic export / timeline / analytics (for support & improvement).
 */

export const DIAGNOSTIC_REPORT_SCHEMA = '2.5';

export function pushDiagTimeline(timeline, entry, maxLen = 40) {
  timeline.unshift({ t: Date.now(), ...entry });
  if (timeline.length > maxLen) timeline.length = maxLen;
}

/** Drift after apply (seconds), exponential weighted moving average. */
export function updateDriftEwm(timing, sampleSec, alpha = 0.25) {
  if (typeof sampleSec !== 'number' || !Number.isFinite(sampleSec) || sampleSec < 0) return;
  const prev = timing.driftEwmSec ?? 0;
  timing.driftEwmSec = alpha * sampleSec + (1 - alpha) * prev;
}

function truncStr(s, max) {
  if (typeof s !== 'string') return s;
  return s.length > max ? s.slice(0, Math.floor(max / 2)) + '…[truncated]' : s;
}

function applyRate(ok, fail) {
  const total = ok + fail;
  if (!total) return { ok, fail, total: 0, successRate: null };
  return { ok, fail, total, successRate: Math.round((ok / total) * 10000) / 10000 };
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

/**
 * Match server `DIAG_ROOM_TRACE` rows to local timeline `*_recv` entries by `correlationId`.
 * Both `trace.t` (server) and `recvAt` (content) use epoch ms; difference ≈ delivery skew if clocks agree.
 */
function ingestRecvForCorrelation(byCorr, e) {
  const recvKinds = new Set(['play_recv', 'pause_recv', 'seek_recv']);
  const kind = e.kind || e.type;
  if (!recvKinds.has(kind)) return;
  const id = e.correlationId;
  if (!id || typeof id !== 'string') return;
  const recvAt =
    typeof e.recvAt === 'number' && Number.isFinite(e.recvAt)
      ? e.recvAt
      : typeof e.t === 'number' && Number.isFinite(e.t)
        ? e.t
        : null;
  if (recvAt == null) return;
  const prev = byCorr.get(id);
  if (!prev || recvAt < prev.recvAt) {
    byCorr.set(id, { recvAt, kind });
  }
}

export function computeCorrelationTraceDelivery(diag) {
  const trace = diag.serverRoomTrace || [];
  const timeline = diag.timing?.timeline || [];
  /** @type {Map<string, { recvAt: number, kind: string }>} */
  const byCorr = new Map();
  for (const e of timeline) {
    ingestRecvForCorrelation(byCorr, e);
  }
  // Timeline is short (ring); sync.events keeps more recv rows with the same correlationIds.
  for (const e of diag.sync?.events || []) {
    ingestRecvForCorrelation(byCorr, e);
  }
  const samples = [];
  let traceConsider = 0;
  for (const tr of trace) {
    if (!tr || !tr.correlationId || typeof tr.correlationId !== 'string') continue;
    const typ = tr.type;
    if (typ !== 'PLAY' && typ !== 'PAUSE' && typ !== 'SEEK') continue;
    traceConsider++;
    const m = byCorr.get(tr.correlationId);
    if (!m) continue;
    const serverT = typeof tr.t === 'number' ? tr.t : null;
    if (serverT == null || !Number.isFinite(serverT)) continue;
    const oneWayMs = m.recvAt - serverT;
    if (!Number.isFinite(oneWayMs) || Math.abs(oneWayMs) > 120000) continue;
    samples.push({
      correlationIdTrunc: truncStr(String(tr.correlationId), 22),
      type: typ,
      clientRecvMinusServerTraceMs: Math.round(oneWayMs)
    });
  }
  const latencies = samples.map((s) => s.clientRecvMinusServerTraceMs);
  const negN = latencies.filter((x) => x < -80).length;
  const clockSkewSuspected =
    latencies.length >= 3 && negN >= Math.max(2, Math.ceil(latencies.length * 0.35));
  return {
    matched: samples.length,
    traceEventsWithIdConsidered: traceConsider,
    clockSkewSuspected,
    samples: samples.slice(0, 20),
    summary: summarizeLatencies(latencies)
  };
}

/**
 * Aggregates metrics for humans / LLMs analyzing sync quality.
 * @param { { memberCount?: number, isHost?: boolean } | null } roomMeta
 */
export function computeSyncAnalytics(diag, reportSession, roomMeta = null) {
  const m = diag.sync?.metrics || {};
  const memberCount = roomMeta?.memberCount ?? null;
  const isSoloSession = memberCount != null && memberCount <= 1;
  const events = diag.sync?.events || [];
  const remotes = diag.sync?.remoteApplyResults || [];
  const timeline = diag.timing?.timeline || [];
  const fv = diag.findVideo || {};
  const jumps = diag.timeupdateJumps || [];
  const significantTimeupdateJumps = jumps.filter(
    (j) => j && typeof j.deltaSec === 'number' && Number.isFinite(j.deltaSec) && j.deltaSec > 3.5
  );

  const recvDrifts = events.map((e) => e.drift).filter((x) => typeof x === 'number' && Number.isFinite(x));
  const recvDriftStats = (() => {
    if (!recvDrifts.length) return { count: 0, max: null, avg: null };
    const sum = recvDrifts.reduce((a, b) => a + b, 0);
    return { count: recvDrifts.length, max: +Math.max(...recvDrifts).toFixed(3), avg: +(sum / recvDrifts.length).toFixed(4) };
  })();

  const byTypeLat = { play: [], pause: [], seek: [] };
  for (const r of remotes) {
    const et = String(r.eventType || '').toLowerCase();
    if (typeof r.latency === 'number' && byTypeLat[et]) byTypeLat[et].push(r.latency);
  }
  const allLat = remotes.map((r) => r.latency).filter((x) => typeof x === 'number');

  const remoteOk = remotes.filter((r) => r.success).length;
  const remoteTotal = remotes.length;

  const eventTypeCounts = {};
  for (const e of events) {
    eventTypeCounts[e.type] = (eventTypeCounts[e.type] || 0) + 1;
  }

  const timelineKindCounts = {};
  for (const e of timeline) {
    const k = e.kind || 'unknown';
    timelineKindCounts[k] = (timelineKindCounts[k] || 0) + 1;
  }

  const tsList = [
    ...events.map((e) => e.t),
    ...remotes.map((r) => r.t),
    ...timeline.map((e) => e.t)
  ].filter((x) => typeof x === 'number');
  const observedSpanMs =
    tsList.length >= 2 ? Math.max(...tsList) - Math.min(...tsList) : tsList.length === 1 ? 0 : null;

  const sessionStartedAt = reportSession?.startedAt || null;
  const sessionDurationMs = sessionStartedAt ? Date.now() - sessionStartedAt : null;

  const flags = [];
  const playT = m.playOk + m.playFail;
  const pauseT = m.pauseOk + m.pauseFail;
  const seekT = m.seekOk + m.seekFail;
  if (playT >= 4 && m.playFail / playT > 0.2) flags.push('elevated_local_play_apply_failures');
  if (pauseT >= 4 && m.pauseFail / pauseT > 0.2) flags.push('elevated_local_pause_apply_failures');
  if (seekT >= 4 && m.seekFail / seekT > 0.2) flags.push('elevated_local_seek_apply_failures');
  if (remoteTotal >= 4 && remoteOk / remoteTotal < 0.75) flags.push('peers_report_many_apply_failures');
  if ((diag.timing?.driftEwmSec ?? 0) > 0.75) flags.push('high_drift_ewm_after_apply');
  if (recvDriftStats.max != null && recvDriftStats.max > 2) flags.push('large_pre_apply_recv_drift_observed');
  if ((fv.invalidations || 0) > 12) flags.push('frequent_findVideo_cache_invalidation');
  if (significantTimeupdateJumps.length > 6) flags.push('many_large_timeupdate_jumps');
  if (diag.tabHidden) flags.push('tab_hidden_at_export');
  if (!diag.videoAttached) flags.push('no_video_attached_at_export');
  if (isSoloSession) flags.push('solo_session_expected_gaps_in_remote_metrics');

  const eo = diag.extensionOps || {};
  const trSw = diag.serviceWorkerTransport;
  const deferredSync =
    (eo.syncStateDeferredNoVideo || 0) + (eo.syncStateDeferredStaleOrMissing || 0);
  if (deferredSync >= 6 && roomMeta && !roomMeta.isHost) {
    flags.push('joiner_deferred_sync_state_often');
  }
  if (trSw && (trSw.wsCloseCount || 0) >= 4) {
    flags.push('service_worker_ws_disconnects_frequent_since_start');
  }
  if ((eo.wsDisconnectEvents || 0) >= 4) {
    flags.push('content_tab_saw_many_ws_disconnected_events');
  }

  const correlationTraceDelivery = computeCorrelationTraceDelivery(diag);
  const vb = diag.videoBuffering || {};
  const msgDiag = diag.messaging || {};
  if ((vb.waiting || 0) > 25) flags.push('many_video_waiting_events_buffering_or_cdn');
  if ((vb.stalled || 0) > 12) flags.push('many_video_stalled_events_buffering_or_cdn');
  if ((msgDiag.runtimeSendFailures || 0) > 0 || (msgDiag.sendThrowCount || 0) > 0) {
    flags.push('content_script_messaging_failures_to_service_worker');
  }
  if ((trSw?.wsSendFailures || 0) > 0) {
    flags.push('service_worker_ws_send_failed_socket_not_open');
  }
  if (correlationTraceDelivery.clockSkewSuspected) {
    flags.push('correlation_trace_vs_client_recv_clock_skew_suspected');
  }
  const remoteDeny =
    (eo.remoteApplyDeniedSyncLock || 0) + (eo.remoteApplyDeniedNetflixDebounce || 0);
  if (remoteDeny >= 8) {
    flags.push('remote_apply_often_denied_sync_lock_or_netflix_debounce');
  }

  const tr = diag.sync?.testResults;
  const testSummary = tr?.done
    ? {
        soakRounds: tr.soakRounds || 1,
        durationSec: +((Date.now() - tr.start) / 1000).toFixed(1),
        peerTimeouts: tr.peerTimeouts ?? 0,
        steps: (tr.steps || []).map((s) => ({
          name: s.name,
          peerSuccess: s.peerSuccess,
          peerReported: s.peerReported
        }))
      }
    : null;

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
      successRate: remoteTotal ? Math.round((remoteOk / remoteTotal) * 10000) / 10000 : null
    },
    correlation: {
      serverTraceSamples: (diag.serverRoomTrace || []).length,
      timelineSteps: timeline.length
    },
    extensionBridge: {
      contentScript: { ...(eo || {}) },
      serviceWorkerTransport: trSw ? { ...trSw } : null
    },
    correlationTraceDelivery,
    videoBuffering: { ...vb },
    messaging: {
      runtimeSendFailures: msgDiag.runtimeSendFailures ?? 0,
      runtimeLastErrorAt: msgDiag.runtimeLastErrorAt ?? null,
      runtimeLastErrorMessage: msgDiag.runtimeLastErrorMessage
        ? truncStr(String(msgDiag.runtimeLastErrorMessage), 72)
        : null,
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
      'Solo session (1 client): apply ok/fail, drift-at-receive, and peer reports stay empty — there is no second player to echo or report. Check signaling (sent/recv) below; add a second device to validate end-to-end sync.'
    );
  }
  if (flags.includes('elevated_local_play_apply_failures')) {
    hints.push('Local play apply failures are high — review forcePlay / platform overlays and autoplay policy.');
  }
  if (flags.includes('peers_report_many_apply_failures')) {
    hints.push('Peers often report failed applies — compare platforms and check correlationIds across clients.');
  }
  if (flags.includes('frequent_findVideo_cache_invalidation')) {
    hints.push('Video element may be recreated often (SPA player) — consider re-attach and cache strategy.');
    const seeks = m.seekSent || 0;
    if (platformKey === 'prime' && seeks >= 12 && findVideoInvalidations >= seeks - 5) {
      hints.push(
        'Prime: cache is invalidated on each seeked event — seek count and invalidation count often rise together during scrubbing; compare attaches (should stay low if the same <video> is reused).'
      );
    }
  }
  if (flags.includes('many_large_timeupdate_jumps')) {
    hints.push(
      'Many timeupdate discontinuities >3.5s — usually real seeks or stream jumps (not sparse ~2s player sampling); may interact badly with sync thresholds.'
    );
  }
  if (flags.includes('joiner_deferred_sync_state_often')) {
    hints.push(
      'Joiner often queued SYNC_STATE (no video yet or stale element) — slow video attach or SPA player swaps; check extensionBridge counters and videoAttachCount.'
    );
  }
  if (flags.includes('service_worker_ws_disconnects_frequent_since_start')) {
    hints.push(
      'Service worker reports many WebSocket closes since start — flaky network, server restarts, or laptop sleep; compare wsCloseCount with tab-level WS_DISCONNECTED.'
    );
  }
  if (flags.includes('many_video_waiting_events_buffering_or_cdn') || flags.includes('many_video_stalled_events_buffering_or_cdn')) {
    hints.push(
      'High `waiting` / `stalled` on <video> — often CDN/adaptive rebuffering; compare timing with sync applies and correlationTraceDelivery so you do not blame sync alone.'
    );
  }
  if (flags.includes('content_script_messaging_failures_to_service_worker')) {
    hints.push(
      'Some chrome.runtime.sendMessage calls failed (service worker asleep or extension context invalid); playback actions may not reach the server.'
    );
  }
  if (flags.includes('service_worker_ws_send_failed_socket_not_open')) {
    hints.push('Service worker dropped outbound WS sends — socket was not OPEN; check wsSendFailures and reconnect timing.');
  }
  if (flags.includes('correlation_trace_vs_client_recv_clock_skew_suspected')) {
    hints.push(
      'Many negative server→client deltas in correlationTraceDelivery — device clocks may differ; use latency shape qualitatively, not absolute ms.'
    );
  }
  if (flags.includes('remote_apply_often_denied_sync_lock_or_netflix_debounce')) {
    hints.push(
      'Remote PLAY/PAUSE/SEEK often blocked by sync lock or Netflix debounce — rapid events or overlapping local actions; see extensionOps.remoteApplyDenied*.'
    );
  }
  if ((m.playRecv || 0) > (m.playSent || 0) + 2) {
    hints.push('More play_recv than play_sent — normal for viewers receiving host actions.');
  }
  if (
    hostOnlyControl === false &&
    memberCount != null &&
    memberCount > 1 &&
    flags.includes('large_pre_apply_recv_drift_observed')
  ) {
    hints.push(
      'hostOnlyControl=false: large “drift at receive” usually means another member’s playhead differed from yours when they sent PAUSE/PLAY (not wire latency). To measure transport-only drift, use host-only control or export from the viewer tab after a single host-driven seek.'
    );
  }
  if (platformKey === 'netflix') {
    hints.push('Netflix: debounce / threshold behavior may dominate; compare with metrics.playFail vs seek.');
  }
  if (platformKey === 'prime') {
    hints.push('Prime Video: video element replacement and Space/click fallbacks are common pain points.');
  }
  return hints;
}

/**
 * Short plain-text report for pasting into chat (Cursor, email, etc.).
 */
export function buildNarrativeSummary(payload) {
  const a = payload.analytics || {};
  const ap = a.applyOutcomesThisDevice || {};
  const sig = a.signalingThisDevice || {};
  const room = payload.room;
  const ctx = a.sessionContext || {};
  const solo = !!ctx.isSoloSession;
  const lines = [];

  lines.push('=== PlayShare sync diagnostic (for analysis) ===');
  lines.push(`Report schema: ${payload.reportSchemaVersion} | Extension: ${payload.extensionVersion}`);
  lines.push(`Exported (UTC): ${payload.exportedAt}`);
  lines.push(`Platform: ${payload.platform?.name || payload.platform?.key || '—'} (${payload.platform?.key || '—'})`);
  lines.push(`Page host (category): ${payload.pageHost || '—'}`);
  lines.push(`Role: ${room?.isHost ? 'host' : room ? 'viewer' : 'not in room'} | Members: ${room?.memberCount ?? '—'}`);
  if (room?.policies) {
    lines.push(
      `Room rules: hostOnlyControl=${!!room.policies.hostOnlyControl} · countdownOnPlay=${!!room.policies.countdownOnPlay}`
    );
  }
  if (solo) {
    lines.push('Session: SOLO — remote-apply and peer metrics require 2+ members.');
  }
  lines.push(`Connection: ${payload.connectionStatus} | Video attached: ${payload.videoAttached}`);
  const rttLine =
    payload.timing?.lastRttMs != null
      ? `${payload.timing.lastRttMs}ms (WS heartbeat RTT/2 used for sync)`
      : '— (not sampled in this snapshot; connect a few seconds — heartbeats ~5s)';
  const rttProv = payload.timing?.lastRttSource ? ` [${payload.timing.lastRttSource}]` : '';
  lines.push(`RTT last: ${rttLine}${rttProv} | Drift EWM: ${payload.timing?.driftEwmSec != null ? payload.timing.driftEwmSec.toFixed(4) + 's' : '—'} (after remote apply only)`);
  lines.push('');
  lines.push('--- Extension & server connectivity ---');
  const cd = payload.connectionDetail;
  const tabConn = `${payload.connectionStatus ?? '—'}${cd?.transportPhase ? ` · transport: ${cd.transportPhase}` : ''}`;
  lines.push(`Signaling socket (as seen by this tab): ${tabConn}`);
  if (cd?.connectionMessage) lines.push(`Transport detail: ${cd.connectionMessage}`);
  const swt = payload.serviceWorkerTransport;
  if (swt && typeof swt === 'object') {
    lines.push(
      `Service worker WebSocket: host ${swt.serverHost ?? '—'} · readyState ${swt.wsReadyState ?? '—'} · opens ${swt.wsOpenCount ?? 0} · closes ${swt.wsCloseCount ?? 0} · send failures ${swt.wsSendFailures ?? 0}`
    );
    lines.push(
      `  last open: ${swt.lastWsOpenedAt != null ? new Date(swt.lastWsOpenedAt).toISOString() : '—'} · last close: ${swt.lastWsClosedAt != null ? new Date(swt.lastWsClosedAt).toISOString() : '—'}`
    );
  } else {
    lines.push('Service worker WebSocket: no snapshot (open Sync analytics once to refresh GET_DIAG).');
  }
  const msg = payload.messaging;
  lines.push(
    `Tab ↔ service worker messaging: runtime.lastError ×${msg?.runtimeSendFailures ?? 0} · send() threw ×${msg?.sendThrowCount ?? 0}${msg?.runtimeLastErrorMessage ? ` · last: ${msg.runtimeLastErrorMessage}` : ''}`
  );
  lines.push('');
  if (payload.capture) {
    const c = payload.capture;
    lines.push('--- How this snapshot was captured ---');
    lines.push(
      c.exportPreparedAtIso
        ? `Prepared at: ${c.exportPreparedAtIso} (GET_DIAG + ~0.5s trace wait + fresh video health)`
        : 'Prepared at: — (export without full refresh — prefer overlay buttons)'
    );
    lines.push(`Tab: ${c.tabVisibility ?? '—'} | doc focus: ${c.documentHasFocus == null ? '—' : c.documentHasFocus} | overlay: ${c.overlayOpenDuringExport == null ? '—' : c.overlayOpenDuringExport}`);
    if (c.serverRoomTraceAgeMsAtExport != null) {
      lines.push(`Server trace age at export: ${(c.serverRoomTraceAgeMsAtExport / 1000).toFixed(2)}s`);
    }
    lines.push(`RTT value source: ${c.lastRttProvenance ?? '—'}`);
    if (c.pendingSyncStateQueued != null) {
      lines.push(`Joiner pending SYNC_STATE queued: ${c.pendingSyncStateQueued ? 'yes' : 'no'}`);
    }
    lines.push('');
  }
  if (payload.dataCompleteness) {
    const d = payload.dataCompleteness;
    lines.push('--- Data completeness ---');
    lines.push(
      `sync events: ${d.syncEventsIncludedInExport}/${d.syncEventsStored} | remote apply rows: ${d.remoteApplyIncludedInExport}/${d.remoteApplyStored} | timeline: ${d.timelineIncludedInExport}/${d.timelineStored}`
    );
    lines.push(`Truncated for file size: ${d.anyTruncation ? 'yes' : 'no'}`);
    lines.push('');
  }
  const eb = a.extensionBridge;
  if (eb?.contentScript && Object.keys(eb.contentScript).length) {
    const c = eb.contentScript;
    lines.push('--- Extension bridge (this tab) ---');
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
    lines.push('');
  }
  if (payload.videoBuffering && ((payload.videoBuffering.waiting ?? 0) > 0 || (payload.videoBuffering.stalled ?? 0) > 0)) {
    const v = payload.videoBuffering;
    lines.push('--- Video buffering (cumulative) ---');
    lines.push(`waiting ×${v.waiting ?? 0} · stalled ×${v.stalled ?? 0}`);
    lines.push('');
  }
  const ctd = a.correlationTraceDelivery;
  if (ctd && (ctd.matched > 0 || ctd.traceEventsWithIdConsidered > 0)) {
    lines.push('--- Server trace ↔ client recv (correlationId) ---');
    const s = ctd.summary || {};
    lines.push(
      `Matched ${ctd.matched}/${ctd.traceEventsWithIdConsidered} playback rows · clientRecv−serverTrace ms: n=${s.count ?? 0} avg=${s.avg ?? '—'} p50=${s.p50 ?? '—'} p90=${s.p90 ?? '—'}${ctd.clockSkewSuspected ? ' · clock skew suspected' : ''}`
    );
    lines.push('');
  }
  if (payload.sessionChronology?.memberTimeline?.length) {
    lines.push('--- Session chronology (recent, redacted) ---');
    payload.sessionChronology.memberTimeline.slice(0, 12).forEach((row) => {
      const when = typeof row.t === 'number' ? new Date(row.t).toISOString() : '?';
      lines.push(`• ${row.kind} ${row.username || row.roomCodeTrunc || ''} @ ${when}`);
    });
    lines.push('');
  }
  if (payload.sessionChronology?.recentAutomatedTestRuns?.length) {
    lines.push('--- Recent automated test runs (metadata) ---');
    payload.sessionChronology.recentAutomatedTestRuns.forEach((run, i) => {
      lines.push(`Run ${i + 1}: ${run.durationMs}ms soak=${run.soakRounds} members=${run.memberCountAtRun} host=${run.isHost} steps=${run.stepCount} peerTimeouts=${run.peerTimeouts}`);
    });
    lines.push('');
  }
  lines.push('--- Signaling (this tab; WS play/pause/seek messages) ---');
  for (const k of ['play', 'pause', 'seek']) {
    const s = sig[k] || { sent: 0, recv: 0 };
    lines.push(`${k}: sent ${s.sent} | recv ${s.recv}${room?.isHost ? ' (host: recv often 0 for own actions)' : ''}`);
  }
  lines.push('');
  lines.push('--- Apply verification (this device, after inbound sync) ---');
  for (const k of ['play', 'pause', 'seek']) {
    const r = ap[k];
    if (r && r.total) lines.push(`${k}: ${r.ok} ok / ${r.fail} fail (${((r.successRate || 0) * 100).toFixed(1)}%)`);
    else if (solo) lines.push(`${k}: no inbound applies yet (solo — normal)`);
    else lines.push(`${k}: no completed apply checks (no inbound sync or not enough activity)`);
  }
  lines.push('');
  lines.push('--- Peer-reported applies (what others said after your actions) ---');
  const p = a.peers || {};
  if (solo) {
    lines.push('N/A with 1 member — need another client in the room to receive DIAG_SYNC_APPLY_RESULT.');
  } else {
    lines.push(`Reports: ${p.applyReportsReceived} | Success rate: ${p.successRate != null ? (p.successRate * 100).toFixed(1) + '%' : '—'}`);
    const lat = a.latencyMsPeerReported?.all;
    if (lat && lat.count) lines.push(`Latency (ms): n=${lat.count} avg=${lat.avg} p50=${lat.p50} p90=${lat.p90}`);
  }
  lines.push('');
  lines.push('--- Drift at receive (before apply) ---');
  const rd = a.recvDriftAtReceive;
  if (rd?.count) lines.push(`n=${rd.count} avg=${rd.avg}s max=${rd.max}s`);
  else if (solo) lines.push('no remote sync events (solo — expected)');
  else lines.push('no data');
  lines.push('');
  lines.push('--- Video / DOM ---');
  const vf = a.videoFinder || {};
  lines.push(`findVideo: hits ${vf.cacheReturns} scans ${vf.fullScans} invalidations ${vf.invalidations} attaches ${vf.videoAttachCount}`);
  lines.push(
    `Timeupdate jumps: significant (>3.5s) ${a.timeupdateSignificantJumps ?? a.timeupdateLargeJumps ?? 0} · raw ring ${a.timeupdateJumpsLogged ?? a.timeupdateLargeJumps ?? 0}`
  );
  lines.push('');
  if (a.flags?.length) {
    lines.push('--- Flags ---');
    a.flags.forEach((f) => lines.push(`! ${f}`));
    lines.push('');
  }
  if (a.analystHints?.length) {
    lines.push('--- Hints ---');
    a.analystHints.forEach((h) => lines.push(`• ${h}`));
    lines.push('');
  }
  if (a.automatedTest) {
    lines.push('--- Last automated sync test ---');
    lines.push(JSON.stringify(a.automatedTest, null, 2));
    if (solo) {
      lines.push('(peerSuccess / peerReported are null with 1 member — run again with a second client.)');
    }
    lines.push('');
  }
  lines.push(payload.howToUse || '');
  return lines.filter(Boolean).join('\n');
}

/**
 * Enum-like strings for IntelPro (no free-form text). Superset of analytics.flags plus scenario markers.
 * @param {{
 *   analyticsFlags?: string[]|null,
 *   memberCount?: number,
 *   dataCompleteness?: { anyTruncation?: boolean }|null,
 *   videoAttached?: boolean,
 *   tabHidden?: boolean
 * }} opts
 * @returns {string[]}
 */
export function buildDiagSynopsisCodes({ analyticsFlags, memberCount, dataCompleteness, videoAttached, tabHidden }) {
  /** @type {Set<string>} */
  const set = new Set();
  const pushCode = (s) => {
    if (typeof s !== 'string') return;
    const t = s.trim().slice(0, 72);
    if (!t || !/^[a-z][a-z0-9_]*$/i.test(t)) return;
    set.add(t);
  };
  if (Array.isArray(analyticsFlags)) {
    for (const f of analyticsFlags) pushCode(f);
  }
  if (memberCount != null && Number.isFinite(memberCount) && memberCount <= 1) {
    set.add('scenario_solo_session');
  }
  if (dataCompleteness && dataCompleteness.anyTruncation === true) {
    set.add('export_data_truncated');
  }
  if (videoAttached === false) {
    set.add('scenario_no_video_attached');
  }
  if (tabHidden) {
    set.add('scenario_tab_hidden_at_export');
  }
  return [...set].sort().slice(0, 56);
}

/**
 * Redacted JSON-safe snapshot + analytics + narrative for upload / paste.
 */
export function buildDiagnosticExport({
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
    anyTruncation:
      evsLen > 80 || remLen > 35 || tlLen > 60 || traceLen > 45 || tuFull.length > 20
  };

  const capture = {
    clientClockNote: 'Timestamps are this browser client Date.now() unless labeled serverTime',
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
      roomCodeTrunc: row.roomCode ? String(row.roomCode).slice(0, 4) + '…' : undefined,
      memberCount: row.memberCount,
      isHost: row.isHost,
      username: row.username ? truncStr(String(row.username), 20) : undefined,
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
    exportedAt: new Date().toISOString(),
    extensionVersion: extVersion || 'unknown',
    userAgent: truncStr(userAgent || '', 120),
    platform: { key: platform.key, name: platform.name },
    pageHost: pageHost ? truncStr(String(pageHost), 48) : null /** streaming hostname only */,
    videoAttached: !!videoAttached,
    room: roomState
      ? {
          roomCode: roomState.roomCode,
          memberCount: (roomState.members || []).length,
          isHost: roomState.isHost,
          clientIdShort: roomState.clientId ? String(roomState.clientId).slice(0, 10) + '…' : null,
          policies: {
            hostOnlyControl: !!roomState.hostOnlyControl,
            countdownOnPlay: !!roomState.countdownOnPlay
          }
        }
      : null,
    pendingSyncStateQueued: !!diag.pendingSyncStateQueued,
    extensionOps: { ...(diag.extensionOps || {}) },
    serviceWorkerTransport: diag.serviceWorkerTransport ? { ...diag.serviceWorkerTransport } : null,
    messaging: diag.messaging
      ? {
          runtimeSendFailures: diag.messaging.runtimeSendFailures ?? 0,
          runtimeLastErrorAt: diag.messaging.runtimeLastErrorAt ?? null,
          runtimeLastErrorMessage: diag.messaging.runtimeLastErrorMessage
            ? truncStr(String(diag.messaging.runtimeLastErrorMessage), 80)
            : null,
          sendThrowCount: diag.messaging.sendThrowCount ?? 0
        }
      : null,
    videoBuffering: diag.videoBuffering
      ? {
          waiting: diag.videoBuffering.waiting ?? 0,
          stalled: diag.videoBuffering.stalled ?? 0,
          lastWaitingAt: diag.videoBuffering.lastWaitingAt ?? null,
          lastStalledAt: diag.videoBuffering.lastStalledAt ?? null
        }
      : null,
    connectionStatus: diag.connectionStatus,
    connectionDetail: {
      transportPhase:
        diag.transportPhase && String(diag.transportPhase).trim()
          ? truncStr(String(diag.transportPhase).trim(), 64)
          : null,
      connectionMessage:
        diag.connectionMessage && String(diag.connectionMessage).trim()
          ? truncStr(String(diag.connectionMessage).trim(), 200)
          : null
    },
    tabHidden: !!diag.tabHidden,
    diagOverlayStale: !!diag.diagOverlayStale,
    clusterSync: diag.clusterSync
      ? {
          spreadSec: diag.clusterSync.spreadSec,
          synced: diag.clusterSync.synced,
          playingMismatch: diag.clusterSync.playingMismatch,
          freshMemberCount: diag.clusterSync.freshMemberCount,
          staleCount: diag.clusterSync.staleCount,
          label: diag.clusterSync.label ? truncStr(String(diag.clusterSync.label), 64) : null,
          wallMs: diag.clusterSync.wallMs
        }
      : null,
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
      metrics: { ...(diag.sync?.metrics || {}) },
      events: evs.slice(0, 80).map((e) => ({
        ...e,
        fromUsername: e.fromUsername ? truncStr(String(e.fromUsername), 24) : e.fromUsername
      })),
      remoteApplyResults: remotesFull.slice(0, 35).map((r) => ({
        ...r,
        fromUsername: r.fromUsername ? truncStr(String(r.fromUsername), 24) : r.fromUsername,
        correlationId: r.correlationId ? String(r.correlationId).slice(0, 12) + '…' : r.correlationId
      })),
      peerReportIds: Object.keys(diag.sync?.peerReports || {}).map((id) => (id ? id.slice(0, 8) + '…' : id)),
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
      correlationId: e.correlationId ? String(e.correlationId).slice(0, 12) + '…' : e.correlationId
    })),
    recentErrors: (diag.errors || []).slice(0, 8).map((e) => ({
      t: e.t,
      event: e.event,
      detail:
        e.detail && typeof e.detail === 'object'
          ? { message: truncStr(String(e.detail.message || ''), 72) }
          : e.detail
    })),
    analytics,
    howToUse:
      'Upload JSON or paste narrativeSummary. v2.5: top “Extension & server connectivity” + extensionOps / serviceWorkerTransport / connectionDetail in JSON. v2.3+: apply denials, messaging failures, WS send drops, buffering, correlationTraceDelivery. Export refreshes RTT + trace. No full URLs/chat.',
    note: 'Redacted for privacy. sessionChronology + dataCompleteness describe how the test was run and what was clipped. When embedded under playshareUnifiedExport, this object is the "extension" slice alongside videoPlayerProfiler and (on Prime) primeSiteDebug.'
  };

  payload.diagSynopsisCodes = buildDiagSynopsisCodes({
    analyticsFlags: analytics.flags,
    memberCount,
    dataCompleteness,
    videoAttached: !!videoAttached,
    tabHidden: !!diag.tabHidden
  });

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
