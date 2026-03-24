-- PlayShare /diag/upload uses SUPABASE_SERVICE_ROLE_KEY (JWT role service_role).
-- If you see "permission denied for table diag_reports_raw", either the wrong key is on Railway
-- (anon vs service_role) or these grants were never applied.

grant usage on schema public to service_role;

grant select, insert, update, delete on table public.diag_reports_raw to service_role;
grant select, insert, update, delete on table public.diag_reports_summary to service_role;
grant select, insert, update, delete on table public.diag_cases to service_role;
grant select, insert, update, delete on table public.diag_case_clusters to service_role;
grant select, insert, update, delete on table public.diag_case_feedback to service_role;
