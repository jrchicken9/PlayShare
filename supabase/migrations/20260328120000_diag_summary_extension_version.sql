-- Store extension (client) version on summary rows for intel queries without joining diag_cases.

alter table public.diag_reports_summary
  add column if not exists extension_version text;

create index if not exists diag_reports_summary_extension_version_idx
  on public.diag_reports_summary (extension_version);

comment on column public.diag_reports_summary.extension_version is
  'Chrome extension manifest version at upload time (same as diag_cases.extension_version).';
