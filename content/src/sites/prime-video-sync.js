/**
 * Dedicated Prime Video sync — playback tuning, ad heuristics, and control fallbacks.
 * Central place to refine behavior without scattering `handlerKey === 'prime'` checks.
 */
import { contentConstants as C } from '../constants.js';

export const PRIME_SYNC_HANDLER_KEY = 'prime';

/** Popup + content script: enable floating Prime telemetry HUD. */
export const PRIME_SYNC_DEBUG_STORAGE_KEY = 'primeSyncDebugHud';

/** Tried first in findVideo (Amazon player shell before generic `video`). */
export const PRIME_PRIORITY_VIDEO_SELECTORS = [
  '.atvwebplayersdk-video-canvas video',
  '.atvwebplayersdk-player-container video',
  '.webPlayerInner video'
];

/**
 * @param {string} [hostname]
 */
export function isPrimeVideoHostname(hostname) {
  const h = (hostname || '').toLowerCase();
  return /primevideo\.com/.test(h) || /amazon\.(com|ca)/.test(h);
}

/**
 * Fields merged into the shared playback profile (see platform-profiles.js).
 */
export function getPrimePlaybackProfilePatch() {
  return {
    handlerKey: PRIME_SYNC_HANDLER_KEY,
    label: 'Prime Video',
    useRelaxedVideoReady: true,
    hostPositionIntervalMs: C.PRIME_HOST_POSITION_INTERVAL_MS,
    viewerReconcileIntervalMs: C.PRIME_VIEWER_RECONCILE_INTERVAL_MS,
    hostSeekSuppressAfterPlayMs: C.HOST_SEEK_SUPPRESS_AFTER_PLAY_MS_PRIME,
    syncRequestDelayMs: 900,
    aggressiveRemoteSync: true,
    syncStateApplyDelayMs: C.PRIME_SYNC_STATE_APPLY_DELAY_MS,
    applyDebounceMs: C.PRIME_APPLY_DEBOUNCE_MS,
    playbackOutboundCoalesceMs: C.PRIME_PLAYBACK_OUTBOUND_COALESCE_MS,
    playbackSlackSec: C.SYNC_THRESHOLD_PRIME,
    timeJumpThresholdSec: C.PRIME_TIME_JUMP_THRESHOLD,
    pauseSeekOutboundPlaySuppressMs: C.PRIME_PAUSE_SEEK_OUTBOUND_PLAY_SUPPRESS_MS
  };
}

/**
 * Amazon does not document a public “ad break” API on the web player. We only treat an ad as
 * active when we see the same cues the viewer sees: Amazon’s in-player ad timer (`atvwebplayersdk-ad-timer*`),
 * “Go ad free”, older adtimeindicator copy, skip/ad controls, or unambiguous Media Session metadata.
 * Broad page-wide `class*=ad` is not used for AD_BREAK (noisy on Prime storefront chrome).
 */

/** @param {Element|null|undefined} el */
function isVisible(el) {
  if (!el || el.nodeType !== 1) return false;
  try {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  } catch {
    return false;
  }
}

function primePlayerShellRoot() {
  try {
    return (
      document.querySelector('.atvwebplayersdk-player-container') ||
      document.querySelector('[class*="atvwebplayersdk-player" i]')
    );
  } catch {
    return null;
  }
}

/** Subtitle / CC lines can mention “resume”, “back in …”, etc. — never treat as ad UI. */
function isPrimeCaptionsSubtree(el) {
  try {
    return !!el.closest?.(
      '.atvwebplayersdk-captions-overlay, [class*="atvwebplayersdk-captions" i], .atvwebplayersdk-text-track-container'
    );
  } catch {
    return false;
  }
}

/**
 * Prime shows copy like “Your program resumes in …” in ad-time UI (see public write-ups / user scripts).
 */
