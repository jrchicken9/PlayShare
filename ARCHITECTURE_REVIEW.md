# PlayShare Architecture & Code Review

## 1. Architecture Review

### Current Structure
```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Content Script │────▶│  Background SW   │────▶│  Node.js Server │
│  (content.js)   │◀────│  (background.js) │◀────│  (server.js)    │
│  ~1580 lines    │     │  ~318 lines      │     │  ~471 lines     │
└────────┬────────┘     └──────────────────┘     └─────────────────┘
         │
         │ postMessage
         ▼
┌─────────────────┐     ┌─────────────────┐
│  Sidebar iframe │     │  Popup          │
│  (sidebar.js)   │     │  (popup.js)     │
└─────────────────┘     └─────────────────┘
```

### Assessment
**Verdict: Reasonable for scope, but content script is overloaded.**

| Aspect | Rating | Notes |
|-------|--------|-------|
| Separation of concerns | 6/10 | Background correctly centralizes WS; content script does too much |
| Scalability | 5/10 | Single content script; adding platforms requires editing one file |
| Testability | 4/10 | No unit tests; tight coupling to DOM and chrome APIs |

### Unnecessary Complexity / Bad Patterns
1. **Monolithic content script** — Video detection, sync logic, sidebar, chat, diagnostics, toasts all in one ~1580-line file
2. **Duplicate platform lists** — `CONTENT_SCRIPT_URLS` in background, `STREAMING_HOSTS` in server, `PLATFORMS` in content, `streamingHosts` in popup — 4+ copies
3. **broadcastToTabs sends to ALL streaming tabs** — User with Netflix + Prime open gets messages in both; only the active/focused tab should matter for sync
4. **No message versioning** — Protocol changes could break older clients

### Suggested Cleaner Architecture
```
content/
  content.js          # Thin orchestrator (~200 lines)
  video-detector.js   # Platform-specific video finding
  sync-engine.js      # Play/pause/seek apply logic
  platform-adapters/  # netflix.js, prime.js, youtube.js
shared/
  constants.js        # Single source: platforms, URLs
  protocol.js         # Message types, validation
background/
  background.js       # WS + routing (unchanged)
  tab-router.js       # Route to active tab only
```

---

## 2. Real-Time Sync Performance

### Current Flow
1. User action → `play`/`pause`/`seeked` event → content sends to background → server broadcasts
2. Recipients receive → `applyPlay`/`applyPause`/`applySeek` → `setTimeout` delay → `forcePlay`/`forcePause`/seek

### Sources of Latency
| Source | Est. Latency | Location |
|--------|--------------|----------|
| Event → send | ~0–5ms | Native, minimal |
| WS round-trip | 20–200ms | Network |
| `setTimeout` delay | 0–300ms | `applyPlay` (Netflix: 150ms, Prime: 80ms) |
| `applyPlayWhenReady` seek wait | 0–3000ms | When video.seeking |
| `forcePlay` retries | 150, 350, 550ms | Multiple attempts |
| syncLock hold | 500ms | Prevents echo but adds delay |

**Total: 200ms–4s** depending on platform and network.

### Desync Causes
1. **No timestamp in messages** — Server/recipients don't compensate for network delay
2. **Host heartbeat every 10s** — Long gap; drift accumulates
3. **Viewer sync every 30s** — Very infrequent; viewers can drift 30s before correction
4. **Platform-specific delays** — Netflix 150ms, Prime 80ms add unnecessary latency for fast networks

### Improvements
1. **Add `sentAt` timestamp** — Recipients compute `currentTime + (now - sentAt)` if playing
2. **Reduce host heartbeat** — 3–5s when playing (with throttling to avoid spam)
3. **Reduce viewer sync** — 10–15s when playing
4. **Adaptive delays** — Use smaller delays on low-latency connections

---

## 3. Networking Layer

### Current Approach
- **Transport**: WebSockets (good choice)
- **Heartbeat**: 20s (reasonable)
- **Playback messages**: Event-driven (PLAY, PAUSE, SEEK)
- **Host position**: Every 10s when playing
- **Viewer sync request**: Every 30s when playing

### Inefficiencies
1. **broadcastToTabs** — Sends to every matching tab; should target active tab in room
2. **PLAYBACK_POSITION** — Server updates state but doesn't broadcast; viewers only get SYNC_STATE on request. Good for bandwidth, but 30s is too slow
3. **DIAG_SYNC_REPORT** — Every 10s when diagnostic open; could be on-demand only
4. **No message batching** — Rapid seek+play sends 2 messages; could batch

