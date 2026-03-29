/**
 * Tactical lobby tile avatar (Warzone-style rim + scan) using PlayShare accent colors.
 * @param {{ color?: string, clientId?: string, username?: string, size?: 'md'|'sm'|'lg' }} [opts]
 * @returns {HTMLDivElement}
 */
export function createLobbyOperativeEl(opts = {}) {
  const raw = opts.color && String(opts.color).trim();
  const accent =
    raw && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)
      ? normalizeHex(raw)
      : defaultAccentFromSeed(`${opts.clientId || ''}|${opts.username || ''}`);
  const initials = (opts.username || '?').trim().slice(0, 2).toUpperCase() || '?';

  const wrap = document.createElement('div');
  let sizeClass = 'ps-operative';
  if (opts.size === 'sm') sizeClass = 'ps-operative ps-operative--sm';
  else if (opts.size === 'lg') sizeClass = 'ps-operative ps-operative--lg';
  wrap.className = sizeClass;
  wrap.style.setProperty('--op-accent', accent);
  wrap.setAttribute('aria-hidden', 'true');

  const spin = document.createElement('div');
  spin.className = 'ps-operative__spin';

  const inner = document.createElement('div');
  inner.className = 'ps-operative__inner';
  inner.textContent = initials;

  wrap.append(spin, inner);
  return wrap;
}

function normalizeHex(c) {
  let s = c.trim();
  if (s.length === 4 && s[0] === '#') {
    s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  return s.toLowerCase();
}

function defaultAccentFromSeed(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 58% 58%)`;
}
