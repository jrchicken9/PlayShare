/**
 * Server-side privacy enforcement for diagnostic ingest.
 * Client anonymization is not trusted; this pass scrubs/rejects before raw persistence.
 */

const crypto = require('crypto');

function isRailwayOrProductionEnv() {
  return Boolean(
    String(process.env.RAILWAY_ENVIRONMENT || '').trim() ||
      String(process.env.RAILWAY_PROJECT_ID || '').trim() ||
      String(process.env.NODE_ENV || '').toLowerCase() === 'production'
  );
}

/** Diagnostic report schema versions accepted for ingest (extension export). */
const ALLOWED_DIAGNOSTIC_SCHEMAS = new Set(['2.5', '2.4', '2.3', '2.2', '2.1', '2.0']);

/**
 * Strong salt required on Railway/production. Local/dev may set PLAYSHARE_DIAG_ALLOW_INSECURE_HASH=1
 * (never use in production).
 * @returns {{ ok: true, salt: string } | { ok: false, code: string }}
 */
function assertHashSaltPolicy() {
  const salt = String(process.env.PLAYSHARE_DIAG_HASH_SALT || '').trim();
  const allowInsecure = String(process.env.PLAYSHARE_DIAG_ALLOW_INSECURE_HASH || '').trim() === '1';
  const prodLike = isRailwayOrProductionEnv();
  if (salt.length >= 16) return { ok: true, salt };
  if (prodLike) {
    return { ok: false, code: 'unsafe_server_config_missing_hash_salt' };
  }
  if (allowInsecure) {
    return { ok: true, salt: 'LOCAL_INSECURE_DIAG_HASH_DEV_ONLY_DO_NOT_USE_IN_PROD' };
  }
  return { ok: false, code: 'unsafe_server_config_missing_hash_salt' };
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/**
 * Re-hash identifiers with server salt so stored hashes never rely on client-only salt.
 * @param {object} unified
 * @param {string} serverSalt
 */
function reanchorAnonymizationHashes(unified, serverSalt) {
  const anon = unified.anonymization;
  if (!anon || typeof anon !== 'object') {
    unified.anonymization = {
      schema: 'playshare.diagAnonymize.serverAnchored.v1',
      serverAnchored: true
    };
    return;
  }
  const prefix = `${serverSalt}|reanchor|`;
  if (anon.roomIdHash) {
    anon.roomIdHash = sha256Hex(prefix + 'room|' + anon.roomIdHash).slice(0, 40);
  }
  if (anon.deviceIdHash) {
    anon.deviceIdHash = sha256Hex(prefix + 'device|' + anon.deviceIdHash).slice(0, 40);
  }
  if (anon.usernameHash) {
    anon.usernameHash = sha256Hex(prefix + 'user|' + anon.usernameHash).slice(0, 40);
  }
  anon.serverAnchored = true;
  anon.serverAnchoredAt = new Date().toISOString();
}

function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

function containsDataImage(str) {
  return typeof str === 'string' && /data:image\//i.test(str);
}

/**
 * Collect rejection reasons (no payload content in logs).
 * @param {object} unified — playshare unified export root
 * @param {{ schemaVersion?: string }} ctx
 */
function collectHardRejections(unified, ctx) {
  /** @type {string[]} */
  const reasons = [];

  if (unified == null || typeof unified !== 'object') {
    reasons.push('invalid_unified_payload');
    return reasons;
  }

  if (Object.prototype.hasOwnProperty.call(unified, 'narrativeSummary')) {
    reasons.push('unsafe_narrative_summary_present');
  }

  const schema = ctx.schemaVersion != null ? String(ctx.schemaVersion).trim() : '';
  if (!schema || !ALLOWED_DIAGNOSTIC_SCHEMAS.has(schema)) {
    reasons.push('unsupported_schema_version');
  }

  const ext = unified.extension;
  if (ext && typeof ext === 'object' && ext.room && typeof ext.room === 'object') {
    if (typeof ext.room.roomCode === 'string' && ext.room.roomCode.trim().length > 0) {
      reasons.push('unsafe_room_code_present');
    }
  }
  if (ext && ext.analytics && ext.analytics.session && typeof ext.analytics.session === 'object') {
    const rw = ext.analytics.session.roomCodeWhileInRoom;
    if (typeof rw === 'string' && rw.trim().length > 0) {
      reasons.push('unsafe_room_code_present');
    }
  }

  const jsonStr = JSON.stringify(unified);
  if (containsDataImage(jsonStr)) {
    reasons.push('unsafe_frame_data_present');
  }

  return reasons;
}

function scrubUsernameLikeFields(root) {
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (/^fromUsername$/i.test(k) || /^username$/i.test(k)) {
        if (typeof v === 'string' && v.trim()) {
          delete node[k];
        }
      } else if (k === 'text' && typeof v === 'string') {
        delete node[k];
      } else if (k === 'message' && typeof v === 'string' && v.length > 200) {
        node[k] = '[redacted]';
      } else {
        walk(v);
      }
    }
  };
  walk(root);
}

