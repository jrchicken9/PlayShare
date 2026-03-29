/**
 * PlayShare desktop renderer — Supabase auth, auto signaling, dashboard + room flow.
 */
import { createClient } from '@supabase/supabase-js';
import { PlayShareSignalingClientType } from '../../../shared/core/signaling-client.js';
import { PLAYS_SHARE_DEFAULT_PUBLIC_WSS } from '../../../shared/core/product.js';
import { buildWatchDeepLink } from '../../../shared/core/invite-link.js';
import {
  PLAYSUP_SHARE_SUPABASE_URL,
  PLAYSUP_SHARE_SUPABASE_ANON_KEY
} from '../../../shared/core/supabase-public-config.js';
import { SPOTLIGHT_PICKS } from './spotlight-data.js';
import { createLobbyOperativeEl } from '../../../shared/ui/lobby-operative.js';

function desktop() {
  return window.playshareDesktop;
}

function $(id) {
  return document.getElementById(id);
}

const DESKTOP_WSS_STORAGE_KEY = 'playshare_desktop_wss_url';
const AUTH_TO_DASH_MS = 480;

let autoConnectAttempted = false;
/** Tracks session across renders so we can animate auth → dashboard once per login */
let previousAuthPresent = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let authDashTransitionTimer = null;
/** Clears lobby chat when transitioning out of a room */
let lobbyChatWasInRoom = false;
/** TMDB picks suggested to the room (shown in lobby); cleared when leaving. */
let lobbyRoomSuggestions = [];
const LOBBY_SUGGEST_MAX = 15;
/** While signaling says we're in a room: 'lobby' = watch-party UI, 'dashboard' = browse catalog without leaving the room */
let roomNavSurface = 'lobby';
/** Set to `${httpOrigin}|${supabaseUserId}` only after TMDB spotlight cards render (not editorial fallback). */
let spotlightTmdbSuccessKey = null;
/** Cooldown after a failed/empty catalog response so `render()` does not hammer the API. */
let spotlightLastCatalogFetchAt = 0;
/** When true, bypass cooldown (e.g. signaling just connected). */
let spotlightCatalogForceRefresh = false;

const SPOTLIGHT_CATALOG_COOLDOWN_MS = 12000;

const SPOTLIGHT_TITLE_DEFAULT = 'Trending TV this week';

function catalogActiveBrowseMedia() {
  return $('tabGenreMovie')?.classList.contains('is-active') ? 'movie' : 'tv';
}

function spotlightTrendingHeading(media) {
  const m = media === 'movie' ? 'movie' : 'tv';
  return m === 'movie' ? 'Trending movies this week' : 'Trending TV this week';
}
/** trending | search | genre — skip ensureSpotlight refetch when user is browsing */
let catalogUiMode = 'trending';
/** Load genre chips once per signaling origin */
let catalogGenresHydratedForBase = null;
/** Prevents overlapping genre fetches (which duplicated chips). */
let catalogGenreHydrateLock = null;
/** Cached genre lists from TMDB */
let catalogGenreData = { tv: [], movie: [] };
/** Last picked genre for tab highlight */
let catalogLastGenrePick = null;
/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
let supabaseClient = null;
/** @type {import('@supabase/supabase-js').Session | null} */
let authSession = null;

/** @type {{ connected: boolean, connecting: boolean, wsUrl: string | null, serverSignalUrl: string | null, lastError: string | null, room: object, watch: object }} */
const ui = {
  connected: false,
  connecting: false,
  wsUrl: null,
  serverSignalUrl: null,
  lastError: null,
  room: {
    inRoom: false,
    roomCode: null,
    clientId: null,
    username: null,
    isHost: false,
    members: []
  },
  watch: { providerKey: '', titleNote: '', watchUrl: '' }
};

function getWsUrl() {
  try {
    const s = localStorage.getItem(DESKTOP_WSS_STORAGE_KEY);
    if (s && s.trim()) return s.trim();
  } catch (_) {
    /* ignore */
  }
  return PLAYS_SHARE_DEFAULT_PUBLIC_WSS;
}

function getUserDisplayName(session) {
  if (!session?.user) return 'there';
  const meta = session.user.user_metadata?.display_name;
  if (meta && String(meta).trim()) return String(meta).trim();
  const em = session.user.email;
  if (em) return em.split('@')[0] || 'there';
  return 'there';
}

function displayNameForRoom() {
  const base = getUserDisplayName(authSession);
  return (base || 'Host').slice(0, 24);
}

function setAuthHint(msg) {
  const el = $('authHint');
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}

function mergeStatus(patch) {
  if (!patch || typeof patch !== 'object') return;
  if (patch.connected !== undefined) ui.connected = patch.connected;
  if (patch.connecting !== undefined) ui.connecting = patch.connecting;
  if (patch.wsUrl !== undefined) {
    if (ui.wsUrl !== patch.wsUrl) {
      spotlightTmdbSuccessKey = null;
      spotlightLastCatalogFetchAt = 0;
      catalogGenresHydratedForBase = null;
      catalogGenreHydrateLock = null;
      catalogGenreData = { tv: [], movie: [] };
      catalogLastGenrePick = null;
      roomNavSurface = 'lobby';
      const g = $('spotlightGrid');
      if (g) g.innerHTML = '';
      const ga = $('genreChipsActive');
      if (ga) ga.innerHTML = '';
      setSpotlightCatalogChrome(false);
    }
    ui.wsUrl = patch.wsUrl;
  }
  if (patch.serverSignalUrl !== undefined) ui.serverSignalUrl = patch.serverSignalUrl;
  if (patch.lastError !== undefined) ui.lastError = patch.lastError;
  if (patch.room) {
    const wasIn = ui.room.inRoom;
    ui.room = { ...patch.room };
    if (!ui.room.inRoom) roomNavSurface = 'lobby';
    else if (!wasIn && ui.room.inRoom) roomNavSurface = 'lobby';
  }
  if (patch.watch) ui.watch = { ...ui.watch, ...patch.watch };
}

