/**
 * Internal HTTP API + lightweight HTML explorer for diagnostic intelligence.
 * Auth: Bearer and/or X-PlayShare-Diag-Intel-Secret must match PLAYSHARE_DIAG_INTEL_SECRET and/or PLAYSHARE_DIAG_UPLOAD_SECRET (either value accepted if both are set).
 */

const fs = require('fs');
const pathMod = require('path');
const { URL } = require('url');
const { getSupabaseAdmin } = require('./diag-upload');
const { explainCase, buildRecommendationsFromCases, regressionCompare } = require('./diag-intelligence');
const { getDiagAiConfig, gatherBriefContext, buildFallbackMarkdown, generateAssistantBrief } = require('./diag-ai-brief');
const { EXTENSION_PRIMER_MARKDOWN } = require('./playshare-extension-primer');
const { saveBriefAsLearning, listKnowledge, getKnowledgeOne } = require('./diag-intel-knowledge');

let explorerClientJsCache = null;
/** Client bundle for /diag/intel/explorer — external file so CSP script-src 'self' works (no unsafe-inline). */
function explorerClientJs() {
  if (explorerClientJsCache == null) {
    explorerClientJsCache = fs.readFileSync(pathMod.join(__dirname, 'diag-intel-explorer-client.js'), 'utf8');
  }
  return explorerClientJsCache;
}

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

/** JSON for auth-related responses — must not be cached by intermediaries. */
function jsonAuth(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0'
  });
  res.end(JSON.stringify(obj));
}