function channelAdCountdownUi() {
  try {
    const nodes = document.querySelectorAll(
      '[class*="adtimeindicator" i], [class*="AdTimeIndicator" i], .atvwebplayersdk-adtimeindicator-text'
    );
    for (const el of nodes) {
      if (isPrimeCaptionsSubtree(el)) continue;
      if (!isVisible(el)) continue;
      const t = (el.textContent || '').trim().toLowerCase();
      if (!t) continue;
      if (
        /resume|program|continue|back (soon|in|shortly)|will return|ends in|return(s)? in|\d+\s*:\s*\d|:\d{2}\b|\d+\s*(s|sec|seconds)\b/.test(
          t
        )
      ) {
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Current Prime web UI (2025+): visible ad countdown blocks like `atvwebplayersdk-ad-timer` with
 * text “Ad2:02” and aria-label “Ad playing. Content resumes in …”, plus `atvwebplayersdk-go-ad-free-button`.
 */
function channelPrimeAdTimerChrome() {
  try {
    const selectors = [
      '[class*="atvwebplayersdk-ad-timer" i]',
      '[class*="atvwebplayersdk-go-ad-free" i]'
    ];
    const seen = new Set();
    for (const sel of selectors) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const el of nodes) {
        if (!(el instanceof Element) || seen.has(el)) continue;
        seen.add(el);
        if (isPrimeCaptionsSubtree(el)) continue;
        if (!isVisible(el)) continue;
        const al = (el.getAttribute('aria-label') || '').toLowerCase();
        if (/\bad playing\b/.test(al)) return true;
        const compact = (el.textContent || '')
          .replace(/\s+/g, '')
          .toLowerCase();
        // “Ad0:48”, “Ad1:02”, “Ad12:05” (pre-roll after refresh often uses Ad0:mm)
        if (/^ad\d+:\d{2}/.test(compact)) return true;
        if (/goadfree/.test(compact)) return true;
        const cls = typeof el.className === 'string' ? el.className : el.classList ? [...el.classList].join(' ') : '';
        if (/atvwebplayersdk-go-ad-free/i.test(cls)) return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Skip / Advertisement controls are only counted inside the main player shell (not site chrome).
 */
function channelPlayerAdControls() {
  const root = primePlayerShellRoot();
  if (!root) return false;
  try {
    const nodes = root.querySelectorAll('button, [role="button"]');
    for (const el of nodes) {
      if (isPrimeCaptionsSubtree(el)) continue;
      if (!isVisible(el)) continue;
      const al = (el.getAttribute('aria-label') || '').toLowerCase();
      if (!al) continue;
      if (/\bskip\b.*\bad\b|^skip ad|\bskip ads\b|\badvertisement\b/.test(al)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * When the site sets OS media metadata during ads, title is often literally “Advertisement” or “Ad N of M”.
 */
function channelMediaSessionAd() {
  try {
    const m = navigator.mediaSession?.metadata;
    if (!m) return false;
    const title = String(m.title || '').trim();
    const artist = String(m.artist || '').trim();
    if (!title && !artist) return false;
    if (/^advertisement[s]?$/i.test(title)) return true;
    if (/^commercial(\s|$)/i.test(title)) return true;
    if (/^ad\s*\d+\s*of\s*\d+/i.test(title)) return true;
    if (/^\(\s*ad\s*\)/i.test(title)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * @param {HTMLVideoElement|null|undefined} _video unused — kept for API stability with callers
 * @returns {{
 *   likelyAd: boolean,
 *   authoritativeInAd: boolean,
 *   score: number,
 *   reasons: string[],
 *   hasStrong: boolean,
 *   channels: { adCountdownUi: boolean, adTimerUi: boolean, playerAdControls: boolean, mediaSession: boolean }
 * }}
 */
export function getPrimeAdDetectionSnapshot(_video) {
  /** @type {{ adCountdownUi: boolean, adTimerUi: boolean, playerAdControls: boolean, mediaSession: boolean }} */
  const channels = {
    adCountdownUi: channelAdCountdownUi(),
    adTimerUi: channelPrimeAdTimerChrome(),
    playerAdControls: channelPlayerAdControls(),
    mediaSession: channelMediaSessionAd()
  };
  const reasons = /** @type {string[]} */ (
    Object.entries(channels)
      .filter(([, on]) => on)
      .map(([k]) => k)
  );
  const authoritativeInAd = reasons.length > 0;
  return {
    likelyAd: authoritativeInAd,
    authoritativeInAd,
    score: reasons.length,
    reasons,
    hasStrong: authoritativeInAd,
    channels
  };
}

/**
 * @param {HTMLVideoElement|null|undefined} video
 */
export function detectPrimeVideoAd(video) {
  return getPrimeAdDetectionSnapshot(video).likelyAd;
}

/**
 * @param {HTMLVideoElement|null|undefined} video
 * @returns {'HIGH'|'MEDIUM'|'LOW'}
 */
export function getPrimePlaybackConfidence(video) {
  if (!video || video.tagName !== 'VIDEO') return 'LOW';
  if (getPrimeAdDetectionSnapshot(video).likelyAd) return 'LOW';
  try {
    if (video.seeking) return 'LOW';
  } catch {
    /* ignore */
  }
  return 'HIGH';
}

/**
 * @param {Element|null} root
 * @param {{ maxNodes?: number, maxDepth?: number }} opts
 */
function summarizePlayerShell(root, opts = {}) {
  const maxNodes = opts.maxNodes ?? 90;
  const maxDepth = opts.maxDepth ?? 14;
  if (!root) return null;
  const nodes = [];
  let count = 0;
  function walk(el, depth) {
    if (!el || el.nodeType !== 1 || count >= maxNodes || depth > maxDepth) return;
    count++;
    let cls = '';
    try {
      if (typeof el.className === 'string') cls = el.className;
      else if (el.classList) cls = [...el.classList].join(' ');
      else if (el.className && typeof el.className.baseVal === 'string') cls = el.className.baseVal;
    } catch {
      cls = '';
    }
    const al = el.getAttribute('aria-label');
    const tid = el.getAttribute('data-testid');
    let textLeaf = '';
    if (el.childNodes.length === 1 && el.firstChild?.nodeType === 3) {
      textLeaf = String(el.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140);
    }
    nodes.push({
      depth,
      tag: el.tagName?.toLowerCase(),
      class: cls.slice(0, 220),
      ariaLabel: al ? String(al).slice(0, 220) : undefined,
      dataTestId: tid ? String(tid).slice(0, 120) : undefined,
      textLeaf: textLeaf || undefined,
      visible: isVisible(el)
    });
    for (const ch of el.children) {
      walk(ch, depth + 1);
      if (count >= maxNodes) return;
    }
  }
  walk(root, 0);
  return { truncated: count >= maxNodes, nodeCount: count, nodes };
}

/**
 * Pull a few human-visible strings from the player shell so exports match what the user saw
 * (title, captions) without searching `playerShellDigest.nodes`.
 * @param {Element|null} shell
 */
function extractPrimePlayerUiSummary(shell) {
  if (!shell) return null;
  /** @type {{ titleText: string|null, captionSnippet: string|null, loadingOverlayVisible: boolean|null }} */
  const out = { titleText: null, captionSnippet: null, loadingOverlayVisible: null };
  try {
    const t = shell.querySelector('.atvwebplayersdk-title-text, [class*="atvwebplayersdk-title-text"]');
    if (t) {
      const s = String(t.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220);
      if (s) out.titleText = s;
    }
  } catch {
    /* ignore */
  }
  try {
    const c = shell.querySelector('.atvwebplayersdk-captions-text, [class*="atvwebplayersdk-captions-text"]');
    if (c) {
      const s = String(c.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 280);
      if (s) out.captionSnippet = s;
    }
  } catch {
    /* ignore */
  }
  try {
    const sp = shell.querySelector('.atvwebplayersdk-loadingspinner-overlay, [class*="loadingspinner-overlay"]');
    out.loadingOverlayVisible = sp ? isVisible(sp) : null;
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * Short, ticket-friendly notes derived from extension state + video census (not in raw DOM walk).
 * @param {object} ctx
 * @param {HTMLVideoElement|null|undefined} v
 * @param {ReturnType<typeof collectPrimeVideoCandidates>|null} videoCandidates
 */
function derivePrimeSyncDebugNotes(ctx, v, videoCandidates) {
  /** @type {{ code: string, detail: string, [k: string]: unknown }[]} */
  const notes = [];
  const pv = videoCandidates?.pageVideos || [];
  const inShell = pv.filter((x) => x.inMainSdkShell);
  const playing = inShell.filter((x) => !x.paused);
  const paused = inShell.filter((x) => x.paused);
  if (inShell.length >= 2 && playing.length >= 1 && paused.length >= 1) {
    notes.push({
      code: 'prime_multi_video_mixed_state',
      detail: `${inShell.length} <video> near main shell (${playing.length} playing, ${paused.length} paused). Confirm findVideo() uses the playing element.`,
      pageVideoIndices: { playing: playing.map((x) => x.index), paused: paused.map((x) => x.index) }
    });
  }
  const la = ctx.lastAppliedState;
  if (la && v && v.tagName === 'VIDEO') {
    try {
      const dt = Math.abs(v.currentTime - (Number(la.currentTime) || 0));
      const playMismatch = Boolean(la.playing) !== !v.paused;
      if (playMismatch || dt > 3) {
        notes.push({
          code: 'extension_state_vs_video_mismatch',
          detail: `lastAppliedState t=${la.currentTime} playing=${la.playing} vs video t=${v.currentTime.toFixed(2)} paused=${v.paused}.`,
          deltaSec: +dt.toFixed(2),
          playMismatch,
          lastSyncAtAgeMs:
            typeof ctx.lastSyncAt === 'number' && ctx.lastSyncAt > 1 ? Date.now() - ctx.lastSyncAt : null
        });
      }
    } catch {
      /* ignore */
    }
  }
  if (typeof ctx.lastSyncAt === 'number' && ctx.lastSyncAt > 1) {
    const age = Date.now() - ctx.lastSyncAt;
    if (age > 15000) {
      notes.push({
        code: 'sync_apply_stale',
        detail: `No SYNC_STATE apply in ~${Math.round(age / 1000)}s (extension lastAppliedState may lag).`
      });
    }
  }
  const fm = ctx.frameCaptureMeta;
  if (fm?.attempted && fm?.likelyDrmBlackOrBlank) {
    notes.push({
      code: 'frame_png_likely_drm_blank',
      detail: 'Attached frame PNG is often solid black under Widevine; use title/caption/video timings here instead of pixels.'
    });
  }
  return { notes };
}

/**
 * Elements that might be ad UI but are not yet wired into authoritative detection.
 */
function collectAdRelatedHints() {
  const selectors = [
    '[class*="ad" i]',
    '[class*="Ad" i]',
    '[aria-label*="ad" i]',
    '[data-testid*="ad" i]',
    '[data-testid*="Ad" i]'
  ];
  const seen = new Set();
  const rows = [];
  try {
    for (const sel of selectors) {
      let els;
      try {
        els = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const el of els) {
        if (!(el instanceof Element) || seen.has(el) || rows.length >= 45) continue;
        seen.add(el);
        const inShell = !!el.closest?.(
          '.atvwebplayersdk-player-container, [class*="atvwebplayersdk" i], .webPlayerInner'
        );
        rows.push({
          matchedBy: sel,
          tag: el.tagName?.toLowerCase(),
          class: String(el.className || '').slice(0, 180),
          ariaLabel: el.getAttribute('aria-label')?.slice(0, 180),
          dataTestId: el.getAttribute('data-testid')?.slice(0, 120),
          textPreview: String(el.textContent || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120),
          visible: isVisible(el),
          inPlayerOrSdk: inShell
        });
      }
    }
  } catch {
    /* ignore */
  }
  return rows;
}

/** @param {HTMLVideoElement} v */
function safeVideoSrcSummary(v) {
  try {
    const s = v.currentSrc || v.src || '';
    if (!s) return null;
    if (s.startsWith('blob:')) return 'blob:…';
    if (s.length > 120) return `${s.slice(0, 80)}…`;
    return s;
  } catch {
    return null;
  }
}

/** @param {Element} el */
function rectSummary(el) {
  try {
    const r = el.getBoundingClientRect();
    return {
      x: +r.x.toFixed(0),
      y: +r.y.toFixed(0),
      w: +r.width.toFixed(0),
      h: +r.height.toFixed(0)
    };
  } catch {
    return null;
  }
}

/**
 * @param {HTMLVideoElement|null|undefined} v
 */
function videoElementSyncDigest(v) {
  if (!v || v.tagName !== 'VIDEO') return null;
  /** @type {number[][]} */
  const bufferedRanges = [];
  try {
    const b = v.buffered;
    for (let i = 0; i < b.length; i++) {
      bufferedRanges.push([+b.start(i).toFixed(2), +b.end(i).toFixed(2)]);
    }
  } catch {
    /* ignore */
  }
  try {
    return {
      inMainSdkShell: isPrimeMainPlayerShell(v),
      paused: v.paused,
      ended: v.ended,
      muted: v.muted,
      volume: v.volume,
      playbackRate: v.playbackRate,
      currentTime: +v.currentTime.toFixed(3),
      duration: v.duration && !isNaN(v.duration) ? +v.duration.toFixed(2) : null,
      readyState: v.readyState,
      networkState: v.networkState,
      seeking: v.seeking,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      clientWidth: v.clientWidth,
      clientHeight: v.clientHeight,
      rect: rectSummary(v),
      currentSrcSummary: safeVideoSrcSummary(v),
      bufferedRanges: bufferedRanges.slice(0, 24)
    };
  } catch {
    return null;
  }
}

/**
 * @param {HTMLVideoElement} el
 * @param {number} [index]
 */
function videoCandidateLite(el, index) {
  return {
    index,
    inMainSdkShell: isPrimeMainPlayerShell(el),
    paused: el.paused,
    currentTime: +el.currentTime.toFixed(2),
    rect: rectSummary(el),
    visible: isVisible(el),
    videoWxH: el.videoWidth && el.videoHeight ? `${el.videoWidth}×${el.videoHeight}` : null
  };
}

function collectPrimeVideoCandidates(getVideo) {
  /** @type {{ selector: string } & ReturnType<typeof videoCandidateLite>} */
  const priorityMatches = [];
  for (const sel of PRIME_PRIORITY_VIDEO_SELECTORS) {
    try {
      const el = document.querySelector(sel);
      if (el && el.tagName === 'VIDEO') priorityMatches.push({ selector: sel, ...videoCandidateLite(el) });
    } catch {
      /* ignore */
    }
  }
  const shell = primePlayerShellRoot();
  if (priorityMatches.length === 0 && shell) {
    let gi = 0;
    try {
      for (const el of document.querySelectorAll('video')) {
        if (!(el instanceof HTMLVideoElement)) continue;
        if (videoGeometricallyAlignedWithPrimeShell(el, shell)) {
          priorityMatches.push({
            selector: '__primeShellGeometry__',
            ...videoCandidateLite(el, gi++)
          });
        }
      }
    } catch {
      /* ignore */
    }
  }
  const pageVideos = [];
  try {
    let i = 0;
    for (const el of document.querySelectorAll('video')) {
      if (i >= 14) break;
      if (el instanceof HTMLVideoElement) pageVideos.push(videoCandidateLite(el, i));
      i++;
    }
  } catch {
    /* ignore */
  }
  const gv = typeof getVideo === 'function' ? getVideo() : null;
  return {
    priorityMatches,
    pageVideos,
    primaryDigest: gv && gv.tagName === 'VIDEO' ? videoElementSyncDigest(gv) : null
  };
}

function collectPlaybackControlHints() {
  const root = primePlayerShellRoot();
  if (!root) return [];
  const hints = [];
  try {
    let n = 0;
    const nodes = root.querySelectorAll('button, [role="button"]');
    for (const el of nodes) {
      if (n >= 42) break;
      if (!isVisible(el)) continue;
      const al = (el.getAttribute('aria-label') || '').slice(0, 140);
      const cls = String(el.className || '').slice(0, 140);
      if (!/play|pause|fullscreen|rewind|forward|skip|closed caption|subtitle|settings|theater|pip|picture/i.test(`${al} ${cls}`)) continue;
      hints.push({
        tag: el.tagName.toLowerCase(),
        ariaLabel: al || undefined,
        class: cls || undefined
      });
      n++;
    }
  } catch {
    /* ignore */
  }
  return hints;
}

/**
 * Grab a downscaled PNG of the current video frame (for sync / layout debugging).
 * DRM often yields a black or uniform frame — `meta` explains what we got.
 * @param {HTMLVideoElement|null|undefined} v
 * @returns {Promise<{ blob: Blob | null, meta: Record<string, unknown> }>}
 */
export function tryCapturePrimeVideoFramePng(v) {
  return new Promise((resolve) => {
    /** @type {Record<string, unknown>} */
    const meta = { attempted: true, ok: false };
    if (!v || v.tagName !== 'VIDEO') {
      meta.reason = 'no_video';
      resolve({ blob: null, meta });
      return;
    }
    try {
      const vw = v.videoWidth;
      const vh = v.videoHeight;
      meta.sourceVideoW = vw;
      meta.sourceVideoH = vh;
      if (!vw || !vh) {
        meta.reason = 'no_video_dimensions';
        resolve({ blob: null, meta });
        return;
      }
      const maxW = 720;
      const maxH = 405;
      const scale = Math.min(1, maxW / vw, maxH / vh);
      const w = Math.max(2, Math.floor(vw * scale));
      const h = Math.max(2, Math.floor(vh * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) {
        meta.reason = 'no_canvas_context';
        resolve({ blob: null, meta });
        return;
      }
      ctx.drawImage(v, 0, 0, w, h);
      meta.canvasW = w;
      meta.canvasH = h;
      let likelyBlank = false;
      try {
        const img = ctx.getImageData(0, 0, Math.min(48, w), Math.min(48, h));
        let sum = 0;
        const step = 16;
        let samples = 0;
        for (let i = 0; i < img.data.length; i += step) {
          sum += img.data[i] + img.data[i + 1] + img.data[i + 2];
          samples++;
        }
        const avg = samples ? sum / (samples * 3) : 0;
        likelyBlank = avg < 5;
      } catch {
        likelyBlank = true;
      }
      meta.likelyDrmBlackOrBlank = likelyBlank;
      c.toBlob(
        (blob) => {
          meta.ok = !!blob;
          if (!blob) meta.reason = meta.reason || 'toBlob_null';
          resolve({ blob, meta });
        },
        'image/png',
        0.92
      );
    } catch (e) {
      const err = /** @type {Error & { name?: string }} */ (e);
      meta.reason = err && err.name === 'SecurityError' ? 'security_error_tainted_canvas' : String(err?.message || err);
      resolve({ blob: null, meta });
    }
  });
}

/** Network Information API (when exposed) — useful for cross-network sync heuristics. */
function getClientNetworkHints() {
  try {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c) return null;
    return {
      effectiveType: c.effectiveType,
      downlinkMbps: c.downlink,
      rttMs: c.rtt,
      saveData: !!c.saveData
    };
  } catch {
    return null;
  }
}

/**
 * Full Prime playback / DOM snapshot while watching (sync tuning, selectors, video health).
 * Pass **`multiUserSync`** from the content script (room, Railway/WebSocket transport, cluster RTT)
 * so multiple users’ exports can be correlated on the server timeline.
 * @param {{
 *   getVideo?: () => HTMLVideoElement|null|undefined,
 *   localAdBreakActive?: boolean,
 *   inRoom?: boolean,
 *   isHost?: boolean,
 *   hostOnlyControl?: boolean,
 *   countdownOnPlay?: boolean,
 *   lastAppliedState?: { currentTime: number, playing: boolean } | null,
 *   lastSentTime?: number,
 *   lastPlaybackOutboundKind?: string | null,
 *   lastSyncAt?: number,
 *   findVideoStats?: object | null,
 *   videoHealth?: object | null,
 *   viewerDriftSec?: number | null,
 *   playbackTuning?: object | null,
 *   frameCaptureMeta?: object | null,
 *   extensionOpsSubset?: object | null,
 *   multiUserSync?: object | null,
 *   autoCaptureContext?: object | null
 * }} [ctx]
 */
export function capturePrimePlayerSyncDebugPayload(ctx = {}) {
  const getV = typeof ctx.getVideo === 'function' ? ctx.getVideo : () => null;
  const v = getV();
  const snapshot = getPrimeAdDetectionSnapshot(v);

  let mediaSession = null;
  try {
    const m = navigator.mediaSession?.metadata;
    if (m) {
      mediaSession = {
        title: m.title != null ? String(m.title) : null,
        artist: m.artist != null ? String(m.artist) : null,
        album: m.album != null ? String(m.album) : null
      };
    }
  } catch {
    /* ignore */
  }

  const shell = primePlayerShellRoot();
  const shellDigest = summarizePlayerShell(shell, { maxNodes: 110, maxDepth: 15 });
  const videoCandidates = collectPrimeVideoCandidates(getV);
  const playerUiSummary = extractPrimePlayerUiSummary(shell);
  const syncDebugNotes = derivePrimeSyncDebugNotes(ctx, v, videoCandidates);

  return {
    kind: 'playshare_prime_player_sync_debug_v1',
    meta: {
      capturedAt: new Date().toISOString(),
      href: typeof location !== 'undefined' ? location.href : '',
      hostname: typeof location !== 'undefined' ? location.hostname : '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      visibilityState: typeof document !== 'undefined' ? document.visibilityState : '',
      viewport: typeof window !== 'undefined' ? { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio } : null,
      /** Minutes behind UTC; compare across peers for clock-skew suspicion with `multiUserSync.traceDeliveryEstimate`. */
      timezoneOffsetMin: typeof Date !== 'undefined' ? new Date().getTimezoneOffset() : null,
      clientNetworkHints: getClientNetworkHints()
    },
    frameCapture: ctx.frameCaptureMeta || { attempted: false },
    /** Title / caption / loading overlay — mirrors what the user sees when DRM blocks frame PNG. */
    playerUiSummary,
    /** Actionable mismatches (multi-video, stale sync, DRM frame). */
    syncDebugNotes,
    /** Filled by the content script: path kind, PiP/fullscreen, extension version, capture id — no manual notes required. */
    autoCaptureContext: ctx.autoCaptureContext ?? null,
    extension: {
      inRoom: !!ctx.inRoom,
      isHost: !!ctx.isHost,
      hostOnlyControl: !!ctx.hostOnlyControl,
      countdownOnPlay: !!ctx.countdownOnPlay,
      lastAppliedState: ctx.lastAppliedState ?? null,
      lastSentTime: ctx.lastSentTime,
      lastPlaybackOutboundKind: ctx.lastPlaybackOutboundKind ?? null,
      lastSyncAtAgeMs:
        typeof ctx.lastSyncAt === 'number' && ctx.lastSyncAt > 1
          ? Date.now() - ctx.lastSyncAt
          : null,
      localAdBreakActive: !!ctx.localAdBreakActive,
      findVideo: ctx.findVideoStats || null,
      videoHealth: ctx.videoHealth || null,
      viewerDriftSec: ctx.viewerDriftSec ?? null,
      extensionOps: ctx.extensionOpsSubset || null
    },
    playbackTuning: ctx.playbackTuning || null,
    primeAdDetection: snapshot,
    mediaSession,
    videoElement: v && v.tagName === 'VIDEO' ? videoElementSyncDigest(v) : null,
    videoCandidates,
    playerShellDigest: shellDigest,
    playbackControlHints: collectPlaybackControlHints(),
    /**
     * Room + Railway/WebSocket path + multi-peer playback telemetry (from content script).
     * Correlate exports: same `room.roomCode`, nearby `meta.capturedAt`, compare `traceDeliveryEstimate` & `clusterPlayback`.
     */
    multiUserSync: ctx.multiUserSync ?? null
  };
}

/**
 * One-shot payload for “ad playing but extension did not detect it” — player DOM digest + hints.
 * @param {{ getVideo?: () => HTMLVideoElement|null|undefined, localAdBreakActive?: boolean, inRoom?: boolean, videoHealth?: object|null, autoCaptureContext?: object|null }} [ctx]
 */
export function capturePrimeMissedAdDebugPayload(ctx = {}) {
  const getV = typeof ctx.getVideo === 'function' ? ctx.getVideo : () => null;
  const v = getV();
  const snapshot = getPrimeAdDetectionSnapshot(v);

  let mediaSession = null;
  try {
    const m = navigator.mediaSession?.metadata;
    if (m) {
      mediaSession = {
        title: m.title != null ? String(m.title) : null,
        artist: m.artist != null ? String(m.artist) : null,
        album: m.album != null ? String(m.album) : null
      };
    }
  } catch {
    /* ignore */
  }

  const shell = primePlayerShellRoot();
  const shellDigest = summarizePlayerShell(shell, { maxNodes: 100, maxDepth: 15 });

  let videoDigest = null;
  if (v && v.tagName === 'VIDEO') {
    try {
      videoDigest = {
        readyState: v.readyState,
        paused: v.paused,
        currentTime: +v.currentTime.toFixed(2),
        duration: v.duration && !isNaN(v.duration) ? +v.duration.toFixed(1) : null,
        muted: v.muted
      };
    } catch {
      /* ignore */
    }
  }

  return {
    kind: 'playshare_prime_missed_ad_debug_v1',
    meta: {
      capturedAt: new Date().toISOString(),
      href: typeof location !== 'undefined' ? location.href : '',
      hostname: typeof location !== 'undefined' ? location.hostname : ''
    },
    extension: {
      localAdBreakActiveReported: !!ctx.localAdBreakActive,
      inRoom: !!ctx.inRoom,
      videoHealth: ctx.videoHealth || null
    },
    primeAdDetection: snapshot,
    mediaSession,
    playerShellDigest: shellDigest,
    adRelatedHints: collectAdRelatedHints(),
    videoElement: videoDigest,
    autoCaptureContext: ctx.autoCaptureContext ?? null
  };
}

/**
 * Prime sometimes keeps the real `<video>` outside the player container in the light DOM (sibling of
 * the SDK UI layer) while `.atvwebplayersdk-player-container` still wraps controls/overlays. Ancestor
 * checks alone then falsely say “not main shell” (see playshare_prime_player_sync_debug snapshots).
 * @param {HTMLVideoElement} v
 * @param {Element|null|undefined} shell
 */
function videoGeometricallyAlignedWithPrimeShell(v, shell) {
  if (!shell || !v) return false;
  try {
    const vr = v.getBoundingClientRect();
    const sr = shell.getBoundingClientRect();
    if (vr.width < 8 || vr.height < 8 || sr.width < 8 || sr.height < 8) return false;
    const ix = Math.max(0, Math.min(vr.right, sr.right) - Math.max(vr.left, sr.left));
    const iy = Math.max(0, Math.min(vr.bottom, sr.bottom) - Math.max(vr.top, sr.top));
    const inter = ix * iy;
    const vArea = vr.width * vr.height;
    const overlapRatio = vArea > 0 ? inter / vArea : 0;
    if (overlapRatio >= 0.35) return true;
    const cx = vr.left + vr.width / 2;
    const cy = vr.top + vr.height / 2;
    return cx >= sr.left && cx <= sr.right && cy >= sr.top && cy <= sr.bottom;
  } catch {
    return false;
  }
}

/**
 * True when the element is inside the main Amazon web player (not a strip/preview).
 * @param {HTMLVideoElement|null|undefined} v
 */
export function isPrimeMainPlayerShell(v) {
  if (!v || v.tagName !== 'VIDEO') return false;
  try {
    if (v.closest?.('.atvwebplayersdk-player-container, [class*="atvwebplayersdk-player"], [class*="webPlayerInner"]')) return true;
    const shell = primePlayerShellRoot();
    return videoGeometricallyAlignedWithPrimeShell(v, shell);
  } catch {
    return false;
  }
}

/**
 * Prefer the main Amazon player canvas over thumbnails / previews.
 * @param {HTMLVideoElement} v
 * @param {number} score
 */
export function adjustPrimeVideoCandidateScore(v, score) {
  if (!v || v.tagName !== 'VIDEO' || !isFinite(score)) return score;
  let s = score;
  if (isPrimeMainPlayerShell(v)) {
    s *= 1.85;
    // Prime often keeps a second <video> in the shell (paused @0, no decoded frames). Prefer the real surface.
    try {
      const dim = v.videoWidth > 32 && v.videoHeight > 32;
      if (v.paused && v.currentTime < 0.08 && !dim) s *= 0.14;
    } catch {
      /* ignore */
    }
  }
  return s;
}

/**
 * Drop findVideo cache when it points at an in-shell placeholder while another shell video is playing.
 * @param {HTMLVideoElement|null|undefined} v
 */
export function primeShouldRefreshVideoCache(v) {
  if (!v || v.tagName !== 'VIDEO') return false;
  try {
    if (!isPrimeMainPlayerShell(v)) return false;
    if (!v.paused || v.currentTime > 0.25) return false;
    if (v.videoWidth > 48 && v.videoHeight > 48) return false;
    for (const el of document.querySelectorAll('video')) {
      if (el === v || !(el instanceof HTMLVideoElement)) continue;
      if (!isPrimeMainPlayerShell(el)) continue;
      if (el.paused || el.currentTime < 0.5) continue;
      if (el.videoWidth > 48 && el.videoHeight > 48) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * @param {HTMLVideoElement} v2
 * @param {{ dispatchSpaceKey: (el: Element|null|undefined) => void }} helpers
 */
export function primeStillPausedAfterAggressivePlay(v2, helpers) {
  helpers.dispatchSpaceKey(v2);
  helpers.dispatchSpaceKey(v2.closest('.atvwebplayersdk-player-container') || document.body);
}

/**
 * @param {HTMLVideoElement} v2
 * @param {{ dispatchSpaceKey: (el: Element|null|undefined) => void }} helpers
 */
export function primeStillPlayingAfterAggressivePause(v2, helpers) {
  helpers.dispatchSpaceKey(v2);
  helpers.dispatchSpaceKey(v2.closest('.atvwebplayersdk-player-container') || document.body);
}

export function primeExtraDiagTips() {
  return [
    {
      level: 'info',
      text: 'Prime: Space / UI clicks if sync lags; video node may swap. HUD + __playsharePrime.getStatus() in popup footer / console.'
    },
    {
      level: 'info',
      text: 'Ad breaks: room sync uses only Amazon’s on-screen ad cues + media metadata (no generic class guessing). Use sidebar manual ad controls if detection misses a break.'
    }
  ];
}

/**
 * Prime ad-break monitor: balance fast enter after refresh/pre-roll vs false positives.
 * Strong cues (ad-timer aria / “Ad0:48” text) are already required by channelPrimeAdTimerChrome;
 * a single positive sample + short debounce is enough for DOM-stable Amazon UI.
 */
export const PRIME_AD_BREAK_MONITOR_OPTIONS = {
  debounceEnterMs: 260,
  debounceExitMs: 1000,
  enterConsecutiveSamples: 1,
  exitConsecutiveSamples: 3,
  minAdHoldMs: 1800
};

export const primeSiteSyncAdapter = Object.freeze({
  key: PRIME_SYNC_HANDLER_KEY,
  getPlaybackConfidence: ({ video }) => getPrimePlaybackConfidence(video),
  remoteApplyIgnoreLocalMs: 650,
  microCorrectionIgnoreSec: 0.65,
  rapidSeekRejectWindowMs: 2200,
  rapidSeekMaxInWindow: 5,
  skipRemoteSeekWhileVideoSeeking: true,
  getPriorityVideoSelectors: () => PRIME_PRIORITY_VIDEO_SELECTORS,
  adjustVideoCandidateScore: adjustPrimeVideoCandidateScore,
  shouldRefreshVideoCache: primeShouldRefreshVideoCache,
  onStillPausedAfterAggressivePlay: primeStillPausedAfterAggressivePlay,
  onStillPlayingAfterAggressivePause: primeStillPlayingAfterAggressivePause,
  extraDiagTips: primeExtraDiagTips
});
