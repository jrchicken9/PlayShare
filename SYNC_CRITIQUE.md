# Sync Logic: Critical Analysis — Timing Accuracy & Drift Correction

## Executive Summary

**Verdict: The sync logic has fundamental timing and drift-correction flaws that make sub-second accuracy impossible.** The design favors "eventually consistent" over "precise," with thresholds and intervals that guarantee visible drift. Below is an uncompromising critique.

---

## 1. Latency Compensation: Incomplete & Incorrect

### What Exists
```javascript
// applyPlay only
const targetTime = (sentAt && typeof sentAt === 'number')
  ? currentTime + (recvAt - sentAt) / 1000
  : currentTime;
```

### Critical Flaws

**A. Only PLAY is compensated.** PAUSE and SEEK use raw `currentTime` with no `sentAt`. By the time a PAUSE arrives (e.g. 150ms later), the sender's video has advanced 150ms. The recipient seeks to `currentTime` but the sender is now at `currentTime + 0.15`. **You're already 150ms behind on pause.**

**B. Wrong clock assumption.** `recvAt - sentAt` assumes sender and receiver share the same clock. They don't. Client clocks can drift minutes. **You're compensating for network latency but using the wrong clock.** The correct approach: measure round-trip (ping) or use server timestamp as authority.

**C. Double-counting risk.** When the sender presses play, `sentAt` is set. The sender's video is at `currentTime`. During the sender→server→receiver path, the sender's video keeps playing. So `currentTime + (recvAt - sentAt)/1000` is correct *for the sender's clock*. But `recvAt` and `sentAt` are both from the sender's perspective when the message is created... No — `sentAt` is set on the sender's machine. `recvAt` is set on the receiver's machine. So we're mixing clocks: `recvAt - sentAt` is the time from sender's "I sent" to receiver's "I got it." That's approximately one-way latency + processing. The sender's video advanced by that much. So we add it to the sender's `currentTime`. Good. But wait — the sender and receiver are different machines. The sender's `currentTime` is the video's position when the message was created. The receiver's `recvAt` is when they got it. So we're saying: sender was at `currentTime` at `sentAt`. By `recvAt` (receiver time), the sender's video would have advanced by `recvAt - sentAt` **if sender and receiver clocks are the same**. They're not. So we're wrong. The correct formula: `senderCurrentTime + oneWayLatency` where oneWayLatency is estimated (e.g. RTT/2). We don't have RTT. We're using `recvAt - sentAt` as a proxy. That's actually the time from sender's perspective... no. `sentAt` is set on the sender. `recvAt` is set on the receiver. So `recvAt - sentAt` assumes both clocks are in sync. If they're off by 1 second, we add 1 second too much or too little. **Clock skew is a real problem.**

**D. No compensation for PAUSE/SEEK.** PAUSE and SEEK use raw `currentTime`. For PAUSE, the position is frozen — no compensation needed. For SEEK, same. So actually PAUSE and SEEK don't need compensation. Only PLAY does (video keeps advancing). So the critique is: (1) clock skew for PLAY, (2) PAUSE/SEEK are fine.

**E. sentAt from wrong moment.** `sentAt` is set when the content script calls `sendBg`. The message then goes: content → background → WebSocket → server → network → receiver. The `sentAt` is set before the WebSocket send. So we're not including the time from content→background→ws. Minor. But the server forwards `sentAt` — it doesn't add a server timestamp. So we have no server-side timing reference.

---

## 2. Drift Correction: Too Slow, Too Late

### Host Heartbeat
- **Interval:** 5 seconds
- **Behavior:** Host sends `currentTime` every 5s. Server updates state. **Server does NOT broadcast to viewers.**

**Flaw:** Viewers never receive the host's position unless they explicitly request it. So for 5–15 seconds, viewers are drifting with no correction. The host could be 2 seconds ahead; viewers have no idea.

### Viewer Sync Request
- **Interval:** 15 seconds
- **Behavior:** Viewer sends `SYNC_REQUEST`. Server responds with `SYNC_STATE` (currentTime + elapsed if playing).

**Flaw:** 15 seconds is far too long. In 15 seconds, at 24fps, you've shown 360 frames. Two viewers can be 15 seconds apart before any correction. **The threshold is 15 seconds, not 2.**

### Combined Effect
- Host sends position at T=0, T=5, T=10...
- Viewer last synced at T=0. Viewer's next request at T=15.
- From T=0 to T=15, viewer drifts with no correction. **Max drift before correction: 15 seconds.**

---

## 3. applySyncState: Threshold Kills Accuracy

```javascript
const diff = Math.abs(v.currentTime - state.currentTime);
if (diff > threshold) v.currentTime = state.currentTime;
```

- **Threshold:** 2s (general), 5s (Netflix)
- **Meaning:** If you're within 2 seconds, **no correction is applied.**

