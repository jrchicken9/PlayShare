#!/usr/bin/env node

const { getSupabaseAdmin } = require('../server/diag-upload');
const { runCliWorker } = require('../server/diag-ai-worker');

runCliWorker(getSupabaseAdmin).catch((err) => {
  console.error('[PlayShare/diag-ai-worker] fatal', err && err.stack ? err.stack : err);
  process.exit(1);
});
