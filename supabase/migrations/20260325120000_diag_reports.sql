-- PlayShare diagnostic learning pipeline (service role inserts from Railway /diag/upload).
-- Run in Supabase SQL editor or via supabase db push.

create table if not exists public.diag_reports_raw (
  id uuid primary key,
  uploaded_at timestamptz not null default now(),
  extension_version text,
  platform text,
  schema_version text,
  report_kind text,
  payload_json jsonb not null
);

create table if not exists public.diag_reports_summary (
  report_id uuid primary key references public.diag_reports_raw (id) on delete cascade,
  test_run_id text,
  device_id_hash text,
  room_id_hash text,
  role text,
  platform text,
  member_count integer,
  recording_duration_ms bigint,
  avg_rtt_ms integer,
  max_rtt_ms integer,
  ws_disconnect_count integer,
  sync_apply_success_rate double precision,
  drift_avg_sec double precision,
  drift_max_sec double precision,
  hard_correction_count integer,
  soft_drift_count integer,
  ad_mode_enter_count integer,
  laggard_anchor_count integer,
  buffering_count integer,
  stalled_count integer,
  source_swap_count integer,
  cooldown_reject_count integer,
  converging_reject_count integer,
  reconnect_settle_reject_count integer,
  netflix_safety_reject_count integer,
  derived_tags text[] not null default '{}'
);

create index if not exists diag_reports_raw_uploaded_at_idx on public.diag_reports_raw (uploaded_at desc);
create index if not exists diag_reports_summary_platform_idx on public.diag_reports_summary (platform);
create index if not exists diag_reports_summary_test_run_idx on public.diag_reports_summary (test_run_id);

comment on table public.diag_reports_raw is 'Opt-in anonymized PlayShare diagnostic JSON exports.';
comment on table public.diag_reports_summary is 'Normalized metrics + derived_tags for analytics dashboards.';
