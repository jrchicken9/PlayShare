/**
 * Per-site playback / sync tuning (DRM-safe vs aggressive apply).
 */
import { contentConstants as C } from './constants.js';
import { getPrimePlaybackProfilePatch, isPrimeVideoHostname } from './sites/prime-video-sync.js';
import { getNetflixPlaybackProfilePatch, isNetflixHostname } from './sites/netflix-sync.js';

/** @typedef {ReturnType<typeof getPlaybackProfile>} PlaybackProfile */

const BASE = {
  handlerKey: 'default',
  label: 'Streaming',
  drmPassive: false,
  useRelaxedVideoReady: false,
  hostPositionIntervalMs: C.HOST_POSITION_INTERVAL_MS,
  viewerReconcileIntervalMs: C.SYNC_RECONCILE_INTERVAL_MS,
  hostSeekSuppressAfterPlayMs: C.HOST_SEEK_SUPPRESS_AFTER_PLAY_MS,
  drmDesyncThresholdSec: 2.5,
  syncThresholdSoft: C.SYNC_THRESHOLD,
  applyDebounceMs: 0,
  aggressiveRemoteSync: false,
  syncStateApplyDelayMs: 0,
  syncRequestDelayMs: 500,
  applyDelayNetflix: C.APPLY_DELAY_NETFLIX,
  applyDelayPrime: C.APPLY_DELAY_PRIME,
  /** 0 = send every local PLAY/PAUSE immediately. */
  playbackOutboundCoalesceMs: 0,
  pauseSeekOutboundPlaySuppressMs: C.PAUSE_SEEK_OUTBOUND_PLAY_SUPPRESS_MS
};

/**
 * @param {string} hostname
 * @param {string} pathname
 */
export function getPlaybackProfile(hostname, pathname) {
  const h = (hostname || '').toLowerCase();
  /** @type {typeof BASE} */
  let profile = { ...BASE };

  if (isNetflixHostname(h)) {
    profile = { ...profile, ...getNetflixPlaybackProfilePatch() };
  } else if (/disneyplus\.com/.test(h)) {
    profile = {
      ...profile,
      handlerKey: 'disney',
      label: 'Disney+',
      drmPassive: true,
      syncThresholdSoft: C.SYNC_THRESHOLD_NETFLIX,
      applyDebounceMs: C.SYNC_DEBOUNCE_MS,
      syncRequestDelayMs: 1500
    };
  } else if (isPrimeVideoHostname(h)) {
    /* Prime intervals, slack, debounce — only these hostnames; content script still requires isVideoPage(). */
    profile = { ...profile, ...getPrimePlaybackProfilePatch() };
  }

  return profile;
}

/**
 * @param {number|null|undefined} lastRtt
 * @param {PlaybackProfile} playbackProfile
 */
export function getApplyDelayMs(lastRtt, playbackProfile) {
  const forNetflix = playbackProfile.handlerKey === 'netflix';
  const forPrime = playbackProfile.handlerKey === 'prime';
  const platform = forNetflix ? playbackProfile.applyDelayNetflix : forPrime ? playbackProfile.applyDelayPrime : 0;
  return typeof lastRtt === 'number' && lastRtt > 0 && lastRtt < platform ? lastRtt : platform;
}
