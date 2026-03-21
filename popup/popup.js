/**
 * PlayShare — Popup Script
 */

// ── DOM refs ──────────────────────────────────────────────────────────────────
const wsDot        = document.getElementById('wsDot');
const wsStatusText = document.getElementById('wsStatusText');
const viewAuth     = document.getElementById('viewAuth');
const viewLobby    = document.getElementById('viewLobby');
const viewRoom     = document.getElementById('viewRoom');
const usernameInput  = document.getElementById('usernameInput');
const roomCodeInput  = document.getElementById('roomCodeInput');
const serverUrlInput = document.getElementById('serverUrlInput');
const serverUrlInputCreate = document.getElementById('serverUrlInputCreate');
const btnPasteInvite = document.getElementById('btnPasteInvite');
const lobbyError     = document.getElementById('lobbyError');
const authError      = document.getElementById('authError');
const btnCreate      = document.getElementById('btnCreate');
const btnJoin        = document.getElementById('btnJoin');
const btnLogin       = document.getElementById('btnLogin');
const btnSignup      = document.getElementById('btnSignup');
const btnGuest       = document.getElementById('btnGuest');
const authLanding    = document.getElementById('authLanding');
const authForms      = document.getElementById('authForms');
const btnShowLoginForm = document.getElementById('btnShowLoginForm');
const btnAuthBack    = document.getElementById('btnAuthBack');
const displayRoomCode = document.getElementById('displayRoomCode');
const hostBadge      = document.getElementById('hostBadge');
const btnCopyCode    = document.getElementById('btnCopyCode');
const btnCopyLink    = document.getElementById('btnCopyLink');
const membersList    = document.getElementById('membersList');
const btnLeave       = document.getElementById('btnLeave');
const btnOpenSidebar = document.getElementById('btnOpenSidebar');
const hostOnlyControl = document.getElementById('hostOnlyControl');
const btnSignOut = document.getElementById('btnSignOut');
const lobbyStepChoose = document.getElementById('lobbyStepChoose');
const lobbyPanelCreate = document.getElementById('lobbyPanelCreate');
const lobbyPanelJoin = document.getElementById('lobbyPanelJoin');
const btnLobbyPickCreate = document.getElementById('btnLobbyPickCreate');
const btnLobbyPickJoin = document.getElementById('btnLobbyPickJoin');
const btnLobbyBackFromCreate = document.getElementById('btnLobbyBackFromCreate');
const btnLobbyBackFromJoin = document.getElementById('btnLobbyBackFromJoin');
const accountBar = document.getElementById('accountBar');
const accountBarText = document.getElementById('accountBarText');
const accountBarAction = document.getElementById('accountBarAction');

// ── State ─────────────────────────────────────────────────────────────────────
let currentState = null;
let currentUser = null;
/** Fired after Create room if we never get connected + ROOM_CREATED (e.g. wrong server URL). */
let createRoomPendingTimer = null;

function clearCreateRoomPendingTimer() {
  if (createRoomPendingTimer) {
    clearTimeout(createRoomPendingTimer);
    createRoomPendingTimer = null;
  }
}

function getSyncedServerUrl() {
  const j = serverUrlInput?.value?.trim() || '';
  const c = serverUrlInputCreate?.value?.trim() || '';
  return (c || j).trim();
}

if (serverUrlInput && serverUrlInputCreate) {
  serverUrlInput.addEventListener('input', () => {
    serverUrlInputCreate.value = serverUrlInput.value;
  });
  serverUrlInputCreate.addEventListener('input', () => {
    serverUrlInput.value = serverUrlInputCreate.value;
  });
}

