# PlayShare Scalability Analysis: Thousands of Concurrent Rooms

## Current Architecture (Single-Process)

```
                    ┌─────────────────────────────────────┐
                    │         Node.js Server              │
                    │  ┌─────────────┐  ┌──────────────┐  │
  Clients ──WS──────▶│  │ rooms Map  │  │ clients Map  │  │
                    │  │ (in-memory)│  │ (in-memory)  │  │
                    │  └─────────────┘  └──────────────┘  │
                    └─────────────────────────────────────┘
```

**Assumptions for "thousands of rooms":**
- 5,000 rooms
- 4 users per room average = 20,000 concurrent WebSocket connections
- 50,000 connections (10 users/room) for stress case

---

## What Breaks First (Priority Order)

### 1. **File Descriptor Limit** (Breaks ~1k–10k connections)

**Problem:** Each WebSocket = 1 TCP socket = 1 file descriptor. Default `ulimit -n` is often 256–1024. At 20k connections you hit the cap.

**Symptom:** `EMFILE` or `Error: accept EMFILE` when accepting new connections.

**Fix:**
```bash
# Before starting server
ulimit -n 65535
# Or in start.sh:
ulimit -n 65535 2>/dev/null || true
node server.js
```

```javascript
// server.js - add connection limit guard
const MAX_CONNECTIONS = 50000;
wss.on('connection', (ws, req) => {
  if (wss.clients.size >= MAX_CONNECTIONS) {
    ws.close(1013, 'Server at capacity');
    return;
  }
  // ...
});
```

---

### 2. **Memory** (Breaks ~10k–50k connections)

**Problem:** In-memory `rooms` and `clients` Maps. Rough estimates:
- 20k clients × ~2KB each (ws ref + metadata) ≈ 40MB
- 5k rooms × ~1KB each ≈ 5MB
- WebSocket buffers: 20k × ~64KB = ~1.3GB (OS-level)
- **Total: ~1.5–2GB** for 20k connections

**Symptom:** OOM kills, slow GC, high RSS.

**Fix (short-term):**
- Cap room size (e.g. max 20 members)
- Cap rooms per server (e.g. 10k)
- Add memory monitoring and graceful degradation

**Fix (long-term):** Move room state to Redis (see below).

---

### 3. **generateRoomCode() Collision + O(n) Lookup** (Breaks at scale)

**Problem:**
```javascript
return rooms.has(code) ? generateRoomCode() : code;  // Recursive retry
```
With 5k rooms, collision probability ≈ 5k/2^31 ≈ 0.002. Rare but possible. Worse: `rooms.has()` is O(1), but under load you're blocking the event loop with retries.

**Fix:**
```javascript
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 100; i++) {
    let code = '';
    for (let j = 0; j < 6; j++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error('Could not generate unique room code');
}
```

---

### 4. **JSON.stringify Per Recipient** (CPU waste)

**Problem:**
```javascript
function broadcast(roomCode, message, excludeWs = null) {
  const data = JSON.stringify(message);  // Once - good!
  for (const [, member] of room.members) {
    member.ws.send(data);  // Same string - good!
  }
}
```
Actually this is already correct — stringify once. But `broadcastAll` calls `broadcast` which stringifies. For SYSTEM_MSG we call `broadcast` and `broadcastAll` separately — duplicate work for PLAY/PAUSE/SEEK (broadcast to room + broadcastAll for system msg). Minor.

---

### 5. **Single Point of Failure** (Operational)

**Problem:** One process. Crash = all rooms gone. No persistence.

**Fix:** Process manager (PM2), health checks, reconnection on client. For true HA: multi-instance + Redis.

---

### 6. **No Horizontal Scaling** (Architectural)

**Problem:** State is in-memory. A second server instance would have empty `rooms`. Can't distribute load.

**Fix:** External state store (Redis) + sticky routing or Redis Pub/Sub for cross-instance messaging.

---

## Recommended Fixes (Implementation Order)

### Phase 1: Quick Wins (No Architecture Change)

