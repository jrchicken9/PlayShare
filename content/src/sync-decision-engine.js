/**
 * SyncDecisionEngine — shared client “brain” for remote apply, drift soft-nudge, and policy gates.
 * Server remains authority for room adMode / spread (see server.js `runSpreadSyncPolicy`).
 *
 * Manual test checklist: see `sync-drift-config.js` top comment.
 */

/**
 * @typedef {'PLAY'|'PAUSE'|'SEEK'|'SYNC_STATE'} RemotePlaybackKind
 */

import {
  CORRECTION_REASONS,
  classifyDriftTier,
  getDriftThresholds
} from './sync-drift-config.js';

/** Hard corrections allowed during server `adMode` (isolation). */
const AD_MODE_ESSENTIAL_HARD = new Set([
  CORRECTION_REASONS.JOIN,
  CORRECTION_REASONS.AD_MODE_EXIT,
  CORRECTION_REASONS.LAGGARD_ANCHOR,
  CORRECTION_REASONS.RECONNECT_SYNC,
  CORRECTION_REASONS.MANUAL_SYNC,
  CORRECTION_REASONS.HOST_SEEK_SYNC
]);

const SOFT_DRIFT_TIMEOUT_MS = 4500;

/**
 * @param {object} opts
 * @param {() => object} opts.getSiteSyncAdapter
 * @param {() => string} opts.getHandlerKey
 * @param {() => object|null|undefined} [opts.getRoomSyncPolicy]
 * @param {() => boolean} [opts.getDrmPassive]
 */
