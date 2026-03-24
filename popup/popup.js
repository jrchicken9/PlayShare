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
/** wss/ws signaling URL → https/http origin for /join links (path on WS URL is stripped). */
function wsUrlToHttpBase(wsUrl) {
  if (!wsUrl || typeof wsUrl !== 'string') return null;
  let t = wsUrl.trim();
  if (!t) return null;
  if (!/^wss?:\/\//i.test(t)) t = `wss://${t.replace(/^\/\//, '')}`;
  try {
    const u = new URL(t);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
    const httpProto = u.protocol === 'ws:' ? 'http:' : 'https:';
    return `${httpProto}//${u.host}`;
  } catch {
    return null;
  }
}

const btnPasteInvite = document.getElementById('btnPasteInvite');
const lobbyError     = document.getElementById('lobbyError');
const roomActionError = document.getElementById('roomActionError');
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
const footerVersionLine = document.getElementById('footerVersionLine');

/** Shown in popup footer — always matches `manifest.json` `version` (Chrome Web Store source of truth). */
if (footerVersionLine) {
  try {
    const v = chrome.runtime.getManifest()?.version || '0.0.0';
    footerVersionLine.textContent = `v${v} · Each viewer needs their own subscription`;
  } catch {
    footerVersionLine.textContent = 'Each viewer needs their own subscription';
  }
}

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

/** Same origin as `background.js` / `server-config.js` — change server URL only in `server-config.js` for dev. */
const SIGNALING_SERVER_URL =
  typeof PLAYSHARE_SERVER_URL !== 'undefined'
    ? PLAYSHARE_SERVER_URL
    : 'wss://playshare-production.up.railway.app';

function getSyncedServerUrl() {
  return SIGNALING_SERVER_URL;
}

// ── Auth UI ───────────────────────────────────────────────────────────────────
function updateAccountBar() {
  if (!accountBar || !accountBarText || !accountBarAction) return;
  // Auth screen already has “Log in” — hide redundant Guest · Sign in strip
  if (viewAuth && !viewAuth.classList.contains('hidden')) {
    accountBar.classList.add('hidden');
    return;
  }
  // Create / Join panels have their own “← Back”; hide header strip to avoid duplicate CTAs
  const lobbySubPanelOpen =
    viewLobby &&
    !viewLobby.classList.contains('hidden') &&
    ((lobbyPanelCreate && !lobbyPanelCreate.classList.contains('hidden')) ||
      (lobbyPanelJoin && !lobbyPanelJoin.classList.contains('hidden')));
  if (lobbySubPanelOpen) {
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
  if (roomActionError) {
    roomActionError.textContent = '';
    roomActionError.classList.add('hidden');
  }
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
  updateAccountBar();
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

  chrome.storage.local.get(['roomState', 'username', 'pendingJoinCode'], (data) => {
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
    chrome.storage.local.set({ serverUrl: SIGNALING_SERVER_URL });

    if (!data.roomState && viewLobby && !viewLobby.classList.contains('hidden')) {
      updateLobbyChooseButtons();
      if (hadPendingJoin) setLobbyMode('join');
    }
  });
}

init();

/** Same key as `PRIME_SYNC_DEBUG_STORAGE_KEY` in content `sites/prime-video-sync.js`. */
const PRIME_SYNC_DEBUG_STORAGE_KEY = 'primeSyncDebugHud';
const primeSyncDebugHudInput = document.getElementById('primeSyncDebugHud');
if (primeSyncDebugHudInput) {
  chrome.storage.local.get({ [PRIME_SYNC_DEBUG_STORAGE_KEY]: false }, (d) => {
    primeSyncDebugHudInput.checked = !!d[PRIME_SYNC_DEBUG_STORAGE_KEY];
  });
  primeSyncDebugHudInput.addEventListener('change', () => {
    chrome.storage.local.set({ [PRIME_SYNC_DEBUG_STORAGE_KEY]: primeSyncDebugHudInput.checked });
  });
}

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
function loadPopupStateFromBackground() {
  chrome.runtime.sendMessage({ source: 'playshare', type: 'GET_DIAG' }, (res) => {
    if (res && res.roomState) {
      currentState = res.roomState;
      showRoomView(res.roomState);
    }
    updateWsHeader(res);
  });
}

chrome.storage.local.get(['serverUrl'], (st) => {
  const url = (st.serverUrl && String(st.serverUrl).trim()) || getSyncedServerUrl();
  const afterEnsure = () => {
    chrome.runtime.sendMessage({ source: 'playshare', type: 'REQUEST_WS_RECONNECT' }, () => {
      loadPopupStateFromBackground();
    });
  };
  if (typeof PlayShareSignalPermissions !== 'undefined') {
    PlayShareSignalPermissions.ensure(url, afterEnsure);
  } else {
    afterEnsure();
  }
});

function updateWsHeader(res) {
  if (!res || typeof res !== 'object') {
    if (wsDot) wsDot.className = 'ws-dot disconnected';
    if (wsStatusText) wsStatusText.textContent = 'Offline';
    return;
  }
  const open = !!(res.open === true || res.connectionStatus === 'connected');
  const phase = res.transportPhase || '';
  const message =
    typeof res.connectionMessage === 'string' && res.connectionMessage.trim()
      ? res.connectionMessage
      : open
        ? 'Connected'
        : 'Offline';
  if (wsDot) {
    let cls = 'ws-dot';
    if (open) cls += ' connected';
    else if (phase === 'unreachable') cls += ' unreachable';
    else cls += ' disconnected';
    wsDot.className = cls;
  }
  if (wsStatusText) wsStatusText.textContent = message;
}

function userVisibleServerErrorLine(msg) {
  const code = msg && msg.code;
  if (code === 'ROOM_NOT_FOUND') return 'Server unavailable — that room may have ended.';
  if (code === 'RATE_LIMIT') return 'Too many messages — slow down.';
  if (code === 'MESSAGE_TOO_LARGE') return 'Message too large.';
  return (msg && msg.message) || 'Something went wrong.';
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
  if (roomActionError) {
    roomActionError.textContent = '';
    roomActionError.classList.add('hidden');
  }
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

if (hostOnlyControl) {
  hostOnlyControl.setAttribute('aria-checked', hostOnlyControl.checked ? 'true' : 'false');
  hostOnlyControl.addEventListener('change', () => {
    hostOnlyControl.setAttribute('aria-checked', hostOnlyControl.checked ? 'true' : 'false');
  });
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
  const toStore = { username, serverUrl: getSyncedServerUrl() };
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
        const connected = !!(res && (res.open === true || res.connectionStatus === 'connected'));
        if (!res?.roomState && !connected && lobbyError) {
          lobbyError.style.color = '#E50914';
          lobbyError.textContent =
            res?.transportPhase === 'unreachable'
              ? 'Server unavailable — check your network or server URL.'
              : 'Could not connect to the signaling server. Check your network or try again in a moment.';
        }
      });
    }, 4500);
  });
});