### Recommended Message Frequency
| Message | Current | Recommended |
|---------|---------|-------------|
| Host position (playing) | 10s | 5s |
| Viewer sync request | 30s | 15s |
| Heartbeat | 20s | 20s (keep) |
| Diagnostic report | 10s | On "Request" only |

### Message Structure Suggestion
```json
{
  "type": "PLAY",
  "currentTime": 123.45,
  "sentAt": 1710000000123,
  "fromClientId": "uuid",
  "fromUsername": "Host"
}
```

---

## 4. Drift Correction Logic

### Current Strategy
- **Threshold**: 2s (general), 5s (Netflix)
- **Debounce**: 800ms (Netflix only) between sync ops
- **applySyncState**: Uses threshold; only seeks if `diff > threshold`
- **Host heartbeat**: Updates server state; viewers request SYNC_STATE

### Issues
1. **No gradual correction** — Binary: either seek or don't; no small nudge
2. **Netflix 5s threshold** — Very loose; users can be 4.9s apart
3. **Viewer-initiated sync** — Only every 30s; host never pushes corrections to viewers
4. **applySyncState** — When joining, uses threshold; new joiner might start 2s off

### Better Drift Correction Strategy
```
Thresholds:
  - Critical: 3s — always seek
  - Warning: 1.5s — seek if playing, else defer
  - Ignore: 0.5s — no action

When playing:
  - Host sends position every 5s
  - Server broadcasts position to viewers (not just stores)
  - Viewers apply if drift > 1.5s
  - Use sentAt for time compensation

When paused:
  - Looser (3s) — avoid fighting user
```

---

## 5. Edge Case Handling

| Edge Case | Current Handling | Gap |
|-----------|------------------|-----|
| **Buffering** | None | Video may stall; others keep playing. No buffering state sync |
| **Network lag** | Reconnect after 3s | No message queue; in-flight messages lost |
| **Tab switching** | None | Inactive tab may throttle; `requestAnimationFrame`/intervals can stall |
| **Users joining mid-session** | SYNC_STATE with elapsed time | Good. But if host is seeking, state can be stale |
| **Different load times** | SYNC_REQUEST after 500ms (2000ms Netflix) | Fixed delay; no "video ready" signal |
| **Multiple tabs** | All receive messages | Wrong tab might apply; race conditions |
| **Service worker sleep** | Reconnect on storage restore | Good; roomState restored |

### Recommendations
1. **Buffering**: Sync `waiting`/`stalled` events; optionally pause all when one buffers
2. **Tab visibility**: Use `document.visibilityState`; when tab hidden, don't apply sync (or defer)
3. **Active tab routing**: Background tracks `activeTabId`; only send sync to that tab
4. **Video ready**: Content sends `VIDEO_READY` when attached; server can delay SYNC_STATE until then

---

## 6. Code Quality

### Redundant Logic
- **findVideo()** — Called repeatedly; could cache with invalidation on `MutationObserver`
- **Platform detection** — `isNetflix`, `isPrimeVideo`, `platform` — computed once but patterns repeated
- **safeVideoOp** — Wraps every call; could use a decorator or single entry point

### Bad Practices
1. **Silent catch** — `sendBg` catches and ignores; errors invisible
2. **Magic numbers** — 150, 350, 550, 80, 3000 scattered; should be named constants
3. **updateDiagnosticOverlay** — Called on every diagLog/syncDiagRecord; could debounce
4. **IIFE** — Entire content script in one IIFE; harder to test or tree-shake

### Refactor Suggestions
- Extract `SyncEngine` class with `applyPlay`, `applyPause`, `applySeek`
- Extract `PlatformAdapter` interface with `findVideo`, `forcePlay`, `forcePause`
- Use `chrome.storage.onChanged` for roomState instead of duplicating in memory

---

## 7. Performance Optimization

### Current Issues
1. **updateDiagnosticOverlay** — Runs every 2s + on every event; does DOM queries
2. **findVideo()** — Can query `document.querySelectorAll('video')`; expensive on large pages
3. **MutationObserver** — Observes full document for video; could be scoped
4. **forcePlay/forcePause** — 3x setTimeout(150,350,550); 9 timers per apply
5. **broadcastToTabs** — `chrome.tabs.query` on every message

### Optimizations
1. **Debounce diagnostic update** — 500ms; only when visible
2. **Cache video element** — Invalidate on `seeked` (Prime replaces) or MutationObserver
3. **Batch sync messages** — If SEEK + PLAY within 100ms, send combined
4. **Targeted tab routing** — Store `roomTabId`; send only there
5. **Lazy diagnostic** — Don't create overlay until opened

---

## 8. Security & Platform Constraints