// ── Auth UI ───────────────────────────────────────────────────────────────────
function updateAccountBar() {
  if (!accountBar || !accountBarText || !accountBarAction) return;
  // Auth screen already has “Log in” — hide redundant Guest · Sign in strip
  if (viewAuth && !viewAuth.classList.contains('hidden')) {
    accountBar.classList.add('hidden');
    return;
  }
  const inRoom = viewRoom && !viewRoom.classList.contains('hidden');
  const hasAuth = PlayShareAuth?.isConfigured;
  if (currentUser && hasAuth) {
    accountBar.classList.add('ws-account-bar--signed-in');
    accountBarText.textContent = 'Signed in as ' + (PlayShareAuth.getUserDisplayName({ user: currentUser }) || currentUser.email);
    accountBarAction.textContent = 'Sign out';
    accountBarAction.classList.remove('ws-account-bar-action--back');
    accountBarAction.classList.add('ws-account-bar-action--signout');
    accountBarAction.style.display = '';
    accountBar.classList.remove('hidden');
  } else if (hasAuth) {
    // In-room: no “← Back” (use Leave → lobby if guest needs account screen)
    if (inRoom) {
      accountBar.classList.add('hidden');
      return;
    }
    accountBar.classList.remove('ws-account-bar--signed-in');
    accountBarText.textContent = '';
    accountBarAction.textContent = '← Back';
    accountBarAction.classList.remove('ws-account-bar-action--signout');
    accountBarAction.classList.add('ws-account-bar-action--back');
    accountBarAction.style.display = '';
    accountBar.classList.remove('hidden');
  } else {
    accountBar.classList.remove('ws-account-bar--signed-in');
    accountBar.classList.add('hidden');
  }
}

function showAuthLanding() {
  if (authLanding) authLanding.classList.remove('hidden');
  if (authForms) authForms.classList.add('hidden');
  if (authError) authError.textContent = '';
}

function showAuthForms() {
  if (authLanding) authLanding.classList.add('hidden');
  if (authForms) authForms.classList.remove('hidden');
}

function showAuth() {
  viewAuth.classList.remove('hidden');
  viewLobby.classList.add('hidden');
  viewRoom.classList.add('hidden');
  showAuthLanding();
  updateAccountBar();
}

function showLobbyView() {
  viewAuth.classList.add('hidden');
  viewLobby.classList.remove('hidden');
  viewRoom.classList.add('hidden');
  if (accountBar) accountBar.classList.remove('hidden');
  setLobbyMode('choose');
  updateLobbyNicknameField();
  updateLobbyChooseButtons();
  updateAccountBar();
}

function showRoomView(state) {
  viewAuth.classList.add('hidden');
  viewLobby.classList.add('hidden');
  viewRoom.classList.remove('hidden');
  updateAccountBar();
  displayRoomCode.textContent = state.roomCode;
  hostBadge.style.display = state.isHost ? 'block' : 'none';
  const hostOnlyEl = document.getElementById('hostOnlyBadge');
  if (hostOnlyEl) hostOnlyEl.style.display = (state.hostOnlyControl && !state.isHost) ? 'block' : 'none';
  renderMembers(state.members || [], state.clientId);
}

function setupAuthTabs() {
  document.querySelectorAll('.ws-auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.ws-auth-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.ws-auth-form').forEach(f => f.classList.add('hidden'));
      tab.classList.add('active');
      const target = document.getElementById('auth' + (tab.dataset.authTab === 'signup' ? 'Signup' : 'Login'));
      if (target) target.classList.remove('hidden');
      authError.textContent = '';
    });
  });
}

function getUsername() {
  if (currentUser && PlayShareAuth?.isConfigured) {
    return PlayShareAuth.getUserDisplayName({ user: currentUser }) || '';
  }
  return usernameInput?.value?.trim() || '';
}

function setLobbyMode(mode) {
  const show = (el, on) => {
    if (!el) return;
    el.classList.toggle('hidden', !on);
  };
  show(lobbyStepChoose, mode === 'choose');
  show(lobbyPanelCreate, mode === 'create');
  show(lobbyPanelJoin, mode === 'join');
  if (lobbyError) lobbyError.textContent = '';
}

