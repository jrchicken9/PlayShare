/**
 * POST /diag/upload — ingest anonymized diagnostic bundles (Railway).
 * Optional Supabase persistence when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set.
 */

const { randomUUID } = require('crypto');
const { normalizeDiagnosticReport } = require('./diag-normalize');
const {
  assertHashSaltPolicy,
  enforceUnifiedDiagnosticPrivacy,
  safePrivacyLog
} = require('./diag-privacy-enforce');
const { buildCaseIntelRecord, upsertClusterRollup } = require('./diag-intelligence');
const { authenticateUploadRequest } = require('./diag-auth');
const { createAiBriefJob } = require('./diag-ai-jobs');
const { getServerDiagAiConfig } = require('./diag-ai-brief');

const ENVELOPE_SCHEMA = 'playshare.diagUploadEnvelope.v1';
const UNIFIED_VERSION = '1.0';

function getSupabaseAdmin() {
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) return null;
  try {
    const { createClient } = require('@supabase/supabase-js');
    return createClient(url, key, { auth: { persistSession: false } });
  } catch (e) {
    console.warn('[PlayShare/diag] Supabase client init failed:', e && e.message);
    return null;
  }
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      total += chunk.length;
      if (total > maxBytes) {
        failed = true;
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function serverPackageVersion() {
  try {
    return require('../package.json').version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

function autoQueueAiOnUploadEnabled() {
  const v = String(process.env.PLAYSHARE_DIAG_AI_AUTO_QUEUE_ON_UPLOAD || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

async function maybeQueueAutomaticAiBrief(supabase, options) {
  if (!supabase || !autoQueueAiOnUploadEnabled()) return null;
  const aiCfg = getServerDiagAiConfig();
  if (!aiCfg.configured) return null;
  const focusPlatform = options.focus_platform ? String(options.focus_platform).slice(0, 64) : null;
  const engineerNote =
    'Auto-generated after diagnostic upload' +
    (options.report_id ? ' ' + String(options.report_id).slice(0, 36) : '') +
    '. Summarize the most actionable extension work from the latest telemetry and note whether this run reinforces or changes prior findings.';
  const row = await createAiBriefJob(supabase, {
    trigger_source: 'upload_auto',
    focus_platform: focusPlatform,
    engineer_notes: engineerNote,
    include_prior_learnings: true,
    persist_learning: true,
    auto_triggered: true,
    source_report_id: options.report_id || null,
    request_options_json: {
      focus_platform: focusPlatform,
      engineer_notes: engineerNote,
      include_prior_learnings: true,
      persist_learning: true,
      case_limit: 30,
      cluster_limit: 12,
      metrics_sample: 120,
      prior_learning_limit: 10
    }
  });
  return row ? row.id : null;
}

/**
 * Core ingest (HTTP-agnostic). Used by POST handler and tests.
 * @param {object} body — parsed envelope JSON
 * @param {{ getSupabase?: () => ReturnType<typeof getSupabaseAdmin> }} [deps]
 * @returns {Promise<{ ok: boolean, status: number, json: object }>}
 */
async function ingestDiagnosticBundle(body, deps = {}) {
  const getSb = deps.getSupabase || getSupabaseAdmin;

  if (!body || typeof body !== 'object') {
    return { ok: false, status: 400, json: { ok: false, error: 'invalid_body', reasons: ['invalid_body'] } };
  }

  if (body.schema !== ENVELOPE_SCHEMA) {
    return {
      ok: false,
      status: 400,
      json: {
        ok: false,
        error: 'bad_envelope_schema',
        reasons: ['bad_envelope_schema'],
        expected: ENVELOPE_SCHEMA
      }
    };
  }

  const payload = body.payload;
  if (!payload || typeof payload !== 'object' || payload.playshareUnifiedExport !== UNIFIED_VERSION) {
    return {
      ok: false,
      status: 400,
      json: {
        ok: false,
        error: 'bad_unified_export',
        reasons: ['bad_unified_export'],
        expectedUnified: UNIFIED_VERSION
      }
    };
  }

  const saltPolicy = assertHashSaltPolicy();
  if (!saltPolicy.ok) {
    return {
      ok: false,
      status: 503,
      json: { ok: false, error: saltPolicy.code, reasons: [saltPolicy.code] }
    };
  }

  const receivedAt = new Date().toISOString();
  const reportId = randomUUID();
  const extensionVersion = String(
    body.extensionVersion ||
      payload.uploadClient?.extensionVersion ||
      payload.extension?.extensionVersion ||
      ''
  ).slice(0, 32);
  const platform = String(
    body.platformHandlerKey || payload.extension?.platform?.key || payload.enrichment?.syncConfigSnapshot?.handlerKey || ''
  ).slice(0, 48);
  const schemaVersion = String(
    body.diagnosticReportSchema || payload.extension?.reportSchemaVersion || ''
  ).slice(0, 16);
  const reportKind = String(body.reportKind || 'unified_anonymized').slice(0, 64);

  const payloadForPrivacy = JSON.parse(JSON.stringify(payload));
  const privacy = enforceUnifiedDiagnosticPrivacy(payloadForPrivacy, {
    serverSalt: saltPolicy.salt,
    schemaVersion
  });

  if (!privacy.ok) {
    safePrivacyLog(reportId, privacy.reasons, {
      schemaVersion,
      reasonCount: privacy.reasons.length
    });
    return {
      ok: false,
      status: 400,
      json: {
        ok: false,
        error: 'privacy_rejected',
        reasons: privacy.reasons,
        reportId
      }
    };
  }

  const uc =
    privacy.scrubbed.uploadClient && typeof privacy.scrubbed.uploadClient === 'object'
      ? {
          extensionVersion: String(privacy.scrubbed.uploadClient.extensionVersion || '').slice(0, 32),
          diagnosticReportSchema: String(privacy.scrubbed.uploadClient.diagnosticReportSchema || '').slice(0, 16)
        }
      : null;

  const stamped = {
    ...privacy.scrubbed,
    ingestMeta: {
      reportId,
      receivedAt,
      serverVersion: serverPackageVersion(),
      envelopeSchema: ENVELOPE_SCHEMA,
      extensionVersionDeclared: extensionVersion,
      platformHandlerKey: platform,
      diagnosticReportSchema: schemaVersion,
      reportKind,
      uploadClient: uc
    }
  };

  const { summary, derived_tags } = normalizeDiagnosticReport({ payload: stamped, testRunId: body.testRunId || null });

  summary.report_id = reportId;
  summary.test_run_id = body.testRunId || summary.test_run_id || null;
  summary.device_id_hash = stamped.anonymization?.deviceIdHash || summary.device_id_hash;
  summary.room_id_hash = stamped.anonymization?.roomIdHash || summary.room_id_hash;

  const supabase = getSb();
  /** @type {string|null} */
  let autoAiJobId = null;
  if (supabase) {
    const { error: rawErr } = await supabase.from('diag_reports_raw').insert({
      id: reportId,
      uploaded_at: receivedAt,
      extension_version: extensionVersion || null,
      platform: platform || null,
      schema_version: schemaVersion || null,
      report_kind: reportKind,
      payload_json: stamped
    });
    if (rawErr) {
      console.error('[PlayShare/diag] raw insert failed', rawErr);
      return {
        ok: false,
        status: 500,
        json: { ok: false, error: 'storage_failed', reasons: ['storage_failed'], detail: rawErr.message }
      };
    }

    const { error: sumErr } = await supabase.from('diag_reports_summary').insert({
      report_id: reportId,
      test_run_id: summary.test_run_id,
      device_id_hash: summary.device_id_hash,
      room_id_hash: summary.room_id_hash,
      extension_version: summary.extension_version || null,
      role: summary.role,
      platform: summary.platform,
      member_count: summary.member_count,
      recording_duration_ms: summary.recording_duration_ms,
      avg_transport_rtt_ms: summary.avg_transport_rtt_ms,
      max_peer_apply_latency_ms: summary.max_peer_apply_latency_ms,
      avg_rtt_ms: summary.avg_rtt_ms,
      max_rtt_ms: summary.max_rtt_ms,
      ws_disconnect_count: summary.ws_disconnect_count,
      sync_apply_success_rate: summary.sync_apply_success_rate,
      drift_avg_sec: summary.drift_avg_sec,
      drift_max_sec: summary.drift_max_sec,
      hard_correction_count: summary.hard_correction_count,
      soft_drift_count: summary.soft_drift_count,
      ad_mode_enter_count: summary.ad_mode_enter_count,
      laggard_anchor_count: summary.laggard_anchor_count,
      buffering_count: summary.buffering_count,
      stalled_count: summary.stalled_count,
      source_swap_count: summary.source_swap_count,
      cooldown_reject_count: summary.cooldown_reject_count,
      converging_reject_count: summary.converging_reject_count,
      reconnect_settle_reject_count: summary.reconnect_settle_reject_count,
      netflix_safety_reject_count: summary.netflix_safety_reject_count,
      derived_tags: derived_tags
    });
    if (sumErr) {
      console.error('[PlayShare/diag] summary insert failed', sumErr);
      return {
        ok: false,
        status: 500,
        json: { ok: false, error: 'summary_failed', reasons: ['summary_failed'], detail: sumErr.message }
      };
    }

    try {
      const intel = buildCaseIntelRecord(stamped, summary, derived_tags, {
        reportId,
        receivedAt,
        extensionVersion,
        serverVersion: stamped.ingestMeta?.serverVersion || null,
        schemaVersion
      });
      const { _cluster_summary_for_rollup, ...caseRow } = intel;
      void _cluster_summary_for_rollup;
      const { error: caseErr } = await supabase.from('diag_cases').insert(caseRow);
      if (caseErr) {
        console.warn('[PlayShare/diag/intel] diag_cases insert failed', caseErr.message || caseErr);
      } else {
        await upsertClusterRollup(supabase, intel).catch((e) =>
          console.warn('[PlayShare/diag/intel] cluster rollup failed', e && e.message)
        );
        autoAiJobId = await maybeQueueAutomaticAiBrief(supabase, {
          report_id: reportId,
          focus_platform: intel.platform || summary.platform || null
        }).catch((e) => {
          console.warn('[PlayShare/diag/intel] auto IntelPro job enqueue failed', e && e.message);
          return null;
        });
      }
    } catch (e) {
      console.warn('[PlayShare/diag/intel] case build failed', e && e.message);
    }
  } else {
    console.warn('[PlayShare/diag] Supabase not configured — accepted report', reportId, '(not persisted)');
  }

  return {
    ok: true,
    status: 200,
    json: {
      ok: true,
      reportId,
      receivedAt,
      persisted: !!supabase,
      derivedTags: derived_tags,
      autoAiJobId
    }
  };
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
async function handleDiagUpload(req, res) {
  const maxBytes = parseInt(process.env.PLAYSHARE_DIAG_UPLOAD_MAX_BYTES || '4194304', 10);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'method_not_allowed', reasons: ['method_not_allowed'] }));
    return;
  }

  let body;
  try {
    body = await readJsonBody(req, maxBytes);
  } catch (e) {
    const code = e && e.message === 'PAYLOAD_TOO_LARGE' ? 'payload_too_large' : 'invalid_json';
    res.writeHead(code === 'payload_too_large' ? 413 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: code, reasons: [code] }));
    return;
  }

  const auth = authenticateUploadRequest(req, body);
  if (auth.configured && !auth.ok) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: false,
        error: 'unauthorized',
        reasons: ['unauthorized'],
        hint:
          'Provide a valid scoped upload token, reuse a valid diagnostic session, or exchange your legacy upload secret for a fresh token.'
      })
    );
    return;
  }

  const result = await ingestDiagnosticBundle(body);
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (result.ok) {
    headers['Access-Control-Allow-Origin'] = '*';
  }
  res.writeHead(result.status, headers);
  res.end(JSON.stringify(result.json));
}

module.exports = { handleDiagUpload, ingestDiagnosticBundle, ENVELOPE_SCHEMA, getSupabaseAdmin };
