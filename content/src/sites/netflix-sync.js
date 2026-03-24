/**
 * Netflix (Cadmium) — dedicated sync tuning separate from generic drmPassive + Disney.
 *
 * Netflix’s HTML5 stack is sensitive to extension-driven playback; users often see **M7375**
 * when automation fights the player. We keep user-confirmed sync but apply with **minimal**
 * direct `<video>` calls and **UI control clicks** where possible.
 */
import { contentConstants as C } from '../constants.js';

export const NETFLIX_SYNC_HANDLER_KEY = 'netflix';

/** Prefer these when resolving the main episode `<video>` (watch UI). */
export const NETFLIX_PRIORITY_VIDEO_SELECTORS = [
  '.watch-video--player-view video',
  '.watch-video video',
  '[data-uia="video-canvas"] video',
  '.watch-video--player-view .VideoContainer video',
  'div[data-uia="player"] video'
];

function isLikelyVisible(el) {
  if (!el || el.nodeType !== 1) return false;
  try {
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    // Cadmium ads chrome is often `position: fixed` → `offsetParent === null` but still on-screen.
    return r.width > 2 && r.height > 2;
  } catch {
    return false;
  }
}

/**
 * Click Netflix’s visible play/pause affordances (data-uia varies by A/B).
 * @returns {boolean} true if a control was activated
 */