function unauthorized(res) {
  jsonAuth(res, 401, {
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

/** JSON POST fallback when an intermediary mangles auth headers after unlock. */
function bodyDiagIntelToken(body) {
  if (!body || typeof body !== 'object') return '';
  const raw =
    body.diag_intel_secret != null
      ? body.diag_intel_secret
      : body.diag_bearer != null
        ? body.diag_bearer
        : body.diag_token;
  return parseBearerToken(raw);
}

/**
 * Collect all auth candidates instead of trusting only one header, so a proxy-
 * injected/malformed Authorization value does not block the custom header or
 * JSON-body fallback from succeeding.
 * @param {import('http').IncomingMessage} req
 * @param {Record<string, unknown> | null | undefined} [body]
 */
function extractDiagIntelTokens(req, body) {
  const out = [];
  const pushUnique = (token) => {
    if (!token || out.includes(token)) return;
    out.push(token);
  };
  pushUnique(parseBearerToken(req.headers.authorization));
  pushUnique(scrubDiagSecret(headerOne(req, 'x-playshare-diag-intel-secret')));
  pushUnique(bodyDiagIntelToken(body));
  return out;
}

function checkAuth(req, body) {
  const accepted = getDiagIntelAcceptedSecrets();
  if (accepted.length === 0) return null;
  const tokens = extractDiagIntelTokens(req, body);
  if (!tokens.length) return false;
  return accepted.some((secret) => tokens.includes(secret));
}

/**
 * Discard the rest of the request body. Safe when the stream may already be finished
 * (avoids hanging on req.on('end') if 'end' fired before the listener was attached).
 */
async function drainRequestBody(req) {
  try {
    for await (const _chunk of req) {
      /* discard */
    }
  } catch (_e) {
    /* ignore */
  }
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

function routeSupportsBodyAuth(path) {
  return path === '/diag/intel/ai-brief' || path === '/diag/intel/knowledge' || path === '/diag/intel/feedback';
}

function routeJsonBodyMaxBytes(path) {
  if (path === '/diag/intel/knowledge') return 131072;
  return 65536;
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
    const explorerBase = path.replace(/\/explorer$/i, '') || '/diag/intel';
    const clientJsUrl = explorerBase + '/explorer-client.js';
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache'
    });
    res.end(explorerHtml(clientJsUrl));
    return;
  }

  if (req.method === 'GET' && path.endsWith('/explorer-client.js') && path.indexOf('/diag/intel/') >= 0) {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache'
    });
    res.end(explorerClientJs());
    return;
  }

  /** @type {Record<string, unknown> | null} */
  let parsedBody = null;
  let authed = checkAuth(req);
  if (!authed && req.method === 'POST' && routeSupportsBodyAuth(path)) {
    try {
      parsedBody = await readJsonBody(req, routeJsonBodyMaxBytes(path));
    } catch {
      json(res, 400, { ok: false, error: 'invalid_json' });
      return;
    }
    authed = checkAuth(req, parsedBody);
  }
  if (authed === null) {
    jsonAuth(res, 503, {
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
      await drainRequestBody(req);
    }
    jsonAuth(res, 200, {
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
        const body = parsedBody || (await readJsonBody(req, 131072));
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
      const body = parsedBody || (await readJsonBody(req, 65536));
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
      const body = parsedBody || (await readJsonBody(req));
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

function explorerHtml(clientJsSrc = '/diag/intel/explorer-client.js') {
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
      align-items: flex-start;
      justify-content: center;
      padding: 32px 18px 48px;
      background:
        radial-gradient(ellipse 85% 55% at 50% -25%, rgba(56, 189, 248, 0.16), transparent),
        var(--bg);
    }
    .gate-screen[hidden] {
      display: none !important;
    }
    #playshareExplorerApp[hidden] {
      display: none !important;
    }
    .gate-shell {
      width: 100%;
      max-width: 520px;
    }
    .gate-header {
      margin-bottom: 22px;
      text-align: center;
    }
    .gate-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--accent);
      background: var(--accent-dim);
      border: 1px solid rgba(56, 189, 248, 0.28);
      padding: 5px 11px;
      border-radius: 999px;
      margin-bottom: 14px;
    }
    .gate-header h1 {
      margin: 0 0 10px;
      font-size: clamp(1.38rem, 4.2vw, 1.68rem);
      font-weight: 700;
      letter-spacing: -0.03em;
      line-height: 1.12;
    }
    .gate-tagline {
      margin: 0 auto;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.55;
      max-width: 40ch;
    }
    .gate-card {
      width: 100%;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 24px 22px 22px;
      box-shadow: 0 20px 55px rgba(0, 0, 0, 0.38);
    }
    .gate-status-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px 12px;
      margin-bottom: 18px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .gate-pill {
      font-size: 12px;
      font-weight: 700;
      padding: 6px 12px;
      border-radius: 999px;
      font-variant-numeric: tabular-nums;
    }
    .gate-pill--idle {
      background: #1e2430;
      color: var(--muted);
    }
    .gate-pill--checking {
      background: rgba(56, 189, 248, 0.16);
      color: var(--accent);
      animation: gate-pill-pulse 1.15s ease-in-out infinite;
    }
    .gate-pill--err {
      background: rgba(248, 113, 113, 0.16);
      color: var(--err);
    }
    @keyframes gate-pill-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.72; }
    }
    .gate-hostpath {
      font-size: 11px;
      font-family: ui-monospace, monospace;
      color: var(--muted);
      word-break: break-all;
      flex: 1;
      min-width: 0;
      line-height: 1.4;
    }
    .gate-help,
    .gate-optional-block,
    .gate-boot-wrap {
      margin-bottom: 14px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface2);
      overflow: hidden;
    }
    .gate-help summary,
    .gate-optional-block summary,
    .gate-boot-wrap summary {
      cursor: pointer;
      padding: 11px 14px;
      font-size: 13px;
      font-weight: 600;
      color: var(--muted);
      user-select: none;
      list-style: none;
    }
    .gate-help summary::-webkit-details-marker,
    .gate-optional-block summary::-webkit-details-marker,
    .gate-boot-wrap summary::-webkit-details-marker {
      display: none;
    }
    .gate-help-body {
      padding: 12px 14px 14px;
      font-size: 13px;
      color: var(--muted);
      line-height: 1.55;
      border-top: 1px solid var(--border);
    }
    .gate-help-body code {
      font-size: 11px;
      color: #cbd5e1;
    }
    .gate-optional-inner {
      padding: 4px 14px 14px;
      border-top: 1px solid var(--border);
    }
    .gate-optional-inner .lbl {
      margin-top: 10px;
    }
    .gate-card > .lbl {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: #94a3b8;
      margin-bottom: 8px;
    }
    #gateSecretMeta {
      font-size: 11px;
      color: var(--muted);
      margin: 0 0 14px;
      line-height: 1.45;
    }
    #gateErr {
      margin-top: 14px;
      margin-bottom: 0;
    }
    #gateErr[role='alert'] {
      outline: none;
    }
    input.gate-input-err {
      border-color: #f87171 !important;
      box-shadow: 0 0 0 1px rgba(248, 113, 113, 0.35);
    }
    .gate-primary {
      margin-top: 6px;
      width: 100%;
      padding: 14px 16px;
      font-size: 15px;
      font-weight: 700;
      border: none;
      border-radius: 12px;
      background: linear-gradient(165deg, #5ecfff 0%, #0ea5e9 55%, #0284c7 100%);
      color: #041c28;
      cursor: pointer;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    .gate-primary:hover {
      filter: brightness(1.06);
    }
    .gate-primary:disabled {
      opacity: 0.55;
      cursor: not-allowed;
      filter: none;
    }
    #gateWorking {
      margin-top: 14px !important;
      padding: 11px 13px !important;
      border-radius: 10px !important;
      background: var(--surface2) !important;
      border: 1px solid var(--border) !important;
      color: var(--text) !important;
      font-size: 13px !important;
    }
    .gate-diag {
      margin-top: 14px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface2);
      overflow: hidden;
    }
    .gate-diag summary {
      padding: 11px 14px;
      cursor: pointer;
      color: var(--muted);
      font-weight: 600;
      font-size: 12px;
      user-select: none;
    }
    .gate-diag-pre {
      margin: 0;
      padding: 12px 14px;
      max-height: min(32vh, 240px);
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, monospace;
      font-size: 11px;
      line-height: 1.55;
      color: #cbd5e1;
      border: 0;
      border-top: 1px solid var(--border);
      background: #05070a;
    }
    #gateInitFail {
      display: none;
      margin: 0 0 16px;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid rgba(248, 113, 113, 0.55);
      background: rgba(248, 113, 113, 0.12);
      color: #fecaca;
      font-size: 13px;
      line-height: 1.45;
    }
    #gateBootStatus {
      margin: 0;
      padding: 12px 14px;
      font-family: ui-monospace, monospace;
      font-size: 10px;
      line-height: 1.5;
      color: #94a3b8;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 140px;
      overflow-y: auto;
      border-top: 1px solid var(--border);
    }
    .gate-privacy-note {
      margin: 16px 0 0;
      font-size: 11px;
      color: var(--muted);
      line-height: 1.45;
      text-align: center;
    }
  </style>
