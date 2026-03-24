/**
 * Content-script tunables & platform metadata (ES module — bundled by esbuild).
 */
const PLATFORMS = {
  netflix:   { name: 'Netflix',     color: '#E50914', match: /netflix\.com/ },
  disney:    { name: 'Disney+',     color: '#113CCF', match: /disneyplus\.com/ },
  prime:     { name: 'Prime Video', color: '#00A8E1', match: /primevideo\.com|amazon\.(com|ca)/ },
  crave:     { name: 'Crave',       color: '#0099CC', match: /crave\.ca/ },
  hulu:      { name: 'Hulu',        color: '#1CE783', match: /hulu\.com/ },
  max:       { name: 'Max',         color: '#002BE7', match: /hbomax\.com|max\.com/ },
  peacock:   { name: 'Peacock',     color: '#FFCC00', match: /peacocktv\.com/ },
  paramount: { name: 'Paramount+',  color: '#0064FF', match: /paramountplus\.com/ },
  appletv:   { name: 'Apple TV+',   color: '#555555', match: /appletv\.apple\.com|tv\.apple\.com/ },
  youtube:   { name: 'YouTube',     color: '#FF0000', match: /youtube\.com|youtu\.be/ }
};

export const contentConstants = {
  SYNC_THRESHOLD: 0.5,
  /** Prime ABR / UI often looks 0.7–1.5s “off” vs room clock; avoid seek thrash. */
  SYNC_THRESHOLD_PRIME: 1.2,
  SYNC_THRESHOLD_NETFLIX: 2.0,
  SYNC_DEBOUNCE_MS: 800,
  /** Coalesce rapid SYNC_STATE + position packets on Prime. */
  PRIME_APPLY_DEBOUNCE_MS: 420,
  /**
   * Host/local: trailing-edge coalesce PLAY/PAUSE wires to the room (ms). Reduces out-of-order
   * bursts when the player fires events faster than peers can apply (0 = off).
   */
  PRIME_PLAYBACK_OUTBOUND_COALESCE_MS: 140,
  /** Let Prime settle after programmatic seek before play(). */
  PRIME_SYNC_STATE_APPLY_DELAY_MS: 220,
  PRIME_TIME_JUMP_THRESHOLD: 2.0,
  /** Host → server playhead anchor (keeps room.state fresh between events). */
  HOST_POSITION_INTERVAL_MS: 2500,
  /** Rare SYNC_REQUEST fallback when periodic server `sync` is unavailable. */
  VIEWER_SYNC_INTERVAL_MS: 20000,
  /** Viewer reconciliation vs host timeline (hybrid continuous sync). */
  SYNC_RECONCILE_INTERVAL_MS: 2500,
  /** Prime: slightly faster host anchor + viewer reconcile (ABR/UI latency). */
  PRIME_HOST_POSITION_INTERVAL_MS: 2200,
  PRIME_VIEWER_RECONCILE_INTERVAL_MS: 2200,
  SYNC_DRIFT_HARD_SEC: 0.5,
  /** Below this magnitude, leave playbackRate at 1 (avoids endless micro-nudges). */
  SYNC_DRIFT_SOFT_MIN_SEC: 0.08,
  SOFT_SYNC_RATE_AHEAD: 0.95,
  SOFT_SYNC_RATE_BEHIND: 1.05,
  /** Reset playbackRate after soft nudge (ms). */
  SOFT_SYNC_RESET_MS: 2800,
  /** Align with SyncDecisionEngine soft-drift window + small margin. */
  VIEWER_SOFT_DRIFT_RESET_MS: 4720,
  /** All peers send local playhead for cluster sync badge / spread (telemetry only on server). */
  POSITION_REPORT_INTERVAL_MS: 4000,
  /** Max difference in extrapolated `currentTime` (seconds) to show “synced” for the room cluster. */
  CLUSTER_SYNC_SPREAD_SEC: 1.5,
  COUNTDOWN_SECONDS: 3,
  APPLY_DELAY_NETFLIX: 150,
  APPLY_DELAY_PRIME: 120,
  DIAG_DEBOUNCE_MS: 150,
  /**
   * Dev build only: interval for `DIAG_PEER_RECORDING_SAMPLE` while a peer is recording the video
   * profiler (collector tab); samples are bundled into the unified export JSON.
   */
  DIAG_PEER_DEV_SHARE_MS: 12000,
  /**
   * After remote sync mutates the video element, ignore play/pause/seeked long enough that we
   * do not emit PLAY/SEEK (collaborative) or revert seeks (host-only) — avoids feedback loops
   * with periodic SYNC_STATE / sync packets.
   */
  PLAYBACK_ECHO_SUPPRESS_MS: 1300,
  /**
   * After a pause sync that seeks the playhead, some players (notably Prime) call play() on seeked.
   * We must not treat that as “user resumed while room is paused” or we broadcast PLAY and fight peers.
   */
  PAUSE_SEEK_OUTBOUND_PLAY_SUPPRESS_MS: 3600,
  /** Prime: longer seek / MSE pipeline — autoplay-after-seek can arrive late. */
  PRIME_PAUSE_SEEK_OUTBOUND_PLAY_SUPPRESS_MS: 4500,
  TIME_JUMP_THRESHOLD: 1.0,
  /** Host: ignore auto-SEEK-from-timeupdate briefly after `play` (ABR/keyframe resume looks like a seek). */
  HOST_SEEK_SUPPRESS_AFTER_PLAY_MS: 1600,
  HOST_SEEK_SUPPRESS_AFTER_PLAY_MS_PRIME: 4200,
  SIDEBAR_WIDTH: { full: 360, compact: 280 },
  DIAG_EVENT_NAMES: [
    'PLAY', 'PAUSE', 'SEEK', 'CHAT', 'SYNC_STATE', 'ROOM_JOINED', 'ROOM_LEFT',
    'MEMBER_JOINED', 'MEMBER_LEFT', 'TOGGLE_SIDEBAR', 'SIDEBAR_OPEN', 'SIDEBAR_CLOSE', 'SIDEBAR_INJECT'
  ],
  PLATFORMS,
  /** @param {string} hostname */
  detectPlatform(hostname) {
    const h = hostname || '';
    for (const [key, p] of Object.entries(PLATFORMS)) {
      if (p.match.test(h)) return { key, ...p };
    }
    return { key: 'unknown', name: 'Streaming', color: '#4ECDC4', match: null };
  }
};