export function tryNetflixPlaybackUi(v, wantPlaying) {
  if (!v || v.tagName !== 'VIDEO') return false;
  const wantPause = !wantPlaying;
  if (wantPlaying && v.paused) {
    const playSel = [
      '[data-uia="player-play-pause-play"]',
      'button[data-uia="player-play-pause-play"]',
      '.button-nfplayerPlay',
      'button[aria-label="Play"]',
      'button[aria-label*="Play" i]'
    ];
    for (const sel of playSel) {
      const el = document.querySelector(sel);
      if (isLikelyVisible(el)) {
        try {
          el.click();
          return true;
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (wantPause && !v.paused) {
    const pauseSel = [
      '[data-uia="player-play-pause-pause"]',
      'button[data-uia="player-play-pause-pause"]',
      '.button-nfplayerPause',
      'button[aria-label="Pause"]',
      'button[aria-label*="Pause" i]'
    ];
    for (const sel of pauseSel) {
      const el = document.querySelector(sel);
      if (isLikelyVisible(el)) {
        try {
          el.click();
          return true;
        } catch {
          /* ignore */
        }
      }
    }
  }
  const toggleSel = ['[data-uia="player-play-pause-button"]', 'button[data-uia="control-play-pause-play-pause"]'];
  for (const sel of toggleSel) {
    const el = document.querySelector(sel);
    if (!isLikelyVisible(el)) continue;
    if ((wantPlaying && v.paused) || (wantPause && !v.paused)) {
      try {
        el.click();
        return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

/**
 * One-shot align for viewers after “Sync” confirmation — seek once, UI-first play/pause, single API fallback.
 */
export function applyNetflixDrmViewerOneShot(v, targetTime, wantPlaying) {
  if (!v || v.tagName !== 'VIDEO') return;
  try {
    if (typeof targetTime === 'number' && Number.isFinite(targetTime) && targetTime >= 0) {
      v.currentTime = targetTime;
    }
  } catch {
    /* ignore */
  }
  if (tryNetflixPlaybackUi(v, wantPlaying)) return;
  try {
    if (wantPlaying) v.play().catch(() => {});
    else v.pause();
  } catch {
    /* ignore */
  }
}

function adjustNetflixVideoCandidateScore(v, score) {
  try {
    let el = v;
    for (let d = 0; d < 8 && el; d++) {
      if (!el.parentElement) break;
      el = el.parentElement;
      const cls = el.className && typeof el.className === 'string' ? el.className : '';
      if (/watch-video|player-view|VideoContainer|watchVideo/i.test(cls)) {
        return score * 1.55;
      }
      if (el.getAttribute?.('data-uia') === 'video-canvas') return score * 1.45;
    }
  } catch {
    /* ignore */
  }
  return score;
}

function onStillPausedAfterAggressivePlay(_v, { dispatchSpaceKey }) {
  const root =
    document.querySelector('.watch-video--player-view') ||
    document.querySelector('.watch-video') ||
    document.querySelector('[data-uia="player"]');
  if (root) dispatchSpaceKey(root);
}

function onStillPlayingAfterAggressivePause(_v, { dispatchSpaceKey }) {
  const root =
    document.querySelector('.watch-video--player-view') ||
    document.querySelector('.watch-video') ||
    document.querySelector('[data-uia="player"]');
  if (root) dispatchSpaceKey(root);
}

/** @type {import('./site-sync-adapter.js').SiteSyncAdapter} */
export const netflixSiteSyncAdapter = Object.freeze({
  key: NETFLIX_SYNC_HANDLER_KEY,
  getPlaybackConfidence: ({ video }) => getNetflixPlaybackConfidence(video),
  remoteApplyIgnoreLocalMs: 1150,
  microCorrectionIgnoreSec: 1.0,
  rapidSeekRejectWindowMs: 2800,
  rapidSeekMaxInWindow: 4,
  skipRemoteSeekWhileVideoSeeking: true,
  getPriorityVideoSelectors: () => [...NETFLIX_PRIORITY_VIDEO_SELECTORS],
  adjustVideoCandidateScore: adjustNetflixVideoCandidateScore,
  onStillPausedAfterAggressivePlay,
  onStillPlayingAfterAggressivePause,
  extraDiagTips: () => [
    {
      level: 'warn',
      text:
        'Netflix (Cadmium): PlayShare uses **Netflix-specific** sync — confirm with “Sync” when prompted. Error **M7375** often means the player rejected extension interference; avoid stacking multiple video extensions and prefer one manual sync.'
    },
    {
      level: 'info',
      text:
        'If auto-detect misses: sidebar **Watching ad** / **Ad finished**, or set **keyboard shortcuts** (chrome://extensions → PlayShare). DOM: `ads-info-container` + ordinal **Ad N of M**, slash counts, mm:ss or seconds on `ads-info-time`.'
    }
  ]
});

/**
 * @param {string} [hostname]
 */
export function isNetflixHostname(hostname) {
  return /netflix\.com/.test(String(hostname || '').toLowerCase());
}

/**
 * @param {HTMLVideoElement|null|undefined} video
 * @returns {'HIGH'|'MEDIUM'|'LOW'}
 */
export function getNetflixPlaybackConfidence(video) {
  if (!video || video.tagName !== 'VIDEO') return 'LOW';
  if (detectNetflixAdPlaying(video)) return 'LOW';
  try {
    if (video.seeking) return 'MEDIUM';
    if (video.readyState != null && video.readyState < 3) return 'MEDIUM';
  } catch {
    /* ignore */
  }
  return 'HIGH';
}

/**
 * True when Netflix’s modular ads strip shows a running countdown (not an idle `0:00` shell).
 * Paused main content often still mounts `ads-info-*` with lone “Ad” text — timer stays empty or zero.
 * @param {ParentNode|null|undefined} surface `.watch-video` or player subtree
 */
function visibleNetflixAdsCountdownActive(surface) {
  if (!surface || typeof surface.querySelector !== 'function') return false;
  try {
    const timeEl = surface.querySelector('[data-uia="ads-info-time"]');
    if (!timeEl || !isLikelyVisible(timeEl)) return false;
    const raw = (timeEl.textContent || '').trim();
    const tt = raw.replace(/\s+/g, '');
    if (!tt || !/\d/.test(tt)) return false;
    // Idle / placeholder when not in a real break
    if (/^0{1,2}:0{1,2}$/.test(tt)) return false;
    if (/\d{1,2}:\d{2}/.test(tt)) return true;
    // e.g. top-right “• 8” — seconds only while “Ad 2 of 2” is in the strip (avoids random lone digits).
    if (/^\d{1,3}$/.test(tt)) {
      const sec = +tt;
      if (sec >= 1 && sec <= 600 && visibleNetflixAdsOrdinalPod(surface)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * English “Ad 2 of 2 • 8” style — often the whole strip lives under `ads-info-container`.
 * @param {ParentNode|null|undefined} surface
 */
function visibleNetflixAdsOrdinalPod(surface) {
  if (!surface || typeof surface.querySelector !== 'function') return false;
  try {
    const c = surface.querySelector('[data-uia="ads-info-container"]');
    if (!c || !isLikelyVisible(c)) return false;
    const norm = (/** @type {string} */ s) =>
      s.replace(/[\s\u00a0\u2007\u202f]+/g, ' ').trim();
    const blob = norm(c.textContent || '');
    const aria = norm(c.getAttribute('aria-label') || '');
    const combined = `${blob} ${aria}`;
    // “Ad 2 of 2”, tight “Ad2 of 2”, optional odd spaces from Cadmium
    return /\bAd\s*\d{1,3}\s+of\s+\d{1,3}\b/i.test(combined);
  } catch {
    return false;
  }
}

/**
 * Top-right **1/3**-style pod indicator stays visible between spots; timer may read `0:00` in the gap.
 * @param {ParentNode|null|undefined} surface
 */
function visibleNetflixAdsPodProgress(surface) {
  if (!surface || typeof surface.querySelector !== 'function') return false;
  try {
    const el = surface.querySelector('[data-uia="ads-info-count"]');
    if (!el || !isLikelyVisible(el)) return false;
    const raw = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const compact = raw.replace(/\s+/g, '');
    let m = /^(\d{1,3})\/(\d{1,3})$/.exec(compact);
    if (m) {
      const cur = +m[1];
      const tot = +m[2];
      return Number.isFinite(cur) && Number.isFinite(tot) && tot >= 1 && cur >= 1 && cur <= tot;
    }
    m = /\bAd\s*(\d{1,3})\s+of\s+(\d{1,3})\b/i.exec(raw);
    if (m) {
      const cur = +m[1];
      const tot = +m[2];
      return Number.isFinite(cur) && Number.isFinite(tot) && tot >= 1 && cur >= 1 && cur <= tot;
    }
    return false;
  } catch {
    return false;
  }
}

/** Lone “Ad” label + timer, slash pod, or “Ad N of M” strip. */
function netflixAdsStripSupportsLoneAdLabel(surface) {
  return (
    visibleNetflixAdsCountdownActive(surface) ||
    visibleNetflixAdsPodProgress(surface) ||
    visibleNetflixAdsOrdinalPod(surface)
  );
}

/**
 * Cadmium ad UI varies by locale/A/B; this is best-effort DOM only (no player API).
 * Keep checks **visible** and **scoped to the watch surface** to limit false positives.
 * @param {HTMLVideoElement|null|undefined} video
 */
export function detectNetflixAdPlaying(video) {
  const root =
    document.querySelector('.watch-video--player-view') ||
    document.querySelector('.watch-video') ||
    document.getElementById('appMountPoint') ||
    document.body;

  const surface =
    document.querySelector('.watch-video--player-view') ||
    document.querySelector('.watch-video') ||
    document.getElementById('appMountPoint');
  if (visibleNetflixAdsOrdinalPod(surface)) return true;
  if (visibleNetflixAdsPodProgress(surface)) return true;
  if (visibleNetflixAdsCountdownActive(surface)) return true;

  const tryVisible = (/** @type {string} */ sel) => {
    try {
      const el = root.querySelector(sel);
      return isLikelyVisible(el) ? el : null;
    } catch {
      return null;
    }
  };

  /** @type {string[]} */
  const uiaHints = [
    '[data-uia*="advertisement" i]',
    '[data-uia*="ad-badge" i]',
    '[data-uia*="adBadge" i]',
    '[data-uia*="ad-label" i]',
    '[data-uia*="adLabel" i]',
    '[data-uia*="ad-timer" i]',
    '[data-uia*="adTimer" i]',
    '[data-uia*="ad-break" i]',
    '[data-uia*="adBreak" i]',
    '[data-uia*="player-ad" i]',
    '[data-uia*="playerAd" i]',
    '[data-uia*="skip-ad" i]',
    '[data-uia*="skipAd" i]',
    '[data-uia*="ad-progress" i]'
  ];
  for (const sel of uiaHints) {
    if (tryVisible(sel)) return true;
  }

  const classHints = [
    '[class*="ad-break" i]',
    '[class*="adbreak" i]',
    '[class*="advertisement" i]',
    '[class*="AdTimer" i]',
    '[class*="ad-timer" i]',
    '[class*="player-ad" i]',
    '[class*="PlayerAd" i]'
  ];
  for (const sel of classHints) {
    if (tryVisible(sel)) return true;
  }

  // Avoid `[aria-label^="Ad "]` alone — too easy to match chrome; require timer/digits (same idea as short-text).
  const ariaHints = [
    '[aria-label*="Advertisement" i]',
    '[aria-label^="Ad ·" i]',
    '[aria-label*="Ad ·" i]',
    '[aria-label*="Ad, " i]'
  ];
  for (const sel of ariaHints) {
    if (tryVisible(sel)) return true;
  }
  try {
    const adAria = root.querySelectorAll('[aria-label^="Ad " i]');
    for (let i = 0; i < adAria.length; i++) {
      const n = adAria[i];
      if (!isLikelyVisible(n)) continue;
      const al = (n.getAttribute('aria-label') || '').trim();
      if (al.length >= 10 || /\d/.test(al)) return true;
    }
  } catch {
    /* ignore */
  }

  if (video && video.closest) {
    try {
      const near = video.closest(
        '[class*="ad-break" i], [class*="adbreak" i], [class*="advertisement" i], [data-ad-state], [data-uia*="ad-break" i], [data-uia*="player-ad" i]'
      );
      if (near && isLikelyVisible(near)) return true;
    } catch {
      /* ignore */
    }
    try {
      let el = video;
      for (let d = 0; d < 16 && el; d++) {
        const cls = el.className && typeof el.className === 'string' ? el.className : '';
        const aria = el.getAttribute?.('aria-label') || '';
        const uia = el.getAttribute?.('data-uia') || '';
        const blob = `${cls} ${aria} ${uia}`;
        if (/\bad[\s_-]?break\b/i.test(blob)) return true;
        if (!/ads-info|modular-ads|adsinfo/i.test(uia) && /player[\s_-]?ad/i.test(uia)) return true;
        if (aria && aria.length < 140 && /\badvertisement\b/i.test(aria)) return true;
        el = el.parentElement;
      }
    } catch {
      /* ignore */
    }
  }

  // Short on-player labels (e.g. "Ad · 0:30") — cap work; ignore long copy (titles, descriptions).
  try {
    if (surface) {
      const nodes = surface.querySelectorAll('span, div, p, button');
      const cap = Math.min(nodes.length, 280);
      for (let i = 0; i < cap; i++) {
        const el = nodes[i];
        if (!isLikelyVisible(el)) continue;
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length < 2 || t.length > 56) continue;
        if (/^Advertisement\b/i.test(t)) return true;
        if (/\bAd\s*\d{1,3}\s+of\s+\d{1,3}\b/i.test(t)) return true;
        if (/\bAd\s*[·•]\s*\d/.test(t)) return true;
        if (/^Ad\b/i.test(t) && /\d/.test(t)) return true;
        if (/^Ad\b/i.test(t) && t.length >= 10) return true;
        // Lone “Ad” only when timer or pod counter (e.g. 1/3) shows an active break.
        if (/^Ad$/i.test(t) && netflixAdsStripSupportsLoneAdLabel(surface)) return true;
      }
    }
  } catch {
    /* ignore */
  }

  return false;
}

/**
 * Capped DOM harvest for **Mark moment** profiler snapshots (missed-ad debugging).
 * JSON-safe; no innerHTML; strings truncated.
 * @param {HTMLVideoElement|null|undefined} video
 */
export function captureNetflixAdProfilerHints(video) {
  /** @param {string} s @param {number} n */
  const cut = (s, n) => {
    const x = s == null ? '' : String(s);
    return x.length > n ? `${x.slice(0, n)}…` : x;
  };

  const out = {
    heuristicAd: detectNetflixAdPlaying(video),
    playerShellClass: /** @type {string|null} */ (null),
    videoIntrinsic: /** @type {{ w: number, h: number }|null} */ (null),
    visibleDataUia: /** @type {string[]} */ ([]),
    ariaAdRelated: /** @type {string[]} */ ([]),
    shortTextHits: /** @type {string[]} */ ([]),
    classNameAdHints: /** @type {string[]} */ ([]),
    idAdHints: /** @type {string[]} */ ([])
  };

  try {
    if (video && video.videoWidth && video.videoHeight) {
      out.videoIntrinsic = { w: video.videoWidth, h: video.videoHeight };
    }
  } catch {
    /* ignore */
  }

  if (video) {
    try {
      let el = video;
      for (let d = 0; d < 18 && el; d++) {
        const cls = typeof el.className === 'string' ? el.className : '';
        if (/\b(active|inactive|passive)\b/.test(cls) && /default-ltr-/.test(cls)) {
          out.playerShellClass = cut(cls, 160);
          break;
        }
        el = el.parentElement;
      }
    } catch {
      /* ignore */
    }
  }

  const surface =
    document.querySelector('.watch-video--player-view') ||
    document.querySelector('.watch-video') ||
    document.getElementById('appMountPoint');
  if (!surface) return out;

  try {
    const uiaNodes = surface.querySelectorAll('[data-uia]');
    const uiaSeen = new Set();
    for (let i = 0; i < uiaNodes.length && out.visibleDataUia.length < 50; i++) {
      const n = uiaNodes[i];
      if (!isLikelyVisible(n)) continue;
      const u = cut(n.getAttribute('data-uia') || '', 100);
      if (!u || uiaSeen.has(u)) continue;
      uiaSeen.add(u);
      out.visibleDataUia.push(u);
    }
  } catch {
    /* ignore */
  }

  try {
    const withAria = surface.querySelectorAll('[aria-label]');
    for (let i = 0; i < withAria.length && out.ariaAdRelated.length < 24; i++) {
      const n = withAria[i];
      if (!isLikelyVisible(n)) continue;
      const al = n.getAttribute('aria-label') || '';
      if (al.length < 2 || al.length > 160) continue;
      if (!/\b(ad|advertisement|sponsor)\b/i.test(al)) continue;
      const c = cut(al, 140);
      if (!out.ariaAdRelated.includes(c)) out.ariaAdRelated.push(c);
    }
  } catch {
    /* ignore */
  }

  try {
    const nodes = surface.querySelectorAll('span, div, p, button, a');
    const cap = Math.min(nodes.length, 400);
    const textSeen = new Set();
    for (let i = 0; i < cap && out.shortTextHits.length < 24; i++) {
      const el = nodes[i];
      if (!isLikelyVisible(el)) continue;
      const t = cut((el.textContent || '').replace(/\s+/g, ' ').trim(), 64);
      if (t.length < 2 || t.length > 60) continue;
      if (
        !/^Advertisement\b/i.test(t) &&
        !/\bAd\s*\d{1,3}\s+of\s+\d{1,3}\b/i.test(t) &&
        !/\bAd\s*[·•]\s*\d/.test(t) &&
        !/\d:\d{2}\s*Ad\b/i.test(t) &&
        !(/^Ad\b/i.test(t) && /\d/.test(t)) &&
        !(/^Ad\b/i.test(t) && t.length >= 10) &&
        !(/^Ad$/i.test(t) && netflixAdsStripSupportsLoneAdLabel(surface))
      ) {
        continue;
      }
      if (textSeen.has(t)) continue;
      textSeen.add(t);
      out.shortTextHits.push(t);
    }
  } catch {
    /* ignore */
  }

  try {
    const all = surface.querySelectorAll('[class]');
    const seen = new Set();
    for (let i = 0; i < all.length && out.classNameAdHints.length < 30; i++) {
      const n = all[i];
      if (!isLikelyVisible(n)) continue;
      const cls = typeof n.className === 'string' ? n.className : '';
      if (!cls || cls.length < 4 || !/\bad/i.test(cls)) continue;
      const c = cut(cls.replace(/\s+/g, ' ').trim(), 120);
      if (!seen.has(c)) {
        seen.add(c);
        out.classNameAdHints.push(c);
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const idNodes = surface.querySelectorAll('[id]');
    for (let i = 0; i < idNodes.length && out.idAdHints.length < 16; i++) {
      const n = idNodes[i];
      if (!isLikelyVisible(n)) continue;
      const id = n.id ? cut(n.id, 80) : '';
      if (!id || !/\bad/i.test(id)) continue;
      if (!out.idAdHints.includes(id)) out.idAdHints.push(id);
    }
  } catch {
    /* ignore */
  }

  return out;
}

/**
 * Netflix: avoid flapping AD_BREAK_* (sidebar + room) on Cadmium; slightly slower enter than Prime.
 */
export const NETFLIX_AD_BREAK_MONITOR_OPTIONS = {
  debounceEnterMs: 550,
  debounceExitMs: 1800,
  enterConsecutiveSamples: 2,
  exitConsecutiveSamples: 5,
  minAdHoldMs: 2400
};

/**
 * Playback profile patch — merged in `platform-profiles.js` only on Netflix hosts.
 */
export function getNetflixPlaybackProfilePatch() {
  return {
    handlerKey: NETFLIX_SYNC_HANDLER_KEY,
    label: 'Netflix',
    /** Still uses passive viewer path (prompted apply), but logic is Netflix-scoped in app + adapter. */
    drmPassive: true,
    /** Never use multi-retry forcePlay/forcePause storms on Cadmium. */
    aggressiveRemoteSync: false,
    syncThresholdSoft: C.SYNC_THRESHOLD_NETFLIX,
    applyDebounceMs: C.SYNC_DEBOUNCE_MS,
    syncStateApplyDelayMs: 300,
    syncRequestDelayMs: 2000,
    /** Longer gaps reduce prompt spam (M7375 risk is partly “too much automation”). */
    drmPromptPlayMinIntervalMs: 9000,
    drmPromptPauseSeekMinIntervalMs: 9000,
    drmPromptSyncStateMinIntervalMs: 12000,
    drmReconcilePromptMinIntervalMs: 16000
  };
}
