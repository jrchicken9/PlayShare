/**
 * Internal HTTP API + lightweight HTML explorer for diagnostic intelligence.
 * Auth: Bearer and/or X-PlayShare-Diag-Intel-Secret must match PLAYSHARE_DIAG_INTEL_SECRET and/or PLAYSHARE_DIAG_UPLOAD_SECRET (either value accepted if both are set).
 */

const { URL } = require('url');
const { getSupabaseAdmin } = require('./diag-upload');
const { explainCase, buildRecommendationsFromCases, regressionCompare } = require('./diag-intelligence');
const { getDiagAiConfig, gatherBriefContext, buildFallbackMarkdown, generateAssistantBrief } = require('./diag-ai-brief');
const { EXTENSION_PRIMER_MARKDOWN } = require('./playshare-extension-primer');
const { saveBriefAsLearning, listKnowledge, getKnowledgeOne } = require('./diag-intel-knowledge');

const FEEDBACK_LABELS = new Set([
  'confirmed_root_cause',
  'false_positive',
  'expected_behavior',
  'network_issue',
  'player_issue',
  'extension_bug',
  'threshold_tuning_needed',
  'platform_specific_quirk',
  'other'
]);

const DIAG_INTEL_MAX_OFFSET = 100000;

/**
 * @param {URLSearchParams} searchParams
 * @param {number} defaultLimit
 * @param {number} maxLimit
 */
function diagIntelPageParams(searchParams, defaultLimit, maxLimit) {
  const limit = Math.min(maxLimit, Math.max(1, parseInt(searchParams.get('limit') || String(defaultLimit), 10) || defaultLimit));
  const rawOff = parseInt(searchParams.get('offset') || '0', 10);
  const offset = Number.isFinite(rawOff) ? Math.min(DIAG_INTEL_MAX_OFFSET, Math.max(0, rawOff)) : 0;
  return { limit, offset };
}

/**
 * Fetch limit+1 rows to detect has_more; return first `limit` rows.
 * @param {{ length: number }} rows
 * @param {number} limit
 */
function diagIntelSlicePage(rows, limit) {
  const arr = rows || [];
  const hasMore = arr.length > limit;
  const data = hasMore ? arr.slice(0, limit) : arr;
  return { data, hasMore, returned: data.length };
}

/** Trim, strip UTF-8 BOM, NBSP, and CR (common when copying from Railway / Windows / .env). */
function scrubDiagSecret(s) {
  let t = String(s || '').trim();
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1).trim();
  t = t.replace(/\u00a0/g, '').replace(/\r/g, '').trim();
  return t;
}

/**
 * Unique non-empty secrets that authorize /diag/intel/*.
 * If both env vars are set to the same string, only one entry is used. If they differ, either value is accepted.
 */
function getDiagIntelAcceptedSecrets() {
  const intel = scrubDiagSecret(process.env.PLAYSHARE_DIAG_INTEL_SECRET);
  const upload = scrubDiagSecret(process.env.PLAYSHARE_DIAG_UPLOAD_SECRET);
  const out = [];
  if (intel) out.push(intel);
  if (upload && upload !== intel) out.push(upload);
  return out;
}

/** @deprecated Use getDiagIntelAcceptedSecrets; kept for module export compatibility (first configured secret). */
function getIntelSecret() {
  const a = getDiagIntelAcceptedSecrets();
  return a[0] || '';
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function unauthorized(res) {
  json(res, 401, {
    ok: false,
    error: 'unauthorized',
    hint:
      'The secret did not match PLAYSHARE_DIAG_INTEL_SECRET or PLAYSHARE_DIAG_UPLOAD_SECRET on this server. Paste the variable value only (no "Bearer" prefix). If you use a proxy that strips Authorization on GET, the explorer sends X-PlayShare-Diag-Intel-Secret as well.'
  });
}

function parseBearerToken(authHeader) {
  let t = String(authHeader || '').trim();
  if (t.toLowerCase().startsWith('bearer ')) t = t.slice(7).trim();
  if (t.toLowerCase().startsWith('bearer ')) t = t.slice(7).trim();
  return scrubDiagSecret(t);
}

/** Single header value (Node may join duplicates with ", "). */
function headerOne(req, lowerName) {
  const v = req.headers[lowerName];
  if (v == null || v === '') return '';
  const s = Array.isArray(v) ? v.join(',') : String(v);
  return s.trim();
}

/**
 * Bearer first; then custom header (some proxies strip Authorization on GET).
 * @param {import('http').IncomingMessage} req
 */
function extractDiagIntelToken(req) {
  let t = parseBearerToken(req.headers.authorization);
  if (t) return t;
  const alt = headerOne(req, 'x-playshare-diag-intel-secret');
  if (!alt) return '';
  return scrubDiagSecret(alt);
}

function checkAuth(req) {
  const accepted = getDiagIntelAcceptedSecrets();
  if (accepted.length === 0) return null;
  const token = extractDiagIntelToken(req);
  if (!token) return false;
  return accepted.some((secret) => token === secret);
}

async function readJsonBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('too_large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} hostBase e.g. http://0.0.0.0:8765
 */
async function handleDiagIntel(req, res, hostBase = 'http://127.0.0.1') {
  const url = new URL(req.url || '/', hostBase);
  const path = url.pathname.replace(/\/$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers':
        'Content-Type, Authorization, X-PlayShare-Diag-AI-Key, X-PlayShare-Diag-Intel-Secret'
    });
    res.end();
    return;
  }

  if (path === '/diag/intel/public-meta' && req.method === 'GET') {
    const cfg = getDiagAiConfig();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(
      JSON.stringify({
        ok: true,
        server_llm_configured: Boolean(cfg && cfg.configured)
      })
    );
    return;
  }

  if (path === '/diag/intel/explorer' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(explorerHtml());
    return;
  }

  const authed = checkAuth(req);
  if (authed === null) {
    json(res, 503, {
      ok: false,
      error: 'intel_secret_not_configured',
      hint:
        'Set PLAYSHARE_DIAG_INTEL_SECRET and/or PLAYSHARE_DIAG_UPLOAD_SECRET. If both are set, the explorer accepts either value in Authorization: Bearer.'
    });
    return;
  }
  if (!authed) {
    unauthorized(res);
    return;
  }

  if (path === '/diag/intel/auth-check' && (req.method === 'POST' || req.method === 'GET')) {
    if (req.method === 'POST') {
      await new Promise((resolve) => {
        req.resume();
        req.on('end', () => resolve(undefined));
        req.on('error', () => resolve(undefined));
      });
    }
    json(res, 200, {
      ok: true,
      authenticated: true,
      supabase_configured: Boolean(getSupabaseAdmin())
    });
    return;
  }

  if (path === '/diag/intel' || path === '/diag/intel/health') {
    if (req.method !== 'GET') {
      json(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    json(res, 200, {
      ok: true,
      service: 'playshare_diag_intel',
      note: 'Use /diag/intel/cases, /diag/intel/explorer',
      supabase_configured: Boolean(getSupabaseAdmin())
    });
    return;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    json(res, 503, { ok: false, error: 'supabase_not_configured' });
    return;
  }

  try {
    if (path === '/diag/intel/search') {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      const rawQ = url.searchParams.get('q') || '';
      const q = rawQ.replace(/%/g, '').replace(/_/g, '').trim().slice(0, 80);
      if (q.length < 2) {
        json(res, 400, { ok: false, error: 'query_too_short', min: 2 });
        return;
      }
      const { limit, offset } = diagIntelPageParams(url.searchParams, 20, 40);
      const rangeEnd = offset + limit;
      const pattern = `%${q}%`;
      const { data, error } = await supabase
        .from('diag_cases')
        .select(
          'report_id,uploaded_at,extension_version,platform,handler_key,case_summary_text,cluster_signature,derived_tags'
        )
        .ilike('case_summary_text', pattern)
        .order('uploaded_at', { ascending: false })
        .range(offset, rangeEnd);
      if (error) throw error;
      const page = diagIntelSlicePage(data || [], limit);
      json(res, 200, {
        ok: true,
        query: q,
        cases: page.data,
        pagination: { limit, offset, returned: page.returned, has_more: page.hasMore }
      });
      return;
    }

    if (path === '/diag/intel/cases') {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      const { limit, offset } = diagIntelPageParams(url.searchParams, 40, 100);
      const rangeEnd = offset + limit;
      const platform = url.searchParams.get('platform');
      const tag = url.searchParams.get('tag');
      const cluster = url.searchParams.get('cluster');
      const extensionVersion = url.searchParams.get('extension_version');
      let q = supabase
        .from('diag_cases')
        .select(
          'report_id,uploaded_at,extension_version,server_version,platform,handler_key,role,case_summary_text,cluster_signature,derived_tags'
        )
        .order('uploaded_at', { ascending: false })
        .range(offset, rangeEnd);
      if (platform) q = q.eq('platform', platform);
      if (cluster) q = q.eq('cluster_signature', cluster);
      if (tag) q = q.contains('derived_tags', [tag]);
      if (extensionVersion) q = q.eq('extension_version', String(extensionVersion).slice(0, 32));
      const { data, error } = await q;
      if (error) throw error;
      const page = diagIntelSlicePage(data || [], limit);
      json(res, 200, {
        ok: true,
        cases: page.data,
        pagination: { limit, offset, returned: page.returned, has_more: page.hasMore }
      });
      return;
    }

    const caseExplainMatch = path.match(/^\/diag\/intel\/cases\/([0-9a-f-]{36})\/explain$/i);
    if (caseExplainMatch) {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      const id = caseExplainMatch[1];
      const { data: row, error: e1 } = await supabase.from('diag_cases').select('*').eq('report_id', id).maybeSingle();
      if (e1) throw e1;
      if (!row) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      const { data: sim, error: e2 } = await supabase
        .from('diag_cases')
        .select('report_id,uploaded_at,case_summary_text,cluster_signature')
        .eq('cluster_signature', row.cluster_signature)
        .neq('report_id', id)
        .order('uploaded_at', { ascending: false })
        .limit(5);
      if (e2) throw e2;
      json(res, 200, { ok: true, explanation: explainCase(row, sim || []) });
      return;
    }

    const caseOneMatch = path.match(/^\/diag\/intel\/cases\/([0-9a-f-]{36})$/i);
    if (caseOneMatch) {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      const id = caseOneMatch[1];
      const { data: row, error } = await supabase.from('diag_cases').select('*').eq('report_id', id).maybeSingle();
      if (error) throw error;
      if (!row) {
        json(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      json(res, 200, { ok: true, case: row });
      return;
    }

    if (path === '/diag/intel/clusters') {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      const { limit, offset } = diagIntelPageParams(url.searchParams, 40, 80);
      const rangeEnd = offset + limit;
      const { data, error } = await supabase
        .from('diag_case_clusters')
        .select('*')
        .order('last_case_at', { ascending: false, nullsFirst: false })
        .range(offset, rangeEnd);
      if (error) throw error;
      const page = diagIntelSlicePage(data || [], limit);
      json(res, 200, {
        ok: true,
        clusters: page.data,
        pagination: { limit, offset, returned: page.returned, has_more: page.hasMore }
      });
      return;
    }

    if (path === '/diag/intel/recommendations') {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      const sample = Math.min(400, Math.max(30, parseInt(url.searchParams.get('sample') || '120', 10)));
      const { data, error } = await supabase
        .from('diag_cases')
        .select('platform,normalized_metrics,derived_tags')
        .order('uploaded_at', { ascending: false })
        .limit(sample);
      if (error) throw error;
      json(res, 200, { ok: true, ...buildRecommendationsFromCases(data || []) });
      return;
    }

    if (path === '/diag/intel/knowledge') {
      if (req.method === 'GET') {
        const oneId = url.searchParams.get('id');
        if (oneId && /^[0-9a-f-]{36}$/i.test(oneId)) {
          const row = await getKnowledgeOne(supabase, oneId);
          if (!row) {
            json(res, 404, { ok: false, error: 'not_found' });
            return;
          }
          json(res, 200, { ok: true, entry: row });
          return;
        }
        const lim = Math.min(80, Math.max(1, parseInt(url.searchParams.get('limit') || '25', 10)));
        const off = Math.min(100000, Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10)));
        const rows = await listKnowledge(supabase, lim, off);
        json(res, 200, { ok: true, entries: rows });
        return;
      }
      if (req.method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req, 131072);
        } catch {
          json(res, 400, { ok: false, error: 'invalid_json' });
          return;
        }
        const digest = String(body.digest_markdown || '').trim();
        if (digest.length < 20) {
          json(res, 400, { ok: false, error: 'digest_too_short', min: 20 });
          return;
        }
        const fp = body.focus_platform != null ? String(body.focus_platform).trim().slice(0, 64) : null;
        try {
          const id = await saveBriefAsLearning(supabase, {
            source: 'manual',
            digest_markdown: digest,
            focus_platform: fp || null,
            extension_versions: [],
            case_window: null,
            data_snapshot_at: null
          });
          json(res, 200, { ok: true, learning_id: id });
        } catch (e) {
          console.error('[PlayShare/diag/intel/knowledge]', e);
          json(res, 500, { ok: false, error: 'persist_failed', detail: e && e.message ? e.message : String(e) });
        }
        return;
      }
      json(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }

    if (path === '/diag/intel/ai-brief') {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req, 65536);
      } catch {
        json(res, 400, { ok: false, error: 'invalid_json' });
        return;
      }
      const dryRun = Boolean(body.dry_run);
      const focusRaw = body.focus_platform != null ? String(body.focus_platform).trim().slice(0, 64) : '';
      const focusPlatform = focusRaw || null;
      const engineerNotes = body.engineer_notes != null ? String(body.engineer_notes).slice(0, 8000) : '';
      const caseLimit = body.case_limit != null ? parseInt(body.case_limit, 10) : undefined;
      const clusterLimit = body.cluster_limit != null ? parseInt(body.cluster_limit, 10) : undefined;
      const metricsSample = body.metrics_sample != null ? parseInt(body.metrics_sample, 10) : undefined;
      const includePriorLearnings = body.include_prior_learnings !== false;
      const persistLearning = body.persist_learning !== false;
      const priorLearningLimit =
        body.prior_learning_limit != null ? parseInt(body.prior_learning_limit, 10) : undefined;
      const bodyLlmKey =
        body.llm_api_key != null ? String(body.llm_api_key).trim().slice(0, 512) : '';

      const context = await gatherBriefContext(supabase, {
        focusPlatform,
        caseLimit: Number.isFinite(caseLimit) ? caseLimit : undefined,
        clusterLimit: Number.isFinite(clusterLimit) ? clusterLimit : undefined,
        metricsSample: Number.isFinite(metricsSample) ? metricsSample : undefined,
        includePriorLearnings,
        priorLearningLimit: Number.isFinite(priorLearningLimit) ? priorLearningLimit : undefined
      });
      const fallbackMarkdown = buildFallbackMarkdown(context);

      if (dryRun) {
        json(res, 200, {
          ok: true,
          dry_run: true,
          context: {
            ...context,
            architecture_primer_markdown: EXTENSION_PRIMER_MARKDOWN
          },
          fallback_markdown: fallbackMarkdown,
          ai_configured: getDiagAiConfig(req, { bodyApiKey: bodyLlmKey }).configured,
          prior_runs_in_prompt: (context.prior_runs_from_database || []).length
        });
        return;
      }

      const aiCfg = getDiagAiConfig(req, { bodyApiKey: bodyLlmKey });
      if (!aiCfg.configured) {
        json(res, 503, {
          ok: false,
          error: 'ai_not_configured',
          hint:
            'Set PLAYSHARE_DIAG_AI_API_KEY (or OPENAI_API_KEY) on the server, or reload /diag/intel/explorer and paste an OpenAI key at unlock. The explorer sends a browser key in header X-PlayShare-Diag-AI-Key and JSON llm_api_key when provided; otherwise the server uses its env key.',
          fallback_markdown: fallbackMarkdown
        });
        return;
      }

      try {
        const assistantMarkdown = await generateAssistantBrief(aiCfg, context, engineerNotes);
        /** @type {string|null} */
        let learningId = null;
        /** @type {string|null} */
        let learningPersistError = null;
        if (persistLearning) {
          try {
            learningId = await saveBriefAsLearning(supabase, {
              source: 'ai_brief',
              model: aiCfg.model,
              focus_platform: focusPlatform,
              extension_versions: Object.keys(context.extension_version_counts || {}),
              case_window: Array.isArray(context.recent_cases) ? context.recent_cases.length : null,
              digest_markdown: assistantMarkdown,
              data_snapshot_at: context.generated_at
            });
          } catch (pe) {
            learningPersistError = pe && pe.message ? pe.message : String(pe);
            console.error('[PlayShare/diag/intel] ai-brief persist learning', pe);
          }
        }
        json(res, 200, {
          ok: true,
          assistant_markdown: assistantMarkdown,
          fallback_markdown: fallbackMarkdown,
          model: aiCfg.model,
          used_ai: true,
          learning_id: learningId,
          learning_persisted: Boolean(learningId),
          learning_persist_error: learningPersistError,
          prior_runs_in_prompt: (context.prior_runs_from_database || []).length
        });
      } catch (e) {
        const detail = e && e.message ? e.message : String(e);
        const status = e && e.status >= 400 && e.status < 600 ? e.status : 502;
        json(res, status, {
          ok: false,
          error: 'ai_request_failed',
          detail,
          fallback_markdown: fallbackMarkdown
        });
      }
      return;
    }

    if (path === '/diag/intel/regression') {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      const baselineVer = url.searchParams.get('baseline_ver') || url.searchParams.get('baseline');
      const targetVer = url.searchParams.get('target_ver') || url.searchParams.get('target');
      const platform = url.searchParams.get('platform') || undefined;
      if (!baselineVer || !targetVer) {
        json(res, 400, { ok: false, error: 'missing_baseline_or_target_version' });
        return;
      }
      const cap = 80;
      const { data: b, error: eb } = await supabase
        .from('diag_cases')
        .select('*')
        .eq('extension_version', baselineVer)
        .order('uploaded_at', { ascending: false })
        .limit(cap);
      if (eb) throw eb;
      const { data: t, error: et } = await supabase
        .from('diag_cases')
        .select('*')
        .eq('extension_version', targetVer)
        .order('uploaded_at', { ascending: false })
        .limit(cap);
      if (et) throw et;
      json(res, 200, {
        ok: true,
        baseline_ver: baselineVer,
        target_ver: targetVer,
        comparison: regressionCompare(b || [], t || [], { platform })
      });
      return;
    }

    if (path === '/diag/intel/feedback') {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        json(res, 400, { ok: false, error: 'invalid_json' });
        return;
      }
      const label = String(body.label || '').trim();
      if (!FEEDBACK_LABELS.has(label)) {
        json(res, 400, { ok: false, error: 'invalid_label', allowed: [...FEEDBACK_LABELS] });
        return;
      }
      const report_id = body.report_id || null;
      const cluster_signature = body.cluster_signature ? String(body.cluster_signature).slice(0, 500) : null;
      if (!report_id && !cluster_signature) {
        json(res, 400, { ok: false, error: 'need_report_id_or_cluster_signature' });
        return;
      }
      const engineer_note =
        body.engineer_note != null ? String(body.engineer_note).replace(/[\u0000-\u001F]/g, ' ').slice(0, 2000) : null;
      const { data, error } = await supabase
        .from('diag_case_feedback')
        .insert({ report_id, cluster_signature, label, engineer_note })
        .select('id')
        .single();
      if (error) throw error;
      json(res, 200, { ok: true, feedback_id: data.id });
      return;
    }

    json(res, 404, { ok: false, error: 'not_found' });
  } catch (e) {
    console.error('[PlayShare/diag/intel]', e);
    json(res, 500, { ok: false, error: 'internal', detail: e && e.message ? e.message : String(e) });
  }
}

function explorerHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PlayShare · Diagnostic intelligence</title>
  <style>
    :root {
      --bg: #07090d;
      --surface: #111620;
      --surface2: #0c1018;
      --border: #2a3142;
      --text: #e8edf4;
      --muted: #8b95a8;
      --accent: #38bdf8;
      --accent-dim: rgba(56, 189, 248, 0.12);
      --ok: #34d399;
      --warn: #fbbf24;
      --err: #f87171;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0 18px 40px; }
    .wrap { max-width: 1280px; margin: 0 auto; padding-top: 22px; }
    .topbar {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 18px 20px;
      background: linear-gradient(155deg, var(--surface) 0%, #0a0e16 100%);
      border-left: 4px solid var(--accent);
      margin-bottom: 20px;
    }
    .topbar h1 { margin: 0 0 6px; font-size: 1.4rem; font-weight: 700; letter-spacing: -0.02em; }
    .topbar p { margin: 0; color: var(--muted); font-size: 0.92rem; max-width: 72ch; }
    .ver { font-size: 11px; color: var(--muted); margin-top: 10px; opacity: 0.85; }
    .shell {
      display: grid;
      grid-template-columns: minmax(240px, 280px) 1fr;
      gap: 22px;
      align-items: start;
    }
    @media (max-width: 920px) {
      .shell {
        grid-template-columns: 1fr;
      }
      /* Put the Bearer field (inside main-col) above the sidebar hints on phones */
      .main-col {
        order: 1;
      }
      .side {
        order: 2;
      }
    }
    .side {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 16px 14px;
      position: sticky;
      top: 12px;
    }
    @media (max-width: 920px) {
      .side { position: static; }
    }
    .side h2 {
      margin: 0 0 10px;
      font-size: 0.68rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--muted);
    }
    label.lbl { display: block; font-size: 0.75rem; color: var(--muted); margin-bottom: 4px; }
    input[type="text"], input[type="password"], input[type="search"] {
      width: 100%;
      background: var(--surface2);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 9px 11px;
      font-size: 14px;
    }
    input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-dim); }
    .chk { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); margin-top: 8px; }
    .chk input { width: auto; }
    .steps { margin: 14px 0 0; padding-left: 18px; color: var(--muted); font-size: 12px; }
    .steps li { margin-bottom: 6px; }
    .main-col {
      min-width: 0;
    }
    .access-panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 16px 16px;
      margin-bottom: 16px;
      border-left: 4px solid var(--accent);
    }
    .access-panel .lbl {
      margin-top: 0;
    }
    .access-panel-hint {
      font-size: 12px;
      color: var(--muted);
      margin: 8px 0 0;
      line-height: 1.45;
    }
    .access-panel--post-unlock {
      padding: 12px 14px;
    }
    .access-panel--post-unlock .access-unlock-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px 14px;
      font-size: 13px;
      color: var(--muted);
    }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 0;
      padding-bottom: 0;
    }
    .tabs button {
      background: transparent;
      color: var(--muted);
      border: none;
      border-bottom: 2px solid transparent;
      padding: 10px 14px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      margin-bottom: -1px;
      border-radius: 8px 8px 0 0;
    }
    .tabs button:hover { color: var(--text); background: rgba(255,255,255,0.03); }
    .tabs button.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
      background: var(--accent-dim);
    }
    .tab-panel {
      display: none;
      background: var(--surface);
      border: 1px solid var(--border);
      border-top: none;
      border-radius: 0 0 12px 12px;
      padding: 16px 18px 18px;
      margin-bottom: 18px;
    }
    .tab-panel.active { display: block; }
    .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; margin-bottom: 10px; }
    .row:last-child { margin-bottom: 0; }
    .grow { flex: 1 1 140px; min-width: 0; }
    button.primary {
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 10px 18px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    button.primary:hover { filter: brightness(1.08); }
    button.secondary {
      background: #334155;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 9px 16px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    button.secondary:hover { filter: brightness(1.08); }
    button:disabled { opacity: 0.45; cursor: not-allowed; filter: none; }
    button.linkish {
      background: transparent;
      border: none;
      color: var(--accent);
      padding: 2px 0;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    details.hint { margin-top: 12px; font-size: 12px; color: var(--muted); }
    details.hint summary { cursor: pointer; color: var(--accent); user-select: none; }
    .results {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 18px;
    }
    .results h2 {
      margin: 0 0 12px;
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }
    .result-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px 14px;
      margin-bottom: 14px;
    }
    .pill {
      font-size: 12px;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 999px;
      font-variant-numeric: tabular-nums;
    }
    .pill.ok { background: rgba(52, 211, 153, 0.15); color: var(--ok); }
    .pill.warn { background: rgba(251, 191, 36, 0.12); color: var(--warn); }
    .pill.err { background: rgba(248, 113, 113, 0.12); color: var(--err); }
    .pill.idle { background: #1e2430; color: var(--muted); }
    .path { font-size: 12px; color: var(--muted); font-family: ui-monospace, monospace; word-break: break-all; }
    .human { min-height: 48px; margin-bottom: 12px; }
    .empty {
      padding: 20px 16px;
      text-align: center;
      color: var(--muted);
      font-size: 14px;
      border: 1px dashed var(--border);
      border-radius: 10px;
      background: var(--surface2);
    }
    .alert {
      padding: 12px 14px;
      border-radius: 10px;
      font-size: 14px;
      margin-bottom: 12px;
    }
    .alert.err { background: rgba(248, 113, 113, 0.1); border: 1px solid rgba(248, 113, 113, 0.35); color: #fecaca; }
    .alert.warn { background: rgba(251, 191, 36, 0.08); border: 1px solid rgba(251, 191, 36, 0.3); color: #fde68a; }
    table.data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    table.data-table th, table.data-table td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    table.data-table th {
      color: var(--muted);
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    table.data-table tr:hover td { background: rgba(255,255,255,0.02); }
    .sum { max-width: 36ch; color: #cbd5e1; }
    .mono-sm { font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all; }
    .rec-card {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 14px;
      margin-bottom: 10px;
      background: var(--surface2);
    }
    .rec-card p { margin: 0 0 8px; }
    .rec-meta { font-size: 11px; color: var(--muted); }
    .dl-row { display: grid; grid-template-columns: 1fr 2fr; gap: 8px 16px; font-size: 13px; margin: 6px 0; }
    .dl-row dt { color: var(--muted); margin: 0; }
    .dl-row dd { margin: 0; }
    details.raw-json { margin-top: 4px; }
    details.raw-json > summary {
      cursor: pointer;
      color: var(--muted);
      font-size: 12px;
      user-select: none;
      padding: 8px 0;
    }
    details.raw-json > summary:hover { color: var(--accent); }
    pre#out {
      margin: 0;
      background: #05070a;
      padding: 14px 16px;
      border-radius: 10px;
      overflow: auto;
      font-size: 11px;
      line-height: 1.45;
      max-height: min(42vh, 480px);
      border: 1px solid var(--border);
      white-space: pre-wrap;
      word-break: break-word;
    }
    button.ghost {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--muted);
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    button.ghost:hover { color: var(--text); border-color: var(--muted); }
    footer { margin-top: 24px; font-size: 11px; color: var(--muted); text-align: center; }
    .muted { color: var(--muted); font-size: 12px; }
    .pager {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }
    .pager .pager-meta { font-size: 13px; color: var(--muted); flex: 1; min-width: 140px; }
    .pager button.secondary:disabled { opacity: 0.35; cursor: not-allowed; }
    textarea.brief-notes {
      width: 100%;
      min-height: 88px;
      background: var(--surface2);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 14px;
      resize: vertical;
    }
    textarea.brief-ta {
      width: 100%;
      min-height: 220px;
      background: #05070a;
      color: #e2e8f0;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 14px;
      font-size: 13px;
      line-height: 1.45;
      font-family: ui-monospace, monospace;
      resize: vertical;
    }
    .gate-screen {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
    }
    .gate-screen[hidden] {
      display: none !important;
    }
    #playshareExplorerApp[hidden] {
      display: none !important;
    }
    .gate-card {
      width: 100%;
      max-width: 500px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 28px 26px;
      border-left: 4px solid var(--accent);
    }
    .gate-card h1 {
      margin: 0 0 8px;
      font-size: 1.35rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .gate-lead {
      color: var(--muted);
      font-size: 14px;
      margin: 0 0 20px;
      line-height: 1.55;
    }
    .gate-card .lbl:first-of-type {
      margin-top: 0;
    }
    .gate-card .lbl {
      margin-top: 14px;
    }
    #gateErr {
      margin-top: 0;
      margin-bottom: 14px;
    }
    #gateErr[role='alert'] {
      outline: none;
    }
    input.gate-input-err {
      border-color: #f87171 !important;
      box-shadow: 0 0 0 1px rgba(248, 113, 113, 0.35);
    }
    #gateSubmit {
      margin-top: 18px;
      width: 100%;
      padding: 12px 14px;
      font-size: 15px;
      font-weight: 600;
      border: none;
      border-radius: 10px;
      background: var(--accent);
      color: #04202c;
      cursor: pointer;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    #gateSubmit:hover {
      filter: brightness(1.06);
    }
    #gateSubmit:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .gate-diag {
      margin-top: 16px;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
      background: var(--surface2);
      font-size: 12px;
      line-height: 1.45;
    }
    .gate-diag summary {
      cursor: pointer;
      color: var(--muted);
      user-select: none;
      font-weight: 600;
    }
    .gate-diag-pre {
      margin: 10px 0 0;
      padding: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, monospace;
      font-size: 11px;
      line-height: 1.55;
      color: #cbd5e1;
      border: 0;
      background: transparent;
    }
  </style>
</head>
<body>
  <div id="gateRoot" class="gate-screen">
    <div class="gate-card">
      <h1>Unlock diagnostic intelligence</h1>
      <p class="gate-lead">
        <strong>Railway does not put this secret into the page for you.</strong> Open Railway → your service → <strong>Variables</strong>, copy the
        <em>value</em> of <code>PLAYSHARE_DIAG_INTEL_SECRET</code> (or upload secret), and paste it in the first box. The server compares that header to the
        variable; they must match exactly. <strong>Continue</strong> uses <code>POST /diag/intel/auth-check</code> plus <code>X-PlayShare-Diag-Intel-Secret</code> so unlock works without Supabase and survives proxies that strip <code>Authorization</code> on GET. Only the <strong>first field</strong> is required to open the explorer. The OpenAI field is optional: leave it blank to use the server’s <code>PLAYSHARE_DIAG_AI_API_KEY</code> / <code>OPENAI_API_KEY</code> for the AI tab, or paste your own key to send from the browser.
      </p>
      <label class="lbl" for="gateBearer">1 · Paste Railway secret here (PLAYSHARE_DIAG_INTEL_SECRET value)</label>
      <input type="password" id="gateBearer" autocomplete="off" spellcheck="false" placeholder="Paste the full secret from Railway Variables" aria-describedby="gateErr" />
      <label class="lbl" for="gateOpenAi">2 · OpenAI API key (optional)</label>
      <input type="password" id="gateOpenAi" autocomplete="off" spellcheck="false" placeholder="sk-… — optional; server env key used if empty" aria-describedby="gateErr" />
      <p id="gateServerLlmHint" class="muted" style="display: none; margin-top: 10px; font-size: 13px; line-height: 1.5">
        This host reports an LLM key in its environment — you may leave the OpenAI field empty for AI assistant calls.
      </p>
      <p class="muted" style="margin-top: 12px; font-size: 12px; line-height: 1.45">Secrets are kept in this tab only until you close it or refresh; they are not written to sessionStorage.</p>
      <div id="gateErr" class="alert err" style="display: none" tabindex="-1"></div>
      <button type="button" id="gateSubmit">Continue</button>
      <p id="gateWorking" class="muted" style="display: none; margin-top: 12px; font-size: 13px; line-height: 1.45" aria-live="polite"></p>
      <details class="gate-diag" id="gateDiag">
        <summary>Authentication diagnostic (developers)</summary>
        <pre id="gateDiagBody" class="gate-diag-pre"></pre>
        <p class="muted" style="margin: 10px 0 0; font-size: 11px; line-height: 1.45">
          Never shares your secret or API key — only lengths, HTTP status, and server messages. Updates each time you press Continue.
        </p>
      </details>
    </div>
  </div>

  <div id="playshareExplorerApp" hidden>
  <div class="wrap">
    <header class="topbar">
      <h1>Diagnostic intelligence</h1>
      <p>Review anonymized sync diagnostics: recent uploads, repeating patterns (clusters), and version comparisons. You already entered access on the unlock screen — no second password is required unless you choose <strong>Change credentials</strong>.</p>
      <p class="ver">UI v2 · If this page still looks like three plain buttons in a row, redeploy the server so <code>diag-intel-http.js</code> is current.</p>
    </header>

    <div class="shell">
      <aside class="side">
        <h2>1 · Access</h2>
        <p class="muted" style="margin: 0 0 10px; font-size: 12px; line-height: 1.45">
          The <strong>unlock screen</strong> is the only place you type the Railway Bearer secret for this tab. While the tab stays open, the browser keeps it in memory for API calls (including AI briefs and saving to the knowledge table). Refresh or a new tab requires unlocking again. Use <strong>Change credentials</strong> above the tabs to switch secret or LLM settings.
        </p>
        <ol class="steps">
          <li>Use Cases / Clusters / AI assistant — no extra password prompts.</li>
          <li>Read the summary table; expand <em>Raw JSON</em> only if you need the full payload.</li>
        </ol>
        <p class="muted" style="margin-top:12px">503 <code>supabase_not_configured</code> → set URL + service role on the server. 401 → use Change credentials and re-unlock.</p>
      </aside>

      <div class="main-col">
        <div class="access-panel access-panel--post-unlock" id="accessPanel">
          <input type="hidden" id="tok" value="" autocomplete="off" />
          <div class="access-unlock-row">
            <span><strong style="color: var(--ok)">Unlocked</strong> — Bearer and LLM settings from the gateway apply to all requests in this tab.</span>
            <button type="button" class="ghost" id="btnReunlock">Change credentials…</button>
          </div>
          <p class="access-panel-hint" style="margin-top: 8px">
            The server never sends your secret to the page; after unlock the browser attaches <code>Authorization: Bearer …</code> and your LLM key (if any) on each request until you refresh or use <strong>Change credentials</strong>.
          </p>
        </div>
        <nav class="tabs" role="tablist" aria-label="Views">
          <button type="button" role="tab" class="active" data-tab="cases" aria-selected="true">Cases</button>
          <button type="button" role="tab" data-tab="clusters" aria-selected="false">Clusters</button>
          <button type="button" role="tab" data-tab="insights" aria-selected="false">Insights</button>
          <button type="button" role="tab" data-tab="search" aria-selected="false">Search</button>
          <button type="button" role="tab" data-tab="regress" aria-selected="false">Compare versions</button>
          <button type="button" role="tab" data-tab="ai" aria-selected="false">AI assistant</button>
        </nav>

        <div id="panel-cases" class="tab-panel active" role="tabpanel">
          <p class="muted" style="margin:0 0 12px">Newest diagnostic cases. Use filters to narrow by extension build, site, tag, or cluster id.</p>
          <div class="row">
            <div class="grow"><label class="lbl" for="fLim">How many rows</label><input type="text" id="fLim" value="25" inputmode="numeric" /></div>
            <div class="grow"><label class="lbl" for="fExt">Extension version (exact)</label><input type="text" id="fExt" placeholder="e.g. 1.1.0" /></div>
            <div class="grow"><label class="lbl" for="fPlat">Platform / site key</label><input type="text" id="fPlat" /></div>
          </div>
          <div class="row">
            <div class="grow"><label class="lbl" for="fTag">Derived tag</label><input type="text" id="fTag" placeholder="e.g. likely_buffer_issue" /></div>
            <div class="grow"><label class="lbl" for="fCluster">Cluster signature</label><input type="text" id="fCluster" /></div>
            <button type="button" class="primary" id="btnCases">Load cases</button>
          </div>
        </div>

        <div id="panel-clusters" class="tab-panel" role="tabpanel" hidden>
          <p class="muted" style="margin:0 0 12px">Groups of cases that look alike — useful for spotting recurring issues.</p>
          <div class="row">
            <div class="grow" style="max-width:200px"><label class="lbl" for="fCLim">Rows per page</label><input type="text" id="fCLim" value="25" inputmode="numeric" /></div>
            <button type="button" class="primary" id="btnClusters">Load clusters</button>
          </div>
        </div>

        <div id="panel-insights" class="tab-panel" role="tabpanel" hidden>
          <p class="muted" style="margin:0 0 12px">Plain-language suggestions from recent metrics (not a substitute for reading individual cases).</p>
          <button type="button" class="primary" id="btnRecs">Generate insights</button>
        </div>

        <div id="panel-search" class="tab-panel" role="tabpanel" hidden>
          <p class="muted" style="margin:0 0 12px">Search the short text summary we store for each case (two characters minimum).</p>
          <div class="row">
            <div class="grow"><label class="lbl" for="sq">Keywords</label><input type="search" id="sq" placeholder="buffer, netflix, reconnect…" /></div>
            <div class="grow" style="max-width:200px"><label class="lbl" for="fSearchLim">Rows per page</label><input type="text" id="fSearchLim" value="25" inputmode="numeric" /></div>
            <button type="button" class="primary" id="btnSearch">Search</button>
          </div>
        </div>

        <div id="panel-regress" class="tab-panel" role="tabpanel" hidden>
          <p class="muted" style="margin:0 0 12px">Compare average metrics between two extension builds to spot regressions. Optional platform limits the sample to one site.</p>
          <div class="row">
            <div class="grow"><label class="lbl" for="bv">Older build (baseline)</label><input type="text" id="bv" placeholder="1.0.0" /></div>
            <div class="grow"><label class="lbl" for="tv">Newer build (target)</label><input type="text" id="tv" placeholder="1.0.1" /></div>
            <div class="grow"><label class="lbl" for="pf">Platform (optional)</label><input type="text" id="pf" /></div>
            <button type="button" class="primary" id="btnReg">Run comparison</button>
          </div>
        </div>

        <div id="panel-ai" class="tab-panel" role="tabpanel" hidden>
          <p class="muted" style="margin:0 0 10px">
            Uses <strong>live data</strong> from diagnostic recordings (<code>diag_cases</code> / clusters). Each successful AI run can be <strong>saved</strong> into <code>diag_intel_knowledge</code>; the next run automatically includes those excerpts so the tool <strong>accumulates context</strong> about the extension over time.
          </p>
          <p class="muted" style="margin:0 0 10px;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface2);font-size:13px;line-height:1.5">
            LLM access comes from the <strong>OpenAI key you paste at unlock</strong> (sent with each request) or from Railway <code>PLAYSHARE_DIAG_AI_API_KEY</code> / <code>OPENAI_API_KEY</code> on the host when you leave that field empty. If you see <strong>LLM not configured</strong>, add a key at unlock or set one of those env vars, or use <strong>Data pack only</strong>. <strong>401</strong> on requests is almost always a wrong unlock secret — use <strong>Change credentials</strong>.
          </p>
          <p class="muted" style="margin:0 0 14px;font-size:12px">
            <strong>Supabase:</strong> apply migration <code>20260330120000_diag_intel_knowledge.sql</code>. Optional server env: <code>PLAYSHARE_DIAG_AI_BASE_URL</code>, <code>PLAYSHARE_DIAG_AI_MODEL</code> (default <code>gpt-4o-mini</code>). <strong>Primer:</strong> <code>npm run generate:primer</code> · <code>playshare-extension-primer.static.md</code> / <code>playshare-extension-primer.js</code>.
          </p>
          <div class="row">
            <div class="grow"><label class="lbl" for="aiFocusPlat">Focus platform (optional)</label><input type="text" id="aiFocusPlat" placeholder="e.g. netflix, prime" /></div>
          </div>
          <label class="lbl" for="aiNotes">What you want prioritized (optional)</label>
          <textarea id="aiNotes" class="brief-notes" placeholder="e.g. Investigate Prime seek lag; compare with Netflix ad path."></textarea>
          <div class="chk" style="margin-top:10px">
            <label><input type="checkbox" id="aiIncludePrior" checked /> Include saved prior briefs in prompt (cumulative learning)</label>
          </div>
          <div class="chk" style="margin-top:6px">
            <label><input type="checkbox" id="aiPersist" checked /> After AI run, save this brief to the knowledge table</label>
          </div>
          <div class="chk" style="margin-top:6px">
            <label><input type="checkbox" id="aiDryRun" /> Data pack only — no LLM (works without API key)</label>
          </div>
          <div class="row" style="margin-top:12px">
            <button type="button" class="primary" id="btnAiBrief">Generate brief</button>
            <span id="aiBriefStatus" class="path"></span>
          </div>
          <div id="aiBriefResult" style="margin-top:16px"></div>
          <h3 class="muted" style="margin:22px 0 10px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Saved learnings</h3>
          <p class="muted" style="margin:0 0 10px;font-size:12px">Append-only history of AI and manual notes. Open loads full markdown.</p>
          <div class="row" style="margin-bottom:10px">
            <button type="button" class="secondary" id="btnListKnowledge">Refresh list</button>
          </div>
          <div id="aiKnowledgeList" class="muted" style="font-size:13px;margin-bottom:12px"></div>
          <textarea id="aiKnowledgeViewTa" class="brief-ta" readonly style="display:none;margin-bottom:12px" placeholder="Select Open on a row…"></textarea>
          <label class="lbl" for="aiManualMemory">Add a manual note to memory (markdown)</label>
          <textarea id="aiManualMemory" class="brief-notes" style="min-height:72px" placeholder="e.g. Confirmed: Prime fullscreen exit breaks sync until tab refocus — see session 2025-03-30."></textarea>
          <div class="row" style="margin-top:8px">
            <button type="button" class="secondary" id="btnSaveManualMemory">Save manual note</button>
            <span id="aiManualStatus" class="path"></span>
          </div>
        </div>

        <section class="results" aria-live="polite">
          <h2>Results</h2>
          <div class="result-head">
            <span id="statusPill" class="pill idle">Ready</span>
            <span id="latencyEl" class="path"></span>
            <span id="pathEl" class="path"></span>
            <span style="flex:1"></span>
            <button type="button" class="ghost" id="btnCopy" disabled>Copy JSON</button>
            <button type="button" class="ghost" id="btnDl" disabled>Download</button>
          </div>
          <div id="humanOut" class="human">
            <div class="empty">Run a query from a tab above. A table or cards will appear here; raw data stays in the fold below.</div>
          </div>
          <details class="raw-json" id="rawDetails">
            <summary>Technical details — raw JSON</summary>
            <pre id="out">{}</pre>
          </details>
        </section>
      </div>
    </div>

    <footer>PlayShare · <code>/diag/intel/*</code> · unlock <code>POST /diag/intel/auth-check</code> · health <code>/diag/intel/health</code></footer>
  </div>
  </div>

  <script>
(function () {
  var TOK_KEY = 'playshare_diag_intel_token_v1';
  var AI_KEY_STORAGE = 'playshare_diag_explorer_ai_key_v1';
  var SKIP_LLM_STORAGE = 'playshare_diag_explorer_skip_llm_v1';
  var runtimeAiKey = '';
  /** Bearer from unlock gate (used when hidden #tok is empty until filled). */
  var runtimeDiagBearer = '';
  var lastText = '';
  var lastPath = '';
  var lastPagedFetch = null;
  var lastPagination = null;
  var FIELD_LABELS = {
    ad_mode_enter_count: 'Ad-mode entries',
    hard_correction_count: 'Hard corrections',
    buffering_count: 'Buffering events',
    stalled_count: 'Playback stalls',
    ws_disconnect_count: 'WebSocket disconnects',
    netflix_safety_reject_count: 'Netflix safety rejects',
    source_swap_count: 'Video source swaps',
    sync_apply_reject_total: 'Sync apply rejects (all reasons)'
  };

  function $(id) { return document.getElementById(id); }

  /** Resolve API base when the app is mounted under a path prefix (same origin as this page). */
  function intelBase() {
    var p = window.location.pathname || '';
    var needle = '/diag/intel';
    var idx = p.indexOf(needle);
    if (idx >= 0) return p.slice(0, idx + needle.length);
    return needle;
  }
  /** @param {string} suffix path after /diag/intel e.g. '/cases?limit=1' */
  function intelApi(suffix) {
    var s = suffix.charAt(0) === '/' ? suffix : '/' + suffix;
    return intelBase() + s;
  }

  function enterExplorerApp() {
    var g = $('gateRoot');
    var a = $('playshareExplorerApp');
    if (g) {
      g.setAttribute('hidden', '');
    }
    if (a) {
      a.removeAttribute('hidden');
    }
  }

  function getClientLlmKeyForBrief() {
    return String(runtimeAiKey || '').trim();
  }

  function attachClientAiHeaders(h) {
    var ak = getClientLlmKeyForBrief();
    if (ak) h['X-PlayShare-Diag-AI-Key'] = ak;
    return h;
  }

  /** Strip wrapping quotes, BOM, CR, and accidental leading "Bearer " from pasted secrets. */
  function normalizeTokInput(raw) {
    var t = String(raw || '').trim();
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1).trim();
    if ((t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') || (t.charAt(0) === "'" && t.charAt(t.length - 1) === "'")) {
      t = t.slice(1, -1).trim();
    }
    if (t.toLowerCase().indexOf('bearer ') === 0) t = t.slice(7).trim();
    if (t.toLowerCase().indexOf('bearer ') === 0) t = t.slice(7).trim();
    t = t.replace(/\r/g, '').trim();
    return t;
  }

  function clearGateFieldHighlights() {
    var b = $('gateBearer');
    var o = $('gateOpenAi');
    if (b) {
      b.classList.remove('gate-input-err');
      b.removeAttribute('aria-invalid');
    }
    if (o) {
      o.classList.remove('gate-input-err');
      o.removeAttribute('aria-invalid');
    }
  }

  function highlightGateField(which) {
    clearGateFieldHighlights();
    var el = which === 'openai' ? $('gateOpenAi') : $('gateBearer');
    if (el) {
      el.classList.add('gate-input-err');
      el.setAttribute('aria-invalid', 'true');
      try {
        el.focus();
      } catch (eF) {}
    }
  }

  function clearGateErr() {
    var el = $('gateErr');
    if (!el) return;
    el.textContent = '';
    el.style.display = 'none';
    el.style.visibility = '';
    el.removeAttribute('role');
  }

  function showGateErr(msg) {
    var el = $('gateErr');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
    el.style.visibility = 'visible';
    el.setAttribute('role', 'alert');
    try {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (e) {}
  }

  function clearGateDiag() {
    var pre = $('gateDiagBody');
    var det = $('gateDiag');
    if (pre) pre.textContent = '';
    if (det) det.open = false;
  }

  /** @param {string[]} lines Plain lines: no secrets — lengths & server text only. */
  function recordGateAuthDiag(lines) {
    var pre = $('gateDiagBody');
    var det = $('gateDiag');
    if (!pre || !det) return;
    var when = new Date().toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
    pre.textContent = when + '\n\n' + lines.filter(Boolean).join('\n');
    setTimeout(function () {
      try {
        det.open = true;
        det.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch (e) {}
    }, 0);
  }

  /**
   * POST auth-check with a hard timeout even when AbortController is missing (older WebViews).
   * @returns {Promise<Response>}
   */
  function gateFetchAuthCheck(url, fetchOpts, timeoutMs) {
    var ms = timeoutMs || 25000;
    if (typeof AbortController !== 'undefined') {
      var ctrl = new AbortController();
      var opts = Object.assign({}, fetchOpts, { signal: ctrl.signal });
      var tid = setTimeout(function () {
        try {
          ctrl.abort();
        } catch (eA) {}
      }, ms);
      return fetch(url, opts).finally(function () {
        clearTimeout(tid);
      });
    }
    var tid2 = 0;
    var fetchP = fetch(url, fetchOpts).then(
      function (res) {
        if (tid2) clearTimeout(tid2);
        return res;
      },
      function (err) {
        if (tid2) clearTimeout(tid2);
        throw err;
      }
    );
    var timeoutP = new Promise(function (_, reject) {
      tid2 = setTimeout(function () {
        var err = new Error('timeout');
        err.name = 'TimeoutError';
        reject(err);
      }, ms);
    });
    return Promise.race([fetchP, timeoutP]);
  }

  /** @param {Response} res */
  async function readGateErrorDetail(res) {
    var raw = '';
    try {
      raw = await res.text();
    } catch (e) {
      return '';
    }
    if (!raw) return '';
    try {
      var j = JSON.parse(raw);
      if (j && typeof j === 'object') {
        var parts = [];
        if (j.error) parts.push(String(j.error));
        if (j.detail) parts.push(String(j.detail));
        if (j.hint) parts.push(String(j.hint));
        if (parts.length) return parts.join(' — ');
      }
    } catch (e2) {}
    return raw.length > 280 ? raw.slice(0, 280) + '…' : raw;
  }

  async function validateAndEnterFromGate() {
    var bearer = normalizeTokInput($('gateBearer') && $('gateBearer').value) || '';
    var openai = ($('gateOpenAi') && $('gateOpenAi').value.trim()) || '';
    var btn = $('gateSubmit');
    var working = $('gateWorking');
    clearGateErr();
    clearGateFieldHighlights();
    clearGateDiag();

    if (!bearer) {
      highlightGateField('bearer');
      recordGateAuthDiag([
        'Client validation failed.',
        'Railway secret: empty after trim / normalize — paste the variable value only (no label text).'
      ]);
      showGateErr('Paste the Railway diagnostic secret (PLAYSHARE_DIAG_INTEL_SECRET or upload secret). It cannot be empty.');
      return;
    }
    if (openai && openai.length < 12) {
      highlightGateField('openai');
      recordGateAuthDiag([
        'Client validation failed.',
        'OpenAI field: ' + openai.length + ' characters (minimum 12 expected for a real key) — paste full key or leave empty for server LLM.'
      ]);
      showGateErr('That OpenAI key looks too short. Copy the full key from OpenAI (usually starts with sk- or similar).');
      return;
    }

    if (btn) btn.disabled = true;
    if (working) {
      working.style.display = 'block';
      working.textContent = 'Checking credentials with the server…';
    }
    var timeoutMs = 25000;
    try {
      var r;
      try {
        var fetchOpts = {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + bearer,
            'X-PlayShare-Diag-Intel-Secret': bearer,
            'Content-Type': 'application/json'
          },
          body: '{}'
        };
        r = await gateFetchAuthCheck(intelApi('/auth-check'), fetchOpts, timeoutMs);
      } catch (eFetch) {
        var aborted =
          eFetch &&
          (eFetch.name === 'AbortError' ||
            eFetch.name === 'TimeoutError' ||
            (String(eFetch.message || '').toLowerCase().indexOf('abort') >= 0) ||
            (String(eFetch.message || '').toLowerCase().indexOf('timeout') >= 0));
        if (aborted) {
          recordGateAuthDiag([
            'No HTTP response — request aborted (timeout ' + Math.round(timeoutMs / 1000) + 's).',
            'Target: POST ' + intelApi('/auth-check'),
            'Normalized Railway secret length: ' + bearer.length + ' chars',
            'If the host is cold-starting, wait and retry.'
          ]);
          showGateErr(
            'Request timed out after ' +
              Math.round(timeoutMs / 1000) +
              's. Your server may be sleeping (cold start), overloaded, or unreachable. Wait and try again, or check Railway / hosting logs.'
          );
        } else {
          recordGateAuthDiag([
            'No HTTP response — network / wrong page origin.',
            'Target: POST ' + intelApi('/auth-check'),
            'Detail: ' + (eFetch && eFetch.message ? eFetch.message : String(eFetch)),
            'Open this page from the same host as your PlayShare server (…/diag/intel/explorer).'
          ]);
          showGateErr(
            'Could not reach the diagnostics API. Open this page from your PlayShare server (…/diag/intel/explorer), not a saved file. If you use a reverse proxy, keep the same path prefix. ' +
              (eFetch && eFetch.message ? 'Technical detail: ' + eFetch.message : '')
          );
        }
        return;
      }

      if (r.status === 401) {
        highlightGateField('bearer');
        var d401 = await readGateErrorDetail(r);
        recordGateAuthDiag([
          'HTTP 401 — Railway secret rejected by this server.',
          'Meaning: pasted value ≠ PLAYSHARE_DIAG_INTEL_SECRET / PLAYSHARE_DIAG_UPLOAD_SECRET in this deployment’s env.',
          'Normalized secret length: ' + bearer.length + ' chars (compare character count to the value in Railway for the same service).',
          'OpenAI field (not validated until unlock succeeds): ' + (openai ? openai.length + ' chars' : 'empty'),
          'Server detail: ' + (d401 || '(empty body)')
        ]);
        showGateErr(
          d401 ||
            'Invalid or wrong Railway secret (401). Paste the exact value of PLAYSHARE_DIAG_INTEL_SECRET or PLAYSHARE_DIAG_UPLOAD_SECRET from Variables. Do not add the word Bearer, quotes, or extra spaces.'
        );
        return;
      }
      if (r.status === 403) {
        highlightGateField('bearer');
        var d403 = await readGateErrorDetail(r);
        recordGateAuthDiag([
          'HTTP 403 — forbidden.',
          'Normalized Railway secret length: ' + bearer.length + ' chars',
          'Server detail: ' + (d403 || '(empty)')
        ]);
        showGateErr(
          'Access denied (403).' + (d403 ? ' ' + d403 : ' Check that the secret matches the variable on this server.')
        );
        return;
      }
      if (r.status === 404) {
        recordGateAuthDiag([
          'HTTP 404 — path not found on this host.',
          'Requested: POST ' + intelApi('/auth-check'),
          'You are probably not on the PlayShare server (wrong domain or path prefix).'
        ]);
        showGateErr(
          'Diagnostics URL not found (404). You may be on the wrong host or path. Use the live /diag/intel/explorer URL from the machine running PlayShare.'
        );
        return;
      }
      if (r.status === 503) {
        var j503t = await readGateErrorDetail(r);
        recordGateAuthDiag([
          'HTTP 503 — service unavailable.',
          'Often: intel_secret_not_configured (no PLAYSHARE_DIAG_INTEL_SECRET on this process) or upstream misconfiguration.',
          'Normalized Railway secret length sent: ' + bearer.length + ' chars',
          'Server detail: ' + (j503t || '(empty)')
        ]);
        showGateErr(
          j503t ||
            'Service unavailable (503). If this says intel_secret_not_configured, set PLAYSHARE_DIAG_INTEL_SECRET on this Railway service and redeploy.'
        );
        return;
      }
      if (r.status >= 500) {
        var d5 = await readGateErrorDetail(r);
        recordGateAuthDiag([
          'HTTP ' + r.status + ' — server error.',
          'Normalized Railway secret length: ' + bearer.length + ' chars',
          'Server detail: ' + (d5 || '(empty)')
        ]);
        showGateErr(
          'Server error (' +
            r.status +
            ').' +
            (d5 ? ' ' + d5 : ' Check deployment logs on Railway (or your host) and try again.')
        );
        return;
      }
      if (!r.ok) {
        var dx = await readGateErrorDetail(r);
        recordGateAuthDiag([
          'HTTP ' + r.status + ' ' + (r.statusText || '') + ' — unexpected.',
          'Normalized Railway secret length: ' + bearer.length + ' chars',
          'Server detail: ' + (dx || '(empty)')
        ]);
        showGateErr(
          'Unexpected response ' + r.status + ' ' + (r.statusText || '') + '.' + (dx ? ' ' + dx : ' Try again or redeploy the server.')
        );
        return;
      }

      var okBody = await r.text().catch(function () {
        return '';
      });
      var supLine = '';
      try {
        var jOk = JSON.parse(okBody || '{}');
        if (jOk.supabase_configured === false) {
          supLine =
            'Supabase: server reports not configured — after unlock, "Load cases" may return 503 until SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set.';
        } else if (jOk.supabase_configured === true) {
          supLine = 'Supabase: server reports configured.';
        }
      } catch (eJ) {}
      recordGateAuthDiag([
        'HTTP ' + r.status + ' — authentication accepted.',
        'POST ' + intelApi('/auth-check'),
        'Normalized Railway secret length: ' + bearer.length + ' chars',
        'OpenAI field: ' + (openai ? openai.length + ' chars (stored for AI requests)' : 'empty (use server LLM env if set)'),
        okBody ? 'Response JSON: ' + okBody : '(empty body)',
        supLine
      ].filter(Boolean));

      try {
        runtimeAiKey = openai;
        try {
          sessionStorage.removeItem(TOK_KEY);
          sessionStorage.removeItem(AI_KEY_STORAGE);
          sessionStorage.removeItem(SKIP_LLM_STORAGE);
        } catch (e2) {}
        runtimeDiagBearer = bearer;
        if ($('tok')) $('tok').value = bearer;
        clearGateErr();
        clearGateFieldHighlights();
        enterExplorerApp();
      } catch (eDone) {
        recordGateAuthDiag([
          'Server returned success but a browser step failed after unlock.',
          String(eDone && eDone.message ? eDone.message : eDone)
        ]);
        showGateErr('Unlocked locally but something failed in the page: ' + (eDone && eDone.message ? eDone.message : String(eDone)));
      }
    } finally {
      if (working) working.style.display = 'none';
      if (btn) btn.disabled = false;
    }
  }

  fetch(intelApi('/public-meta'))
    .then(function (r) {
      return r.text();
    })
    .then(function (t) {
      try {
        var j = JSON.parse(t || '{}');
        if (j && j.ok && j.server_llm_configured) {
          var gh = $('gateServerLlmHint');
          if (gh) gh.style.display = 'block';
        }
      } catch (eParse) {}
    })
    .catch(function () {});

  var gateBtn = $('gateSubmit');
  if (gateBtn) {
    function onGateContinueClick(ev) {
      if (ev) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      try {
        var pr = validateAndEnterFromGate();
        if (pr && typeof pr.catch === 'function') {
          pr.catch(function (eUnhandled) {
            recordGateAuthDiag([
              'Uncaught async error in unlock handler.',
              String(eUnhandled && eUnhandled.message ? eUnhandled.message : eUnhandled)
            ]);
            showGateErr('Unexpected error: ' + (eUnhandled && eUnhandled.message ? eUnhandled.message : String(eUnhandled)));
          });
        }
      } catch (eSync) {
        recordGateAuthDiag([
          'Uncaught synchronous error in Continue click.',
          String(eSync && eSync.message ? eSync.message : eSync)
        ]);
        showGateErr('Unexpected error: ' + (eSync && eSync.message ? eSync.message : String(eSync)));
      }
    }
    gateBtn.addEventListener('click', onGateContinueClick);
  }
  function gateMaybeSubmit(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    try {
      var pr = validateAndEnterFromGate();
      if (pr && typeof pr.catch === 'function') {
        pr.catch(function (eUnhandled) {
          recordGateAuthDiag([
            'Uncaught async error in unlock handler (Enter key).',
            String(eUnhandled && eUnhandled.message ? eUnhandled.message : eUnhandled)
          ]);
          showGateErr('Unexpected error: ' + (eUnhandled && eUnhandled.message ? eUnhandled.message : String(eUnhandled)));
        });
      }
    } catch (eSync) {
      recordGateAuthDiag([
        'Uncaught synchronous error (Enter key).',
        String(eSync && eSync.message ? eSync.message : eSync)
      ]);
      showGateErr('Unexpected error: ' + (eSync && eSync.message ? eSync.message : String(eSync)));
    }
  }
  var gb = $('gateBearer');
  if (gb) gb.addEventListener('keydown', gateMaybeSubmit);
  var go = $('gateOpenAi');
  if (go) go.addEventListener('keydown', gateMaybeSubmit);

  var btnReunlock = $('btnReunlock');
  if (btnReunlock) {
    btnReunlock.onclick = function () {
      try {
        sessionStorage.removeItem(TOK_KEY);
        sessionStorage.removeItem(AI_KEY_STORAGE);
        sessionStorage.removeItem(SKIP_LLM_STORAGE);
      } catch (eR) {}
      runtimeDiagBearer = '';
      runtimeAiKey = '';
      if ($('tok')) $('tok').value = '';
      if ($('gateBearer')) $('gateBearer').value = '';
      if ($('gateOpenAi')) $('gateOpenAi').value = '';
      clearGateErr();
      clearGateDiag();
      var gr = $('gateRoot');
      var ap = $('playshareExplorerApp');
      if (ap) ap.setAttribute('hidden', '');
      if (gr) gr.removeAttribute('hidden');
    };
  }

  function esc(s) {
    if (s == null || s === '') return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtWhen(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch (e) {
      return esc(iso);
    }
  }

  function tagsCell(tags) {
    if (!Array.isArray(tags) || !tags.length) return '—';
    return esc(tags.join(', '));
  }

  function truncate(s, n) {
    var t = String(s || '');
    if (t.length <= n) return esc(t);
    return esc(t.slice(0, n)) + '…';
  }

  function paginationBar(p) {
    if (!p || typeof p.offset !== 'number' || typeof p.limit !== 'number') return '';
    var start = p.returned ? p.offset + 1 : p.offset;
    var end = p.offset + (p.returned || 0);
    var prevDis = p.offset <= 0 ? ' disabled' : '';
    var nextDis = !p.has_more ? ' disabled' : '';
    var label =
      p.returned > 0
        ? 'Showing ' + start + '–' + end + (p.has_more ? ' (more available)' : '')
        : 'No rows on this page';
    return (
      '<div class="pager" role="navigation" aria-label="Pagination">' +
      '<button type="button" class="secondary"' +
      prevDis +
      ' data-page="prev">Previous page</button>' +
      '<span class="pager-meta">' +
      esc(label) +
      '</span>' +
      '<button type="button" class="secondary"' +
      nextDis +
      ' data-page="next">Next page</button>' +
      '</div>'
    );
  }

  function getResolvedBearer() {
    var t = normalizeTokInput($('tok') && $('tok').value);
    if (t) return t;
    return normalizeTokInput(runtimeDiagBearer);
  }

  function authHeaders() {
    var t = getResolvedBearer();
    var h = { 'Content-Type': 'application/json' };
    if (t) {
      h.Authorization = 'Bearer ' + t;
      h['X-PlayShare-Diag-Intel-Secret'] = t;
    }
    return attachClientAiHeaders(h);
  }

  function setPill(text, kind) {
    var el = $('statusPill');
    el.textContent = text;
    el.className = 'pill ' + (kind || 'idle');
  }

  function setLoading() {
    setPill('Loading…', 'warn');
    $('latencyEl').textContent = '';
    $('pathEl').textContent = '';
    $('out').textContent = '…';
    $('btnCopy').disabled = true;
    $('btnDl').disabled = true;
    $('humanOut').innerHTML = '<div class="empty">Loading…</div>';
  }

  function pillForStatus(code) {
    if (code >= 200 && code < 300) return 'ok';
    if (code === 401 || code === 403) return 'err';
    if (code >= 500) return 'err';
    if (code >= 400) return 'warn';
    return 'idle';
  }

  function renderHuman(j, statusCode) {
    var box = $('humanOut');
    var raw = $('rawDetails');
    if (!j) {
      box.innerHTML = '<div class="alert err">Empty response.</div>';
      return;
    }
    if (j.parseError) {
      box.innerHTML = '<div class="alert err">The server returned non-JSON. First bytes: <span class="mono-sm">' + esc((j.bodyPreview || '').slice(0, 400)) + '</span></div>';
      if (statusCode >= 400) raw.open = true;
      return;
    }
    if (j.ok === false) {
      var msg = esc(j.error || 'request_failed');
      var det = j.detail ? '<br/><span class="mono-sm">' + esc(String(j.detail)) + '</span>' : '';
      var cls = statusCode >= 500 ? 'err' : 'warn';
      box.innerHTML = '<div class="alert ' + cls + '"><strong>' + msg + '</strong>' + det + '</div>';
      raw.open = true;
      return;
    }
    if (Array.isArray(j.cases)) {
      var qh =
        j.query != null
          ? '<p class="muted" style="margin:0 0 10px">Matches for <strong>' + esc(j.query) + '</strong> · ' + j.cases.length + ' row(s) on this page</p>'
          : '<p class="muted" style="margin:0 0 10px">' + j.cases.length + ' case(s) on this page</p>';
      if (!j.cases.length) {
        box.innerHTML =
          qh +
          '<div class="empty">No rows matched. Upload a diagnostic from the extension, relax filters, or go to the previous page.</div>' +
          (j.pagination ? paginationBar(j.pagination) : '');
        return;
      }
      var tbl = qh + '<div style="overflow:auto"><table class="data-table"><thead><tr><th>When</th><th>Site</th><th>Ext</th><th>Summary</th><th>Tags</th><th></th></tr></thead><tbody>';
      j.cases.forEach(function (c) {
        var id = c.report_id || '';
        tbl += '<tr><td>' + fmtWhen(c.uploaded_at) + '</td><td>' + esc(c.platform || '') + '</td><td class="mono-sm">' + esc(c.extension_version || '') + '</td><td class="sum">' + truncate(c.case_summary_text, 160) + '</td><td class="mono-sm">' + tagsCell(c.derived_tags) + '</td><td><button type="button" class="linkish" data-explain="' + esc(id) + '">Explain</button></td></tr>';
      });
      tbl += '</tbody></table></div>' + (j.pagination ? paginationBar(j.pagination) : '');
      box.innerHTML = tbl;
      box.querySelectorAll('[data-explain]').forEach(function (btn) {
        btn.onclick = function () {
          var rid = btn.getAttribute('data-explain');
          if (rid) jget(intelApi('/cases/' + rid + '/explain'));
        };
      });
      return;
    }
    if (Array.isArray(j.clusters)) {
      if (!j.clusters.length) {
        box.innerHTML =
          '<div class="empty">No cluster rollups on this page (or none yet). They populate as cases are ingested.</div>' +
          (j.pagination ? paginationBar(j.pagination) : '');
        return;
      }
      var t2 =
        '<p class="muted" style="margin:0 0 10px">' +
        j.clusters.length +
        ' cluster(s) on this page</p><div style="overflow:auto"><table class="data-table"><thead><tr><th>Last seen</th><th>Site</th><th>Cases</th><th>Signature</th><th>Summary</th></tr></thead><tbody>';
      j.clusters.forEach(function (cl) {
        t2 += '<tr><td>' + fmtWhen(cl.last_case_at) + '</td><td>' + esc(cl.platform || '') + '</td><td>' + esc(String(cl.case_count != null ? cl.case_count : '')) + '</td><td class="mono-sm">' + truncate(cl.cluster_signature, 48) + '</td><td class="sum">' + truncate(cl.cluster_summary, 120) + '</td></tr>';
      });
      t2 += '</tbody></table></div>' + (j.pagination ? paginationBar(j.pagination) : '');
      box.innerHTML = t2;
      return;
    }
    if (j.recommendations && Array.isArray(j.recommendations)) {
      var sample = j.case_sample_size != null ? '<p class="muted" style="margin:0 0 12px">Based on the last <strong>' + esc(String(j.case_sample_size)) + '</strong> uploaded case(s).</p>' : '';
      if (!j.recommendations.length) {
        box.innerHTML = sample + '<div class="empty">No strong patterns in this sample. Try again after more uploads or raise the sample size in the API.</div>';
        return;
      }
      var cards = sample;
      j.recommendations.forEach(function (r) {
        var conf = r.confidence ? '<span class="pill ' + (r.confidence === 'low' ? 'warn' : 'ok') + '" style="font-size:10px;margin-left:8px">' + esc(r.confidence) + '</span>' : '';
        var ev = Array.isArray(r.evidence) ? r.evidence.map(function (x) { return esc(x); }).join(' · ') : '';
        cards += '<div class="rec-card"><p><strong>Suggestion</strong>' + conf + '</p><p>' + esc(r.text || '') + '</p><div class="rec-meta">' + ev + '</div></div>';
      });
      box.innerHTML = cards;
      return;
    }
    if (j.explanation) {
      var ex = j.explanation;
      var hints = ex.suggested_inspection && typeof ex.suggested_inspection === 'object' ? ex.suggested_inspection : {};
      var hintList = Object.keys(hints).map(function (k) {
        return '<div class="dl-row"><dt>' + esc(k) + '</dt><dd class="mono-sm">' + esc(hints[k]) + '</dd></div>';
      }).join('');
      var sec = Array.isArray(ex.secondary_factors) && ex.secondary_factors.length
        ? '<p class="muted" style="margin-top:12px"><strong>Also consider:</strong> ' + esc(ex.secondary_factors.join(' · ')) + '</p>'
        : '';
      var sim = Array.isArray(ex.similar_cases) && ex.similar_cases.length
        ? '<h3 class="muted" style="margin:16px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Similar cases</h3><ul style="margin:0;padding-left:18px;color:#cbd5e1;font-size:13px">' +
          ex.similar_cases.map(function (s) {
            return '<li>' + fmtWhen(s.uploaded_at) + ' — ' + truncate(s.case_summary_text, 100) + '</li>';
          }).join('') + '</ul>'
        : '';
      box.innerHTML =
        '<div class="rec-card"><p class="muted" style="margin:0 0 6px">Report <span class="mono-sm">' + esc(ex.report_id) + '</span></p>' +
        '<p style="font-size:1.05rem;margin:0 0 8px"><strong>Likely focus:</strong> ' + esc(ex.likely_issue || '') + '</p>' +
        sec +
        '<h3 class="muted" style="margin:16px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Why</h3><ul style="margin:0;padding-left:18px;font-size:13px">' +
        (Array.isArray(ex.reasoning) ? ex.reasoning.map(function (x) { return '<li class="mono-sm">' + esc(x) + '</li>'; }).join('') : '') +
        '</ul>' +
        (hintList ? '<h3 class="muted" style="margin:16px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Where to look in code</h3>' + hintList : '') +
        sim +
        '</div>';
      return;
    }
    if (j.case && typeof j.case === 'object') {
      var row = j.case;
      box.innerHTML =
        '<div class="rec-card"><p class="mono-sm" style="margin:0 0 8px">' + esc(row.report_id) + '</p>' +
        '<div class="dl-row"><dt>Uploaded</dt><dd>' + fmtWhen(row.uploaded_at) + '</dd></div>' +
        '<div class="dl-row"><dt>Platform</dt><dd>' + esc(row.platform) + '</dd></div>' +
        '<div class="dl-row"><dt>Extension</dt><dd>' + esc(row.extension_version) + '</dd></div>' +
        '<div class="dl-row"><dt>Summary</dt><dd>' + esc(row.case_summary_text) + '</dd></div>' +
        '<div class="dl-row"><dt>Tags</dt><dd class="mono-sm">' + tagsCell(row.derived_tags) + '</dd></div>' +
        '<p style="margin-top:12px"><button type="button" class="linkish" id="btnExplainThis">Open plain-language explain</button></p></div>';
      var bid = row.report_id;
      $('btnExplainThis').onclick = function () {
        if (bid) jget(intelApi('/cases/' + bid + '/explain'));
      };
      return;
    }
    if (j.comparison && typeof j.comparison === 'object') {
      var cmp = j.comparison;
      var head = '<p class="muted" style="margin:0 0 12px">Baseline <strong>' + esc(j.baseline_ver) + '</strong> (' + esc(String(cmp.baseline_n)) + ' cases) vs target <strong>' + esc(j.target_ver) + '</strong> (' + esc(String(cmp.target_n)) + ' cases). Filter: <strong>' + esc(String(cmp.filter)) + '</strong>.</p>';
      if (!cmp.baseline_n || !cmp.target_n) {
        box.innerHTML = head + '<div class="empty">Not enough cases on one or both versions. Check exact version strings in the database.</div>';
        return;
      }
      var sumList = Array.isArray(cmp.summary) && cmp.summary.length
        ? '<ul style="margin:0 0 14px;padding-left:18px;font-size:14px">' + cmp.summary.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'
        : '<p class="muted">No metric crossed the “notable change” threshold — open JSON for full deltas.</p>';
      var md = '<h3 class="muted" style="margin:12px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Metric averages</h3><div style="overflow:auto"><table class="data-table"><thead><tr><th>Metric</th><th>Baseline Ø</th><th>Target Ø</th><th>Note</th></tr></thead><tbody>';
      (cmp.metric_deltas || []).forEach(function (d) {
        var label = FIELD_LABELS[d.field] || d.field;
        var rowCls = d.notable ? ' style="background:rgba(251,191,36,0.06)"' : '';
        md += '<tr' + rowCls + '><td>' + esc(label) + '</td><td class="mono-sm">' + (d.baseline_mean != null ? esc(d.baseline_mean.toFixed(2)) : '—') + '</td><td class="mono-sm">' + (d.target_mean != null ? esc(d.target_mean.toFixed(2)) : '—') + '</td><td>' + esc(d.note || '') + '</td></tr>';
      });
      md += '</tbody></table></div>';
      var tg = '<h3 class="muted" style="margin:16px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Tag rates</h3><div style="overflow:auto"><table class="data-table"><thead><tr><th>Tag</th><th>Baseline</th><th>Target</th><th>Δ</th></tr></thead><tbody>';
      (cmp.tag_compare || []).forEach(function (t) {
        var rowCls = t.notable ? ' style="background:rgba(251,191,36,0.06)"' : '';
        var dlt = t.delta != null ? (t.delta * 100).toFixed(0) + ' pp' : '—';
        tg += '<tr' + rowCls + '><td class="mono-sm">' + esc(t.tag) + '</td><td>' + (t.baseline_rate != null ? esc((t.baseline_rate * 100).toFixed(0) + '%') : '—') + '</td><td>' + (t.target_rate != null ? esc((t.target_rate * 100).toFixed(0) + '%') : '—') + '</td><td>' + esc(dlt) + '</td></tr>';
      });
      tg += '</tbody></table></div>';
      box.innerHTML = head + sumList + md + tg;
      return;
    }
    box.innerHTML = '<div class="empty">Received data in an unexpected shape. Expand <em>Raw JSON</em> below.</div>';
  }

  async function jget(path) {
    lastPath = path;
    setLoading();
    var t0 = performance.now();
    var status = 0;
    try {
      var r = await fetch(path, { headers: authHeaders() });
      status = r.status;
      var ms = Math.round(performance.now() - t0);
      var raw = await r.text();
      var j;
      try {
        j = JSON.parse(raw);
      } catch (e) {
        j = { ok: false, parseError: true, bodyPreview: raw.slice(0, 800) };
      }
      lastText = JSON.stringify(j, null, 2);
      $('out').textContent = lastText;
      $('latencyEl').textContent = ms + ' ms';
      $('pathEl').textContent = path;
      setPill(String(r.status) + ' ' + r.statusText, pillForStatus(r.status));
      $('btnCopy').disabled = !lastText;
      $('btnDl').disabled = !lastText;
      if (j && j.ok !== false && j.pagination) lastPagination = j.pagination;
      else lastPagination = null;
      renderHuman(j, r.status);
      $('rawDetails').open = r.status >= 400 || j.parseError;
    } catch (e) {
      lastPagination = null;
      lastText = JSON.stringify({ ok: false, error: 'fetch_failed', detail: String(e && e.message ? e.message : e) }, null, 2);
      $('out').textContent = lastText;
      $('latencyEl').textContent = Math.round(performance.now() - t0) + ' ms';
      $('pathEl').textContent = path;
      setPill('Network error', 'err');
      $('btnCopy').disabled = false;
      $('btnDl').disabled = false;
      renderHuman(JSON.parse(lastText), 0);
      $('rawDetails').open = true;
    }
  }

  function casesQuery(offset) {
    var off = offset == null || offset === '' ? 0 : Math.max(0, parseInt(offset, 10) || 0);
    var limRaw = parseInt(($('fLim').value || '25').trim(), 10) || 25;
    var lim = Math.min(100, Math.max(1, limRaw));
    var q = ['limit=' + encodeURIComponent(String(lim)), 'offset=' + encodeURIComponent(String(off))];
    var ext = ($('fExt').value || '').trim();
    var plat = ($('fPlat').value || '').trim();
    var tag = ($('fTag').value || '').trim();
    var cl = ($('fCluster').value || '').trim();
    if (ext) q.push('extension_version=' + encodeURIComponent(ext));
    if (plat) q.push('platform=' + encodeURIComponent(plat));
    if (tag) q.push('tag=' + encodeURIComponent(tag));
    if (cl) q.push('cluster=' + encodeURIComponent(cl));
    return intelApi('/cases?' + q.join('&'));
  }

  function searchPath(offset) {
    var off = offset == null || offset === '' ? 0 : Math.max(0, parseInt(offset, 10) || 0);
    var raw = ($('sq').value || '').trim();
    var limRaw = parseInt(($('fSearchLim').value || '25').trim(), 10) || 25;
    var lim = Math.min(40, Math.max(1, limRaw));
    return intelApi('/search?q=' + encodeURIComponent(raw) + '&limit=' + lim + '&offset=' + off);
  }

  function clustersPath(offset) {
    var off = offset == null || offset === '' ? 0 : Math.max(0, parseInt(offset, 10) || 0);
    var limRaw = parseInt(($('fCLim').value || '25').trim(), 10) || 25;
    var lim = Math.min(80, Math.max(1, limRaw));
    return intelApi('/clusters?limit=' + lim + '&offset=' + off);
  }

  document.querySelectorAll('.tabs [role="tab"]').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var id = tab.getAttribute('data-tab');
      document.querySelectorAll('.tabs [role="tab"]').forEach(function (t) {
        var on = t === tab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      document.querySelectorAll('.tab-panel').forEach(function (p) {
        var show = p.id === 'panel-' + id;
        p.classList.toggle('active', show);
        if (show) p.removeAttribute('hidden'); else p.setAttribute('hidden', '');
      });
    });
  });

  $('humanOut').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-page]');
    if (!btn || btn.disabled || !lastPagedFetch || !lastPagination) return;
    var dir = btn.getAttribute('data-page');
    var p = lastPagination;
    if (dir === 'prev') lastPagedFetch(Math.max(0, p.offset - p.limit));
    else if (dir === 'next' && p.has_more) lastPagedFetch(p.offset + p.limit);
  });

  $('btnCases').onclick = function () {
    lastPagedFetch = function (off) {
      jget(casesQuery(off));
    };
    jget(casesQuery(0));
  };
  $('btnClusters').onclick = function () {
    lastPagedFetch = function (off) {
      jget(clustersPath(off));
    };
    jget(clustersPath(0));
  };
  $('btnRecs').onclick = function () {
    lastPagedFetch = null;
    lastPagination = null;
    jget(intelApi('/recommendations?sample=150'));
  };
  $('btnSearch').onclick = function () {
    var raw = ($('sq').value || '').trim();
    if (raw.length < 2) { alert('Enter at least 2 characters'); return; }
    lastPagedFetch = function (off) {
      jget(searchPath(off));
    };
    jget(searchPath(0));
  };
  $('sq').onkeydown = function (e) {
    if (e.key === 'Enter') $('btnSearch').click();
  };
  $('btnReg').onclick = function () {
    lastPagedFetch = null;
    lastPagination = null;
    var bv = encodeURIComponent(($('bv').value || '').trim());
    var tv = encodeURIComponent(($('tv').value || '').trim());
    var pf = ($('pf').value || '').trim();
    if (!bv || !tv) { alert('Baseline and target versions are required'); return; }
    var u = intelApi('/regression?baseline_ver=' + bv + '&target_ver=' + tv);
    if (pf) u += '&platform=' + encodeURIComponent(pf);
    jget(u);
  };

  function extractCursorBlock(md) {
    if (!md) return '';
    var tick3 = String.fromCharCode(96, 96, 96);
    var re = new RegExp(
      '##\\\\s*COPY_PASTE_FOR_CURSOR_AI\\\\s*(?:\\\\r?\\\\n)+' +
        tick3 +
        '[a-z0-9]*\\\\s*([\\\\s\\\\S]*?)' +
        tick3,
      'im'
    );
    var m = md.match(re);
    return m ? m[1].trim() : '';
  }

  function copyText(t, okEl) {
    if (!t) {
      alert('Nothing to copy');
      return;
    }
    navigator.clipboard.writeText(t).then(function () {
      if (okEl) {
        okEl.textContent = 'Copied';
        setTimeout(function () {
          okEl.textContent = '';
        }, 1600);
      }
    }).catch(function () {
      alert('Clipboard unavailable');
    });
  }

  $('btnAiBrief').onclick = async function () {
    var btn = $('btnAiBrief');
    var out = $('aiBriefResult');
    var st = $('aiBriefStatus');
    if (!getResolvedBearer()) {
      st.textContent = '';
      out.innerHTML =
        '<div class="alert err"><strong>Missing server secret</strong>' +
        '<p class="muted" style="margin:8px 0 0">Use <strong>Change credentials</strong> (above the tabs) to open the unlock screen and paste your Railway <code>PLAYSHARE_DIAG_INTEL_SECRET</code> (or upload secret). Without it the server returns <strong>401</strong>.</p></div>';
      return;
    }
    btn.disabled = true;
    st.textContent = '';
    out.innerHTML = '<div class="empty">Gathering data' + ($('aiDryRun').checked ? '…' : ' and calling the model…') + '</div>';
    try {
      var lk = getClientLlmKeyForBrief();
      var body = {
        dry_run: $('aiDryRun').checked,
        focus_platform: ($('aiFocusPlat').value || '').trim() || undefined,
        engineer_notes: ($('aiNotes').value || '').trim() || undefined,
        include_prior_learnings: $('aiIncludePrior').checked,
        persist_learning: !$('aiDryRun').checked && $('aiPersist').checked
      };
      if (lk) body.llm_api_key = lk;
      var r = await fetch(intelApi('/ai-brief'), {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify(body)
      });
      var raw = await r.text();
      var j;
      try {
        j = JSON.parse(raw);
      } catch (e1) {
        j = { ok: false, error: 'bad_json', detail: raw.slice(0, 400) };
      }
      st.textContent = r.status + ' ' + r.statusText;

      var parts = [];
      if (!j.ok && (r.status === 401 || j.error === 'unauthorized')) {
        parts.push(
          '<div class="alert err"><strong>401 — wrong or missing Bearer token</strong>' +
            '<p class="muted" style="margin:8px 0 0">The secret you entered at <strong>unlock</strong> must match the <em>exact</em> value of <code>PLAYSHARE_DIAG_INTEL_SECRET</code> or <code>PLAYSHARE_DIAG_UPLOAD_SECRET</code> from Railway Variables (copy-paste, no extra spaces). Use <strong>Change credentials</strong> to re-enter it. This is not your OpenAI API key.</p></div>'
        );
      } else if (!j.ok && (j.error === 'ai_not_configured' || j.error === 'ai_request_failed')) {
        var extra =
          j.error === 'ai_not_configured'
            ? getClientLlmKeyForBrief()
              ? '<p class="muted" style="margin:8px 0 0">A key was sent from this browser but the server still reported missing config. <strong>Redeploy</strong> the latest PlayShare server (needs <code>llm_api_key</code> body + header support). If you already deployed, check the server logs.</p>'
              : '<p class="muted" style="margin:8px 0 0">Use <strong>Change credentials</strong>, paste an OpenAI key at unlock, <em>or</em> set <code>PLAYSHARE_DIAG_AI_API_KEY</code> / <code>OPENAI_API_KEY</code> on Railway and leave the browser field empty.</p>'
            : '';
        parts.push(
          '<div class="alert warn"><strong>' +
            esc(j.error === 'ai_not_configured' ? 'LLM not configured' : 'LLM request failed') +
            '</strong><p class="muted" style="margin:8px 0 0">' +
            esc(j.hint || j.detail || '') +
            '</p>' +
            extra +
            '<p class="muted" style="margin:8px 0 0">You can still use the <strong>data pack</strong> below without an LLM.</p></div>'
        );
      } else if (!j.ok && !j.fallback_markdown) {
        parts.push(
          '<div class="alert err"><strong>' + esc(j.error || 'request_failed') + '</strong><p class="muted">' + esc(j.detail || '') + '</p></div>'
        );
      }

      if (j.fallback_markdown) {
        parts.push(
          '<h3 class="muted" style="margin:16px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Data pack (markdown)</h3>' +
            '<p class="muted" style="margin:0 0 8px;font-size:12px">Safe to paste into Cursor as context together with the Cursor message.</p>' +
            '<textarea id="aiFallbackTa" class="brief-ta" readonly></textarea>' +
            '<div class="row" style="margin-top:8px;align-items:center">' +
            '<button type="button" class="ghost" id="btnCopyFallback">Copy data pack</button>' +
            '<span id="copyFbHint" class="path"></span></div>'
        );
      }

      if (j.ok && j.assistant_markdown) {
        var cursorMsg = extractCursorBlock(j.assistant_markdown) || j.assistant_markdown;
        window.__playshareCursorBrief = cursorMsg;
        window.__playshareAiBriefFull = j.assistant_markdown;
        parts.unshift(
          '<h3 class="muted" style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">AI-written brief</h3>' +
            '<p class="muted" style="margin:0 0 8px;font-size:12px">Model: <code>' +
            esc(j.model || '') +
            '</code> · Use <strong>Copy Cursor message</strong> for the short paste; the section <code>COPY_PASTE_FOR_CURSOR_AI</code> in the text is the same.</p>' +
            '<textarea id="aiMainTa" class="brief-ta" readonly></textarea>' +
            '<div class="row" style="margin-top:8px;align-items:center;flex-wrap:wrap;gap:8px">' +
            '<button type="button" class="primary" id="btnCopyCursor">Copy Cursor message</button> ' +
            '<button type="button" class="ghost" id="btnCopyAiFull">Copy full AI brief</button>' +
            '<span id="copyAiHint" class="path"></span></div>'
        );
        var metaBits = [];
        if (j.prior_runs_in_prompt != null) {
          metaBits.push('Prior briefs included in this prompt: <strong>' + esc(String(j.prior_runs_in_prompt)) + '</strong>');
        }
        if (j.learning_id) {
          metaBits.push('Saved to knowledge table <code class="mono-sm">' + esc(j.learning_id) + '</code> — future runs will use it.');
        }
        if (j.learning_persist_error) {
          metaBits.push('<span style="color:#fbbf24">Brief not saved: ' + esc(j.learning_persist_error) + '</span>');
        }
        if (metaBits.length) {
          parts.unshift(
            '<div style="margin-bottom:12px;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface2);font-size:13px;line-height:1.5">' +
              metaBits.join('<br/>') +
              '</div>'
          );
        }
      } else if (j.ok && j.dry_run) {
        window.__playshareDryContext = j.context;
        var pr = j.prior_runs_in_prompt != null ? esc(String(j.prior_runs_in_prompt)) : '?';
        parts.unshift(
          '<div class="alert ok" style="background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.35);color:#a7f3d0;padding:12px 14px;border-radius:10px;margin-bottom:12px">' +
            '<strong>Dry run</strong> — no LLM. Prior briefs that would be injected: <strong>' +
            pr +
            '</strong>. JSON context: <strong>Download context.json</strong>.</div>' +
            '<div class="row" style="margin-bottom:12px"><button type="button" class="ghost" id="btnDlContext">Download context.json</button></div>'
        );
      }

      out.innerHTML = parts.join('');
      var fb = $('aiFallbackTa');
      if (fb && j.fallback_markdown) fb.value = j.fallback_markdown;
      var main = $('aiMainTa');
      if (main && j.assistant_markdown) main.value = j.assistant_markdown;

      var dl = $('btnDlContext');
      if (dl) {
        dl.onclick = function () {
          var ctx = window.__playshareDryContext;
          if (!ctx) return;
          var blob = new Blob([JSON.stringify(ctx, null, 2)], { type: 'application/json' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'playshare-diag-context.json';
          a.click();
          URL.revokeObjectURL(a.href);
        };
      }
      var cf = $('btnCopyFallback');
      if (cf) {
        cf.onclick = function () {
          var ta = $('aiFallbackTa');
          copyText(ta && ta.value, $('copyFbHint'));
        };
      }
      var cc = $('btnCopyCursor');
      if (cc) {
        cc.onclick = function () {
          copyText(window.__playshareCursorBrief, $('copyAiHint'));
        };
      }
      var caf = $('btnCopyAiFull');
      if (caf) {
        caf.onclick = function () {
          copyText(window.__playshareAiBriefFull, $('copyAiHint'));
        };
      }
    } catch (e2) {
      st.textContent = 'Error';
      out.innerHTML =
        '<div class="alert err">' + esc(e2 && e2.message ? e2.message : String(e2)) + '</div>';
    } finally {
      btn.disabled = false;
    }
  };

  $('btnCopy').onclick = function () {
    if (!lastText) return;
    var btn = $('btnCopy');
    navigator.clipboard.writeText(lastText).then(function () {
      var prev = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = prev; }, 1400);
    }).catch(function () { alert('Clipboard unavailable'); });
  };
  $('btnDl').onclick = function () {
    if (!lastText) return;
    var blob = new Blob([lastText], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'playshare-intel-' + (lastPath.replace(/[^a-z0-9]+/gi, '-').slice(0, 48) || 'response') + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  function renderKnowledgeTable(entries) {
    var box = $('aiKnowledgeList');
    if (!entries || !entries.length) {
      box.innerHTML = '<p class="muted">No rows in <code>diag_intel_knowledge</code> yet. Run a successful AI brief with save enabled, or add a manual note.</p>';
      return;
    }
    var h =
      '<div style="overflow:auto"><table class="data-table"><thead><tr><th>When</th><th>Source</th><th>Platform</th><th>Model</th><th>Cases</th><th></th></tr></thead><tbody>';
    entries.forEach(function (e) {
      h +=
        '<tr><td>' +
        fmtWhen(e.created_at) +
        '</td><td>' +
        esc(e.source || '') +
        '</td><td>' +
        esc(e.focus_platform || '—') +
        '</td><td class="mono-sm">' +
        esc(e.model || '—') +
        '</td><td>' +
        esc(e.case_window != null ? String(e.case_window) : '—') +
        '</td><td><button type="button" class="linkish" data-kview="' +
        esc(e.id) +
        '">Open</button></td></tr>';
    });
    h += '</tbody></table></div>';
    box.innerHTML = h;
  }

  async function refreshKnowledgeList() {
    var box = $('aiKnowledgeList');
    box.innerHTML = '<span class="muted">Loading…</span>';
    try {
      var r = await fetch(intelApi('/knowledge?limit=25'), { headers: authHeaders() });
      var j = await r.json();
      if (j.ok && j.entries) renderKnowledgeTable(j.entries);
      else box.innerHTML = '<p class="muted">Could not load list: ' + esc(j.error || String(r.status)) + '</p>';
    } catch (x) {
      box.innerHTML = '<p class="muted">Network error</p>';
    }
  }

  $('btnListKnowledge').onclick = function () {
    refreshKnowledgeList();
  };

  $('aiKnowledgeList').addEventListener('click', async function (e) {
    var b = e.target.closest('[data-kview]');
    if (!b) return;
    var id = b.getAttribute('data-kview');
    var ta = $('aiKnowledgeViewTa');
    ta.style.display = 'block';
    ta.value = 'Loading…';
    try {
      var r = await fetch(intelApi('/knowledge?id=' + encodeURIComponent(id)), { headers: authHeaders() });
      var j = await r.json();
      if (j.ok && j.entry) ta.value = j.entry.digest_markdown || '';
      else ta.value = 'Error: ' + (j.error || String(r.status));
    } catch (x) {
      ta.value = 'Network error';
    }
  });

  $('btnSaveManualMemory').onclick = async function () {
    var t = ($('aiManualMemory').value || '').trim();
    var st = $('aiManualStatus');
    if (t.length < 20) {
      st.textContent = 'Enter at least 20 characters';
      return;
    }
    st.textContent = 'Saving…';
    try {
      var r = await fetch(intelApi('/knowledge'), {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({
          digest_markdown: t,
          focus_platform: ($('aiFocusPlat').value || '').trim() || undefined
        })
      });
      var j = await r.json();
      if (j.ok && j.learning_id) {
        st.textContent = 'Saved';
        $('aiManualMemory').value = '';
        refreshKnowledgeList();
      } else st.textContent = j.detail || j.error || String(r.status);
    } catch (x) {
      st.textContent = 'Network error';
    }
  };

  $('aiDryRun').addEventListener('change', function () {
    $('aiPersist').disabled = $('aiDryRun').checked;
    if ($('aiDryRun').checked) $('aiPersist').checked = false;
  });
})();
  </script>
</body>
</html>`;
}

module.exports = { handleDiagIntel, getIntelSecret, explorerHtml };
