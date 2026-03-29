/**
 * Product-facing constants shared across PlayShare clients (extension, future web/desktop).
 * Invite links and query params must stay stable for backward compatibility.
 */

/** Logical product id / brand key (not the Chrome extension name). */
export const PLAYS_SHARE_PRODUCT_KEY = 'playshare';

/** `?playshare=ROOMCODE` on a watch URL — deep link into a session. */
export const PLAYS_SHARE_INVITE_QUERY_ROOM = 'playshare';

/** `?ps_srv=HOST` — encoded signaling host (see join-link-helpers). */
export const PLAYS_SHARE_INVITE_QUERY_SERVER = 'ps_srv';

/** Default local signaling port (matches `server.js` when PORT is unset). */
export const PLAYS_SHARE_DEFAULT_LOCAL_SIGNAL_PORT = 8765;

/**
 * Default public signaling WebSocket (Railway production).
 * Same hostname as the marketing site — use `wss://`, not `https://`, and do not use a `ws.` subdomain prefix.
 */
export const PLAYS_SHARE_DEFAULT_PUBLIC_WSS = 'wss://playshare-production.up.railway.app';
