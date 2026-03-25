const crypto = require('crypto');

const SESSION_COOKIE_NAME = 'playshare_diag_intel_session';
const INTEL_SESSION_TTL_MS = Math.max(
  5 * 60 * 1000,
  parseInt(process.env.PLAYSHARE_DIAG_SESSION_TTL_MS || '43200000', 10) || 43200000
);
const UPLOAD_TOKEN_TTL_MS = Math.max(
  60 * 1000,
  parseInt(process.env.PLAYSHARE_DIAG_UPLOAD_TOKEN_TTL_MS || '2592000000', 10) || 2592000000
);

/** @type {Map<string, { id: string, csrfToken: string, createdAt: string, expiresAtMs: number }>} */
const intelSessions = new Map();
/** @type {Map<string, { token: string, createdAt: string, expiresAtMs: number, via: string, sessionId: string | null }>} */
const uploadTokens = new Map();

/** Trim, strip UTF-8 BOM, NBSP, and CR (common when copying from Railway / Windows / .env). */
function scrubDiagSecret(s) {
  let t = String(s || '').trim();
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1).trim();
  t = t.replace(/\u00a0/g, '').replace(/\r/g, '').trim();
  return t;
}

function parseBearerToken(authHeader) {
  let t = String(authHeader || '').trim();
  if (t.toLowerCase().startsWith('bearer ')) t = t.slice(7).trim();
  if (t.toLowerCase().startsWith('bearer ')) t = t.slice(7).trim();
  return scrubDiagSecret(t);
}

/** Single header value (Node may join duplicates with ", "). */
function headerOne(req, lowerName) {
  const v = req && req.headers ? req.headers[lowerName] : null;
  if (v == null || v === '') return '';
  const s = Array.isArray(v) ? v.join(',') : String(v);
  return s.trim();
}

function requestProto(req) {
  const proto = headerOne(req, 'x-forwarded-proto').split(',')[0].trim().toLowerCase();
  if (proto === 'https' || proto === 'http') return proto;
  return req && req.socket && req.socket.encrypted ? 'https' : 'http';
}

function requestHost(req) {
  return headerOne(req, 'x-forwarded-host') || headerOne(req, 'host');
}

function requestOrigin(req) {
  const host = requestHost(req);
  if (!host) return '';
  return `${requestProto(req)}://${host}`;
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function purgeExpiredRecords(map) {
  const now = Date.now();
  for (const [key, value] of map.entries()) {
    if (!value || typeof value.expiresAtMs !== 'number' || value.expiresAtMs <= now) {
      map.delete(key);
    }
  }
}

function getDiagIntelAcceptedSecrets() {
  const intel = scrubDiagSecret(process.env.PLAYSHARE_DIAG_INTEL_SECRET);
  const upload = scrubDiagSecret(process.env.PLAYSHARE_DIAG_UPLOAD_SECRET);
  const out = [];
  if (intel) out.push(intel);
  if (upload && upload !== intel) out.push(upload);
  return out;
}

function getIntelSecret() {
  const accepted = getDiagIntelAcceptedSecrets();
  return accepted[0] || '';
}

function getAcceptedUploadSecrets() {
  const upload = scrubDiagSecret(process.env.PLAYSHARE_DIAG_UPLOAD_SECRET);
  const intel = scrubDiagSecret(process.env.PLAYSHARE_DIAG_INTEL_SECRET);
  const out = [];
  if (upload) out.push(upload);
  if (intel && intel !== upload) out.push(intel);
  return out;
}

function parseCookies(req) {
  const raw = headerOne(req, 'cookie');
  /** @type {Record<string, string>} */
  const out = {};
  if (!raw) return out;
  raw.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) return;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  });
  return out;
}

