/**
 * Diagnostic normalization (tags, profiler histogram).
 * Run: node test/diag-normalize.test.js
 */

const assert = require('assert');
const { normalizeDiagnosticReport, profilerEventTypeHistogram } = require('../platform/server/diag-normalize');

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

  const marked = normalizeDiagnosticReport({
    payload: {
      extension: {
        platform: { key: 'prime' },
        room: { memberCount: 2 },
        videoBuffering: {},
        extensionOps: {},
        sync: { events: [] },
        analytics: { flags: [] },
        diagSynopsisCodes: ['export_data_truncated'],
        timing: {}
      },
      videoPlayerProfiler: {
        events: [
          { type: 'user_marker', seq: 1, code: 'undetected_ad', note: 'undetected_ad' },
          { type: 'user_marker', seq: 2, code: 'undetected_ad', note: 'undetected_ad' },
          { type: 'user_marker', seq: 3, code: 'detected_ad', note: 'detected_ad' }
        ],
        session: { rollup: { userMarkerCodeCounts: { undetected_ad: 2, detected_ad: 1 } } }
      },
      uploadClient: {},
      anonymization: {},
      ingestMeta: {}
    }
  });
  assert.strictEqual(marked.summary.user_marker_code_counts.undetected_ad, 2);
  assert.ok(marked.derived_tags.includes('marker_undetected_ad'));
  assert.ok((marked.summary.diag_synopsis_codes || []).includes('undetected_ad'));
  assert.ok((marked.summary.diag_synopsis_codes || []).includes('export_data_truncated'));

  const overlap = normalizeDiagnosticReport({
    payload: {
      extension: {
        platform: { key: 'prime' },
        room: { memberCount: 2 },
        extensionOps: { syncStateDeferredRebuffer: 4 },
        sync: { events: [] },
        analytics: {
          correlationTraceDelivery: {
            matched: 3,
            traceEventsWithIdConsidered: 5,
            clockSkewSuspected: false,
            summary: { count: 3, avg: 40, p50: 35, p90: 62 }
          },
          flags: [],
          signalingThisDevice: {
            play: { sent: 1, recv: 2 },
            pause: { sent: 0, recv: 1 },
            seek: { sent: 2, recv: 2 }
          },
          timeupdateSignificantJumps: 7
        },
        messaging: { runtimeSendFailures: 1, sendThrowCount: 0 },
        timing: { lastRttMs: 30 }
      },
      videoPlayerProfiler: {
        events: [
          { type: 'buffer_recovery_start', monoMs: 0, t: 1e12 },
          { type: 'remote_correction_received', monoMs: 10, t: 1e12 },
          { type: 'remote_correction_applied', monoMs: 20, t: 1e12 },
          { type: 'remote_correction_applied', monoMs: 30, t: 1e12 },
          { type: 'remote_correction_applied', monoMs: 40, t: 1e12 },
          { type: 'buffer_recovery_end', monoMs: 50, t: 1e12 }
        ]
      },
      uploadClient: {},
      anonymization: {},
      ingestMeta: {}
    }
  });
  assert.ok(overlap.summary.correlation_trace_delivery);
  assert.strictEqual(overlap.summary.correlation_trace_delivery.matched, 3);
  assert.strictEqual(overlap.summary.video_rebuffer_sync_defer_count, 4);
  assert.strictEqual(overlap.summary.profiler_rebuffer_applied_in_buffer, 3);
  assert.strictEqual(overlap.summary.profiler_rebuffer_overlap_flag, 1);
  assert.ok(overlap.summary.extension_ops_intel && overlap.summary.extension_ops_intel.syncStateDeferredRebuffer === 4);
  assert.ok(overlap.summary.signaling_counts && overlap.summary.signaling_counts.play_recv === 2);
  assert.strictEqual(overlap.summary.timeupdate_significant_jump_count, 7);
  assert.ok(overlap.summary.messaging_failures && overlap.summary.messaging_failures.runtime_send_failures === 1);
  assert.ok(overlap.derived_tags.includes('likely_rebuffer_sync_overlap'));
  assert.ok(overlap.derived_tags.includes('remote_sync_during_video_rebuffer_profiler'));

  console.log('diag-normalize.test.js: all passed');
}

run();
