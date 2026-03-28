/**
 * Service-worker safe (importScripts): anonymize unified diagnostic JSON before upload.
 * Strips narrative text, hashes identifiers, removes chat-adjacent strings, trims URLs in free text.
 */
(function (global) {
  'use strict';

  async function sha256Hex(input) {
    const s = typeof input === 'string' ? input : String(input || '');
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(s));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function scrubFreeText(str, maxLen) {
    if (typeof str !== 'string') return str;
    let o = str.replace(/https?:\/\/[^\s"'<>]+/gi, '[url]');
    o = o.replace(/\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/gi, '[id]');
    if (maxLen && o.length > maxLen) o = o.slice(0, maxLen) + '…';
    return o;
  }

  function deleteUsernameFields(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      if (/username/i.test(k) && typeof obj[k] === 'string') delete obj[k];
      if (k === 'text' && typeof obj[k] === 'string') delete obj[k];
      if (k === 'note' && typeof obj[k] === 'string') obj[k] = scrubFreeText(obj[k], 120);
    }
  }

  /**
   * @param {object} body unified export (playshareUnifiedExport root)
   * @param {{ roomCode?: string|null, clientId?: string|null, username?: string|null, salt?: string }} hashSecrets
   * @param {{ retainPeerDevDiag?: boolean }} [opts]
   */
  async function anonymizePlayShareUnifiedExport(body, hashSecrets, opts) {
    const retainPeerDevDiag = !!(opts && opts.retainPeerDevDiag);
    const salt = hashSecrets?.salt || 'playshare-diag-anon-v1';
    const roomHash = hashSecrets?.roomCode
      ? (await sha256Hex(`${salt}|room|${hashSecrets.roomCode}`)).slice(0, 40)
      : null;
    const deviceHash = hashSecrets?.clientId
      ? (await sha256Hex(`${salt}|device|${hashSecrets.clientId}`)).slice(0, 40)
      : null;
    const userHash = hashSecrets?.username
      ? (await sha256Hex(`${salt}|user|${hashSecrets.username}`)).slice(0, 40)
      : null;

    const clone = JSON.parse(JSON.stringify(body));
    delete clone.narrativeSummary;

    clone.anonymization = {
      schema: 'playshare.diagAnonymize.v1',
      at: new Date().toISOString(),
      roomIdHash: roomHash,
      deviceIdHash: deviceHash,
      usernameHash: userHash
    };

    const ext = clone.extension;
    if (ext && typeof ext === 'object') {
      delete ext.userAgent;
      if (ext.analytics && ext.analytics.session && typeof ext.analytics.session === 'object') {
        delete ext.analytics.session.roomCodeWhileInRoom;
      }
      if (ext.room && typeof ext.room === 'object') {
        delete ext.room.roomCode;
        if (roomHash) ext.room.roomIdHash = roomHash;
      }
      if (ext.sync && Array.isArray(ext.sync.events)) {
        for (const e of ext.sync.events) {
          deleteUsernameFields(e);
          if (e.detail && typeof e.detail === 'object') deleteUsernameFields(e.detail);
        }
      }
      if (ext.sync && Array.isArray(ext.sync.remoteApplyResults)) {
        for (const r of ext.sync.remoteApplyResults) deleteUsernameFields(r);
      }
      if (ext.sync && Array.isArray(ext.sync.peerReportsSummary)) {
        for (const p of ext.sync.peerReportsSummary) deleteUsernameFields(p);
      }
      if (ext.serverRoomTrace && Array.isArray(ext.serverRoomTrace)) {
        for (const row of ext.serverRoomTrace) deleteUsernameFields(row);
      }
      if (ext.sessionChronology && Array.isArray(ext.sessionChronology.memberTimeline)) {
        for (const row of ext.sessionChronology.memberTimeline) {
          delete row.username;
          delete row.roomCodeTrunc;
        }
      }
      if (ext.messaging && typeof ext.messaging === 'object') {
        if (ext.messaging.runtimeLastErrorMessage) {
          ext.messaging.runtimeLastErrorMessage = scrubFreeText(String(ext.messaging.runtimeLastErrorMessage), 80);
        }
      }
      if (ext.connectionDetail && typeof ext.connectionDetail === 'object') {
        if (ext.connectionDetail.connectionMessage) {
          ext.connectionDetail.connectionMessage = scrubFreeText(
            String(ext.connectionDetail.connectionMessage),
            160
          );
        }
      }
    }

    const prof = clone.videoPlayerProfiler;
    if (prof && typeof prof === 'object') {
      delete prof.page;
      if (prof.snapshots && Array.isArray(prof.snapshots)) {
        for (const s of prof.snapshots) {
          if (s && typeof s === 'object') {
            if (s.currentSrc) s.currentSrc = scrubFreeText(String(s.currentSrc), 80);
            if (s.src) s.src = scrubFreeText(String(s.src), 80);
          }
        }
      }
    }

    const peers = clone.peerRecordingDiagnostics;
    if (peers && Array.isArray(peers.peers)) {
      for (const p of peers.peers) {
        if (p && typeof p === 'object') {
          delete p.clientId;
          if (Array.isArray(p.samples) && !retainPeerDevDiag) {
            for (const s of p.samples) {
              if (s && s.devDiag && typeof s.devDiag === 'object') {
                delete s.devDiag;
              }
            }
          }
        }
      }
    }

    if (clone.primeSiteDebug && typeof clone.primeSiteDebug === 'object') {
      delete clone.primeSiteDebug.frameDataUrl;
      delete clone.primeSiteDebug.captureErrorStack;
    }

    return clone;
  }

  global.diagAnonymizePlayShareUnifiedExport = anonymizePlayShareUnifiedExport;
})(typeof self !== 'undefined' ? self : globalThis);