**Flaw:** Two viewers can be 1.9 seconds apart and the system does nothing. That's 48 frames at 24fps. **"In sync" is defined as "within 2 seconds" — that's not sync.** For a watch party, 500ms is noticeable. 2 seconds is unacceptable.

**Netflix 5s:** Allows 5 seconds of drift before correcting. **That's 120 frames.** One viewer is 5 seconds ahead and we don't correct. Why?

---

## 4. SYNC_STATE Has No sentAt

```javascript
const elapsed = room.state.playing ? (Date.now() - room.state.updatedAt) / 1000 : 0;
sendTo(ws, {
  type: 'SYNC_STATE',
  state: {
    playing: room.state.playing,
    currentTime: room.state.currentTime + elapsed
  }
});
```

**Flaw:** The server computes `currentTime + elapsed` at server time. The message then travels to the client. By the time the client receives it, more time has passed. The client applies it after a `setTimeout(delay)` (Netflix: 300ms). So we have:
- Server computes at T
- Client receives at T + RTT
- Client applies at T + RTT + 300ms

The video at `currentTime + elapsed` was correct at server time T. By the time we apply, we're 300ms + RTT late. **No compensation for the time from server computation to client apply.**

**Fix:** Include `computedAt` in SYNC_STATE. Client applies: `targetTime = currentTime + (Date.now() - computedAt)/1000` when playing.

---

## 5. PLAYBACK_POSITION: Never Reaches Viewers

```javascript
case 'PLAYBACK_POSITION': {
  room.state.currentTime = t;
  room.state.updatedAt = Date.now();
  break;  // No broadcast!
}
```

**Flaw:** Host sends position. Server stores it. **Viewers are never told.** The only way viewers get it is by SYNC_REQUEST every 15 seconds. So the host's position is updated every 5 seconds, but viewers only ask every 15 seconds. **The host's position is 3x more frequent than viewer requests, but we throw away 2/3 of the updates from the viewer's perspective.**

**Fix:** Server should broadcast `SYNC_STATE` (or a lightweight `POSITION` message) to viewers when the host sends PLAYBACK_POSITION. Or at least every 5 seconds, push to all viewers.

---

## 6. Event Timing: Race Conditions

### onVideoPlay / onVideoPause
```javascript
if (Math.abs(t - lastSentTime) < 0.3) return;  // play
if (Math.abs(t - lastSentTime) < 0.5) return;  // seek
```

**Flaw:** These thresholds are arbitrary. 0.3s for play: if the user presses play, we send. If the video fires `play` again 0.2s later (e.g. buffering), we ignore. That's fine. But 0.3s for play vs 0.5s for seek — inconsistent. And `lastSentTime` is only updated when *we* send. When we *receive* a remote SEEK, we set `lastSentTime = currentTime` in applySeek. So we're good. But when we receive PLAY, we set `lastAppliedState` but not `lastSentTime`. So if the remote sends PLAY, we apply it. Our video plays. Our `video` fires `play`. We check `Math.abs(t - lastSentTime) < 0.3`. Our `lastSentTime` is from our last *sent* action. So we might have sent a SEEK 10 seconds ago. Our video is now playing at 100.5. lastSentTime might be 95. So we'd send. Good. But if we had just received a PLAY and applied it, our video plays. Our `play` event fires. Our `lastSentTime` might be from the remote's seek. Actually `lastSentTime` is only set when we send (onVideoPlay, onVideoSeeked, countdown). When we receive and apply, we don't set lastSentTime. So we could:
1. Receive PLAY, apply, our video plays
2. Our `play` event fires
3. We check lastSentTime — it's from our last send. If we haven't sent anything in a while, we'd send. **We'd echo the remote play back!** That's a bug. We have syncLock to prevent that. When we apply, we set syncLock. The syncLock is cleared after 500ms. So for 500ms we ignore. But the `play` event might fire after 500ms. So we could echo. Let me check — when we apply play, we set syncLock. The play event fires when the video actually starts playing. That might be 100ms after we call forcePlay. So we're still in syncLock. Good. But forcePlay has retries at 150, 350, 550ms. So the play might succeed at 550ms. The syncLock is cleared at 500ms. So we could have: syncLock cleared at 500ms, then at 550ms the video actually plays. The play event fires. syncLock is false. We'd send. **We'd echo.** So we need syncLock to persist longer, or we need to set lastSentTime when we apply.

Actually looking at the code — when we apply play, we set syncLock. The syncLock is cleared in a setTimeout(500ms) inside the doApply callback. The doApply runs after applyPlayWhenReady. So the flow is: we apply, set syncLock, setTimeout 500ms to clear. The video might play at 550ms. So we clear at 500ms. Then play fires at 550ms. We'd echo. **Bug.**

