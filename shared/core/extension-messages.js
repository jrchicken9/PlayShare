/**
 * Extension internal routing: content/popup/join → service worker (`background.js`).
 *
 * `source` + `type` must stay aligned with `background.js` (`msg.source === 'playshare'`).
 * Relay `type` values that are forwarded to the signaling server match `signaling-client.js`.
 */

import { PlayShareSignalingClientType as Sig } from './signaling-client.js';

/** @typedef {'playshare'} PlayShareContentSource */

/** Must match `background.js` listener. */
export const PLAYS_SHARE_CONTENT_SOURCE = /** @type {PlayShareContentSource} */ ('playshare');

/** Message types handled by the service worker only (not sent on the room WebSocket as-is). */
export const PlayShareExtensionBridgeType = Object.freeze({
  GET_STATE: 'GET_STATE',
  GET_DIAG: 'GET_DIAG',
  GET_ROOM_LINK_DATA: 'GET_ROOM_LINK_DATA',
  GET_DEV_INSTALL: 'GET_DEV_INSTALL',
  SET_ROOM_VIDEO_URL: 'SET_ROOM_VIDEO_URL',
  UPDATE_COUNTDOWN_ON_PLAY: 'UPDATE_COUNTDOWN_ON_PLAY',
  REQUEST_WS_RECONNECT: 'REQUEST_WS_RECONNECT',
  TOGGLE_SIDEBAR_ACTIVE: 'TOGGLE_SIDEBAR_ACTIVE',
  DIAG_UPLOAD_UNIFIED: 'DIAG_UPLOAD_UNIFIED'
});

/**
 * @param {string} type
 * @param {Record<string, unknown>} [fields]
 */
function frame(type, fields = {}) {
  return { source: PLAYS_SHARE_CONTENT_SOURCE, type, ...fields };
}

// ── Queries (expect `sendResponse` / callback) ───────────────────────────────

export function bgGetState() {
  return frame(PlayShareExtensionBridgeType.GET_STATE);
}

export function bgGetDiag() {
  return frame(PlayShareExtensionBridgeType.GET_DIAG);
}

export function bgGetRoomLinkData() {
  return frame(PlayShareExtensionBridgeType.GET_ROOM_LINK_DATA);
}

export function bgGetDevInstall() {
  return frame(PlayShareExtensionBridgeType.GET_DEV_INSTALL);
}

// ── Popup / join (service worker control) ───────────────────────────────────

export function bgRequestWsReconnect() {
  return frame(PlayShareExtensionBridgeType.REQUEST_WS_RECONNECT);
}

/**
 * @param {object} fields
 * @param {string} fields.username
 * @param {boolean} fields.hostOnlyControl
 * @param {boolean} fields.countdownOnPlay
 */
export function bgCreateRoom(fields) {
  return frame(Sig.CREATE_ROOM, fields);
}

export function bgToggleSidebarActive() {
  return frame(PlayShareExtensionBridgeType.TOGGLE_SIDEBAR_ACTIVE);
}

// ── Room / server relay ─────────────────────────────────────────────────────

/** @param {string} roomCode @param {string} username */
export function bgJoinRoom(roomCode, username) {
  return frame(Sig.JOIN_ROOM, { roomCode, username });
}

export function bgLeaveRoom() {
  return frame(Sig.LEAVE_ROOM);
}

/** @param {string|null} videoUrl */
export function bgSetRoomVideoUrl(videoUrl) {
  return frame(PlayShareExtensionBridgeType.SET_ROOM_VIDEO_URL, { videoUrl });
}

/** @param {number} currentTime */
export function bgPlaybackPosition(currentTime) {
  return frame(Sig.PLAYBACK_POSITION, { currentTime });
}

export function bgSyncRequest() {
  return frame(Sig.SYNC_REQUEST);
}

export function bgAdBreakStart() {
  return frame(Sig.AD_BREAK_START);
}

