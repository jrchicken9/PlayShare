/**
 * Netflix (Cadmium) — state-based multi-signal ad break detection.
 * Replaces polling `detectNetflixAdPlaying` for room AD_BREAK_*; does not use timeupdate jumps as a primary ad signal.
 */
import { detectNetflixAdPlaying } from './netflix-sync.js';

/** @typedef {'CONTENT' | 'AD'} NetflixAdPhase */

const USER_IDLE_MS = 800;
const MUTATION_THROTTLE_MS = 220;
const TICK_MS = 400;
const LOG_THROTTLE_MS = 2000;

const ENTER_CONFIDENCE = 0.7;
const EXIT_CONFIDENCE = 0.3;
const EXIT_MIN_HOLD_MS = 2000;

const SYSTEM_SEEK_WINDOW_MS = 4500;
const SHORT_SEGMENT_MEDIA_SEC = 45;
const SHORT_SEGMENT_BOOST_MS = 3500;

/**
 * @typedef {object} NetflixAdStateMachineOptions
 * @property {() => HTMLVideoElement|null|undefined} getVideo
 * @property {() => void} onEnterAd
 * @property {() => void} onExitAd
 * @property {(detail: Record<string, unknown>) => void} [log] — e.g. platformPlaybackLog
 */

/**
 * @param {NetflixAdStateMachineOptions} options
 */
