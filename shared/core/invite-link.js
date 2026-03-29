/**
 * Build watch-page deep links with stable query params (extension + server agree on names).
 */
import { PLAYS_SHARE_INVITE_QUERY_ROOM, PLAYS_SHARE_INVITE_QUERY_SERVER } from './product.js';

/**
 * Host fragment used in `ps_srv` (no ws:// prefix), matching server.js join redirect.
 * @param {string} wsUrl
 * @returns {string}
 */
export function signalingHostForPsSrv(wsUrl) {
  if (!wsUrl || typeof wsUrl !== 'string') return '';
  return wsUrl.replace(/^wss?:\/\//i, '').split('/')[0].trim();
}

/**
 * Append `playshare=ROOM&ps_srv=host` to a watch URL so guests auto-join with their own subscription.
 * @param {string} watchPageUrl full watch URL (must be http(s))
 * @param {string} roomCode
 * @param {string} wsUrl signaling WebSocket URL for this session
 * @returns {string|null}
 */
export function buildWatchDeepLink(watchPageUrl, roomCode, wsUrl) {
  const code = String(roomCode || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  const host = signalingHostForPsSrv(wsUrl);
  let base = String(watchPageUrl || '').trim();
  if (!code || !host || !base) return null;
  try {
    const u = new URL(base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  const sep = base.includes('?') ? '&' : '?';
  return (
    base +
    sep +
    PLAYS_SHARE_INVITE_QUERY_ROOM +
    '=' +
    code +
    '&' +
    PLAYS_SHARE_INVITE_QUERY_SERVER +
    '=' +
    encodeURIComponent(host)
  );
}
