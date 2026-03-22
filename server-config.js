/**
 * Default WebSocket URL for every Chrome install that loads this extension build.
 *
 * Production signaling server on Railway (always on). Use wss:// on the public hostname;
 * do not append :8765 — Railway maps HTTPS/WSS on port 443 to the app’s internal PORT.
 *
 * For local-only dev, change this to ws://127.0.0.1:8765 or your LAN IP, or override in the popup.
 */
var PLAYSHARE_SERVER_URL = 'wss://playshare-production.up.railway.app';
