# PlayShare — Watch Together Chrome Extension

**PlayShare** is a Google Chrome extension that lets 2 or more people watch Netflix, Disney+, Prime Video, Crave, and other streaming services in perfect sync — with a built-in real-time chat panel.

> **Important:** Every participant must have their own valid subscription to the streaming service they are watching. PlayShare only synchronizes playback and provides a chat layer; it does not bypass any DRM or access controls.

---

## Features

| Feature | Details |
|---|---|
| **Playback Sync** | Play, pause, and seek are instantly broadcast to all room members |
| **Drift Correction** | If a member's playback drifts more than 2 seconds, it is automatically corrected |
| **Real-time Chat** | Floating sidebar with live chat, visible on top of any streaming page |
| **Emoji Reactions** | 8 quick-reaction buttons; reactions float up on screen for everyone |
| **Member List** | See who is in the room with color-coded avatars |
| **Room Codes** | 6-character alphanumeric codes — share with friends to join |
| **Host Promotion** | If the host leaves, the next member is automatically promoted |
| **Reconnection** | Automatically reconnects and re-syncs if the connection drops |

### Supported Platforms

Netflix · Disney+ · Prime Video · Crave · Hulu · Max (HBO) · Peacock · Paramount+ · Apple TV+ · YouTube

---

## Project Structure

```
playshare/
├── extension/               ← Chrome extension (load this folder)
│   ├── manifest.json
│   ├── background.js        ← Service worker: WebSocket client + message routing
│   ├── icons/               ← Extension icons (16, 32, 48, 128 px)
│   ├── popup/
│   │   ├── popup.html       ← Extension popup (toolbar button)
│   │   ├── popup.css
│   │   └── popup.js
│   ├── content/
│   │   ├── content.js       ← Injected into streaming pages; video sync + sidebar
│   │   └── sidebar.css      ← Styles for injected elements
│   └── sidebar/
│       ├── sidebar.html     ← Chat sidebar (loaded in iframe)
│       ├── sidebar.css
│       └── sidebar.js
└── server/
    ├── package.json
    └── server.js            ← Node.js WebSocket sync server
```

---

## Setup Instructions

### Step 1 — Start the Sync Server

The sync server must be running on a machine that all participants can reach. For local testing, run it on one machine and ensure all users are on the same network (or expose it via a tunnel).

```bash
cd server
npm install
node server.js
# Server listens on ws://localhost:8765 by default
```

**To change the port:**
```bash
PORT=9000 node server.js
```

**For remote/internet use (recommended for friends in different locations):**

Use a tunneling service to expose the server publicly:

```bash
# Option A: ngrok
ngrok tcp 8765
# Copy the forwarded address, e.g. tcp://0.tcp.ngrok.io:12345

# Option B: localtunnel
npx localtunnel --port 8765
```

Then update the `SERVER_URL` constant in `extension/background.js`:
```js
const SERVER_URL = 'ws://YOUR_PUBLIC_ADDRESS';
```

For a permanent deployment, host `server/server.js` on any Node.js-capable server (Railway, Render, Fly.io, etc.) and set `SERVER_URL` accordingly.

### Step 2 — Load the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `extension/` folder inside this project
5. The PlayShare icon (red play button) will appear in your toolbar

### Step 3 — Watch Together

**Host (person who starts the room):**
1. Navigate to a video on any supported streaming service
2. Click the PlayShare toolbar icon
3. Enter your display name
4. Click **Create Room**
5. Share the 6-character room code with your friends

**Guests (everyone else):**
1. Navigate to the **same video** on the same streaming service
2. Click the PlayShare toolbar icon
3. Enter your display name
4. Enter the room code and click **Join Room**

Once everyone has joined, the chat sidebar opens automatically. Press play on any member's browser — everyone else will sync instantly.

---

## How It Works

```
[User A Browser]          [PlayShare Server]          [User B Browser]
  content.js                  server.js                  content.js
      │                           │                           │
      │── PLAY (t=42.3s) ────────>│                           │
      │                           │── PLAY (t=42.3s) ────────>│
      │                           │                      applyPlay()
      │                           │                      video.currentTime = 42.3
      │                           │                      video.play()
      │                           │                           │
      │── CHAT "omg this part!" ─>│                           │
      │                           │── CHAT ──────────────────>│
      │                           │                      sidebar shows msg
```

- The **background service worker** maintains a single persistent WebSocket connection per browser.
- The **content script** intercepts native video events (`play`, `pause`, `seeked`) and forwards them to the background.
- The **server** relays events to all other room members.
- A `syncLock` flag prevents echo loops when applying remote events.
- Drift correction fires if the local playback position differs by more than **2 seconds** from the remote event.

---

## Configuration

| Setting | File | Default |
|---|---|---|
| Server URL | `extension/background.js` → `SERVER_URL` | `ws://localhost:8765` |
| Server port | `server/server.js` → `PORT` | `8765` |
| Sync threshold | `extension/content/content.js` → `SYNC_THRESHOLD` | `2.0` seconds |
| Max chat length | `extension/sidebar/sidebar.html` input `maxlength` | `500` chars |

---

## Deploying the Server (Production)

For friends in different locations, deploy the server to a free hosting provider:

### Railway (recommended — free tier available)
1. Push the `server/` folder to a GitHub repository
2. Create a new Railway project and connect the repo
3. Set the start command to `node server.js`
4. Railway will provide a public WebSocket URL
5. Update `SERVER_URL` in `background.js` to `wss://your-app.railway.app`

### Render
1. Create a new Web Service from the `server/` directory
2. Build command: `npm install`
3. Start command: `node server.js`
4. Use the provided `wss://` URL in `background.js`

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "Room not found" error | Ensure the server is running and `SERVER_URL` in `background.js` is correct |
| Video not syncing | Refresh the streaming page; the extension polls for video every 2 seconds |
| Sidebar not opening | Click the red tab on the right edge of the screen, or use the popup → "Open Chat" |
| Extension not loading | Ensure Developer Mode is on in `chrome://extensions` and you loaded the `extension/` folder |
| Friends can't connect | Use ngrok or deploy the server publicly; `localhost` only works on the same machine |

---

## Privacy

PlayShare does not collect, store, or transmit any personal data, viewing history, or account credentials. The sync server only relays playback timestamps and chat messages between room members in real time, and retains no data after a room is closed.

---

*PlayShare v1.0 — Built for friends who watch apart.*