function stripProfilerUnsafe(unified) {
  const prof = unified.videoPlayerProfiler;
  if (!prof || typeof prof !== 'object') return;
  delete prof.page;
  if (prof.videoFrame && typeof prof.videoFrame === 'object') {
    delete prof.videoFrame.dataUrl;
    if (prof.videoFrame.truncated != null) delete prof.videoFrame.truncated;
  }
  if (Array.isArray(prof.snapshots)) {
    for (const s of prof.snapshots) {
      if (!s || typeof s !== 'object') continue;
      if (typeof s.currentSrc === 'string' && s.currentSrc.length > 120) {
        s.currentSrc = s.currentSrc.slice(0, 120);
      }
      if (typeof s.src === 'string' && s.src.length > 120) {
        s.src = s.src.slice(0, 120);
      }
      delete s.poster;
    }
  }
}

function stripExtensionUnsafe(unified) {
  const ext = unified.extension;
  if (!ext || typeof ext !== 'object') return;
  delete ext.userAgent;
  if (ext.room && typeof ext.room === 'object') {
    delete ext.room.roomCode;
  }
  if (ext.analytics && ext.analytics.session && typeof ext.analytics.session === 'object') {
    delete ext.analytics.session.roomCodeWhileInRoom;
  }
}

/**
 * After scrub, fail if obvious PII remnants.
 * @param {object} unified
 * @returns {string[]}
 */
function postScrubViolations(unified) {
  /** @type {string[]} */
  const reasons = [];

  if (Object.prototype.hasOwnProperty.call(unified, 'narrativeSummary')) {
    reasons.push('unsafe_narrative_summary_present');
  }

  const ext = unified.extension;
  const walkUser = (node, path) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((x, i) => walkUser(x, `${path}[${i}]`));
      return;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if ((/^fromUsername$/i.test(k) || /^username$/i.test(k)) && typeof v === 'string' && v.trim().length > 0) {
        reasons.push('unsafe_unredacted_username');
      }
      if (k === 'text' && typeof v === 'string' && v.trim().length > 0) {
        reasons.push('unsafe_chat_or_free_text_present');
      }
      walkUser(v, `${path}.${k}`);
    }
  };
  if (ext) walkUser(ext, 'extension');

  if (containsDataImage(JSON.stringify(unified))) {
    reasons.push('unsafe_frame_data_present');
  }

  if (ext && ext.room && typeof ext.room === 'object' && typeof ext.room.roomCode === 'string' && ext.room.roomCode.trim()) {
    reasons.push('unsafe_room_code_present');
  }

  return [...new Set(reasons)];
}

/**
 * @param {object} unified — unified export root (mutated)
 * @param {{ serverSalt: string, schemaVersion?: string }} opts
 * @returns {{ ok: boolean, reasons: string[], scrubbed: object }}
 */
function enforceUnifiedDiagnosticPrivacy(unified, opts) {
  const serverSalt = opts.serverSalt;
  const schemaVersion = opts.schemaVersion;

  const hard = collectHardRejections(unified, { schemaVersion });
  if (hard.length) {
    return { ok: false, reasons: [...new Set(hard)], scrubbed: unified };
  }

  const scrubbed = deepClone(unified);
  delete scrubbed.narrativeSummary;
  stripExtensionUnsafe(scrubbed);
  scrubUsernameLikeFields(scrubbed);
  stripProfilerUnsafe(scrubbed);

  const retainPeerDevDiag = String(process.env.PLAYSHARE_DIAG_RETAIN_PEER_DEV_DIAG || '').trim() === '1';
  if (scrubbed.peerRecordingDiagnostics && Array.isArray(scrubbed.peerRecordingDiagnostics.peers)) {
    for (const p of scrubbed.peerRecordingDiagnostics.peers) {
      if (p && typeof p === 'object') {
        delete p.clientId;
        if (Array.isArray(p.samples) && !retainPeerDevDiag) {
          for (const s of p.samples) {
            if (s && s.devDiag) delete s.devDiag;
          }
        }
      }
    }
  }

  if (scrubbed.primeSiteDebug && typeof scrubbed.primeSiteDebug === 'object') {
    delete scrubbed.primeSiteDebug.frameDataUrl;
    delete scrubbed.primeSiteDebug.captureErrorStack;
  }

  reanchorAnonymizationHashes(scrubbed, serverSalt);

  const post = postScrubViolations(scrubbed);
  if (post.length) {
    return { ok: false, reasons: [...new Set(post)], scrubbed };
  }

  scrubbed.privacyEnforcement = {
    schema: 'playshare.diagPrivacyEnforcement.v1',
    at: new Date().toISOString(),
    serverSaltAnchored: true
  };

  return { ok: true, reasons: [], scrubbed };
}

function safePrivacyLog(reportId, reasons, extra = {}) {
  const line = `[PlayShare/diag/privacy] reject report=${reportId || 'n/a'} reasons=${reasons.join(',')}`;
  const safe = { ...extra };
  console.warn(line, safe);
}

module.exports = {
  assertHashSaltPolicy,
  enforceUnifiedDiagnosticPrivacy,
  safePrivacyLog,
  ALLOWED_DIAGNOSTIC_SCHEMAS,
  isRailwayOrProductionEnv
};
