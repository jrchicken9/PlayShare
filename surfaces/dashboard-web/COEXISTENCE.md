# PlayShare extension and web app — how they coexist

## Roles today

| Layer | Responsibility |
|--------|----------------|
| **Signaling server** (`server.js`) | WebSocket rooms, playback/chat relay, HTTP `/join`, `/health`, diagnostics routes. All clients use the same protocol (`shared/playshare/signaling-client.js`). |
| **Chrome extension** | In-page experience: finds `<video>`, syncs play/pause/seek with the room, sidebar chat, site adapters under `content/src/sites/`. Still the **only** supported way to sync the actual player on Netflix, Prime, etc. |
| **Web app** (`/app`) | Hosted with the server. **Lobby**: localStorage for signaling URL + display name, **CREATE_ROOM** / **JOIN_ROOM**, member list, **CHAT** / **SYSTEM_MSG** / **REACTION** (playback frames ignored). Styled to match extension popup/sidebar. No `<video>` sync — extension owns player control on streaming sites. |

## Shared product surface

- **`shared/playshare/product.js`** — Invite query names (`playshare`, `ps_srv`) and defaults; keep in sync with marketing and extension manifest flows.
- **`shared/playshare/join-link-helpers.js`** — HTTP/WS helpers for invites; safe to import from web, extension (bundled), or Node tooling.
- **`shared/playshare/signaling-client.js`** — Server `type` strings for client→server messages.
- **`shared/playshare/extension-messages.js`** — Extension ↔ service worker only; not used by the web shell.

## Intended division of labor (near term)

1. **Extension** — Continues to own content scripts, streaming site quirks, and optional connection to the same room server the web app talks to.
2. **Web app** — Lobby + chat for the same rooms; use alongside guests on the extension (same room code and server). Optional next: deep links (`?code=`), typing indicators, reaction bar, or auth.

## Query parameters

- **`/app?code=ABCD12`** or **`/app?playshare=ABCD12`** pre-fills the join field.

## Next step

- **Parity**: optional **TYPING_START/STOP** and quick **REACTION** buttons (same payloads as sidebar).
- **Accounts**: only when product needs cross-device history — keep guest rooms working without login.