function canProceedFromLobbyChoose() {
  if (currentUser && PlayShareAuth?.isConfigured) return true;
  return !!(usernameInput?.value?.trim());
}

function updateLobbyChooseButtons() {
  const ok = canProceedFromLobbyChoose();
  if (btnLobbyPickCreate) btnLobbyPickCreate.disabled = !ok;
  if (btnLobbyPickJoin) btnLobbyPickJoin.disabled = !ok;
}

function updateLobbyNicknameField() {
  if (!usernameInput) return;
  const signedIn = !!(currentUser && PlayShareAuth?.isConfigured);
  usernameInput.readOnly = signedIn;
  usernameInput.title = signedIn ? 'From your PlayShare account' : '';
  usernameInput.classList.toggle('ws-input-readonly', signedIn);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  setupAuthTabs();

  const auth = window.PlayShareAuth;
  const hasAuth = auth && auth.isConfigured;

  if (hasAuth) {
    const session = await auth.init();
    if (session) {
      currentUser = session.user;
      chrome.storage.local.set({ user: { id: session.user.id, email: session.user.email, displayName: auth.getUserDisplayName(session) } });
      if (usernameInput) usernameInput.value = auth.getUserDisplayName(session);
      showLobbyView();
    } else {
      showAuth();
    }
    auth.onAuthStateChange((session) => {
      currentUser = session?.user || null;
      if (session) {
        chrome.storage.local.set({ user: { id: session.user.id, email: session.user.email, displayName: auth.getUserDisplayName(session) } });
        if (usernameInput) usernameInput.value = auth.getUserDisplayName(session);
        showLobbyView();
      } else {
        chrome.storage.local.remove('user');
        showAuth();
      }
    });
  } else {
    showLobbyView();
  }

  chrome.storage.local.get(['roomState', 'username', 'pendingJoinCode', 'serverUrl'], (data) => {
    let hadPendingJoin = false;
    if (data.roomState) {
      currentState = data.roomState;
      showRoomView(data.roomState);
    } else if (data.pendingJoinCode) {
      hadPendingJoin = true;
      if (roomCodeInput) roomCodeInput.value = data.pendingJoinCode;
      chrome.storage.local.remove('pendingJoinCode');
    }
    if (data.username && !currentUser && usernameInput) usernameInput.value = data.username;
    if (data.serverUrl) {
      if (serverUrlInput) serverUrlInput.value = data.serverUrl;
      if (serverUrlInputCreate) serverUrlInputCreate.value = data.serverUrl;
    }

    if (!data.roomState && viewLobby && !viewLobby.classList.contains('hidden')) {
      updateLobbyChooseButtons();
      if (hadPendingJoin) setLobbyMode('join');
    }
  });
}

init();

// ── Auth handlers ─────────────────────────────────────────────────────────────
if (btnLogin) {
  btnLogin.addEventListener('click', async () => {
    authError.textContent = '';
    const email = document.getElementById('authLoginEmail')?.value?.trim();
    const password = document.getElementById('authLoginPassword')?.value;
    if (!email || !password) {
      authError.textContent = 'Please enter email and password.';
      return;
    }
    try {
      const data = await PlayShareAuth.signIn(email, password);
      currentUser = data?.user || null;
      if (currentUser) {
        chrome.storage.local.set({ user: { id: currentUser.id, email: currentUser.email, displayName: PlayShareAuth.getUserDisplayName({ user: currentUser }) } });
      }
      if (usernameInput) usernameInput.value = PlayShareAuth.getUserDisplayName({ user: currentUser }) || '';
      showLobbyView();
    } catch (e) {
      authError.textContent = e.message || 'Sign in failed.';
    }
  });
}

