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
    netflix_safety_reject_count: num(eo.syncDecisionNetflixSafetyNoop, 0)
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

  return { summary, derived_tags: [...new Set(tags)] };
}

module.exports = { normalizeDiagnosticReport };
