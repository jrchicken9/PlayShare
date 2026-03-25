const crypto = require('crypto');

const {
  gatherBriefContext,
  buildFallbackMarkdown,
  generateAssistantBrief,
  getServerDiagAiConfig
} = require('./diag-ai-brief');
const { saveBriefAsLearning } = require('./diag-intel-knowledge');
const {
  claimNextAiBriefJob,
  heartbeatAiBriefJob,
  markAiBriefJobSucceeded,
  markAiBriefJobFailed
} = require('./diag-ai-jobs');

const POLL_MS = Math.max(1500, parseInt(process.env.PLAYSHARE_DIAG_AI_WORKER_POLL_MS || '4000', 10) || 4000);
const IDLE_POLL_MS = Math.max(POLL_MS, parseInt(process.env.PLAYSHARE_DIAG_AI_WORKER_IDLE_POLL_MS || '8000', 10) || 8000);
const HEARTBEAT_MS = Math.max(4000, parseInt(process.env.PLAYSHARE_DIAG_AI_WORKER_HEARTBEAT_MS || '10000', 10) || 10000);

function workerIdentity() {
  return `diag-ai-worker-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jobOptions(row) {
  const opts = row && row.request_options_json && typeof row.request_options_json === 'object'
    ? row.request_options_json
    : {};
  return {
    focusPlatform: opts.focus_platform ? String(opts.focus_platform).slice(0, 64) : row.focus_platform || null,
    engineerNotes: opts.engineer_notes ? String(opts.engineer_notes).slice(0, 8000) : row.engineer_notes || '',
    includePriorLearnings: opts.include_prior_learnings !== false,
    persistLearning: opts.persist_learning !== false,
    caseLimit: Number.isFinite(opts.case_limit) ? opts.case_limit : undefined,
    clusterLimit: Number.isFinite(opts.cluster_limit) ? opts.cluster_limit : undefined,
    metricsSample: Number.isFinite(opts.metrics_sample) ? opts.metrics_sample : undefined,
    priorLearningLimit: Number.isFinite(opts.prior_learning_limit) ? opts.prior_learning_limit : undefined
  };
}

async function processAiBriefJob(supabase, row, workerId) {
  const cfg = getServerDiagAiConfig();
  if (!cfg.configured) {
    await markAiBriefJobFailed(supabase, row.id, {
      error_code: 'ai_not_configured',
      error_detail:
        'IntelPro requires PLAYSHARE_DIAG_AI_API_KEY (or OPENAI_API_KEY) on the server/worker.',
      fallback_markdown: row.fallback_markdown || null,
      model: cfg.model || null
    });
    return { ok: false, status: 'failed', reason: 'ai_not_configured' };
  }

  const options = jobOptions(row);
  let heartbeatTimer = null;
  const bumpHeartbeat = async () => {
    await heartbeatAiBriefJob(supabase, row.id, workerId);
  };
  try {
    heartbeatTimer = setInterval(() => {
      void bumpHeartbeat().catch((err) => {
        console.warn('[PlayShare/diag-ai-worker] heartbeat failed', row.id, err && err.message);
      });
    }, HEARTBEAT_MS);

    const context =
      row.context_json && typeof row.context_json === 'object'
        ? row.context_json
        : await gatherBriefContext(supabase, {
            focusPlatform: options.focusPlatform,
            caseLimit: options.caseLimit,
            clusterLimit: options.clusterLimit,
            metricsSample: options.metricsSample,
            includePriorLearnings: options.includePriorLearnings,
            priorLearningLimit: options.priorLearningLimit
          });
    const fallbackMarkdown = row.fallback_markdown || buildFallbackMarkdown(context);
    const assistantMarkdown = await generateAssistantBrief(cfg, context, options.engineerNotes);

    /** @type {string|null} */
    let learningId = null;
    if (options.persistLearning) {
      learningId = await saveBriefAsLearning(supabase, {
        source: row.auto_triggered ? 'ai_brief_auto' : 'ai_brief',
        model: cfg.model,
        focus_platform: options.focusPlatform,
        extension_versions: Object.keys((context && context.extension_version_counts) || {}),
        case_window: Array.isArray(context && context.recent_cases) ? context.recent_cases.length : null,
        digest_markdown: assistantMarkdown,
        data_snapshot_at: context && context.generated_at ? context.generated_at : null
      });
    }

    await markAiBriefJobSucceeded(supabase, row.id, {
      assistant_markdown: assistantMarkdown,
      fallback_markdown: fallbackMarkdown,
      model: cfg.model,
      learning_id: learningId,
      prior_runs_in_prompt: Array.isArray(context && context.prior_runs_from_database)
        ? context.prior_runs_from_database.length
        : 0
    });
    return { ok: true, status: 'succeeded', learningId };
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    const code = err && err.code ? err.code : err && err.status ? `http_${err.status}` : 'ai_request_failed';
    await markAiBriefJobFailed(supabase, row.id, {
      error_code: code,
      error_detail: detail,
      fallback_markdown: row.fallback_markdown || null,
      model: cfg.model || null
    });
    return { ok: false, status: 'failed', reason: code };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

async function runDiagAiWorkerOnce(supabase, workerId) {
  const row = await claimNextAiBriefJob(supabase, workerId);
  if (!row) return { claimed: false };
  const result = await processAiBriefJob(supabase, row, workerId);
  return { claimed: true, jobId: row.id, ...result };
}

function startDiagAiWorkerLoop(supabase, options = {}) {
  const workerId = options.workerId || workerIdentity();
  let stopped = false;
  let active = false;

  const tick = async () => {
    if (stopped || active) return;
    active = true;
    try {
      const result = await runDiagAiWorkerOnce(supabase, workerId);
      const delay = result.claimed ? POLL_MS : IDLE_POLL_MS;
      if (!stopped) setTimeout(tick, delay);
    } catch (err) {
      console.error('[PlayShare/diag-ai-worker] tick failed', err);
      if (!stopped) setTimeout(tick, IDLE_POLL_MS);
    } finally {
      active = false;
    }
  };

  setTimeout(tick, 50);
  return {
    workerId,
    stop() {
      stopped = true;
    }
  };
}

async function runCliWorker(getSupabase) {
  const supabase = getSupabase();
  if (!supabase) {
    throw new Error('Supabase is not configured for diag AI worker.');
  }
  const loop = startDiagAiWorkerLoop(supabase);
  console.log('[PlayShare/diag-ai-worker] started', loop.workerId);
  const shutdown = () => {
    loop.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  while (true) {
    await sleep(60000);
  }
}

module.exports = {
  processAiBriefJob,
  runDiagAiWorkerOnce,
  startDiagAiWorkerLoop,
  runCliWorker
};
