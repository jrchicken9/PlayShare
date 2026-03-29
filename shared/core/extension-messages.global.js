(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // shared/core/extension-messages.js
  var extension_messages_exports = {};
  __export(extension_messages_exports, {
    PLAYS_SHARE_CONTENT_SOURCE: () => PLAYS_SHARE_CONTENT_SOURCE,
    PlayShareExtensionBridgeType: () => PlayShareExtensionBridgeType,
    bgAdBreakEnd: () => bgAdBreakEnd,
    bgAdBreakStart: () => bgAdBreakStart,
    bgChat: () => bgChat,
    bgCountdownStart: () => bgCountdownStart,
    bgCreateRoom: () => bgCreateRoom,
    bgDiagPeerRecordingSample: () => bgDiagPeerRecordingSample,
    bgDiagProfilerCollection: () => bgDiagProfilerCollection,
    bgDiagRoomTraceRequest: () => bgDiagRoomTraceRequest,
    bgDiagSyncApplyResult: () => bgDiagSyncApplyResult,
    bgDiagSyncReport: () => bgDiagSyncReport,
    bgDiagUploadUnified: () => bgDiagUploadUnified,
    bgGetDevInstall: () => bgGetDevInstall,
    bgGetDiag: () => bgGetDiag,
    bgGetRoomLinkData: () => bgGetRoomLinkData,
    bgGetState: () => bgGetState,
    bgJoinRoom: () => bgJoinRoom,
    bgLeaveRoom: () => bgLeaveRoom,
    bgPause: () => bgPause,
    bgPlay: () => bgPlay,
    bgPlaybackPosition: () => bgPlaybackPosition,
    bgPositionReport: () => bgPositionReport,
    bgReaction: () => bgReaction,
    bgRequestWsReconnect: () => bgRequestWsReconnect,
    bgSeek: () => bgSeek,
    bgSetRoomVideoUrl: () => bgSetRoomVideoUrl,
    bgSyncRequest: () => bgSyncRequest,
    bgToggleSidebarActive: () => bgToggleSidebarActive,
    bgTyping: () => bgTyping,
    bgUpdateCountdownOnPlay: () => bgUpdateCountdownOnPlay
  });

  // shared/core/signaling-client.js
  var PlayShareSignalingClientType = Object.freeze({
    CREATE_ROOM: "CREATE_ROOM",
    JOIN_ROOM: "JOIN_ROOM",
    LEAVE_ROOM: "LEAVE_ROOM",
    PLAY: "PLAY",
    PAUSE: "PAUSE",
    SEEK: "SEEK",
    PLAYBACK_POSITION: "PLAYBACK_POSITION",
    POSITION_REPORT: "POSITION_REPORT",
    SYNC_REQUEST: "SYNC_REQUEST",
    HEARTBEAT: "HEARTBEAT",
    COUNTDOWN_START: "COUNTDOWN_START",
    AD_BREAK_START: "AD_BREAK_START",
    AD_BREAK_END: "AD_BREAK_END",
    TYPING_START: "TYPING_START",
    TYPING_STOP: "TYPING_STOP",
    DIAG_ROOM_TRACE_REQUEST: "DIAG_ROOM_TRACE_REQUEST",
    DIAG_SYNC_APPLY_RESULT: "DIAG_SYNC_APPLY_RESULT",
    DIAG_SYNC_REPORT: "DIAG_SYNC_REPORT",
    DIAG_PROFILER_COLLECTION: "DIAG_PROFILER_COLLECTION",
    DIAG_PEER_RECORDING_SAMPLE: "DIAG_PEER_RECORDING_SAMPLE",
    CHAT: "CHAT",
    REACTION: "REACTION"
  });

  // shared/core/extension-messages.js
  var PLAYS_SHARE_CONTENT_SOURCE = (
    /** @type {PlayShareContentSource} */
    "playshare"
  );
  var PlayShareExtensionBridgeType = Object.freeze({
    GET_STATE: "GET_STATE",
    GET_DIAG: "GET_DIAG",
    GET_ROOM_LINK_DATA: "GET_ROOM_LINK_DATA",
    GET_DEV_INSTALL: "GET_DEV_INSTALL",
    SET_ROOM_VIDEO_URL: "SET_ROOM_VIDEO_URL",
    UPDATE_COUNTDOWN_ON_PLAY: "UPDATE_COUNTDOWN_ON_PLAY",
    REQUEST_WS_RECONNECT: "REQUEST_WS_RECONNECT",
    TOGGLE_SIDEBAR_ACTIVE: "TOGGLE_SIDEBAR_ACTIVE",
    DIAG_UPLOAD_UNIFIED: "DIAG_UPLOAD_UNIFIED"
  });
  function frame(type, fields = {}) {
    return { source: PLAYS_SHARE_CONTENT_SOURCE, type, ...fields };
  }
  function bgGetState() {
    return frame(PlayShareExtensionBridgeType.GET_STATE);
  }
  function bgGetDiag() {
    return frame(PlayShareExtensionBridgeType.GET_DIAG);
  }
  function bgGetRoomLinkData() {
    return frame(PlayShareExtensionBridgeType.GET_ROOM_LINK_DATA);
  }
  function bgGetDevInstall() {
    return frame(PlayShareExtensionBridgeType.GET_DEV_INSTALL);
  }
  function bgRequestWsReconnect() {
    return frame(PlayShareExtensionBridgeType.REQUEST_WS_RECONNECT);
  }
  function bgCreateRoom(fields) {
    return frame(PlayShareSignalingClientType.CREATE_ROOM, fields);
  }
  function bgToggleSidebarActive() {
    return frame(PlayShareExtensionBridgeType.TOGGLE_SIDEBAR_ACTIVE);
  }
  function bgJoinRoom(roomCode, username) {
    return frame(PlayShareSignalingClientType.JOIN_ROOM, { roomCode, username });
  }
  function bgLeaveRoom() {
    return frame(PlayShareSignalingClientType.LEAVE_ROOM);
  }
  function bgSetRoomVideoUrl(videoUrl) {
    return frame(PlayShareExtensionBridgeType.SET_ROOM_VIDEO_URL, { videoUrl });
  }
  function bgPlaybackPosition(currentTime) {
    return frame(PlayShareSignalingClientType.PLAYBACK_POSITION, { currentTime });
  }
  function bgSyncRequest() {
    return frame(PlayShareSignalingClientType.SYNC_REQUEST);
  }
  function bgAdBreakStart() {
    return frame(PlayShareSignalingClientType.AD_BREAK_START);
  }
  function bgAdBreakEnd() {
    return frame(PlayShareSignalingClientType.AD_BREAK_END);
  }
  function bgPlay(currentTime, sentAt) {
    return frame(PlayShareSignalingClientType.PLAY, { currentTime, sentAt });
  }
  function bgPause(currentTime, sentAt) {
    return frame(PlayShareSignalingClientType.PAUSE, { currentTime, sentAt });
  }
  function bgSeek(currentTime, sentAt) {
    return frame(PlayShareSignalingClientType.SEEK, { currentTime, sentAt });
  }
  function bgCountdownStart(currentTime) {
    return frame(PlayShareSignalingClientType.COUNTDOWN_START, { currentTime });
  }
  function bgChat(text) {
    return frame(PlayShareSignalingClientType.CHAT, { text });
  }
  function bgTyping(typingType) {
    return frame(typingType);
  }
  function bgReaction(emoji) {
    return frame(PlayShareSignalingClientType.REACTION, { emoji });
  }
  function bgUpdateCountdownOnPlay(value) {
    return frame(PlayShareExtensionBridgeType.UPDATE_COUNTDOWN_ON_PLAY, { value });
  }
  function bgPositionReport(fields) {
    return frame(PlayShareSignalingClientType.POSITION_REPORT, fields);
  }
  function bgDiagSyncApplyResult(fields) {
    return frame(PlayShareSignalingClientType.DIAG_SYNC_APPLY_RESULT, fields);
  }
  function bgDiagSyncReport(body) {
    return frame(PlayShareSignalingClientType.DIAG_SYNC_REPORT, body);
  }
  function bgDiagProfilerCollection(fields) {
    return frame(PlayShareSignalingClientType.DIAG_PROFILER_COLLECTION, fields);
  }
  function bgDiagPeerRecordingSample(fields) {
    return frame(PlayShareSignalingClientType.DIAG_PEER_RECORDING_SAMPLE, fields);
  }
  function bgDiagRoomTraceRequest() {
    return frame(PlayShareSignalingClientType.DIAG_ROOM_TRACE_REQUEST);
  }
  function bgDiagUploadUnified(envelope) {
    const { payload, hashSecrets, extensionVersion, platformHandlerKey, diagnosticReportSchema, testRunId } = envelope;
    return frame(PlayShareExtensionBridgeType.DIAG_UPLOAD_UNIFIED, {
      payload,
      hashSecrets,
      extensionVersion,
      platformHandlerKey,
      diagnosticReportSchema,
      testRunId: testRunId ?? null
    });
  }

  // shared/core/extension-messages-global-entry.js
  globalThis.PlayShareExtensionMessages = extension_messages_exports;
})();