### Manifest V3
- ✅ Service worker (no persistent background)
- ✅ No eval
- ⚠️ `broadcastToTabs` — Consider `activeTab` permission for focused tab only

### Streaming Platform Constraints
- **Content script limitations**: No `video.play()` from non-user gesture (autoplay policy) — you use `forcePlay` with click simulation; good
- **CSP**: Some sites may block inline scripts; sidebar is same-origin iframe — OK
- **Prime Video iframes**: `all_frames: true` — necessary; increases load

### Potential Issues
1. **Cross-origin iframes** — Prime embeds from different origin; content script may not run
2. **Shadow DOM** — findVideo checks shadow roots; good
3. **Dynamic player replacement** — Prime replaces `<video>` on seek; you re-find — good

---

## 9. Refactored Versions (Critical Improvements)

### A. Centralized Constants
```javascript
// shared/constants.js
export const SYNC = {
  THRESHOLD: 2.0,
  THRESHOLD_NETFLIX: 5.0,
  DEBOUNCE_MS: 800,
  HOST_HEARTBEAT_MS: 5000,  // was 10000
  VIEWER_SYNC_MS: 15000,     // was 30000
  APPLY_DELAY_NETFLIX: 150,
  APPLY_DELAY_PRIME: 80,
};
```

### B. Message with Timestamp
```javascript
// When sending
sendBg({
  source: 'playshare',
  type: 'PLAY',
  currentTime: video.currentTime,
  sentAt: Date.now(),
  fromClientId: roomState.clientId,
  fromUsername: roomState.username,
});

// When applying (in applyPlay)
const elapsed = msg.sentAt ? (Date.now() - msg.sentAt) / 1000 : 0;
const targetTime = msg.currentTime + (roomState?.state?.playing ? elapsed : 0);
```

### C. Active Tab Routing
```javascript
// background.js - track active streaming tab
let roomTabId = null;

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (tab?.url && CONTENT_SCRIPT_URLS.some(p => tab.url.includes(p))) {
      roomTabId = tabId;
    }
  });
});

function broadcastToTabs(msg) {
  if (roomTabId) {
    chrome.tabs.sendMessage(roomTabId, { source: 'playshare-bg', ...msg }).catch(() => {});
  } else {
    // Fallback: all tabs
    chrome.tabs.query({ url: CONTENT_SCRIPT_URLS }, (tabs) => { ... });
  }
}
```

### D. Debounced Diagnostic Update
```javascript
let diagUpdateScheduled = false;
function scheduleDiagUpdate() {
  if (diagUpdateScheduled || !diagVisible) return;
  diagUpdateScheduled = true;
  requestAnimationFrame(() => {
    setTimeout(() => {
      updateDiagnosticOverlay();
      diagUpdateScheduled = false;
    }, 100);
  });
}
```

### E. Cached Video with Invalidation
```javascript
let cachedVideo = null;
let cachedVideoFrame = null;

function findVideo() {
  const frame = window !== window.top ? window : document;
  if (cachedVideo && cachedVideoFrame === frame) {
    if (document.body.contains(cachedVideo) && cachedVideo.readyState >= 1) {
      return cachedVideo;
    }
    cachedVideo = null;
  }
  const v = /* ... find logic ... */;
  if (v) {
    cachedVideo = v;
    cachedVideoFrame = frame;
  }
  return v;
}
```

---

## 10. Final Verdict

### Rating: **6.5/10**

**Strengths**
- WebSocket architecture is sound
- Platform-specific handling (Netflix, Prime) shows real-world awareness
- Teleparty-style join flow is user-friendly
- Diagnostic tool is valuable for debugging
- applyPlayWhenReady (seeked wait) fixes a real bug

**Weaknesses**
- Content script too large; hard to maintain
- Sync intervals too conservative (10s/30s)
- No timestamp compensation for network latency
- Broadcasts to all tabs; no active-tab targeting
- Edge cases (buffering, tab visibility) unhandled

### Top 5 Highest-Impact Changes

1. **Add `sentAt` and compensate for latency** — When applying PLAY, use `currentTime + elapsed` if video was playing. Reduces drift from network delay.

2. **Reduce host heartbeat to 5s, viewer sync to 15s** — Cuts max drift from 30s to 15s with minimal bandwidth increase.

3. **Route sync messages to active tab only** — Prevents wrong-tab application and duplicate handling.

4. **Extract sync engine and platform adapters** — Splits 1584-line content.js into testable modules; enables per-platform tuning.

5. **Handle tab visibility** — When tab is hidden, defer or skip sync application; avoid fighting throttled timers and reduce CPU.
