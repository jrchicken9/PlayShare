/**
 * Long-running <video> instrumentation for PlayShare / cross-site player analysis.
 * Captures deep element + page chrome + performance hints + playerCapabilities (EME/PiP/sink/WebKit counters) +
 * videoFrameCallback samples + optional JPEG frame for extension debugging.
 * Designed for extended runs (tens of minutes to hours): periodic snapshots + throttled media events are stored in
 * ring buffers (oldest rows drop after maxSnapshots / maxEvents) while the extension keeps working.
 * Export is JSON-serializable; URLs and attributes truncated — no credentials.
 *
 * v4: derived timeline events, decision hooks (`recordDecisionEvent`), per-snapshot `deltaSummary`,
 * session `progressionQuality` rollup — observer-only; no sync control logic here.
 */

/** @typedef {{ t: number, type: string, [k: string]: unknown }} ProfilerEvent */

const PROFILER_SCHEMA = 'playshare.videoPlayerProfiler.v4';

/** Jumps larger than this (seconds) while not seeking count as discontinuities (not micro-drift). */
const LARGE_DISCONTINUITY_SEC = 3.5;
/** Debounce derived `video_frozen_but_not_paused` (ms). */
const DERIVED_FROZEN_DEBOUNCE_MS = 4200;

const MEDIA_ERROR_NAMES = {
  1: 'MEDIA_ERR_ABORTED',
  2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED'
};

/**
 * @param {unknown} v
 * @param {number} max
 */