function buildCookieString(req, name, value, opts = {}) {
  const attrs = [`${name}=${encodeURIComponent(value)}`];
  attrs.push(`Path=${opts.path || '/'}`);
  attrs.push('HttpOnly');
  attrs.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.maxAgeMs != null) attrs.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAgeMs / 1000))}`);
  if (requestProto(req) === 'https') attrs.push('Secure');
  return attrs.join('; ');
}

function setCookie(res, cookieValue) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) {
    res.setHeader('Set-Cookie', cookieValue);
    return;
  }
  const arr = Array.isArray(prev) ? prev.slice() : [String(prev)];
  arr.push(cookieValue);
  res.setHeader('Set-Cookie', arr);
}

function createIntelSession() {
  purgeExpiredRecords(intelSessions);
  const id = randomToken(32);
  const record = {
    id,
    csrfToken: randomToken(18),
    createdAt: new Date().toISOString(),
    expiresAtMs: Date.now() + INTEL_SESSION_TTL_MS
  };
  intelSessions.set(id, record);
  return record;
}

function getIntelSession(req) {
  purgeExpiredRecords(intelSessions);
  const cookies = parseCookies(req);
  const id = scrubDiagSecret(cookies[SESSION_COOKIE_NAME] || '');
  if (!id) return null;
  const record = intelSessions.get(id);
  if (!record) return null;
  if (record.expiresAtMs <= Date.now()) {
    intelSessions.delete(id);
    return null;
  }
  record.expiresAtMs = Date.now() + INTEL_SESSION_TTL_MS;
  intelSessions.set(id, record);
  return record;
}

function attachIntelSessionCookie(req, res, session) {
  setCookie(
    res,
    buildCookieString(req, SESSION_COOKIE_NAME, session.id, {
      path: '/diag/intel',
      maxAgeMs: INTEL_SESSION_TTL_MS,
      sameSite: 'Lax'
    })
  );
}

function clearIntelSession(req, res) {
  const cookies = parseCookies(req);
  const id = scrubDiagSecret(cookies[SESSION_COOKIE_NAME] || '');
  if (id) intelSessions.delete(id);
  setCookie(
    res,
    buildCookieString(req, SESSION_COOKIE_NAME, '', {
      path: '/diag/intel',
      maxAgeMs: 0,
      sameSite: 'Lax'
    })
  );
}

function bodyDiagIntelToken(body) {
  if (!body || typeof body !== 'object') return '';
  const raw =
    body.diag_intel_secret != null
      ? body.diag_intel_secret
      : body.diag_upload_secret != null
        ? body.diag_upload_secret
      : body.diag_bearer != null
        ? body.diag_bearer
        : body.diag_token;
  return parseBearerToken(raw);
}

function extractDiagIntelTokens(req, body) {
  const out = [];
  const pushUnique = (token) => {
    if (!token || out.includes(token)) return;
    out.push(token);
  };
  pushUnique(parseBearerToken(req && req.headers ? req.headers.authorization : ''));
  pushUnique(scrubDiagSecret(headerOne(req, 'x-playshare-diag-intel-secret')));
  pushUnique(bodyDiagIntelToken(body));
  return out;
}

function authenticateIntelRequest(req, body) {
  const accepted = getDiagIntelAcceptedSecrets();
  if (accepted.length === 0) {
    return { configured: false, ok: false, via: null, session: null };
  }
  const session = getIntelSession(req);
  if (session) {
    return { configured: true, ok: true, via: 'session', session };
  }
  const tokens = extractDiagIntelTokens(req, body);
  if (tokens.some((token) => accepted.includes(token))) {
    return { configured: true, ok: true, via: 'secret', session: null };
  }
  return { configured: true, ok: false, via: null, session: null };
}

function issueIntelSessionFromSecret(req, res, secret) {
  const accepted = getDiagIntelAcceptedSecrets();
  if (!accepted.length) return { configured: false, ok: false, session: null };
  const normalized = parseBearerToken(secret);
  if (!normalized || !accepted.includes(normalized)) {
    return { configured: true, ok: false, session: null };
  }
  const session = createIntelSession();
  attachIntelSessionCookie(req, res, session);
  return { configured: true, ok: true, session };
}

function enforceSessionCsrf(req, auth, body) {
  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return { ok: true };
  }
  if (!auth || auth.via !== 'session' || !auth.session) {
    return { ok: true };
  }
  const expected = scrubDiagSecret(auth.session.csrfToken);
  const provided = scrubDiagSecret(headerOne(req, 'x-playshare-csrf') || (body && body.csrf_token));
  if (!provided || provided !== expected) {
    return { ok: false, status: 403, error: 'csrf_token_invalid', hint: 'Reload the explorer and unlock again.' };
  }
  const expectedOrigin = requestOrigin(req);
  const origin = headerOne(req, 'origin');
  const referer = headerOne(req, 'referer');
  if (origin && expectedOrigin && origin !== expectedOrigin) {
    return { ok: false, status: 403, error: 'csrf_origin_mismatch', hint: 'Requests must come from the same host.' };
  }
  if (!origin && referer && expectedOrigin && !referer.startsWith(expectedOrigin + '/') && referer !== expectedOrigin) {
    return { ok: false, status: 403, error: 'csrf_referer_mismatch', hint: 'Requests must come from the same host.' };
  }
  return { ok: true };
}

function createScopedUploadToken(via = 'session', sessionId = null) {
  purgeExpiredRecords(uploadTokens);
  const token = `psu_${randomToken(28)}`;
  const record = {
    token,
    createdAt: new Date().toISOString(),
    expiresAtMs: Date.now() + UPLOAD_TOKEN_TTL_MS,
    via,
    sessionId
  };
  uploadTokens.set(token, record);
  return {
    token,
    created_at: record.createdAt,
    expires_at: new Date(record.expiresAtMs).toISOString(),
    expires_in_ms: UPLOAD_TOKEN_TTL_MS
  };
}

function getScopedUploadTokenRecord(token) {
  purgeExpiredRecords(uploadTokens);
  const normalized = scrubDiagSecret(token);
  if (!normalized) return null;
  const record = uploadTokens.get(normalized);
  if (!record) return null;
  if (record.expiresAtMs <= Date.now()) {
    uploadTokens.delete(normalized);
    return null;
  }
  return record;
}

function bodyUploadToken(body) {
  if (!body || typeof body !== 'object') return '';
  return parseBearerToken(body.upload_token || body.diag_upload_token || '');
}

function bodyUploadSecret(body) {
  if (!body || typeof body !== 'object') return '';
  return parseBearerToken(body.upload_secret || body.diag_upload_secret || body.diag_secret || '');
}

function authenticateUploadRequest(req, body) {
  const session = getIntelSession(req);
  if (session) return { configured: true, ok: true, via: 'session', session, tokenRecord: null };

  const uploadToken = parseBearerToken(req && req.headers ? req.headers.authorization : '') || bodyUploadToken(body);
  const tokenRecord = getScopedUploadTokenRecord(uploadToken);
  if (tokenRecord) {
    return { configured: true, ok: true, via: 'upload_token', session: null, tokenRecord };
  }

  const secrets = getAcceptedUploadSecrets();
  if (!secrets.length) return { configured: false, ok: false, via: null, session: null, tokenRecord: null };
  const secretCandidates = [parseBearerToken(req && req.headers ? req.headers.authorization : ''), bodyUploadSecret(body)]
    .map((v) => scrubDiagSecret(v))
    .filter(Boolean);
  if (secretCandidates.some((secret) => secrets.includes(secret))) {
    return { configured: true, ok: true, via: 'legacy_secret', session: null, tokenRecord: null };
  }
  return { configured: true, ok: false, via: null, session: null, tokenRecord: null };
}

module.exports = {
  SESSION_COOKIE_NAME,
  INTEL_SESSION_TTL_MS,
  UPLOAD_TOKEN_TTL_MS,
  scrubDiagSecret,
  parseBearerToken,
  headerOne,
  requestOrigin,
  getDiagIntelAcceptedSecrets,
  getIntelSecret,
  parseCookies,
  extractDiagIntelTokens,
  authenticateIntelRequest,
  issueIntelSessionFromSecret,
  clearIntelSession,
  enforceSessionCsrf,
  createScopedUploadToken,
  authenticateUploadRequest
};
