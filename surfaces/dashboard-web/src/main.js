/**
 * PlayShare web lobby — CREATE_ROOM / JOIN_ROOM / CHAT via same signaling server as the extension.
 */

import { PlayShareSignalingClientType } from '../../shared/playshare/signaling-client.js';

const LS = {
  WSS: 'playshare_web_wss_url',
  NAME: 'playshare_web_display_name'
};

/** @type {WebSocket|null} */
let ws = null;
/** @type {ReturnType<typeof setInterval>|null} */
let hb = null;

/** @type {{ inRoom: boolean, roomCode: string|null, clientId: string|null, username: string|null, isHost: boolean, members: object[] }} */
const state = {
  inRoom: false,
  roomCode: null,
  clientId: null,
  username: null,
  isHost: false,
  members: []
};

const typingUsers = new Set();
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const typingClearTimers = new Map();
/** @type {ReturnType<typeof setTimeout>|null} */
let typingIdleTimer = null;

const TYPING_IDLE_MS = 1500;
const TYPING_PEER_CLEAR_MS = 3000;

/** @param {string} id */
function $(id) {
  return document.getElementById(id);
}

/** @param {boolean} ok @param {string} label */
function setConn(ok, label) {
  const dot = $('connDot');
  dot.className = 'ws-dot ' + (ok ? 'ok' : 'off');
  $('connLabel').textContent = label;
}

/** @param {string} [msg] */
function showError(msg) {
  const el = $('globalError');
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.textContent = msg;
  el.hidden = false;
}

function inferDefaultWss() {
  const { protocol, host } = window.location;
  if (protocol === 'https:') return `wss://${host}`;
  if (protocol === 'http:' && (host.startsWith('localhost') || host.startsWith('127.0.0.1'))) {
    return `ws://${host}`;
  }
  return `wss://${host}`;
}

function stopHeartbeat() {
  if (hb) clearInterval(hb);
  hb = null;
}

function startHeartbeat() {
  stopHeartbeat();
  hb = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: PlayShareSignalingClientType.HEARTBEAT }));
    }
  }, 25000);
}

function closeSocket() {
  stopHeartbeat();
  try {
    if (ws) ws.close();
  } catch {
    /* ignore */
  }
  ws = null;
  setConn(false, 'Offline');
}

/**
 * @param {string} wssUrl
 * @returns {Promise<void>}
 */