if (btnSignup) {
  btnSignup.addEventListener('click', async () => {
    authError.textContent = '';
    const name = document.getElementById('authSignupName')?.value?.trim();
    const email = document.getElementById('authSignupEmail')?.value?.trim();
    const password = document.getElementById('authSignupPassword')?.value;
    if (!email || !password) {
      authError.textContent = 'Please enter email and password.';
      return;
    }
    if (password.length < 6) {
      authError.textContent = 'Password must be at least 6 characters.';
      return;
    }
    try {
      await PlayShareAuth.signUp(email, password, name);
      authError.textContent = 'Check your email to confirm your account, or sign in.';
    } catch (e) {
      authError.textContent = e.message || 'Sign up failed.';
    }
  });
}

if (btnGuest) {
  btnGuest.addEventListener('click', () => {
    showLobbyView();
  });
}

if (btnShowLoginForm) {
  btnShowLoginForm.addEventListener('click', () => {
    showAuthForms();
  });
}

if (btnAuthBack) {
  btnAuthBack.addEventListener('click', () => {
    showAuthLanding();
    if (authError) authError.textContent = '';
  });
}

// ── Connection status ─────────────────────────────────────────────────────────
chrome.runtime.sendMessage({ source: 'playshare', type: 'GET_DIAG' }, (res) => {
  if (res && res.roomState) {
    currentState = res.roomState;
    showRoomView(res.roomState);
  }
  const connected = res && res.connectionStatus === 'connected';
  updateConnectionStatus(connected);
});

function updateConnectionStatus(connected) {
  if (wsDot) wsDot.className = 'ws-dot ' + (connected ? 'connected' : 'disconnected');
  if (wsStatusText) wsStatusText.textContent = connected ? 'Connected' : 'Offline';
}

// ── Room display ──────────────────────────────────────────────────────────────
function showRoom(state) {
  currentState = state;
  showRoomView(state);
}

function loadSettings() {}

const STREAMING_URLS = globalThis.PLAYSHARE_STREAMING_CONFIG.tabQueryPatterns;

function saveSettings() {
  chrome.storage.local.set({ sidebarCompact: true, sidebarPosition: 'right' });
  chrome.tabs.query({ url: STREAMING_URLS }, (tabs) => {
    tabs.forEach(tab => {
      if (tab.id && !tab.url.startsWith('chrome://')) {
        chrome.tabs.sendMessage(tab.id, { source: 'playshare-bg', type: 'SETTINGS_CHANGED' }).catch(() => {});
      }
    });
  });
}

function showLobby() {
  viewAuth.classList.add('hidden');
  viewRoom.classList.add('hidden');
  viewLobby.classList.remove('hidden');
  currentState = null;
  setLobbyMode('choose');
  updateLobbyNicknameField();
  updateLobbyChooseButtons();
  updateAccountBar();
}

function renderMembers(members, myClientId) {
  if (!membersList) return;
  membersList.innerHTML = '';
  members.forEach(m => {
    const div = document.createElement('div');
    div.className = 'ws-member';
    const initials = m.username.slice(0, 2).toUpperCase();
    div.innerHTML = `
      <div class="ws-member-avatar" style="background:${m.color}22;color:${m.color};border:1px solid ${m.color}44">${initials}</div>
      <span class="ws-member-name">${escHtml(m.username)}</span>
      ${m.clientId === myClientId ? '<span class="ws-member-you">you</span>' : ''}
      ${m.isHost ? '<span class="ws-member-host-tag">HOST</span>' : ''}
    `;
    membersList.appendChild(div);
  });
}

