/**
 * Per-site playback / sync tuning (DRM-safe vs aggressive apply).
 */
import { contentConstants as C } from './constants.js';

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
  applyDelayPrime: C.APPLY_DELAY_PRIME
};

/**
 * @param {string} hostname
 * @param {string} pathname
 */
export function getPlaybackProfile(hostname, pathname) {
  const h = (hostname || '').toLowerCase();
  /** @type {typeof BASE} */
  let profile = { ...BASE };

  if (/netflix\.com/.test(h)) {
    profile = {
      ...profile,
      handlerKey: 'netflix',
      label: 'Netflix',
      drmPassive: true,
      syncThresholdSoft: C.SYNC_THRESHOLD_NETFLIX,
      applyDebounceMs: C.SYNC_DEBOUNCE_MS,
      syncStateApplyDelayMs: 300,
      syncRequestDelayMs: 2000
    };
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
  } else if (/primevideo\.com/.test(h) || /amazon\.(com|ca)/.test(h)) {
    profile = {
      ...profile,
      handlerKey: 'prime',
      label: 'Prime Video',
      /** Player often mounts before `duration` / readyState is final — pick best `<video>` earlier. */
      useRelaxedVideoReady: true,
      hostSeekSuppressAfterPlayMs: C.HOST_SEEK_SUPPRESS_AFTER_PLAY_MS_PRIME,
      syncRequestDelayMs: 900,
      /** Prime ignores a bare `video.play()` unless UI fallbacks run (see forcePlay). */
      aggressiveRemoteSync: true,
      syncStateApplyDelayMs: C.PRIME_SYNC_STATE_APPLY_DELAY_MS,
      applyDebounceMs: C.PRIME_APPLY_DEBOUNCE_MS,
      /** Looser seek / reconcile threshold than default 0.5s. */
      playbackSlackSec: C.SYNC_THRESHOLD_PRIME,
      timeJumpThresholdSec: C.PRIME_TIME_JUMP_THRESHOLD
    };
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
