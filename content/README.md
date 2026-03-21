# PlayShare content scripts

## Source layout (`content/src/`)

| File | Responsibility |
|------|----------------|
| **`entry.js`** | Loads first in the bundle; calls `runPlayShareContent()`. |
| **`app.js`** | Main logic: video, sync, sidebar bridge, diagnostics, storage. |
| **`constants.js`** | Sync thresholds, sidebar widths, `PLATFORMS`, `detectPlatform()`. |
| **`video-page.js`** | `isVideoPage()`, URL join (`playshare` / `ps_srv` query). |
| **`format-time.js`** | `formatTime()` for UI. |
| **`diagnostics/helpers.js`** | Diagnostic export JSON (`buildDiagnosticExport`), timeline + drift EWM helpers. |

## Build

The extension loads **`content/content.bundle.js`** (see `manifest.json`). That file is **generated**:

```bash
npm install          # installs devDependency esbuild
npm run build:content
```

After editing anything under **`content/src/`**, run **`npm run build:content`** and reload the extension in Chrome.

`npm run sync-streaming` updates host patterns in `manifest.json` and regenerates `shared/streaming-hosts.generated.js` (still loaded **before** the bundle).

## Adding modules

1. Create `content/src/my-module.js` with `export` / `import`.
2. Import it from `app.js` (or another module).
3. Run `npm run build:content`.

To split a large area out of **`app.js`**: move functions into e.g. `sync-apply.js` and pass shared state via a small `state.js` module or explicit parameters.

### Video cache & seeks

After `seeked`, the **`findVideo` cache is only invalidated** if the current `<video>` is gone, disconnected, or no longer matches the cached node. That avoids full DOM rescans on every scrub when the same element survives (common on Prime).

### Host “phantom seek” after play (Prime / MSE)

The host can **auto-send SEEK** when `timeupdate` sees a **>1s jump** in `currentTime` (abr / keyframe alignment after **resume** looks like a scrub). After **`play`**, a short suppress window skips that detector on Prime (~4.2s) and other sites (~1.6s) so chat does not show a fake “seeked to …” right after you only pressed play.

### Local `play` vs `pause` counts (Prime / SYNC_STATE)

Frequent **`SYNC_STATE`** updates set **`lastSentTime`** to the current media time. The content script used to drop **`play`** events when the time matched within 0.3s (echo suppression), which could hide **real resumes** after a pause (many **`pause_sent`**, few **`play_sent`**). **`lastPlaybackOutboundKind`** fixes that: after a **`PAUSE`** or **`SEEK`**, the next **`play`** is allowed even at the same timestamp.

### Diagnostics

The **developer** overlay (**Ctrl+Shift+D**, floating ⚙ — not for production users) includes collapsible sections, a **wider layout** toggle, **drag** (⠿ handle), system UI typography, timing/drift, video health, `findVideo` stats, server `DIAG_ROOM_TRACE`, redacted export, event filter, soak test, and theme/minimize. Play messages carry **`correlationId`** + **`serverTime`** from the server.

Sidebar **`postMessage` queue**: messages to the chat iframe (including **`SYSTEM_MSG`** / play–pause–seek lines) are buffered until the iframe sends **`READY`**, so action lines are not lost during the load race after **`injectSidebar()`**.

#### Room cluster playhead (`POSITION_REPORT` / `POSITION_SNAPSHOT`)

All peers in a room periodically send **`POSITION_REPORT`** (`currentTime`, `playing`) as **telemetry only**; canonical playback state stays **host-driven** (**`PLAYBACK_POSITION`**, **`PLAY`/`PAUSE`/`SEEK`**). The server merges last reports and **rate-limited** broadcasts **`POSITION_SNAPSHOT`** so each client can compute **spread** (extrapolated timelines) and show a **Sync: ✓ / ~Xs / play-pause** pill on the **page**, plus a **connection state** pill in the **sidebar header** (text matches colour: **Connected** / **Syncing..** / **Warning** / **Mismatch** / **No room** / **Reconnecting**; hover for full detail). When **not** Connected, the pill is **clickable** and opens a short detail flyout plus **Open Sync Status (Members)**. **Members → Sync Status** still shows the text line.

