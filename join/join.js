(function () {
  const params = new URLSearchParams(window.location.search);
  const code = (params.get('code') || params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  let videoUrl = null;
  let serverUrl = null;
  try {
    const raw = params.get('url');
    if (raw) videoUrl = decodeURIComponent(raw);
    const rawServer = params.get('server');
    if (rawServer) serverUrl = decodeURIComponent(rawServer);
  } catch {}

  if (serverUrl) {
    chrome.storage.local.set({ serverUrl });
  }

  const STREAMING_HOSTS = globalThis.PLAYSHARE_STREAMING_CONFIG.hostSubstrings;

  function isValidVideoUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && STREAMING_HOSTS.some(h => u.hostname.includes(h));
    } catch { return false; }
  }

  // Convert title/detail URLs to watch URLs for auto-play where possible
  function toWatchUrl(url) {
    if (!url) return url;
    try {
      const u = new URL(url);
      // Netflix: /title/12345 -> /watch/12345 (starts playback)
      const netflixTitle = u.pathname.match(/\/title\/(\d+)/);
      if (u.hostname.includes('netflix.com') && netflixTitle) {
        u.pathname = `/watch/${netflixTitle[1]}`;
        return u.toString();
      }
      return url;
    } catch { return url; }
  }

  const content = document.getElementById('content');

  if (!code || code.length < 4) {
    content.innerHTML = '<p class="join-error">Invalid or missing room code. The link should look like: ...?code=ABC123</p>';
    return;
  }

  chrome.storage.local.set({ pendingJoinCode: code }, () => {
    const watchUrl = toWatchUrl(videoUrl);
    if (watchUrl && isValidVideoUrl(watchUrl)) {
      content.innerHTML = `
        <p style="color:#888;font-size:14px;">Redirecting you to the video…</p>
        <div class="join-room-code">${code}</div>
        <p class="join-instructions">
          Opening the same video the host is watching. Once it loads, <strong>click the PlayShare icon</strong> and join the room.
        </p>
      `;
      chrome.tabs.getCurrent((tab) => {
        if (tab?.id) chrome.tabs.update(tab.id, { url: watchUrl });
        else chrome.tabs.create({ url: watchUrl });
      });
    } else {
      content.innerHTML = `
        <p style="color:#888;font-size:14px;">You're invited to join</p>
        <div class="join-room-code">${code}</div>
        <p class="join-instructions">
          <strong>Click the PlayShare icon</strong> in your browser toolbar, then click <strong>Join Room</strong> — the code is already filled in.
        </p>
        <p class="join-instructions" style="margin-top:12px;font-size:12px;">
          Open Netflix, Prime Video, YouTube, or another supported site first, then open PlayShare to join.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
          <a href="#" class="join-btn" id="openYouTube">Open YouTube</a>
          <a href="#" class="join-btn" id="openPrime">Open Prime Video</a>
        </div>
      `;

      document.getElementById('openYouTube').addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: 'https://www.youtube.com' });
      });
      document.getElementById('openPrime').addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: 'https://www.primevideo.com' });
      });
    }
  });
})();
