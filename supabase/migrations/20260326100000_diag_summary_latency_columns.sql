-- Truthful latency naming: transport RTT vs peer-reported apply latency (see extension timing vs analytics.latencyMsPeerReported).

alter table public.diag_reports_summary
  add column if not exists avg_transport_rtt_ms integer;

alter table public.diag_reports_summary
  add column if not exists max_peer_apply_latency_ms integer;

comment on column public.diag_reports_summary.avg_rtt_ms is
  'Legacy alias: same as avg_transport_rtt_ms (last sampled WS transport RTT). Prefer avg_transport_rtt_ms.';

comment on column public.diag_reports_summary.max_rtt_ms is
  'Deprecated: historically peer apply latency under a misleading name. Prefer max_peer_apply_latency_ms; new rows set this to null.';
