-- Cumulative AI / engineer digests built from diagnostic recordings (diag_cases).
-- Fed back into future IntelPro reports so analysis deepens over time.

create table if not exists public.diag_intel_knowledge (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null default 'ai_brief',
  model text,
  focus_platform text,
  extension_versions text[] not null default '{}',
  case_window integer,
  digest_markdown text not null,
  data_snapshot_at timestamptz
);

create index if not exists diag_intel_knowledge_created_at_idx on public.diag_intel_knowledge (created_at desc);

comment on table public.diag_intel_knowledge is
  'Append-only IntelPro reports and manual notes; prior rows are included in new /diag/intel/ai-brief prompts.';

grant select, insert, update, delete on table public.diag_intel_knowledge to service_role;