Tunables: **`constants.js`** (`POSITION_REPORT_INTERVAL_MS`, `CLUSTER_SYNC_SPREAD_SEC`); server env **`PLAYSHARE_POSITION_SNAPSHOT_MS`**, **`PLAYSHARE_POSITION_STALE_MS`**.

#### Reports for analysis (`reportSchemaVersion` **2.4**)

Exports include:

- **`clusterSync`** — last evaluated room cluster line from **`POSITION_SNAPSHOT`** (spread, synced flag, play/pause mismatch, stale counts).
- **`capture`** — how the snapshot was taken: pre-export **GET_DIAG** (RTT), **server trace** request (~0.5s delay), tab visibility/focus, **lastRttSource** (`playback` vs `background_heartbeat`), **pendingSyncStateQueued** (joiner waiting for `<video>`).
- **`extensionOps`** (content script, this tab) — **SYNC_STATE** + remote **PLAY/PAUSE/SEEK** **denied** reasons (**sync lock** vs **Netflix debounce**), **deferred** applies when **tab hidden**, **local** **host-only** blocks; keepalive, chat, errors, etc.
- **`messaging`** — `chrome.runtime.sendMessage` **lastError** and **throw** counts (tab → service worker).
- **`videoBuffering`** — `<video>` **`waiting`** / **`stalled`** counts (rebuffer vs sync).
- **`analytics.correlationTraceDelivery`** — match **serverRoomTrace** ↔ timeline **`_recv`** by **correlationId** (client recv time − server trace time); **clockSkewSuspected** when many negative deltas.
- **`serviceWorkerTransport`** — from **GET_DIAG**: WebSocket **open/close**, **`wsSendFailures`** when socket not OPEN, **serverHost**; also under **`analytics.extensionBridge`**.
- **`room.policies`** — **hostOnlyControl** (popup when creating room); **countdownOnPlay** is controlled by the **host** in the **sidebar** (“Play countdown” switch), persisted as **`playshareCountdownOnPlay`** in `chrome.storage.local` and synced into **`roomState`** via **`UPDATE_COUNTDOWN_ON_PLAY`**.
- **`dataCompleteness`** — stored vs included row counts (events, remote applies, timeline, trace) so analysts know if slices were truncated.
- **`sessionChronology`** — recent **member join/leave** and **room attach/restore**; **recent automated test runs** (duration, soak, member count at run).
- **`analytics`** — apply success rates, peer latency, drift, flags, hints; **extensionBridge** mirrors the bridge counters + SW transport.
- **`narrativeSummary`** — includes capture + completeness + bridge + chronology for paste-friendly analysis.

Use **Copy / Download** from the overlay so the refresh runs. No full page URLs or chat bodies.

Run **`npm run build:content`** after changing `app.js` or `diagnostics/*`.

Toolbar / `chrome://extensions` icons come from **`icons/icon*.png`**, built from **`shared/brand-mark.png`** via **`scripts/build-extension-icons.mjs`**. The script removes only **neutral black matte** at the edges (flood-fill) but **keeps red back-glow, teal accent, and borders**. After knockout it **upscales** internally to **`MASTER_EXPORT_PX`** (default **4096**) for icon supersampling, then writes **`shared/brand-mark.png`** at **`UI_BRAND_MAX_PX`** (default **512**) for popup/sidebar/overlay (must match **`manifest.json` `web_accessible_resources`** as `shared/brand-mark.png`). Env: **`KNOCKOUT_MAX_RGB_DISTANCE`**, **`ICON_CONTENT_ZOOM`**, **`ENHANCE_MASTER=0`**, **`UI_BRAND_MAX_PX`**. After replacing the master asset, run **`npm run icons`** (or `python3 gen_icons.py`) and reload the extension.

**Extension manager “orange camera” corner badge:** Drawn by **Chrome**, not your PNG. **`web_accessible_resources`** matches streaming hosts only (via **`npm run sync-streaming`**), not `<all_urls>`, when possible. Reload the extension after manifest changes.

## Git

**`content.bundle.js` is committed** so “Load unpacked” works without Node. CI or release workflows should run `npm run build:content` and fail if the bundle is out of date (optional `git diff --exit-code` check).
