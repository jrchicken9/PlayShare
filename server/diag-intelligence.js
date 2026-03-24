/**
 * Rules-based diagnostic intelligence: case summaries, clustering signatures,
 * explainability, conservative recommendations, build/regression hints.
 * No raw payload — only normalized summary + tags + config snapshot.
 */

const INTEL_SCHEMA_VERSION = '1';

/** @param {number|null|undefined} n */
function nz(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return n;
}

/** @param {number|null|undefined} n */
function bucket3(n) {
  const x = nz(n);
  if (x <= 0) return '0';
  if (x <= 2) return 'l';
  if (x <= 8) return 'm';
  return 'h';
}

/** @param {number|null|undefined} n */
function bucketBuf(n) {
  const x = nz(n);
  if (x <= 5) return 'l';
  if (x <= 20) return 'm';
  return 'h';
}

/**
 * Deterministic grouping key for first-pass clustering (not ML).
 * @param {Record<string, unknown>} summary
 * @param {string[]} derived_tags
 */
function computeClusterSignature(summary, derived_tags) {
  const platform = String(summary.platform || 'unknown').slice(0, 32);
  const handler = String(summary.handler_key || summary.platform || 'unknown').slice(0, 32);
  const role = String(summary.role || 'solo').slice(0, 16);
  const tags = [...new Set(derived_tags || [])].sort().join('+') || 'none';
  const parts = [
    `v${INTEL_SCHEMA_VERSION}`,
    `p:${platform}`,
    `h:${handler}`,
    `r:${role}`,
    `t:${tags}`,
    `hc:${bucket3(summary.hard_correction_count)}`,
    `ad:${bucket3(summary.ad_mode_enter_count)}`,
    `ws:${bucket3(summary.ws_disconnect_count)}`,
    `buf:${bucketBuf(nz(summary.buffering_count) + nz(summary.stalled_count))}`,
    `rej:${bucket3(summary.sync_apply_reject_total)}`,
    `reb:${bucket3(summary.source_swap_count)}`,
    `lag:${bucket3(summary.laggard_anchor_count)}`
  ];
  const sig = parts.join('|');
  return sig.length > 450 ? sig.slice(0, 450) : sig;
}

/**
 * Short factual summary for search / review (no PII).
 * @param {Record<string, unknown>} summary
 * @param {string[]} derived_tags
 */
function buildCaseSummaryText(summary, derived_tags) {
  const platform = String(summary.platform || 'unknown');
  const handler = String(summary.handler_key || platform);
  const role = String(summary.role || 'solo');
  const tags = derived_tags && derived_tags.length ? derived_tags.join(', ') : 'no derived tags';
  const ad = nz(/** @type {number} */ (summary.ad_mode_enter_count));
  const hard = nz(/** @type {number} */ (summary.hard_correction_count));
  const soft = nz(/** @type {number} */ (summary.soft_drift_count));
  const buf = nz(/** @type {number} */ (summary.buffering_count)) + nz(/** @type {number} */ (summary.stalled_count));
  const ws = nz(/** @type {number} */ (summary.ws_disconnect_count));
  const swap = nz(/** @type {number} */ (summary.source_swap_count));
  const lag = nz(/** @type {number} */ (summary.laggard_anchor_count));
  const rej = nz(/** @type {number} */ (summary.sync_apply_reject_total));
  const nfSafe = nz(/** @type {number} */ (summary.netflix_safety_reject_count));
  const driftM = summary.drift_max_sec != null ? `${Number(summary.drift_max_sec).toFixed(2)}s max drift` : 'drift n/a';
  const apply =
    summary.sync_apply_success_rate != null
      ? `${Math.round(Number(summary.sync_apply_success_rate) * 100)}% apply success`
      : 'apply success n/a';

  const bits = [
    `${platform} (${handler}) ${role}`,
    `${apply}, ${driftM}`,
    ad > 0 ? `${ad} adMode-related signal(s)` : null,
    hard > 0 ? `${hard} hard correction(s)` : null,
    soft > 0 ? `${soft} soft drift / rate nudge(s)` : null,
    buf > 8 ? `buffering+stalled=${buf}` : buf > 0 ? `light buffering (${buf})` : null,
    ws > 2 ? `${ws} WS disconnects` : null,
    swap > 0 ? `${swap} source swap / rebind signal(s)` : null,
    lag > 0 ? `${lag} laggard anchor(s)` : null,
    rej > 0 ? `${rej} sync decision reject(s)` : null,
    nfSafe > 0 ? `${nfSafe} Netflix safety no-op(s)` : null,
    `tags: ${tags}`
  ].filter(Boolean);

  let text = bits.join('. ') + '.';
  if (text.length > 520) text = text.slice(0, 517) + '…';
  return text;
}

