/**
 * Default signaling server for every Chrome install that loads this extension build.
 *
 * Set PLAYSHARE_SERVER_HOST to your MacBook’s LAN IPv4 (System Settings → Network, or the
 * “Phones & other PCs on your LAN” line printed when you run `npm start` on the Mac).
 * All household machines can use the same default; override in the popup if your IP changes.
 *
 * Tip: Chrome on the MacBook can use this ws://<same-LAN-IP>:8765 URL too (it reaches itself).
 */
var PLAYSHARE_SERVER_HOST = '10.0.0.92';
var PLAYSHARE_SERVER_URL = 'ws://' + PLAYSHARE_SERVER_HOST + ':8765';
