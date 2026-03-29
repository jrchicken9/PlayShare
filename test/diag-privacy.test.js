/**
 * Server-side diagnostic ingest privacy + normalization tests.
 * Run: node test/diag-privacy.test.js
 */

const assert = require('assert');
const {
  assertHashSaltPolicy,
  enforceUnifiedDiagnosticPrivacy,
  ALLOWED_DIAGNOSTIC_SCHEMAS
} = require('../platform/server/diag-privacy-enforce');
const { normalizeDiagnosticReport } = require('../platform/server/diag-normalize');
const { ingestDiagnosticBundle, ENVELOPE_SCHEMA } = require('../platform/server/diag-upload');

function envSnapshot() {
  return {
    PLAYSHARE_DIAG_HASH_SALT: process.env.PLAYSHARE_DIAG_HASH_SALT,
    PLAYSHARE_DIAG_ALLOW_INSECURE_HASH: process.env.PLAYSHARE_DIAG_ALLOW_INSECURE_HASH,
    RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT,
    RAILWAY_PROJECT_ID: process.env.RAILWAY_PROJECT_ID,
    NODE_ENV: process.env.NODE_ENV
  };
}

function restoreEnv(snap) {
  for (const k of Object.keys(snap)) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function baseUnified() {
  return {
    playshareUnifiedExport: '1.0',
    anonymization: {
      roomIdHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      deviceIdHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      usernameHash: 'cccccccccccccccccccccccccccccccccccccccc'
    },
    extension: {
      reportSchemaVersion: '2.5',
      extensionVersion: '9.9.9',
      platform: { key: 'prime', name: 'Prime' },
      room: { isHost: false, memberCount: 2, roomIdHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      timing: { lastRttMs: 42, lastRttSource: 'heartbeat' },
      analytics: {
        latencyMsPeerReported: { all: { max: 200, min: 10, count: 5 } },
        session: { sessionDurationSinceJoinMs: 60000 }
      },
      connectionDetail: { transportPhase: 'unreachable' },
      extensionOps: { wsDisconnectEvents: 2 },
      serviceWorkerTransport: { wsCloseCount: 2 },
      sync: { events: [] },
      videoBuffering: { waiting: 0, stalled: 0 }
    }
  };
}

function envelopeFromPayload(payload, extra = {}) {
  return {
    schema: ENVELOPE_SCHEMA,
    payload,
    diagnosticReportSchema: '2.5',
    ...extra
  };
}

async function run() {
  const snap = envSnapshot();
  try {
    delete process.env.RAILWAY_ENVIRONMENT;
    delete process.env.RAILWAY_PROJECT_ID;
    process.env.NODE_ENV = 'test';
    process.env.PLAYSHARE_DIAG_HASH_SALT = 'unit_test_diag_salt_16chars';
    delete process.env.PLAYSHARE_DIAG_ALLOW_INSECURE_HASH;

    assert.strictEqual(assertHashSaltPolicy().ok, true, 'salt policy ok with 16+ char salt');

    assert.ok(ALLOWED_DIAGNOSTIC_SCHEMAS.has('2.5'), 'schema 2.5 allowed');

    const clean = baseUnified();
    const p1 = enforceUnifiedDiagnosticPrivacy(JSON.parse(JSON.stringify(clean)), {
      serverSalt: 'unit_test_diag_salt_16chars',
      schemaVersion: '2.5'
    });
    assert.strictEqual(p1.ok, true, 'clean payload passes privacy');
    assert.ok(p1.scrubbed.anonymization.serverAnchored, 're-anchored');
    assert.ok(!p1.scrubbed.narrativeSummary, 'no narrative');

    const withNarrative = { ...baseUnified(), narrativeSummary: 'secret story' };
    const p2 = enforceUnifiedDiagnosticPrivacy(JSON.parse(JSON.stringify(withNarrative)), {
      serverSalt: 'unit_test_diag_salt_16chars',
      schemaVersion: '2.5'
    });
    assert.strictEqual(p2.ok, false, 'narrative rejected');
    assert.ok(p2.reasons.includes('unsafe_narrative_summary_present'));

    const withRoom = baseUnified();
    withRoom.extension = { ...withRoom.extension, room: { ...withRoom.extension.room, roomCode: 'ABCDEF' } };
    const p3 = enforceUnifiedDiagnosticPrivacy(JSON.parse(JSON.stringify(withRoom)), {
      serverSalt: 'unit_test_diag_salt_16chars',
      schemaVersion: '2.5'
    });
    assert.strictEqual(p3.ok, false, 'room code rejected');
    assert.ok(p3.reasons.includes('unsafe_room_code_present'));

    const withBlob = baseUnified();
    withBlob.extension.note = 'data:image/png;base64,ZZZ';
    const p4 = enforceUnifiedDiagnosticPrivacy(JSON.parse(JSON.stringify(withBlob)), {
      serverSalt: 'unit_test_diag_salt_16chars',
      schemaVersion: '2.5'
    });
    assert.strictEqual(p4.ok, false, 'frame/blob rejected');
    assert.ok(p4.reasons.includes('unsafe_frame_data_present'));

    const badSchema = baseUnified();
    const p5 = enforceUnifiedDiagnosticPrivacy(JSON.parse(JSON.stringify(badSchema)), {
      serverSalt: 'unit_test_diag_salt_16chars',
      schemaVersion: '0.1'
    });
    assert.strictEqual(p5.ok, false, 'bad schema rejected');
    assert.ok(p5.reasons.includes('unsupported_schema_version'));

    const scrubUser = baseUnified();
    scrubUser.extension = {
      ...scrubUser.extension,
      sync: { events: [{ type: 'x', fromUsername: 'alice', text: 'hello world' }] }
    };
    const p6 = enforceUnifiedDiagnosticPrivacy(JSON.parse(JSON.stringify(scrubUser)), {
      serverSalt: 'unit_test_diag_salt_16chars',
      schemaVersion: '2.5'
    });
    assert.strictEqual(p6.ok, true, 'username/chat scrubbed');
    const ev = p6.scrubbed.extension.sync.events[0];
    assert.strictEqual(ev.fromUsername, undefined);
    assert.strictEqual(ev.text, undefined);

    const norm = normalizeDiagnosticReport({ payload: p6.scrubbed });
    assert.strictEqual(norm.summary.extension_version, '9.9.9', 'summary carries extension_version from export');
    assert.strictEqual(norm.summary.max_rtt_ms, null, 'max_rtt_ms not used for apply latency');
    assert.strictEqual(norm.summary.max_peer_apply_latency_ms, 200);
    assert.strictEqual(norm.summary.avg_transport_rtt_ms, 42);
    assert.strictEqual(norm.summary.avg_rtt_ms, 42);
    const wsTags = norm.derived_tags.filter((t) => t === 'likely_ws_instability');
    assert.strictEqual(wsTags.length, 1, 'derived_tags deduped');

    delete process.env.PLAYSHARE_DIAG_HASH_SALT;
    process.env.PLAYSHARE_DIAG_ALLOW_INSECURE_HASH = '1';
    assert.strictEqual(assertHashSaltPolicy().ok, true, 'insecure dev salt allowed with flag');

    process.env.PLAYSHARE_DIAG_ALLOW_INSECURE_HASH = '1';
    const inserts = { raw: null, summary: null, case: null };
    const mockSb = {
      from(table) {
        if (table === 'diag_case_clusters') {
          return {
            select() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => ({ data: null, error: null })
                  };
                }
              };
            },
            insert: async () => ({ error: null }),
            update() {
              return { eq: async () => ({ error: null }) };
            }
          };
        }
        return {
          insert(row) {
            if (table === 'diag_reports_raw') inserts.raw = row;
            if (table === 'diag_reports_summary') inserts.summary = row;
            if (table === 'diag_cases') inserts.case = row;
            return Promise.resolve({ error: null });
          }
        };
      }
    };

    const bundle = await ingestDiagnosticBundle(envelopeFromPayload(baseUnified()), {
      getSupabase: () => mockSb
    });
    assert.strictEqual(bundle.ok, true, 'ingest accepts clean bundle');
    assert.ok(inserts.raw && inserts.raw.payload_json, 'raw row written');
    assert.strictEqual(inserts.raw.payload_json.ingestMeta.reportId, bundle.json.reportId);
    assert.strictEqual(inserts.summary.max_peer_apply_latency_ms, 200);
    assert.strictEqual(inserts.summary.max_rtt_ms, null);
    assert.strictEqual(inserts.summary.extension_version, '9.9.9');
    assert.ok(Array.isArray(inserts.summary.derived_tags));

    const badIngest = await ingestDiagnosticBundle(
      envelopeFromPayload({ ...baseUnified(), narrativeSummary: 'x' }),
      { getSupabase: () => mockSb }
    );
    assert.strictEqual(badIngest.ok, false);
    assert.strictEqual(badIngest.json.error, 'privacy_rejected');
    assert.ok(badIngest.json.reasons.includes('unsafe_narrative_summary_present'));

    process.env.RAILWAY_ENVIRONMENT = 'production';
    delete process.env.PLAYSHARE_DIAG_HASH_SALT;
    delete process.env.PLAYSHARE_DIAG_ALLOW_INSECURE_HASH;
    const prodSalt = assertHashSaltPolicy();
    assert.strictEqual(prodSalt.ok, false, 'production requires salt');
    assert.ok(prodSalt.code.includes('hash_salt'));

    console.log('diag-privacy.test.js: all passed');
  } finally {
    restoreEnv(snap);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