function clearAuthDashTransition() {
  if (authDashTransitionTimer) {
    clearTimeout(authDashTransitionTimer);
    authDashTransitionTimer = null;
  }
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function formatChatTime(ts) {
  const n = typeof ts === 'number' ? ts : Date.now();
  try {
    return new Date(n).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function clearLobbyChat() {
  const log = $('lobbyChatLog');
  if (!log) return;
  log.innerHTML = '';
  const ph = document.createElement('p');
  ph.id = 'lobbyChatPlaceholder';
  ph.className = 'lobby-chat-placeholder muted';
  ph.textContent = 'No messages yet.';
  log.appendChild(ph);
}

function appendLobbyChatMessage(msg) {
  if (!msg || msg.type !== 'CHAT' || !ui.room.inRoom) return;
  const log = $('lobbyChatLog');
  if (!log) return;
  $('lobbyChatPlaceholder')?.remove();

  const cid = String(msg.clientId || '');
  const own = msg.clientId && ui.room.clientId && msg.clientId === ui.room.clientId;
  const prev = log.querySelector('.lobby-chat-row:last-child');
  const sameAuthor = !!(prev && cid && prev.dataset.chatClient === cid);

  const row = document.createElement('div');
  row.className = 'lobby-chat-row';
  row.dataset.chatClient = cid;
  if (own) row.classList.add('lobby-chat-row--self');
  if (sameAuthor) row.classList.add('lobby-chat-row--compact');

  const bubble = document.createElement('div');
  bubble.className = 'lobby-chat-bubble';

  if (sameAuthor) {
    const line = document.createElement('div');
    line.className = 'lobby-chat-compact-line';
    const body = document.createElement('div');
    body.className = 'lobby-chat-text';
    body.textContent = msg.text || '';
    const when = document.createElement('span');
    when.className = 'lobby-chat-when lobby-chat-when--inline';
    when.textContent = formatChatTime(msg.timestamp);
    line.append(body, when);
    bubble.appendChild(line);
    row.appendChild(bubble);
  } else {
    const tile = createLobbyOperativeEl({
      color: msg.color,
      clientId: msg.clientId,
      username: msg.username,
      size: 'sm'
    });
    const meta = document.createElement('div');
    meta.className = 'lobby-chat-meta';
    const who = document.createElement('span');
    who.className = 'lobby-chat-who';
    who.textContent = own ? 'You' : msg.username || 'Member';
    const when = document.createElement('span');
    when.className = 'lobby-chat-when';
    when.textContent = formatChatTime(msg.timestamp);
    meta.append(who, when);
    const body = document.createElement('div');
    body.className = 'lobby-chat-text';
    body.textContent = msg.text || '';
    bubble.append(meta, body);
    row.append(tile, bubble);
  }

  log.appendChild(row);

  while (log.querySelectorAll('.lobby-chat-row').length > 120) {
    log.querySelector('.lobby-chat-row')?.remove();
  }
  log.scrollTop = log.scrollHeight;
}

function syncLobbyChatRoomBoundary() {
  if (ui.room.inRoom) {
    lobbyChatWasInRoom = true;
    return;
  }
  if (lobbyChatWasInRoom) {
    lobbyChatWasInRoom = false;
    clearLobbyChat();
    clearLobbySuggestions();
  }
}

function suggestionMergeKey(media, tmdbId) {
  return `${media}:${tmdbId}`;
}

function clearLobbySuggestions() {
  lobbyRoomSuggestions = [];
  renderLobbySuggestions();
  syncCatalogSuggestButtons();
}

function applyLobbyTitleSuggestion(msg) {
  if (!msg || msg.type !== 'TITLE_SUGGEST' || !ui.room.inRoom) return;
  const media = msg.media === 'movie' || msg.media === 'tv' ? msg.media : null;
  if (!media) return;
  const tmdbId =
    typeof msg.tmdbId === 'number' && Number.isFinite(msg.tmdbId)
      ? msg.tmdbId
      : parseInt(String(msg.tmdbId || ''), 10);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return;
  const title = (msg.title || '').trim();
  if (!title) return;
  const key = suggestionMergeKey(media, tmdbId);
  const row = {
    key,
    title: title.slice(0, 200),
    media,
    tmdbId,
    overview: String(msg.overview || '').slice(0, 280),
    posterUrl: typeof msg.posterUrl === 'string' && msg.posterUrl.trim() ? msg.posterUrl.trim() : null,
    year: msg.year ? String(msg.year).replace(/[^\d]/g, '').slice(0, 4) : null,
    username: (msg.username || 'Someone').trim().slice(0, 48) || 'Someone',
    clientId: String(msg.clientId || ''),
    timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now()
  };
  const idx = lobbyRoomSuggestions.findIndex((r) => r.key === key);
  if (idx >= 0) {
    const [prev] = lobbyRoomSuggestions.splice(idx, 1);
    lobbyRoomSuggestions.unshift({ ...row, overview: row.overview || prev.overview });
  } else {
    lobbyRoomSuggestions.unshift(row);
  }
  while (lobbyRoomSuggestions.length > LOBBY_SUGGEST_MAX) {
    lobbyRoomSuggestions.pop();
  }
  renderLobbySuggestions();
  syncCatalogSuggestButtons();
}

function applyLobbyTitleRemoved(msg) {
  if (!msg || msg.type !== 'TITLE_SUGGEST_REMOVED' || !ui.room.inRoom) return;
  const media = msg.media === 'movie' || msg.media === 'tv' ? msg.media : null;
  if (!media) return;
  const t =
    typeof msg.tmdbId === 'number' && Number.isFinite(msg.tmdbId)
      ? msg.tmdbId
      : parseInt(String(msg.tmdbId || ''), 10);
  if (!Number.isFinite(t) || t <= 0) return;
  const key = suggestionMergeKey(media, t);
  lobbyRoomSuggestions = lobbyRoomSuggestions.filter((r) => r.key !== key);
  renderLobbySuggestions();
  syncCatalogSuggestButtons();
}

async function sendTitleSuggestionRemove(s) {
  if (!s || !ui.room.inRoom) return;
  const api = desktop();
  if (!api?.signalSend) return;
  const res = await api.signalSend({
    type: PlayShareSignalingClientType.TITLE_SUGGEST_REMOVE,
    media: s.media,
    tmdbId: s.tmdbId
  });
  if (!res.ok) {
    ui.lastError = res.error || 'Could not remove suggestion';
    render();
  }
}

function renderLobbySuggestions() {
  const wrap = $('lobbySuggestedWrap');
  const list = $('lobbySuggestedList');
  if (!wrap || !list) return;
  if (!ui.room.inRoom || lobbyRoomSuggestions.length === 0) {
    wrap.hidden = true;
    list.innerHTML = '';
    return;
  }
  wrap.hidden = false;
  list.innerHTML = '';
  for (const s of lobbyRoomSuggestions) {
    const card = document.createElement('article');
    card.className = 'lobby-suggest-card';
    card.setAttribute('role', 'listitem');
    const thumb = document.createElement('div');
    thumb.className = 'lobby-suggest-thumb';
    if (s.posterUrl) {
      const img = document.createElement('img');
      let src = s.posterUrl;
      if (src.includes('/w342/')) src = src.replace('/w342/', '/w92/');
      else if (src.includes('/w500/')) src = src.replace('/w500/', '/w92/');
      img.src = src;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.loading = 'lazy';
      img.addEventListener('error', () => img.remove());
      thumb.appendChild(img);
    }
    const info = document.createElement('div');
    info.className = 'lobby-suggest-info';
    const h = document.createElement('h4');
    h.className = 'lobby-suggest-title';
    h.textContent = s.title;
    const meta = document.createElement('p');
    meta.className = 'lobby-suggest-meta muted';
    const typeLabel = s.media === 'movie' ? 'Movie' : 'TV series';
    const y = s.year ? ` · ${s.year}` : '';
    meta.textContent = `${typeLabel}${y}`;
    const by = document.createElement('p');
    by.className = 'lobby-suggest-by muted';
    const self =
      s.clientId && ui.room.clientId && s.clientId === ui.room.clientId;
    by.textContent = self ? 'You suggested this' : `Suggested by ${s.username}`;
    info.append(h, meta, by);
    const canRemove =
      !!ui.room.isHost ||
      !!(s.clientId && ui.room.clientId && s.clientId === ui.room.clientId);
    if (canRemove) {
      const foot = document.createElement('div');
      foot.className = 'lobby-suggest-foot';
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'lobby-suggest-remove';
      rm.textContent = 'Remove';
      rm.addEventListener('click', (ev) => {
        ev.stopPropagation();
        sendTitleSuggestionRemove(s);
      });
      foot.appendChild(rm);
      info.appendChild(foot);
    }
    card.append(thumb, info);
    list.appendChild(card);
  }
}

async function sendTitleSuggestionFromRow(row) {
  if (!row || !ui.room.inRoom) return;
  const api = desktop();
  if (!api?.signalSend) return;
  const tmdbId = row.tmdbId;
  if (tmdbId == null || !Number.isFinite(Number(tmdbId))) return;
  const media = row.mediaType === 'movie' ? 'movie' : row.mediaType === 'tv' ? 'tv' : null;
  if (!media) return;
  const title = (row.title || '').trim().slice(0, 200);
  if (!title) return;
  const y = row.firstAirDate ? String(row.firstAirDate).slice(0, 4) : '';
  const res = await api.signalSend({
    type: PlayShareSignalingClientType.TITLE_SUGGEST,
    title,
    media,
    tmdbId: Number(tmdbId),
    overview: (row.overview || '').slice(0, 280),
    posterUrl: typeof row.posterUrl === 'string' ? row.posterUrl : undefined,
    year: y || undefined
  });
  if (!res.ok) {
    ui.lastError = res.error || 'Could not send suggestion';
    render();
    return;
  }
  applyLobbyTitleSuggestion({
    type: 'TITLE_SUGGEST',
    clientId: ui.room.clientId,
    username: ui.room.username || displayNameForRoom(),
    title,
    media,
    tmdbId: Number(tmdbId),
    overview: (row.overview || '').slice(0, 280),
    posterUrl: typeof row.posterUrl === 'string' ? row.posterUrl : null,
    year: y ? String(y).replace(/[^\d]/g, '').slice(0, 4) : null,
    timestamp: Date.now()
  });
}

function setLobbyChatComposerEnabled() {
  const on = ui.room.inRoom && ui.connected && !ui.connecting;
  const inp = $('inLobbyChat');
  const btn = $('btnLobbyChatSend');
  if (inp) inp.disabled = !on;
  if (btn) btn.disabled = !on;
}

async function sendLobbyChatMessage() {
  const input = $('inLobbyChat');
  if (!input || !ui.room.inRoom) return;
  const text = (input.value || '').trim().slice(0, 500);
  if (!text) return;
  const api = desktop();
  if (!api?.signalSend) return;
  input.value = '';
  const res = await api.signalSend({ type: PlayShareSignalingClientType.CHAT, text });
  if (!res.ok) {
    ui.lastError = res.error || 'Chat send failed';
    render();
  }
}

function setErrorLine() {
  const el = $('lastError');
  if (!el) return;
  if (ui.lastError) {
    el.textContent = ui.lastError;
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}

function updateDashboardChrome() {
  const greet = $('dashGreeting');
  const emailEl = $('dashEmail');
  const tagline = $('dashTagline');
  const signOut = $('btnSignOut');
  const line = $('dashConnLine');

  if (signOut) signOut.hidden = !authSession;

  if (authSession && greet && emailEl) {
    greet.textContent = `Hi, ${getUserDisplayName(authSession)}`;
    emailEl.textContent = authSession.user?.email || '';
  }

  if (tagline && authSession) {
    tagline.hidden = !!(ui.room.inRoom && roomNavSurface === 'dashboard');
  }

  if (line && authSession) {
    line.classList.remove('dash-status--ok', 'dash-status--warn', 'dash-status--off');
    if (ui.connecting) {
      line.textContent = 'Connecting to signaling…';
      line.classList.add('dash-status--warn');
    } else if (ui.connected) {
      if (ui.room.inRoom && roomNavSurface === 'dashboard') {
        line.textContent = 'Signaling online.';
      } else {
        line.textContent = 'Ready — create a room or join with a code.';
      }
      line.classList.add('dash-status--ok');
    } else {
      line.textContent =
        'Signaling offline. Check your network, then try Create or Join again.';
      line.classList.add('dash-status--off');
    }
  }
}

function setMainSurfaceVisibility(vDash, vRoom, inRoom) {
  if (!inRoom) {
    vDash.hidden = false;
    vRoom.hidden = true;
    return;
  }
  if (roomNavSurface === 'lobby') {
    vDash.hidden = true;
    vRoom.hidden = false;
  } else {
    vDash.hidden = false;
    vRoom.hidden = true;
  }
}

function syncInRoomChrome(inRoom, canRoom) {
  const shell = document.querySelector('.shell');
  if (inRoom) {
    shell?.classList.add('is-in-room');
    $('roomCodeDisplay').textContent = ui.room.roomCode || '------';
    $('hostBadge').hidden = !ui.room.isHost;
    renderMembers();
    syncWatchFields();
    updateHandoffButtons();
  } else {
    shell?.classList.remove('is-in-room');
  }
  const blockCreateJoin = !canRoom || inRoom;
  $('btnCreate').disabled = blockCreateJoin;
  $('btnJoin').disabled = blockCreateJoin;
  const nav = $('appSurfaceNav');
  const tDisc = $('tabSurfaceDiscover');
  const tRoom = $('tabSurfaceRoom');
  if (nav) nav.hidden = !inRoom;
  if (tRoom) {
    tRoom.classList.toggle('has-live-room', inRoom);
    if (inRoom) {
      const code = (ui.room.roomCode || '').trim() || '····';
      tRoom.setAttribute('title', `Room ${code} — chat and leave`);
    } else {
      tRoom.removeAttribute('title');
    }
  }
  if (!inRoom) {
    shell?.removeAttribute('data-surface');
    if (tDisc) {
      tDisc.classList.remove('is-active');
      tDisc.setAttribute('aria-selected', 'false');
    }
    if (tRoom) {
      tRoom.classList.remove('is-active');
      tRoom.setAttribute('aria-selected', 'false');
    }
  } else {
    const onDiscover = roomNavSurface === 'dashboard';
    shell?.setAttribute('data-surface', onDiscover ? 'discover' : 'room');
    if (tDisc) {
      tDisc.classList.toggle('is-active', onDiscover);
      tDisc.setAttribute('aria-selected', onDiscover ? 'true' : 'false');
    }
    if (tRoom) {
      tRoom.classList.toggle('is-active', !onDiscover);
      tRoom.setAttribute('aria-selected', !onDiscover ? 'true' : 'false');
    }
  }
  const sub = $('surfaceRoomSubline');
  if (sub) {
    if (inRoom) {
      sub.textContent = (ui.room.roomCode || '····').toUpperCase();
      sub.classList.add('surface-room-code');
    } else {
      sub.textContent = 'Create or join a room';
      sub.classList.remove('surface-room-code');
    }
  }
}

function renderViews() {
  const vAuth = $('viewAuth');
  const vDash = $('viewDashboard');
  const vRoom = $('viewRoom');
  const shell = document.querySelector('.shell');
  if (!vAuth || !vDash || !vRoom) return;

  const loggedIn = !!authSession;
  const inRoom = ui.room.inRoom;
  const canRoom = ui.connected && !ui.connecting;

  if (!loggedIn) {
    clearAuthDashTransition();
    vAuth.classList.remove('view-auth-exit');
    vDash.classList.remove('view-dash-enter', 'view-dash-enter-ready');
    vAuth.hidden = false;
    vDash.hidden = true;
    vRoom.hidden = true;
    shell?.classList.remove('is-in-room');
    const navOut = $('appSurfaceNav');
    if (navOut) navOut.hidden = true;
    document.querySelector('.shell')?.removeAttribute('data-surface');
    previousAuthPresent = false;
    return;
  }

  if (vAuth.classList.contains('view-auth-exit')) {
    setMainSurfaceVisibility(vDash, vRoom, inRoom);
    syncInRoomChrome(inRoom, canRoom);
    previousAuthPresent = true;
    return;
  }

  const justLoggedIn = !previousAuthPresent;
  if (justLoggedIn) {
    previousAuthPresent = true;

    if (prefersReducedMotion() || inRoom) {
      clearAuthDashTransition();
      vAuth.classList.remove('view-auth-exit');
      vDash.classList.remove('view-dash-enter', 'view-dash-enter-ready');
      vAuth.hidden = true;
      setMainSurfaceVisibility(vDash, vRoom, inRoom);
      syncInRoomChrome(inRoom, canRoom);
      return;
    }

    clearAuthDashTransition();
    vRoom.hidden = true;
    shell?.classList.remove('is-in-room');
    vDash.hidden = false;
    vDash.classList.remove('view-dash-enter', 'view-dash-enter-ready');
    vAuth.hidden = false;
    vAuth.classList.add('view-auth-exit');
    void vDash.offsetWidth;
    vDash.classList.add('view-dash-enter');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        vDash.classList.add('view-dash-enter-ready');
      });
    });
    $('btnCreate').disabled = !canRoom;
    $('btnJoin').disabled = !canRoom;
    const navAnim = $('appSurfaceNav');
    if (navAnim) navAnim.hidden = true;

    authDashTransitionTimer = window.setTimeout(() => {
      authDashTransitionTimer = null;
      vAuth.hidden = true;
      vAuth.classList.remove('view-auth-exit');
      vDash.classList.remove('view-dash-enter', 'view-dash-enter-ready');
      render();
    }, AUTH_TO_DASH_MS);
    return;
  }

  vAuth.hidden = true;
  vAuth.classList.remove('view-auth-exit');
  vDash.classList.remove('view-dash-enter', 'view-dash-enter-ready');

  setMainSurfaceVisibility(vDash, vRoom, inRoom);
  syncInRoomChrome(inRoom, canRoom);
  previousAuthPresent = true;
}

