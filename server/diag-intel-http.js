/**
 * Internal HTTP API + lightweight HTML explorer for diagnostic intelligence.
 * Auth: Bearer PLAYSHARE_DIAG_INTEL_SECRET or PLAYSHARE_DIAG_UPLOAD_SECRET (if set).
 */

const { URL } = require('url');
const { getSupabaseAdmin } = require('./diag-upload');
const { explainCase, buildRecommendationsFromCases, regressionCompare } = require('./diag-intelligence');

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

function getIntelSecret() {
  return String(process.env.PLAYSHARE_DIAG_INTEL_SECRET || process.env.PLAYSHARE_DIAG_UPLOAD_SECRET || '').trim();
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function unauthorized(res) {
  json(res, 401, { ok: false, error: 'unauthorized' });
}

function checkAuth(req) {
  const secret = getIntelSecret();
  if (!secret) return null;
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return token === secret;
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
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
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
      hint: 'Set PLAYSHARE_DIAG_INTEL_SECRET or PLAYSHARE_DIAG_UPLOAD_SECRET'
    });
    return;
  }
  if (!authed) {
    unauthorized(res);
    return;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    json(res, 503, { ok: false, error: 'supabase_not_configured' });
    return;
  }

  try {
    if (path === '/diag/intel' || path === '/diag/intel/health') {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      json(res, 200, { ok: true, service: 'playshare_diag_intel', note: 'Use /diag/intel/cases, /diag/intel/explorer' });
      return;
    }

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
      const limit = Math.min(40, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
      const pattern = `%${q}%`;
      const { data, error } = await supabase
        .from('diag_cases')
        .select(
          'report_id,uploaded_at,extension_version,platform,handler_key,case_summary_text,cluster_signature,derived_tags'
        )
        .ilike('case_summary_text', pattern)
        .order('uploaded_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      json(res, 200, { ok: true, query: q, cases: data || [] });
      return;
    }

    if (path === '/diag/intel/cases') {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '40', 10)));
      const platform = url.searchParams.get('platform');
      const tag = url.searchParams.get('tag');
      const cluster = url.searchParams.get('cluster');
      let q = supabase
        .from('diag_cases')
        .select(
          'report_id,uploaded_at,extension_version,server_version,platform,handler_key,role,case_summary_text,cluster_signature,derived_tags'
        )
        .order('uploaded_at', { ascending: false })
        .limit(limit);
      if (platform) q = q.eq('platform', platform);
      if (cluster) q = q.eq('cluster_signature', cluster);
      if (tag) q = q.contains('derived_tags', [tag]);
      const { data, error } = await q;
      if (error) throw error;
      json(res, 200, { ok: true, cases: data || [] });
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
      const limit = Math.min(80, Math.max(1, parseInt(url.searchParams.get('limit') || '40', 10)));
      const { data, error } = await supabase
        .from('diag_case_clusters')
        .select('*')
        .order('last_case_at', { ascending: false, nullsFirst: false })
        .limit(limit);
      if (error) throw error;
      json(res, 200, { ok: true, clusters: data || [] });
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
  <title>PlayShare diagnostic intelligence</title>
  <style>
    :root { font-family: system-ui, sans-serif; background:#0c0e12; color:#e8edf4; }
    body { max-width:960px; margin:24px auto; padding:0 16px; }
    h1 { font-size:1.25rem; }
    textarea, input { width:100%; max-width:520px; background:#161a22; color:#e8edf4; border:1px solid #2a3140; border-radius:8px; padding:8px; }
    button { background:#2563eb; color:#fff; border:none; border-radius:8px; padding:8px 14px; cursor:pointer; margin:4px 4px 4px 0; }
    button.secondary { background:#334155; }
    pre { background:#11151c; padding:12px; border-radius:8px; overflow:auto; font-size:12px; max-height:420px; }
    .muted { color:#8b95a8; font-size:13px; }
    ul { padding-left:18px; }
    li { margin:6px 0; }
  </style>
</head>
<body>
  <h1>PlayShare diagnostic intelligence</h1>
  <p class="muted">Paste the same Bearer token as <code>PLAYSHARE_DIAG_INTEL_SECRET</code> or <code>PLAYSHARE_DIAG_UPLOAD_SECRET</code>. Nothing is sent except to this server.</p>
  <p><input type="password" id="tok" placeholder="Bearer token" autocomplete="off" /></p>
  <p>
    <button onclick="loadCases()">Recent cases</button>
    <button onclick="loadClusters()" class="secondary">Clusters</button>
    <button onclick="loadRecs()" class="secondary">Recommendations</button>
  </p>
  <p>
    <input id="sq" placeholder="Keyword search on case summaries" />
    <button onclick="loadSearch()" class="secondary">Search</button>
  </p>
  <p class="muted">Regression (extension versions, exact match):</p>
  <p>
    <input id="bv" placeholder="baseline extension version e.g. 1.0.0" />
    <input id="tv" placeholder="target extension version e.g. 1.0.1" />
    <input id="pf" placeholder="platform filter (optional)" />
    <button onclick="loadReg()" class="secondary">Compare</button>
  </p>
  <pre id="out">{}</pre>
  <script>
    function authHeaders() {
      const t = document.getElementById('tok').value.trim();
      return t ? { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
    }
    async function jget(path) {
      const r = await fetch(path, { headers: authHeaders() });
      const j = await r.json();
      document.getElementById('out').textContent = JSON.stringify(j, null, 2);
    }
    function loadCases() { jget('/diag/intel/cases?limit=25'); }
    function loadClusters() { jget('/diag/intel/clusters?limit=25'); }
    function loadRecs() { jget('/diag/intel/recommendations?sample=150'); }
    function loadReg() {
      const bv = encodeURIComponent(document.getElementById('bv').value.trim());
      const tv = encodeURIComponent(document.getElementById('tv').value.trim());
      const pf = document.getElementById('pf').value.trim();
      if (!bv || !tv) { alert('baseline + target versions required'); return; }
      let u = '/diag/intel/regression?baseline_ver=' + bv + '&target_ver=' + tv;
      if (pf) u += '&platform=' + encodeURIComponent(pf);
      jget(u);
    }
    function loadSearch() {
      const raw = document.getElementById('sq').value.trim();
      if (raw.length < 2) { alert('Enter at least 2 characters'); return; }
      jget('/diag/intel/search?q=' + encodeURIComponent(raw) + '&limit=25');
    }
  </script>
</body>
</html>`;
}

module.exports = { handleDiagIntel, getIntelSecret, explorerHtml };
