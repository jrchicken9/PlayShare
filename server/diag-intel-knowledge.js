/**
 * Persistent "memory" for diagnostic AI briefs — prior runs are reinjected into new prompts.
 */

const DEFAULT_LEARNING_LIMIT = 14;
const PER_ENTRY_MAX_CHARS = 3800;
const MAX_INJECT_TOTAL_CHARS = 32000;

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

  /** @type {Array<Record<string, unknown>>} */
  const prior_runs_from_database = [];
  let total = 0;
  for (const row of data || []) {
    const md = String(row.digest_markdown || '');
    let excerpt = md;
    if (excerpt.length > PER_ENTRY_MAX_CHARS) {
      excerpt = excerpt.slice(0, PER_ENTRY_MAX_CHARS) + '\n…(truncated for prompt size)';
    }
    if (total + excerpt.length > MAX_INJECT_TOTAL_CHARS) break;
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
  saveBriefAsLearning,
  listKnowledge,
  getKnowledgeOne,
  DEFAULT_LEARNING_LIMIT,
  PER_ENTRY_MAX_CHARS
};