function renderMembers() {
  const squad = $('lobbySquad');
  const meta = $('lobbySquadMeta');
  const members = Array.isArray(ui.room.members) ? ui.room.members : [];
  const n = members.length;

  if (meta) {
    if (n === 0) {
      meta.textContent = 'Waiting for people to join…';
    } else if (n === 1) {
      meta.textContent = 'Only you so far — invite friends with the code above.';
    } else {
      meta.textContent = `${n} people in this room`;
    }
  }

  if (!squad) return;

  squad.innerHTML = '';
  squad.setAttribute('role', 'list');

  if (n === 0) {
    squad.className = 'lobby-squad lobby-squad--holo lobby-squad--empty';
    const empty = document.createElement('p');
    empty.className = 'lobby-squad-empty muted';
    empty.textContent = 'When someone joins, they’ll appear here.';
    squad.appendChild(empty);
    return;
  }

  squad.className = 'lobby-squad lobby-squad--holo';

  members.forEach((m, i) => {
    const item = document.createElement('div');
    item.className = 'lobby-float';
    item.setAttribute('role', 'listitem');
    item.style.setProperty('--float-phase', `${((i * 0.41) % 1).toFixed(2)}s`);

    const inner = document.createElement('div');
    inner.className = 'lobby-float-inner';

    const tile = createLobbyOperativeEl({
      color: m.color,
      clientId: m.clientId,
      username: m.username,
      size: 'lg'
    });

    const cap = document.createElement('div');
    cap.className = 'lobby-float-cap';

    const label = document.createElement('span');
    label.className = 'lobby-float-name';
    label.textContent = m.username || '—';

    cap.appendChild(label);
    if (m.isHost) {
      const host = document.createElement('span');
      host.className = 'lobby-float-host';
      host.textContent = 'Host';
      cap.appendChild(host);
    }

    inner.append(tile, cap);
    item.appendChild(inner);
    squad.appendChild(item);
  });
}

