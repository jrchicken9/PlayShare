/** URL looks like a watchable video page (not home/browse). */
export function isVideoPage() {
  const path = location.pathname.toLowerCase();
  const host = location.hostname.toLowerCase();
  if (/youtube\.com|youtu\.be/.test(host)) {
    return /\/watch(\?|$)/.test(path) || /\/shorts\//.test(path) || /\/embed\//.test(path) || (host.includes('youtu.be') && path.length > 1);
  }
  if (/netflix\.com/.test(host)) return /\/watch\//.test(path) || /\/title\//.test(path);
  if (/disneyplus\.com/.test(host)) return /\/video\//.test(path) || /\/player\//.test(path);
  if (/primevideo\.com/.test(host)) return /\/detail\//.test(path) || /\/watch\//.test(path) || /\/region\//.test(path);
  if (/amazon\.(com|ca)/.test(host)) return /\/gp\/video\/detail\//.test(path) || /\/gp\/video\/watch\//.test(path);
  if (/crave\.ca/.test(host)) return /\/watch\//.test(path) || /\/movies\//.test(path) || /\/shows\//.test(path);
  if (/hulu\.com/.test(host)) return /\/watch\//.test(path);
  if (/hbomax\.com|max\.com/.test(host)) return /\/feature\//.test(path) || /\/watch\//.test(path) || /\/video\//.test(path);
  if (/peacocktv\.com/.test(host)) return /\/watch\//.test(path) || /\/movies\//.test(path) || /\/tv\//.test(path);
  if (/paramountplus\.com/.test(host)) return /\/video\//.test(path) || /\/watch\//.test(path);
  if (/appletv\.apple\.com|tv\.apple\.com/.test(host)) return /\/movie\//.test(path) || /\/tv-episode\//.test(path) || /\/watch\//.test(path);
  return false;
}

/** Teleparty-style: auto-join from `?playshare=CODE&ps_srv=host` */
export function runUrlJoinFromQuery() {
  const params = new URLSearchParams(location.search);
  const code = (params.get('playshare') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const srv = params.get('ps_srv');
  if (code.length < 4 || !srv) return;

  const host = decodeURIComponent(srv);
  const serverUrl = host.startsWith('ws') ? host : 'ws://' + host + (host.includes(':') ? '' : ':8765');
  params.delete('playshare');
  params.delete('ps_srv');
  const newSearch = params.toString() ? '?' + params.toString() : '';
  try { history.replaceState(null, '', location.pathname + newSearch + location.hash); } catch {}

  chrome.storage.local.set({ serverUrl });
  chrome.storage.local.get(['username'], (d) => {
    const username = (d.username || 'Viewer').slice(0, 24);
    chrome.runtime.sendMessage({ source: 'playshare', type: 'JOIN_ROOM', roomCode: code, username });
  });
}

/**
 * Heuristic: higher score = more likely main player (not preview / background).
 * @param {HTMLVideoElement} v
 */
export function scoreVideoElement(v) {
  if (!v || v.tagName !== 'VIDEO') return -Infinity;
  try {
    const rect = v.getBoundingClientRect();
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    if (area < 4) return -Infinity;
    const style = window.getComputedStyle(v);
    let score = area;
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
      score *= 0.02;
    }
    // Preview strips / mini players
    if (rect.width < 200 || rect.height < 112) score *= 0.12;
    const vw = window.innerWidth || 1920;
    const vh = window.innerHeight || 1080;
    const visibleW = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
    const visibleH = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
    const visArea = visibleW * visibleH;
    score = Math.max(score * 0.08, visArea * 2.2);
    if (v.getAttribute('aria-hidden') === 'true') score *= 0.25;
    if (!v.paused) score *= 1.35;
    if (v.muted && (rect.width < 320 || rect.height < 180)) score *= 0.4;
    try {
      if (v.closest?.('.atvwebplayersdk-player-container, [class*="atvwebplayersdk-player"], [class*="webPlayerInner"]')) {
        score *= 1.85;
      }
    } catch { /* ignore */ }
    return score;
  } catch {
    return -Infinity;
  }
}

function collectVideosFromRoot(root, depth, out, seen) {
  if (depth < 0 || !root) return;
  try {
    const vids = root.querySelectorAll?.('video');
    if (vids) {
      for (const el of vids) {
        if (seen.has(el)) continue;
        seen.add(el);
        out.push(el);
      }
    }
    if (depth > 0) {
      const elements = root.querySelectorAll?.('*') || [];
      for (const el of elements) {
        if (el.shadowRoot) collectVideosFromRoot(el.shadowRoot, depth - 1, out, seen);
      }
    }
  } catch { /* cross-origin shadow */ }
}

/**
 * All `<video>` nodes in the page: document, shadow trees, same-origin iframes.
 * @param {Document} [doc]
 * @returns {HTMLVideoElement[]}
 */
export function collectPageVideoElements(doc = document) {
  const out = [];
  const seen = new Set();
  collectVideosFromRoot(doc, 5, out, seen);
  try {
    const iframes = doc.querySelectorAll('iframe');
    for (const fr of iframes) {
      try {
        const idoc = fr.contentDocument || fr.contentWindow?.document;
        if (idoc) collectVideosFromRoot(idoc, 4, out, seen);
      } catch { /* cross-origin */ }
    }
  } catch { /* ignore */ }
  return out;
}

/**
 * Observe DOM / attribute churn (SPA players, Netflix / Prime swaps).
 * @param {Node} root
 * @param {() => void} onMaybeVideoTreeChanged
 * @param {number} [throttleMs]
 * @returns {() => void} disconnect
 */
export function attachVideoDomObserver(root, onMaybeVideoTreeChanged, throttleMs = 300) {
  let tid = null;
  const schedule = () => {
    if (tid) return;
    tid = setTimeout(() => {
      tid = null;
      onMaybeVideoTreeChanged();
    }, throttleMs);
  };
  const obs = new MutationObserver(schedule);
  if (root) {
    obs.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'class', 'style']
    });
  }
  return () => {
    obs.disconnect();
    if (tid) clearTimeout(tid);
  };
}