function parseInviteFromClipboard(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim();
  if (/^wss:\/\/[^\s]+\/join\b/i.test(t)) {
    t = 'https://' + t.slice(6);
  }
  const codeMatch = t.match(/(?:Code|code):\s*([A-Z0-9]{4,6})/i) || t.match(/\b([A-Z0-9]{4,6})\b/);
  const code = codeMatch ? codeMatch[1].toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) : null;
  return { code };
}

if (btnPasteInvite) {
  btnPasteInvite.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      const parsed = parseInviteFromClipboard(text);
      if (parsed?.code && roomCodeInput) {
        roomCodeInput.value = parsed.code;
        lobbyError.textContent = 'Pasted!';
        lobbyError.style.color = '#4ECDC4';
        setTimeout(() => { lobbyError.textContent = ''; lobbyError.style.color = ''; }, 1500);
      } else {
        lobbyError.textContent = 'Could not find a room code. Copy the full invite from the join page.';
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
  if (!roomCode || roomCode.length < 4) {
    if (lobbyError) lobbyError.textContent = 'Please enter a valid room code.';
    return;
  }
  const joinStore = { username, serverUrl: getSyncedServerUrl() };
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
    const httpBase = wsUrlToHttpBase(serverUrl);
    let httpJoinUrl = httpBase ? `${httpBase}/join?code=${currentState.roomCode}` : null;
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
  chrome.runtime.sendMessage({ source: 'playshare', type: 'TOGGLE_SIDEBAR_ACTIVE' }, (r) => {
    if (chrome.runtime.lastError) {
      window.close();
      return;
    }
    if (r && !r.ok) {
      const inRoom = viewRoom && !viewRoom.classList.contains('hidden');
      const errEl = inRoom ? roomActionError : lobbyError;
      if (errEl) {
        errEl.style.color = '#E50914';
        if (r.error === 'NOT_STREAMING') {
          errEl.textContent =
            'Not on a supported site — open Netflix, YouTube, or another listed streaming page first.';
        } else if (r.error === 'NO_TAB' || r.error === 'NOT_WEB_PAGE') {
          errEl.textContent = 'Open a normal browser tab, then try again.';
        } else if (r.error === 'SEND_FAILED') {
          errEl.textContent = 'Could not reach this tab — refresh the streaming page and try again.';
        } else {
          errEl.textContent = 'Could not open the sidebar.';
        }
        if (inRoom && roomActionError) roomActionError.classList.remove('hidden');
      }
      return;
    }
    window.close();
  });
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
    case 'WS_STATUS':
      updateWsHeader(msg);
      break;
    case 'ERROR':
      clearCreateRoomPendingTimer();
      if (lobbyError) {
        lobbyError.style.color = '#E50914';
        lobbyError.textContent = userVisibleServerErrorLine(msg);
      }
      break;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
