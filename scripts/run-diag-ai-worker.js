#!/usr/bin/env node

const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (_) {
  /* same pattern as server.js */
}

const { getSupabaseAdmin } = require('../server/diag-upload');
const { runCliWorker } = require('../server/diag-ai-worker');

runCliWorker(getSupabaseAdmin).catch((err) => {
  console.error('[PlayShare/diag-ai-worker] fatal', err && err.stack ? err.stack : err);
  process.exit(1);
});
