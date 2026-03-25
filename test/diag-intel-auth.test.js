/**
 * Diagnostic intel auth helpers.
 * Run: node test/diag-intel-auth.test.js
 */

const assert = require('assert');
const { checkAuth, extractDiagIntelTokens } = require('../server/diag-intel-http');

function envSnapshot() {
  return {
    PLAYSHARE_DIAG_INTEL_SECRET: process.env.PLAYSHARE_DIAG_INTEL_SECRET,
    PLAYSHARE_DIAG_UPLOAD_SECRET: process.env.PLAYSHARE_DIAG_UPLOAD_SECRET
  };
}

function restoreEnv(snap) {
  for (const k of Object.keys(snap)) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function req(headers = {}) {
  return { headers };
}

async function run() {
  const snap = envSnapshot();
  try {
    process.env.PLAYSHARE_DIAG_INTEL_SECRET = 'intel-secret';
    process.env.PLAYSHARE_DIAG_UPLOAD_SECRET = 'upload-secret';

    assert.deepStrictEqual(
      extractDiagIntelTokens(
        req({ authorization: 'Bearer wrong-secret', 'x-playshare-diag-intel-secret': 'intel-secret' }),
        { diag_intel_secret: 'upload-secret' }
      ),
      ['wrong-secret', 'intel-secret', 'upload-secret'],
      'collects all token candidates from headers and body'
    );

    assert.strictEqual(
      checkAuth(req({ authorization: 'Bearer wrong-secret' }), { diag_intel_secret: 'upload-secret' }),
      true,
      'body fallback authorizes even when Authorization is wrong'
    );

    assert.strictEqual(
      checkAuth(req({}), { diag_intel_secret: 'Bearer intel-secret' }),
      true,
      'body fallback normalizes accidental Bearer prefixes'
    );

    assert.strictEqual(
      checkAuth(req({ authorization: 'Bearer nope' }), { diag_intel_secret: 'still-nope' }),
      false,
      'request stays unauthorized when no candidate matches'
    );

    console.log('diag-intel-auth.test.js: all passed');
  } finally {
    restoreEnv(snap);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
