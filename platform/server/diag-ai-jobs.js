const DEFAULT_JOB_LIMIT = 20;
const RUNNING_STALE_MS = Math.max(
  60 * 1000,
  parseInt(process.env.PLAYSHARE_DIAG_AI_JOB_STALE_MS || '900000', 10) || 900000
);

function scrubText(v, maxLen = 1000) {
  return v == null ? '' : String(v).trim().slice(0, maxLen);
}

function normalizeAiBriefRequest(body = {}) {
  const dryRun = Boolean(body.dry_run);
  const focusRaw = body.focus_platform != null ? String(body.focus_platform).trim().slice(0, 64) : '';
  const focusPlatform = focusRaw || null;
  const engineerNotes = body.engineer_notes != null ? String(body.engineer_notes).slice(0, 8000) : '';
  const caseLimit = body.case_limit != null ? parseInt(body.case_limit, 10) : undefined;
  const clusterLimit = body.cluster_limit != null ? parseInt(body.cluster_limit, 10) : undefined;
  const metricsSample = body.metrics_sample != null ? parseInt(body.metrics_sample, 10) : undefined;
  const includePriorLearnings = body.include_prior_learnings !== false;
  const includeEngineerFeedback = body.include_engineer_feedback !== false;
  const persistLearning = body.persist_learning !== false;
  const priorLearningLimit = body.prior_learning_limit != null ? parseInt(body.prior_learning_limit, 10) : undefined;
  const engineerFeedbackLimit =
    body.engineer_feedback_limit != null ? parseInt(body.engineer_feedback_limit, 10) : undefined;
  const bodyLlmKey = body.llm_api_key != null ? String(body.llm_api_key).trim().slice(0, 512) : '';
  return {
    dryRun,
    focusPlatform,
    engineerNotes,
    caseLimit: Number.isFinite(caseLimit) ? caseLimit : undefined,
    clusterLimit: Number.isFinite(clusterLimit) ? clusterLimit : undefined,
    metricsSample: Number.isFinite(metricsSample) ? metricsSample : undefined,
    includePriorLearnings,
    includeEngineerFeedback,
    persistLearning,
    priorLearningLimit: Number.isFinite(priorLearningLimit) ? priorLearningLimit : undefined,
    engineerFeedbackLimit: Number.isFinite(engineerFeedbackLimit) ? engineerFeedbackLimit : undefined,
    bodyLlmKey
  };
}

function queueRequestOptions(normalized) {
  return {
    focus_platform: normalized.focusPlatform,
    engineer_notes: normalized.engineerNotes || null,
    include_prior_learnings: normalized.includePriorLearnings,
    include_engineer_feedback: normalized.includeEngineerFeedback,
    persist_learning: normalized.persistLearning,
    case_limit: normalized.caseLimit != null ? normalized.caseLimit : null,
    cluster_limit: normalized.clusterLimit != null ? normalized.clusterLimit : null,
    metrics_sample: normalized.metricsSample != null ? normalized.metricsSample : null,
    prior_learning_limit: normalized.priorLearningLimit != null ? normalized.priorLearningLimit : null,
    engineer_feedback_limit:
      normalized.engineerFeedbackLimit != null ? normalized.engineerFeedbackLimit : null
  };
}

function serializeContext(context) {
  return context && typeof context === 'object' ? JSON.parse(JSON.stringify(context)) : null;
}

function jobSummaryRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    last_heartbeat_at: row.last_heartbeat_at,
    status: row.status,
    trigger_source: row.trigger_source,
    focus_platform: row.focus_platform,
    auto_triggered: Boolean(row.auto_triggered),
    source_report_id: row.source_report_id,
    attempt_count: row.attempt_count,
    worker_id: row.worker_id,
    model: row.model,
    error_code: row.error_code,
    error_detail: row.error_detail,
    prior_runs_in_prompt: row.prior_runs_in_prompt,
    learning_id: row.learning_id
  };
}

function jobDetailRow(row) {
  if (!row) return null;
  return {
    ...jobSummaryRow(row),
    request_options_json: row.request_options_json || {},
    fallback_markdown: row.fallback_markdown || null,
    assistant_markdown: row.assistant_markdown || null
  };
}

