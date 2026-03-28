/**
 * Persistent "memory" for IntelPro reports — prior runs are reinjected into new prompts.
 */

const DEFAULT_LEARNING_LIMIT = 14;
const DEFAULT_PER_ENTRY_MAX_CHARS = 3800;
const DEFAULT_MAX_INJECT_TOTAL_CHARS = 32000;
const DEFAULT_FEEDBACK_LIMIT = 18;
const FEEDBACK_NOTE_MAX_CHARS = 480;

/** @deprecated use getPerEntryMaxChars() for env-aware cap */
const PER_ENTRY_MAX_CHARS = DEFAULT_PER_ENTRY_MAX_CHARS;

function getPriorLearningPromptMode() {
  return String(process.env.PLAYSHARE_DIAG_PRIOR_LEARNING_PROMPT_MODE || 'full')
    .trim()
    .toLowerCase();
}

function getPerEntryMaxChars() {
  const n = parseInt(process.env.PLAYSHARE_DIAG_PRIOR_LEARNING_PER_ENTRY_MAX_CHARS || '', 10);
  if (Number.isFinite(n) && n >= 200) return Math.min(20000, n);
  return DEFAULT_PER_ENTRY_MAX_CHARS;
}

function getMaxInjectTotalChars() {
  const n = parseInt(process.env.PLAYSHARE_DIAG_PRIOR_LEARNING_MAX_INJECT_CHARS || '', 10);
  if (Number.isFinite(n) && n >= 500) return Math.min(100000, n);
  return DEFAULT_MAX_INJECT_TOTAL_CHARS;
}

function getFallbackHeadChars() {
  const n = parseInt(process.env.PLAYSHARE_DIAG_PRIOR_LEARNING_FALLBACK_MAX_CHARS || '', 10);
  if (Number.isFinite(n) && n >= 200) return Math.min(8000, n);
  return 1200;
}

/**
 * @param {string[]} lines
 * @param {RegExp} headingLineRegex — anchored line match, e.g. /^##\s+Executive summary\s*$/i
 */