// ── Buttons ───────────────────────────────────────────────────────────────────
if (btnLobbyPickCreate) {
  btnLobbyPickCreate.addEventListener('click', () => {
    if (!canProceedFromLobbyChoose()) {
      if (lobbyError) lobbyError.textContent = 'Please enter a display name.';
      usernameInput?.focus();
      return;
    }
    setLobbyMode('create');
  });
}
if (btnLobbyPickJoin) {
  btnLobbyPickJoin.addEventListener('click', () => {
    if (!canProceedFromLobbyChoose()) {
      if (lobbyError) lobbyError.textContent = 'Please enter a display name.';
      usernameInput?.focus();
      return;
    }
    setLobbyMode('join');
  });
}
if (btnLobbyBackFromCreate) {
  btnLobbyBackFromCreate.addEventListener('click', () => setLobbyMode('choose'));
}
if (btnLobbyBackFromJoin) {
  btnLobbyBackFromJoin.addEventListener('click', () => setLobbyMode('choose'));
}
if (usernameInput) {
  usernameInput.addEventListener('input', () => {
    updateLobbyChooseButtons();
    if (lobbyError && lobbyError.textContent === 'Please enter a display name.') lobbyError.textContent = '';
  });
}

btnCreate.addEventListener('click', () => {
  const username = getUsername();
  if (!username) {
    if (lobbyError) lobbyError.textContent = 'Please enter a display name.';
    setLobbyMode('choose');
    usernameInput?.focus();
    return;
  }
  const hostOnly = hostOnlyControl ? hostOnlyControl.checked : false;
  const serverUrl = getSyncedServerUrl();
  const toStore = { username };
  if (serverUrl) toStore.serverUrl = serverUrl;
  if (lobbyError) {
    lobbyError.textContent = '';
    lobbyError.style.color = '';
  }
  clearCreateRoomPendingTimer();
  /* Persist server URL before CREATE_ROOM so the service worker reads the same URL (set is async). */
  chrome.storage.local.set(toStore, () => {
    chrome.runtime.sendMessage({ source: 'playshare', type: 'CREATE_ROOM', username, hostOnlyControl: hostOnly, countdownOnPlay: false });
    createRoomPendingTimer = setTimeout(() => {
      createRoomPendingTimer = null;
      chrome.runtime.sendMessage({ source: 'playshare', type: 'GET_DIAG' }, (res) => {
        if (chrome.runtime.lastError) return;
        if (!res?.roomState && res?.connectionStatus !== 'connected' && lobbyError) {
          lobbyError.style.color = '#E50914';
          lobbyError.textContent =
            'Could not connect to the server. If node server.js runs on another computer (e.g. your MacBook), set Server WebSocket URL to ws:// that machine’s LAN IP :8765 — not localhost on this PC.';
        }
      });
    }, 4500);
  });
});

function parseInviteFromClipboard(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  let server = null;
  let code = null;
  const serverMatch = t.match(/(wss?:\/\/[^\s\n]+)/i);
  if (serverMatch) server = serverMatch[1].trim();
  const codeMatch = t.match(/(?:Code|code):\s*([A-Z0-9]{4,6})/i) || t.match(/\b([A-Z0-9]{4,6})\b/);
  if (codeMatch) code = codeMatch[1].toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  return { server, code };
}

if (btnPasteInvite) {
  btnPasteInvite.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      const parsed = parseInviteFromClipboard(text);
      if (parsed && (parsed.server || parsed.code)) {
        if (parsed.server) {
          if (serverUrlInput) serverUrlInput.value = parsed.server;
          if (serverUrlInputCreate) serverUrlInputCreate.value = parsed.server;
        }
        if (parsed.code && roomCodeInput) roomCodeInput.value = parsed.code;
        lobbyError.textContent = 'Pasted!';
        lobbyError.style.color = '#4ECDC4';
        setTimeout(() => { lobbyError.textContent = ''; lobbyError.style.color = ''; }, 1500);
      } else {
        lobbyError.textContent = 'Could not parse invite. Copy from the join page first.';
      }
    } catch {
      lobbyError.textContent = 'Please allow clipboard access or paste manually.';
    }
  });
}