async function createAiBriefJob(supabase, payload) {
  const insertPayload = {
    trigger_source: scrubText(payload.trigger_source || 'explorer', 64) || 'explorer',
    focus_platform: payload.focus_platform ? scrubText(payload.focus_platform, 64) : null,
    engineer_notes: payload.engineer_notes ? String(payload.engineer_notes).slice(0, 8000) : null,
    include_prior_learnings: payload.include_prior_learnings !== false,
    persist_learning: payload.persist_learning !== false,
    auto_triggered: Boolean(payload.auto_triggered),
    source_report_id: payload.source_report_id || null,
    request_options_json: payload.request_options_json || {},
    context_json: serializeContext(payload.context_json),
    fallback_markdown: payload.fallback_markdown ? String(payload.fallback_markdown).slice(0, 160000) : null,
    prior_runs_in_prompt:
      typeof payload.prior_runs_in_prompt === 'number' && Number.isFinite(payload.prior_runs_in_prompt)
        ? payload.prior_runs_in_prompt
        : null,
    updated_at: new Date().toISOString()
  };
  const { data, error } = await supabase
    .from('diag_ai_brief_jobs')
    .insert(insertPayload)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function getAiBriefJob(supabase, id) {
  const { data, error } = await supabase
    .from('diag_ai_brief_jobs')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function listAiBriefJobs(supabase, options = {}) {
  const limit = Math.min(80, Math.max(1, options.limit || DEFAULT_JOB_LIMIT));
  const off = Math.min(100000, Math.max(0, options.offset || 0));
  let q = supabase
    .from('diag_ai_brief_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .range(off, off + limit - 1);
  if (options.status) q = q.eq('status', scrubText(options.status, 32));
  if (options.focusPlatform) q = q.eq('focus_platform', scrubText(options.focusPlatform, 64));
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function cancelAiBriefJob(supabase, id) {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('diag_ai_brief_jobs')
    .update({ status: 'cancelled', updated_at: nowIso, finished_at: nowIso })
    .eq('id', id)
    .in('status', ['queued', 'running'])
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data;
}

function postgrestOrFilterStaleRunning(staleBeforeIso) {
  const v = String(staleBeforeIso || '').replace(/"/g, '\\"');
  return `status.eq.queued,and(status.eq.running,or(last_heartbeat_at.is.null,last_heartbeat_at.lt."${v}"))`;
}

async function claimNextAiBriefJob(supabase, workerId) {
  const staleBefore = new Date(Date.now() - RUNNING_STALE_MS).toISOString();
  const { data, error } = await supabase
    .from('diag_ai_brief_jobs')
    .select('*')
    .or(postgrestOrFilterStaleRunning(staleBefore))
    .order('created_at', { ascending: true })
    .limit(6);
  if (error) throw error;
  for (const row of data || []) {
    const nowIso = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .from('diag_ai_brief_jobs')
      .update({
        status: 'running',
        updated_at: nowIso,
        started_at: row.started_at || nowIso,
        last_heartbeat_at: nowIso,
        worker_id: scrubText(workerId, 128) || null,
        attempt_count: (row.attempt_count || 0) + 1
      })
      .eq('id', row.id)
      .eq('status', row.status)
      .select('*')
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (claimed) return claimed;
  }
  return null;
}

async function heartbeatAiBriefJob(supabase, id, workerId) {
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from('diag_ai_brief_jobs')
    .update({
      updated_at: nowIso,
      last_heartbeat_at: nowIso,
      worker_id: scrubText(workerId, 128) || null
    })
    .eq('id', id)
    .eq('status', 'running');
  if (error) throw error;
}

async function markAiBriefJobSucceeded(supabase, id, payload) {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('diag_ai_brief_jobs')
    .update({
      status: 'succeeded',
      updated_at: nowIso,
      finished_at: nowIso,
      last_heartbeat_at: nowIso,
      assistant_markdown: String(payload.assistant_markdown || '').slice(0, 160000),
      fallback_markdown: payload.fallback_markdown ? String(payload.fallback_markdown).slice(0, 160000) : null,
      model: payload.model ? scrubText(payload.model, 128) : null,
      learning_id: payload.learning_id || null,
      prior_runs_in_prompt:
        typeof payload.prior_runs_in_prompt === 'number' && Number.isFinite(payload.prior_runs_in_prompt)
          ? payload.prior_runs_in_prompt
          : null,
      error_code: null,
      error_detail: null
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function markAiBriefJobFailed(supabase, id, payload) {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('diag_ai_brief_jobs')
    .update({
      status: 'failed',
      updated_at: nowIso,
      finished_at: nowIso,
      last_heartbeat_at: nowIso,
      error_code: scrubText(payload.error_code || 'job_failed', 64),
      error_detail: payload.error_detail ? String(payload.error_detail).slice(0, 4000) : null,
      fallback_markdown: payload.fallback_markdown ? String(payload.fallback_markdown).slice(0, 160000) : null,
      model: payload.model ? scrubText(payload.model, 128) : null
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

module.exports = {
  normalizeAiBriefRequest,
  queueRequestOptions,
  serializeContext,
  jobSummaryRow,
  jobDetailRow,
  createAiBriefJob,
  getAiBriefJob,
  listAiBriefJobs,
  cancelAiBriefJob,
  claimNextAiBriefJob,
  heartbeatAiBriefJob,
  markAiBriefJobSucceeded,
  markAiBriefJobFailed
};
