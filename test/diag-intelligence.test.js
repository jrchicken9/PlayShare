/**
 * Diagnostic intelligence (rules, summaries, regression helpers).
 * Run: node test/diag-intelligence.test.js
 */

const assert = require('assert');
const {
  computeClusterSignature,
  buildCaseSummaryText,
  buildCaseIntelRecord,
  explainCase,
  buildRecommendationsFromCases,
  regressionCompare
} = require('../server/diag-intelligence');

function baseSummary(over = {}) {
  return {
    platform: 'prime',
    handler_key: 'prime',
    role: 'viewer',
    hard_correction_count: 2,
    ad_mode_enter_count: 1,
    ws_disconnect_count: 1,
    buffering_count: 12,
    stalled_count: 2,
    sync_apply_reject_total: 1,
    source_swap_count: 1,
    laggard_anchor_count: 1,
    netflix_safety_reject_count: 0,
    sync_apply_success_rate: 0.92,
    drift_max_sec: 1.2,
    ...over
  };
}

async function run() {
  const tags = ['likely_ad_divergence', 'likely_buffer_issue'];
  const s = baseSummary();
  const sig = computeClusterSignature(s, tags);
  assert.ok(sig.includes('prime'), 'signature includes platform');
  assert.ok(sig.includes('likely_ad_divergence'), 'signature includes tag');

  const text = buildCaseSummaryText(s, tags);
  assert.ok(/prime/i.test(text), 'summary mentions platform');
  assert.ok(text.includes('tags:'), 'summary lists tags');

  const stamped = { enrichment: { syncConfigSnapshot: { handlerKey: 'prime', viewerReconcileIntervalMs: 5000 } } };
  const intel = buildCaseIntelRecord(stamped, s, tags, {
    reportId: '00000000-0000-4000-8000-000000000001',
    receivedAt: new Date().toISOString(),
    extensionVersion: '1.0.0',
    serverVersion: '1.0.0',
    schemaVersion: '2.5'
  });
  assert.strictEqual(intel.report_id, '00000000-0000-4000-8000-000000000001');
  assert.ok(intel.config_snapshot && intel.config_snapshot.handlerKey === 'prime');
  assert.ok(intel._cluster_summary_for_rollup);

  const expl = explainCase(
    {
      report_id: intel.report_id,
      derived_tags: tags,
      normalized_metrics: intel.normalized_metrics
    },
    [{ report_id: 'b', case_summary_text: 'other', cluster_signature: sig, uploaded_at: 'x' }]
  );
  assert.ok(expl.likely_issue);
  assert.ok(Array.isArray(expl.reasoning));
  assert.strictEqual(expl.similar_cases.length, 1);

  const rec = buildRecommendationsFromCases(
    Array.from({ length: 8 }, () => ({
      platform: 'prime',
      normalized_metrics: { reconnect_settle_reject_count: 2, cooldown_reject_count: 0 },
      derived_tags: ['likely_ad_divergence']
    }))
  );
  assert.ok(rec.recommendations.length >= 1);

  const reg = regressionCompare(
    [
      {
        platform: 'prime',
        normalized_metrics: { ad_mode_enter_count: 2, hard_correction_count: 1 },
        derived_tags: []
      }
    ],
    [
      {
        platform: 'prime',
        normalized_metrics: { ad_mode_enter_count: 4, hard_correction_count: 1 },
        derived_tags: []
      }
    ],
    { platform: 'prime' }
  );
  assert.ok(reg.baseline_n >= 1 && reg.target_n >= 1);

  console.log('diag-intelligence.test.js: all passed');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