function syncWatchFields() {
  $('selProvider').value = ui.watch.providerKey || '';
  $('inTitleNote').value = ui.watch.titleNote || '';
  $('inWatchUrl').value = ui.watch.watchUrl || '';
}

function updateHandoffButtons() {
  const hasRoom = ui.room.inRoom && ui.room.roomCode;
  const hasWatch = ($('inWatchUrl').value || '').trim().length > 0;
  $('btnCopyDeep').disabled = !hasRoom || !hasWatch;
  $('btnOpenWatch').disabled = !hasWatch;
  $('btnAnnounce').disabled = !hasRoom || !desktop()?.signalSend;
}

function catalogHttpBase() {
  const w = (ui.wsUrl || getWsUrl() || '').trim();
  if (!w) return '';
  try {
    const u = new URL(w);
    u.protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
    u.pathname = '';
    u.search = '';
    u.hash = '';
    return u.origin;
  } catch {
    return '';
  }
}

function buildEditorialSpotlightCard(item) {
  const art = document.createElement('article');
  art.className = `spotlight-card spotlight-card--${item.providerKey}`;
  art.setAttribute('role', 'listitem');

  const vis = document.createElement('div');
  vis.className = 'spotlight-card-visual';
  vis.setAttribute('aria-hidden', 'true');

  const body = document.createElement('div');
  body.className = 'spotlight-card-body';

  const svc = document.createElement('span');
  svc.className = 'spotlight-service';
  svc.textContent = item.service;

  const h = document.createElement('h4');
  h.className = 'spotlight-show';
  h.textContent = item.title;

  const kind = document.createElement('p');
  kind.className = 'spotlight-kind';
  kind.textContent = item.kind;

  const tag = document.createElement('p');
  tag.className = 'spotlight-tagline';
  tag.textContent = item.tagline;

  body.append(svc, h, kind, tag);
  art.append(vis, body);
  return art;
}

