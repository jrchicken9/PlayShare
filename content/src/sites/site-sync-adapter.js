/**
 * Per-site sync adapters — playback fallbacks, video picking, diagnostics.
 * Default adapter is a no-op; Prime (and future sites) supply overrides.
 *
 * Prime adapter: `isPrimeVideoHostname(hostname)`. Netflix adapter: `isNetflixHostname(hostname)`
 * (Cadmium-specific video picking + UI fallbacks). The content script exits early unless
 * `isVideoPage()` so these never run on the wrong paths.
 */
import { isPrimeVideoHostname, primeSiteSyncAdapter } from './prime-video-sync.js';
import { isNetflixHostname, netflixSiteSyncAdapter } from './netflix-sync.js';

/**
 * @typedef {'HIGH'|'MEDIUM'|'LOW'} SyncConfidenceLevel
 * @typedef {object} SiteSyncAdapter
 * @property {string} key
 * @property {() => string[]} [getPriorityVideoSelectors]
 * @property {(v: HTMLVideoElement, score: number) => number} [adjustVideoCandidateScore]
 * @property {(v: HTMLVideoElement) => boolean} [shouldRefreshVideoCache]
 * @property {(v2: HTMLVideoElement, helpers: { dispatchSpaceKey: (el: Element|null|undefined) => void }) => void} [onStillPausedAfterAggressivePlay]
 * @property {(v2: HTMLVideoElement, helpers: { dispatchSpaceKey: (el: Element|null|undefined) => void }) => void} [onStillPlayingAfterAggressivePause]
 * @property {() => { level: string, text: string }[]} [extraDiagTips]
 * @property {(ctx: { video?: HTMLVideoElement|null }) => SyncConfidenceLevel} [getPlaybackConfidence]
 * @property {number} [remoteApplyIgnoreLocalMs] after remote apply, ignore local→room playback wires for this long
 * @property {number} [microCorrectionIgnoreSec] skip remote seeks smaller than this (Netflix/Prime)
 * @property {number} [rapidSeekRejectWindowMs] rolling window for seek burst cap
 * @property {number} [rapidSeekMaxInWindow] max seeks per window
 * @property {boolean} [skipRemoteSeekWhileVideoSeeking] defer remote seek while `<video>.seeking`
 */

/** @type {SiteSyncAdapter} */
const defaultSiteSyncAdapter = Object.freeze({
  key: 'default',
  getPlaybackConfidence: () => 'MEDIUM',
  remoteApplyIgnoreLocalMs: 700,
  adjustVideoCandidateScore: undefined,
  shouldRefreshVideoCache: undefined,
  onStillPausedAfterAggressivePlay: undefined,
  onStillPlayingAfterAggressivePause: undefined,
  extraDiagTips: undefined
});

/**
 * Prime vs default: `isPrimeVideoHostname(hostname)`. Content script only runs on `isVideoPage()`, so
 * Prime sync is not used on arbitrary amazon.com pages.
 *
 * @param {string} hostname
 * @param {string} [_pathname] reserved for path-scoped rules (e.g. amazon retail vs video)
 * @returns {SiteSyncAdapter}
 */
export function getSiteSyncAdapter(hostname, _pathname = '') {
  if (isPrimeVideoHostname(hostname)) return primeSiteSyncAdapter;
  if (isNetflixHostname(hostname)) return netflixSiteSyncAdapter;
  return defaultSiteSyncAdapter;
}
