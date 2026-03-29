/**
 * Derive normalized summary + likelihood tags from unified diagnostic JSON (post-ingest stamp OK).
 */

function num(x, d = null) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return d;
  return x;
}

function countProfilerEvents(events, type) {
  if (!Array.isArray(events)) return 0;
  return events.filter((e) => e && e.type === type).length;
}

/**
 * Privacy-safe histogram of profiler event types (no URLs / custom strings).
 * @param {unknown[]} events
 * @returns {Record<string, number>|null}
 */
function profilerEventTypeHistogram(events) {
  if (!Array.isArray(events) || !events.length) return null;
  /** @type {Record<string, number>} */
  const o = {};
  for (const e of events) {
    if (!e || typeof e !== 'object' || typeof e.type !== 'string') continue;
    const t = e.type.trim().slice(0, 64);
    if (!t) continue;
    o[t] = (o[t] || 0) + 1;
  }
  return Object.keys(o).length ? o : null;
}

const MAX_DERIVED_TAGS = 48;

/** @param {unknown} s */
function safeAnalyticsFlagToken(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim().slice(0, 72);
  if (!t || !/^[a-z][a-z0-9_]*$/i.test(t)) return null;
  return t;
}

/**
 * Numbers/booleans only — extension `dataCompleteness` is already summary-sized.
 * @param {unknown} dc
 * @returns {Record<string, number|boolean>|null}
 */
function sanitizeDataCompletenessForMetrics(dc) {
  if (!dc || typeof dc !== 'object') return null;
  /** @type {Record<string, number|boolean>} */
  const o = {};
  for (const [k, v] of Object.entries(dc)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      o[k] = Math.round(Math.min(Math.max(v, -1e9), 1e9));
    } else if (typeof v === 'boolean') {
      o[k] = v;
    }
  }
  return Object.keys(o).length ? o : null;
}

/**
 * @param {string[]} ruleTags
 * @param {unknown} flags
 * @returns {string[]}
 */
