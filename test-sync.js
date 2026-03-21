/**
 * PlayShare — Sync flow test
 * Simulates 2+ users connecting and verifies video state stays in sync.
 * Run: node test-sync.js (with server running: node server.js)
 */

const WebSocket = require('ws');

const SERVER = process.env.PLAYSHARE_TEST_SERVER || 'ws://localhost:8765';
const TIMEOUT = 5000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function createClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER);
    const received = [];
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        received.push(msg);
      } catch {}
    });
    ws.on('open', () => resolve({ ws, received }));
    ws.on('error', reject);
    ws.on('close', () => {});
  });
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function waitFor(client, type, timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const idx = client.received.findIndex(m => m.type === type);
      if (idx >= 0) {
        resolve(client.received[idx]);
        return;
      }
    };
    check();
    const interval = setInterval(check, 50);
    setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timeout waiting for ${type}`));
    }, timeout);
  });
}

async function run() {
  console.log('PlayShare sync test\n');
  let host, viewer;
  let hostRoomCode;

  try {
    // 1. Connect host
    console.log('1. Connecting host...');
    host = await createClient('host');
    console.log('   ✓ Host connected');

    // 2. Host creates room
    console.log('2. Host creates room...');
    send(host.ws, { type: 'CREATE_ROOM', username: 'Host' });
    const created = await waitFor(host, 'ROOM_CREATED');
    hostRoomCode = created.roomCode;
    console.log(`   ✓ Room created: ${hostRoomCode}`);

    // 3. Connect viewer
    console.log('3. Connecting viewer...');
    viewer = await createClient('viewer');
    console.log('   ✓ Viewer connected');

    // 4. Viewer joins room
    console.log('4. Viewer joins room...');
    send(viewer.ws, { type: 'JOIN_ROOM', roomCode: hostRoomCode, username: 'Viewer' });
    const joined = await waitFor(viewer, 'ROOM_JOINED');
    console.log(`   ✓ Viewer joined (state: playing=${joined.state?.playing}, time=${joined.state?.currentTime})`);

    // 5. Host sends PLAY at 30s
    console.log('5. Host sends PLAY at 30s...');
    send(host.ws, { type: 'PLAY', currentTime: 30 });
    const viewerPlay = await waitFor(viewer, 'PLAY');
    if (viewerPlay.currentTime !== 30) throw new Error(`Viewer got wrong time: ${viewerPlay.currentTime}`);
    if (!viewerPlay.correlationId || typeof viewerPlay.correlationId !== 'string') {
      throw new Error('PLAY missing server correlationId');
    }
    console.log(`   ✓ Viewer received PLAY at 30s (correlationId ok)`);

    // 6. Host sends PAUSE at 45s
    console.log('6. Host sends PAUSE at 45s...');
    send(host.ws, { type: 'PAUSE', currentTime: 45 });
    const viewerPause = await waitFor(viewer, 'PAUSE');
    if (viewerPause.currentTime !== 45) throw new Error(`Viewer got wrong time: ${viewerPause.currentTime}`);
    console.log(`   ✓ Viewer received PAUSE at 45s`);

    // 7. Host sends SEEK to 60s
    console.log('7. Host sends SEEK to 60s...');
    send(host.ws, { type: 'SEEK', currentTime: 60 });
    const viewerSeek = await waitFor(viewer, 'SEEK');
    if (viewerSeek.currentTime !== 60) throw new Error(`Viewer got wrong time: ${viewerSeek.currentTime}`);
    console.log(`   ✓ Viewer received SEEK to 60s`);

    console.log('7b. DIAG_ROOM_TRACE ring...');
    send(viewer.ws, { type: 'DIAG_ROOM_TRACE_REQUEST' });
    const diagTrace = await waitFor(viewer, 'DIAG_ROOM_TRACE');
    if (!Array.isArray(diagTrace.entries)) throw new Error('DIAG_ROOM_TRACE missing entries');
    if (diagTrace.entries.length < 1) throw new Error('Expected server playback ring to have entries');
    console.log(`   ✓ DIAG_ROOM_TRACE entries: ${diagTrace.entries.length}`);

    // 8. Viewer requests sync (e.g. after reconnect)
    console.log('8. Viewer requests SYNC...');
    send(viewer.ws, { type: 'SYNC_REQUEST' });
    const syncState = await waitFor(viewer, 'SYNC_STATE');
    if (!syncState.state || typeof syncState.state.currentTime !== 'number') {
      throw new Error('SYNC_STATE missing state');
    }
    console.log(`   ✓ Viewer got SYNC_STATE: playing=${syncState.state.playing}, time=${syncState.state.currentTime}`);

    // 9. Verify SYSTEM_MSG broadcast for PLAY
    const hasPlayMsg = viewer.received.some(m => m.type === 'SYSTEM_MSG' && m.text && m.text.includes('pressed play'));
    console.log(`9. SYSTEM_MSG for play: ${hasPlayMsg ? '✓' : '✗'}`);

    // 10. Add third user
    console.log('10. Connecting third user...');
    const viewer2 = await createClient('viewer2');
    send(viewer2.ws, { type: 'JOIN_ROOM', roomCode: hostRoomCode, username: 'Viewer2' });
    await waitFor(viewer2, 'ROOM_JOINED');
    console.log('   ✓ Third user joined');

    // 11. With hostOnlyControl off (default room), viewer PLAY is broadcast
    console.log('11. Viewer sends PLAY at 90s (collaborative control)...');
    send(viewer.ws, { type: 'PLAY', currentTime: 90 });
    const hostPlay = await waitFor(host, 'PLAY');
    const viewer2Play = await waitFor(viewer2, 'PLAY');
    if (hostPlay.currentTime !== 90 || viewer2Play.currentTime !== 90) {
      throw new Error(`Host or Viewer2 got wrong time: host=${hostPlay.currentTime}, v2=${viewer2Play.currentTime}`);
    }
    console.log('   ✓ Host and Viewer2 received PLAY at 90s');

    // 11b. With hostOnlyControl on, non-host PLAY must be ignored
    console.log('11b. Room with host-only: viewer PLAY rejected...');
    const strictHost = await createClient('strictHost');
    send(strictHost.ws, { type: 'CREATE_ROOM', username: 'Host2', hostOnlyControl: true });
    const strictCreated = await waitFor(strictHost, 'ROOM_CREATED');
    const strictCode = strictCreated.roomCode;
    const strictViewer = await createClient('strictViewer');
    send(strictViewer.ws, { type: 'JOIN_ROOM', roomCode: strictCode, username: 'V' });
    await waitFor(strictViewer, 'ROOM_JOINED');
    const strictBefore = strictHost.received.filter((m) => m.type === 'PLAY').length;
    send(strictViewer.ws, { type: 'PLAY', currentTime: 1 });
    await sleep(400);
    const strictAfter = strictHost.received.filter((m) => m.type === 'PLAY').length;
    if (strictAfter !== strictBefore) throw new Error('hostOnlyControl: viewer PLAY should not broadcast');
    strictViewer.ws.close();
    strictHost.ws.close();
    console.log('   ✓ hostOnlyControl enforced on server');

    // 11c. Periodic sync packets while room is active
    console.log('11c. Waiting for periodic sync from server...');
    await sleep(2500);
    const syncMsg = viewer.received.find((m) => m.type === 'sync' && typeof m.sentAt === 'number');
    if (!syncMsg) throw new Error('Expected at least one { type: sync, sentAt } broadcast');
    if (syncMsg.state !== 'playing' && syncMsg.state !== 'paused') {
      throw new Error('sync.state must be playing or paused');
    }
    console.log('   ✓ Periodic sync received');

    viewer2.ws.close();

    console.log('\n✅ All sync tests passed. 2+ users can connect and video stays in sync.');
  } catch (err) {
    console.error('\n❌ Test failed:', err.message);
    process.exit(1);
  } finally {
    if (host?.ws) host.ws.close();
    if (viewer?.ws) viewer.ws.close();
    process.exit(0);
  }
}

run();