/** @param {{ title?: string, overview?: string, posterUrl?: string | null, mediaType?: string, voteAverage?: number | null, firstAirDate?: string | null }} row */
function buildTmdbSpotlightCard(row, opts) {
  const featured = !!(opts && opts.featured);
  const art = document.createElement('article');
  art.className = featured
    ? 'spotlight-card spotlight-card--tmdb spotlight-card--feature'
    : 'spotlight-card spotlight-card--tmdb';
  art.setAttribute('role', 'listitem');

  const vis = document.createElement('div');
  vis.className = 'spotlight-card-visual';
  if (row.posterUrl) {
    const img = document.createElement('img');
    img.className = 'spotlight-poster';
    const hi =
      featured && typeof row.posterUrl === 'string' && row.posterUrl.includes('/w342/')
        ? row.posterUrl.replace('/w342/', '/w500/')
        : row.posterUrl;
    img.src = hi;
    const t = (row.title || '').trim();
    img.alt = t ? `Poster: ${t}` : 'Title poster';
    img.loading = featured ? 'eager' : 'lazy';
    img.fetchPriority = featured ? 'high' : 'low';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      img.remove();
    });
    vis.appendChild(img);
  }

  const body = document.createElement('div');
  body.className = 'spotlight-card-body';

  const svc = document.createElement('span');
  svc.className = 'spotlight-service';
  svc.textContent = featured ? 'Top pick · TMDB' : 'Trending · TMDB';

  const h = document.createElement('h4');
  h.className = 'spotlight-show';
  h.textContent = row.title || '—';

  const kind = document.createElement('p');
  kind.className = 'spotlight-kind';
  const bits = [row.mediaType === 'movie' ? 'Movie' : 'Series'];
  if (row.firstAirDate) bits.push(row.firstAirDate.slice(0, 4));
  if (typeof row.voteAverage === 'number' && row.voteAverage > 0)
    bits.push(`★ ${row.voteAverage.toFixed(1)}`);
  kind.textContent = bits.filter(Boolean).join(' · ');

  const tag = document.createElement('p');
  tag.className = 'spotlight-tagline';
  tag.textContent = row.overview || '';

  const actions = document.createElement('div');
  actions.className = 'spotlight-card-actions';
  const suggestBtn = document.createElement('button');
  suggestBtn.type = 'button';
  suggestBtn.className = 'catalog-suggest-to-room';
  suggestBtn.textContent = 'Suggest to room';
  const mediaKey = row.mediaType === 'movie' ? 'movie' : row.mediaType === 'tv' ? 'tv' : '';
  const tid =
    row.tmdbId != null && Number.isFinite(Number(row.tmdbId)) ? Number(row.tmdbId) : null;
  if (mediaKey && tid) {
    suggestBtn.dataset.suggestKey = suggestionMergeKey(mediaKey, tid);
  }
  suggestBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    sendTitleSuggestionFromRow(row);
  });
  actions.appendChild(suggestBtn);
  body.append(svc, h, kind, tag, actions);
  art.append(vis, body);
  return art;
}

function setSpotlightCatalogChrome(hasLiveCatalog) {
  const sec = $('spotlightSection');
  const pill = $('spotlightCatalogPill');
  const tb = $('catalogToolbar');
  if (sec) sec.classList.toggle('spotlight--live-catalog', !!hasLiveCatalog);
  if (pill) pill.hidden = !hasLiveCatalog;
  if (tb) tb.hidden = !hasLiveCatalog;
  if (hasLiveCatalog) {
    hydrateGenreChipsIfNeeded();
  } else {
    catalogGenresHydratedForBase = null;
    catalogGenreHydrateLock = null;
    catalogGenreData = { tv: [], movie: [] };
    catalogLastGenrePick = null;
    const gHost = $('genreChipsActive');
    if (gHost) gHost.innerHTML = '';
    const tTv = $('tabGenreTv');
    const tMv = $('tabGenreMovie');
    tTv?.classList.add('is-active');
    tMv?.classList.remove('is-active');
    tTv?.setAttribute('aria-selected', 'true');
    tMv?.setAttribute('aria-selected', 'false');
    catalogUiMode = 'trending';
    const h = $('spotlight-heading');
    if (h) h.textContent = spotlightTrendingHeading('tv');
    const resetBtn = $('btnCatalogReset');
    if (resetBtn) resetBtn.hidden = true;
    const inp = $('inCatalogSearch');
    if (inp) inp.value = '';
    document.querySelectorAll('.catalog-genre-chip--active').forEach((el) => el.classList.remove('catalog-genre-chip--active'));
  }
}