/** One-line rollup for cluster table */
function buildClusterSummaryText(summary, derived_tags) {
  const platform = String(summary.platform || '?');
  const t = (derived_tags || []).slice(0, 4).join(', ') || 'no tags';
  return `${platform} · ${t}`.slice(0, 240);
}

/**
 * Privacy-safe subset of enrichment for learning (thresholds, intervals — no URLs).
 * @param {object} stamped unified payload post-privacy
 */
function buildConfigSnapshot(stamped) {
  const enr = stamped && stamped.enrichment && typeof stamped.enrichment === 'object' ? stamped.enrichment : null;
  const snap = enr && enr.syncConfigSnapshot && typeof enr.syncConfigSnapshot === 'object' ? enr.syncConfigSnapshot : null;
  if (!snap) return null;
  /** @type {Record<string, unknown>} */
  const out = {};
  const keys = [
    'handlerKey',
    'drmPassive',
    'aggressiveRemoteSync',
    'viewerReconcileIntervalMs',
    'drmDesyncThresholdSec',
    'syncStateApplyDelayMs',
    'positionReportIntervalMs'
  ];
  for (const k of keys) {
    if (k in snap) out[k] = snap[k];
  }
  if (snap.driftThresholds && typeof snap.driftThresholds === 'object') {
    out.driftThresholds = { .../** @type {object} */ (snap.driftThresholds) };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Metrics persisted on the case row (jsonb).
 * @param {Record<string, unknown>} summary
 */
function pickNormalizedMetricsForStorage(summary) {
  const keys = [
    'member_count',
    'recording_duration_ms',
    'avg_transport_rtt_ms',
    'max_peer_apply_latency_ms',
    'ws_disconnect_count',
    'sync_apply_success_rate',
    'drift_avg_sec',
    'drift_max_sec',
    'hard_correction_count',
    'soft_drift_count',
    'ad_mode_enter_count',
    'laggard_anchor_count',
    'buffering_count',
    'stalled_count',
    'source_swap_count',
    'cooldown_reject_count',
    'converging_reject_count',
    'reconnect_settle_reject_count',
    'netflix_safety_reject_count',
    'sync_apply_reject_total',
    'progression_max_timeupdate_gap_ms',
    'video_element_rebounds',
    'handler_key',
    'platform',
    'role'
  ];
  /** @type {Record<string, unknown>} */
  const o = {};
  for (const k of keys) {
    if (summary[k] !== undefined) o[k] = summary[k];
  }
  return o;
}

/**
 * @param {object} stamped
 * @param {Record<string, unknown>} summary
 * @param {string[]} derived_tags
 * @param {object} meta
 */
function buildCaseIntelRecord(stamped, summary, derived_tags, meta) {
  const cluster_signature = computeClusterSignature(summary, derived_tags);
  const case_summary_text = buildCaseSummaryText(summary, derived_tags);
  const cluster_summary = buildClusterSummaryText(summary, derived_tags);
  return {
    report_id: meta.reportId,
    uploaded_at: meta.receivedAt,
    extension_version: meta.extensionVersion || null,
    server_version: meta.serverVersion || null,
    schema_version: meta.schemaVersion || null,
    platform: String(summary.platform || '').slice(0, 48) || null,
    handler_key: String(summary.handler_key || summary.platform || '').slice(0, 48) || null,
    role: summary.role || null,
    test_run_id: summary.test_run_id || null,
    device_id_hash: summary.device_id_hash || null,
    room_id_hash: summary.room_id_hash || null,
    case_summary_text,
    cluster_signature,
    derived_tags,
    normalized_metrics: pickNormalizedMetricsForStorage(summary),
    config_snapshot: buildConfigSnapshot(stamped),
    intel_schema_version: INTEL_SCHEMA_VERSION,
    _cluster_summary_for_rollup: cluster_summary
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {ReturnType<typeof buildCaseIntelRecord>} intel
 */
async function upsertClusterRollup(supabase, intel) {
  const sig = intel.cluster_signature;
  const { data: existing, error: selErr } = await supabase
    .from('diag_case_clusters')
    .select('case_count, representative_report_ids')
    .eq('cluster_signature', sig)
    .maybeSingle();
  if (selErr) throw selErr;

  const rid = intel.report_id;
  const reps = existing && Array.isArray(existing.representative_report_ids) ? existing.representative_report_ids : [];
  const nextReps = [rid, ...reps.filter((x) => x !== rid)].slice(0, 5);
  const count = (existing && typeof existing.case_count === 'number' ? existing.case_count : 0) + 1;

  const row = {
    cluster_signature: sig,
    platform: intel.platform,
    handler_key: intel.handler_key,
    pattern_tags: intel.derived_tags,
    case_count: count,
    cluster_summary: intel._cluster_summary_for_rollup,
    representative_report_ids: nextReps,
    first_case_at: existing ? undefined : intel.uploaded_at,
    last_case_at: intel.uploaded_at
  };
  if (existing) {
    const { error } = await supabase
      .from('diag_case_clusters')
      .update({
        case_count: count,
        cluster_summary: row.cluster_summary,
        representative_report_ids: nextReps,
        last_case_at: intel.uploaded_at,
        pattern_tags: intel.derived_tags,
        platform: intel.platform,
        handler_key: intel.handler_key
      })
      .eq('cluster_signature', sig);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('diag_case_clusters').insert({
      ...row,
      first_case_at: intel.uploaded_at
    });
    if (error) throw error;
  }
}

/**
 * @param {Record<string, unknown>} caseRow — diag_cases row
 * @param {Record<string, unknown>[]} similar — nearby cases (same cluster or tag overlap)
 */
function explainCase(caseRow, similar) {
  const m = caseRow.normalized_metrics && typeof caseRow.normalized_metrics === 'object' ? caseRow.normalized_metrics : {};
  const tags = Array.isArray(caseRow.derived_tags) ? caseRow.derived_tags : [];
  /** @type {string[]} */
  const reasons = [];
  /** @type {string[]} */
  const likely = [];

  if (tags.includes('likely_ad_divergence')) {
    likely.push('Ad-mode or spread-related divergence vs peers');
    reasons.push('derived_tag:likely_ad_divergence');
  }
  if (tags.includes('likely_video_rebind_issue')) {
    likely.push('Frequent video element churn or src changes');
    reasons.push('derived_tag:likely_video_rebind_issue');
  }
  if (tags.includes('likely_buffer_issue')) {
    likely.push('Buffering / long timeupdate gaps');
    reasons.push('derived_tag:likely_buffer_issue');
  }
  if (tags.includes('likely_ws_instability')) {
    likely.push('WebSocket transport instability');
    reasons.push('derived_tag:likely_ws_instability');
  }
  if (tags.includes('likely_netflix_safety_issue')) {
    likely.push('Netflix safety no-op path firing often (may be protective)');
    reasons.push('derived_tag:likely_netflix_safety_issue');
  }

  if (nz(/** @type {number} */ (m.hard_correction_count)) > 2) {
    likely.push('Above-average hard corrections');
    reasons.push(`hard_correction_count:${m.hard_correction_count}`);
  }
  if (nz(/** @type {number} */ (m.sync_apply_reject_total)) > 3) {
    likely.push('Many sync decision rejections (cooldown / converging / reconnect / safety)');
    reasons.push(`sync_apply_reject_total:${m.sync_apply_reject_total}`);
  }

  if (likely.length === 0) {
    likely.push('No strong single-factor signal — review tags and metrics');
    reasons.push('fallback:no_primary_tag');
  }

  /** @type {Record<string, string>} */
  const inspectHints = {};
  if (tags.includes('likely_netflix_safety_issue')) {
    inspectHints.sync = 'content/src/sites/netflix-sync.js, sync-decision-engine (netflix_safety_noop)';
  }
  if (tags.includes('likely_ad_divergence') || nz(/** @type {number} */ (m.ad_mode_enter_count)) > 0) {
    inspectHints.ads = 'ad-detection.js, site-specific ad monitors, profiler ad_mode_visible_*';
  }
  if (tags.includes('likely_video_rebind_issue')) {
    inspectHints.video = 'findVideo / video attach path, video-player-profiler src_swap_detected';
  }
  if (tags.includes('likely_ws_instability')) {
    inspectHints.transport = 'service worker bridge, connectionDetail, reconnect policy';
  }
  inspectHints.thresholds = 'enrichment.syncConfigSnapshot.driftThresholds in export / diag_cases.config_snapshot';

  return {
    report_id: caseRow.report_id,
    likely_issue: likely[0],
    secondary_factors: likely.slice(1),
    reasoning: reasons,
    similar_cases: similar.map((s) => ({
      report_id: s.report_id,
      uploaded_at: s.uploaded_at,
      case_summary_text: s.case_summary_text,
      cluster_signature: s.cluster_signature
    })),
    suggested_inspection: inspectHints
  };
}

/**
 * @param {Record<string, unknown>[]} cases — recent diag_cases rows
 */
function buildRecommendationsFromCases(cases) {
  if (!cases.length) return { recommendations: [], evidence: 'no_cases' };
  /** @type {Record<string, Record<string, unknown>[]>} */
  const byPlatform = {};
  for (const c of cases) {
    const p = String(c.platform || 'unknown');
    if (!byPlatform[p]) byPlatform[p] = [];
    byPlatform[p].push(c);
  }

  /** @type {Array<{ text: string, confidence: string, evidence: string[], platforms?: string[] }>} */
  const out = [];

  for (const [plat, rows] of Object.entries(byPlatform)) {
    const n = rows.length;
    if (n < 5) continue;
    let sumRecon = 0;
    let sumCooldown = 0;
    let sumNetflix = 0;
    let sumHard = 0;
    let sumLag = 0;
    let adTagged = 0;
    for (const r of rows) {
      const m = r.normalized_metrics && typeof r.normalized_metrics === 'object' ? r.normalized_metrics : {};
      sumRecon += nz(/** @type {number} */ (m.reconnect_settle_reject_count));
      sumCooldown += nz(/** @type {number} */ (m.cooldown_reject_count));
      sumNetflix += nz(/** @type {number} */ (m.netflix_safety_reject_count));
      sumHard += nz(/** @type {number} */ (m.hard_correction_count));
      sumLag += nz(/** @type {number} */ (m.laggard_anchor_count));
      const tags = Array.isArray(r.derived_tags) ? r.derived_tags : [];
      if (tags.includes('likely_ad_divergence')) adTagged++;
    }
    const avgRecon = sumRecon / n;
    const avgCooldown = sumCooldown / n;
    const avgNetflix = sumNetflix / n;
    const avgHard = sumHard / n;
    const avgLag = sumLag / n;

    if (avgRecon >= 1.2) {
      out.push({
        text: `On ${plat}, reconnect-settle rejections average ${avgRecon.toFixed(1)} per case — consider lengthening settle window or reviewing reconnect gating.`,
        confidence: 'medium',
        evidence: [`platform=${plat}`, `n=${n}`, `avg_reconnect_settle_reject=${avgRecon.toFixed(2)}`],
        platforms: [plat]
      });
    }
    if (avgCooldown >= 2) {
      out.push({
        text: `On ${plat}, cooldown-related sync rejects are frequent — sync-decision cooldown tiers may be tight for real-world latency.`,
        confidence: 'medium',
        evidence: [`platform=${plat}`, `n=${n}`, `avg_cooldown_reject=${avgCooldown.toFixed(2)}`],
        platforms: [plat]
      });
    }
    if (plat === 'netflix' && avgNetflix >= 2) {
      out.push({
        text: `Netflix safety no-ops are common in this sample — before loosening safety, confirm false positives with human labels (likely protective behavior).`,
        confidence: 'low',
        evidence: [`platform=netflix`, `n=${n}`, `avg_netflix_safety=${avgNetflix.toFixed(2)}`],
        platforms: ['netflix']
      });
    }
    if (avgLag >= 1.5 && avgHard >= 1) {
      out.push({
        text: `On ${plat}, laggard anchors co-occur with hard corrections — review laggard_anchor thresholds during low-confidence windows.`,
        confidence: 'medium',
        evidence: [`platform=${plat}`, `avg_laggard=${avgLag.toFixed(2)}`, `avg_hard=${avgHard.toFixed(2)}`],
        platforms: [plat]
      });
    }
    if (adTagged / n >= 0.35) {
      out.push({
        text: `On ${plat}, ~${Math.round((adTagged / n) * 100)}% of recent cases carry likely_ad_divergence — prioritize ad/sync interaction tests on this platform.`,
        confidence: 'medium',
        evidence: [`platform=${plat}`, `ad_tag_rate=${(adTagged / n).toFixed(2)}`, `n=${n}`],
        platforms: [plat]
      });
    }
  }

  return {
    recommendations: out.slice(0, 12),
    case_sample_size: cases.length,
    evidence: 'aggregated_normalized_metrics'
  };
}

function mean(arr) {
  if (!arr.length) return null;
  const s = arr.reduce((a, b) => a + b, 0);
  return s / arr.length;
}

/**
 * @param {Record<string, unknown>[]} baselineRows
 * @param {Record<string, unknown>[]} targetRows
 * @param {{ platform?: string }} [filter]
 */
function regressionCompare(baselineRows, targetRows, filter = {}) {
  const plat = filter.platform;
  const b = plat ? baselineRows.filter((r) => r.platform === plat) : baselineRows;
  const t = plat ? targetRows.filter((r) => r.platform === plat) : targetRows;
  const fields = [
    'ad_mode_enter_count',
    'hard_correction_count',
    'buffering_count',
    'stalled_count',
    'ws_disconnect_count',
    'netflix_safety_reject_count',
    'source_swap_count',
    'sync_apply_reject_total'
  ];

  /** @param {Record<string, unknown>[]} rows */
  function collect(rows) {
    /** @type {Record<string, number[]>} */
    const acc = {};
    for (const f of fields) acc[f] = [];
    for (const r of rows) {
      const m = r.normalized_metrics && typeof r.normalized_metrics === 'object' ? r.normalized_metrics : {};
      for (const f of fields) {
        const v = m[f];
        if (typeof v === 'number' && Number.isFinite(v)) acc[f].push(v);
      }
    }
    return acc;
  }

  const B = collect(b);
  const T = collect(t);
  /** @type {Array<{ field: string, baseline_mean: number|null, target_mean: number|null, delta_pct: number|null, notable: boolean, note: string }>} */
  const deltas = [];
  const THRESH = 0.25;

  for (const f of fields) {
    const mb = mean(B[f]);
    const mt = mean(T[f]);
    let deltaPct = null;
    if (mb != null && mb > 0.001 && mt != null) deltaPct = (mt - mb) / mb;
    else if (mb != null && mb === 0 && mt != null && mt > 0) deltaPct = 1;
    let notable = false;
    let note = '';
    if (deltaPct != null && Math.abs(deltaPct) >= THRESH) {
      notable = true;
      note =
        deltaPct > 0
          ? `${f} higher in target vs baseline (~${Math.round(deltaPct * 100)}%)`
          : `${f} lower in target vs baseline (~${Math.round(-deltaPct * 100)}%)`;
    }
    deltas.push({
      field: f,
      baseline_mean: mb,
      target_mean: mt,
      delta_pct: deltaPct,
      notable,
      note
    });
  }

  const tagRate = (rows, tag) => {
    if (!rows.length) return null;
    let c = 0;
    for (const r of rows) {
      const tags = Array.isArray(r.derived_tags) ? r.derived_tags : [];
      if (tags.includes(tag)) c++;
    }
    return c / rows.length;
  };

  const tagNames = ['likely_ad_divergence', 'likely_buffer_issue', 'likely_ws_instability', 'likely_video_rebind_issue'];
  /** @type {Array<{ tag: string, baseline_rate: number|null, target_rate: number|null, delta: number|null, notable: boolean }>} */
  const tagCompare = [];
  for (const tag of tagNames) {
    const rb = tagRate(b, tag);
    const rt = tagRate(t, tag);
    const delta = rb != null && rt != null ? rt - rb : null;
    const notable = delta != null && Math.abs(delta) >= 0.15;
    tagCompare.push({ tag, baseline_rate: rb, target_rate: rt, delta, notable });
  }

  return {
    filter: plat || 'all',
    baseline_n: b.length,
    target_n: t.length,
    metric_deltas: deltas,
    tag_compare: tagCompare,
    summary: deltas
      .filter((d) => d.notable)
      .map((d) => d.note)
      .concat(tagCompare.filter((x) => x.notable).map((x) => `Tag ${x.tag}: Δrate ${(x.delta != null ? x.delta * 100 : 0).toFixed(0)}pp`))
  };
}

module.exports = {
  INTEL_SCHEMA_VERSION,
  computeClusterSignature,
  buildCaseSummaryText,
  buildClusterSummaryText,
  buildConfigSnapshot,
  pickNormalizedMetricsForStorage,
  buildCaseIntelRecord,
  upsertClusterRollup,
  explainCase,
  buildRecommendationsFromCases,
  regressionCompare
};
