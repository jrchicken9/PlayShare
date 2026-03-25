-- Async IntelPro jobs so diagnostic analysis can run out-of-band.

create table if not exists public.diag_ai_brief_jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  last_heartbeat_at timestamptz,
  status text not null default 'queued',
  trigger_source text not null default 'explorer',
  focus_platform text,
  engineer_notes text,
  include_prior_learnings boolean not null default true,
  persist_learning boolean not null default true,
  auto_triggered boolean not null default false,
  source_report_id uuid references public.diag_reports_raw (id) on delete set null,
  attempt_count integer not null default 0,
  worker_id text,
  model text,
  error_code text,
  error_detail text,
  request_options_json jsonb not null default '{}'::jsonb,
  context_json jsonb,
  fallback_markdown text,
  assistant_markdown text,
  prior_runs_in_prompt integer,
  learning_id uuid references public.diag_intel_knowledge (id) on delete set null,
  constraint diag_ai_brief_jobs_status_chk check (
    status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')
  )
);

create index if not exists diag_ai_brief_jobs_status_created_idx
  on public.diag_ai_brief_jobs (status, created_at desc);

create index if not exists diag_ai_brief_jobs_created_idx
  on public.diag_ai_brief_jobs (created_at desc);

create index if not exists diag_ai_brief_jobs_source_report_idx
  on public.diag_ai_brief_jobs (source_report_id);

comment on table public.diag_ai_brief_jobs is
  'Queued and completed IntelPro jobs for always-on diagnostic analysis.';

grant select, insert, update, delete on table public.diag_ai_brief_jobs to service_role;
