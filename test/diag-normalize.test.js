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

  const rich = normalizeDiagnosticReport({
    testRunId: 'run_xyz',
    payload: {
      uploadClient: { diagUploadDepth: 'deep', extensionVersion: '9.9.9' },
      extension: {
        platform: { key: 'prime' },
        room: { isHost: false, memberCount: 2 },
        videoBuffering: { waiting: 0, stalled: 0 },
        extensionOps: {},
        sync: { events: [] },
        analytics: { flags: ['high_drift_ewm_after_apply', 'invalid flag', 'tab_hidden_at_export'] },
        dataCompleteness: { anyTruncation: true, syncEventsStored: 100, rogue: 'dropme' },
        timing: { lastRttMs: 50 },
        diagSynopsisCodes: ['scenario_solo_session', 'high_drift_ewm_after_apply', 'bad tag!']
      },
      videoPlayerProfiler: {
        exportOptions: { compact: false, includeVideoFrame: false },
        events: [],
        session: {}
      },
      peerRecordingDiagnostics: {
        peers: [
          {
            sampleCount: 2,
            samples: [
              { videoAttached: true, platform: { key: 'prime' } },
              { videoAttached: false, platform: { key: 'youtube' } }
            ]
          }
        ],
        collectorRecording: true
      },
      primeSiteDebug: {
        kind: 'playshare_prime_player_sync_debug_v1',
        extension: { inRoom: true, isHost: false, localAdBreakActive: true },
        primeAdDetection: { score: 2, channels: { adTimerUi: true, mediaSession: true } },
        syncDebugNotes: [{ code: 'x' }],
        frameCapture: { attempted: true },
        videoCandidates: [{}],
        multiUserSync: {}
      },
      enrichment: {},
      anonymization: {},
      ingestMeta: {}
    }
  });

  assert.strictEqual(rich.summary.diag_upload_depth, 'deep');
  assert.strictEqual(rich.summary.profiler_export_compact, false);
  assert.ok(rich.summary.data_completeness && rich.summary.data_completeness.anyTruncation === true);
  assert.ok(!rich.summary.data_completeness.rogue);
  assert.ok(Array.isArray(rich.summary.diag_synopsis_codes) && rich.summary.diag_synopsis_codes.includes('high_drift_ewm_after_apply'));
  assert.ok(!rich.summary.diag_synopsis_codes.includes('bad tag!'));
  assert.ok(rich.derived_tags.includes('high_drift_ewm_after_apply'));
  assert.ok(rich.derived_tags.includes('tab_hidden_at_export'));
  assert.strictEqual(rich.summary.peer_recording_summary.peer_count, 1);
  assert.strictEqual(rich.summary.peer_recording_summary.distinct_peer_platform_keys, 2);
  assert.strictEqual(rich.summary.prime_site_debug_summary.ad_channel_signals_true, 2);
  assert.strictEqual(rich.summary.prime_site_debug_summary.local_ad_break_active, true);

  const failPrime = normalizeDiagnosticReport({
    payload: {
      extension: { analytics: {}, extensionOps: {}, sync: { events: [] }, platform: { key: 'prime' } },
      primeSiteDebug: { captureError: 'Frame timeout (drm)' },
      videoPlayerProfiler: { events: [] },
      uploadClient: {},
      anonymization: {},
      ingestMeta: {}
    }
  });
  assert.strictEqual(failPrime.summary.prime_site_debug_summary.capture_failed, true);
  assert.ok(typeof failPrime.summary.prime_site_debug_summary.capture_error_token === 'string');

  console.log('diag-normalize.test.js: all passed');
}

run();
