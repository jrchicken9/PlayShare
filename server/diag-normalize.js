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

function countEventsCorrectionReason(events, reason) {
  if (!Array.isArray(events)) return 0;
  return events.filter((e) => e && e.correctionReason === reason).length;
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
  const rollup = prof.session?.rollup || {};
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
    diag_synopsis_codes: sanitizeDiagSynopsisCodes(ext.diagSynopsisCodes),
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
        : 'standard'
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

  const derived_tags = mergeAnalyticsFlagsIntoDerivedTags([...new Set(tags)], analytics.flags);

  return { summary, derived_tags };
}

module.exports = { normalizeDiagnosticReport, profilerEventTypeHistogram };
