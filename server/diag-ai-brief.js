/**
 * AI-assisted briefs from diagnostic intelligence aggregates.
 * Uses OpenAI-compatible POST /v1/chat/completions when PLAYSHARE_DIAG_AI_API_KEY is set.
 */

const { buildRecommendationsFromCases } = require('./diag-intelligence');
const { fetchPriorLearningsForPrompt } = require('./diag-intel-knowledge');
const { EXTENSION_PRIMER_MARKDOWN, EXTENSION_PRIMER_VERSION } = require('./playshare-extension-primer');

const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_USER_JSON_CHARS = 72000;

function getDiagAiConfig() {
  const apiKey = String(process.env.PLAYSHARE_DIAG_AI_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const baseUrl = String(process.env.PLAYSHARE_DIAG_AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = String(process.env.PLAYSHARE_DIAG_AI_MODEL || DEFAULT_MODEL).trim();
  return { apiKey, baseUrl, model, configured: Boolean(apiKey) };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   caseLimit?: number,
 *   clusterLimit?: number,
 *   metricsSample?: number,
 *   focusPlatform?: string | null,
 *   includePriorLearnings?: boolean,
 *   priorLearningLimit?: number
 * }} [options]
 */
async function gatherBriefContext(supabase, options = {}) {
  const caseLimit = Math.min(80, Math.max(5, options.caseLimit || 45));
  const clusterLimit = Math.min(30, Math.max(3, options.clusterLimit || 18));
  const metricsSample = Math.min(350, Math.max(40, options.metricsSample || 160));
  const focusPlatform = options.focusPlatform ? String(options.focusPlatform).trim().slice(0, 64) : null;

  let caseQuery = supabase
    .from('diag_cases')
    .select(
      'report_id,uploaded_at,platform,handler_key,extension_version,case_summary_text,derived_tags,normalized_metrics'
    )
    .order('uploaded_at', { ascending: false })
    .limit(caseLimit);
  if (focusPlatform) caseQuery = caseQuery.eq('platform', focusPlatform);

  const { data: cases, error: e1 } = await caseQuery;
  if (e1) throw e1;

  let clusterQuery = supabase
    .from('diag_case_clusters')
    .select('cluster_signature,platform,handler_key,case_count,cluster_summary,pattern_tags,last_case_at')
    .order('last_case_at', { ascending: false, nullsFirst: false })
    .limit(clusterLimit);
  if (focusPlatform) clusterQuery = clusterQuery.eq('platform', focusPlatform);

  const { data: clusters, error: e2 } = await clusterQuery;
  if (e2) throw e2;

  let metricsQuery = supabase
    .from('diag_cases')
    .select('platform,normalized_metrics,derived_tags')
    .order('uploaded_at', { ascending: false })
    .limit(metricsSample);
  if (focusPlatform) metricsQuery = metricsQuery.eq('platform', focusPlatform);

  const { data: metricsRows, error: e3 } = await metricsQuery;
  if (e3) throw e3;

  const rec = buildRecommendationsFromCases(metricsRows || []);

  /** @type {Record<string, number>} */
  const extensionVersions = {};
  for (const c of cases || []) {
    const v = c.extension_version || 'unknown';
    extensionVersions[v] = (extensionVersions[v] || 0) + 1;
  }

  /** @type {Array<Record<string, unknown>>} */
  let prior_runs_from_database = [];
  const loadPrior = options.includePriorLearnings !== false;
  if (loadPrior) {
    prior_runs_from_database = await fetchPriorLearningsForPrompt(supabase, {
      limit: options.priorLearningLimit
    });
  }

  let prior_runs_note = '';
  if (!loadPrior) {
    prior_runs_note = 'Prior saved briefs were not loaded for this request (include_prior_learnings=false).';
  } else if (prior_runs_from_database.length > 0) {
    prior_runs_note =
      'Earlier AI/manual briefs from this database (newest first). Refine and extend; revise if new telemetry contradicts.';
  } else {
    prior_runs_note =
      'No prior saved briefs yet — after you persist this run, future prompts will include it and build cumulative context.';
  }

  return {
    generated_at: new Date().toISOString(),
    focus_platform: focusPlatform,
    recent_cases: (cases || []).map(slimCaseRow),
    top_clusters: clusters || [],
    rule_based_recommendations: rec.recommendations || [],
    rule_engine_evidence: rec.evidence,
    rule_engine_sample_size: rec.case_sample_size,
    extension_version_counts: extensionVersions,
    prior_runs_from_database,
    prior_runs_note,
    extension_primer_version: EXTENSION_PRIMER_VERSION,
    extension_architecture_primer_in_system_prompt: true
  };
}

/** @param {Record<string, unknown>} c */
function slimCaseRow(c) {
  return {
    report_id: c.report_id,
    uploaded_at: c.uploaded_at,
    platform: c.platform,
    handler_key: c.handler_key,
    extension_version: c.extension_version,
    summary: c.case_summary_text,
    tags: c.derived_tags,
    metrics: c.normalized_metrics && typeof c.normalized_metrics === 'object' ? c.normalized_metrics : {}
  };
}

/**
 * @param {Awaited<ReturnType<typeof gatherBriefContext>>} ctx
 */
function buildFallbackMarkdown(ctx) {
  const lines = [
    '# PlayShare diagnostic pack (no AI — paste into your coding assistant)',
    '',
    `_Generated ${ctx.generated_at}${ctx.focus_platform ? ` · platform filter: ${ctx.focus_platform}` : ''}_ · primer **v${EXTENSION_PRIMER_VERSION}**`,
    '',
    '## Extension architecture primer (same text the AI sees in its system prompt)',
    '',
    EXTENSION_PRIMER_MARKDOWN,
    '',
    '---',
    '',
    '## Rule-based recommendations (from server)',
    ''
  ];
  if (!ctx.rule_based_recommendations.length) {
    lines.push('_None in this sample._', '');
  } else {
    ctx.rule_based_recommendations.forEach((r, i) => {
      lines.push(`### ${i + 1}. (${r.confidence || 'n/a'})`, '', r.text || '', '');
      if (Array.isArray(r.evidence) && r.evidence.length) {
        lines.push('_Evidence:_ ' + r.evidence.join(' · '), '');
      }
    });
  }
  lines.push('## Recent case summaries (verbatim)', '');
  if (!ctx.recent_cases.length) {
    lines.push('_No cases matched filters._', '');
  } else {
    ctx.recent_cases.forEach((c, i) => {
      lines.push(`### Case ${i + 1}`, `- **When:** ${c.uploaded_at}`, `- **Platform:** ${c.platform}`, `- **Ext:** ${c.extension_version}`, `- **Tags:** ${Array.isArray(c.tags) ? c.tags.join(', ') : ''}`, `- **Summary:** ${c.summary}`, '');
    });
  }
  lines.push('## Top clusters', '');
  if (!ctx.top_clusters.length) {
    lines.push('_None._', '');
  } else {
    ctx.top_clusters.forEach((cl, i) => {
      lines.push(
        `### Cluster ${i + 1}`,
        `- **Cases:** ${cl.case_count} · **Platform:** ${cl.platform}`,
        `- **Signature:** \`${String(cl.cluster_signature || '').slice(0, 120)}\`${String(cl.cluster_signature || '').length > 120 ? '…' : ''}`,
        `- **Summary:** ${cl.cluster_summary || '—'}`,
        ''
      );
    });
  }
  lines.push('## Extension versions in recent-case window', '', '```json', JSON.stringify(ctx.extension_version_counts, null, 2), '```', '');
  lines.push(
    '---',
    'Ask your assistant to prioritize sync stability, ad-mode divergence, transport/WebSocket health, and site-specific handlers under `content/src/sites/`.'
  );
  return lines.join('\n');
}

const SYSTEM_PROMPT_TASK = `You are a senior engineer helping improve the PlayShare browser extension.

The **first block** of this system message (above the --- separator) is the **extension architecture primer** — treat it as ground truth for repo layout, purpose, and data flow. If telemetry suggests something that contradicts the primer, prefer the primer for *structure* and explain the conflict.

You receive ONLY privacy-safe aggregates: short case summaries, derived tags, normalized numeric metrics, cluster rollups, rule-based recommendations, and optionally **prior_runs_from_database** — excerpts from earlier successful analyses saved when engineers ran this tool. Those excerpts are cumulative memory from past diagnostic recordings (tests).

When prior_runs_from_database is non-empty:
- Treat it as institutional knowledge about the extension; **build on it** and call out what changed or what is newly confirmed.
- If fresh telemetry **contradicts** an earlier conclusion, say so explicitly and prefer the newer evidence.
- Merge themes across runs so the user gets a progressively deeper picture of the codebase over time.

Your job:
1. Read the data and infer themes (e.g. buffering vs sync rejects vs ad divergence vs Netflix safety path).
2. Propose concrete, actionable extension work: which subsystems to inspect (sync engine, ad detection, site adapters, service worker bridge, profiler).
3. Produce output the user can paste into Cursor or another coding AI.

Always respond in Markdown with exactly these top-level sections (headings must match):

## Executive summary
3–6 bullets on what the telemetry suggests overall.

## Themes and hypotheses
Numbered list; tie each to tags/metrics/clusters when possible.

## Suggested engineering tasks
Prioritized checklist (highest impact first). Mention likely file areas only when reasonably inferred (e.g. content/src/sites/netflix-sync.js, ad-detection, sync-decision paths).

## Risks and unknowns
What we cannot conclude from this data alone.

## COPY_PASTE_FOR_CURSOR_AI
One fenced code block (language tag: text) containing a SINGLE paragraph the user can paste as their next message to a coding assistant. It must:
- State that PlayShare diagnostic aggregates are attached above or in context
- Ask for specific code changes or investigations
- Stay under 1200 characters inside the block
- Be written in first person ("I need you to…")`;

const SYSTEM_PROMPT_FULL = `${EXTENSION_PRIMER_MARKDOWN}\n\n---\n\n${SYSTEM_PROMPT_TASK}`;

/**
 * @param {{ baseUrl: string, apiKey: string, model: string }} aiCfg
 * @param {Awaited<ReturnType<typeof gatherBriefContext>>} context
 * @param {string} [engineerNotes]
 */
async function generateAssistantBrief(aiCfg, context, engineerNotes) {
  let userJson = JSON.stringify(context, null, 2);
  if (userJson.length > MAX_USER_JSON_CHARS) {
    userJson = userJson.slice(0, MAX_USER_JSON_CHARS) + '\n…(truncated for model context)';
  }
  let user = `Aggregated PlayShare diagnostic intelligence (JSON). The extension architecture primer is already in your system instructions (primer version **${EXTENSION_PRIMER_VERSION}**). This JSON is telemetry + prior brief excerpts only — no PII.\n\n\`\`\`json\n${userJson}\n\`\`\`\n`;
  const notes = engineerNotes && String(engineerNotes).trim();
  if (notes) user += `\n**Engineer focus / questions:**\n${notes.slice(0, 4000)}\n`;

  const r = await fetch(`${aiCfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${aiCfg.apiKey}`
    },
    body: JSON.stringify({
      model: aiCfg.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT_FULL },
        { role: 'user', content: user }
      ],
      temperature: 0.35,
      max_tokens: 3500
    })
  });

  const raw = await r.text();
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    j = null;
  }
  if (!r.ok) {
    const msg = j && j.error && j.error.message ? j.error.message : raw.slice(0, 600);
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!content || typeof content !== 'string') {
    const err = new Error('ai_empty_response');
    err.status = 502;
    throw err;
  }
  return content.trim();
}

module.exports = {
  getDiagAiConfig,
  gatherBriefContext,
  buildFallbackMarkdown,
  generateAssistantBrief,
  DEFAULT_MODEL,
  EXTENSION_PRIMER_VERSION
};
