# Chrome Web Store — PlayShare

Use this when filling the developer dashboard (privacy, permissions justification, listing text).

## Final steps before you click “Publish”

1. **Pay the one-time developer fee** ($5) at [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) if you have not already.
2. **Privacy policy URL** — Source of truth: `docs/PRIVACY_POLICY.md`. The **hosted** page is **`public/privacy.html`**, served at **`GET /privacy`** on your signaling server. After Railway deploy, use **`https://<your-railway-host>/privacy`** (e.g. `https://playshare-production.up.railway.app/privacy`) in the Chrome Web Store listing and **Privacy practices**. When you change the policy, edit **`public/privacy.html`** (or regenerate from the markdown) and redeploy.
3. **Build the upload package** from the repo root:
   ```bash
   npm run package:extension
   ```
   This runs `sync-streaming` + `build:content`, then writes **`playshare-extension.zip`** in the project root (gitignored). **Upload that zip** to the store (not the whole monorepo).
4. **Smoke-test the same zip** — Unzip to a folder → Chrome → `chrome://extensions` → **Load unpacked** → create/join a room on one streaming site and confirm sync + chat.
5. **Dashboard fields** — Complete **Privacy practices** (data types, handling, certification). Answer consistently with this doc and `PRIVACY_POLICY.md`.
6. **Listing assets** — At least **1 screenshot** (often 1280×800 or 640×400). Short description ≤132 characters. Optional: promo tile, marquee.
7. **Version** — **Source of truth:** `"version"` in `manifest.json` (Chrome requires semver `X.Y.Z`). The popup footer reads it at runtime via `chrome.runtime.getManifest().version`, so you do **not** edit the footer text by hand. To bump before a release:
   ```bash
   node scripts/bump-extension-version.mjs patch   # 1.0.7 → 1.0.8
   # or: minor | major
   node scripts/bump-extension-version.mjs         # print current version only
   ```
   Then rebuild the zip (`npm run package:extension`) and upload.
8. **Homepage install (Web Store + .zip)** — The marketing site shows **two** choices: **Chrome Web Store** (live link when `PLAYSHARE_CHROME_STORE_URL` is set, otherwise a **Coming soon** state) and **Direct download** when **`public/install/playshare-extension.zip`** exists (`GET /install/playshare-extension.zip`). The shown **download version** comes from **`public/install/playshare-extension.version`**, which `npm run package:extension` writes from `manifest.json` whenever you build the store zip—so it tracks the packaged build, not a separate hand-edited string. If the sidecar is missing but the zip exists, the server falls back to the repo’s `manifest.json` (useful in dev). The **Dockerfile** runs `package:extension`, then copies both the zip and `.version` into the runtime image. After the listing is live, set `PLAYSHARE_CHROME_STORE_URL`; you can keep shipping the .zip for operators who sideload.

## Single purpose

Synchronize video playback and provide a chat sidebar for people watching the same supported streaming site together.

## Permission justification (copy/adapt)

- **storage** — Save room state, display name, optional custom signaling server URL, and auth session (Supabase) between sessions.
- **tabs** — Find streaming tabs that have the content script so playback and chat messages can be routed to the correct watch page; read the active tab URL when building invite links.
- **Host permissions (required)** — Connect to the PlayShare signaling WebSocket (`playshare-production.up.railway.app`), optional local development (`localhost` / `127.0.0.1`), and Supabase HTTPS endpoints for optional sign-in.
- **Host permissions (optional)** — Only requested when an invite link or stored settings point at a **custom** self-hosted signaling server; the user sees a standard Chrome permission prompt for that host.

## Data & privacy (summary)

- **Signaling server** — Room codes, chat, playback commands, and display names pass through the WebSocket server to sync the session.
- **Optional accounts** — Email/password sign-in uses Supabase; session data is stored in `chrome.storage.local`.
- **Streaming sites** — The extension does not read streaming passwords or payment data; it interacts with the page `<video>` element and URL for sync.

Full legal text template: **`docs/PRIVACY_POLICY.md`**.

## Listing tips

- Avoid implying endorsement by streaming brands; the in-extension description is already phrased generically.
- Screenshots should show the UI overlay and disclose that each user needs their own subscription.
- If reviewers ask about **optional** broad patterns (`http(s)://*/*`, `ws(s)://*/*`), explain they are **optional** and only applied when the user accepts the prompt for a custom server host.

## Custom server + `?playshare=` / `ps_srv` on the watch page

The content script can save a custom `serverUrl` from the page URL but cannot run `chrome.permissions.request`. If the host is not covered by the **required** manifest hosts, ask users to **open the PlayShare popup once** (or use an invite `join` link with `?server=`, which requests permission on that page).

## Maintainer checklist (source changes)

1. `npm run sync-streaming` after editing `shared/streaming-hosts.json`.
2. `npm run build:content` after editing `content/src/` (or rely on `npm run package:extension`, which runs both).
3. `npm run postinstall` (or ensure `lib/supabase.min.js` exists) before packaging on a fresh clone.

## What is **not** in the store zip

The package script **excludes** `node_modules/`, `server.js`, `content/src/`, `docs/`, `scripts/`, tests, Docker files, and `shared/streaming-hosts.json` (source for sync only). The running extension only needs the paths referenced in `manifest.json`.
