/**
 * Invite / join-page URL helpers (bundled in content script — do not rely on a separate manifest script).
 */

/**
 * @param {string} wsUrl e.g. wss://playshare.example.com or ws://127.0.0.1:8765
 * @returns {string|null} https:// or http:// origin (no trailing slash)
 */
export function wsUrlToHttpBase(wsUrl) {
  if (!wsUrl || typeof wsUrl !== 'string') return null;
  const t = wsUrl.trim();
  if (/^wss:\/\//i.test(t)) return 'https://' + t.slice(6).replace(/\/+$/, '');
  if (/^ws:\/\//i.test(t)) return 'http://' + t.slice(5).replace(/\/+$/, '');
  return null;
}

/**
 * @param {string} srv raw ?ps_srv= value (may be encoded)
 * @returns {string|null} ws:// or wss:// URL for chrome.storage serverUrl
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
    return 'ws://' + firstSeg + ':8765';
  }
  return 'wss://' + host;
}