function truncUrl(v, max) {
  const s = v == null ? '' : String(v);
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function perfNowMs() {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return +performance.now().toFixed(1);
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * @param {Record<string, unknown>|null|undefined} d
 */
function sanitizeDecisionDetail(d) {
  if (!d || typeof d !== 'object') return {};
  /** @type {Record<string, unknown>} */
  const out = {};
  const keys = [
    'reason',
    'driftSec',
    'correctionReason',
    'handlerKey',
    'syncKind',
    'remoteKind',
    'kind',
    'rate',
    'absDrift',
    'driftSigned',
    'ok',
    'deltaSeek',
    'note',
    'durationMs',
    'correlationId',
    'branch',
    'snapshotAt'
  ];
  for (const k of keys) {
    if (!(k in d)) continue;
    const v = /** @type {Record<string, unknown>} */ (d)[k];
    if (v == null) continue;
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = Math.abs(v) > 1e5 ? v : +v.toFixed(Number.isInteger(v) ? 0 : 4);
    } else if (typeof v === 'boolean') {
      out[k] = v;
    } else if (typeof v === 'string') {
      out[k] = truncUrl(v, 96);
    }
  }
  return out;
}

/**
 * @param {Record<string, unknown>|null|undefined} prev
 * @param {Record<string, unknown>|null|undefined} cur
 */
function computeDeltaSummary(prev, cur) {
  if (!prev || !cur) return null;
  /** @type {Record<string, unknown>} */
  const d = {};
  if (prev.videoPresent !== cur.videoPresent) d.videoPresentChanged = true;
  const pct = prev.currentTime;
  const cct = cur.currentTime;
  if (typeof pct === 'number' && typeof cct === 'number' && Number.isFinite(pct) && Number.isFinite(cct)) {
    const dt = cct - pct;
    if (Math.abs(dt) > 1e-4) d.currentTimeDelta = +dt.toFixed(3);
  }
  const pb = prev.bufferAheadSec;
  const cb = cur.bufferAheadSec;
  if (typeof pb === 'number' && typeof cb === 'number' && Number.isFinite(pb) && Number.isFinite(cb)) {
    const db = cb - pb;
    if (Math.abs(db) > 0.02) d.bufferAheadDelta = +db.toFixed(2);
  }
  if (prev.playbackRate !== cur.playbackRate && typeof cur.playbackRate === 'number') d.playbackRateChanged = true;
  if (prev.readyState !== cur.readyState) d.readyStateChanged = [prev.readyState, cur.readyState];
  if (prev.paused !== cur.paused) d.pausedChanged = true;
  if (prev.seeking !== cur.seeking) d.seekingChanged = true;
  const ps = typeof prev.currentSrc === 'string' ? prev.currentSrc : '';
  const cs = typeof cur.currentSrc === 'string' ? cur.currentSrc : '';
  if (ps !== cs && (ps || cs)) d.srcChanged = true;
  if (prev.documentVisibility !== cur.documentVisibility) d.visibilityChanged = true;
  return Object.keys(d).length ? d : null;
}

/**
 * Best-effort “ad-like” visibility from enriched snapshot (playShare / Prime / Netflix blocks).
 * @param {Record<string, unknown>|null|undefined} snap
 */
function adModeVisibleFromSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return false;
  try {
    const ps = snap.playShare;
    if (ps && typeof ps === 'object' && /** @type {Record<string, unknown>} */ (ps).localAdBreakActive === true) {
      return true;
    }
    const nf = snap.netflixAd;
    if (nf && typeof nf === 'object' && /** @type {Record<string, unknown>} */ (nf).extensionHeuristicAd === true) {
      return true;
    }
    const pr = snap.primePlayer;
    if (pr && typeof pr === 'object') {
      const o = /** @type {Record<string, unknown>} */ (pr);
      if (o.adLikely === true || o.adStrong === true) return true;
    }
    const pt = snap.primeTelemetry;
    if (pt && typeof pt === 'object' && /** @type {Record<string, unknown>} */ (pt).extensionLocalAd === true) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Seconds of buffer ahead of current playhead (best effort).
 * @param {HTMLVideoElement} v
 */
function bufferAheadSec(v) {
  try {
    const ct = v.currentTime;
    if (typeof ct !== 'number' || !Number.isFinite(ct)) return null;
    const b = v.buffered;
    let inRange = 0;
    for (let i = 0; i < b.length; i++) {
      if (ct >= b.start(i) && ct <= b.end(i)) {
        inRange = Math.max(inRange, b.end(i) - ct);
      }
    }
    if (inRange > 0) return +inRange.toFixed(2);
    let ahead = 0;
    for (let i = 0; i < b.length; i++) {
      if (b.end(i) > ct) ahead = Math.max(ahead, b.end(i) - ct);
    }
    return ahead > 0 ? +ahead.toFixed(2) : 0;
  } catch {
    return null;
  }
}

/**
 * Fraction of the video element’s bounding box visible in the viewport (0–1).
 * @param {HTMLVideoElement} v
 */
function viewportOverlapRatio(v) {
  try {
    if (typeof window === 'undefined') return null;
    const r = v.getBoundingClientRect();
    const iw = window.innerWidth;
    const ih = window.innerHeight;
    const ix = Math.max(0, Math.min(r.right, iw) - Math.max(r.left, 0));
    const iy = Math.max(0, Math.min(r.bottom, ih) - Math.max(r.top, 0));
    const inter = ix * iy;
    const area = r.width * r.height;
    return area > 0 ? +Math.min(1, inter / area).toFixed(3) : 0;
  } catch {
    return null;
  }
}

/**
 * @param {HTMLVideoElement} v
 */
function videoDomContext(v) {
  try {
    const root = v.getRootNode();
    const inShadow = root instanceof ShadowRoot;
    return {
      inShadowRoot: inShadow,
      hostTag: inShadow && /** @type {ShadowRoot} */ (root).host ? /** @type {ShadowRoot} */ (root).host.tagName : null
    };
  } catch {
    return { inShadowRoot: false, hostTag: null };
  }
}

function networkConnectionHint() {
  try {
    const nc = /** @type {{ effectiveType?: string, downlink?: number, rtt?: number, saveData?: boolean }|undefined} */ (
      typeof navigator !== 'undefined' ? navigator.connection : undefined
    );
    if (!nc) return null;
    return {
      effectiveType: nc.effectiveType != null ? String(nc.effectiveType) : null,
      downlinkMbps: typeof nc.downlink === 'number' ? +nc.downlink.toFixed(2) : null,
      rttMs: typeof nc.rtt === 'number' ? Math.round(nc.rtt) : null,
      saveData: !!nc.saveData
    };
  } catch {
    return null;
  }
}

/**
 * @param {unknown[]} snaps
 * @param {ProfilerEvent[]} evs
 */
function computeSessionRollup(snaps, evs) {
  const nums = [];
  let present = 0;
  let playing = 0;
  for (const s of snaps) {
    if (!s || typeof s !== 'object') continue;
    const o = /** @type {Record<string, unknown>} */ (s);
    if (o.videoPresent === true) {
      present++;
      if (o.paused === false) playing++;
    }
    const b = o.bufferAheadSec;
    if (typeof b === 'number' && Number.isFinite(b)) nums.push(b);
  }
  nums.sort((a, b) => a - b);
  const sum = nums.reduce((a, b) => a + b, 0);
  let userMarkers = 0;
  let rebounds = 0;
  let srcChanges = 0;
  let longTaskEvents = 0;
  let decisionEvents = 0;
  let derivedTimelineEvents = 0;
  for (const e of evs) {
    const row = e && typeof e === 'object' ? /** @type {Record<string, unknown>} */ (e) : null;
    const et = row ? String(row.type || '') : '';
    if (et === 'user_marker') userMarkers++;
    if (et === 'video_element_rebound') rebounds++;
    if (et === 'current_src_changed') srcChanges++;
    if (et === 'performance_longtask') longTaskEvents++;
    if (row && row.decision === true) decisionEvents++;
    if (row && row.derived === true) derivedTimelineEvents++;
  }
  return {
    snapshotsWithVideo: present,
    playingSampleRatio: present > 0 ? +(playing / present).toFixed(3) : null,
    bufferAheadSec: nums.length
      ? {
          min: nums[0],
          max: nums[nums.length - 1],
          median: nums[Math.floor(nums.length / 2)],
          avg: +(sum / nums.length).toFixed(2),
          samples: nums.length
        }
      : null,
    userMarkers,
    videoElementRebounds: rebounds,
    currentSrcChanges: srcChanges,
    performanceLongTaskEvents: longTaskEvents,
    decisionEvents,
    derivedTimelineEvents
  };
}

function captureEnvironmentSnapshot() {
  /** @type {Record<string, unknown>} */
  const out = {};
  try {
    if (typeof navigator !== 'undefined') {
      out.languages = navigator.languages ? [...navigator.languages].slice(0, 10) : null;
      out.hardwareConcurrency = navigator.hardwareConcurrency ?? null;
      out.platform = String(navigator.platform || '').slice(0, 80);
      out.onLine = !!navigator.onLine;
      const dm = /** @type {{ deviceMemory?: number }} */ (navigator);
      if (typeof dm.deviceMemory === 'number') out.deviceMemoryGb = dm.deviceMemory;
    }
  } catch {
    /* ignore */
  }
  try {
    const pm = /** @type {{ memory?: { usedJSHeapSize: number, totalJSHeapSize: number, jsHeapSizeLimit: number } }} */ (
      performance
    );
    if (pm.memory) {
      out.jsHeapUsedMb = +(pm.memory.usedJSHeapSize / 1048576).toFixed(1);
      out.jsHeapTotalMb = +(pm.memory.totalJSHeapSize / 1048576).toFixed(1);
      out.jsHeapLimitMb = +(pm.memory.jsHeapSizeLimit / 1048576).toFixed(0);
    }
  } catch {
    /* ignore */
  }
  try {
    const t = performance.timing;
    if (t && t.navigationStart > 0) {
      out.pageLoadAgeMs = Date.now() - t.navigationStart;
    }
  } catch {
    /* ignore */
  }
  try {
    out.contentScriptTopLevel = typeof window !== 'undefined' ? window === window.top : null;
    out.devicePixelRatio =
      typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number'
        ? +window.devicePixelRatio.toFixed(2)
        : null;
  } catch {
    /* ignore */
  }
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      out.extensionContext = { runtimePresent: true };
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * @param {HTMLVideoElement|null} trackedVideo
 */
function capturePageChrome(trackedVideo) {
  try {
    const fs = document.fullscreenElement || document.webkitFullscreenElement || null;
    const pip = document.pictureInPictureElement || null;
    return {
      fullscreenElementTag: fs && fs instanceof Element ? fs.tagName : null,
      fullscreenElementId: fs && fs instanceof Element && fs.id ? String(fs.id).slice(0, 56) : null,
      fullscreenElementClass:
        fs && fs instanceof Element && typeof (/** @type {Element} */ (fs)).className === 'string'
          ? String((/** @type {HTMLElement} */ (fs)).className).slice(0, 140)
          : null,
      pictureInPictureElementTag: pip && pip instanceof Element ? pip.tagName : null,
      pictureInPictureIsTrackedVideo: !!(trackedVideo && pip === trackedVideo)
    };
  } catch {
    return null;
  }
}

/**
 * @param {HTMLVideoElement|null} v
 */
function captureActiveElementHint(v) {
  try {
    const a = document.activeElement;
    if (!a || !(a instanceof Element)) return null;
    const within =
      v && (a === v || (typeof v.contains === 'function' && /** @type {HTMLElement} */ (v).contains(a)));
    return {
      tag: a.tagName,
      id: a.id ? String(a.id).slice(0, 48) : null,
      class: typeof (/** @type {HTMLElement} */ (a)).className === 'string' ? String(a.className).slice(0, 100) : null,
      role: a.getAttribute('role'),
      withinTrackedVideo: !!within
    };
  } catch {
    return null;
  }
}

/**
 * @param {HTMLVideoElement} v
 */
function captureVideoElementDeep(v) {
  /** @type {Record<string, unknown>} */
  const out = {
    tagName: v.tagName,
    id: v.id ? String(v.id).slice(0, 80) : '',
    classList: v.classList ? [...v.classList].slice(0, 28).map((c) => String(c).slice(0, 56)) : []
  };
  try {
    const attrs = {};
    const names = typeof v.getAttributeNames === 'function' ? v.getAttributeNames() : [];
    for (const n of names.slice(0, 50)) {
      const val = v.getAttribute(n);
      attrs[String(n).slice(0, 64)] = val != null ? truncUrl(val, 140) : '';
    }
    out.attributes = attrs;
  } catch {
    out.attributes = {};
  }
  try {
    const ds = v.dataset;
    const data = {};
    for (const k of Object.keys(ds).slice(0, 28)) {
      data[k.slice(0, 48)] = truncUrl(String(ds[k] || ''), 96);
    }
    out.dataset = data;
  } catch {
    out.dataset = {};
  }
  try {
    const st = getComputedStyle(v);
    out.computedStyle = {
      display: st.display,
      visibility: st.visibility,
      opacity: st.opacity,
      objectFit: st.objectFit,
      pointerEvents: st.pointerEvents,
      zIndex: st.zIndex,
      position: st.position
    };
  } catch {
    out.computedStyle = null;
  }
  try {
    const chain = [];
    let el = /** @type {Element|null} */ (v);
    for (let d = 0; d < 12 && el; d++) {
      const he = /** @type {HTMLElement} */ (el);
      chain.push({
        tag: el.tagName,
        id: el.id ? String(el.id).slice(0, 48) : '',
        cls: typeof he.className === 'string' ? he.className.slice(0, 120) : ''
      });
      el = el.parentElement;
    }
    out.ancestorChain = chain;
  } catch {
    out.ancestorChain = [];
  }
  try {
    out.closestPlayerHints = {
      atvSdk: !!v.closest?.('[class*="atvwebplayersdk" i]'),
      nfPlayer: !!v.closest?.('.nf-player-container, [class*="watch-video" i]'),
      youtube: !!v.closest?.('.html5-video-player, #movie_player'),
      disney: !!v.closest?.('[data-testid*="player" i], [class*="dplus-player" i], [class*="disney" i]')
    };
  } catch {
    out.closestPlayerHints = {};
  }
  return out;
}

/**
 * Best-effort JPEG (often fails on DRM-tainted canvases).
 * @param {HTMLVideoElement|null} v
 */
function tryCaptureVideoFrameDataUrl(v) {
  if (!v || !(v instanceof HTMLVideoElement)) return { ok: false, reason: 'no_video' };
  if (!v.videoWidth || !v.videoHeight) return { ok: false, reason: 'no_decoded_frames' };
  try {
    const c = document.createElement('canvas');
    const maxW = 400;
    const scale = Math.min(1, maxW / v.videoWidth);
    c.width = Math.max(1, Math.round(v.videoWidth * scale));
    c.height = Math.max(1, Math.round(v.videoHeight * scale));
    const ctx = c.getContext('2d');
    if (!ctx) return { ok: false, reason: 'no_canvas_context' };
    ctx.drawImage(v, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', 0.4);
    const maxLen = 240000;
    if (dataUrl.length > maxLen) {
      return {
        ok: true,
        format: 'jpeg',
        width: c.width,
        height: c.height,
        truncated: true,
        length: dataUrl.length,
        dataUrl: dataUrl.slice(0, maxLen)
      };
    }
    return { ok: true, format: 'jpeg', width: c.width, height: c.height, length: dataUrl.length, dataUrl };
  } catch (e) {
    const name = e && typeof e === 'object' && 'name' in e ? String(/** @type {{name?:string}} */ (e).name) : '';
    return { ok: false, reason: 'canvas_security_or_error', detail: name.slice(0, 64) };
  }
}

/**
 * Policy / EME / output / Chromium pipeline counters (sync, best-effort).
 * @param {HTMLVideoElement} v
 */
function capturePlayerCapabilities(v) {
  /** @type {Record<string, unknown>} */
  const cap = {};
  try {
    cap.disablePictureInPicture = !!v.disablePictureInPicture;
    cap.disableRemotePlayback = !!v.disableRemotePlayback;
  } catch {
    cap.disablePictureInPicture = null;
    cap.disableRemotePlayback = null;
  }
  try {
    if (typeof document !== 'undefined') {
      cap.pictureInPictureEnabled = !!document.pictureInPictureEnabled;
      const d = /** @type {{ fullscreenEnabled?: boolean, webkitFullscreenEnabled?: boolean }} */ (document);
      cap.fullscreenEnabled =
        typeof d.fullscreenEnabled === 'boolean'
          ? d.fullscreenEnabled
          : typeof d.webkitFullscreenEnabled === 'boolean'
            ? d.webkitFullscreenEnabled
            : null;
    }
  } catch {
    /* leave missing */
  }
  try {
    cap.emeMediaKeysAttached = !!(/** @type {{ mediaKeys?: object|null }} */ (v).mediaKeys);
  } catch {
    cap.emeMediaKeysAttached = null;
  }
  try {
    if ('sinkId' in v) {
      const sid = /** @type {{ sinkId?: string }} */ (v).sinkId;
      cap.sinkId = typeof sid === 'string' ? truncUrl(sid, 96) : null;
    }
  } catch {
    cap.sinkId = null;
  }
  try {
    if (typeof v.getStartDate === 'function') {
      const d = v.getStartDate();
      if (d instanceof Date && !Number.isNaN(d.getTime())) cap.broadcastStartDateMs = d.getTime();
    }
  } catch {
    /* ignore */
  }
  /** @type {Record<string, number>} */
  const webkit = {};
  for (const key of [
    'webkitVideoDecodedByteCount',
    'webkitAudioDecodedByteCount',
    'webkitDecodedFrameCount',
    'webkitDroppedFrameCount'
  ]) {
    try {
      if (key in v) {
        const n = Reflect.get(v, key);
        if (typeof n === 'number' && Number.isFinite(n)) webkit[key] = n;
      }
    } catch {
      /* ignore */
    }
  }
  if (Object.keys(webkit).length) cap.webkitPipeline = webkit;
  return cap;
}

function captureMediaSessionSnapshot() {
  try {
    if (typeof navigator === 'undefined' || !navigator.mediaSession) {
      return { available: false };
    }
    const ms = navigator.mediaSession;
    const md = ms.metadata;
    return {
      available: true,
      playbackState: ms.playbackState || null,
      title: md && md.title ? truncUrl(md.title, 120) : null,
      artist: md && md.artist ? truncUrl(md.artist, 96) : null,
      album: md && md.album ? truncUrl(md.album, 96) : null
    };
  } catch {
    return { available: false, readError: true };
  }
}

/**
 * @param {HTMLVideoElement|null} v
 */
function captureVideoSnapshot(v) {
  const at = Date.now();
  const mono = perfNowMs();
  if (!v || !(v instanceof HTMLVideoElement)) {
    /** @type {Record<string, unknown>} */
    const absent = { at, perfNowMs: mono, videoPresent: false };
    try {
      absent.documentVisibility = typeof document !== 'undefined' ? document.visibilityState || '' : '';
      absent.documentHidden = typeof document !== 'undefined' ? !!document.hidden : null;
      absent.pageHasFocus =
        typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : null;
    } catch {
      /* ignore */
    }
    absent.mediaSession = captureMediaSessionSnapshot();
    try {
      absent.pageChrome = capturePageChrome(null);
      absent.activeElement = captureActiveElementHint(null);
    } catch {
      /* ignore */
    }
    try {
      if (typeof window !== 'undefined') {
        absent.windowInner = { w: window.innerWidth, h: window.innerHeight };
      }
    } catch {
      /* ignore */
    }
    try {
      if (typeof document !== 'undefined') {
        const d = /** @type {{ pictureInPictureEnabled?: boolean, fullscreenEnabled?: boolean, webkitFullscreenEnabled?: boolean }} */ (
          document
        );
        absent.documentPlayerApi = {
          pictureInPictureEnabled: !!d.pictureInPictureEnabled,
          fullscreenEnabled:
            typeof d.fullscreenEnabled === 'boolean'
              ? d.fullscreenEnabled
              : typeof d.webkitFullscreenEnabled === 'boolean'
                ? d.webkitFullscreenEnabled
                : null
        };
      }
    } catch {
      /* ignore */
    }
    return absent;
  }
  /** @type {Record<string, unknown>} */
  const snap = {
    at,
    perfNowMs: mono,
    videoPresent: true,
    readyState: v.readyState,
    networkState: v.networkState,
    paused: v.paused,
    ended: v.ended,
    seeking: v.seeking,
    muted: v.muted,
    defaultMuted: v.defaultMuted,
    volume: typeof v.volume === 'number' ? +v.volume.toFixed(3) : null,
    playbackRate: v.playbackRate,
    defaultPlaybackRate: v.defaultPlaybackRate,
    currentTime: typeof v.currentTime === 'number' && Number.isFinite(v.currentTime) ? +v.currentTime.toFixed(3) : null,
    duration:
      typeof v.duration === 'number' && Number.isFinite(v.duration) && !Number.isNaN(v.duration)
        ? +v.duration.toFixed(2)
        : null,
    videoWidth: v.videoWidth || 0,
    videoHeight: v.videoHeight || 0,
    currentSrc: truncUrl(v.currentSrc, 120),
    src: truncUrl(v.getAttribute('src') || v.src || '', 120),
    crossOrigin: v.crossOrigin || null,
    preload: v.preload || null,
    loop: !!v.loop,
    playsInline: 'playsInline' in v ? !!/** @type {HTMLVideoElement} */ (v).playsInline : null,
    autoplay: !!v.autoplay,
    controls: !!v.controls,
    poster: truncUrl(v.poster || '', 80)
  };

  try {
    const r = v.getBoundingClientRect();
    const iw = typeof window !== 'undefined' ? window.innerWidth : 0;
    const ih = typeof window !== 'undefined' ? window.innerHeight : 0;
    snap.layout = {
      offsetW: v.offsetWidth,
      offsetH: v.offsetHeight,
      clientW: v.clientWidth,
      clientH: v.clientHeight,
      rect: { x: +r.x.toFixed(0), y: +r.y.toFixed(0), w: +r.width.toFixed(0), h: +r.height.toFixed(0) }
    };
    snap.inViewportApprox =
      ih > 0 && iw > 0 && r.bottom > 0 && r.right > 0 && r.top < ih && r.left < iw;
  } catch {
    /* ignore */
  }

  try {
    snap.pictureInPicture =
      typeof document !== 'undefined' && document.pictureInPictureElement === v ? true : false;
  } catch {
    snap.pictureInPicture = null;
  }

  try {
    if ('webkitPresentationMode' in v) {
      snap.webkitPresentationMode = /** @type {{ webkitPresentationMode?: string }} */ (v).webkitPresentationMode;
    }
  } catch {
    /* ignore */
  }

  try {
    if ('preservesPitch' in v) snap.preservesPitch = !!/** @type {{ preservesPitch?: boolean }} */ (v).preservesPitch;
  } catch {
    /* ignore */
  }

  try {
    const rp = /** @type {{ remote?: { state?: string } }} */ (v).remote;
    if (rp && typeof rp.state === 'string') snap.remotePlayback = { state: rp.state };
  } catch {
    /* ignore */
  }

  try {
    snap.documentVisibility = typeof document !== 'undefined' ? document.visibilityState || '' : '';
    snap.documentHidden = typeof document !== 'undefined' ? !!document.hidden : null;
    snap.pageHasFocus = typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : null;
  } catch {
    /* ignore */
  }

  snap.mediaSession = captureMediaSessionSnapshot();
  snap.bufferAheadSec = bufferAheadSec(v);
  snap.viewportOverlapRatio = viewportOverlapRatio(v);
  snap.videoDom = videoDomContext(v);
  snap.network = networkConnectionHint();
  try {
    snap.pageChrome = capturePageChrome(v);
    snap.activeElement = captureActiveElementHint(v);
    snap.videoElement = captureVideoElementDeep(v);
  } catch {
    /* ignore */
  }

  try {
    const b = v.buffered;
    const br = [];
    const n = Math.min(b.length, 24);
    for (let i = 0; i < n; i++) {
      br.push([+b.start(i).toFixed(2), +b.end(i).toFixed(2)]);
    }
    snap.bufferedRanges = br;
    snap.bufferedRangeCount = b.length;
  } catch {
    snap.bufferedRanges = [];
  }

  try {
    const s = v.seekable;
    const sr = [];
    const n = Math.min(s.length, 12);
    for (let i = 0; i < n; i++) {
      sr.push([+s.start(i).toFixed(2), +s.end(i).toFixed(2)]);
    }
    snap.seekableRanges = sr;
  } catch {
    snap.seekableRanges = [];
  }

  try {
    const p = v.played;
    const pr = [];
    const n = Math.min(p.length, 12);
    for (let i = 0; i < n; i++) {
      pr.push([+p.start(i).toFixed(2), +p.end(i).toFixed(2)]);
    }
    snap.playedRanges = pr;
  } catch {
    snap.playedRanges = [];
  }

  try {
    if (typeof v.getVideoPlaybackQuality === 'function') {
      const q = v.getVideoPlaybackQuality();
      snap.playbackQuality = {
        totalVideoFrames: q.totalVideoFrames ?? null,
        droppedVideoFrames: q.droppedVideoFrames ?? null,
        corruptedVideoFrames: q.corruptedVideoFrames ?? null,
        creationTime: q.creationTime != null ? +q.creationTime.toFixed(1) : null
      };
    }
  } catch {
    /* ignore */
  }

  try {
    const vt = v.videoTracks;
    if (vt && vt.length !== undefined) {
      snap.videoTracks = [];
      for (let i = 0; i < Math.min(vt.length, 8); i++) {
        const t = vt[i];
        snap.videoTracks.push({
          id: t.id || '',
          kind: t.kind || '',
          label: truncUrl(t.label, 40),
          language: t.language || '',
          selected: !!t.selected
        });
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const atTracks = v.audioTracks;
    if (atTracks && atTracks.length !== undefined) {
      snap.audioTracks = [];
      for (let i = 0; i < Math.min(atTracks.length, 8); i++) {
        const t = atTracks[i];
        snap.audioTracks.push({
          id: t.id || '',
          kind: t.kind || '',
          label: truncUrl(t.label, 40),
          language: t.language || '',
          enabled: !!t.enabled
        });
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const tt = v.textTracks;
    if (tt && tt.length !== undefined) {
      snap.textTracks = [];
      for (let i = 0; i < Math.min(tt.length, 12); i++) {
        const t = tt[i];
        let cueCount = /** @type {number|null} */ (null);
        let activeCueCount = /** @type {number|null} */ (null);
        try {
          if (t.cues) cueCount = t.cues.length;
        } catch {
          cueCount = null;
        }
        try {
          if (t.activeCues) activeCueCount = t.activeCues.length;
        } catch {
          activeCueCount = null;
        }
        snap.textTracks.push({
          kind: t.kind || '',
          label: truncUrl(t.label, 48),
          language: t.language || '',
          mode: t.mode || '',
          cueCount,
          activeCueCount
        });
      }
    }
  } catch {
    /* ignore */
  }

  try {
    snap.playerCapabilities = capturePlayerCapabilities(v);
  } catch {
    snap.playerCapabilities = { readError: true };
  }

  return snap;
}

/**
 * @param {object} opts
 * @param {() => HTMLVideoElement|null} opts.getVideo
 * @param {number} [opts.snapshotIntervalMs]
 * @param {number} [opts.maxSnapshots]
 * @param {number} [opts.maxEvents]
 * @param {number} [opts.stallCheckIntervalMs]
 * @param {number} [opts.timeupdateLogMinIntervalMs]
 * @param {number} [opts.progressLogMinIntervalMs]
 * @param {(snap: Record<string, unknown>, v: HTMLVideoElement|null, ctx?: { userMarker?: boolean, seq?: number, note?: string }|null|undefined) => void} [opts.enrichSnapshot]
 * @param {() => Record<string, unknown>|null|undefined} [opts.getExportExtras]
 */
function createProgressionTracker() {
  let lastTuWall = 0;
  let lastTuCt = /** @type {number|null} */ (null);
  let sumGap = 0;
  let gapCount = 0;
  let maxGap = 0;
  let zeroAdvanceWhilePlayingCount = 0;
  let largeDiscontinuityCount = 0;
  let expectedAdvanceSec = 0;
  let actualAdvanceSec = 0;
  let frozenWhilePlayingCount = 0;

  return {
    reset() {
      lastTuWall = 0;
      lastTuCt = null;
      sumGap = 0;
      gapCount = 0;
      maxGap = 0;
      zeroAdvanceWhilePlayingCount = 0;
      largeDiscontinuityCount = 0;
      expectedAdvanceSec = 0;
      actualAdvanceSec = 0;
      frozenWhilePlayingCount = 0;
    },
    /**
     * @param {HTMLVideoElement} v
     * @param {number} wallMs
     */
    onTimeupdate(v, wallMs) {
      const ct = typeof v.currentTime === 'number' && Number.isFinite(v.currentTime) ? v.currentTime : null;
      const paused = !!v.paused;
      const seeking = !!v.seeking;
      const rate = typeof v.playbackRate === 'number' && v.playbackRate > 0 ? v.playbackRate : 1;
      if (lastTuWall > 0 && wallMs > lastTuWall && wallMs - lastTuWall < 120000) {
        const gap = wallMs - lastTuWall;
        sumGap += gap;
        gapCount += 1;
        if (gap > maxGap) maxGap = gap;
      }
      if (typeof ct === 'number' && lastTuCt != null && !seeking) {
        const dct = ct - lastTuCt;
        if (!paused && Math.abs(dct) > LARGE_DISCONTINUITY_SEC) largeDiscontinuityCount += 1;
      }
      if (!paused && !seeking && typeof ct === 'number' && lastTuCt != null && lastTuWall > 0) {
        const wallSec = (wallMs - lastTuWall) / 1000;
        if (wallSec > 0 && wallSec < 60) {
          const dct = ct - lastTuCt;
          if (Math.abs(dct) < LARGE_DISCONTINUITY_SEC) {
            expectedAdvanceSec += wallSec * rate;
            actualAdvanceSec += dct;
          }
        }
      }
      lastTuWall = wallMs;
      lastTuCt = ct;
    },
    onFrozenHeuristic() {
      frozenWhilePlayingCount += 1;
      zeroAdvanceWhilePlayingCount += 1;
    },
    getSummary() {
      const averageTimeupdateGapMs = gapCount ? +(sumGap / gapCount).toFixed(1) : null;
      const expectedVsActualAdvanceRatio =
        expectedAdvanceSec > 0.25 && Number.isFinite(actualAdvanceSec)
          ? +(actualAdvanceSec / expectedAdvanceSec).toFixed(3)
          : null;
      return {
        averageTimeupdateGapMs,
        maxTimeupdateGapMs: maxGap > 0 ? maxGap : null,
        timeupdateGapSampleCount: gapCount,
        zeroAdvanceWhilePlayingCount,
        largeDiscontinuityCount,
        expectedVsActualAdvanceRatio,
        frozenWhilePlayingCount
      };
    }
  };
}

export function createVideoPlayerProfiler(opts) {
  const getVideo = opts.getVideo;
  const enrichSnapshot = typeof opts.enrichSnapshot === 'function' ? opts.enrichSnapshot : null;
  const getExportExtras = typeof opts.getExportExtras === 'function' ? opts.getExportExtras : null;
  const snapshotIntervalMs = Math.max(500, opts.snapshotIntervalMs ?? 3000);
  const maxSnapshots = Math.min(20000, Math.max(50, opts.maxSnapshots ?? 4000));
  const maxEvents = Math.min(50000, Math.max(200, opts.maxEvents ?? 20000));
  const stallCheckIntervalMs = Math.max(200, opts.stallCheckIntervalMs ?? 500);
  const timeupdateLogMinIntervalMs = Math.max(500, opts.timeupdateLogMinIntervalMs ?? 2000);
  const progressLogMinIntervalMs = Math.max(500, opts.progressLogMinIntervalMs ?? 2000);

  /** @type {ProfilerEvent[]} */
  const events = [];
  /** @type {Record<string, number>} */
  const eventTypeCounts = {};
  /** @type {unknown[]} */
  const snapshots = [];

  let recording = false;
  let startedAtMs = /** @type {number|null} */ (null);
  let endedAtMs = /** @type {number|null} */ (null);

  /** Passed to `enrichSnapshot` for the extra snapshot taken after **Mark moment** (then cleared). */
  let snapshotEnrichContext = /** @type {{ userMarker?: boolean, seq?: number, note?: string }|null} */ (null);

  /** @type {ReturnType<typeof setInterval>|null} */
  let snapshotTimerId = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let stallTimerId = null;

  /** @type {HTMLVideoElement|null} */
  let boundEl = null;

  let lastTimeupdateLogAt = 0;
  let lastProgressLogAt = 0;

  /** @type {{ t: number, ct: number }|null} */
  let stallPrev = null;
  let playheadStallMarkers = 0;

  /** @type {MediaError|null} */
  let lastMediaError = null;

  /** @type {{ totalVideoFrames: number|null, droppedVideoFrames: number|null }|null} */
  let lastPlaybackQualitySample = null;

  /** `performance.now()` at session start — for monoMs on events/snapshots until clear. */
  let sessionMonoOrigin = /** @type {number|null} */ (null);
  /** Truncated `currentSrc` fingerprint to detect MSE blob swaps on the same node. */
  let lastSrcFinger = '';
  let userMarkerSeq = 0;

  const progression = createProgressionTracker();

  let bufferRecoveryActive = false;
  let bufferRecoveryStartAt = 0;
  let lastDerivedFrozenAt = 0;
  /** @type {boolean|null} */
  let lastAdModeVisible = null;
  /** @type {Record<string, unknown>|null} */
  let lastSnapshotBrief = null;
  let playbackRateNudgeActive = false;

  /** @type {(() => void)|null} */
  let pageHideHandler = null;

  function pushDerived(type, /** @type {Record<string, unknown>} */ detail = {}) {
    if (!recording) return;
    const row = { type: String(type).slice(0, 72), derived: true, ...detail };
    pushEvent(row);
  }

  function endBufferRecovery(reason) {
    if (!bufferRecoveryActive) return;
    const now = Date.now();
    pushDerived('buffer_recovery_end', {
      durationMs: Math.min(600000, now - bufferRecoveryStartAt),
      reason: truncUrl(String(reason || ''), 48)
    });
    bufferRecoveryActive = false;
  }

  /**
   * @param {string} type
   * @param {HTMLVideoElement} v
   */
  function considerDerivedFromMediaEvent(type, v) {
    if (!recording || !v || !(v instanceof HTMLVideoElement)) return;
    if (type === 'waiting' || type === 'stalled') {
      if (!v.paused && !v.ended && !bufferRecoveryActive) {
        bufferRecoveryActive = true;
        bufferRecoveryStartAt = Date.now();
        pushDerived('buffer_recovery_start', {
          from: type,
          currentTime: typeof v.currentTime === 'number' ? +v.currentTime.toFixed(3) : null,
          readyState: v.readyState,
          playbackRate: v.playbackRate
        });
      }
      return;
    }
    if (
      bufferRecoveryActive &&
      (type === 'playing' ||
        type === 'canplaythrough' ||
        type === 'seeked' ||
        type === 'pause' ||
        type === 'emptied' ||
        type === 'abort')
    ) {
      endBufferRecovery(type);
    }
  }

  /**
   * @param {Record<string, unknown>} snap
   */
  function snapshotBriefFromSnap(snap) {
    return {
      currentTime: snap.currentTime,
      bufferAheadSec: snap.bufferAheadSec,
      playbackRate: snap.playbackRate,
      readyState: snap.readyState,
      paused: snap.paused,
      seeking: snap.seeking,
      currentSrc: snap.currentSrc,
      documentVisibility: snap.documentVisibility,
      videoPresent: snap.videoPresent
    };
  }

  /**
   * Sync decision / reconcile outcomes (from app.js). Lightweight, capped strings/numbers only.
   * @param {string} type
   * @param {Record<string, unknown>|null|undefined} [detail]
   */
  function recordDecisionEvent(type, detail) {
    if (!recording) return;
    const t = String(type || 'unknown').slice(0, 72);
    const base = sanitizeDecisionDetail(detail);
    pushEvent({ type: t, decision: true, ...base });
  }

  /**
   * @param {'start'|'end'} phase
   * @param {Record<string, unknown>|null|undefined} [detail]
   */
  function recordRemoteSyncApplyPhase(phase, detail) {
    if (!recording) return;
    const p = phase === 'end' ? 'end' : 'start';
    const base = sanitizeDecisionDetail(detail);
    pushDerived(p === 'start' ? 'remote_sync_apply_start' : 'remote_sync_apply_end', base);
  }

  /**
   * Soft drift playbackRate nudges from sync (app.js); not user UI rate changes.
   * @param {'start'|'end'} phase
   * @param {Record<string, unknown>|null|undefined} [detail]
   */
  function recordPlaybackRateNudgePhase(phase, detail) {
    if (!recording) return;
    const p = phase === 'end' ? 'end' : 'start';
    const base = sanitizeDecisionDetail(detail);
    if (p === 'start') {
      playbackRateNudgeActive = true;
      pushDerived('playback_rate_nudge_start', base);
    } else {
      if (!playbackRateNudgeActive) return;
      playbackRateNudgeActive = false;
      pushDerived('playback_rate_nudge_end', base);
    }
  }

  function pushEvent(ev) {
    const t = typeof ev.t === 'number' ? ev.t : Date.now();
    const type = String(ev.type || 'unknown');
    eventTypeCounts[type] = (eventTypeCounts[type] || 0) + 1;
    const mono = perfNowMs();
    const row = {
      t,
      ...ev,
      ...(mono != null && sessionMonoOrigin != null ? { monoMs: +(mono - sessionMonoOrigin).toFixed(1) } : {})
    };
    events.push(row);
    while (events.length > maxEvents) events.shift();
  }

  /** @type {Record<string, unknown>|null} */
  let lastIntersectionSample = null;
  /** @type {IntersectionObserver|null} */
  let ioObserver = null;
  /** @type {PerformanceObserver|null} */
  let longTaskObs = null;

  function disconnectIntersectionObserver() {
    if (ioObserver) {
      try {
        ioObserver.disconnect();
      } catch {
        /* ignore */
      }
      ioObserver = null;
    }
    lastIntersectionSample = null;
  }

  /**
   * @param {HTMLVideoElement|null} v
   */
  function attachIntersectionObserver(v) {
    disconnectIntersectionObserver();
    if (!recording || !v || !(v instanceof HTMLVideoElement)) return;
    try {
      ioObserver = new IntersectionObserver(
        (entries) => {
          if (!recording || !entries.length) return;
          const e = entries[entries.length - 1];
          const br = e.boundingClientRect;
          const ir = e.intersectionRect;
          lastIntersectionSample = {
            at: Date.now(),
            intersectionRatio: +e.intersectionRatio.toFixed(3),
            isIntersecting: e.isIntersecting,
            boundingClientRect: {
              x: +br.x.toFixed(0),
              y: +br.y.toFixed(0),
              w: +br.width.toFixed(0),
              h: +br.height.toFixed(0)
            },
            intersectionRect: {
              x: +ir.x.toFixed(0),
              y: +ir.y.toFixed(0),
              w: +ir.width.toFixed(0),
              h: +ir.height.toFixed(0)
            }
          };
        },
        { threshold: [0, 0.01, 0.1, 0.25, 0.5, 0.75, 1] }
      );
      ioObserver.observe(v);
    } catch {
      ioObserver = null;
    }
  }

  function disconnectLongTaskObserver() {
    if (longTaskObs) {
      try {
        longTaskObs.disconnect();
      } catch {
        /* ignore */
      }
      longTaskObs = null;
    }
  }

  function attachLongTaskObserver() {
    disconnectLongTaskObserver();
    if (!recording) return;
    try {
      const PO = typeof PerformanceObserver !== 'undefined' ? PerformanceObserver : null;
      if (!PO) return;
      longTaskObs = new PerformanceObserver((list) => {
        if (!recording) return;
        for (const e of list.getEntries()) {
          pushEvent({
            type: 'performance_longtask',
            durationMs: +e.duration.toFixed(1),
            startTimeMs: +e.startTime.toFixed(1),
            name: String(e.name || 'longtask').slice(0, 96)
          });
        }
      });
      longTaskObs.observe({ type: 'longtask', buffered: true });
    } catch {
      longTaskObs = null;
    }
  }

  function pushSnapshot() {
    const v = getVideo();
    const snap = /** @type {Record<string, unknown>} */ (captureVideoSnapshot(v));
    if (lastIntersectionSample) {
      snap.intersectionObserver = { ...lastIntersectionSample };
    }
    if (lastVideoFrameCallbackSample) {
      snap.videoFrameCallback = { ...lastVideoFrameCallbackSample };
    }
    const q = snap.playbackQuality;
    if (q && typeof q === 'object' && lastPlaybackQualitySample) {
      const t0 = lastPlaybackQualitySample.totalVideoFrames;
      const d0 = lastPlaybackQualitySample.droppedVideoFrames;
      const t1 = /** @type {{ totalVideoFrames?: number }} */ (q).totalVideoFrames;
      const d1 = /** @type {{ droppedVideoFrames?: number }} */ (q).droppedVideoFrames;
      if (typeof t1 === 'number' && typeof d1 === 'number' && typeof t0 === 'number' && typeof d0 === 'number') {
        snap.playbackQualityDelta = {
          totalVideoFramesDelta: t1 - t0,
          droppedVideoFramesDelta: d1 - d0
        };
      }
    }
    if (q && typeof q === 'object') {
      const tq = /** @type {{ totalVideoFrames?: number, droppedVideoFrames?: number }} */ (q);
      lastPlaybackQualitySample = {
        totalVideoFrames: typeof tq.totalVideoFrames === 'number' ? tq.totalVideoFrames : null,
        droppedVideoFrames: typeof tq.droppedVideoFrames === 'number' ? tq.droppedVideoFrames : null
      };
    }
    if (typeof snap.perfNowMs === 'number' && sessionMonoOrigin != null) {
      snap.monoSinceSessionStartMs = +(snap.perfNowMs - sessionMonoOrigin).toFixed(1);
    }
    if (v && v instanceof HTMLVideoElement && recording) {
      const finger = String(v.currentSrc || '').slice(0, 96);
      if (lastSrcFinger && finger && finger !== lastSrcFinger) {
        pushEvent({
          type: 'current_src_changed',
          from: truncUrl(lastSrcFinger, 72),
          to: truncUrl(finger, 72)
        });
        pushDerived('src_swap_detected', {
          from: truncUrl(lastSrcFinger, 72),
          to: truncUrl(finger, 72)
        });
      }
      if (finger) lastSrcFinger = finger;
    }
    const enrichCtx = snapshotEnrichContext;
    snapshotEnrichContext = null;
    if (enrichSnapshot) {
      try {
        enrichSnapshot(snap, v, enrichCtx);
      } catch {
        /* ignore */
      }
    }
    try {
      const vis = adModeVisibleFromSnapshot(/** @type {Record<string, unknown>} */ (snap));
      if (lastAdModeVisible === null) {
        lastAdModeVisible = vis;
      } else if (lastAdModeVisible !== vis) {
        if (vis) pushDerived('ad_mode_visible_start', { snapshotAt: snap.at });
        else pushDerived('ad_mode_visible_end', { snapshotAt: snap.at });
        lastAdModeVisible = vis;
      }
    } catch {
      /* ignore */
    }
    const brief = snapshotBriefFromSnap(/** @type {Record<string, unknown>} */ (snap));
    const deltaSummary = computeDeltaSummary(lastSnapshotBrief, brief);
    if (deltaSummary) {
      /** @type {Record<string, unknown>} */ (snap).deltaSummary = deltaSummary;
    }
    lastSnapshotBrief = brief;

    snapshots.push(snap);
    while (snapshots.length > maxSnapshots) snapshots.shift();
  }

  const videoListenerNames = [
    'play',
    'pause',
    'playing',
    'waiting',
    'stalled',
    'seeking',
    'seeked',
    'timeupdate',
    'loadedmetadata',
    'loadeddata',
    'canplay',
    'canplaythrough',
    'progress',
    'suspend',
    'abort',
    'error',
    'emptied',
    'ratechange',
    'durationchange',
    'volumechange',
    'ended',
    'resize',
    'enterpictureinpicture',
    'leavepictureinpicture',
    'encrypted',
    'waitingforkey'
  ];

  /** @type {number|null} */
  let vfcHandle = null;
  /** @type {HTMLVideoElement|null} */
  let vfcEl = null;
  /** @type {Record<string, unknown>|null} */
  let lastVideoFrameCallbackSample = null;

  function stopVideoFrameMetrics() {
    if (vfcEl != null && vfcHandle != null) {
      try {
        if (typeof vfcEl.cancelVideoFrameCallback === 'function') {
          vfcEl.cancelVideoFrameCallback(vfcHandle);
        }
      } catch {
        /* ignore */
      }
    }
    vfcHandle = null;
    vfcEl = null;
  }

  /**
   * Samples presented frames: mediaTime vs rAF clock — useful for jank vs playhead stalls.
   * @param {HTMLVideoElement} el
   */
  function startVideoFrameMetrics(el) {
    stopVideoFrameMetrics();
    lastVideoFrameCallbackSample = null;
    if (!recording || !el || typeof el.requestVideoFrameCallback !== 'function') return;
    vfcEl = el;
    const tick = (now, metadata) => {
      if (!recording || boundEl !== el) return;
      try {
        const md = metadata && typeof metadata === 'object' ? /** @type {Record<string, unknown>} */ (metadata) : {};
        lastVideoFrameCallbackSample = {
          at: Date.now(),
          perfNowMs: typeof now === 'number' ? +now.toFixed(3) : null,
          mediaTime: typeof md.mediaTime === 'number' ? +/** @type {number} */ (md.mediaTime).toFixed(4) : null,
          presentationTime:
            typeof md.presentationTime === 'number'
              ? +/** @type {number} */ (md.presentationTime).toFixed(3)
              : null,
          presentedWidth: typeof md.width === 'number' ? md.width : null,
          presentedHeight: typeof md.height === 'number' ? md.height : null
        };
      } catch {
        /* ignore */
      }
      if (!recording || boundEl !== el) return;
      try {
        vfcHandle = el.requestVideoFrameCallback(tick);
      } catch {
        vfcHandle = null;
      }
    };
    try {
      vfcHandle = el.requestVideoFrameCallback(tick);
    } catch {
      vfcHandle = null;
      vfcEl = null;
    }
  }

  function onVideoError(e) {
    const el = /** @type {HTMLVideoElement} */ (e.target);
    try {
      const err = el.error;
      lastMediaError = err;
      const code = err ? err.code : -1;
      pushEvent({
        type: 'error',
        mediaErrorCode: code,
        mediaErrorName: MEDIA_ERROR_NAMES[/** @type {1|2|3|4} */ (code)] || `UNKNOWN_${code}`,
        message: err && err.message ? truncUrl(err.message, 160) : ''
      });
    } catch {
      pushEvent({ type: 'error', mediaErrorCode: -1, mediaErrorName: 'UNKNOWN', message: '' });
    }
  }

  /** @param {Event} e */
  function onVideoGeneric(e) {
    const type = e.type;
    const v = /** @type {HTMLVideoElement} */ (e.target);
    const now = Date.now();
    if (type === 'timeupdate') {
      try {
        progression.onTimeupdate(v, now);
      } catch {
        /* ignore */
      }
      if (now - lastTimeupdateLogAt < timeupdateLogMinIntervalMs) return;
      lastTimeupdateLogAt = now;
    }
    if (type === 'progress') {
      if (now - lastProgressLogAt < progressLogMinIntervalMs) return;
      lastProgressLogAt = now;
    }
    considerDerivedFromMediaEvent(type, v);
    pushEvent({
      t: now,
      type,
      currentTime: typeof v.currentTime === 'number' ? +v.currentTime.toFixed(3) : null,
      paused: v.paused,
      seeking: v.seeking,
      readyState: v.readyState,
      playbackRate: v.playbackRate
    });
  }

  function unbindVideo() {
    if (!boundEl) return;
    stopVideoFrameMetrics();
    boundEl.removeEventListener('error', onVideoError);
    for (const n of videoListenerNames) {
      if (n === 'error') continue;
      boundEl.removeEventListener(n, onVideoGeneric);
    }
    boundEl = null;
  }

  function bindVideo(v) {
    if (v === boundEl) return;
    const prevEl = boundEl;
    unbindVideo();
    if (!v || !(v instanceof HTMLVideoElement)) return;
    boundEl = v;
    if (recording && prevEl instanceof HTMLVideoElement && prevEl !== v) {
      pushEvent({
        type: 'video_element_rebound',
        prevSrc: truncUrl(prevEl.currentSrc, 80),
        newSrc: truncUrl(v.currentSrc, 80)
      });
      lastSrcFinger = '';
    }
    boundEl.addEventListener('error', onVideoError);
    for (const n of videoListenerNames) {
      if (n === 'error') continue;
      boundEl.addEventListener(n, onVideoGeneric);
    }
    if (recording) {
      attachIntersectionObserver(boundEl);
      startVideoFrameMetrics(boundEl);
    }
  }

  function syncBoundVideo() {
    const v = getVideo();
    bindVideo(v);
  }

  function onVisibilityChange() {
    if (!recording) return;
    try {
      pushEvent({
        type: 'page_visibility',
        hidden: document.hidden,
        visibilityState: document.visibilityState || ''
      });
    } catch {
      /* ignore */
    }
  }

  function onFullscreenChange() {
    if (!recording) return;
    try {
      const fs = document.fullscreenElement || document.webkitFullscreenElement || null;
      pushEvent({
        type: 'page_fullscreen',
        active: !!fs,
        tag: fs && fs instanceof Element ? fs.tagName : null
      });
    } catch {
      /* ignore */
    }
  }

  /** @type {(() => void)|null} */
  let visHandler = null;
  /** @type {(() => void)|null} */
  let fsHandler = null;
  /** @type {(() => void)|null} */
  let winFocusHandler = null;
  /** @type {(() => void)|null} */
  let winBlurHandler = null;
  /** @type {(() => void)|null} */
  let winResizeHandler = null;

  function onWindowFocus() {
    if (!recording) return;
    try {
      pushEvent({ type: 'page_window_focus', hasFocus: true });
    } catch {
      /* ignore */
    }
  }

  function onWindowBlur() {
    if (!recording) return;
    try {
      pushEvent({ type: 'page_window_focus', hasFocus: false });
    } catch {
      /* ignore */
    }
  }

  function onWindowResize() {
    if (!recording) return;
    try {
      if (typeof window === 'undefined') return;
      pushEvent({ type: 'window_resize', innerWidth: window.innerWidth, innerHeight: window.innerHeight });
    } catch {
      /* ignore */
    }
  }

  function onPageHide() {
    if (!recording) return;
    try {
      pushEvent({ type: 'page_lifecycle', phase: 'pagehide' });
    } catch {
      /* ignore */
    }
  }

  function startPageListeners() {
    if (typeof document === 'undefined') return;
    visHandler = onVisibilityChange;
    fsHandler = onFullscreenChange;
    document.addEventListener('visibilitychange', visHandler);
    document.addEventListener('fullscreenchange', fsHandler);
    try {
      document.addEventListener('webkitfullscreenchange', fsHandler);
    } catch {
      /* ignore */
    }
    if (typeof window !== 'undefined') {
      winFocusHandler = onWindowFocus;
      winBlurHandler = onWindowBlur;
      winResizeHandler = onWindowResize;
      window.addEventListener('focus', winFocusHandler);
      window.addEventListener('blur', winBlurHandler);
      window.addEventListener('resize', winResizeHandler);
      pageHideHandler = onPageHide;
      window.addEventListener('pagehide', pageHideHandler);
    }
  }

  function stopPageListeners() {
    if (typeof document === 'undefined') return;
    if (visHandler) document.removeEventListener('visibilitychange', visHandler);
    if (fsHandler) {
      document.removeEventListener('fullscreenchange', fsHandler);
      try {
        document.removeEventListener('webkitfullscreenchange', fsHandler);
      } catch {
        /* ignore */
      }
    }
    visHandler = null;
    fsHandler = null;
    if (typeof window !== 'undefined') {
      if (winFocusHandler) window.removeEventListener('focus', winFocusHandler);
      if (winBlurHandler) window.removeEventListener('blur', winBlurHandler);
      if (winResizeHandler) window.removeEventListener('resize', winResizeHandler);
      if (pageHideHandler) window.removeEventListener('pagehide', pageHideHandler);
    }
    winFocusHandler = null;
    winBlurHandler = null;
    winResizeHandler = null;
    pageHideHandler = null;
  }

  function stallTick() {
    if (!recording) return;
    syncBoundVideo();
    const v = getVideo();
    const now = Date.now();
    if (!v || v.paused || v.seeking || !v.playbackRate) {
      stallPrev = null;
      return;
    }
    const ct = v.currentTime;
    if (typeof ct !== 'number' || !Number.isFinite(ct)) {
      stallPrev = null;
      return;
    }
    if (!stallPrev) {
      stallPrev = { t: now, ct };
      return;
    }
    const wallSec = (now - stallPrev.t) / 1000;
    const deltaCt = ct - stallPrev.ct;
    const expected = wallSec * v.playbackRate;
    if (wallSec >= 0.45 && expected > 0.08 && deltaCt < expected * 0.22) {
      playheadStallMarkers++;
      pushEvent({
        type: 'playhead_stall_heuristic',
        wallSec: +wallSec.toFixed(3),
        deltaCurrentTime: +deltaCt.toFixed(4),
        expectedAdvance: +expected.toFixed(4),
        playbackRate: v.playbackRate,
        readyState: v.readyState
      });
      try {
        progression.onFrozenHeuristic();
      } catch {
        /* ignore */
      }
      if (now - lastDerivedFrozenAt >= DERIVED_FROZEN_DEBOUNCE_MS) {
        lastDerivedFrozenAt = now;
        pushDerived('video_frozen_but_not_paused', {
          wallSec: +wallSec.toFixed(3),
          deltaCurrentTime: +deltaCt.toFixed(4),
          expectedAdvance: +expected.toFixed(4),
          playbackRate: v.playbackRate,
          readyState: v.readyState
        });
      }
    }
    stallPrev = { t: now, ct };
  }

  function snapshotTick() {
    if (!recording) return;
    syncBoundVideo();
    pushSnapshot();
  }

  return {
    start() {
      if (recording) return;
      events.length = 0;
      snapshots.length = 0;
      for (const k of Object.keys(eventTypeCounts)) delete eventTypeCounts[k];
      lastTimeupdateLogAt = 0;
      lastProgressLogAt = 0;
      lastVideoFrameCallbackSample = null;
      stallPrev = null;
      playheadStallMarkers = 0;
      lastMediaError = null;
      lastPlaybackQualitySample = null;
      lastSrcFinger = '';
      userMarkerSeq = 0;
      progression.reset();
      bufferRecoveryActive = false;
      bufferRecoveryStartAt = 0;
      lastDerivedFrozenAt = 0;
      lastAdModeVisible = null;
      lastSnapshotBrief = null;
      playbackRateNudgeActive = false;
      sessionMonoOrigin = perfNowMs();
      endedAtMs = null;
      startedAtMs = Date.now();
      recording = true;
      syncBoundVideo();
      pushEvent({
        type: 'session_start',
        snapshotIntervalMs,
        maxSnapshots,
        maxEvents,
        schema: PROFILER_SCHEMA
      });
      pushSnapshot();
      attachLongTaskObserver();
      startPageListeners();
      onVisibilityChange();
      snapshotTimerId = setInterval(snapshotTick, snapshotIntervalMs);
      stallTimerId = setInterval(stallTick, stallCheckIntervalMs);
    },

    stop() {
      if (!recording) return;
      recording = false;
      endedAtMs = Date.now();
      if (snapshotTimerId) {
        clearInterval(snapshotTimerId);
        snapshotTimerId = null;
      }
      if (stallTimerId) {
        clearInterval(stallTimerId);
        stallTimerId = null;
      }
      stopPageListeners();
      pushEvent({ type: 'session_stop' });
      pushSnapshot();
      disconnectIntersectionObserver();
      disconnectLongTaskObserver();
      unbindVideo();
    },

    /** Call when <video> may have been swapped while recording */
    notifyVideoMayHaveChanged() {
      if (recording) syncBoundVideo();
    },

    /**
     * Annotate the timeline (e.g. “ad started”, “sync broke”) — adds an event and an extra snapshot.
     * @param {string} [note]
     */
    dropMarker(note) {
      if (!recording) return false;
      userMarkerSeq += 1;
      const label = note != null && String(note).trim() !== '' ? truncUrl(String(note).trim(), 140) : `marker_${userMarkerSeq}`;
      pushEvent({ type: 'user_marker', seq: userMarkerSeq, note: label });
      snapshotEnrichContext = { userMarker: true, seq: userMarkerSeq, note: label };
      pushSnapshot();
      return true;
    },

    isRecording() {
      return recording;
    },

    getStatus() {
      const maxWallMin = Math.max(1, Math.round((maxSnapshots * snapshotIntervalMs) / 60000));
      return {
        recording,
        startedAtMs,
        endedAtMs,
        snapshotCount: snapshots.length,
        eventCount: events.length,
        eventTypeCounts: { ...eventTypeCounts },
        userMarkerCount: eventTypeCounts.user_marker ?? 0,
        playheadStallMarkers,
        recordingLimits: {
          snapshotIntervalMs,
          maxSnapshots,
          maxEvents,
          /** Wall-time span represented if the snapshot buffer is full (ring drops oldest). */
          approxMaxWallMinutes: maxWallMin
        },
        lastMediaError: lastMediaError
          ? {
              code: lastMediaError.code,
              name: MEDIA_ERROR_NAMES[/** @type {1|2|3|4} */ (lastMediaError.code)] || `UNKNOWN_${lastMediaError.code}`,
              message: lastMediaError.message ? truncUrl(lastMediaError.message, 120) : ''
            }
          : null,
        progressionQuality: progression.getSummary()
      };
    },

    /**
     * @param {object} pageMeta
     * @param {string} [pageMeta.hostname]
     * @param {string} [pageMeta.pathname]
     * @param {string} [pageMeta.userAgent]
     * @param {string} [pageMeta.platformHandlerKey]
     * @param {string} [pageMeta.extensionVersion]
     * @param {{ compact?: boolean, includeVideoFrame?: boolean }} [exportOpts]
     */
    buildExportPayload(pageMeta = {}, exportOpts = {}) {
      const compact = !!exportOpts.compact;
      const includeVideoFrame = !!exportOpts.includeVideoFrame;
      const st = this.getStatus();
      /** @type {Record<string, unknown>} */
      const rollup = computeSessionRollup(snapshots, events);
      const capMin = Math.max(1, Math.round((maxSnapshots * snapshotIntervalMs) / 60000));
      let snapOut = snapshots.slice();
      if (compact && snapOut.length > 520) {
        snapOut = snapOut.slice(-520);
      }
      if (compact && snapOut.length > 1) {
        for (let i = 0; i < snapOut.length - 1; i++) {
          const s = snapOut[i];
          if (s && typeof s === 'object' && 'videoElement' in /** @type {object} */ (s)) {
            delete /** @type {Record<string, unknown>} */ (s).videoElement;
          }
        }
      }
      /** @type {Record<string, unknown>} */
      const payload = {
        schema: PROFILER_SCHEMA,
        exportedAtMs: Date.now(),
        exportOptions: { compact, includeVideoFrame },
        session: {
          startedAtMs,
          endedAtMs,
          recording,
          sessionMonoOriginMs: sessionMonoOrigin,
          environment: captureEnvironmentSnapshot(),
          options: {
            snapshotIntervalMs,
            maxSnapshots,
            maxEvents,
            stallCheckIntervalMs,
            timeupdateLogMinIntervalMs,
            progressLogMinIntervalMs
          },
          summary: {
            snapshotCount: snapshots.length,
            eventCount: events.length,
            eventTypeCounts: { ...eventTypeCounts },
            playheadStallMarkers: st.playheadStallMarkers,
            lastMediaError: st.lastMediaError,
            progressionQuality: progression.getSummary()
          },
          timelineCapacity: {
            snapshotIntervalMs,
            maxSnapshots,
            maxEvents,
            approxMaxWallMinutesIfBufferFull: capMin,
            ringBufferBehavior:
              'When snapshot or event caps are reached, oldest rows are removed; recording and the extension continue.'
          },
          rollup
        },
        page: {
          hostname: pageMeta.hostname != null ? String(pageMeta.hostname) : '',
          pathname: pageMeta.pathname != null ? String(pageMeta.pathname) : '',
          userAgent: pageMeta.userAgent != null ? truncUrl(pageMeta.userAgent, 220) : '',
          platformHandlerKey: pageMeta.platformHandlerKey != null ? String(pageMeta.platformHandlerKey) : '',
          extensionVersion: pageMeta.extensionVersion != null ? String(pageMeta.extensionVersion) : ''
        },
        snapshots: snapOut,
        events: events.slice()
      };
      if (includeVideoFrame) {
        payload.videoFrame = tryCaptureVideoFrameDataUrl(getVideo());
      }
      if (getExportExtras) {
        try {
          const x = getExportExtras();
          if (x && typeof x === 'object') Object.assign(payload, x);
        } catch {
          /* ignore */
        }
      }
      return payload;
    },

    clearSession() {
      const wasRec = recording;
      if (wasRec) this.stop();
      events.length = 0;
      snapshots.length = 0;
      for (const k of Object.keys(eventTypeCounts)) delete eventTypeCounts[k];
      startedAtMs = null;
      endedAtMs = null;
      playheadStallMarkers = 0;
      lastMediaError = null;
      stallPrev = null;
      lastSrcFinger = '';
      sessionMonoOrigin = null;
      userMarkerSeq = 0;
      lastVideoFrameCallbackSample = null;
      progression.reset();
      bufferRecoveryActive = false;
      bufferRecoveryStartAt = 0;
      lastDerivedFrozenAt = 0;
      lastAdModeVisible = null;
      lastSnapshotBrief = null;
      playbackRateNudgeActive = false;
      disconnectIntersectionObserver();
      disconnectLongTaskObserver();
      unbindVideo();
    },

    recordDecisionEvent,
    /** @param {'start'|'end'} phase @param {Record<string, unknown>|null|undefined} [detail] */
    recordRemoteSyncApply(phase, detail) {
      recordRemoteSyncApplyPhase(phase, detail);
    },
    /** @param {'start'|'end'} phase @param {Record<string, unknown>|null|undefined} [detail] */
    recordPlaybackRateNudge(phase, detail) {
      recordPlaybackRateNudgePhase(phase, detail);
    }
  };
}
