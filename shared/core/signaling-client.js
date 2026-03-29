/**
 * WebSocket message `type` values the signaling server accepts from clients (`server.js` switch).
 * Any PlayShare client that speaks the wire protocol should use these strings — not ad-hoc literals.
 *
 * Server → client frames (ROOM_JOINED, SYNC_STATE, …) are intentionally omitted here; add a
 * `signaling-server.js` module when the first non-extension consumer needs them.
 */
/**
 * Optional `surface` on CREATE_ROOM / JOIN_ROOM JSON (server → member list):
 * - `app` — PlayShare desktop or web lobby
 * - `extension` — Chrome extension (streaming tab); omitted / legacy clients default to `extension`
 */
export const PlayShareSignalingClientType = Object.freeze({
  CREATE_ROOM: 'CREATE_ROOM',
  JOIN_ROOM: 'JOIN_ROOM',
  LEAVE_ROOM: 'LEAVE_ROOM',
  PLAY: 'PLAY',
  PAUSE: 'PAUSE',
  SEEK: 'SEEK',
  PLAYBACK_POSITION: 'PLAYBACK_POSITION',
  POSITION_REPORT: 'POSITION_REPORT',
  SYNC_REQUEST: 'SYNC_REQUEST',
  HEARTBEAT: 'HEARTBEAT',
  COUNTDOWN_START: 'COUNTDOWN_START',
  AD_BREAK_START: 'AD_BREAK_START',
  AD_BREAK_END: 'AD_BREAK_END',
  TYPING_START: 'TYPING_START',
  TYPING_STOP: 'TYPING_STOP',
  DIAG_ROOM_TRACE_REQUEST: 'DIAG_ROOM_TRACE_REQUEST',
  DIAG_SYNC_APPLY_RESULT: 'DIAG_SYNC_APPLY_RESULT',
  DIAG_SYNC_REPORT: 'DIAG_SYNC_REPORT',
  DIAG_PROFILER_COLLECTION: 'DIAG_PROFILER_COLLECTION',
  DIAG_PEER_RECORDING_SAMPLE: 'DIAG_PEER_RECORDING_SAMPLE',
  CHAT: 'CHAT',
  /** Share a TMDB title from Discover with everyone in the room (desktop lobby). */
  TITLE_SUGGEST: 'TITLE_SUGGEST',
  /** Remove a title suggestion (suggester or host only; validated on server). */
  TITLE_SUGGEST_REMOVE: 'TITLE_SUGGEST_REMOVE',
  /** Cast vote on a suggestion: value 1 = up, -1 = down, 0 = clear your vote. */
  TITLE_SUGGEST_VOTE: 'TITLE_SUGGEST_VOTE',
  /** Desktop host: agreed watch page URL + notes for the room (broadcast to all members). */
  SESSION_WATCH_SET: 'SESSION_WATCH_SET',
  REACTION: 'REACTION'
});
