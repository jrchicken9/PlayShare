/**
 * Lightweight “Sync to host?” UI for DRM-passive platforms (user-confirmed one-shot seek).
 * @param {{ getMountParent?: () => HTMLElement }} [opts] — e.g. mount inside fullscreen element so the prompt stays visible over fullscreen video.
 */
export function createDrmSyncPromptHost(opts = {}) {
  const getMountParent =
    typeof opts.getMountParent === 'function' ? opts.getMountParent : () => document.body;
  let lastOfferAt = 0;
  let activeEl = null;

  function dismiss() {
    if (activeEl && activeEl.parentNode) activeEl.parentNode.removeChild(activeEl);
    activeEl = null;
  }

  return {
    /**
     * @param {{ headline?: string, detail?: string, minIntervalMs?: number, onConfirm?: () => void }} opts
     */
    offer(opts) {
      const minIntervalMs = opts.minIntervalMs ?? 8000;
      const now = Date.now();
      if (now - lastOfferAt < minIntervalMs) return;
      lastOfferAt = now;
      if (activeEl) dismiss();

      const wrap = document.createElement('div');
      wrap.setAttribute('role', 'dialog');
      wrap.style.cssText = [
        'position:fixed', 'z-index:2147483647', 'right:16px', 'bottom:16px', 'max-width:320px',
        'padding:14px 16px', 'border-radius:12px',
        'background:rgba(18,20,24,0.96)', 'color:#e8eaed', 'font:13px/1.45 system-ui,sans-serif',
        'box-shadow:0 8px 32px rgba(0,0,0,0.55)', 'border:1px solid rgba(255,255,255,0.1)'
      ].join(';');

      const h = document.createElement('div');
      h.style.cssText = 'font-weight:700;margin-bottom:8px;font-size:14px';
      h.textContent = opts.headline || 'Sync to host?';

      const d = document.createElement('div');
      d.style.cssText = 'opacity:0.9;margin-bottom:12px';
      d.textContent = opts.detail || '';

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

      const btnCancel = document.createElement('button');
      btnCancel.type = 'button';
      btnCancel.textContent = 'Not now';
      btnCancel.style.cssText =
        'padding:8px 12px;border-radius:8px;border:1px solid #444;background:transparent;color:#ccc;cursor:pointer;font:inherit';

      const btnOk = document.createElement('button');
      btnOk.type = 'button';
      btnOk.textContent = 'Sync';
      btnOk.style.cssText =
        'padding:8px 14px;border-radius:8px;border:none;background:#E50914;color:#fff;cursor:pointer;font:inherit;font-weight:600';

      btnCancel.addEventListener('click', () => dismiss());
      btnOk.addEventListener('click', () => {
        dismiss();
        try {
          if (typeof opts.onConfirm === 'function') opts.onConfirm();
        } catch { /* ignore */ }
      });

      row.appendChild(btnCancel);
      row.appendChild(btnOk);
      wrap.appendChild(h);
      wrap.appendChild(d);
      wrap.appendChild(row);
      try {
        getMountParent().appendChild(wrap);
      } catch {
        try {
          document.body.appendChild(wrap);
        } catch {
          /* ignore */
        }
      }
      activeEl = wrap;
    },
    /** Call on fullscreen changes so an open prompt stays in the top layer. */
    reparentIfVisible() {
      if (!activeEl || !activeEl.parentNode) return;
      const p = getMountParent();
      try {
        if (activeEl.parentElement !== p) p.appendChild(activeEl);
      } catch {
        /* ignore */
      }
    }
  };
}
