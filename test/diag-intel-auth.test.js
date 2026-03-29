/**
 * Diagnostic auth/session helpers.
 * Run: node test/diag-intel-auth.test.js
 */

const assert = require('assert');
const {
  extractDiagIntelTokens,
  authenticateIntelRequest,
  issueIntelSessionFromSecret,
  enforceSessionCsrf,
  createScopedUploadToken,
  authenticateUploadRequest
} = require('../platform/server/diag-auth');

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

function req(headers = {}, method = 'GET') {
  return {
    method,
    headers: Object.assign({ host: 'playshare.test', origin: 'https://playshare.test' }, headers),
    socket: { encrypted: true }
  };
}

function res() {
  const headers = new Map();
  return {
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
    }
  };
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
      authenticateIntelRequest(req({ authorization: 'Bearer wrong-secret' }), { diag_intel_secret: 'upload-secret' }).ok,
      true,
      'legacy secret auth still works from POST bodies during rollout'
    );

    const unlockReq = req({}, 'POST');
    const unlockRes = res();
    const issued = issueIntelSessionFromSecret(unlockReq, unlockRes, 'Bearer intel-secret');
    assert.strictEqual(issued.ok, true, 'unlock exchanges a raw secret for a server session');
    const setCookie = unlockRes.getHeader('set-cookie');
    assert.ok(setCookie, 'unlock sets a session cookie');
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const cookiePair = String(cookieHeader).split(';')[0];
    const authedSession = authenticateIntelRequest(req({ cookie: cookiePair }));
    assert.strictEqual(authedSession.ok, true, 'subsequent requests authenticate with the session cookie');
    assert.strictEqual(authedSession.via, 'session', 'session auth is preferred once established');
    assert.ok(authedSession.session && authedSession.session.csrfToken, 'session auth exposes CSRF token server-side');

    const csrfReq = req(
      {
        cookie: cookiePair,
        'x-playshare-csrf': authedSession.session.csrfToken,
        origin: 'https://playshare.test'
      },
      'POST'
    );
    assert.strictEqual(enforceSessionCsrf(csrfReq, authedSession, {}).ok, true, 'matching CSRF header passes');
    assert.strictEqual(
      enforceSessionCsrf(req({ cookie: cookiePair }, 'POST'), authedSession, {}).ok,
      false,
      'missing CSRF header is rejected for session-backed POSTs'
    );

    const scoped = createScopedUploadToken('session', authedSession.session.id);
    assert.ok(scoped.token.startsWith('psu_'), 'scoped upload tokens have a recognizable prefix');
    assert.strictEqual(
      authenticateUploadRequest(req({ authorization: 'Bearer ' + scoped.token }), {}).ok,
      true,
      'issued upload tokens authorize /diag/upload'
    );

    assert.strictEqual(
      authenticateUploadRequest(req({ authorization: 'Bearer upload-secret' }), {}).via,
      'legacy_secret',
      'legacy upload secret remains valid during rollout'
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
