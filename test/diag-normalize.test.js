/**
 * Diagnostic normalization (tags, profiler histogram).
 * Run: node test/diag-normalize.test.js
 */

const assert = require('assert');
const { normalizeDiagnosticReport, profilerEventTypeHistogram } = require('../server/diag-normalize');

function run() {
  const hist = profilerEventTypeHistogram([
    { type: 'hard_correction_selected' },
    { type: 'hard_correction_selected' },
    { type: 'waiting_tick' }
  ]);
  assert.strictEqual(hist.hard_correction_selected, 2);
  assert.strictEqual(hist.waiting_tick, 1);

  const { summary, derived_tags } = normalizeDiagnosticReport({
    payload: {
      extension: {
        platform: { key: 'youtube' },
        room: { isHost: true, memberCount: 1 },
        videoBuffering: { waiting: 2, stalled: 0 },
        extensionOps: {},
        sync: { events: [] },
        analytics: {},
        timing: { lastRttMs: 100 }
      },
      videoPlayerProfiler: {
        events: [{ type: 'ad_mode_visible_start' }, { type: 'ad_mode_visible_start' }]
      },
      enrichment: { syncConfigSnapshot: { handlerKey: 'youtube' } },
      anonymization: {},
      ingestMeta: {},
      uploadClient: {}
    }
  });

  assert.ok(summary.profiler_event_counts && summary.profiler_event_counts.ad_mode_visible_start === 2);
  assert.ok(
    derived_tags.includes('buffering_signal_mild'),
    'light buffering should yield buffering_signal_mild when not likely_buffer_issue'
  );

  console.log('diag-normalize.test.js: all passed');
}

run();
