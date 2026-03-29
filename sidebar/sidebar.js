/**
 * PlayShare — Sidebar Script
 * Runs inside the iframe injected by the content script.
 * Communicates with the content script via postMessage.
 */

(function () {
  'use strict';

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const sInviteBtn   = document.getElementById('sInviteBtn');
  const sInviteHint  = document.getElementById('sInviteHint');
  const tabs         = document.querySelectorAll('.ws-tab');
  const tabContents  = document.querySelectorAll('.ws-tab-content');
  const chatBadge    = document.getElementById('chatBadge');
  const memberCount  = document.getElementById('memberCount');
  const sMessages    = document.getElementById('sMessages');
  const sChatInput   = document.getElementById('sChatInput');
  const sSendBtn     = document.getElementById('sSendBtn');
  const sMembersList = document.getElementById('sMembersList');
  const sSyncInfo    = document.getElementById('sSyncInfo');
  const sSyncQuality = document.getElementById('sSyncQuality');
  const sClusterSync = document.getElementById('sClusterSync');
  const sSyncBadge = document.getElementById('sSyncBadge');
  const sConnectionBadgeLabel = document.getElementById('sConnectionBadgeLabel');
  const sConnectionDetail = document.getElementById('sConnectionDetail');
  const sConnectionDetailHeading = document.getElementById('sConnectionDetailHeading');
  const sConnectionDetailBody = document.getElementById('sConnectionDetailBody');
  const sConnectionDetailClose = document.getElementById('sConnectionDetailClose');
  const sConnectionDetailMembers = document.getElementById('sConnectionDetailMembers');
  const sSyncCard = document.getElementById('sSyncCard');
  const sPlatformInfo = document.getElementById('sPlatformInfo');
  const sTypingIndicator = document.getElementById('sTypingIndicator');
  const sHostCountdownPref = document.getElementById('sHostCountdownPref');
  const sCountdownToggle = document.getElementById('sCountdownToggle');
  const sAdBreakCard = document.getElementById('sAdBreakCard');
  const sAdBreakHint = document.getElementById('sAdBreakHint');
  const sAdBreakWatching = document.getElementById('sAdBreakWatching');
  const sAdBreakDone = document.getElementById('sAdBreakDone');

  // ── State ──────────────────────────────────────────────────────────────────
  let myClientId = null;
  let myUsername = null;
  let myIsHost   = false;
  let members    = [];
  let unread     = 0;
  /** Last cluster snapshot from content (room playhead spread). */
  let lastClusterSnapshot = null;
  /** Local drift vs host after apply (seconds), from SYNC_QUALITY. */
  let lastDriftSec = 0;
  /** Extension ↔ server WebSocket (not the same as video PTS, but affects commands). */
  let extensionWsConnected = true;
  let extensionWsMessage = '';
  let extensionWsPhase = '';
  /** Connection detail popover (only for tiers other than ok). */
  let connectionDetailOpen = false;
  let connectionBadgeDetailTitle = '';
  let connectionBadgeDetailShort = '';

  const SYNC_BADGE_TIERS = ['idle', 'wait', 'ok', 'warn', 'err', 'disconnected'];

  /** Short label on the pill — must match the colour tier (green = Connected, etc.). */
  function connectionTierLabel(tier) {
    switch (tier) {
      case 'idle':
        return 'No room';
      case 'wait':
        return 'Syncing..';
      case 'ok':
        return 'Connected';
      case 'warn':
        return 'Warning';
      case 'err':
        return 'Mismatch';
      case 'disconnected':
        return 'Reconnecting';
      default:
        return '…';
    }
  }

  function closeConnectionDetailPopover() {
    if (!sConnectionDetail || !connectionDetailOpen) return;
    sConnectionDetail.classList.add('hidden');
    connectionDetailOpen = false;
    if (sSyncBadge && sSyncBadge.classList.contains('ws-sync-badge--clickable')) {
      sSyncBadge.setAttribute('aria-expanded', 'false');
    }
  }

  function openConnectionDetailPopover() {
    if (!sConnectionDetail || !sSyncBadge || !sSyncBadge.classList.contains('ws-sync-badge--clickable')) return;
    if (sConnectionDetailHeading) sConnectionDetailHeading.textContent = connectionBadgeDetailShort;
    if (sConnectionDetailBody) sConnectionDetailBody.textContent = connectionBadgeDetailTitle;
    sConnectionDetail.classList.remove('hidden');
    connectionDetailOpen = true;
    sSyncBadge.setAttribute('aria-expanded', 'true');
    if (sConnectionDetailClose) sConnectionDetailClose.focus();
  }

  function toggleConnectionDetailPopover() {
    if (connectionDetailOpen) closeConnectionDetailPopover();
    else openConnectionDetailPopover();
  }

  function setHeaderSyncBadge(tier, title, shortLabelOverride) {
    if (!sSyncBadge) return;
    for (const t of SYNC_BADGE_TIERS) sSyncBadge.classList.remove('ws-sync-' + t);
    sSyncBadge.classList.add('ws-sync-' + tier);
    const shortLabel =
      shortLabelOverride != null && String(shortLabelOverride).trim() !== ''
        ? String(shortLabelOverride)
        : connectionTierLabel(tier);
    const clickable = tier !== 'ok';

    connectionBadgeDetailTitle = title;
    connectionBadgeDetailShort = shortLabel;

    const titleAttr = clickable ? `${title} · Click for details` : title;
    sSyncBadge.title = titleAttr;
    sSyncBadge.setAttribute(
      'aria-label',
      clickable
        ? `${shortLabel}. ${title}. Select for more information.`
        : `${shortLabel}. ${title}`
    );
    if (sConnectionBadgeLabel) sConnectionBadgeLabel.textContent = shortLabel;

    if (clickable) {
      sSyncBadge.classList.add('ws-sync-badge--clickable');
      sSyncBadge.setAttribute('role', 'button');
      sSyncBadge.setAttribute('tabindex', '0');
      sSyncBadge.setAttribute('aria-haspopup', 'dialog');
      sSyncBadge.removeAttribute('aria-live');
      sSyncBadge.setAttribute('aria-expanded', connectionDetailOpen ? 'true' : 'false');
    } else {
      sSyncBadge.classList.remove('ws-sync-badge--clickable');
      sSyncBadge.setAttribute('role', 'status');
      sSyncBadge.setAttribute('aria-live', 'polite');
      sSyncBadge.removeAttribute('tabindex');
      sSyncBadge.removeAttribute('aria-haspopup');
      sSyncBadge.removeAttribute('aria-expanded');
      closeConnectionDetailPopover();
    }

    if (connectionDetailOpen && sConnectionDetailHeading && sConnectionDetailBody) {
      sConnectionDetailHeading.textContent = shortLabel;
      sConnectionDetailBody.textContent = title;
    }
  }

  function refreshHeaderSyncBadge() {
    if (!sSyncBadge) return;
    if (!myClientId) {
      setHeaderSyncBadge('idle', 'Not in a room');
      return;
    }
    if (!extensionWsConnected) {
      const phase = extensionWsPhase || '';
      const detail =
        extensionWsMessage ||
        (phase === 'unreachable'
          ? "Can't reach server"
          : 'Reconnecting…');
      const short =
        phase === 'unreachable'
          ? 'Offline'
          : phase === 'connecting'
            ? 'Connecting…'
            : phase === 'offline'
              ? 'Offline'
              : 'Reconnecting…';
      const tier = phase === 'unreachable' ? 'err' : phase === 'connecting' ? 'wait' : 'disconnected';
      setHeaderSyncBadge(tier, detail, short);
      return;
    }

    const drift = typeof lastDriftSec === 'number' ? lastDriftSec : 0;
    const c = lastClusterSnapshot;

    if (myIsHost) {
      let tier = 'ok';
      let title = "You're hosting — playback drives the room";

      if (c) {
        if (c.playingMismatch) {
          tier = 'err';
          title = 'Viewers out of step — play/pause mismatch';
        } else if (c.synced === true) {
          tier = 'ok';
          title = 'Everyone aligned on your timeline';
        } else if (c.synced === false && typeof c.spreadSec === 'number') {
          tier = 'warn';
          title = `Viewers ~${c.spreadSec.toFixed(1)}s apart on the timeline`;
        } else if (c.label) {
          const raw = c.label.replace(/^Cluster:\s*/, '');
          if (/add another|need 2|2\+|participants/i.test(raw)) {
            tier = 'ok';
            title = "You're hosting — add viewers to compare playheads";
          } else if (/waiting|reports/i.test(raw)) {
            tier = 'wait';
            title = 'Collecting viewer playhead positions…';
          } else {
            tier = 'wait';
            title = raw;
          }
        }
      }

      if (tier === 'ok' && drift >= 0.75) {
        tier = 'warn';
        title = `Playback check — local time ±${drift.toFixed(1)}s vs last command`;
      }

      setHeaderSyncBadge(tier, title);
      return;
    }

    let tier = 'wait';
    let title = 'Waiting for sync with host…';

    if (c) {
      if (c.playingMismatch) {
        tier = 'err';
        title = 'Play/pause mismatch — not aligned with host or room';
      } else if (c.synced === true) {
        tier = 'ok';
        title = 'In sync with host and room';
      } else if (c.synced === false && typeof c.spreadSec === 'number') {
        tier = 'warn';
        title = `About ${c.spreadSec.toFixed(1)}s off from the group — catching up`;
      } else if (c.label) {
        title = c.label.replace(/^Cluster:\s*/, '');
      }
    }

    if (tier === 'ok' && drift >= 0.75) {
      tier = 'warn';
      title = `Mostly aligned — this device ±${drift.toFixed(1)}s vs host`;
    } else if (tier === 'ok' && drift >= 0.35 && drift < 0.75) {
      title = `In sync with host (±${drift.toFixed(1)}s after last seek/play)`;
    }

    setHeaderSyncBadge(tier, title);
  }

  /** Members card text + header symbol — cluster snapshot from content script. */
  function applyClusterSyncUI(msg) {
    if (sClusterSync) {
      sClusterSync.classList.remove('ws-cluster-ok', 'ws-cluster-warn', 'ws-cluster-err');
      if (msg.playingMismatch) {
        sClusterSync.textContent = 'Room cluster: play/pause mismatch';
        sClusterSync.classList.add('ws-cluster-err');
      } else if (msg.synced === true) {
        sClusterSync.textContent = 'Room cluster: synced';
        sClusterSync.classList.add('ws-cluster-ok');
      } else if (msg.synced === false && typeof msg.spreadSec === 'number') {
        sClusterSync.textContent = `Room cluster: ~${msg.spreadSec.toFixed(1)}s apart`;
        sClusterSync.classList.add('ws-cluster-warn');
      } else {
        sClusterSync.textContent = msg.label ? msg.label.replace(/^Cluster:\s*/, 'Room cluster: ') : 'Room cluster: waiting…';
      }
    }

    lastClusterSnapshot = {
      playingMismatch: !!msg.playingMismatch,
      synced: msg.synced,
      spreadSec: typeof msg.spreadSec === 'number' ? msg.spreadSec : null,
      label: msg.label || ''
    };
    refreshHeaderSyncBadge();
  }

  function resetClusterSyncUI() {
    if (sClusterSync) {
      sClusterSync.textContent = '';
      sClusterSync.classList.remove('ws-cluster-ok', 'ws-cluster-warn', 'ws-cluster-err');
    }
    lastClusterSnapshot = null;
    lastDriftSec = 0;
    refreshHeaderSyncBadge();
  }

  function updateInviteButton(d) {
    if (!sInviteBtn) return;
    const code = d && d.roomCode ? String(d.roomCode) : '';
    const hasVideo =
      !!d &&
      (typeof d.inviteLinkHasVideo === 'boolean' ? d.inviteLinkHasVideo : !!d.videoUrl);
    sInviteBtn.disabled = !code;
    sInviteBtn.classList.toggle('ws-invite-ghost', !hasVideo);
    sInviteBtn.classList.toggle('ws-invite-filled', hasVideo);
    const title = code
      ? hasVideo
        ? `Room ${code} — copy invite (opens this video and joins the room)`
        : `Room ${code} — copy invite; open a watch page on the host tab to add one-tap join`
      : 'Join a room to copy an invite link';
    sInviteBtn.title = title;
    sInviteBtn.setAttribute('aria-label', title);
    if (sInviteHint) {
      if (!code) {
        sInviteHint.textContent = 'Join a room to share a link';
      } else if (hasVideo) {
        sInviteHint.textContent = 'One-tap join — link includes this watch page';
      } else {
        sInviteHint.textContent = 'Invite has room code — add a watch page for one-tap join';
      }
    }
  }

  let activeTab  = 'chat';
  let welcomeRemoved = false;
  let typingTimeout = null;
  let typingUsers = new Set();

  /** Keep DOM bounded during long sessions (chat + system + reactions). */
  const MAX_CHAT_NODES = 150;

  function trimChatDom() {
    while (sMessages && sMessages.children.length > MAX_CHAT_NODES) {
      sMessages.removeChild(sMessages.firstChild);
    }
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────
  function switchTab(target) {
    tabs.forEach(t => {
      t.classList.toggle('active', t.dataset.tab === target);
    });
    tabContents.forEach(c => {
      c.classList.toggle('active', c.id === 'tab' + capitalize(target));
    });
    activeTab = target;
    if (target === 'chat') {
      unread = 0;
      if (chatBadge) {
        chatBadge.textContent = '0';
        chatBadge.classList.add('hidden');
      }
    }
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // ── Chat send ──────────────────────────────────────────────────────────────
  function sendChat() {
    const text = sChatInput.value.trim();
    if (!text) return;
    clearTimeout(typingTimeout);
    postContent({ type: 'TYPING_STOP' });
    postContent({ type: 'CHAT', text });
    // Optimistically show own message
    appendChatMessage({
      clientId: myClientId,
      username: myUsername || 'You',
      color: '#4ECDC4',
      text,
      timestamp: Date.now()
    }, true);
    sChatInput.value = '';
  }

  sSendBtn.addEventListener('click', sendChat);
  sChatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  // ── Typing indicators ──────────────────────────────────────────────────────
  function onTypingInput() {
    postContent({ type: 'TYPING_START' });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => postContent({ type: 'TYPING_STOP' }), 1500);
  }
  sChatInput.addEventListener('input', onTypingInput);
  sChatInput.addEventListener('keydown', onTypingInput);

  function updateTypingIndicator() {
    if (!sTypingIndicator) return;
    const others = [...typingUsers].filter(u => u !== myUsername);
    if (others.length === 0) {
      sTypingIndicator.textContent = '';
      sTypingIndicator.style.display = 'none';
    } else {
      sTypingIndicator.textContent = others.length === 1
        ? `${others[0]} is typing…`
        : `${others.length} people typing…`;
      sTypingIndicator.style.display = 'block';
    }
  }

  // ── Reactions ──────────────────────────────────────────────────────────────
  document.querySelectorAll('.ws-reaction-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const emoji = btn.dataset.emoji;
      postContent({ type: 'REACTION', emoji });
    });
  });

  // ── Message rendering ──────────────────────────────────────────────────────
  /** Tactical lobby tile; keep in sync with shared/ui/lobby-operative.js */
  function createLobbyOperativeEl(opts) {
    opts = opts || {};
    const raw = opts.color && String(opts.color).trim();
    const accent =
      raw && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)
        ? (function normalizeHex(c) {
            var s = c.trim();
            if (s.length === 4 && s[0] === '#') {
              s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
            }
            return s.toLowerCase();
          })(raw)
        : (function defaultAccentFromSeed(seed) {
            var h = 2166136261;
            for (var i = 0; i < seed.length; i++) {
              h ^= seed.charCodeAt(i);
              h = Math.imul(h, 16777619);
            }
            var hue = Math.abs(h) % 360;
            return 'hsl(' + hue + ' 58% 58%)';
          })((opts.clientId || '') + '|' + (opts.username || ''));
    var initials = (opts.username || '?').trim().slice(0, 2).toUpperCase() || '?';
    var wrap = document.createElement('div');
    wrap.className = opts.size === 'sm' ? 'ps-operative ps-operative--sm' : 'ps-operative';
    wrap.style.setProperty('--op-accent', accent);
    wrap.setAttribute('aria-hidden', 'true');
    var spin = document.createElement('div');
    spin.className = 'ps-operative__spin';
    var inner = document.createElement('div');
    inner.className = 'ps-operative__inner';
    inner.textContent = initials;
    wrap.appendChild(spin);
    wrap.appendChild(inner);
    return wrap;
  }

  function removeWelcome() {
    if (welcomeRemoved) return;
    const w = sMessages.querySelector('.ws-welcome');
    if (w) w.remove();
    welcomeRemoved = true;
  }

  function appendChatMessage(msg, isMine) {
    removeWelcome();
    const div = document.createElement('div');
    div.className = 'ws-msg';
    const color = msg.color || '#4ECDC4';
    const tile = createLobbyOperativeEl({
      color: msg.color,
      clientId: msg.clientId,
      username: msg.username
    });
    const body = document.createElement('div');
    body.className = 'ws-msg-body';
    const meta = document.createElement('div');
    meta.className = 'ws-msg-meta';
    const nameEl = document.createElement('span');
    nameEl.className = 'ws-msg-name';
    nameEl.style.color = color;
    nameEl.textContent = msg.username || '';
    const timeEl = document.createElement('span');
    timeEl.className = 'ws-msg-time';
    timeEl.textContent = formatTime(msg.timestamp);
    meta.appendChild(nameEl);
    meta.appendChild(timeEl);
    const textEl = document.createElement('div');
    textEl.className = 'ws-msg-text';
    textEl.textContent = msg.text || '';
    body.appendChild(meta);
    body.appendChild(textEl);
    div.appendChild(tile);
    div.appendChild(body);
    sMessages.appendChild(div);
    trimChatDom();
    scrollToBottom();

    if (!isMine && activeTab !== 'chat') {
      unread++;
      chatBadge.textContent = unread;
      chatBadge.classList.remove('hidden');
    }
  }

  /** Drop back-to-back duplicates (e.g. flushed queue + live server echo). */
  let _lastSysText = '';
  let _lastSysAt = 0;

  function appendSystemMessage(text) {
    if (!text) return;
    const now = Date.now();
    if (text === _lastSysText && now - _lastSysAt < 900) return;
    _lastSysText = text;
    _lastSysAt = now;
    removeWelcome();
    const div = document.createElement('div');
    div.className = 'ws-system-msg';
    div.textContent = text;
    sMessages.appendChild(div);
    trimChatDom();
    scrollToBottom();
  }

  function appendReactionMessage(msg) {
    removeWelcome();
    const div = document.createElement('div');
    div.className = 'ws-reaction-msg';
    const color = msg.color || '#888';
    div.innerHTML = `
      <span class="ws-reaction-emoji">${msg.emoji}</span>
      <span style="color:${color}">${escHtml(msg.username)}</span>
      <span style="color:#555">reacted</span>
    `;
    sMessages.appendChild(div);
    trimChatDom();
    scrollToBottom();
  }

  function scrollToBottom() {
    sMessages.scrollTop = sMessages.scrollHeight;
  }

  function showChatCountdown(fromUsername) {
    const overlay = document.getElementById('sCountdownOverlay');
    if (!overlay) return;
    overlay.innerHTML = '';
    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');
    const num = document.createElement('div');
    num.className = 'ws-countdown-num';
    overlay.appendChild(num);
    let n = 3;
    num.textContent = n;
    const tick = () => {
      n--;
      if (n > 0) {
        num.textContent = n;
        num.style.animation = 'none';
        num.offsetHeight;
        num.style.animation = 'wsCountPulse 1s ease';
        setTimeout(tick, 1000);
      } else {
        overlay.classList.remove('visible');
        overlay.setAttribute('aria-hidden', 'true');
        overlay.innerHTML = '';
        appendSystemMessage(fromUsername ? `${fromUsername} is starting playback…` : 'Starting playback…');
      }
    };
    setTimeout(tick, 1000);
  }

  // ── Members rendering ──────────────────────────────────────────────────────
  function renderMembers(memberList) {
    members = memberList || [];
    memberCount.textContent = members.length;
    sMembersList.innerHTML = '';
    if (members.length === 0) {
      sMembersList.innerHTML = '<div class="ws-empty-state">No members yet</div>';
      return;
    }
    members.forEach(m => {
      const div = document.createElement('div');
      div.className = 'ws-member-card';
      const isMe = m.clientId === myClientId;
      const face = createLobbyOperativeEl({
        color: m.color,
        clientId: m.clientId,
        username: m.username,
        size: 'sm'
      });
      const info = document.createElement('div');
      info.className = 'ws-member-card-info';
      const nameRow = document.createElement('div');
      nameRow.className = 'ws-member-card-name';
      nameRow.textContent = m.username || '';
      const roleRow = document.createElement('div');
      roleRow.className = 'ws-member-card-role';
      roleRow.textContent = m.isHost ? '👑 Host' : 'Viewer';
      info.appendChild(nameRow);
      info.appendChild(roleRow);
      div.appendChild(face);
      div.appendChild(info);
      if (isMe) {
        const you = document.createElement('span');
        you.className = 'ws-member-card-you';
        you.textContent = 'you';
        div.appendChild(you);
      }
      sMembersList.appendChild(div);
    });
  }

  /** Host-only: play countdown preference (mirrors content script roomState.countdownOnPlay). */
  function updateAdBreakUI(payload) {
    if (!sAdBreakCard) return;
    const d = payload || {};
    const inRoom = !!(myClientId);
    sAdBreakCard.classList.toggle('hidden', !inRoom);
    sAdBreakCard.setAttribute('aria-hidden', inRoom ? 'false' : 'true');
    if (!inRoom) return;
    const waiting = !!d.waiting && Array.isArray(d.peerNames) && d.peerNames.length > 0;
    if (sAdBreakHint) {
      if (waiting) {
        sAdBreakHint.textContent = 'Paused: ' + d.peerNames.join(', ') + ' in an ad.';
      } else if (d.local) {
        sAdBreakHint.textContent = 'You reported an ad — others stay paused until you tap “Ad finished”.';
      } else {
        sAdBreakHint.textContent = 'Auto-detect on supported sites, or mark manually.';
      }
    }
    if (sAdBreakWatching) sAdBreakWatching.disabled = !!d.local;
    if (sAdBreakDone) sAdBreakDone.disabled = !d.local;
  }

  function updateHostCountdownPrefFromRoom(d) {
    if (!sHostCountdownPref || !sCountdownToggle) return;
    const show = !!(d && d.clientId && d.isHost);
    sHostCountdownPref.classList.toggle('hidden', !show);
    sHostCountdownPref.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (!show) return;
    const on = !!d.countdownOnPlay;
    sCountdownToggle.setAttribute('aria-checked', on ? 'true' : 'false');
    sHostCountdownPref.classList.toggle('ws-host-pref-countdown--on', on);
  }

  // ── Parent frame messages ──────────────────────────────────────────────────
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.source !== 'playshare-content') return;

    switch (msg.type) {
      case 'SETTINGS':
        document.querySelector('.ws-sidebar')?.classList.toggle('ws-compact', msg.compact !== false);
        break;

      case 'ROOM_STATE': {
        const d = msg.data || {};
        myClientId = d.clientId;
        myUsername = d.username;
        myIsHost = !!d.isHost;
        updateInviteButton(d);
        renderMembers(d.members || []);
        sPlatformInfo.textContent = `Platform: ${detectPlatform()}`;
        sSyncInfo.textContent = d.hostOnlyControl && !d.isHost ? 'Host controls playback' : 'Synced and ready';
        if (sSyncQuality) sSyncQuality.textContent = '';
        resetClusterSyncUI();
        updateHostCountdownPrefFromRoom(d);
        updateAdBreakUI({ local: false, waiting: false, peerNames: [] });
        break;
      }

      case 'AD_BREAK_UI':
        updateAdBreakUI(msg);
        break;

      case 'EXTENSION_WS':
        extensionWsConnected = msg.open !== false;
        extensionWsMessage = typeof msg.connectionMessage === 'string' ? msg.connectionMessage : '';
        extensionWsPhase = typeof msg.transportPhase === 'string' ? msg.transportPhase : '';
        refreshHeaderSyncBadge();
        break;

      case 'COUNTDOWN_START':
        showChatCountdown(msg.fromUsername);
        break;

      case 'SYNC_QUALITY': {
        if (!sSyncQuality) break;
        const drift = msg.drift || 0;
        if (drift < 0.5) sSyncQuality.textContent = '±0.0s in sync';
        else sSyncQuality.textContent = `±${drift.toFixed(1)}s corrected`;
        lastDriftSec = drift;
        refreshHeaderSyncBadge();
        break;
      }

      case 'CLUSTER_SYNC':
        applyClusterSyncUI(msg);
        break;

      case 'TYPING_START':
        if (msg.username && msg.username !== myUsername) {
          typingUsers.add(msg.username);
          updateTypingIndicator();
          setTimeout(() => {
            typingUsers.delete(msg.username);
            updateTypingIndicator();
          }, 3000);
        }
        break;

      case 'TYPING_STOP':
        if (msg.username) {
          typingUsers.delete(msg.username);
          updateTypingIndicator();
        }
        break;

      case 'MEMBER_JOINED':
        renderMembers(msg.data.members || []);
        appendSystemMessage(`👋 ${msg.data.username} joined the room`);
        break;

      case 'MEMBER_LEFT':
        renderMembers(msg.data.members || []);
        appendSystemMessage(`👋 ${msg.data.username} left the room`);
        break;

      case 'CHAT':
        if (msg.data.clientId !== myClientId) {
          appendChatMessage(msg.data, false);
        }
        break;

      case 'REACTION':
        appendReactionMessage(msg.data);
        break;

      case 'SYSTEM_MSG':
        appendSystemMessage(msg.text);
        break;

      case 'READY':
        break;
    }
  });

  // Signal ready to parent
  function postContent(msg) {
    window.parent.postMessage({ source: 'playshare-sidebar', ...msg }, '*');
  }

  if (sInviteBtn) {
    sInviteBtn.addEventListener('click', () => {
      if (sInviteBtn.disabled) return;
      postContent({ type: 'COPY_INVITE_LINK' });
    });
  }

  if (sAdBreakWatching) {
    sAdBreakWatching.addEventListener('click', () => {
      if (!myClientId) return;
      postContent({ type: 'AD_BREAK_MANUAL_START' });
    });
  }
  if (sAdBreakDone) {
    sAdBreakDone.addEventListener('click', () => {
      if (!myClientId) return;
      postContent({ type: 'AD_BREAK_MANUAL_END' });
    });
  }

  if (sCountdownToggle) {
    sCountdownToggle.addEventListener('click', () => {
      if (!myIsHost || !myClientId) return;
      const next = sCountdownToggle.getAttribute('aria-checked') !== 'true';
      postContent({ type: 'SET_COUNTDOWN_ON_PLAY', value: next });
      sCountdownToggle.setAttribute('aria-checked', next ? 'true' : 'false');
      sHostCountdownPref?.classList.toggle('ws-host-pref-countdown--on', next);
    });
    sCountdownToggle.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      sCountdownToggle.click();
    });
  }

  if (sSyncBadge) {
    sSyncBadge.addEventListener('click', (e) => {
      if (!sSyncBadge.classList.contains('ws-sync-badge--clickable')) return;
      e.stopPropagation();
      toggleConnectionDetailPopover();
    });
    sSyncBadge.addEventListener('keydown', (e) => {
      if (!sSyncBadge.classList.contains('ws-sync-badge--clickable')) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleConnectionDetailPopover();
      }
    });
  }
  if (sConnectionDetailClose) {
    sConnectionDetailClose.addEventListener('click', () => {
      closeConnectionDetailPopover();
      if (sSyncBadge && sSyncBadge.classList.contains('ws-sync-badge--clickable')) sSyncBadge.focus();
    });
  }
  if (sConnectionDetailMembers) {
    sConnectionDetailMembers.addEventListener('click', () => {
      closeConnectionDetailPopover();
      switchTab('members');
      requestAnimationFrame(() => {
        sSyncCard?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
  }
  document.addEventListener('mousedown', (e) => {
    if (!connectionDetailOpen) return;
    const wrap = document.querySelector('.ws-connection-badge-wrap');
    if (wrap && !wrap.contains(e.target)) closeConnectionDetailPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && connectionDetailOpen) {
      e.preventDefault();
      closeConnectionDetailPopover();
      if (sSyncBadge && sSyncBadge.classList.contains('ws-sync-badge--clickable')) sSyncBadge.focus();
    }
  });

  refreshHeaderSyncBadge();
  postContent({ type: 'READY' });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function detectPlatform() {
    try {
      const ref = window.parent.location.hostname;
      if (/netflix/.test(ref)) return 'Netflix';
      if (/disney/.test(ref)) return 'Disney+';
      if (/prime|amazon/.test(ref)) return 'Prime Video';
      if (/crave/.test(ref)) return 'Crave';
      if (/hulu/.test(ref)) return 'Hulu';
      if (/max\.com|hbomax/.test(ref)) return 'Max';
      if (/peacock/.test(ref)) return 'Peacock';
      if (/paramount/.test(ref)) return 'Paramount+';
      if (/apple/.test(ref)) return 'Apple TV+';
      if (/youtube/.test(ref)) return 'YouTube';
    } catch {}
    return 'Streaming';
  }

})();
