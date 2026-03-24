## PlayShare extension — architecture primer (narrative)

_Hand-maintained. Update when behavior or architecture changes meaningfully. The **preceding** section (if present) is regenerated on each `npm run generate:primer` / version bump / package._

### What it is
**PlayShare** is a **Manifest V3 Chrome extension** that lets a small group **watch the same streaming title in sync** (playback time aligned) and use **chat**, while each person uses **their own subscription**. It is **not** affiliated with Netflix, Prime, Disney, etc.

### High-level runtime
1. **Content script** (`content/content.bundle.js`, built from `content/src/entry.js` → `app.js`) runs on **supported streaming origins** (see `manifest.json` `content_scripts.matches`). It only does heavy work when the page is treated as a **video watch experience** (`video-page.js` / `isVideoPage()`).
2. **Background service worker** (`background.js`) holds the **WebSocket** to the PlayShare **signaling server**, tracks **room membership**, and **routes messages** between popup, content scripts, and the server (`chrome.runtime.sendMessage` / `tabs.sendMessage`).
3. **Popup** (`popup/`) — join/create room, transport status, settings that touch storage.
4. **Sidebar / join** — `sidebar/`, `join/` as web-accessible UI where needed for embedded flows.
5. **Signaling server** (`server.js` + `ws`) — **rooms**, **playback state**, chat relay; **no video streams** (only sync metadata).
6. **Supabase** — extension auth / identity patterns in popup; **diagnostic uploads** and **intel** use the **service role** on the server (Railway), not the extension client.

### Content script — sync pipeline (simplified)
- **Site adapter** (`content/src/sites/site-sync-adapter.js`) picks **Netflix** (`netflix-sync.js`), **Prime Video** (`prime-video-sync.js`), or **default** hooks (video scoring, ignore windows after remote apply, confidence hints).
- **Sync decision engine** (`sync-decision-engine.js`) — when to apply remote seeks/pause/play, cooldowns, “converging” behavior, **reject** paths (logged as metrics).
- **Drift / thresholds** (`sync-drift-config.js`, enrichment from server snapshot) — how far off before hard/soft correction.
- **Ad detection** (`ad-detection.js`) + **Netflix ad state** (`netflix-ad-state-machine.js`) — ad segments can change timing; **divergence** vs peers shows up in diagnostics as tags like `likely_ad_divergence`.
- **Video player profiler** (`diagnostics/video-player-profiler.js`) — records buffering, timeupdate gaps, src swaps, etc., gated for **developer/diagnostic** builds.
- **Platform profiles** (`platform-profiles.js`) — host → handler key mapping aligned with `shared/streaming-hosts.generated.js` (generated list of supported hosts).

### Background — transport & diagnostics
- Maintains **WebSocket** lifecycle, **reconnect**, **RTT**, **auto-rejoin** after drop.
- **Diagnostic upload** path: anonymized payloads POST to server `/diag/upload` (HTTP origin derived from WS URL). Content aggregates metrics; **PII is stripped** server-side where enforced.
- **Development-only** affordances (e.g. default upload bearer) are gated with `chrome.management.getSelf().installType === 'development'`.

### Server (`server.js`)
- **WebSocket**: rooms, members, playback updates, chat.
- **HTTP**: health, **diagnostic ingest** (`server/diag-upload.js`), **diagnostic intelligence** APIs (`server/diag-intel-http.js`) — cases, clusters, search, regression, **AI brief** (`server/diag-ai-brief.js`), **knowledge** table for cumulative briefs (`server/diag-intel-knowledge.js`).
- **Intel pipeline** (`server/diag-intelligence.js`) — normalized metrics, **cluster signatures**, **explainCase**, **recommendations**, **regressionCompare** (no raw page HTML in DB).

### Key paths (when suggesting code changes)
| Area | Path |
|------|------|
| Main content orchestration | `content/src/app.js` |
| Entry | `content/src/entry.js` |
| Site-specific sync | `content/src/sites/*.js` |
| Sync policy | `content/src/sync-decision-engine.js`, `sync-drift-config.js` |
| Ads | `content/src/ad-detection.js`, `netflix-ad-state-machine.js` |
| Profiler / diag helpers | `content/src/diagnostics/` |
| Constants / feature flags | `content/src/constants.js` |
| Background WS + routing | `background.js` |
| Popup UI | `popup/popup.js`, `popup/popup.html` |
| Signaling + diag HTTP | `server.js`, `server/diag-*.js` |

### Diagnostics & “recordings”
- Engineers run **recording** sessions (profiler + sync metrics); uploads create rows in **Supabase** (`diag_cases`, `diag_case_clusters`, etc.). The **AI assistant** and **explorer** read **aggregates only** (summaries, tags, normalized numbers).
- **Knowledge table** (`diag_intel_knowledge`) stores **past AI/manual briefs** so each new analysis can **build on previous conclusions**.

### Build
- Content bundle: `npm run build:content` / `build:content:dev` (esbuild `content/src/entry.js` → `content/content.bundle.js`).
- Host list: `npm run sync-streaming` updates `shared/streaming-hosts.generated.js`.

### Operating constraints
- Respect **streaming sites’ ToS**; extension manipulates only the **user’s browser** and **user-initiated** sync.
- Prefer **small, targeted** changes; preserve **adapter boundaries** so new sites do not break Netflix/Prime paths.
