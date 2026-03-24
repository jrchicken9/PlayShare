/**
 * Central drift / correction tiers (platform-aware). Used by SyncDecisionEngine + reconcile.
 *
 * TEST / DEBUG CHECKLIST (manual):
 * - Two users, no ads: play / pause / seek stay aligned without seek thrash.
 * - One user reconnects mid-playback: reconnect_sync + settle; no immediate laggard fight.
 * - One user in ad, one not: server adMode isolates; exit issues one hard correction.
 * - Large spread enters adMode; convergence or timeout exits adMode.
 * - Netflix: micro-drift no-op, cooldown respected, no playbackRate soft nudge (drmPassive path).
 * - Prime / generic: small drift uses playbackRate soft band before hard seek.
 * - Reconnect settle prevents spread-like hard apply except join / reconnect_sync / authority reasons.
 */

/** Standard server + client `correctionReason` values for hard SYNC_STATE (keep in sync with server.js). */
export const CORRECTION_REASONS = Object.freeze({
  JOIN: 'join',
  LAGGARD_ANCHOR: 'laggard_anchor',
  AD_MODE_EXIT: 'ad_mode_exit',
  RECONNECT_SYNC: 'reconnect_sync',
  HOST_SEEK_SYNC: 'host_seek_sync',
  MANUAL_SYNC: 'manual_sync',
  HOST_ANCHOR_SOFT: 'host_anchor_soft'
});

/**
 * @param {string} handlerKey playbackProfile.handlerKey
 */
export function getDriftThresholds(handlerKey) {
  switch (handlerKey) {
    case 'netflix':
      return {
        enableSoftPlaybackRateDrift: false,
        ignoreBelow: 0.8,
        softBandMax: 1.8,
        hardAbove: 2.5,
        rateBehind: [1.02, 1.04],
        rateAhead: [0.96, 0.98],
        microSeekMin: 1.0,
        convergingEpsilon: 0.07
      };
    case 'prime':
      return {
        enableSoftPlaybackRateDrift: true,
        ignoreBelow: 0.5,
        softBandMax: 2.5,
        hardAbove: 2.5,
        rateBehind: [1.02, 1.05],
        rateAhead: [0.95, 0.98],
        microSeekMin: 0.65,
        convergingEpsilon: 0.08
      };
    default:
      return {
        enableSoftPlaybackRateDrift: true,
        ignoreBelow: 0.45,
        softBandMax: 2.5,
        hardAbove: 2.5,
        rateBehind: [1.02, 1.05],
        rateAhead: [0.95, 0.98],
        microSeekMin: 0.5,
        convergingEpsilon: 0.08
      };
  }
}

/**
 * @param {number} absDrift
 * @param {string} handlerKey
 * @returns {'ignore'|'soft'|'hard'}
 */
export function classifyDriftTier(absDrift, handlerKey) {
  const th = getDriftThresholds(handlerKey);
  if (absDrift < th.ignoreBelow) return 'ignore';
  if (absDrift <= th.softBandMax) return 'soft';
  return 'hard';
}
