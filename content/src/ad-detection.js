/**
 * Best-effort ad-break detection (DOM heuristics). Platforms change often — pair with manual controls.
 * @param {string} hostname
 * @param {HTMLVideoElement|null|undefined} video
 */
export function detectAdPlaying(hostname, video) {
  const h = (hostname || '').toLowerCase();
  try {
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
 * Debounced enter/exit to avoid flicker from DOM churn.
 * @param {string} hostname
 * @param {() => HTMLVideoElement|null|undefined} getVideo
 * @param {{ onEnter: () => void, onExit: () => void, debounceEnterMs?: number, debounceExitMs?: number }} callbacks
 */
export function createAdBreakMonitor(hostname, getVideo, callbacks) {
  const debounceEnterMs = callbacks.debounceEnterMs ?? 650;
  const debounceExitMs = callbacks.debounceExitMs ?? 900;
  let intervalId = null;
  let inAd = false;
  let enterT = null;
  let exitT = null;

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
    const ad = detectAdPlaying(hostname, getVideo());
    if (ad) {
      clearExit();
      if (!inAd && !enterT) {
        enterT = setTimeout(() => {
          enterT = null;
          if (!inAd) {
            inAd = true;
            try {
              callbacks.onEnter();
            } catch { /* ignore */ }
          }
        }, debounceEnterMs);
      }
    } else {
      clearEnter();
      if (inAd && !exitT) {
        exitT = setTimeout(() => {
          exitT = null;
          if (inAd) {
            inAd = false;
            try {
              callbacks.onExit();
            } catch { /* ignore */ }
          }
        }, debounceExitMs);
      }
    }
  }

  return {
    start() {
      if (intervalId) return;
      intervalId = setInterval(tick, 400);
    },
    stop() {
      clearEnter();
      clearExit();
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      if (inAd) {
        inAd = false;
        try {
          callbacks.onExit();
        } catch { /* ignore */ }
      }
    }
  };
}
