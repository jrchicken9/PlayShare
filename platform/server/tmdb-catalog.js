/**
 * TMDB-backed catalog helpers (API key stays on the server).
 * @see https://developer.themoviedb.org/docs/getting-started
 */

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

const SPOTLIGHT_CACHE_MS = parseInt(process.env.PLAYSHARE_TMDB_CACHE_MS || '600000', 10);

/** @type {Map<string, { at: number, payload: object }>} */
const cache = new Map();

function cacheGet(key) {
  const row = cache.get(key);
  if (!row) return null;
  if (Date.now() - row.at > SPOTLIGHT_CACHE_MS) {
    cache.delete(key);
    return null;
  }
  return row.payload;
}

function cacheSet(key, payload) {
  cache.set(key, { at: Date.now(), payload });
}

/**
 * @param {string} pathWithLeadingSlash e.g. /trending/tv/week
 * @param {string} apiKey
 */
async function tmdbFetchJson(pathWithLeadingSlash, apiKey) {
  const sep = pathWithLeadingSlash.includes('?') ? '&' : '?';
  const url = `${TMDB_BASE}${pathWithLeadingSlash}${sep}api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' }
  });
  if (!res.ok) {
    const err = new Error(`tmdb_http_${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function trimOverview(text, maxLen) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1).trim()}…`;
}

const ATTRIBUTION =
  'This product uses the TMDB API but is not endorsed or certified by TMDB.';

/**
 * Trending TV (weekly) for dashboard spotlight — normalized for clients.
 * @param {string} apiKey
 */
async function getSpotlightTvWeek(apiKey) {
  const cacheKey = 'spotlight:tv:week:v1';
  const hit = cacheGet(cacheKey);
  if (hit) return hit;

  const data = await tmdbFetchJson('/trending/tv/week', apiKey);
  const raw = Array.isArray(data.results) ? data.results : [];
  const results = raw.slice(0, 12).map((row) => ({
    tmdbId: row.id,
    mediaType: 'tv',
    title: row.name || row.original_name || '',
    overview: trimOverview(row.overview, 220),
    posterUrl: row.poster_path ? `${IMAGE_BASE}/w342${row.poster_path}` : null,
    firstAirDate: row.first_air_date || null,
    voteAverage: typeof row.vote_average === 'number' ? row.vote_average : null
  }));

  const payload = {
    source: 'tmdb',
    attribution: ATTRIBUTION,
    results
  };
  cacheSet(cacheKey, payload);
  return payload;
}

module.exports = {
  getSpotlightTvWeek,
  ATTRIBUTION
};