function sliceSingleMarkdownSection(lines, headingLineRegex) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingLineRegex.test(lines[i].trim())) {
      start = i;
      break;
    }
  }
  if (start < 0) return '';
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (i > start && /^##\s+/.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * Narrow stored IntelPro markdown before putting it in the model context (no extra LLM call).
 * Modes: full | exec_summary | exec_summary_themes (via PLAYSHARE_DIAG_PRIOR_LEARNING_PROMPT_MODE).
 * @param {string} fullMd
 * @param {string} [modeOverride]
 */
function narrowPriorLearningMarkdownForPrompt(fullMd, modeOverride) {
  const md = String(fullMd || '').trim();
  if (!md) return '';
  const mode = (modeOverride || getPriorLearningPromptMode()).toLowerCase();
  if (mode === 'full' || mode === '') return md;

  const lines = md.split(/\r?\n/);
  const exec = sliceSingleMarkdownSection(lines, /^##\s+executive\s+summary\s*$/i);
  if (!exec) {
    const cap = getFallbackHeadChars();
    return md.length <= cap ? md : `${md.slice(0, cap)}\n…(truncated — no "## Executive summary" section in saved digest)`;
  }
  if (mode === 'exec_summary' || mode === 'compact') return exec;

  if (mode === 'exec_summary_themes') {
    const themes = sliceSingleMarkdownSection(lines, /^##\s+themes\b/i);
    return themes ? `${exec}\n\n${themes}` : exec;
  }

  return exec;
}

/**
 * Recent human labels on cases/clusters — ground IntelPro in known triage outcomes.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ limit?: number }} [options]
 */
async function fetchEngineerFeedbackForPrompt(supabase, options = {}) {
  const limit = Math.min(40, Math.max(0, options.limit != null ? options.limit : DEFAULT_FEEDBACK_LIMIT));
  if (limit === 0) return [];
  const { data, error } = await supabase
    .from('diag_case_feedback')
    .select('created_at,label,engineer_note,cluster_signature,report_id')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (const row of data || []) {
    const note = row.engineer_note != null ? String(row.engineer_note).trim() : '';
    out.push({
      recorded_at: row.created_at,
      label: row.label,
      engineer_note: note
        ? note.length > FEEDBACK_NOTE_MAX_CHARS
          ? note.slice(0, FEEDBACK_NOTE_MAX_CHARS) + '…'
          : note
        : null,
      cluster_signature: row.cluster_signature || null,
      report_id: row.report_id || null
    });
  }
  return out;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ limit?: number }} [options]
 */
async function fetchPriorLearningsForPrompt(supabase, options = {}) {
  const limit = Math.min(30, Math.max(1, options.limit || DEFAULT_LEARNING_LIMIT));
  const { data, error } = await supabase
    .from('diag_intel_knowledge')
    .select(
      'id,created_at,source,model,focus_platform,extension_versions,case_window,digest_markdown,data_snapshot_at'
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  const perEntryMax = getPerEntryMaxChars();
  const maxInject = getMaxInjectTotalChars();
  const promptMode = getPriorLearningPromptMode();

  /** @type {Array<Record<string, unknown>>} */
  const prior_runs_from_database = [];
  let total = 0;
  for (const row of data || []) {
    const md = String(row.digest_markdown || '');
    let excerpt = narrowPriorLearningMarkdownForPrompt(md, promptMode);
    if (excerpt.length > perEntryMax) {
      excerpt = excerpt.slice(0, perEntryMax) + '\n…(truncated for prompt size)';
    }
    if (total + excerpt.length > maxInject) break;
    prior_runs_from_database.push({
      saved_at: row.created_at,
      source: row.source,
      model: row.model,
      focus_platform: row.focus_platform,
      extension_versions_snapshot: row.extension_versions,
      cases_in_window_when_saved: row.case_window,
      data_snapshot_at: row.data_snapshot_at,
      digest_excerpt: excerpt
    });
    total += excerpt.length;
  }
  return prior_runs_from_database;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   source?: string,
 *   model?: string | null,
 *   focus_platform?: string | null,
 *   extension_versions?: string[],
 *   case_window?: number | null,
 *   digest_markdown: string,
 *   data_snapshot_at?: string | null
 * }} payload
 */
async function saveBriefAsLearning(supabase, payload) {
  const digest = String(payload.digest_markdown || '').slice(0, 120000);
  if (digest.length < 20) {
    const err = new Error('digest_too_short');
    err.code = 'digest_too_short';
    throw err;
  }
  const { data, error } = await supabase
    .from('diag_intel_knowledge')
    .insert({
      source: String(payload.source || 'ai_brief').slice(0, 64),
      model: payload.model != null ? String(payload.model).slice(0, 128) : null,
      focus_platform: payload.focus_platform ? String(payload.focus_platform).slice(0, 64) : null,
      extension_versions: Array.isArray(payload.extension_versions) ? payload.extension_versions.map((x) => String(x).slice(0, 32)).slice(0, 40) : [],
      case_window: typeof payload.case_window === 'number' && Number.isFinite(payload.case_window) ? payload.case_window : null,
      digest_markdown: digest,
      data_snapshot_at: payload.data_snapshot_at || null
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} limit
 * @param {number} offset
 */
async function listKnowledge(supabase, limit, offset) {
  const lim = Math.min(80, Math.max(1, limit));
  const off = Math.min(100000, Math.max(0, offset));
  const end = off + lim - 1;
  const { data, error } = await supabase
    .from('diag_intel_knowledge')
    .select('id,created_at,source,model,focus_platform,extension_versions,case_window,data_snapshot_at')
    .order('created_at', { ascending: false })
    .range(off, end);
  if (error) throw error;
  return data || [];
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} id
 */
async function getKnowledgeOne(supabase, id) {
  const { data, error } = await supabase
    .from('diag_intel_knowledge')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

module.exports = {
  fetchPriorLearningsForPrompt,
  fetchEngineerFeedbackForPrompt,
  saveBriefAsLearning,
  listKnowledge,
  getKnowledgeOne,
  narrowPriorLearningMarkdownForPrompt,
  DEFAULT_LEARNING_LIMIT,
  DEFAULT_FEEDBACK_LIMIT,
  PER_ENTRY_MAX_CHARS
};