| Fix | Effort | Impact |
|-----|--------|--------|
| Add `ulimit -n` to start script | 5 min | Prevents EMFILE |
| Add connection limit (reject when full) | 10 min | Graceful degradation |
| Fix generateRoomCode retry logic | 5 min | Avoid rare blocks |
| Add max room size (e.g. 20) | 15 min | Prevents mega-rooms |
| Add room count limit per server | 10 min | Bounded memory |

### Phase 2: Observability

| Fix | Effort | Impact |
|-----|--------|--------|
| Prometheus metrics (connections, rooms, msg/sec) | 2 hr | Know when you're hitting limits |
| Structured logging (JSON) | 1 hr | Debugging at scale |
| Health endpoint `/health` | 30 min | Load balancer checks |

### Phase 3: Horizontal Scaling (Redis-Based)

```
                    ┌─────────────┐
                    │    Redis    │
                    │  - rooms    │
  Clients ──WS──────▶│  - pub/sub │◀──────┐
                    └─────────────┘       │
                           ▲              │
                    ┌──────┴──────┐  ┌─────┴─────┐
                    │  Server 1  │  │  Server 2 │  ...
                    └─────────────┘  └───────────┘
```

**Changes:**
1. **Room state in Redis** — `HSET room:ABC123 host state updatedAt`
2. **Member list in Redis** — `SADD room:ABC123:members clientId`
3. **Pub/Sub for broadcast** — Server subscribes to `room:ABC123`. On PLAY, `PUBLISH room:ABC123 <msg>`. All servers subscribed get it and forward to their local connections.
4. **Sticky sessions or room routing** — Clients in same room should hit same server (or use Redis Pub/Sub so any server can forward).

**Simpler alternative:** Use Redis Pub/Sub only for cross-server broadcast. Keep in-memory state per server. Route clients to a server by `roomCode` hash (consistent hashing). All members of a room land on same server. Scale by adding servers; each owns a subset of rooms.

---

## Concrete Code Changes (Phase 1)

### 1. start.sh — Increase file descriptor limit

```sh
#!/bin/bash
ulimit -n 65535 2>/dev/null || true
exec node server.js
```

### 2. server.js — Connection and room limits

```javascript
const MAX_CONNECTIONS = 50000;
const MAX_ROOMS = 10000;
const MAX_MEMBERS_PER_ROOM = 20;

wss.on('connection', (ws, req) => {
  if (wss.clients.size >= MAX_CONNECTIONS) {
    ws.close(1013, 'Server at capacity');
    return;
  }
  // ... existing logic
});

// In CREATE_ROOM:
if (rooms.size >= MAX_ROOMS) {
  sendTo(ws, { type: 'ERROR', code: 'SERVER_FULL', message: 'Too many rooms' });
  return;
}

// In JOIN_ROOM:
const room = rooms.get(roomCode);
if (room.members.size >= MAX_MEMBERS_PER_ROOM) {
  sendTo(ws, { type: 'ERROR', code: 'ROOM_FULL', message: 'Room is full' });
  return;
}
```

### 3. generateRoomCode — Non-recursive

```javascript
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error('Room code exhaustion');
}
```

---

## Summary: What Breaks First

| Order | Bottleneck | Approx. Breaking Point | Fix |
|-------|------------|------------------------|-----|
| 1 | File descriptors | 1k–10k connections | `ulimit -n 65535` |
| 2 | Memory | 10k–50k connections | Redis, caps, horizontal scaling |
| 3 | Single process | Any crash | PM2, multi-instance + Redis |
| 4 | Room code collisions | Rare at 5k rooms | Non-recursive generateRoomCode |
| 5 | No observability | Debugging at scale | Metrics, health, structured logs |

**Fastest path to "thousands of rooms":** Implement Phase 1 (limits + ulimit + generateRoomCode). That should get you to ~5k–10k rooms on a single 4GB+ machine. Beyond that, Phase 3 (Redis + horizontal scaling) is required.
