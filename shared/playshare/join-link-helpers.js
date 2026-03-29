/**
 * Invite / join-page URL helpers (environment-agnostic).
 * Used by the extension content script and reusable from a future hosted join flow or app.
 */

import { PLAYS_SHARE_DEFAULT_LOCAL_SIGNAL_PORT } from './product.js';

/**
 * @param {string} wsUrl e.g. wss://playshare.example.com or ws://127.0.0.1:8765 (optional path is stripped)
 * @returns {string|null} https:// or http:// origin only (protocol + host + port, no path)
 */
export function wsUrlToHttpBase(wsUrl) {
  if (!wsUrl || typeof wsUrl !== 'string') return null;
  let t = wsUrl.trim();
  if (!t) return null;
  if (!/^wss?:\/\//i.test(t)) t = `wss://${t.replace(/^\/\//, '')}`;
  try {
    const u = new URL(t);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
    const httpProto = u.protocol === 'ws:' ? 'http:' : 'https:';
    return `${httpProto}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * @param {string} srv raw invite `ps_srv` query value (see `product.js`; may be encoded)
 * @returns {string|null} ws:// or wss:// URL suitable for `serverUrl` storage / WebSocket
 */
export function wsUrlFromInvitePsSrv(srv) {
  if (srv == null || typeof srv !== 'string') return null;
  let host = srv;
  try {
    host = decodeURIComponent(srv.trim());
  } catch {
    return null;
  }
  if (!host) return null;
  if (/^wss?:\/\//i.test(host)) return host;
  const firstSeg = host.split(':')[0];
  const isLocal =
    firstSeg === 'localhost' ||
    firstSeg === '127.0.0.1' ||
    firstSeg === '[::1]' ||
    firstSeg === '::1';
  if (isLocal) {
    if (/:\d+$/.test(host)) return 'ws://' + host;
    return 'ws://' + firstSeg + ':' + PLAYS_SHARE_DEFAULT_LOCAL_SIGNAL_PORT;
  }
  return 'wss://' + host;
}