function mergeAnalyticsFlagsIntoDerivedTags(ruleTags, flags) {
  const out = [];
  const seen = new Set();
  for (const t of ruleTags) {
    const s = typeof t === 'string' ? t.trim() : '';
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  if (!Array.isArray(flags)) return out;
  for (const f of flags) {
    if (out.length >= MAX_DERIVED_TAGS) break;
    const tok = safeAnalyticsFlagToken(f);
    if (!tok || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/** @param {unknown} prd */
function summarizePeerRecordingForMetrics(prd) {
  if (!prd || typeof prd !== 'object') return null;
  const peers = Array.isArray(prd.peers) ? prd.peers : [];
  if (!peers.length) return null;
  let sampleRows = 0;
  let videoTrue = 0;
  let videoFalse = 0;
  /** @type {Set<string>} */
  const platformKeys = new Set();
  for (const p of peers) {
    if (!p || typeof p !== 'object') continue;
    const n = typeof p.sampleCount === 'number' && Number.isFinite(p.sampleCount) ? p.sampleCount : 0;
    sampleRows += n;
    const samples = Array.isArray(p.samples) ? p.samples : [];
    let sliceN = 0;
    for (const s of samples) {
      if (sliceN >= 120) break;
      sliceN++;
      if (s && typeof s === 'object') {
        if (s.videoAttached === true) videoTrue++;
        else if (s.videoAttached === false) videoFalse++;
        const pk = s.platform && typeof s.platform === 'object' && typeof s.platform.key === 'string' ? s.platform.key : null;
        if (pk) platformKeys.add(String(pk).slice(0, 32));
      }
    }
  }
  return {
    peer_count: peers.length,
    sample_rows_total: sampleRows,
    collector_recording: prd.collectorRecording === true,
    sample_video_attached_true: videoTrue,
    sample_video_attached_false: videoFalse,
    distinct_peer_platform_keys: platformKeys.size
  };
}

/** @param {unknown} psd */
function summarizePrimeSiteDebugForMetrics(psd) {
  if (!psd || typeof psd !== 'object') return null;
  if (typeof psd.captureError === 'string' && psd.captureError.trim()) {
    const raw = psd.captureError.trim().slice(0, 200);
    const capture_error_token = raw
      .replace(/[^\w.:+/-]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 96);
    return {
      capture_failed: true,
      capture_error_token: capture_error_token || 'unknown'
    };
  }
  const ext = psd.extension && typeof psd.extension === 'object' ? psd.extension : {};
  const pad = psd.primeAdDetection && typeof psd.primeAdDetection === 'object' ? psd.primeAdDetection : {};
  const ch = pad.channels && typeof pad.channels === 'object' ? pad.channels : {};
  const frame = psd.frameCapture && typeof psd.frameCapture === 'object' ? psd.frameCapture : {};
  const notes = Array.isArray(psd.syncDebugNotes) ? psd.syncDebugNotes : [];
  let adChTrue = 0;
  for (const k of ['adCountdownUi', 'adTimerUi', 'playerAdControls', 'mediaSession']) {
    if (ch[k] === true) adChTrue++;
  }
  const vc = Array.isArray(psd.videoCandidates) ? Math.min(psd.videoCandidates.length, 24) : null;
  return {
    kind: typeof psd.kind === 'string' ? psd.kind.slice(0, 64) : null,
    in_room: ext.inRoom === true,
    is_host: ext.isHost === true,
    local_ad_break_active: ext.localAdBreakActive === true,
    ad_detection_score: typeof pad.score === 'number' && Number.isFinite(pad.score) ? pad.score : null,
    ad_channel_signals_true: adChTrue,
    sync_debug_note_count: Math.min(notes.length, 50),
    frame_capture_attempted: frame.attempted === true,
    video_candidate_count: vc,
    multi_user_sync_present: psd.multiUserSync != null && typeof psd.multiUserSync === 'object'
  };
}

/** @param {unknown} codes */
function sanitizeDiagSynopsisCodes(codes) {
  if (!Array.isArray(codes)) return null;
  const out = [];
  const seen = new Set();
  for (const c of codes) {
    if (out.length >= 56) break;
    const t = safeAnalyticsFlagToken(c);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.length ? out : null;
}

/**
 * @param {unknown} prof — unified.videoPlayerProfiler
 */
function userMarkerCodeCountsFromProfiler(prof) {
  if (!prof || typeof prof !== 'object') return null;
  const rollup =
    prof.session && typeof prof.session === 'object' && prof.session.rollup && typeof prof.session.rollup === 'object'
      ? prof.session.rollup
      : null;
  const fromRollup =
    rollup && rollup.userMarkerCodeCounts && typeof rollup.userMarkerCodeCounts === 'object'
      ? rollup.userMarkerCodeCounts
      : null;
  /** @type {Record<string, number>} */
  const o = {};
  if (fromRollup) {
    for (const [k, v] of Object.entries(fromRollup)) {
      const t = safeAnalyticsFlagToken(k);
      if (!t || typeof v !== 'number' || !Number.isFinite(v)) continue;
      o[t] = Math.min(Math.max(Math.round(v), 0), 999);
    }
  }
  if (!Object.keys(o).length) {
    const evs = prof.events || [];
    for (const e of evs) {
      if (!e || e.type !== 'user_marker' || typeof e.code !== 'string') continue;
      const t = safeAnalyticsFlagToken(e.code);
      if (!t) continue;
      o[t] = (o[t] || 0) + 1;
    }
  }
  return Object.keys(o).length ? o : null;
}

/**
 * @param {unknown} extCodesRaw
 * @param {Record<string, number>|null} userMarkerCounts
 */
function mergeDiagSynopsisCodes(extCodesRaw, userMarkerCounts) {
  const base = sanitizeDiagSynopsisCodes(extCodesRaw) || [];
  /** @type {Set<string>} */
  const set = new Set(base);
  if (userMarkerCounts && typeof userMarkerCounts === 'object') {
    for (const k of Object.keys(userMarkerCounts)) {
      const t = safeAnalyticsFlagToken(k);
      if (t) set.add(t);
    }
  }
  if (!set.size) return null;
  return [...set].sort().slice(0, 56);
}

/**
 * @param {string[]} tags
 * @param {Record<string, number>|null} markerCounts
 */
function mergeMarkerDerivedTags(tags, markerCounts) {
  if (!markerCounts || typeof markerCounts !== 'object') return [...tags];
  const out = [...tags];
  const seen = new Set(out);
  for (const k of Object.keys(markerCounts)) {
    if (out.length >= MAX_DERIVED_TAGS) break;
    const t = safeAnalyticsFlagToken(k);
    if (!t) continue;
    const tag = `marker_${t}`;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function countEventsCorrectionReason(events, reason) {
  if (!Array.isArray(events)) return 0;
  return events.filter((e) => e && e.correctionReason === reason).length;
}

/**
 * Same stack logic as client `computeProfilerRebufferRemoteSyncOverlap` — server-side so IntelPro
 * gets overlap stats even on older extension builds (when profiler.events are present).
 * @param {unknown[]} events
 */
function computeProfilerRebufferOverlapFromEvents(events) {
  if (!Array.isArray(events) || !events.length) {
    return {
      profilerEventsConsidered: 0,
      closedBufferWindows: 0,
      openBufferDepthAtExportEnd: 0,
      remoteCorrectionAppliedDuringBuffer: 0,
      remoteCorrectionReceivedDuringBuffer: 0,
      overlapSuspicious: false
    };
  }
  const norm = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const type = typeof e.type === 'string' ? e.type.trim() : '';
    if (!type) continue;
    const mono = typeof e.monoMs === 'number' && Number.isFinite(e.monoMs) ? e.monoMs : null;
    const wall = typeof e.t === 'number' && Number.isFinite(e.t) ? e.t : null;
    norm.push({ type, mono, wall });
  }
  norm.sort((a, b) => {
    const ta = a.mono != null ? a.mono : a.wall ?? 0;
    const tb = b.mono != null ? b.mono : b.wall ?? 0;
    return ta - tb;
  });
  function tOf(e) {
    return e.mono != null ? e.mono : e.wall ?? 0;
  }
  const stack = [];
  let closedBufferWindows = 0;
  let appliedDuring = 0;
  let receivedDuring = 0;
  for (const e of norm) {
    if (e.type === 'buffer_recovery_start') {
      stack.push(tOf(e));
    } else if (e.type === 'buffer_recovery_end') {
      if (stack.length) {
        stack.pop();
        closedBufferWindows++;
      }
    } else if (e.type === 'remote_correction_applied') {
      if (stack.length) appliedDuring++;
    } else if (e.type === 'remote_correction_received') {
      if (stack.length) receivedDuring++;
    }
  }
  const overlapSuspicious =
    appliedDuring >= 3 || (appliedDuring >= 1 && closedBufferWindows >= 2 && appliedDuring + receivedDuring >= 4);
  return {
    profilerEventsConsidered: norm.length,
    closedBufferWindows,
    openBufferDepthAtExportEnd: stack.length,
    remoteCorrectionAppliedDuringBuffer: appliedDuring,
    remoteCorrectionReceivedDuringBuffer: receivedDuring,
    overlapSuspicious
  };
}

/** @param {unknown} analytics */
function sanitizeCorrelationTraceDelivery(analytics) {
  const ctd =
    analytics && typeof analytics === 'object' && analytics.correlationTraceDelivery && typeof analytics.correlationTraceDelivery === 'object'
      ? analytics.correlationTraceDelivery
      : null;
  if (!ctd) return null;
  const s = ctd.summary && typeof ctd.summary === 'object' ? ctd.summary : {};
  const out = {
    matched: num(ctd.matched, 0),
    trace_events_considered: num(ctd.traceEventsWithIdConsidered, 0),
    clock_skew_suspected: ctd.clockSkewSuspected === true,
    latency_ms_count: num(s.count, 0),
    latency_ms_avg: typeof s.avg === 'number' && Number.isFinite(s.avg) ? Math.round(s.avg) : null,
    latency_ms_p50: typeof s.p50 === 'number' && Number.isFinite(s.p50) ? Math.round(s.p50) : null,
    latency_ms_p90: typeof s.p90 === 'number' && Number.isFinite(s.p90) ? Math.round(s.p90) : null
  };
  return out.matched > 0 || out.trace_events_considered > 0 ? out : null;
}

const INTEL_EXTOP_KEYS = [
  'syncStateInbound',
  'syncStateApplied',
  'syncStateSkippedRedundant',
  'syncStateDeferredNoVideo',
  'syncStateDeferredStaleOrMissing',
  'syncStateDeferredRebuffer',
  'syncStateHeldForAd',
  'syncStateDeniedSyncLock',
  'syncStateDeniedPlaybackDebounce',
  'remoteApplyDeniedSyncLock',
  'remoteApplyDeniedPlaybackDebounce',
  'remoteApplyDeferredTabHidden',
  'hostPlaybackPositionSent',
  'viewerSyncRequestSent',
  'positionReportSent',
  'positionSnapshotInbound',
  'wsDisconnectEvents',
  'syncDecisionRejectedCooldown',
  'syncDecisionRejectedConverging',
  'syncDecisionRejectedReconnectSettle',
  'syncDecisionNetflixSafetyNoop',
  'softDriftPlaybackStarts',
  'localControlBlockedHostOnly',
  'playbackOutboundSuppressedLocalAd'
];

/** @param {unknown} eo */
function summarizeExtensionOpsIntel(eo) {
  if (!eo || typeof eo !== 'object') return null;
  /** @type {Record<string, number>} */
  const o = {};
  for (const k of INTEL_EXTOP_KEYS) {
    const v = eo[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      o[k] = Math.min(Math.max(Math.round(v), 0), 1e6);
    }
  }
  return Object.keys(o).length ? o : null;
}

/** @param {unknown} analytics */
function signalingCountsFromAnalytics(analytics) {
  const s =
    analytics && typeof analytics === 'object' && analytics.signalingThisDevice && typeof analytics.signalingThisDevice === 'object'
      ? analytics.signalingThisDevice
      : null;
  if (!s) return null;
  /** @type {Record<string, number>} */
  const o = {};
  for (const ev of ['play', 'pause', 'seek']) {
    const b = s[ev];
    if (!b || typeof b !== 'object') continue;
    if (typeof b.sent === 'number' && Number.isFinite(b.sent)) o[`${ev}_sent`] = Math.min(Math.max(Math.round(b.sent), 0), 1e6);
    if (typeof b.recv === 'number' && Number.isFinite(b.recv)) o[`${ev}_recv`] = Math.min(Math.max(Math.round(b.recv), 0), 1e6);
  }
  return Object.keys(o).length ? o : null;
}

/** @param {unknown} analytics */
function timeupdateSignificantJumpCount(analytics) {
  if (!analytics || typeof analytics !== 'object') return null;
  const a = num(analytics.timeupdateSignificantJumps, -1);
  if (a >= 0) return Math.min(a, 1e5);
  const b = num(analytics.timeupdateLargeJumps, -1);
  if (b >= 0) return Math.min(b, 1e5);
  return null;
}

/** @param {unknown} msg */
function messagingFailureCounts(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const rf = num(msg.runtimeSendFailures, 0);
  const st = num(msg.sendThrowCount, 0);
  if (rf <= 0 && st <= 0) return null;
  return {
    runtime_send_failures: rf,
    send_throw_count: st
  };
}

/**
 * @param {{ payload: object, testRunId?: string|null }} args
 */
function normalizeDiagnosticReport(args) {
  const unified = args.payload || {};
  const ext = unified.extension || {};
  const eo = ext.extensionOps || {};
  const analytics = ext.analytics || {};
  const vb = ext.videoBuffering || {};
  const sw = ext.serviceWorkerTransport || {};
  const prof = unified.videoPlayerProfiler || {};
  const profEvents = prof.events || [];
  const profilerEventCounts = profilerEventTypeHistogram(profEvents);
  const profBufferOverlap = computeProfilerRebufferOverlapFromEvents(profEvents);
  const correlationTrace = sanitizeCorrelationTraceDelivery(analytics);
  const extensionOpsIntel = summarizeExtensionOpsIntel(eo);
  const signalingCounts = signalingCountsFromAnalytics(analytics);
  const tuJumpC = timeupdateSignificantJumpCount(analytics);
  const messagingFails = messagingFailureCounts(ext.messaging);
  const rebufferDefer = num(eo.syncStateDeferredRebuffer, 0);
  const rollup = prof.session?.rollup || {};
  const userMarkerCodeCounts = userMarkerCodeCountsFromProfiler(prof);
  const prog = prof.session?.summary?.progressionQuality || {};

  const latAll = analytics.latencyMsPeerReported?.all || {};
  const play = analytics.applyOutcomesThisDevice?.play || {};
  const pause = analytics.applyOutcomesThisDevice?.pause || {};
  const seek = analytics.applyOutcomesThisDevice?.seek || {};
  const ok = (play.ok || 0) + (pause.ok || 0) + (seek.ok || 0);
  const fail = (play.fail || 0) + (pause.fail || 0) + (seek.fail || 0);
  const localApplyTotal = ok + fail;
  const localSuccessRate = localApplyTotal > 0 ? Math.round((ok / localApplyTotal) * 10000) / 10000 : null;

  const peerSuccess = num(analytics.peers?.successRate, null);

  const recvDrift = analytics.recvDriftAtReceive || {};
  const driftAvg = num(recvDrift.avg, null);
  const driftMax = num(recvDrift.max, null);

  let sessionDur = num(analytics.session?.sessionDurationSinceJoinMs, null);
  if (sessionDur == null && prof.session?.startedAtMs != null) {
    const end = num(prof.session.endedAtMs, Date.now());
    sessionDur = end - prof.session.startedAtMs;
  }

  const hardCorrectionCount = countProfilerEvents(profEvents, 'hard_correction_selected');

  let softDriftCount = num(eo.softDriftPlaybackStarts, 0);
  if (softDriftCount === 0) {
    softDriftCount =
      countProfilerEvents(profEvents, 'soft_drift_selected') ||
      countProfilerEvents(profEvents, 'playback_rate_nudge_start');
  }

  const wsDisc = num(eo.wsDisconnectEvents, 0) + num(sw.wsCloseCount, 0);

  const syncEv = ext.sync?.events || [];
  const laggardFromSync = countEventsCorrectionReason(syncEv, 'laggard_anchor');
  const laggardFromProf = countEventsCorrectionReason(profEvents, 'laggard_anchor');

  const transportRtt = num(ext.timing?.lastRttMs, null);
  const peerApplyMax = num(latAll.max, null);
  const handlerKey =
    unified.enrichment?.syncConfigSnapshot?.handlerKey != null
      ? String(unified.enrichment.syncConfigSnapshot.handlerKey)
      : ext.platform?.key || 'unknown';
  const progMaxTuGap = num(prog.maxTimeupdateGapMs, null);
  const videoRebounds = num(rollup.videoElementRebounds, null);

  const extensionVersionNorm = String(
    unified.ingestMeta?.extensionVersionDeclared ||
      unified.uploadClient?.extensionVersion ||
      ext.extensionVersion ||
      ''
  ).slice(0, 32);

  const summary = {
    extension_version: extensionVersionNorm || null,
    test_run_id: args.testRunId || unified.anonymization?.testRunId || null,
    device_id_hash: unified.anonymization?.deviceIdHash || null,
    room_id_hash: unified.anonymization?.roomIdHash || ext.room?.roomIdHash || null,
    role: ext.room ? (ext.room.isHost ? 'host' : 'viewer') : 'solo',
    platform: ext.platform?.key || unified.enrichment?.syncConfigSnapshot?.handlerKey || 'unknown',
    handler_key: handlerKey,
    progression_max_timeupdate_gap_ms: progMaxTuGap,
    video_element_rebounds: videoRebounds,
    member_count: num(ext.room?.memberCount, null),
    recording_duration_ms: sessionDur,
    avg_transport_rtt_ms: transportRtt,
    max_peer_apply_latency_ms: peerApplyMax,
    avg_rtt_ms: transportRtt,
    max_rtt_ms: null,
    ws_disconnect_count: wsDisc,
    sync_apply_success_rate: peerSuccess != null ? peerSuccess : localSuccessRate,
    drift_avg_sec: driftAvg,
    drift_max_sec: driftMax,
    hard_correction_count: hardCorrectionCount,
    soft_drift_count: softDriftCount,
    ad_mode_enter_count:
      countProfilerEvents(profEvents, 'ad_mode_visible_start') + num(eo.syncDecisionRejectedServerAdMode, 0),
    laggard_anchor_count: laggardFromSync + laggardFromProf,
    buffering_count: num(vb.waiting, 0),
    stalled_count: num(vb.stalled, 0),
    source_swap_count: num(rollup.currentSrcChanges, 0) + countProfilerEvents(profEvents, 'src_swap_detected'),
    cooldown_reject_count: num(eo.syncDecisionRejectedCooldown, 0),
    converging_reject_count: num(eo.syncDecisionRejectedConverging, 0),
    reconnect_settle_reject_count: num(eo.syncDecisionRejectedReconnectSettle, 0),
    netflix_safety_reject_count: num(eo.syncDecisionNetflixSafetyNoop, 0),
    profiler_event_counts: profilerEventCounts,
    data_completeness: sanitizeDataCompletenessForMetrics(ext.dataCompleteness),
    peer_recording_summary: summarizePeerRecordingForMetrics(unified.peerRecordingDiagnostics),
    prime_site_debug_summary: summarizePrimeSiteDebugForMetrics(unified.primeSiteDebug),
    user_marker_code_counts: userMarkerCodeCounts,
    diag_synopsis_codes: mergeDiagSynopsisCodes(ext.diagSynopsisCodes, userMarkerCodeCounts),
    profiler_export_compact:
      prof.exportOptions && typeof prof.exportOptions === 'object'
        ? prof.exportOptions.compact === true
          ? true
          : prof.exportOptions.compact === false
            ? false
            : null
        : null,
    diag_upload_depth:
      unified.uploadClient && String(unified.uploadClient.diagUploadDepth || '').toLowerCase() === 'deep'
        ? 'deep'
        : 'standard',
    correlation_trace_delivery: correlationTrace,
    profiler_rebuffer_remote_sync:
      profBufferOverlap.profilerEventsConsidered > 0
        ? {
            profiler_events_sampled: profBufferOverlap.profilerEventsConsidered,
            closed_buffer_windows: profBufferOverlap.closedBufferWindows,
            open_buffer_depth_at_end: profBufferOverlap.openBufferDepthAtExportEnd,
            remote_correction_applied_during_buffer: profBufferOverlap.remoteCorrectionAppliedDuringBuffer,
            remote_correction_received_during_buffer: profBufferOverlap.remoteCorrectionReceivedDuringBuffer,
            overlap_suspicious: profBufferOverlap.overlapSuspicious === true
          }
        : null,
    extension_ops_intel: extensionOpsIntel,
    signaling_counts: signalingCounts,
    timeupdate_significant_jump_count: tuJumpC,
    messaging_failures: messagingFails,
    video_rebuffer_sync_defer_count: rebufferDefer,
    profiler_rebuffer_overlap_flag: profBufferOverlap.overlapSuspicious ? 1 : 0,
    profiler_rebuffer_applied_in_buffer: profBufferOverlap.remoteCorrectionAppliedDuringBuffer
  };

  summary.sync_apply_reject_total =
    summary.cooldown_reject_count +
    summary.converging_reject_count +
    summary.reconnect_settle_reject_count +
    summary.netflix_safety_reject_count;

  const tags = [];
  const waiting = num(vb.waiting, 0);
  const stalled = num(vb.stalled, 0);
  if (waiting + stalled > 20 || num(prog.maxTimeupdateGapMs, 0) > 4500) {
    tags.push('likely_buffer_issue');
  }
  if (
    num(ext.clusterSync?.spreadSec, 0) > 5 ||
    countProfilerEvents(profEvents, 'ad_mode_visible_start') > 0 ||
    summary.ad_mode_enter_count > 2
  ) {
    tags.push('likely_ad_divergence');
  }
  if (wsDisc > 3) {
    tags.push('likely_ws_instability');
  }
  const tp = String(ext.connectionDetail?.transportPhase || '');
  if (/unreachable|reconnecting/i.test(tp) && wsDisc > 0) {
    tags.push('likely_ws_instability');
  }
  if ((ext.platform?.key === 'netflix' || summary.platform === 'netflix') && num(eo.syncDecisionNetflixSafetyNoop, 0) > 2) {
    tags.push('likely_netflix_safety_issue');
  }
  if (num(ext.findVideo?.invalidations, 0) > 15 || num(rollup.videoElementRebounds, 0) > 2) {
    tags.push('likely_video_rebind_issue');
  }
  if (waiting + stalled > 0 && !tags.includes('likely_buffer_issue')) {
    tags.push('buffering_signal_mild');
  }
  if (profBufferOverlap.overlapSuspicious) {
    tags.push('likely_rebuffer_sync_overlap');
  }

  const serverIntelFlags = [];
  if (profBufferOverlap.overlapSuspicious) {
    serverIntelFlags.push('remote_sync_during_video_rebuffer_profiler');
  }

  const derived_tags = mergeAnalyticsFlagsIntoDerivedTags(
    mergeMarkerDerivedTags([...new Set(tags)], userMarkerCodeCounts),
    [...(Array.isArray(analytics.flags) ? analytics.flags : []), ...serverIntelFlags]
  );

  return { summary, derived_tags };
}

module.exports = {
  normalizeDiagnosticReport,
  profilerEventTypeHistogram,
  computeProfilerRebufferOverlapFromEvents
};