function dedupeGenres(genres) {
  const seen = new Set();
  const out = [];
  for (const g of genres) {
    if (!g || typeof g.id !== 'number') continue;
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    out.push({ id: g.id, name: String(g.name || '').trim() || '—' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function hydrateGenreChipsIfNeeded() {
  const base = catalogHttpBase();
  const host = $('genreChipsActive');
  if (!base || !host) return;
  if (catalogGenresHydratedForBase === base) return;
  if (catalogGenreHydrateLock === base) return;
  catalogGenreHydrateLock = base;
  host.innerHTML = '';
  catalogGenreData = { tv: [], movie: [] };

  Promise.all([fetch(`${base}/api/catalog/genres?media=tv`), fetch(`${base}/api/catalog/genres?media=movie`)])
    .then(([rt, rm]) => Promise.all([rt.json(), rm.json()]))
    .then(([jt, jm]) => {
      if (catalogGenreHydrateLock !== base) return;
      catalogGenreData.tv = jt.ok && Array.isArray(jt.genres) ? dedupeGenres(jt.genres) : [];
      catalogGenreData.movie = jm.ok && Array.isArray(jm.genres) ? dedupeGenres(jm.genres) : [];
      catalogGenresHydratedForBase = base;
      catalogGenreHydrateLock = null;
      const movieTab = $('tabGenreMovie')?.classList.contains('is-active');
      renderGenreChipsForTab(movieTab ? 'movie' : 'tv');
    })
    .catch(() => {
      if (catalogGenreHydrateLock === base) catalogGenreHydrateLock = null;
      catalogGenresHydratedForBase = null;
    });
}

function renderGenreChipsForTab(media) {
  const host = $('genreChipsActive');
  if (!host) return;
  const m = media === 'movie' ? 'movie' : 'tv';
  host.innerHTML = '';
  host.setAttribute('aria-label', m === 'movie' ? 'Movie genres' : 'TV genres');
  const list = catalogGenreData[m] || [];
  for (const g of list) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'catalog-genre-chip';
    btn.dataset.media = m;
    btn.dataset.genreId = String(g.id);
    btn.textContent = g.name;
    if (catalogLastGenrePick && catalogLastGenrePick.media === m && catalogLastGenrePick.id === g.id) {
      btn.classList.add('catalog-genre-chip--active');
    }
    btn.addEventListener('click', () => onCatalogGenrePick(m, g.id, g.name, btn));
    host.appendChild(btn);
  }
}

function onCatalogBrowseTabChange(media) {
  const m = media === 'movie' ? 'movie' : 'tv';
  if (catalogUiMode === 'search') return;
  if (catalogUiMode === 'trending') {
    reloadTrendingSpotlight().catch(() => {});
    return;
  }
  if (!catalogLastGenrePick) {
    catalogUiMode = 'trending';
    reloadTrendingSpotlight().catch(() => {});
    return;
  }
  if (catalogLastGenrePick.media === m) return;
  const name = (catalogLastGenrePick.name || '').trim().toLowerCase();
  const list = catalogGenreData[m] || [];
  const match = list.find((g) => (g.name || '').trim().toLowerCase() === name);
  if (match) {
    catalogLastGenrePick = { media: m, id: match.id, name: match.name };
    runCatalogDiscover(m, match.id, match.name);
    return;
  }
  document.querySelectorAll('.catalog-genre-chip--active').forEach((el) => el.classList.remove('catalog-genre-chip--active'));
  catalogLastGenrePick = null;
  catalogUiMode = 'trending';
  reloadTrendingSpotlight().catch(() => {});
}

function wireGenreTabs() {
  const tv = $('tabGenreTv');
  const mv = $('tabGenreMovie');
  const apply = (med) => {
    const m = med === 'tv' ? 'tv' : 'movie';
    const isTv = m === 'tv';
    if (isTv && tv?.classList.contains('is-active')) return;
    if (!isTv && mv?.classList.contains('is-active')) return;
    tv?.classList.toggle('is-active', isTv);
    mv?.classList.toggle('is-active', !isTv);
    tv?.setAttribute('aria-selected', isTv ? 'true' : 'false');
    mv?.setAttribute('aria-selected', isTv ? 'false' : 'true');
    onCatalogBrowseTabChange(m);
    renderGenreChipsForTab(m);
  };
  tv?.addEventListener('click', () => apply('tv'));
  mv?.addEventListener('click', () => apply('movie'));
}

function onCatalogGenrePick(media, genreId, genreName, btn) {
  const same =
    catalogUiMode === 'genre' &&
    catalogLastGenrePick &&
    catalogLastGenrePick.media === media &&
    catalogLastGenrePick.id === genreId;
  if (same) {
    reloadTrendingSpotlight().catch(() => {});
    return;
  }
  document.querySelectorAll('.catalog-genre-chip--active').forEach((el) => el.classList.remove('catalog-genre-chip--active'));
  btn.classList.add('catalog-genre-chip--active');
  catalogLastGenrePick = { media, id: genreId, name: genreName };
  const inp = $('inCatalogSearch');
  if (inp) inp.value = '';
  catalogUiMode = 'genre';
  runCatalogDiscover(media, genreId, genreName);
}

function renderCatalogResults(grid, foot, j, footNote) {
  const attr = j.attribution ? `${j.attribution} ` : '';
  if (j.ok && Array.isArray(j.results) && j.results.length > 0) {
    grid.className = 'spotlight-grid spotlight-grid--catalog';
    grid.innerHTML = '';
    j.results.forEach((row, i) => {
      grid.appendChild(buildTmdbSpotlightCard(row, { featured: i === 0 }));
    });
    foot.textContent = (footNote && footNote.trim()) ? `${attr}${footNote}`.trim() : attr.trim();
    syncCatalogSuggestButtons();
    return;
  }
  grid.className = 'spotlight-grid spotlight-grid--catalog';
  grid.innerHTML =
    '<p class="catalog-empty muted" role="status">No matches. Try different words or pick a category.</p>';
  foot.textContent = `${attr}${footNote || ''}`.trim();
}

async function runCatalogDiscover(media, genreId, genreName) {
  const base = catalogHttpBase();
  const grid = $('spotlightGrid');
  const foot = $('spotlightFoot');
  if (!base || !grid || !foot) return;
  const label = media === 'movie' ? 'Movies' : 'TV';
  const heading = $('spotlight-heading');
  if (heading) heading.textContent = `${label} · ${genreName}`;
  const resetBtn = $('btnCatalogReset');
  if (resetBtn) resetBtn.hidden = false;
  renderSpotlightSkeleton(grid);
  foot.textContent = `Loading ${genreName}…`;
  try {
    const r = await fetch(
      `${base}/api/catalog/discover?media=${encodeURIComponent(media)}&genre=${encodeURIComponent(String(genreId))}`
    );
    const j = await r.json();
    renderCatalogResults(grid, foot, j, 'Streaming availability varies by region.');
  } catch {
    grid.className = 'spotlight-grid spotlight-grid--catalog';
    grid.innerHTML =
      '<p class="catalog-empty muted" role="alert">Couldn’t load this category. Try again.</p>';
  }
}

async function runCatalogSearch() {
  const base = catalogHttpBase();
  const q = ($('inCatalogSearch')?.value || '').trim();
  const grid = $('spotlightGrid');
  const foot = $('spotlightFoot');
  if (!base || !grid || !foot) return;
  if (q.length < 1) return;
  document.querySelectorAll('.catalog-genre-chip--active').forEach((el) => el.classList.remove('catalog-genre-chip--active'));
  catalogLastGenrePick = null;
  catalogUiMode = 'search';
  const shortQ = q.length > 42 ? `${q.slice(0, 42)}…` : q;
  const heading = $('spotlight-heading');
  if (heading) heading.textContent = `Results for “${shortQ}”`;
  const resetBtn = $('btnCatalogReset');
  if (resetBtn) resetBtn.hidden = false;
  renderSpotlightSkeleton(grid);
  foot.textContent = 'Searching…';
  try {
    const r = await fetch(`${base}/api/catalog/search?q=${encodeURIComponent(q)}`);
    const j = await r.json();
    renderCatalogResults(grid, foot, j, 'Streaming availability varies by region.');
  } catch {
    grid.className = 'spotlight-grid spotlight-grid--catalog';
    grid.innerHTML =
      '<p class="catalog-empty muted" role="alert">Search failed. Check your connection.</p>';
  }
}

async function reloadTrendingSpotlight() {
  const base = catalogHttpBase();
  const grid = $('spotlightGrid');
  const foot = $('spotlightFoot');
  if (!base || !grid || !foot) return;
  const media = catalogActiveBrowseMedia();
  catalogUiMode = 'trending';
  const h = $('spotlight-heading');
  if (h) h.textContent = spotlightTrendingHeading(media);
  const rb = $('btnCatalogReset');
  if (rb) rb.hidden = true;
  const inp = $('inCatalogSearch');
  if (inp) inp.value = '';
  document.querySelectorAll('.catalog-genre-chip--active').forEach((el) => el.classList.remove('catalog-genre-chip--active'));
  catalogLastGenrePick = null;
  renderSpotlightSkeleton(grid);
  foot.textContent = media === 'movie' ? 'Loading trending movies…' : 'Loading trending TV…';
  try {
    const r = await fetch(`${base}/api/catalog/spotlight?media=${encodeURIComponent(media)}`);
    const j = await r.json();
    if (j.ok && Array.isArray(j.results) && j.results.length > 0) {
      grid.className = 'spotlight-grid spotlight-grid--catalog';
      grid.innerHTML = '';
      j.results.forEach((row, i) => {
        grid.appendChild(buildTmdbSpotlightCard(row, { featured: i === 0 }));
      });
      foot.textContent = `${j.attribution} Streaming availability varies by region—open titles in your own app.`;
      const catalogKey = `${base}|${authSession?.user?.id || '__anon__'}`;
      spotlightTmdbSuccessKey = `${catalogKey}|trending:${media}`;
      syncCatalogSuggestButtons();
    } else {
      foot.textContent = 'Could not refresh trending.';
    }
  } catch {
    grid.innerHTML = '<p class="catalog-empty muted">Could not refresh trending.</p>';
  }
}

function wireCatalogBrowse() {
  wireGenreTabs();
  $('btnCatalogSearch')?.addEventListener('click', () => runCatalogSearch());
  $('inCatalogSearch')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      runCatalogSearch();
    }
  });
  let debounceSearch = null;
  $('inCatalogSearch')?.addEventListener('input', () => {
    window.clearTimeout(debounceSearch);
    debounceSearch = window.setTimeout(() => {
      const q = ($('inCatalogSearch')?.value || '').trim();
      if (q.length >= 3) runCatalogSearch();
    }, 500);
  });
  $('btnCatalogReset')?.addEventListener('click', () => reloadTrendingSpotlight().catch(() => {}));
}

