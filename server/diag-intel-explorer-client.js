(function () {
  console.log('[PlayShare diag explorer] external bundle loaded');
  var gateBootEl = document.getElementById('gateBootStatus');
  var gateInitFailEl = document.getElementById('gateInitFail');
  function gateBootLine(msg) {
    var ts = new Date().toISOString();
    var line = ts + ' ' + msg;
    try {
      console.log('[PlayShare diag explorer]', msg);
    } catch (eL) {}
    try {
      if (gateBootEl) {
        gateBootEl.textContent = (gateBootEl.textContent ? gateBootEl.textContent + '\n' : '') + line;
        gateBootEl.scrollTop = gateBootEl.scrollHeight;
      }
    } catch (e2) {}
  }
  function showGateInitFail(detail) {
    var t = 'Explorer gate failed to initialize. Open console.';
    if (detail) t += ' ' + String(detail);
    try {
      console.error('[PlayShare diag explorer] INIT FAIL', detail);
    } catch (e) {}
    try {
      if (gateInitFailEl) {
        gateInitFailEl.textContent = t;
        gateInitFailEl.style.display = 'block';
      }
    } catch (e2) {}
    try {
      var pre = document.getElementById('gateDiagBody');
      var det = document.getElementById('gateDiag');
      if (pre) pre.textContent = (pre.textContent ? pre.textContent + '\n\n' : '') + 'INIT FAIL: ' + String(detail || '');
      if (det) det.open = true;
    } catch (e3) {}
  }
  try {
    window.addEventListener(
      'error',
      function (ev) {
        try {
          gateBootLine('window.error: ' + (ev && ev.message ? ev.message : 'unknown'));
        } catch (e) {}
      },
      true
    );
    window.addEventListener('unhandledrejection', function (ev) {
      try {
        var r = ev.reason;
        gateBootLine('unhandledrejection: ' + (r && r.message ? r.message : String(r)));
      } catch (e) {}
    });
  } catch (eWin) {}

  gateBootLine('Explorer script loaded');

  var TOK_KEY = 'playshare_diag_intel_token_v1';
  var AI_KEY_STORAGE = 'playshare_diag_explorer_ai_key_v1';
  var SKIP_LLM_STORAGE = 'playshare_diag_explorer_skip_llm_v1';
  var runtimeAiKey = '';
  /** Bearer from unlock gate (used when hidden #tok is empty until filled). */
  var runtimeDiagBearer = '';
  var lastText = '';
  var lastPath = '';
  var lastPagedFetch = null;
  var lastPagination = null;
  var FIELD_LABELS = {
    ad_mode_enter_count: 'Ad-mode entries',
    hard_correction_count: 'Hard corrections',
    buffering_count: 'Buffering events',
    stalled_count: 'Playback stalls',
    ws_disconnect_count: 'WebSocket disconnects',
    netflix_safety_reject_count: 'Netflix safety rejects',
    source_swap_count: 'Video source swaps',
    sync_apply_reject_total: 'Sync apply rejects (all reasons)'
  };

  function $(id) { return document.getElementById(id); }

  /** Resolve API base when the app is mounted under a path prefix (same origin as this page). */
  function intelBase() {
    var p = window.location.pathname || '';
    var needle = '/diag/intel';
    var idx = p.indexOf(needle);
    if (idx >= 0) return p.slice(0, idx + needle.length);
    return needle;
  }
  /** @param {string} suffix path after /diag/intel e.g. '/cases?limit=1' */
  function intelApi(suffix) {
    var s = suffix.charAt(0) === '/' ? suffix : '/' + suffix;
    return intelBase() + s;
  }

  function setGatePill(mode, label) {
    var el = $('gateStatusPill');
    if (!el) return;
    el.className = 'gate-pill gate-pill--' + mode;
    if (label) el.textContent = label;
  }

  (function initGateHostLine() {
    var el = $('gateHostPath');
    if (!el) return;
    try {
      el.textContent = window.location.origin + intelBase();
    } catch (eH) {
      el.textContent = window.location.origin || '';
    }
  })();

  function enterExplorerApp() {
    try {
      console.log('[PlayShare diag explorer] enterExplorerApp called');
    } catch (eL) {}
    var g = $('gateRoot');
    var a = $('playshareExplorerApp');
    if (g) {
      g.setAttribute('hidden', '');
      g.style.display = 'none';
      g.setAttribute('aria-hidden', 'true');
    }
    if (a) {
      a.removeAttribute('hidden');
      a.style.display = 'block';
      a.style.visibility = 'visible';
      a.setAttribute('aria-hidden', 'false');
    }
    try {
      window.scrollTo(0, 0);
    } catch (eS) {}
  }

  function getClientLlmKeyForBrief() {
    return String(runtimeAiKey || '').trim();
  }

  function attachClientAiHeaders(h) {
    var ak = getClientLlmKeyForBrief();
    if (ak) h['X-PlayShare-Diag-AI-Key'] = ak;
    return h;
  }

  /** Strip wrapping quotes, BOM, CR, and accidental leading "Bearer " from pasted secrets. */
  function normalizeTokInput(raw) {
    var t = String(raw || '').trim();
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1).trim();
    t = t.replace(/\u00a0/g, '');
    if ((t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') || (t.charAt(0) === "'" && t.charAt(t.length - 1) === "'")) {
      t = t.slice(1, -1).trim();
    }
    if (t.toLowerCase().indexOf('bearer ') === 0) t = t.slice(7).trim();
    if (t.toLowerCase().indexOf('bearer ') === 0) t = t.slice(7).trim();
    t = t.replace(/\r/g, '').trim();
    return t;
  }

  function clearGateFieldHighlights() {
    var b = $('gateBearer');
    var o = $('gateOpenAi');
    if (b) {
      b.classList.remove('gate-input-err');
      b.removeAttribute('aria-invalid');
    }
    if (o) {
      o.classList.remove('gate-input-err');
      o.removeAttribute('aria-invalid');
    }
  }

  function highlightGateField(which) {
    clearGateFieldHighlights();
    var el = which === 'openai' ? $('gateOpenAi') : $('gateBearer');
    if (el) {
      el.classList.add('gate-input-err');
      el.setAttribute('aria-invalid', 'true');
      try {
        el.focus();
      } catch (eF) {}
    }
  }

  function clearGateErr() {
    var el = $('gateErr');
    if (!el) return;
    el.textContent = '';
    el.style.display = 'none';
    el.style.visibility = '';
    el.removeAttribute('role');
  }

  function showGateErr(msg) {
    var el = $('gateErr');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
    el.style.visibility = 'visible';
    el.setAttribute('role', 'alert');
    setGatePill('err', 'Error');
    try {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (e) {}
  }

  /** Full reset when returning to the gate (e.g. Change credentials). */
  function clearGateDiag() {
    var pre = $('gateDiagBody');
    var det = $('gateDiag');
    if (pre) pre.textContent = '';
    if (det) det.open = false;
  }

  /** Append one timestamped line and open the diagnostic panel (sync, before any await). */
  function gateAppendDiagImmediate(line) {
    var pre = $('gateDiagBody');
    var det = $('gateDiag');
    if (!pre || !det) return;
    var stamp = '[' + new Date().toISOString() + '] ';
    pre.textContent = (pre.textContent ? pre.textContent + '\n\n' : '') + stamp + String(line || '');
    try {
      det.open = true;
    } catch (e) {}
  }

  /** Sync UI before validate: visible loading + boot log (no async). */
  function gateImmediateUnlockFeedback() {
    setGatePill('checking', 'Contacting server…');
    var working = $('gateWorking');
    if (working) {
      working.style.display = 'block';
      working.textContent = 'Checking credentials…';
    }
    gateBootLine('Unlock attempt started');
    gateAppendDiagImmediate('Unlock attempt started');
  }

  /** @param {string[]} lines Plain lines: no secrets — lengths & server text only. */
  function recordGateAuthDiag(lines) {
    var pre = $('gateDiagBody');
    var det = $('gateDiag');
    if (!pre || !det) return;
    var when = new Date().toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
    var block = when + '\n\n' + lines.filter(Boolean).join('\n');
    pre.textContent = (pre.textContent ? pre.textContent + '\n\n' : '') + block;
    try {
      det.open = true;
    } catch (e0) {}
    setTimeout(function () {
      try {
        det.open = true;
        det.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch (e) {}
    }, 0);
  }

  /**
   * auth-check fetch with a hard timeout even when AbortController is missing (older WebViews).
   * @returns {Promise<Response>}
   */
  function gateFetchAuthCheck(url, fetchOpts, timeoutMs) {
    var ms = timeoutMs || 25000;
    if (typeof AbortController !== 'undefined') {
      var ctrl = new AbortController();
      var opts = Object.assign({}, fetchOpts, { signal: ctrl.signal });
      var tid = setTimeout(function () {
        try {
          ctrl.abort();
        } catch (eA) {}
      }, ms);
      return fetch(url, opts).finally(function () {
        clearTimeout(tid);
      });
    }
    var tid2 = 0;
    var fetchP = fetch(url, fetchOpts).then(
      function (res) {
        if (tid2) clearTimeout(tid2);
        return res;
      },
      function (err) {
        if (tid2) clearTimeout(tid2);
        throw err;
      }
    );
    var timeoutP = new Promise(function (_, reject) {
      tid2 = setTimeout(function () {
        var err = new Error('timeout');
        err.name = 'TimeoutError';
        reject(err);
      }, ms);
    });
    return Promise.race([fetchP, timeoutP]);
  }

  /** @param {Response} res */
  async function readGateErrorDetail(res) {
    var raw = '';
    try {
      raw = await res.text();
    } catch (e) {
      return '';
    }
    if (!raw) return '';
    try {
      var j = JSON.parse(raw);
      if (j && typeof j === 'object') {
        var parts = [];
        if (j.error) parts.push(String(j.error));
        if (j.detail) parts.push(String(j.detail));
        if (j.hint) parts.push(String(j.hint));
        if (parts.length) return parts.join(' — ');
      }
    } catch (e2) {}
    return raw.length > 280 ? raw.slice(0, 280) + '…' : raw;
  }

  async function validateAndEnterFromGate() {
    try {
      console.log('[PlayShare diag explorer] validateAndEnterFromGate entered');
    } catch (eL) {}
    var bearer = normalizeTokInput($('gateBearer') && $('gateBearer').value) || '';
    var openai = ($('gateOpenAi') && $('gateOpenAi').value.trim()) || '';
    var btn = $('gateSubmit');
    var working = $('gateWorking');
    var hadBearerReadyForFetch = false;
    var unlockFetchStarted = false;
    clearGateErr();
    clearGateFieldHighlights();

    if (!bearer) {
      highlightGateField('bearer');
      recordGateAuthDiag([
        'Client validation failed.',
        'Railway secret: empty after trim / normalize — paste the variable value only (no label text).'
      ]);
      showGateErr('Paste the Railway diagnostic secret (PLAYSHARE_DIAG_INTEL_SECRET or upload secret). It cannot be empty.');
      return;
    }
    if (openai && openai.length < 12) {
      highlightGateField('openai');
      recordGateAuthDiag([
        'Client validation failed.',
        'OpenAI field: ' + openai.length + ' characters (minimum 12 expected for a real key) — paste full key or leave empty for server LLM.'
      ]);
      showGateErr('That OpenAI key looks too short. Copy the full key from OpenAI (usually starts with sk- or similar).');
      return;
    }

    hadBearerReadyForFetch = true;
    if (btn) btn.disabled = true;
    if (working) {
      working.style.display = 'block';
      working.textContent = 'Checking credentials with the server…';
    }
    var timeoutMs = 25000;
    try {
      var r;
      try {
        /* GET avoids POST body / some reverse-proxy quirks; server accepts GET or POST. */
        var fetchOpts = {
          method: 'GET',
          headers: {
            Authorization: 'Bearer ' + bearer,
            'X-PlayShare-Diag-Intel-Secret': bearer
          },
          credentials: 'same-origin',
          cache: 'no-store'
        };
        try {
          console.log('[PlayShare diag explorer] fetch about to start (GET)', intelApi('/auth-check'));
        } catch (eLog) {}
        unlockFetchStarted = true;
        r = await gateFetchAuthCheck(intelApi('/auth-check'), fetchOpts, timeoutMs);
        try {
          console.log('[PlayShare diag explorer] fetch completed', r && r.status);
        } catch (eLog2) {}
      } catch (eFetch) {
        var aborted =
          eFetch &&
          (eFetch.name === 'AbortError' ||
            eFetch.name === 'TimeoutError' ||
            (String(eFetch.message || '').toLowerCase().indexOf('abort') >= 0) ||
            (String(eFetch.message || '').toLowerCase().indexOf('timeout') >= 0));
        if (aborted) {
          recordGateAuthDiag([
            'No HTTP response — request aborted (timeout ' + Math.round(timeoutMs / 1000) + 's).',
            'Browser: ' + window.location.origin + window.location.pathname,
            'Target: GET ' + intelApi('/auth-check'),
            'Normalized Railway secret length: ' + bearer.length + ' chars',
            'If the host is cold-starting, wait and retry.'
          ]);
          showGateErr(
            'Request timed out after ' +
              Math.round(timeoutMs / 1000) +
              's. Your server may be sleeping (cold start), overloaded, or unreachable. Wait and try again, or check Railway / hosting logs.'
          );
        } else {
          recordGateAuthDiag([
            'No HTTP response — network / wrong page origin.',
            'Browser: ' + window.location.origin + window.location.pathname,
            'Target: GET ' + intelApi('/auth-check'),
            'Detail: ' + (eFetch && eFetch.message ? eFetch.message : String(eFetch)),
            'Open this page from the same host as your PlayShare server (…/diag/intel/explorer).'
          ]);
          showGateErr(
            'Could not reach the diagnostics API. Open this page from your PlayShare server (…/diag/intel/explorer), not a saved file. If you use a reverse proxy, keep the same path prefix. ' +
              (eFetch && eFetch.message ? 'Technical detail: ' + eFetch.message : '')
          );
        }
        return;
      }

      if (r.status === 401) {
        highlightGateField('bearer');
        var d401 = await readGateErrorDetail(r);
        recordGateAuthDiag([
          'HTTP 401 — Railway secret rejected by this server.',
          'Meaning: pasted value ≠ PLAYSHARE_DIAG_INTEL_SECRET / PLAYSHARE_DIAG_UPLOAD_SECRET in this deployment’s env.',
          'Normalized secret length: ' + bearer.length + ' chars (compare character count to the value in Railway for the same service).',
          'OpenAI field (not validated until unlock succeeds): ' + (openai ? openai.length + ' chars' : 'empty'),
          'Server detail: ' + (d401 || '(empty body)')
        ]);
        showGateErr(
          d401 ||
            'Invalid or wrong Railway secret (401). Paste the exact value of PLAYSHARE_DIAG_INTEL_SECRET or PLAYSHARE_DIAG_UPLOAD_SECRET from Variables. Do not add the word Bearer, quotes, or extra spaces.'
        );
        return;
      }
      if (r.status === 403) {
        highlightGateField('bearer');
        var d403 = await readGateErrorDetail(r);
        recordGateAuthDiag([
          'HTTP 403 — forbidden.',
          'Normalized Railway secret length: ' + bearer.length + ' chars',
          'Server detail: ' + (d403 || '(empty)')
        ]);
        showGateErr(
          'Access denied (403).' + (d403 ? ' ' + d403 : ' Check that the secret matches the variable on this server.')
        );
        return;
      }
      if (r.status === 404) {
        recordGateAuthDiag([
          'HTTP 404 — path not found on this host.',
          'Requested: GET ' + intelApi('/auth-check'),
          'You are probably not on the PlayShare server (wrong domain or path prefix).'
        ]);
        showGateErr(
          'Diagnostics URL not found (404). You may be on the wrong host or path. Use the live /diag/intel/explorer URL from the machine running PlayShare.'
        );
        return;
      }
      if (r.status === 503) {
        var j503t = await readGateErrorDetail(r);
        recordGateAuthDiag([
          'HTTP 503 — service unavailable.',
          'Often: intel_secret_not_configured (no PLAYSHARE_DIAG_INTEL_SECRET on this process) or upstream misconfiguration.',
          'Normalized Railway secret length sent: ' + bearer.length + ' chars',
          'Server detail: ' + (j503t || '(empty)')
        ]);
        showGateErr(
          j503t ||
            'Service unavailable (503). If this says intel_secret_not_configured, set PLAYSHARE_DIAG_INTEL_SECRET on this Railway service and redeploy.'
        );
        return;
      }
      if (r.status >= 500) {
        var d5 = await readGateErrorDetail(r);
        recordGateAuthDiag([
          'HTTP ' + r.status + ' — server error.',
          'Normalized Railway secret length: ' + bearer.length + ' chars',
          'Server detail: ' + (d5 || '(empty)')
        ]);
        showGateErr(
          'Server error (' +
            r.status +
            ').' +
            (d5 ? ' ' + d5 : ' Check deployment logs on Railway (or your host) and try again.')
        );
        return;
      }
      if (!r.ok) {
        var dx = await readGateErrorDetail(r);
        recordGateAuthDiag([
          'HTTP ' + r.status + ' ' + (r.statusText || '') + ' — unexpected.',
          'Normalized Railway secret length: ' + bearer.length + ' chars',
          'Server detail: ' + (dx || '(empty)')
        ]);
        showGateErr(
          'Unexpected response ' + r.status + ' ' + (r.statusText || '') + '.' + (dx ? ' ' + dx : ' Try again or redeploy the server.')
        );
        return;
      }

      var okBody = await r.text().catch(function () {
        return '';
      });
      var supLine = '';
      try {
        var jOk = JSON.parse(okBody || '{}');
        if (jOk.supabase_configured === false) {
          supLine =
            'Supabase: server reports not configured — after unlock, "Load cases" may return 503 until SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set.';
        } else if (jOk.supabase_configured === true) {
          supLine = 'Supabase: server reports configured.';
        }
      } catch (eJ) {}
      recordGateAuthDiag([
        'HTTP ' + r.status + ' — authentication accepted.',
        'Browser: ' + window.location.origin + window.location.pathname,
        'GET ' + intelApi('/auth-check'),
        'Normalized Railway secret length: ' + bearer.length + ' chars',
        'OpenAI field: ' + (openai ? openai.length + ' chars (stored for AI requests)' : 'empty (use server LLM env if set)'),
        okBody ? 'Response JSON: ' + okBody : '(empty body)',
        supLine
      ].filter(Boolean));

      try {
        runtimeAiKey = openai;
        try {
          sessionStorage.removeItem(TOK_KEY);
          sessionStorage.removeItem(AI_KEY_STORAGE);
          sessionStorage.removeItem(SKIP_LLM_STORAGE);
        } catch (e2) {}
        runtimeDiagBearer = bearer;
        if ($('tok')) $('tok').value = bearer;
        clearGateErr();
        clearGateFieldHighlights();
        try {
          console.log('[PlayShare diag explorer] calling enterExplorerApp');
        } catch (eL3) {}
        enterExplorerApp();
      } catch (eDone) {
        recordGateAuthDiag([
          'Server returned success but a browser step failed after unlock.',
          String(eDone && eDone.message ? eDone.message : eDone)
        ]);
        showGateErr('Unlocked locally but something failed in the page: ' + (eDone && eDone.message ? eDone.message : String(eDone)));
      }
    } finally {
      if (hadBearerReadyForFetch && !unlockFetchStarted) {
        gateAppendDiagImmediate('Unlock request did not start (stopped before network request).');
        showGateErr('Unlock request did not start. See Authentication diagnostic or the browser console.');
        try {
          console.warn('[PlayShare diag explorer] unlockFetchStarted never set true');
        } catch (eW) {}
      }
      if (working) working.style.display = 'none';
      if (btn) btn.disabled = false;
      var stillGate = $('gateRoot') && !$('gateRoot').hasAttribute('hidden');
      var ge = $('gateErr');
      var errShowing = ge && ge.style.display !== 'none' && String(ge.textContent || '').length > 0;
      if (stillGate) {
        if (errShowing) setGatePill('err', 'Error');
        else setGatePill('idle', 'Ready');
      }
    }
  }

  fetch(intelApi('/public-meta'))
    .then(function (r) {
      return r.text();
    })
    .then(function (t) {
      try {
        var j = JSON.parse(t || '{}');
        if (j && j.ok && j.server_llm_configured) {
          var gh = $('gateServerLlmHint');
          if (gh) gh.style.display = 'block';
        }
      } catch (eParse) {}
    })
    .catch(function () {});

  gateBootLine('DOM ready (end-of-body script)');

  try {
    var gateBtn = $('gateSubmit');
    if (!gateBtn) {
      gateBootLine('ERROR: #gateSubmit not found');
      showGateInitFail('#gateSubmit (Continue) not found in page HTML.');
    } else {
      gateBootLine('Continue button found');
      function onGateContinueClick(ev) {
        if (ev) {
          ev.preventDefault();
          ev.stopPropagation();
        }
        try {
          console.log('[PlayShare diag explorer] Continue clicked');
          gateImmediateUnlockFeedback();
          var pr = validateAndEnterFromGate();
          if (pr && typeof pr.catch === 'function') {
            pr.catch(function (eUnhandled) {
              var msg = String(eUnhandled && eUnhandled.message ? eUnhandled.message : eUnhandled);
              recordGateAuthDiag(['Uncaught async error in unlock handler.', msg]);
              showGateErr('Unexpected error: ' + msg);
              gateBootLine('async unlock error: ' + msg);
            });
          }
        } catch (eSync) {
          var msgS = String(eSync && eSync.message ? eSync.message : eSync);
          gateAppendDiagImmediate('Continue click handler error: ' + msgS);
          recordGateAuthDiag(['Uncaught synchronous error in Continue click.', msgS]);
          showGateErr('Unexpected error: ' + msgS);
          gateBootLine('click handler error: ' + msgS);
          try {
            console.error('[PlayShare diag explorer] Continue click', eSync);
          } catch (eC) {}
        }
      }
      gateBtn.addEventListener('click', onGateContinueClick);
      gateBootLine('click handler attached');
      gateBootLine('Unlock handler ready');
    }
  } catch (eGateInit) {
    showGateInitFail(eGateInit && eGateInit.message ? eGateInit.message : String(eGateInit));
    gateBootLine('gate init exception: ' + (eGateInit && eGateInit.message ? eGateInit.message : String(eGateInit)));
  }

  function gateMaybeSubmit(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    try {
      console.log('[PlayShare diag explorer] Enter key submit');
      gateImmediateUnlockFeedback();
      var pr = validateAndEnterFromGate();
      if (pr && typeof pr.catch === 'function') {
        pr.catch(function (eUnhandled) {
          recordGateAuthDiag([
            'Uncaught async error in unlock handler (Enter key).',
            String(eUnhandled && eUnhandled.message ? eUnhandled.message : eUnhandled)
          ]);
          showGateErr('Unexpected error: ' + (eUnhandled && eUnhandled.message ? eUnhandled.message : String(eUnhandled)));
        });
      }
    } catch (eSync) {
      recordGateAuthDiag([
        'Uncaught synchronous error (Enter key).',
        String(eSync && eSync.message ? eSync.message : eSync)
      ]);
      showGateErr('Unexpected error: ' + (eSync && eSync.message ? eSync.message : String(eSync)));
    }
  }
  var gb = $('gateBearer');
  if (gb) {
    gb.addEventListener('keydown', gateMaybeSubmit);
    gb.addEventListener('input', function () {
      var meta = $('gateSecretMeta');
      if (!meta) return;
      var n = normalizeTokInput(gb.value).length;
      meta.textContent = n
        ? 'Normalized length: ' + n + ' characters (nothing is sent until you unlock).'
        : 'Paste above — length is checked locally before any request runs.';
    });
  }
  var go = $('gateOpenAi');
  if (go) go.addEventListener('keydown', gateMaybeSubmit);

  var btnReunlock = $('btnReunlock');
  if (btnReunlock) {
    btnReunlock.onclick = function () {
      try {
        sessionStorage.removeItem(TOK_KEY);
        sessionStorage.removeItem(AI_KEY_STORAGE);
        sessionStorage.removeItem(SKIP_LLM_STORAGE);
      } catch (eR) {}
      runtimeDiagBearer = '';
      runtimeAiKey = '';
      if ($('tok')) $('tok').value = '';
      if ($('gateBearer')) $('gateBearer').value = '';
      if ($('gateOpenAi')) $('gateOpenAi').value = '';
      clearGateErr();
      clearGateDiag();
      setGatePill('idle', 'Ready');
      var hp = $('gateHostPath');
      if (hp) {
        try {
          hp.textContent = window.location.origin + intelBase();
        } catch (eHP) {}
      }
      var gr = $('gateRoot');
      var ap = $('playshareExplorerApp');
      if (ap) {
        ap.setAttribute('hidden', '');
        ap.style.display = '';
        ap.style.visibility = '';
        ap.setAttribute('aria-hidden', 'true');
      }
      if (gr) {
        gr.removeAttribute('hidden');
        gr.style.display = '';
        gr.style.visibility = '';
        gr.removeAttribute('aria-hidden');
      }
    };
  }

  function esc(s) {
    if (s == null || s === '') return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtWhen(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch (e) {
      return esc(iso);
    }
  }

  function tagsCell(tags) {
    if (!Array.isArray(tags) || !tags.length) return '—';
    return esc(tags.join(', '));
  }

  function truncate(s, n) {
    var t = String(s || '');
    if (t.length <= n) return esc(t);
    return esc(t.slice(0, n)) + '…';
  }

  function paginationBar(p) {
    if (!p || typeof p.offset !== 'number' || typeof p.limit !== 'number') return '';
    var start = p.returned ? p.offset + 1 : p.offset;
    var end = p.offset + (p.returned || 0);
    var prevDis = p.offset <= 0 ? ' disabled' : '';
    var nextDis = !p.has_more ? ' disabled' : '';
    var label =
      p.returned > 0
        ? 'Showing ' + start + '–' + end + (p.has_more ? ' (more available)' : '')
        : 'No rows on this page';
    return (
      '<div class="pager" role="navigation" aria-label="Pagination">' +
      '<button type="button" class="secondary"' +
      prevDis +
      ' data-page="prev">Previous page</button>' +
      '<span class="pager-meta">' +
      esc(label) +
      '</span>' +
      '<button type="button" class="secondary"' +
      nextDis +
      ' data-page="next">Next page</button>' +
      '</div>'
    );
  }

  function getResolvedBearer() {
    var t = normalizeTokInput($('tok') && $('tok').value);
    if (t) return t;
    return normalizeTokInput(runtimeDiagBearer);
  }

  function authHeaders() {
    var t = getResolvedBearer();
    var h = { 'Content-Type': 'application/json' };
    if (t) {
      h.Authorization = 'Bearer ' + t;
      h['X-PlayShare-Diag-Intel-Secret'] = t;
    }
    return attachClientAiHeaders(h);
  }

  /** POST fallback for hosts that strip auth headers on JSON requests. */
  function withDiagAuthBody(body) {
    var b = body && typeof body === 'object' ? body : {};
    var t = getResolvedBearer();
    if (t) b.diag_intel_secret = t;
    return b;
  }

  function setPill(text, kind) {
    var el = $('statusPill');
    el.textContent = text;
    el.className = 'pill ' + (kind || 'idle');
  }

  function setLoading() {
    setPill('Loading…', 'warn');
    $('latencyEl').textContent = '';
    $('pathEl').textContent = '';
    $('out').textContent = '…';
    $('btnCopy').disabled = true;
    $('btnDl').disabled = true;
    $('humanOut').innerHTML = '<div class="empty">Loading…</div>';
  }

  function pillForStatus(code) {
    if (code >= 200 && code < 300) return 'ok';
    if (code === 401 || code === 403) return 'err';
    if (code >= 500) return 'err';
    if (code >= 400) return 'warn';
    return 'idle';
  }

  function renderHuman(j, statusCode) {
    var box = $('humanOut');
    var raw = $('rawDetails');
    if (!j) {
      box.innerHTML = '<div class="alert err">Empty response.</div>';
      return;
    }
    if (j.parseError) {
      box.innerHTML = '<div class="alert err">The server returned non-JSON. First bytes: <span class="mono-sm">' + esc((j.bodyPreview || '').slice(0, 400)) + '</span></div>';
      if (statusCode >= 400) raw.open = true;
      return;
    }
    if (j.ok === false) {
      var msg = esc(j.error || 'request_failed');
      var det = j.detail ? '<br/><span class="mono-sm">' + esc(String(j.detail)) + '</span>' : '';
      var cls = statusCode >= 500 ? 'err' : 'warn';
      box.innerHTML = '<div class="alert ' + cls + '"><strong>' + msg + '</strong>' + det + '</div>';
      raw.open = true;
      return;
    }
    if (Array.isArray(j.cases)) {
      var qh =
        j.query != null
          ? '<p class="muted" style="margin:0 0 10px">Matches for <strong>' + esc(j.query) + '</strong> · ' + j.cases.length + ' row(s) on this page</p>'
          : '<p class="muted" style="margin:0 0 10px">' + j.cases.length + ' case(s) on this page</p>';
      if (!j.cases.length) {
        box.innerHTML =
          qh +
          '<div class="empty">No rows matched. Upload a diagnostic from the extension, relax filters, or go to the previous page.</div>' +
          (j.pagination ? paginationBar(j.pagination) : '');
        return;
      }
      var tbl = qh + '<div style="overflow:auto"><table class="data-table"><thead><tr><th>When</th><th>Site</th><th>Ext</th><th>Summary</th><th>Tags</th><th></th></tr></thead><tbody>';
      j.cases.forEach(function (c) {
        var id = c.report_id || '';
        tbl += '<tr><td>' + fmtWhen(c.uploaded_at) + '</td><td>' + esc(c.platform || '') + '</td><td class="mono-sm">' + esc(c.extension_version || '') + '</td><td class="sum">' + truncate(c.case_summary_text, 160) + '</td><td class="mono-sm">' + tagsCell(c.derived_tags) + '</td><td><button type="button" class="linkish" data-explain="' + esc(id) + '">Explain</button></td></tr>';
      });
      tbl += '</tbody></table></div>' + (j.pagination ? paginationBar(j.pagination) : '');
      box.innerHTML = tbl;
      box.querySelectorAll('[data-explain]').forEach(function (btn) {
        btn.onclick = function () {
          var rid = btn.getAttribute('data-explain');
          if (rid) jget(intelApi('/cases/' + rid + '/explain'));
        };
      });
      return;
    }
    if (Array.isArray(j.clusters)) {
      if (!j.clusters.length) {
        box.innerHTML =
          '<div class="empty">No cluster rollups on this page (or none yet). They populate as cases are ingested.</div>' +
          (j.pagination ? paginationBar(j.pagination) : '');
        return;
      }
      var t2 =
        '<p class="muted" style="margin:0 0 10px">' +
        j.clusters.length +
        ' cluster(s) on this page</p><div style="overflow:auto"><table class="data-table"><thead><tr><th>Last seen</th><th>Site</th><th>Cases</th><th>Signature</th><th>Summary</th></tr></thead><tbody>';
      j.clusters.forEach(function (cl) {
        t2 += '<tr><td>' + fmtWhen(cl.last_case_at) + '</td><td>' + esc(cl.platform || '') + '</td><td>' + esc(String(cl.case_count != null ? cl.case_count : '')) + '</td><td class="mono-sm">' + truncate(cl.cluster_signature, 48) + '</td><td class="sum">' + truncate(cl.cluster_summary, 120) + '</td></tr>';
      });
      t2 += '</tbody></table></div>' + (j.pagination ? paginationBar(j.pagination) : '');
      box.innerHTML = t2;
      return;
    }
    if (j.recommendations && Array.isArray(j.recommendations)) {
      var sample = j.case_sample_size != null ? '<p class="muted" style="margin:0 0 12px">Based on the last <strong>' + esc(String(j.case_sample_size)) + '</strong> uploaded case(s).</p>' : '';
      if (!j.recommendations.length) {
        box.innerHTML = sample + '<div class="empty">No strong patterns in this sample. Try again after more uploads or raise the sample size in the API.</div>';
        return;
      }
      var cards = sample;
      j.recommendations.forEach(function (r) {
        var conf = r.confidence ? '<span class="pill ' + (r.confidence === 'low' ? 'warn' : 'ok') + '" style="font-size:10px;margin-left:8px">' + esc(r.confidence) + '</span>' : '';
        var ev = Array.isArray(r.evidence) ? r.evidence.map(function (x) { return esc(x); }).join(' · ') : '';
        cards += '<div class="rec-card"><p><strong>Suggestion</strong>' + conf + '</p><p>' + esc(r.text || '') + '</p><div class="rec-meta">' + ev + '</div></div>';
      });
      box.innerHTML = cards;
      return;
    }
    if (j.explanation) {
      var ex = j.explanation;
      var hints = ex.suggested_inspection && typeof ex.suggested_inspection === 'object' ? ex.suggested_inspection : {};
      var hintList = Object.keys(hints).map(function (k) {
        return '<div class="dl-row"><dt>' + esc(k) + '</dt><dd class="mono-sm">' + esc(hints[k]) + '</dd></div>';
      }).join('');
      var sec = Array.isArray(ex.secondary_factors) && ex.secondary_factors.length
        ? '<p class="muted" style="margin-top:12px"><strong>Also consider:</strong> ' + esc(ex.secondary_factors.join(' · ')) + '</p>'
        : '';
      var sim = Array.isArray(ex.similar_cases) && ex.similar_cases.length
        ? '<h3 class="muted" style="margin:16px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Similar cases</h3><ul style="margin:0;padding-left:18px;color:#cbd5e1;font-size:13px">' +
          ex.similar_cases.map(function (s) {
            return '<li>' + fmtWhen(s.uploaded_at) + ' — ' + truncate(s.case_summary_text, 100) + '</li>';
          }).join('') + '</ul>'
        : '';
      box.innerHTML =
        '<div class="rec-card"><p class="muted" style="margin:0 0 6px">Report <span class="mono-sm">' + esc(ex.report_id) + '</span></p>' +
        '<p style="font-size:1.05rem;margin:0 0 8px"><strong>Likely focus:</strong> ' + esc(ex.likely_issue || '') + '</p>' +
        sec +
        '<h3 class="muted" style="margin:16px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Why</h3><ul style="margin:0;padding-left:18px;font-size:13px">' +
        (Array.isArray(ex.reasoning) ? ex.reasoning.map(function (x) { return '<li class="mono-sm">' + esc(x) + '</li>'; }).join('') : '') +
        '</ul>' +
        (hintList ? '<h3 class="muted" style="margin:16px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Where to look in code</h3>' + hintList : '') +
        sim +
        '</div>';
      return;
    }
    if (j.case && typeof j.case === 'object') {
      var row = j.case;
      box.innerHTML =
        '<div class="rec-card"><p class="mono-sm" style="margin:0 0 8px">' + esc(row.report_id) + '</p>' +
        '<div class="dl-row"><dt>Uploaded</dt><dd>' + fmtWhen(row.uploaded_at) + '</dd></div>' +
        '<div class="dl-row"><dt>Platform</dt><dd>' + esc(row.platform) + '</dd></div>' +
        '<div class="dl-row"><dt>Extension</dt><dd>' + esc(row.extension_version) + '</dd></div>' +
        '<div class="dl-row"><dt>Summary</dt><dd>' + esc(row.case_summary_text) + '</dd></div>' +
        '<div class="dl-row"><dt>Tags</dt><dd class="mono-sm">' + tagsCell(row.derived_tags) + '</dd></div>' +
        '<p style="margin-top:12px"><button type="button" class="linkish" id="btnExplainThis">Open plain-language explain</button></p></div>';
      var bid = row.report_id;
      $('btnExplainThis').onclick = function () {
        if (bid) jget(intelApi('/cases/' + bid + '/explain'));
      };
      return;
    }
    if (j.comparison && typeof j.comparison === 'object') {
      var cmp = j.comparison;
      var head = '<p class="muted" style="margin:0 0 12px">Baseline <strong>' + esc(j.baseline_ver) + '</strong> (' + esc(String(cmp.baseline_n)) + ' cases) vs target <strong>' + esc(j.target_ver) + '</strong> (' + esc(String(cmp.target_n)) + ' cases). Filter: <strong>' + esc(String(cmp.filter)) + '</strong>.</p>';
      if (!cmp.baseline_n || !cmp.target_n) {
        box.innerHTML = head + '<div class="empty">Not enough cases on one or both versions. Check exact version strings in the database.</div>';
        return;
      }
      var sumList = Array.isArray(cmp.summary) && cmp.summary.length
        ? '<ul style="margin:0 0 14px;padding-left:18px;font-size:14px">' + cmp.summary.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'
        : '<p class="muted">No metric crossed the “notable change” threshold — open JSON for full deltas.</p>';
      var md = '<h3 class="muted" style="margin:12px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Metric averages</h3><div style="overflow:auto"><table class="data-table"><thead><tr><th>Metric</th><th>Baseline Ø</th><th>Target Ø</th><th>Note</th></tr></thead><tbody>';
      (cmp.metric_deltas || []).forEach(function (d) {
        var label = FIELD_LABELS[d.field] || d.field;
        var rowCls = d.notable ? ' style="background:rgba(251,191,36,0.06)"' : '';
        md += '<tr' + rowCls + '><td>' + esc(label) + '</td><td class="mono-sm">' + (d.baseline_mean != null ? esc(d.baseline_mean.toFixed(2)) : '—') + '</td><td class="mono-sm">' + (d.target_mean != null ? esc(d.target_mean.toFixed(2)) : '—') + '</td><td>' + esc(d.note || '') + '</td></tr>';
      });
      md += '</tbody></table></div>';
      var tg = '<h3 class="muted" style="margin:16px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Tag rates</h3><div style="overflow:auto"><table class="data-table"><thead><tr><th>Tag</th><th>Baseline</th><th>Target</th><th>Δ</th></tr></thead><tbody>';
      (cmp.tag_compare || []).forEach(function (t) {
        var rowCls = t.notable ? ' style="background:rgba(251,191,36,0.06)"' : '';
        var dlt = t.delta != null ? (t.delta * 100).toFixed(0) + ' pp' : '—';
        tg += '<tr' + rowCls + '><td class="mono-sm">' + esc(t.tag) + '</td><td>' + (t.baseline_rate != null ? esc((t.baseline_rate * 100).toFixed(0) + '%') : '—') + '</td><td>' + (t.target_rate != null ? esc((t.target_rate * 100).toFixed(0) + '%') : '—') + '</td><td>' + esc(dlt) + '</td></tr>';
      });
      tg += '</tbody></table></div>';
      box.innerHTML = head + sumList + md + tg;
      return;
    }
    box.innerHTML = '<div class="empty">Received data in an unexpected shape. Expand <em>Raw JSON</em> below.</div>';
  }

  async function jget(path) {
    lastPath = path;
    setLoading();
    var t0 = performance.now();
    var status = 0;
    try {
      var r = await fetch(path, { headers: authHeaders() });
      status = r.status;
      var ms = Math.round(performance.now() - t0);
      var raw = await r.text();
      var j;
      try {
        j = JSON.parse(raw);
      } catch (e) {
        j = { ok: false, parseError: true, bodyPreview: raw.slice(0, 800) };
      }
      lastText = JSON.stringify(j, null, 2);
      $('out').textContent = lastText;
      $('latencyEl').textContent = ms + ' ms';
      $('pathEl').textContent = path;
      setPill(String(r.status) + ' ' + r.statusText, pillForStatus(r.status));
      $('btnCopy').disabled = !lastText;
      $('btnDl').disabled = !lastText;
      if (j && j.ok !== false && j.pagination) lastPagination = j.pagination;
      else lastPagination = null;
      renderHuman(j, r.status);
      $('rawDetails').open = r.status >= 400 || j.parseError;
    } catch (e) {
      lastPagination = null;
      lastText = JSON.stringify({ ok: false, error: 'fetch_failed', detail: String(e && e.message ? e.message : e) }, null, 2);
      $('out').textContent = lastText;
      $('latencyEl').textContent = Math.round(performance.now() - t0) + ' ms';
      $('pathEl').textContent = path;
      setPill('Network error', 'err');
      $('btnCopy').disabled = false;
      $('btnDl').disabled = false;
      renderHuman(JSON.parse(lastText), 0);
      $('rawDetails').open = true;
    }
  }

  function casesQuery(offset) {
    var off = offset == null || offset === '' ? 0 : Math.max(0, parseInt(offset, 10) || 0);
    var limRaw = parseInt(($('fLim').value || '25').trim(), 10) || 25;
    var lim = Math.min(100, Math.max(1, limRaw));
    var q = ['limit=' + encodeURIComponent(String(lim)), 'offset=' + encodeURIComponent(String(off))];
    var ext = ($('fExt').value || '').trim();
    var plat = ($('fPlat').value || '').trim();
    var tag = ($('fTag').value || '').trim();
    var cl = ($('fCluster').value || '').trim();
    if (ext) q.push('extension_version=' + encodeURIComponent(ext));
    if (plat) q.push('platform=' + encodeURIComponent(plat));
    if (tag) q.push('tag=' + encodeURIComponent(tag));
    if (cl) q.push('cluster=' + encodeURIComponent(cl));
    return intelApi('/cases?' + q.join('&'));
  }

  function searchPath(offset) {
    var off = offset == null || offset === '' ? 0 : Math.max(0, parseInt(offset, 10) || 0);
    var raw = ($('sq').value || '').trim();
    var limRaw = parseInt(($('fSearchLim').value || '25').trim(), 10) || 25;
    var lim = Math.min(40, Math.max(1, limRaw));
    return intelApi('/search?q=' + encodeURIComponent(raw) + '&limit=' + lim + '&offset=' + off);
  }

  function clustersPath(offset) {
    var off = offset == null || offset === '' ? 0 : Math.max(0, parseInt(offset, 10) || 0);
    var limRaw = parseInt(($('fCLim').value || '25').trim(), 10) || 25;
    var lim = Math.min(80, Math.max(1, limRaw));
    return intelApi('/clusters?limit=' + lim + '&offset=' + off);
  }

  document.querySelectorAll('.tabs [role="tab"]').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var id = tab.getAttribute('data-tab');
      document.querySelectorAll('.tabs [role="tab"]').forEach(function (t) {
        var on = t === tab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      document.querySelectorAll('.tab-panel').forEach(function (p) {
        var show = p.id === 'panel-' + id;
        p.classList.toggle('active', show);
        if (show) p.removeAttribute('hidden'); else p.setAttribute('hidden', '');
      });
    });
  });

  $('humanOut').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-page]');
    if (!btn || btn.disabled || !lastPagedFetch || !lastPagination) return;
    var dir = btn.getAttribute('data-page');
    var p = lastPagination;
    if (dir === 'prev') lastPagedFetch(Math.max(0, p.offset - p.limit));
    else if (dir === 'next' && p.has_more) lastPagedFetch(p.offset + p.limit);
  });

  $('btnCases').onclick = function () {
    lastPagedFetch = function (off) {
      jget(casesQuery(off));
    };
    jget(casesQuery(0));
  };
  $('btnClusters').onclick = function () {
    lastPagedFetch = function (off) {
      jget(clustersPath(off));
    };
    jget(clustersPath(0));
  };
  $('btnRecs').onclick = function () {
    lastPagedFetch = null;
    lastPagination = null;
    jget(intelApi('/recommendations?sample=150'));
  };
  $('btnSearch').onclick = function () {
    var raw = ($('sq').value || '').trim();
    if (raw.length < 2) { alert('Enter at least 2 characters'); return; }
    lastPagedFetch = function (off) {
      jget(searchPath(off));
    };
    jget(searchPath(0));
  };
  $('sq').onkeydown = function (e) {
    if (e.key === 'Enter') $('btnSearch').click();
  };
  $('btnReg').onclick = function () {
    lastPagedFetch = null;
    lastPagination = null;
    var bv = encodeURIComponent(($('bv').value || '').trim());
    var tv = encodeURIComponent(($('tv').value || '').trim());
    var pf = ($('pf').value || '').trim();
    if (!bv || !tv) { alert('Baseline and target versions are required'); return; }
    var u = intelApi('/regression?baseline_ver=' + bv + '&target_ver=' + tv);
    if (pf) u += '&platform=' + encodeURIComponent(pf);
    jget(u);
  };

  function extractCursorBlock(md) {
    if (!md) return '';
    var tick3 = String.fromCharCode(96, 96, 96);
    var re = new RegExp(
      '##\\\\s*COPY_PASTE_FOR_CURSOR_AI\\\\s*(?:\\\\r?\\\\n)+' +
        tick3 +
        '[a-z0-9]*\\\\s*([\\\\s\\\\S]*?)' +
        tick3,
      'im'
    );
    var m = md.match(re);
    return m ? m[1].trim() : '';
  }

  function copyText(t, okEl) {
    if (!t) {
      alert('Nothing to copy');
      return;
    }
    navigator.clipboard.writeText(t).then(function () {
      if (okEl) {
        okEl.textContent = 'Copied';
        setTimeout(function () {
          okEl.textContent = '';
        }, 1600);
      }
    }).catch(function () {
      alert('Clipboard unavailable');
    });
  }

  $('btnAiBrief').onclick = async function () {
    var btn = $('btnAiBrief');
    var out = $('aiBriefResult');
    var st = $('aiBriefStatus');
    if (!getResolvedBearer()) {
      st.textContent = '';
      out.innerHTML =
        '<div class="alert err"><strong>Missing server secret</strong>' +
        '<p class="muted" style="margin:8px 0 0">Use <strong>Change credentials</strong> (above the tabs) to open the unlock screen and paste your Railway <code>PLAYSHARE_DIAG_INTEL_SECRET</code> (or upload secret). Without it the server returns <strong>401</strong>.</p></div>';
      return;
    }
    btn.disabled = true;
    st.textContent = '';
    out.innerHTML = '<div class="empty">Gathering data' + ($('aiDryRun').checked ? '…' : ' and calling the model…') + '</div>';
    try {
      var lk = getClientLlmKeyForBrief();
      var body = withDiagAuthBody({
        dry_run: $('aiDryRun').checked,
        focus_platform: ($('aiFocusPlat').value || '').trim() || undefined,
        engineer_notes: ($('aiNotes').value || '').trim() || undefined,
        include_prior_learnings: $('aiIncludePrior').checked,
        persist_learning: !$('aiDryRun').checked && $('aiPersist').checked
      });
      if (lk) body.llm_api_key = lk;
      var r = await fetch(intelApi('/ai-brief'), {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify(body)
      });
      var raw = await r.text();
      var j;
      try {
        j = JSON.parse(raw);
      } catch (e1) {
        j = { ok: false, error: 'bad_json', detail: raw.slice(0, 400) };
      }
      st.textContent = r.status + ' ' + r.statusText;

      var parts = [];
      if (!j.ok && (r.status === 401 || j.error === 'unauthorized')) {
        parts.push(
          '<div class="alert err"><strong>401 — wrong or missing Bearer token</strong>' +
            '<p class="muted" style="margin:8px 0 0">The secret you entered at <strong>unlock</strong> must match the <em>exact</em> value of <code>PLAYSHARE_DIAG_INTEL_SECRET</code> or <code>PLAYSHARE_DIAG_UPLOAD_SECRET</code> from Railway Variables (copy-paste, no extra spaces). Use <strong>Change credentials</strong> to re-enter it. This is not your OpenAI API key.</p></div>'
        );
      } else if (!j.ok && (j.error === 'ai_not_configured' || j.error === 'ai_request_failed')) {
        var extra =
          j.error === 'ai_not_configured'
            ? getClientLlmKeyForBrief()
              ? '<p class="muted" style="margin:8px 0 0">A key was sent from this browser but the server still reported missing config. <strong>Redeploy</strong> the latest PlayShare server (needs <code>llm_api_key</code> body + header support). If you already deployed, check the server logs.</p>'
              : '<p class="muted" style="margin:8px 0 0">Use <strong>Change credentials</strong>, paste an OpenAI key at unlock, <em>or</em> set <code>PLAYSHARE_DIAG_AI_API_KEY</code> / <code>OPENAI_API_KEY</code> on Railway and leave the browser field empty.</p>'
            : '';
        parts.push(
          '<div class="alert warn"><strong>' +
            esc(j.error === 'ai_not_configured' ? 'LLM not configured' : 'LLM request failed') +
            '</strong><p class="muted" style="margin:8px 0 0">' +
            esc(j.hint || j.detail || '') +
            '</p>' +
            extra +
            '<p class="muted" style="margin:8px 0 0">You can still use the <strong>data pack</strong> below without an LLM.</p></div>'
        );
      } else if (!j.ok && !j.fallback_markdown) {
        parts.push(
          '<div class="alert err"><strong>' + esc(j.error || 'request_failed') + '</strong><p class="muted">' + esc(j.detail || '') + '</p></div>'
        );
      }

      if (j.fallback_markdown) {
        parts.push(
          '<h3 class="muted" style="margin:16px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Data pack (markdown)</h3>' +
            '<p class="muted" style="margin:0 0 8px;font-size:12px">Safe to paste into Cursor as context together with the Cursor message.</p>' +
            '<textarea id="aiFallbackTa" class="brief-ta" readonly></textarea>' +
            '<div class="row" style="margin-top:8px;align-items:center">' +
            '<button type="button" class="ghost" id="btnCopyFallback">Copy data pack</button>' +
            '<span id="copyFbHint" class="path"></span></div>'
        );
      }

      if (j.ok && j.assistant_markdown) {
        var cursorMsg = extractCursorBlock(j.assistant_markdown) || j.assistant_markdown;
        window.__playshareCursorBrief = cursorMsg;
        window.__playshareAiBriefFull = j.assistant_markdown;
        parts.unshift(
          '<h3 class="muted" style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">AI-written brief</h3>' +
            '<p class="muted" style="margin:0 0 8px;font-size:12px">Model: <code>' +
            esc(j.model || '') +
            '</code> · Use <strong>Copy Cursor message</strong> for the short paste; the section <code>COPY_PASTE_FOR_CURSOR_AI</code> in the text is the same.</p>' +
            '<textarea id="aiMainTa" class="brief-ta" readonly></textarea>' +
            '<div class="row" style="margin-top:8px;align-items:center;flex-wrap:wrap;gap:8px">' +
            '<button type="button" class="primary" id="btnCopyCursor">Copy Cursor message</button> ' +
            '<button type="button" class="ghost" id="btnCopyAiFull">Copy full AI brief</button>' +
            '<span id="copyAiHint" class="path"></span></div>'
        );
        var metaBits = [];
        if (j.prior_runs_in_prompt != null) {
          metaBits.push('Prior briefs included in this prompt: <strong>' + esc(String(j.prior_runs_in_prompt)) + '</strong>');
        }
        if (j.learning_id) {
          metaBits.push('Saved to knowledge table <code class="mono-sm">' + esc(j.learning_id) + '</code> — future runs will use it.');
        }
        if (j.learning_persist_error) {
          metaBits.push('<span style="color:#fbbf24">Brief not saved: ' + esc(j.learning_persist_error) + '</span>');
        }
        if (metaBits.length) {
          parts.unshift(
            '<div style="margin-bottom:12px;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface2);font-size:13px;line-height:1.5">' +
              metaBits.join('<br/>') +
              '</div>'
          );
        }
      } else if (j.ok && j.dry_run) {
        window.__playshareDryContext = j.context;
        var pr = j.prior_runs_in_prompt != null ? esc(String(j.prior_runs_in_prompt)) : '?';
        parts.unshift(
          '<div class="alert ok" style="background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.35);color:#a7f3d0;padding:12px 14px;border-radius:10px;margin-bottom:12px">' +
            '<strong>Dry run</strong> — no LLM. Prior briefs that would be injected: <strong>' +
            pr +
            '</strong>. JSON context: <strong>Download context.json</strong>.</div>' +
            '<div class="row" style="margin-bottom:12px"><button type="button" class="ghost" id="btnDlContext">Download context.json</button></div>'
        );
      }

      out.innerHTML = parts.join('');
      var fb = $('aiFallbackTa');
      if (fb && j.fallback_markdown) fb.value = j.fallback_markdown;
      var main = $('aiMainTa');
      if (main && j.assistant_markdown) main.value = j.assistant_markdown;

      var dl = $('btnDlContext');
      if (dl) {
        dl.onclick = function () {
          var ctx = window.__playshareDryContext;
          if (!ctx) return;
          var blob = new Blob([JSON.stringify(ctx, null, 2)], { type: 'application/json' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'playshare-diag-context.json';
          a.click();
          URL.revokeObjectURL(a.href);
        };
      }
      var cf = $('btnCopyFallback');
      if (cf) {
        cf.onclick = function () {
          var ta = $('aiFallbackTa');
          copyText(ta && ta.value, $('copyFbHint'));
        };
      }
      var cc = $('btnCopyCursor');
      if (cc) {
        cc.onclick = function () {
          copyText(window.__playshareCursorBrief, $('copyAiHint'));
        };
      }
      var caf = $('btnCopyAiFull');
      if (caf) {
        caf.onclick = function () {
          copyText(window.__playshareAiBriefFull, $('copyAiHint'));
        };
      }
    } catch (e2) {
      st.textContent = 'Error';
      out.innerHTML =
        '<div class="alert err">' + esc(e2 && e2.message ? e2.message : String(e2)) + '</div>';
    } finally {
      btn.disabled = false;
    }
  };

  $('btnCopy').onclick = function () {
    if (!lastText) return;
    var btn = $('btnCopy');
    navigator.clipboard.writeText(lastText).then(function () {
      var prev = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = prev; }, 1400);
    }).catch(function () { alert('Clipboard unavailable'); });
  };
  $('btnDl').onclick = function () {
    if (!lastText) return;
    var blob = new Blob([lastText], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'playshare-intel-' + (lastPath.replace(/[^a-z0-9]+/gi, '-').slice(0, 48) || 'response') + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  function renderKnowledgeTable(entries) {
    var box = $('aiKnowledgeList');
    if (!entries || !entries.length) {
      box.innerHTML = '<p class="muted">No rows in <code>diag_intel_knowledge</code> yet. Run a successful AI brief with save enabled, or add a manual note.</p>';
      return;
    }
    var h =
      '<div style="overflow:auto"><table class="data-table"><thead><tr><th>When</th><th>Source</th><th>Platform</th><th>Model</th><th>Cases</th><th></th></tr></thead><tbody>';
    entries.forEach(function (e) {
      h +=
        '<tr><td>' +
        fmtWhen(e.created_at) +
        '</td><td>' +
        esc(e.source || '') +
        '</td><td>' +
        esc(e.focus_platform || '—') +
        '</td><td class="mono-sm">' +
        esc(e.model || '—') +
        '</td><td>' +
        esc(e.case_window != null ? String(e.case_window) : '—') +
        '</td><td><button type="button" class="linkish" data-kview="' +
        esc(e.id) +
        '">Open</button></td></tr>';
    });
    h += '</tbody></table></div>';
    box.innerHTML = h;
  }

  async function refreshKnowledgeList() {
    var box = $('aiKnowledgeList');
    box.innerHTML = '<span class="muted">Loading…</span>';
    try {
      var r = await fetch(intelApi('/knowledge?limit=25'), { headers: authHeaders() });
      var j = await r.json();
      if (j.ok && j.entries) renderKnowledgeTable(j.entries);
      else box.innerHTML = '<p class="muted">Could not load list: ' + esc(j.error || String(r.status)) + '</p>';
    } catch (x) {
      box.innerHTML = '<p class="muted">Network error</p>';
    }
  }

  $('btnListKnowledge').onclick = function () {
    refreshKnowledgeList();
  };

  $('aiKnowledgeList').addEventListener('click', async function (e) {
    var b = e.target.closest('[data-kview]');
    if (!b) return;
    var id = b.getAttribute('data-kview');
    var ta = $('aiKnowledgeViewTa');
    ta.style.display = 'block';
    ta.value = 'Loading…';
    try {
      var r = await fetch(intelApi('/knowledge?id=' + encodeURIComponent(id)), { headers: authHeaders() });
      var j = await r.json();
      if (j.ok && j.entry) ta.value = j.entry.digest_markdown || '';
      else ta.value = 'Error: ' + (j.error || String(r.status));
    } catch (x) {
      ta.value = 'Network error';
    }
  });

  $('btnSaveManualMemory').onclick = async function () {
    var t = ($('aiManualMemory').value || '').trim();
    var st = $('aiManualStatus');
    if (t.length < 20) {
      st.textContent = 'Enter at least 20 characters';
      return;
    }
    st.textContent = 'Saving…';
    try {
      var r = await fetch(intelApi('/knowledge'), {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify(withDiagAuthBody({
          digest_markdown: t,
          focus_platform: ($('aiFocusPlat').value || '').trim() || undefined
        }))
      });
      var j = await r.json();
      if (j.ok && j.learning_id) {
        st.textContent = 'Saved';
        $('aiManualMemory').value = '';
        refreshKnowledgeList();
      } else st.textContent = j.detail || j.error || String(r.status);
    } catch (x) {
      st.textContent = 'Network error';
    }
  };

  $('aiDryRun').addEventListener('change', function () {
    $('aiPersist').disabled = $('aiDryRun').checked;
    if ($('aiDryRun').checked) $('aiPersist').checked = false;
  });
})();
