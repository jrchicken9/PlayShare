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
