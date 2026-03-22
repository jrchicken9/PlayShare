/**
 * Optional host permissions for custom signaling URLs (self-hosted / invite ?server=).
 * Built-in Railway, localhost, and Supabase hosts are covered by manifest host_permissions.
 */
(function (g) {
  const DEFAULT_WS =
    typeof PLAYSHARE_SERVER_URL !== 'undefined'
      ? PLAYSHARE_SERVER_URL
      : 'wss://playshare-production.up.railway.app';

  function normalizedWsUrl(urlStr) {
    const s = String(urlStr || '').trim();
    if (!s) return null;
    if (/^wss?:\/\//i.test(s)) return s;
    if (/^https?:\/\//i.test(s)) return s.replace(/^http/i, 'ws');
    return 'wss://' + s.replace(/^\/\//, '');
  }

  function isBuiltinSignalServer(urlStr) {
    try {
      const u = new URL(normalizedWsUrl(urlStr));
      const h = u.hostname.toLowerCase();
      if (h === 'localhost' || h === '127.0.0.1') return true;
      const def = new URL(normalizedWsUrl(DEFAULT_WS));
      if (h === def.hostname) return true;
      if (h.endsWith('.supabase.co')) return true;
      return false;
    } catch {
      return false;
    }
  }

  function hostPermissionPatternsForSignalUrl(urlStr) {
    try {
      const ws = normalizedWsUrl(urlStr);
      const u = new URL(ws);
      const isWss = u.protocol === 'wss:';
      const host = u.host;
      return [(isWss ? 'https:' : 'http:') + '//' + host + '/*', (isWss ? 'wss:' : 'ws:') + '//' + host + '/*'];
    } catch {
      return [];
    }
  }

  /**
   * @param {string} urlStr
   * @param {(ok: boolean) => void} cb
   */
  function ensureSignalServerHostPermissions(urlStr, cb) {
    if (!urlStr || isBuiltinSignalServer(urlStr)) {
      cb(true);
      return;
    }
    const origins = hostPermissionPatternsForSignalUrl(urlStr);
    if (!origins.length) {
      cb(false);
      return;
    }
    try {
      chrome.permissions.contains({ origins }, (has) => {
        if (chrome.runtime.lastError) {
          cb(true);
          return;
        }
        if (has) {
          cb(true);
          return;
        }
        chrome.permissions.request({ origins }, (granted) => cb(!!granted));
      });
    } catch {
      cb(false);
    }
  }

  g.PlayShareSignalPermissions = {
    ensure: ensureSignalServerHostPermissions,
    isBuiltin: isBuiltinSignalServer,
    hostPatterns: hostPermissionPatternsForSignalUrl
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