export function createSyncDecisionEngine({
  getSiteSyncAdapter,
  getHandlerKey,
  getRoomSyncPolicy,
  getDrmPassive
}) {
  let lastRemoteApplyAt = 0;
  let lastRemoteTimelineMsgAt = 0;
  let clientReconnectSettleUntil = 0;
  /** @type {number[]} */
  const recentRemoteSeekTs = [];
  /** @type {number[]} */
  const driftAbsSamples = [];

  /** @type {{ active: boolean, rate: number, until: number, lastSign: number }} */
  let softDriftState = { active: false, rate: 1, until: 0, lastSign: 0 };

  function handlerKey() {
    try {
      return typeof getHandlerKey === 'function' ? String(getHandlerKey() || 'default') : 'default';
    } catch {
      return 'default';
    }
  }

  function roomPolicy() {
    try {
      return typeof getRoomSyncPolicy === 'function' ? getRoomSyncPolicy() : null;
    } catch {
      return null;
    }
  }

  function drmPassive() {
    try {
      return typeof getDrmPassive === 'function' ? !!getDrmPassive() : false;
    } catch {
      return false;
    }
  }

  function adapter() {
    try {
      return typeof getSiteSyncAdapter === 'function' ? getSiteSyncAdapter() : {};
    } catch {
      return {};
    }
  }

  function remoteIgnoreLocalMs() {
    const ms = adapter().remoteApplyIgnoreLocalMs;
    return typeof ms === 'number' && ms > 0 ? ms : 750;
  }

  function serverReconnectSettling() {
    const p = roomPolicy();
    const u = p && typeof p.reconnectSettleUntil === 'number' ? p.reconnectSettleUntil : 0;
    return u > 0 && Date.now() < u;
  }

  /**
   * @param {{ syncKind?: string, correctionReason?: string|null, fromRoomJoin?: boolean }} ctx
   */
  function isHardPriorityRemote(ctx = {}) {
    const cr = ctx.correctionReason;
    if (ctx.fromRoomJoin || cr === CORRECTION_REASONS.JOIN) return true;
    if (ctx.syncKind !== 'hard') return false;
    return (
      cr === CORRECTION_REASONS.AD_MODE_EXIT ||
      cr === CORRECTION_REASONS.LAGGARD_ANCHOR ||
      cr === CORRECTION_REASONS.RECONNECT_SYNC ||
      cr === CORRECTION_REASONS.MANUAL_SYNC ||
      cr === CORRECTION_REASONS.HOST_SEEK_SYNC
    );
  }

  function recordDriftSample(absDrift) {
    const x = typeof absDrift === 'number' && Number.isFinite(absDrift) ? absDrift : 0;
    driftAbsSamples.push(x);
    while (driftAbsSamples.length > 8) driftAbsSamples.shift();
  }

  /**
   * Generic convergence: drift shrinking or already within “close enough” with play agreement.
   * @param {{ absDrift: number, playMatches?: boolean }} ctx
   */
  function isAlreadyConverging(ctx) {
    const th = getDriftThresholds(handlerKey());
    const absDrift = ctx.absDrift;
    if (ctx.playMatches && absDrift < th.ignoreBelow * 1.15) return true;
    if (driftAbsSamples.length >= 2) {
      const a = driftAbsSamples[driftAbsSamples.length - 2];
      const b = driftAbsSamples[driftAbsSamples.length - 1];
      if (b < a - th.convergingEpsilon) return true;
    }
    return false;
  }

  /**
   * @param {object} ctx
   * @param {RemotePlaybackKind} ctx.kind
   * @param {string} [ctx.syncKind]
   * @param {string|null} [ctx.correctionReason]
   * @param {number} [ctx.driftSec]
   * @param {boolean} [ctx.isRedundantWithLocal]
   * @param {boolean} [ctx.fromRoomJoin]
   * @param {boolean} [ctx.playMatches]
   * @param {boolean} [ctx.hostAnchorSoft]
   */
  function shouldApplyRemoteState(ctx) {
    const hard = isHardPriorityRemote(ctx);
    const now = Date.now();
    const p = roomPolicy();
    const adMode = !!(p && p.adMode);

    if (adMode && ctx.syncKind === 'hard') {
      const cr = ctx.correctionReason;
      if (!cr || !AD_MODE_ESSENTIAL_HARD.has(String(cr))) {
        return { ok: false, reason: 'server_ad_mode' };
      }
    }

    const settling = now < clientReconnectSettleUntil || serverReconnectSettling();
    if (settling && !hard) {
      if (ctx.kind === 'SEEK' && typeof ctx.driftSec === 'number' && ctx.driftSec < 2.5) {
        return { ok: false, reason: 'reconnect_settle' };
      }
      if (ctx.kind === 'SYNC_STATE' && ctx.syncKind === 'soft') {
        return { ok: false, reason: 'reconnect_settle' };
      }
      if (ctx.isRedundantWithLocal) {
        return { ok: false, reason: 'reconnect_settle' };
      }
    }

    if (
      !hard &&
      (ctx.kind === 'SEEK' || ctx.kind === 'SYNC_STATE') &&
      typeof ctx.driftSec === 'number' &&
      isAlreadyConverging({ absDrift: ctx.driftSec, playMatches: ctx.playMatches })
    ) {
      return { ok: false, reason: 'already_converging' };
    }

    const cd = remoteIgnoreLocalMs();
    if (now - lastRemoteApplyAt < cd && !hard) {
      const th = getDriftThresholds(handlerKey());
      const relax =
        ctx.hostAnchorSoft && ctx.kind === 'SYNC_STATE' && ctx.syncKind === 'soft' && ctx.driftSec < 1.6;
      if (!relax && typeof ctx.driftSec === 'number' && ctx.driftSec < Math.max(5, th.hardAbove)) {
        return { ok: false, reason: 'apply_cooldown' };
      }
    }

    if (handlerKey() === 'netflix' && drmPassive() && !hard) {
      const th = getDriftThresholds('netflix');
      if (typeof ctx.driftSec === 'number' && ctx.driftSec < th.ignoreBelow && ctx.playMatches) {
        return { ok: false, reason: 'netflix_safety_noop' };
      }
    }

    return { ok: true, reason: 'allow' };
  }

  /**
   * @param {{ sentAt?: number, serverTime?: number }} [meta]
   */
  function noteRemoteApply(meta = {}) {
    lastRemoteApplyAt = Date.now();
    const t = meta.sentAt ?? meta.serverTime;
    if (typeof t === 'number' && t > 0) {
      lastRemoteTimelineMsgAt = Math.max(lastRemoteTimelineMsgAt, t);
    }
    softDriftState = { active: false, rate: 1, until: 0, lastSign: 0 };
  }

  function shouldSuppressLocalPlaybackOutbound() {
    return Date.now() - lastRemoteApplyAt < remoteIgnoreLocalMs();
  }

  /**
   * @param {{ sentAt?: number }} msg
   */
  function shouldAcceptRoomSyncTick(msg) {
    if (!msg || typeof msg.sentAt !== 'number') return true;
    return msg.sentAt >= lastRemoteTimelineMsgAt - 400;
  }

  /**
   * Micro / burst seek gate: central threshold + adapter caps.
   * @param {number} deltaSec local - remote
   */
  function shouldApplyRemoteSeek(deltaSec) {
    const th = getDriftThresholds(handlerKey());
    const micro = th.microSeekMin;
    if (micro > 0 && Math.abs(deltaSec) < micro) {
      return { ok: false, reason: 'micro_correction' };
    }
    const a = adapter();
    const win = a.rapidSeekRejectWindowMs;
    const max = a.rapidSeekMaxInWindow;
    if (typeof win === 'number' && win > 0 && typeof max === 'number' && max > 0) {
      const now = Date.now();
      while (recentRemoteSeekTs.length && now - recentRemoteSeekTs[0] > win) {
        recentRemoteSeekTs.shift();
      }
      if (recentRemoteSeekTs.length >= max) {
        return { ok: false, reason: 'rapid_seek' };
      }
    }
    return { ok: true, reason: null };
  }

  function recordRemoteSeekCommitted() {
    recentRemoteSeekTs.push(Date.now());
  }

  /** @param {HTMLVideoElement|null|undefined} v */
  function shouldSkipSeekWhileVideoSeeking(v) {
    if (!adapter().skipRemoteSeekWhileVideoSeeking) return false;
    try {
      return !!(v && v.seeking);
    } catch {
      return false;
    }
  }

  function beginReconnectSettle(ms = 5000) {
    clientReconnectSettleUntil = Date.now() + ms;
  }

  function isReconnectSettling() {
    return Date.now() < clientReconnectSettleUntil;
  }

  /**
   * One decision per reconcile tick: soft playbackRate nudge or hold or reset.
   * @param {{ driftSigned: number, hostPlaying: boolean, videoPaused: boolean }} ctx
   * @returns {{ action: 'none'|'start'|'hold'|'reset', rate?: number, absDrift?: number, log?: string }}
   */
  function tickSoftDriftPlaybackRate(ctx) {
    const th = getDriftThresholds(handlerKey());
    const p = roomPolicy();
    const adMode = !!(p && p.adMode);
    const now = Date.now();

    const disable =
      !th.enableSoftPlaybackRateDrift ||
      adMode ||
      isReconnectSettling() ||
      serverReconnectSettling() ||
      ctx.videoPaused ||
      !ctx.hostPlaying;

    if (disable) {
      if (softDriftState.active) {
        softDriftState = { active: false, rate: 1, until: 0, lastSign: 0 };
        return { action: 'reset', log: 'policy_or_pause' };
      }
      return { action: 'none' };
    }

    const adrift = Math.abs(ctx.driftSigned);
    const softFloor = Math.max(0.4, th.ignoreBelow);
    if (adrift < softFloor) {
      if (softDriftState.active) {
        softDriftState = { active: false, rate: 1, until: 0, lastSign: 0 };
        return { action: 'reset', log: 'below_soft_floor', absDrift: adrift };
      }
      return { action: 'none' };
    }

    if (adrift > th.softBandMax) {
      if (softDriftState.active) {
        softDriftState = { active: false, rate: 1, until: 0, lastSign: 0 };
        return { action: 'reset', log: 'hard_band', absDrift: adrift };
      }
      return { action: 'none' };
    }

    const sign = ctx.driftSigned > 0 ? 1 : ctx.driftSigned < 0 ? -1 : 0;
    if (sign === 0) return { action: 'none' };

    const [rLo, rHi] = sign > 0 ? th.rateAhead : th.rateBehind;
    const wantRate = (rLo + rHi) / 2;

    if (softDriftState.active && softDriftState.lastSign === sign && now < softDriftState.until) {
      return { action: 'hold', rate: softDriftState.rate, absDrift: adrift };
    }

    softDriftState = {
      active: true,
      rate: wantRate,
      until: now + SOFT_DRIFT_TIMEOUT_MS,
      lastSign: sign
    };
    return { action: 'start', rate: wantRate, absDrift: adrift };
  }

  function resetSession() {
    lastRemoteApplyAt = 0;
    lastRemoteTimelineMsgAt = 0;
    clientReconnectSettleUntil = 0;
    recentRemoteSeekTs.length = 0;
    driftAbsSamples.length = 0;
    softDriftState = { active: false, rate: 1, until: 0, lastSign: 0 };
  }

  return {
    CORRECTION_REASONS,
    classifyDriftTier: (absDrift) => classifyDriftTier(absDrift, handlerKey()),
    getDriftThresholds: () => getDriftThresholds(handlerKey()),
    isHardPriorityRemote,
    isAlreadyConverging,
    recordDriftSample,
    shouldApplyRemoteState,
    noteRemoteApply,
    shouldSuppressLocalPlaybackOutbound,
    shouldAcceptRoomSyncTick,
    shouldApplyRemoteSeek,
    recordRemoteSeekCommitted,
    shouldSkipSeekWhileVideoSeeking,
    beginReconnectSettle,
    isReconnectSettling,
    serverReconnectSettling,
    tickSoftDriftPlaybackRate,
    resetSession
  };
}
