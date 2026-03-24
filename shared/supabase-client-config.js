/**
 * Single source for the Supabase project used by PlayShare (auth in popup + optional background use).
 *
 * Railway / Node (same project):
 *   SUPABASE_URL         = same URL as below (Settings → API → Project URL)
 *   SUPABASE_SERVICE_ROLE_KEY = service_role secret (server only — never ship in the extension)
 *
 * Diagnostics (/diag/upload, /diag/intel/*) insert via the PlayShare server using the service role.
 * The anon key below is public and only for client auth; it cannot replace the service role for ingest.
 */
(function (g) {
  'use strict';
  g.PLAYSUP_SHARE_SUPABASE_URL = 'https://bgeghnykqzocajepbjsx.supabase.co';
  g.PLAYSUP_SHARE_SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJnZWdobnlrcXpvY2FqZXBianN4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4Mjg1ODUsImV4cCI6MjA4OTQwNDU4NX0.PZQy5eaquwiNAqY5TIw3q6alEeGvLWYkYMD1sgct_9g';
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