export function bgAdBreakEnd() {
  return frame(Sig.AD_BREAK_END);
}

/** @param {number} currentTime @param {number} sentAt */
export function bgPlay(currentTime, sentAt) {
  return frame(Sig.PLAY, { currentTime, sentAt });
}

/** @param {number} currentTime @param {number} sentAt */
export function bgPause(currentTime, sentAt) {
  return frame(Sig.PAUSE, { currentTime, sentAt });
}

/** @param {number} currentTime @param {number} sentAt */
export function bgSeek(currentTime, sentAt) {
  return frame(Sig.SEEK, { currentTime, sentAt });
}

/** @param {number} currentTime */
export function bgCountdownStart(currentTime) {
  return frame(Sig.COUNTDOWN_START, { currentTime });
}

/** @param {string} text */
export function bgChat(text) {
  return frame(Sig.CHAT, { text });
}

/** @param {'TYPING_START'|'TYPING_STOP'} typingType */
export function bgTyping(typingType) {
  return frame(typingType);
}

/** @param {string} emoji */
export function bgReaction(emoji) {
  return frame(Sig.REACTION, { emoji });
}

/** @param {boolean} value */
export function bgUpdateCountdownOnPlay(value) {
  return frame(PlayShareExtensionBridgeType.UPDATE_COUNTDOWN_ON_PLAY, { value });
}

/**
 * @param {object} fields
 * @param {number} fields.currentTime
 * @param {boolean} fields.playing
 * @param {string} fields.confidence
 */
export function bgPositionReport(fields) {
  return frame(Sig.POSITION_REPORT, fields);
}

// ── Diagnostics (relay to signaling server) ────────────────────────────────

/**
 * @param {object} fields
 * @param {string} fields.targetClientId
 * @param {string} fields.fromClientId
 * @param {string} fields.fromUsername
 * @param {string} fields.eventType
 * @param {boolean} fields.success
 * @param {number} fields.latency
 * @param {string} [fields.correlationId]
 * @param {string} fields.platform
 * @param {string} fields.platformName
 */
export function bgDiagSyncApplyResult(fields) {
  return frame(Sig.DIAG_SYNC_APPLY_RESULT, fields);
}

/**
 * @param {Record<string, unknown>} body `clientId`, `username`, `metrics`, … (no `source`/`type`)
 */
export function bgDiagSyncReport(body) {
  return frame(Sig.DIAG_SYNC_REPORT, body);
}

/**
 * @param {object} fields
 * @param {boolean} fields.active
 * @param {string} fields.collectorClientId
 */
export function bgDiagProfilerCollection(fields) {
  return frame(Sig.DIAG_PROFILER_COLLECTION, fields);
}

/**
 * @param {object} fields
 * @param {string} fields.collectorClientId
 * @param {unknown} fields.payload
 */
export function bgDiagPeerRecordingSample(fields) {
  return frame(Sig.DIAG_PEER_RECORDING_SAMPLE, fields);
}

export function bgDiagRoomTraceRequest() {
  return frame(Sig.DIAG_ROOM_TRACE_REQUEST);
}

/**
 * @param {object} envelope
 * @param {unknown} envelope.payload
 * @param {{ roomCode?: string|null, clientId?: string|null, username?: string|null }} envelope.hashSecrets
 * @param {string} envelope.extensionVersion
 * @param {string} envelope.platformHandlerKey
 * @param {string} envelope.diagnosticReportSchema
 * @param {string|null} [envelope.testRunId]
 */
export function bgDiagUploadUnified(envelope) {
  const { payload, hashSecrets, extensionVersion, platformHandlerKey, diagnosticReportSchema, testRunId } =
    envelope;
  return frame(PlayShareExtensionBridgeType.DIAG_UPLOAD_UNIFIED, {
    payload,
    hashSecrets,
    extensionVersion,
    platformHandlerKey,
    diagnosticReportSchema,
    testRunId: testRunId ?? null
  });
}
