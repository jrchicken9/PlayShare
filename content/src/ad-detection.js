import { detectPrimeVideoAd, isPrimeVideoHostname } from './sites/prime-video-sync.js';
import { detectNetflixAdPlaying, isNetflixHostname } from './sites/netflix-sync.js';

/**
 * Best-effort ad-break detection (DOM heuristics). Platforms change often — pair with manual controls.
 * @param {string} hostname
 * @param {HTMLVideoElement|null|undefined} video
 */
export function detectAdPlaying(hostname, video) {
  const h = (hostname || '').toLowerCase();
  try {
    if (isPrimeVideoHostname(h)) return detectPrimeVideoAd(video);
    if (isNetflixHostname(h)) return detectNetflixAdPlaying(video);
    if (/youtube\.com|youtu\.be/.test(h)) return detectYouTubeAd();
    if (/hulu\.com/.test(h)) return detectHuluAd();
    if (/crave\.ca/.test(h)) return detectCraveAd();
    if (/peacocktv\.com/.test(h)) return detectPeacockAd();
    if (video && video.closest && video.closest('[class*="ad-break" i], [class*="adbreak" i], [data-ad-state]')) {
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

function visibleEl(sel, root = document) {
  const el = root.querySelector(sel);
  if (!el) return false;
  const st = getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 4 && r.height > 4;
}

function detectYouTubeAd() {
  if (visibleEl('.ytp-ad-module')) return true;
  if (visibleEl('.ytp-ad-player-overlay')) return true;
  if (visibleEl('.ytp-ad-text-overlay')) return true;
  const player = document.querySelector('.html5-video-player');
  if (player && (player.classList.contains('ad-showing') || player.classList.contains('ytp-ad-mode'))) return true;
  return false;
}

function detectHuluAd() {
  return visibleEl('[data-testid="ad-ui"], .AdModule__container, [class*="AdBadge"]');
}

function detectCraveAd() {
  return visibleEl('[class*="advertisement" i], [class*="ad-break" i]');
}

function detectPeacockAd() {
  return visibleEl('[class*="AdSlot" i], [class*="ad-indicator" i]');
}

/**
 * @typedef {object} AdBreakMonitorOptions
 * @property {number} [debounceEnterMs]
 * @property {number} [debounceExitMs]
 * @property {number} [enterConsecutiveSamples] — raw “ad” reads in a row before enter debounce can start (default 1).
 * @property {number} [exitConsecutiveSamples] — raw “clear” reads in a row before exit debounce can start (default 1).
 * @property {number} [minAdHoldMs] — ignore exit debouncing until this long after enter (avoids “complete” during short UI flicker).
 * @property {(hostname: string, video: HTMLVideoElement|null|undefined) => boolean} [detectOverride]
 */

/**
 * Debounced enter/exit + consecutive sampling + optional min hold so “ad complete” is stable after DOM settles.
 * @param {string} hostname
 * @param {() => HTMLVideoElement|null|undefined} getVideo
 * @param {{ onEnter: () => void, onExit: () => void, debounceEnterMs?: number, debounceExitMs?: number }} callbacks
 * @param {AdBreakMonitorOptions} [monitorOptions]
 */
export function createAdBreakMonitor(hostname, getVideo, callbacks, monitorOptions = {}) {
  const debounceEnterMs =
    monitorOptions.debounceEnterMs ?? callbacks.debounceEnterMs ?? 650;
  const debounceExitMs =
    monitorOptions.debounceExitMs ?? callbacks.debounceExitMs ?? 900;
  const enterNeed = Math.max(1, monitorOptions.enterConsecutiveSamples ?? 1);
  const exitNeed = Math.max(1, monitorOptions.exitConsecutiveSamples ?? 1);
  const minAdHoldMs = Math.max(0, monitorOptions.minAdHoldMs ?? 0);

  let intervalId = null;
  let inAd = false;
  let enterT = null;
  let exitT = null;
  let consecOn = 0;
  let consecOff = 0;
  let adEnteredAt = 0;

  function rawDetect() {
    const video = getVideo();
    if (monitorOptions.detectOverride) {
      return monitorOptions.detectOverride(hostname, video);
    }
    return detectAdPlaying(hostname, video);
  }

  function clearEnter() {
    if (enterT) {
      clearTimeout(enterT);
      enterT = null;
    }
  }
  function clearExit() {
    if (exitT) {
      clearTimeout(exitT);
      exitT = null;
    }
  }

  function tick() {
    const ad = rawDetect();
    if (ad) {
      consecOn = Math.min(consecOn + 1, 99);
      consecOff = 0;
    } else {
      consecOff = Math.min(consecOff + 1, 99);
      consecOn = 0;
    }

    const enterArmed = consecOn >= enterNeed;
    const exitArmed = consecOff >= exitNeed;

    if (!inAd) {
      clearExit();
      if (enterArmed) {
        if (!enterT) {
          enterT = setTimeout(() => {
            enterT = null;
            if (inAd) return;
            if (!rawDetect()) return;
            inAd = true;
            adEnteredAt = Date.now();
            try {
              callbacks.onEnter();
            } catch {
              /* ignore */
            }
          }, debounceEnterMs);
        }
      } else {
        clearEnter();
      }
    } else {
      clearEnter();
      const holdOk = !minAdHoldMs || Date.now() - adEnteredAt >= minAdHoldMs;
      if (exitArmed && holdOk) {
        if (!exitT) {
          exitT = setTimeout(() => {
            exitT = null;
            if (!inAd) return;
            if (rawDetect()) return;
            inAd = false;
            try {
              callbacks.onExit();
            } catch {
              /* ignore */
            }
          }, debounceExitMs);
        }
      } else {
        clearExit();
      }
    }
  }

  return {
    start() {
      if (intervalId) return;
      // Prime (and others) often mount ad UI in the same tick as <video> attach; waiting 400ms
      // for the first interval loses the first sample and delays AD_BREAK_START after refresh.
      tick();
      try {
        setTimeout(tick, 100);
      } catch {
        /* ignore */
      }
      intervalId = setInterval(tick, 400);
    },
    stop() {
      clearEnter();
      clearExit();
      consecOn = 0;
      consecOff = 0;
      adEnteredAt = 0;
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      if (inAd) {
        inAd = false;
        try {
          callbacks.onExit();
        } catch {
          /* ignore */
        }
      }
    }
  };
}