function renderSpotlightSkeleton(grid) {
  grid.className = 'spotlight-grid spotlight-grid--loading';
  grid.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const sk = document.createElement('div');
    sk.className = 'spotlight-skel';
    sk.setAttribute('aria-hidden', 'true');
    const v = document.createElement('div');
    v.className = 'spotlight-skel-visual';
    const b = document.createElement('div');
    b.className = 'spotlight-skel-body';
    for (let j = 0; j < 3; j++) {
      const ln = document.createElement('div');
      ln.className =
        j === 0 ? 'spotlight-skel-line spotlight-skel-line--short' : j === 1 ? 'spotlight-skel-line' : 'spotlight-skel-line spotlight-skel-line--med';
      b.appendChild(ln);
    }
    sk.append(v, b);
    grid.appendChild(sk);
  }
}

function renderEditorialSpotlight(grid, foot) {
  setSpotlightCatalogChrome(false);
  grid.className = 'spotlight-grid spotlight-grid--editorial';
  grid.innerHTML = '';
  for (const item of SPOTLIGHT_PICKS) {
    grid.appendChild(buildEditorialSpotlightCard(item));
  }
  foot.textContent =
    'Illustration-style cards when the catalog isn’t available · Not affiliated with Netflix, Disney, Prime Video, or other listed services.';
}

async function ensureSpotlight() {
  const grid = $('spotlightGrid');
  const foot = $('spotlightFoot');
  if (!grid || !foot) return;

  const base = catalogHttpBase();
  const sessionKey = authSession?.user?.id || '__anon__';
  const catalogKey = `${base}|${sessionKey}`;

  const wantMedia = catalogActiveBrowseMedia();
  const trendingKey = `${catalogKey}|trending:${wantMedia}`;
  if (
    catalogUiMode === 'trending' &&
    spotlightTmdbSuccessKey === trendingKey &&
    grid.querySelector('.spotlight-card--tmdb')
  ) {
    return;
  }

  if (!base) {
    renderEditorialSpotlight(grid, foot);
    return;
  }

  const now = Date.now();
  const hasTmdb = !!grid.querySelector('.spotlight-card--tmdb');
  const cool = !spotlightCatalogForceRefresh && now - spotlightLastCatalogFetchAt < SPOTLIGHT_CATALOG_COOLDOWN_MS;
  if (grid.childElementCount > 0 && !hasTmdb && cool) {
    return;
  }
  spotlightCatalogForceRefresh = false;
  spotlightLastCatalogFetchAt = now;

  renderSpotlightSkeleton(grid);
  foot.textContent = wantMedia === 'movie' ? 'Loading trending movies…' : 'Loading trending TV…';

  try {
    const ctrl = new AbortController();
    const tid = window.setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(
      `${base}/api/catalog/spotlight?media=${encodeURIComponent(wantMedia)}`,
      { signal: ctrl.signal }
    );
    window.clearTimeout(tid);
    const j = await r.json();
    if (j.ok && Array.isArray(j.results) && j.results.length > 0) {
      grid.className = 'spotlight-grid spotlight-grid--catalog';
      grid.innerHTML = '';
      j.results.forEach((row, i) => {
        grid.appendChild(buildTmdbSpotlightCard(row, { featured: i === 0 }));
      });
      foot.textContent = `${j.attribution} Streaming availability varies by region—open titles in your own app.`;
      spotlightTmdbSuccessKey = trendingKey;
      catalogUiMode = 'trending';
      setSpotlightCatalogChrome(true);
      syncCatalogSuggestButtons();
      const h0 = $('spotlight-heading');
      if (h0) h0.textContent = spotlightTrendingHeading(wantMedia);
      const rb0 = $('btnCatalogReset');
      if (rb0) rb0.hidden = true;
      return;
    }
  } catch {
    /* editorial fallback */
  }

  renderEditorialSpotlight(grid, foot);
}

function syncCatalogSuggestButtons() {
  const baseOn = !!ui.room.inRoom && ui.connected && !ui.connecting && !!desktop()?.signalSend;
  const suggestedKeys = new Set(lobbyRoomSuggestions.map((s) => s.key));
  document.querySelectorAll('.catalog-suggest-to-room').forEach((btn) => {
    const key = btn.dataset.suggestKey || '';
    const already = !!key && suggestedKeys.has(key);
    btn.classList.toggle('catalog-suggest-to-room--done', already);
    if (already) {
      btn.disabled = true;
      btn.textContent = 'Suggested to room';
      btn.setAttribute('aria-label', 'This title is already in the lobby suggestions list');
    } else {
      btn.removeAttribute('aria-label');
      btn.textContent = 'Suggest to room';
      btn.disabled = !baseOn;
    }
  });
}

function render() {
  setErrorLine();
  updateDashboardChrome();
  renderViews();
  syncLobbyChatRoomBoundary();
  setLobbyChatComposerEnabled();
  renderLobbySuggestions();
  syncCatalogSuggestButtons();
  const dash = $('viewDashboard');
  if (authSession && dash && !dash.hidden) {
    ensureSpotlight().catch(() => {});
  }
}

async function hydrate() {
  const api = desktop();
  if (!api?.signalGetState) return;
  try {
    const s = await api.signalGetState();
    mergeStatus(s);
    render();
  } catch (_) {
    /* ignore */
  }
}

function setAuthMode(tab) {
  const isSignIn = tab === 'signin';
  const fIn = $('formSignIn');
  const fUp = $('formSignUp');
  if (fIn) {
    fIn.classList.toggle('auth-form-active', isSignIn);
    fIn.setAttribute('aria-hidden', isSignIn ? 'false' : 'true');
  }
  if (fUp) {
    fUp.classList.toggle('auth-form-active', !isSignIn);
    fUp.setAttribute('aria-hidden', isSignIn ? 'true' : 'false');
  }
  document.querySelectorAll('[data-auth-tab]').forEach((b) => {
    const on = b.getAttribute('data-auth-tab') === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  setAuthHint('');
}

function wireAuthTabs() {
  document.querySelectorAll('[data-auth-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.getAttribute('data-auth-tab');
      if (t === 'signin' || t === 'signup') setAuthMode(t);
    });
  });
}

async function initAuth() {
  supabaseClient = createClient(PLAYSUP_SHARE_SUPABASE_URL, PLAYSUP_SHARE_SUPABASE_ANON_KEY);
  const { data: { session } } = await supabaseClient.auth.getSession();
  authSession = session;
  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    authSession = session;
    if (event === 'SIGNED_OUT') {
      roomNavSurface = 'lobby';
      spotlightTmdbSuccessKey = null;
      spotlightLastCatalogFetchAt = 0;
      catalogUiMode = 'trending';
      catalogGenresHydratedForBase = null;
      catalogGenreHydrateLock = null;
      catalogGenreData = { tv: [], movie: [] };
      catalogLastGenrePick = null;
      const g = $('spotlightGrid');
      if (g) g.innerHTML = '';
      const foot = $('spotlightFoot');
      if (foot) foot.textContent = '';
      const hOut = $('spotlight-heading');
      if (hOut) hOut.textContent = SPOTLIGHT_TITLE_DEFAULT;
      setSpotlightCatalogChrome(false);
    }
    if (event === 'SIGNED_IN' && session) {
      await hydrate();
      const api = desktop();
      if (api?.signalConnect && !ui.connected && !ui.connecting) {
        ui.lastError = null;
        const res = await api.signalConnect({ wsUrl: getWsUrl() });
        if (!res.ok) ui.lastError = res.error || 'Connect failed';
      }
    }
    render();
  });
}