btnJoin.addEventListener('click', () => {
  const username = getUsername();
  if (!username) {
    if (lobbyError) lobbyError.textContent = 'Please enter a display name.';
    setLobbyMode('choose');
    usernameInput?.focus();
    return;
  }
  const roomCode = roomCodeInput.value.trim().toUpperCase();
  const serverUrl = getSyncedServerUrl();
  if (!roomCode || roomCode.length < 4) {
    if (lobbyError) lobbyError.textContent = 'Please enter a valid room code.';
    return;
  }
  const joinStore = { username };
  if (serverUrl) joinStore.serverUrl = serverUrl;
  if (lobbyError) lobbyError.textContent = '';
  chrome.storage.local.set(joinStore, () => {
    chrome.runtime.sendMessage({ source: 'playshare', type: 'JOIN_ROOM', username, roomCode: roomCode });
  });
});

roomCodeInput.addEventListener('input', () => {
  roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

btnCopyCode.addEventListener('click', () => {
  if (currentState) {
    navigator.clipboard.writeText(currentState.roomCode).then(() => {
      btnCopyCode.title = 'Copied!';
      setTimeout(() => { btnCopyCode.title = 'Copy room code'; }, 1500);
    });
  }
});

btnCopyLink.addEventListener('click', () => {
  if (!currentState) return;
  chrome.runtime.sendMessage({ source: 'playshare', type: 'GET_ROOM_LINK_DATA' }, (linkData) => {
    if (!linkData) return;
    const serverUrl = linkData.serverUrl;
    let httpJoinUrl = serverUrl ? serverUrl.replace(/^ws:/, 'http:') + '/join?code=' + currentState.roomCode : null;
    if (httpJoinUrl && linkData.videoUrl) httpJoinUrl += '&url=' + encodeURIComponent(linkData.videoUrl);
    const textToCopy = httpJoinUrl || currentState.roomCode;
    navigator.clipboard.writeText(textToCopy).then(() => {
      btnCopyLink.title = linkData.videoUrl ? 'Link copied (one-click join)' : 'Link copied (open video tab first for one-click)';
      setTimeout(() => { btnCopyLink.title = 'Copy join link'; }, 2000);
    });
  });
});

btnLeave.addEventListener('click', () => {
  chrome.runtime.sendMessage({ source: 'playshare', type: 'LEAVE_ROOM' });
  showLobby();
});

btnOpenSidebar.addEventListener('click', () => {
  chrome.runtime.sendMessage({ source: 'playshare', type: 'TOGGLE_SIDEBAR_ACTIVE' });
  window.close();
});

async function handleSignOut() {
  if (PlayShareAuth?.signOut) {
    await PlayShareAuth.signOut();
    currentUser = null;
    chrome.storage.local.remove('user');
    showAuth();
  }
}

if (btnSignOut) btnSignOut.addEventListener('click', handleSignOut);

if (accountBarAction) {
  accountBarAction.addEventListener('click', async () => {
    if (currentUser && PlayShareAuth?.isConfigured) {
      await handleSignOut();
    } else {
      showAuth();
    }
  });
}

// ── Background messages ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.source !== 'playshare-bg') return;
  switch (msg.type) {
    case 'ROOM_CREATED':
    case 'ROOM_JOINED':
      clearCreateRoomPendingTimer();
      currentState = { roomCode: msg.roomCode, clientId: msg.clientId, username: msg.username, color: msg.color, isHost: msg.isHost, members: msg.members };
      showRoom(currentState);
      break;
    case 'MEMBER_JOINED':
    case 'MEMBER_LEFT':
      if (currentState) {
        currentState.members = msg.members;
        renderMembers(currentState.members, currentState.clientId);
        if (msg.newHostId === currentState.clientId) currentState.isHost = true;
      }
      break;
    case 'ROOM_LEFT':
      showLobby();
      break;
    case 'WS_CONNECTED':
      updateConnectionStatus(true);
      break;
    case 'WS_DISCONNECTED':
      updateConnectionStatus(false);
      break;
    case 'ERROR':
      clearCreateRoomPendingTimer();
      lobbyError.textContent = msg.message || 'An error occurred.';
      break;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
