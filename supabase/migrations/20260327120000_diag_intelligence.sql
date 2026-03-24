-- Diagnostic intelligence: cases, cluster rollups, engineering feedback (privacy-safe aggregates only).

create table if not exists public.diag_case_clusters (
  cluster_signature text primary key,
  platform text,
  handler_key text,
  pattern_tags text[] not null default '{}',
  case_count integer not null default 0,
  cluster_summary text,
  representative_report_ids uuid[] not null default '{}',
  first_case_at timestamptz,
  last_case_at timestamptz
);

create table if not exists public.diag_cases (
  report_id uuid primary key references public.diag_reports_raw (id) on delete cascade,
  uploaded_at timestamptz not null,
  extension_version text,
  server_version text,
  schema_version text,
  platform text,
  handler_key text,
  role text,
  test_run_id text,
  device_id_hash text,
  room_id_hash text,
  case_summary_text text not null,
  cluster_signature text not null,
  derived_tags text[] not null default '{}',
  normalized_metrics jsonb not null default '{}',
  config_snapshot jsonb,
  intel_schema_version text not null default '1'
);

create table if not exists public.diag_case_feedback (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references public.diag_reports_raw (id) on delete cascade,
  cluster_signature text references public.diag_case_clusters (cluster_signature) on delete set null,
  label text not null,
  engineer_note text,
  created_at timestamptz not null default now(),
  constraint diag_case_feedback_target_chk check (report_id is not null or cluster_signature is not null),
  constraint diag_case_feedback_label_chk check (
    label in (
      'confirmed_root_cause',
      'false_positive',
      'expected_behavior',
      'network_issue',
      'player_issue',
      'extension_bug',
      'threshold_tuning_needed',
      'platform_specific_quirk',
      'other'
    )
  )
);

create index if not exists diag_cases_uploaded_at_idx on public.diag_cases (uploaded_at desc);
create index if not exists diag_cases_platform_uploaded_idx on public.diag_cases (platform, uploaded_at desc);
create index if not exists diag_cases_cluster_sig_idx on public.diag_cases (cluster_signature);
create index if not exists diag_cases_extension_version_idx on public.diag_cases (extension_version);
create index if not exists diag_cases_derived_tags_gin on public.diag_cases using gin (derived_tags);
create index if not exists diag_case_feedback_report_idx on public.diag_case_feedback (report_id);
create index if not exists diag_case_feedback_cluster_idx on public.diag_case_feedback (cluster_signature);

comment on table public.diag_cases is
  'One learning case per uploaded diagnostic; searchable summary + metrics only (no raw payload).';
comment on table public.diag_case_clusters is
  'Rule-based cluster rollup keyed by cluster_signature; counts updated on ingest.';
comment on table public.diag_case_feedback is
  'Engineering labels for continuous improvement of recommendations.';