We should set `lastSentTime = targetTime` when we apply a remote play, so we don't echo. Let me check — we don't set lastSentTime in applyPlay. We set lastAppliedState. So when the play event fires, we check lastSentTime. lastSentTime is from our last send. If we haven't sent, it's -1 or old. So we'd send. We need to set lastSentTime when we apply.

---

## 7. syncLock: Too Short, Too Simple

**Duration:** 500ms (applyPlay, applyPause, applySeek)

**Flaw:** forcePlay has retries at 150, 350, 550ms. The video might actually start playing at 550ms. The syncLock is cleared at 500ms. So we have a 50ms window where syncLock is false but the play event hasn't fired yet. When it fires, we'd send. **Echo.**

**Fix:** Clear syncLock after 800ms or when we're confident the operation is done. Or set `lastSentTime` when we apply.

---

## 8. lastSentTime Not Updated on Apply

When we apply a remote PLAY, we should set `lastSentTime = targetTime` so that when our `play` event fires (from the applied play), we don't send again. We don't do that. **Same for PAUSE and SEEK.**

---

## 9. applySyncState: No Elapsed Compensation

When we receive SYNC_STATE, the server computed `currentTime + elapsed` at some moment. We don't have `computedAt`. So we apply it as-is. By the time we apply (after delay), we're wrong.

---

## 10. Buffering: No Handling

When the host buffers, their video pauses. The host's `play` event fires when buffering ends. We'd send PLAY. But the host's `currentTime` might have jumped (e.g. adaptive bitrate seek). We don't send SEEK. Viewers would play from their current position. **Drift.**

---

## 11. Platform Delays: Arbitrary

```javascript
const delay = isNetflix ? APPLY_DELAY_NETFLIX : isPrimeVideo ? APPLY_DELAY_PRIME : 0;
```

- Netflix: 150ms
- Prime: 80ms
- Others: 0

**Flaw:** These are magic numbers. Why 150ms for Netflix? What if the platform changes? We're adding latency for no measured reason. The delay was presumably to let the platform "settle." But we're not measuring. We're guessing.

---

## 12. Recommended Fixes (Prioritized)

| Priority | Issue | Fix | Status |
|----------|-------|-----|--------|
| 1 | lastSentTime not set on apply | Set `lastSentTime = targetTime` when applying remote PLAY/PAUSE/SEEK | ✅ Done |
| 2 | syncLock too short | Clear at 800ms or set lastSentTime on apply | ✅ Done (800ms for applyPlay) |
| 3 | Host position never broadcast | Server broadcasts SYNC_STATE to viewers when host sends PLAYBACK_POSITION | ✅ Done |
| 4 | Viewer sync 15s | Reduce to 5s | ✅ Done |
| 5 | applySyncState threshold 2s | Reduce to 0.5s for seek correction | ✅ Done |
| 6 | SYNC_STATE no computedAt | Add computedAt; client compensates with elapsed | ✅ Done |
| 7 | Netflix 5s threshold | Reduce to 2s | ✅ Done |

---

## 13. What "Good" Timing Looks Like

| Metric | Before | After |
|--------|--------|-------|
| Max drift before correction | 15s | 5s (viewer) + 5s (host push) |
| Seek correction threshold | 2–5s | 0.5–2s |
| Host→viewer position push | Never | Every 5s (on PLAYBACK_POSITION) |
| Viewer sync request | 15s | 5s |
| Echo prevention | syncLock 500ms | lastSentTime on apply + syncLock 800ms |
| SYNC_STATE latency comp | None | computedAt + elapsed |

---

## 14. Summary

The sync logic is **event-driven with periodic correction**, but the correction is too infrequent (15s), the thresholds are too loose (2–5s), and the host's position is never pushed to viewers. Latency compensation exists only for PLAY and assumes synchronized clocks. Echo prevention relies on a 500ms syncLock that can expire before the video actually plays. **For sub-second accuracy, a fundamental redesign is needed:** push-based position updates from host to viewers every 1–2 seconds, sub-500ms correction thresholds, and proper lastSentTime handling to prevent echo.

---

## 15. Additional Fixes (Remaining Issues)

| Issue | Fix |
|-------|-----|
| **Clock skew** | Use RTT/2 instead of recvAt-sentAt. Background measures RTT on HEARTBEAT_ACK; forwards `lastRtt` with playback messages. `applyPlay` prefers `lastRtt` when available. |
| **Buffering / internal seeks** | `onVideoTimeUpdate` detects time jumps > 1s; host sends SEEK to sync viewers (adaptive bitrate, buffering recovery). |
| **Platform delays** | `getApplyDelay(lastRtt)` uses `min(platformDefault, lastRtt)` for low-latency connections (Netflix 150ms, Prime 80ms). |