export function createNetflixAdStateMachine(options) {
  const { getVideo, onEnterAd, onExitAd, log: logOptional } = options;

  /** @type {NetflixAdPhase} */
  let phase = 'CONTENT';
  let lastPhaseChangeAt = Date.now();
  let lastUserInteractionAt = Date.now();
  let lastCt = /** @type {number} */ (-1);
  let segmentMediaStart = /** @type {number|null} */ (null);
  let segmentWallStart = /** @type {number|null} */ (null);
  let systemSeekUntil = 0;
  let shortSegmentBoostUntil = 0;
  let lastConfidence = 0;
  /** @type {Record<string, number>} */
  let lastBreakdown = {};

  /** @type {ReturnType<typeof setInterval>|null} */
  let tickId = null;
  /** @type {MutationObserver|null} */
  let mo = null;
  let mutationThrottleTimer = 0;
  let lastLogAt = 0;

  /** @type {HTMLVideoElement|null} */
  let boundVideo = null;
  let onSeeking = /** @type {((this: HTMLVideoElement, ev: Event) => void) | null} */ (null);
  let onTu = /** @type {((this: HTMLVideoElement, ev: Event) => void) | null} */ (null);
  let onPlaying = /** @type {((this: HTMLVideoElement, ev: Event) => void) | null} */ (null);
  let onPause = /** @type {((this: HTMLVideoElement, ev: Event) => void) | null} */ (null);

  function isSystemDriven() {
    return Date.now() - lastUserInteractionAt > USER_IDLE_MS;
  }

  function bumpUserInteraction() {
    lastUserInteractionAt = Date.now();
  }

  /** @param {Event} e */
  function onUserIntentCapture(e) {
    try {
      const t = /** @type {Node|null} */ (e.target);
      if (t && t instanceof Element) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || t.closest?.('[contenteditable="true"]')) return;
      }
    } catch {
      /* ignore */
    }
    bumpUserInteraction();
  }

  function watchSurface() {
    return (
      document.querySelector('.watch-video--player-view') ||
      document.querySelector('.watch-video') ||
      document.getElementById('appMountPoint') ||
      document.body
    );
  }

  /**
   * Secondary text heuristic (scoped; throttled). Not used alone when structured detector fires.
   * @param {HTMLElement|Document|null} root
   */
  function detectNetflixAdTextHeuristic(root) {
    if (!root || !('innerText' in root)) return false;
    try {
      const t = String(root.innerText || '')
        .slice(0, 12000)
        .toLowerCase();
      if (!/\bad\b/.test(t)) return false;
      return (
        t.includes('resume') ||
        t.includes('second') ||
        t.includes('will resume') ||
        /\d+\s+of\s+\d+/.test(t) ||
        t.includes('advertisement')
      );
    } catch {
      return false;
    }
  }

  function computeConfidence() {
    const v = getVideo();
    const surface = watchSurface();
    const structured = !!(v && detectNetflixAdPlaying(v));
    const textBlob = detectNetflixAdTextHeuristic(surface instanceof HTMLElement ? surface : null);

    let score = 0;
    /** @type {Record<string, number>} */
    const breakdown = { structured: 0, textBlob: 0, systemSeek: 0, shortSegment: 0 };

    if (structured) {
      breakdown.structured = 0.7;
      score += 0.7;
    } else if (textBlob) {
      breakdown.textBlob = 0.55;
      score += 0.55;
    }

    const now = Date.now();
    if (now < systemSeekUntil) {
      breakdown.systemSeek = 0.3;
      score += 0.3;
    }
    if (now < shortSegmentBoostUntil) {
      breakdown.shortSegment = 0.2;
      score += 0.2;
    }

    score = Math.min(1, score);
    lastBreakdown = breakdown;
    lastConfidence = score;
    return score;
  }

  function updateAdState() {
    const conf = computeConfidence();
    const now = Date.now();

    if (phase === 'CONTENT') {
      if (conf >= ENTER_CONFIDENCE) {
        phase = 'AD';
        lastPhaseChangeAt = now;
        onEnterAd();
      }
    } else {
      const heldLongEnough = now - lastPhaseChangeAt >= EXIT_MIN_HOLD_MS;
      const low = conf < EXIT_CONFIDENCE;
      if (heldLongEnough && low) {
        phase = 'CONTENT';
        lastPhaseChangeAt = now;
        onExitAd();
      }
    }

    if (now - lastLogAt >= LOG_THROTTLE_MS) {
      lastLogAt = now;
      const payload = {
        state: phase,
        confidence: +conf.toFixed(2),
        breakdown: { ...lastBreakdown },
        systemDriven: isSystemDriven()
      };
      console.log('[AdDetection] state:', phase, 'confidence:', +conf.toFixed(2), 'breakdown:', { ...lastBreakdown });
      try {
        logOptional?.(payload);
      } catch {
        /* ignore */
      }
    }
  }

  function scheduleMutationTick() {
    if (mutationThrottleTimer) return;
    mutationThrottleTimer = window.setTimeout(() => {
      mutationThrottleTimer = 0;
      updateAdState();
    }, MUTATION_THROTTLE_MS);
  }

  function bindVideoListeners(v) {
    if (!v || boundVideo === v) return;
    unbindVideoListeners();

    boundVideo = v;
    lastCt = typeof v.currentTime === 'number' && Number.isFinite(v.currentTime) ? v.currentTime : -1;

    onTu = function onTuHandler() {
      const ct = this.currentTime;
      if (typeof ct === 'number' && Number.isFinite(ct)) lastCt = ct;
    };

    onSeeking = function onSeekingHandler() {
      const el = this;
      const to = el.currentTime;
      if (typeof to !== 'number' || !Number.isFinite(to) || typeof lastCt !== 'number' || lastCt < 0) return;
      const jump = Math.abs(to - lastCt);
      if (jump > 2 && isSystemDriven()) {
        systemSeekUntil = Date.now() + SYSTEM_SEEK_WINDOW_MS;
      }
    };

    onPlaying = function onPlayingHandler() {
      const el = this;
      if (isSystemDriven() && typeof el.currentTime === 'number' && Number.isFinite(el.currentTime)) {
        segmentMediaStart = el.currentTime;
        segmentWallStart = Date.now();
      }
    };

    onPause = function onPauseHandler() {
      const el = this;
      if (
        segmentMediaStart != null &&
        segmentWallStart != null &&
        typeof el.currentTime === 'number' &&
        Number.isFinite(el.currentTime) &&
        isSystemDriven() &&
        Math.abs((el.playbackRate || 1) - 1) < 0.05
      ) {
        const dur = el.currentTime - segmentMediaStart;
        if (dur > 0.5 && dur < SHORT_SEGMENT_MEDIA_SEC) {
          shortSegmentBoostUntil = Date.now() + SHORT_SEGMENT_BOOST_MS;
        }
      }
      segmentMediaStart = null;
      segmentWallStart = null;
    };

    v.addEventListener('timeupdate', onTu);
    v.addEventListener('seeking', onSeeking);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('pause', onPause);
  }

  function unbindVideoListeners() {
    if (boundVideo && onTu) {
      try {
        boundVideo.removeEventListener('timeupdate', onTu);
        boundVideo.removeEventListener('seeking', onSeeking);
        boundVideo.removeEventListener('playing', onPlaying);
        boundVideo.removeEventListener('pause', onPause);
      } catch {
        /* ignore */
      }
    }
    boundVideo = null;
    onSeeking = null;
    onTu = null;
    onPlaying = null;
    onPause = null;
  }

  const intentEvents = ['click', 'keydown', 'pointerdown', 'touchstart'];

  return {
    start() {
      this.stop();
      phase = 'CONTENT';
      lastPhaseChangeAt = Date.now();
      lastUserInteractionAt = Date.now();
      systemSeekUntil = 0;
      shortSegmentBoostUntil = 0;

      intentEvents.forEach((evt) => {
        document.addEventListener(evt, onUserIntentCapture, true);
      });

      try {
        mo = new MutationObserver(() => {
          scheduleMutationTick();
        });
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
      } catch {
        mo = null;
      }

      tickId = window.setInterval(() => {
        const v = getVideo();
        if (v) bindVideoListeners(v);
        updateAdState();
      }, TICK_MS);

      updateAdState();
    },

    stop() {
      if (tickId) {
        clearInterval(tickId);
        tickId = null;
      }
      if (mutationThrottleTimer) {
        clearTimeout(mutationThrottleTimer);
        mutationThrottleTimer = 0;
      }
      if (mo) {
        try {
          mo.disconnect();
        } catch {
          /* ignore */
        }
        mo = null;
      }
      intentEvents.forEach((evt) => {
        document.removeEventListener(evt, onUserIntentCapture, true);
      });
      unbindVideoListeners();
    },

    /** @returns {NetflixAdPhase} */
    getPhase() {
      return phase;
    },

    isAd() {
      return phase === 'AD';
    },

    getDebugSnapshot() {
      return {
        phase,
        confidence: lastConfidence,
        breakdown: { ...lastBreakdown },
        lastPhaseChangeAt,
        systemSeekUntil,
        shortSegmentBoostUntil
      };
    }
  };
}