function wireAuthForms() {
  $('formSignIn')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!supabaseClient) return;
    setAuthHint('');
    ui.lastError = null;
    const email = ($('inSignInEmail').value || '').trim();
    const password = $('inSignInPassword').value || '';
    try {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
      authSession = data.session;
      if (!authSession) {
        const { data: snap } = await supabaseClient.auth.getSession();
        authSession = snap.session;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setAuthHint(msg);
    }
    render();
  });

  $('formSignUp')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!supabaseClient) return;
    setAuthHint('');
    ui.lastError = null;
    const email = ($('inSignUpEmail').value || '').trim();
    const password = $('inSignUpPassword').value || '';
    const displayName = ($('inSignUpName').value || '').trim() || email.split('@')[0];
    try {
      const { data, error } = await supabaseClient.auth.signUp({
        email,
        password,
        options: { data: { display_name: displayName.slice(0, 24) } }
      });
      if (error) throw error;
      if (data.user && !data.session) {
        setAuthHint('Check your email to confirm your account, then sign in.');
      } else if (data.session) {
        authSession = data.session;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setAuthHint(msg);
    }
    render();
  });

  $('btnSignOut')?.addEventListener('click', async () => {
    setAuthHint('');
    if (supabaseClient) await supabaseClient.auth.signOut();
    const api = desktop();
    if (api?.signalDisconnect) await api.signalDisconnect();
    await hydrate();
    render();
  });
}

function wireRoomActions() {
  const api = desktop();
  if (!api?.signalConnect) {
    $('lastError').textContent = 'Preload bridge missing. Run the app with Electron.';
    $('lastError').hidden = false;
    return;
  }

  window.addEventListener('playshare-signal-status', (ev) => {
    mergeStatus(ev.detail);
    if (ev.detail?.connected && ev.detail?.wsUrl) {
      try {
        localStorage.setItem(DESKTOP_WSS_STORAGE_KEY, ev.detail.wsUrl);
      } catch (_) {
        /* ignore */
      }
    }
    if (ev.detail?.connected) {
      const g = $('spotlightGrid');
      if (g && !g.querySelector('.spotlight-card--tmdb')) {
        spotlightCatalogForceRefresh = true;
        spotlightLastCatalogFetchAt = 0;
      }
    }
    render();
  });

  window.addEventListener('playshare-signal-frame', (ev) => {
    const msg = ev.detail;
    if (msg && msg.type === 'ERROR') {
      ui.lastError = msg.message || msg.code || 'Server error';
      render();
    } else if (msg && msg.type === 'CHAT') {
      appendLobbyChatMessage(msg);
      setLobbyChatComposerEnabled();
    } else if (msg && msg.type === 'TITLE_SUGGEST') {
      applyLobbyTitleSuggestion(msg);
    } else if (msg && msg.type === 'TITLE_SUGGEST_REMOVED') {
      applyLobbyTitleRemoved(msg);
    }
  });

  $('btnCreate')?.addEventListener('click', async () => {
    const name = displayNameForRoom();
    const res = await api.signalSend({
      type: PlayShareSignalingClientType.CREATE_ROOM,
      username: name || 'Host'
    });
    if (!res.ok) ui.lastError = res.error || 'Create failed';
    render();
  });

  $('btnJoin')?.addEventListener('click', async () => {
    const code = ($('inJoinCode').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!code) {
      ui.lastError = 'Enter a room code';
      render();
      return;
    }
    const name = displayNameForRoom() || 'Viewer';
    const res = await api.signalSend({
      type: PlayShareSignalingClientType.JOIN_ROOM,
      roomCode: code,
      username: name,
      rejoinAfterDrop: true
    });
    if (!res.ok) ui.lastError = res.error || 'Join failed';
    render();
  });

  $('tabSurfaceDiscover')?.addEventListener('click', () => {
    if (!ui.room.inRoom) return;
    roomNavSurface = 'dashboard';
    render();
  });
  $('tabSurfaceRoom')?.addEventListener('click', () => {
    if (!ui.room.inRoom) return;
    roomNavSurface = 'lobby';
    render();
  });

  $('btnLeaveRoom')?.addEventListener('click', async () => {
    await api.signalLeaveRoom();
    await hydrate();
  });

  $('btnSaveWatch')?.addEventListener('click', async () => {
    const meta = {
      providerKey: $('selProvider').value,
      titleNote: ($('inTitleNote').value || '').trim(),
      watchUrl: ($('inWatchUrl').value || '').trim()
    };
    await api.sessionSetWatch(meta);
    mergeStatus({ watch: meta });
    updateHandoffButtons();
  });

  ['inWatchUrl', 'inJoinCode', 'inTitleNote', 'selProvider'].forEach((id) => {
    $(id)?.addEventListener('input', () => updateHandoffButtons());
  });

  $('btnCopyDeep')?.addEventListener('click', async () => {
    const ws = ui.wsUrl || getWsUrl();
    const watchUrl = ($('inWatchUrl').value || '').trim();
    const deep = buildWatchDeepLink(watchUrl, ui.room.roomCode, ws);
    if (!deep) {
      ui.lastError = 'Need a valid https watch URL and room';
      render();
      return;
    }
    try {
      await navigator.clipboard.writeText(deep);
      ui.lastError = null;
    } catch {
      ui.lastError = 'Clipboard blocked — copy manually from console';
      console.info('[PlayShare deep link]', deep);
    }
    render();
  });

  $('btnOpenWatch')?.addEventListener('click', async () => {
    const u = ($('inWatchUrl').value || '').trim();
    const r = await api.openExternal({ url: u });
    if (!r.ok) ui.lastError = r.error || 'Open failed';
    render();
  });

  $('btnAnnounce')?.addEventListener('click', async () => {
    const prov = $('selProvider').selectedOptions[0]?.text || 'Watch';
    const note = ($('inTitleNote').value || '').trim();
    const text = note ? `📺 Now watching (${prov}): ${note}` : `📺 Now watching: ${prov}`;
    const res = await api.signalSend({ type: PlayShareSignalingClientType.CHAT, text });
    if (!res.ok) ui.lastError = res.error || 'Chat send failed';
    render();
  });

  $('btnLobbyChatSend')?.addEventListener('click', () => {
    sendLobbyChatMessage();
  });
  $('inLobbyChat')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendLobbyChatMessage();
    }
  });
}

async function tryAutoConnect() {
  if (autoConnectAttempted) return;
  autoConnectAttempted = true;
  const api = desktop();
  if (!api?.signalConnect) return;
  if (ui.connected || ui.connecting) return;
  const url = getWsUrl();
  ui.lastError = null;
  render();
  const res = await api.signalConnect({ wsUrl: url });
  if (!res.ok) {
    ui.lastError = res.error || 'Connect failed';
    render();
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  wireAuthTabs();
  setAuthMode('signin');
  wireAuthForms();
  wireCatalogBrowse();
  wireRoomActions();
  await initAuth();
  previousAuthPresent = !!authSession;
  render();
  await hydrate();
  await tryAutoConnect();
  render();
});