</head>
<body>
  <div id="gateRoot" class="gate-screen">
    <div class="gate-shell">
      <header class="gate-header">
        <span class="gate-badge">PlayShare · developers</span>
        <h1>Diagnostic intelligence</h1>
        <p class="gate-tagline">Sign in with your server secret. Nothing is pre-filled here; your browser only sends it when you unlock.</p>
      </header>
      <div class="gate-card">
        <div id="gateInitFail" role="alert"></div>
        <div class="gate-status-row">
          <span id="gateStatusPill" class="gate-pill gate-pill--idle">Ready</span>
          <span id="gateHostPath" class="gate-hostpath" title="API base for this tab"></span>
        </div>

        <details class="gate-help">
          <summary>Where is the secret? · How unlock works</summary>
          <div class="gate-help-body">
            <p style="margin: 0">
              <strong>Railway:</strong> open your service → <strong>Variables</strong> → copy the <em>value</em> of <code>PLAYSHARE_DIAG_INTEL_SECRET</code>
              (or your upload secret). Paste <strong>only the value</strong>—no variable name, no quotes, no <code>Bearer</code> prefix.
            </p>
            <p style="margin: 12px 0 0">
              <strong>Network:</strong> Unlock calls <code>GET /diag/intel/auth-check</code> with <code>Authorization</code> and
              <code>X-PlayShare-Diag-Intel-Secret</code> (POST also supported) so proxies that mishandle bodies still work.
            </p>
            <p style="margin: 12px 0 0">
              <strong>OpenAI:</strong> optional; expand below. Leave blank if this host already has an LLM key in env.
            </p>
          </div>
        </details>

        <label class="lbl" for="gateBearer">Server secret</label>
        <input
          type="password"
          id="gateBearer"
          name="diag_intel_secret"
          autocomplete="off"
          spellcheck="false"
          placeholder="Full value from Railway Variables"
          aria-describedby="gateErr gateSecretMeta"
        />
        <p id="gateSecretMeta">Paste above — length is checked locally before any request runs.</p>

        <details class="gate-optional-block">
          <summary>Optional: OpenAI API key (AI tab)</summary>
          <div class="gate-optional-inner">
            <label class="lbl" for="gateOpenAi">OpenAI key</label>
            <input
              type="password"
              id="gateOpenAi"
              autocomplete="off"
              spellcheck="false"
              placeholder="sk-… or leave empty for server env"
              aria-describedby="gateErr"
            />
            <p id="gateServerLlmHint" class="muted" style="display: none; margin-top: 10px; font-size: 12px; line-height: 1.45">
              This host reports an LLM key in its environment — you may leave this field empty for the AI tab.
            </p>
          </div>
        </details>

        <div id="gateErr" class="alert err" style="display: none" tabindex="-1"></div>
        <button type="button" id="gateSubmit" class="gate-primary">Unlock dashboard</button>
        <p id="gateWorking" class="muted" style="display: none; margin-top: 12px; font-size: 13px; line-height: 1.45" aria-live="polite"></p>

        <details class="gate-diag" id="gateDiag">
          <summary>Authentication log · lengths &amp; HTTP only (no secret values)</summary>
          <pre id="gateDiagBody" class="gate-diag-pre"></pre>
        </details>

        <details class="gate-boot-wrap">
          <summary>Technical connection log</summary>
          <div id="gateBootStatus" aria-live="polite"></div>
        </details>

        <p class="gate-privacy-note">Secrets stay in this tab until you close or refresh. They are not written to sessionStorage.</p>
      </div>
    </div>
  </div>

  <div id="playshareExplorerApp" hidden>
  <div class="wrap">
    <header class="topbar">
      <h1>Diagnostic intelligence</h1>
      <p>Review anonymized sync diagnostics: recent uploads, repeating patterns (clusters), and version comparisons. You already entered access on the unlock screen — no second password is required unless you choose <strong>Change credentials</strong>.</p>
      <p class="ver">Explorer UI · redeploy the server if unlock or tabs look outdated (<code>diag-intel-http.js</code>).</p>
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

    <footer>PlayShare · <code>/diag/intel/*</code> · unlock <code>GET /diag/intel/auth-check</code> · health <code>/diag/intel/health</code></footer>
  </div>
  </div>
  <script defer src="${clientJsSrc}"></script>
  <noscript>
    <div style="max-width:520px;margin:24px auto;padding:16px;background:rgba(248,113,113,0.12);border:1px solid rgba(248,113,113,0.5);border-radius:12px;color:#fecaca;font-size:14px;line-height:1.45">
      <strong>JavaScript is off or blocked.</strong> Unlock requires JS. Allow scripts from this origin (bundle URL <code>${clientJsSrc}</code>).
    </div>
  </noscript>
</body>
</html>`;
}

module.exports = {
  handleDiagIntel,
  getIntelSecret,
  explorerHtml,
  getDiagIntelAcceptedSecrets,
  extractDiagIntelTokens,
  checkAuth
};