function ensureSocket(wssUrl) {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN && ws.__playshareUrl === wssUrl) {
      resolve();
      return;
    }
    closeSocket();
    let settled = false;
    let s;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (s instanceof WebSocket) s.close();
      } catch {
        /* ignore */
      }
      reject(new Error('Connection timeout'));
    }, 15000);
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      reject(new Error(msg));
    };
    const ok = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve();
    };
    try {
      s = new WebSocket(wssUrl);
      ws = s;
      s.__playshareUrl = wssUrl;
      s.onopen = () => {
        setConn(true, 'Connected');
        startHeartbeat();
        ok();
      };
      s.onerror = () => fail('WebSocket error');
      s.onclose = () => {
        stopHeartbeat();
        setConn(false, 'Offline');
        if (!settled) fail('Connection closed');
        if (state.inRoom) {
          showError('Disconnected from the signaling server.');
          leaveRoomLocal();
        }
      };
      s.onmessage = (ev) => {
        try {
          handleServerMessage(JSON.parse(ev.data));
        } catch {
          /* ignore */
        }
      };
    } catch (e) {
      clearTimeout(t);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** @param {object} msg */
function handleServerMessage(msg) {
  const t = msg && msg.type;
  switch (t) {
    case 'SERVER_INFO':
    case 'HEARTBEAT_ACK':
      return;
    case 'ERROR':
      showError(msg.message || msg.code || 'Server error');
      return;
    case 'ROOM_CREATED':
    case 'ROOM_JOINED':
      enterRoom(msg);
      return;
    case 'MEMBER_JOINED':
    case 'MEMBER_LEFT':
      if (Array.isArray(msg.members)) setMembers(msg.members);
      return;
    case 'CHAT':
      appendChatMsg(msg);
      return;
    case 'REACTION':
      appendReaction(msg);
      return;
    case 'TYPING_START':
      if (msg.clientId && state.clientId && msg.clientId === state.clientId) return;
      if (msg.username) {
        typingUsers.add(msg.username);
        updateTypingIndicator();
        const prev = typingClearTimers.get(msg.username);
        if (prev) clearTimeout(prev);
        typingClearTimers.set(
          msg.username,
          setTimeout(() => {
            typingClearTimers.delete(msg.username);
            typingUsers.delete(msg.username);
            updateTypingIndicator();
          }, TYPING_PEER_CLEAR_MS)
        );
      }
      return;
    case 'TYPING_STOP':
      if (msg.username) {
        const t = typingClearTimers.get(msg.username);
        if (t) clearTimeout(t);
        typingClearTimers.delete(msg.username);
        typingUsers.delete(msg.username);
        updateTypingIndicator();
      }
      return;
    case 'SYSTEM_MSG':
      appendSystem(String(msg.text || ''));
      return;
    default:
      return;
  }
}

/** @param {object} msg */
function enterRoom(msg) {
  state.inRoom = true;
  state.roomCode = msg.roomCode || null;
  state.clientId = msg.clientId || null;
  state.username = typeof msg.username === 'string' ? msg.username : null;
  state.isHost = !!msg.isHost;
  state.members = Array.isArray(msg.members) ? msg.members : [];
  clearTypingState();
  $('viewLobby').hidden = true;
  $('viewRoom').hidden = false;
  showError('');
  $('roomCodeEl').textContent = state.roomCode || '------';
  $('hostPill').hidden = !state.isHost;
  renderMembers();
  $('msgList').innerHTML = '';
  $('chatInput').value = '';
  $('chatInput').focus();
}

function clearTypingState() {
  clearTimeout(typingIdleTimer);
  typingIdleTimer = null;
  for (const t of typingClearTimers.values()) clearTimeout(t);
  typingClearTimers.clear();
  typingUsers.clear();
  const ind = $('typingIndicator');
  ind.textContent = '';
  ind.style.display = 'none';
}

function leaveRoomLocal() {
  state.inRoom = false;
  state.roomCode = null;
  state.clientId = null;
  state.username = null;
  state.isHost = false;
  state.members = [];
  clearTypingState();
  $('viewLobby').hidden = false;
  $('viewRoom').hidden = true;
  $('msgList').innerHTML = '';
}

function updateTypingIndicator() {
  const el = $('typingIndicator');
  const mine = state.username;
  const others = [...typingUsers].filter((u) => u && u !== mine);
  if (others.length === 0) {
    el.textContent = '';
    el.style.display = 'none';
  } else {
    el.textContent =
      others.length === 1 ? `${others[0]} is typing…` : `${others.length} people typing…`;
    el.style.display = 'block';
  }
}

function onTypingActivity() {
  if (!state.inRoom || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: PlayShareSignalingClientType.TYPING_START }));
  clearTimeout(typingIdleTimer);
  typingIdleTimer = setTimeout(() => {
    typingIdleTimer = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: PlayShareSignalingClientType.TYPING_STOP }));
    }
  }, TYPING_IDLE_MS);
}

/** @param {object[]} members */
function setMembers(members) {
  state.members = members;
  renderMembers();
}

function renderMembers() {
  const ul = $('memberList');
  ul.innerHTML = '';
  for (const m of state.members) {
    const li = document.createElement('li');
    li.className = 'ws-member';
    const dot = document.createElement('span');
    dot.className = 'ws-member-dot';
    dot.style.background = m.color || '#888';
    const name = document.createElement('span');
    name.className = 'ws-member-name';
    name.textContent = m.username || '—';
    li.appendChild(dot);
    li.appendChild(name);
    if (m.isHost) {
      const tag = document.createElement('span');
      tag.className = 'ws-member-tag';
      tag.textContent = 'Host';
      li.appendChild(tag);
    }
    ul.appendChild(li);
  }
}

/** @param {string} text */
function appendSystem(text) {
  const div = document.createElement('div');
  div.className = 'ws-system-msg';
  div.textContent = text;
  $('msgList').appendChild(div);
  scrollChat();
}

/** @param {object} msg */
function appendChatMsg(msg) {
  const row = document.createElement('div');
  row.className = 'ws-msg';
  const av = document.createElement('div');
  av.className = 'ws-msg-avatar';
  av.style.background = msg.color || '#4ecdc4';
  av.textContent = String(msg.username || '?')
    .slice(0, 1)
    .toUpperCase();
  const body = document.createElement('div');
  body.className = 'ws-msg-body';
  const name = document.createElement('div');
  name.className = 'ws-msg-name';
  name.style.color = msg.color || '#f0f0f0';
  name.textContent = msg.username || 'Unknown';
  const text = document.createElement('div');
  text.className = 'ws-msg-text';
  text.textContent = msg.text || '';
  body.appendChild(name);
  body.appendChild(text);
  row.appendChild(av);
  row.appendChild(body);
  $('msgList').appendChild(row);
  scrollChat();
}

