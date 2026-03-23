/**
 * Per-site sync adapters — playback fallbacks, video picking, diagnostics.
 * Default adapter is a no-op; Prime (and future sites) supply overrides.
 *
 * Prime adapter: used only when `isPrimeVideoHostname(hostname)` is true (primevideo.com or
 * amazon.com/ca video hosts). The content script also exits early unless `isVideoPage()` — so
 * Prime-specific sync never runs on generic Amazon shopping pages or on Netflix/Disney/etc.
 */
import { isPrimeVideoHostname, primeSiteSyncAdapter } from './prime-video-sync.js';

/**
 * @typedef {object} SiteSyncAdapter
 * @property {string} key
 * @property {() => string[]} [getPriorityVideoSelectors]
 * @property {(v: HTMLVideoElement, score: number) => number} [adjustVideoCandidateScore]
 * @property {(v: HTMLVideoElement) => boolean} [shouldRefreshVideoCache]
 * @property {(v2: HTMLVideoElement, helpers: { dispatchSpaceKey: (el: Element|null|undefined) => void }) => void} [onStillPausedAfterAggressivePlay]
 * @property {(v2: HTMLVideoElement, helpers: { dispatchSpaceKey: (el: Element|null|undefined) => void }) => void} [onStillPlayingAfterAggressivePause]
 * @property {() => { level: string, text: string }[]} [extraDiagTips]
 */

/** @type {SiteSyncAdapter} */
const defaultSiteSyncAdapter = Object.freeze({
  key: 'default',
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
  return defaultSiteSyncAdapter;
}
