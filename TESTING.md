# PlayShare — Same-Network Testing

Quick guide for testing between two computers on the same Wi‑Fi (e.g. MacBook + Windows PC).

## Prerequisites

- **Both machines**: Chrome and Node.js installed
- **Same network**: Both on the same Wi‑Fi or LAN

---

## Step 1 — Start the server (choose one machine)

Open a terminal in the **streamshare** folder, then:

### Server limits (optional env)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PLAYSHARE_MAX_MESSAGE_BYTES` | `65536` | Max WebSocket frame size |
| `PLAYSHARE_RATE_WINDOW_MS` | `10000` | Rate-limit sliding window |
| `PLAYSHARE_RATE_MAX_MESSAGES` | `400` | Max messages per window per connection |

### On Mac / Linux
```bash
npm install
node server.js
```
Or: `./start.sh`

### On Windows
```cmd
npm install
node server.js
```
Or double-click `start.bat`

**If Windows Firewall prompts:** Allow Node.js for private networks so the other computer can connect.

---

## Step 2 — Load the extension on both machines

1. Copy the same `streamshare` folder to both computers (or use the same folder on a shared drive).
2. On each machine: Chrome → Extensions → Developer mode → Load unpacked → select the `streamshare` folder.
3. Use the same extension on both — no file edits needed.

---

## Step 3 — Host creates a room

1. On the **host machine** (the one running the server): Open Chrome, go to Netflix/YouTube/Prime Video, etc.
2. Click the PlayShare icon → Create room.
3. Click **Copy join link** — this copies an `http://` URL (e.g. `http://192.168.1.105:8765/join?code=ABC123`).

---

## Step 4 — Viewer joins (Teleparty-style)

**One-click join (when link includes video)**

1. Viewer clicks the link.
2. They're redirected to the video (Netflix, YouTube, etc.) and **automatically join the room**.
3. The chat sidebar opens. No manual steps.

**Manual join (when link has no video)**

1. Join page opens. Click **Copy invite**.
2. Open the PlayShare extension, click **Paste invite**, then **Join room**.
3. Open a streaming site to watch.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| **Offline** when joining | Host: allow port 8765 in firewall. Mac: System Settings → Firewall. Windows: Windows Defender Firewall → Allow an app. |
| **Room not found** | Server must be running. Check the host terminal for `✅ PlayShare server running`. |
| **Wrong machine hosting** | Either machine can host. Just run `node server.js` on the one you want, then create the room from that machine. |

---

## Switching roles

- **MacBook hosts, PC joins**: Run server on MacBook, create room on MacBook, share link to PC.
- **PC hosts, MacBook joins**: Run server on PC, create room on PC, share link to MacBook.

The extension uses the same code on both — no configuration needed.