/** @param {object} msg */
function appendReaction(msg) {
  const div = document.createElement('div');
  div.className = 'ws-reaction-msg';
  const color = msg.color || '#888';
  const emoji = msg.emoji || '';
  const uname = msg.username || '';
  const em = document.createElement('span');
  em.className = 'ws-reaction-emoji';
  em.textContent = emoji;
  const who = document.createElement('span');
  who.style.color = color;
  who.textContent = uname;
  const tail = document.createElement('span');
  tail.style.color = '#555';
  tail.textContent = 'reacted';
  div.appendChild(em);
  div.appendChild(who);
  div.appendChild(tail);
  $('msgList').appendChild(div);
  scrollChat();
}

function scrollChat() {
  const el = $('msgList');
  el.scrollTop = el.scrollHeight;
}

function sendChat() {
  const input = $('chatInput');
  const text = (input.value || '').trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  clearTimeout(typingIdleTimer);
  typingIdleTimer = null;
  ws.send(JSON.stringify({ type: PlayShareSignalingClientType.TYPING_STOP }));
  ws.send(JSON.stringify({ type: PlayShareSignalingClientType.CHAT, text }));
  input.value = '';
}

function sendReaction(emoji) {
  if (!state.inRoom || !emoji || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: PlayShareSignalingClientType.REACTION, emoji }));
}

async function onCreate() {
  showError('');
  const wss = $('inServer').value.trim() || inferDefaultWss();
  const username = ($('inName').value || 'Host').trim().slice(0, 24) || 'Host';
  localStorage.setItem(LS.WSS, wss);
  localStorage.setItem(LS.NAME, username);
  $('btnCreate').disabled = true;
  $('btnJoin').disabled = true;
  try {
    await ensureSocket(wss);
    ws.send(
      JSON.stringify({
        type: PlayShareSignalingClientType.CREATE_ROOM,
        username,
        hostOnlyControl: false,
        countdownOnPlay: false
      })
    );
  } catch (e) {
    showError(e.message || 'Could not connect');
  } finally {
    $('btnCreate').disabled = false;
    $('btnJoin').disabled = false;
  }
}

async function onJoin() {
  showError('');
  const wss = $('inServer').value.trim() || inferDefaultWss();
  const username = ($('inName').value || 'Viewer').trim().slice(0, 24) || 'Viewer';
  const roomCode = $('inCode').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (roomCode.length < 4) {
    showError('Enter a valid room code (4–6 characters).');
    return;
  }
  localStorage.setItem(LS.WSS, wss);
  localStorage.setItem(LS.NAME, username);
  $('btnCreate').disabled = true;
  $('btnJoin').disabled = true;
  try {
    await ensureSocket(wss);
    ws.send(
      JSON.stringify({
        type: PlayShareSignalingClientType.JOIN_ROOM,
        roomCode,
        username
      })
    );
  } catch (e) {
    showError(e.message || 'Could not connect');
  } finally {
    $('btnCreate').disabled = false;
    $('btnJoin').disabled = false;
  }
}

function onLeave() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: PlayShareSignalingClientType.LEAVE_ROOM }));
    } catch {
      /* ignore */
    }
  }
  leaveRoomLocal();
  showError('');
}

function init() {
  $('inServer').value = localStorage.getItem(LS.WSS) || inferDefaultWss();
  $('inName').value = localStorage.getItem(LS.NAME) || '';

  const qp = new URLSearchParams(window.location.search);
  const preCode = (qp.get('code') || qp.get('playshare') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (preCode.length >= 4) $('inCode').value = preCode;

  $('btnCreate').addEventListener('click', () => void onCreate());
  $('btnJoin').addEventListener('click', () => void onJoin());
  $('btnLeave').addEventListener('click', onLeave);
  $('btnSend').addEventListener('click', sendChat);
  $('chatInput').addEventListener('input', onTypingActivity);
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
      return;
    }
    onTypingActivity();
  });

  const bar = document.querySelector('.ws-reactions-bar');
  if (bar) {
    bar.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('.ws-reaction-btn') : null;
      if (!btn) return;
      const emoji = btn.getAttribute('data-emoji');
      if (emoji) sendReaction(emoji);
    });
  }

  $('btnCopyCode').addEventListener('click', () => {
    const c = state.roomCode;
    if (!c) return;
    navigator.clipboard.writeText(c).then(() => {
      const b = $('btnCopyCode');
      b.textContent = 'Copied';
      setTimeout(() => {
        b.textContent = 'Copy';
      }, 1500);
    });
  });

  $('inCode').addEventListener('input', () => {
    $('inCode').value = $('inCode').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
}

init();
