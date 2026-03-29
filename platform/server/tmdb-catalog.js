/**
 * TMDB-backed catalog helpers (API key stays on the server).
 * @see https://developer.themoviedb.org/docs/getting-started
 */

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

const SPOTLIGHT_CACHE_MS = parseInt(process.env.PLAYSHARE_TMDB_CACHE_MS || '600000', 10);
const GENRE_CACHE_MS = parseInt(process.env.PLAYSHARE_TMDB_GENRE_CACHE_MS || '86400000', 10);

/** @type {Map<string, { at: number, payload: object }>} */
const cache = new Map();
/** @type {Map<string, { at: number, payload: object }>} */
const genreCache = new Map();

function cacheGet(map, key, ttlMs) {
  const row = map.get(key);
  if (!row) return null;
  if (Date.now() - row.at > ttlMs) {
    map.delete(key);
    return null;
  }
  return row.payload;
}

function cacheSet(map, key, payload) {
  map.set(key, { at: Date.now(), payload });
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

/** @param {object} row */
function normalizeMovieRow(row) {
  return {
    tmdbId: row.id,
    mediaType: 'movie',
    title: row.title || row.original_title || '',
    overview: trimOverview(row.overview, 220),
    posterUrl: row.poster_path ? `${IMAGE_BASE}/w342${row.poster_path}` : null,
    firstAirDate: row.release_date || null,
    voteAverage: typeof row.vote_average === 'number' ? row.vote_average : null
  };
}

/** @param {object} row */
function normalizeTvRow(row) {
  return {
    tmdbId: row.id,
    mediaType: 'tv',
    title: row.name || row.original_name || '',
    overview: trimOverview(row.overview, 220),
    posterUrl: row.poster_path ? `${IMAGE_BASE}/w342${row.poster_path}` : null,
    firstAirDate: row.first_air_date || null,
    voteAverage: typeof row.vote_average === 'number' ? row.vote_average : null
  };
}

const ATTRIBUTION =
  'This product uses the TMDB API but is not endorsed or certified by TMDB.';

/**
 * Trending TV (weekly) for dashboard spotlight — normalized for clients.
 * @param {string} apiKey
 */
async function getSpotlightTvWeek(apiKey) {
  const cacheKey = 'spotlight:tv:week:v1';
  const hit = cacheGet(cache, cacheKey, SPOTLIGHT_CACHE_MS);
  if (hit) return hit;

  const data = await tmdbFetchJson('/trending/tv/week', apiKey);
  const raw = Array.isArray(data.results) ? data.results : [];
  const results = raw.slice(0, 12).map((row) => normalizeTvRow(row));

  const payload = {
    source: 'tmdb',
    attribution: ATTRIBUTION,
    results
  };
  cacheSet(cache, cacheKey, payload);
  return payload;
}

/**
 * Multi search (movies + TV); drops people.
 * @param {string} apiKey
 * @param {string} query
 * @param {number} [page]
 */
async function searchMulti(apiKey, query, page = 1) {
  const q = String(query || '').trim().slice(0, 200);
  const p = Math.max(1, Math.min(500, parseInt(String(page), 10) || 1));
  if (q.length < 1) {
    return { source: 'tmdb', attribution: ATTRIBUTION, results: [], page: 1, totalPages: 0 };
  }
  const enc = encodeURIComponent(q);
  const data = await tmdbFetchJson(
    `/search/multi?query=${enc}&page=${p}&include_adult=false`,
    apiKey
  );
  const raw = Array.isArray(data.results) ? data.results : [];
  /** @type {ReturnType<normalizeMovieRow>[]} */
  const results = [];
  for (const row of raw) {
    if (row.media_type === 'movie') results.push(normalizeMovieRow(row));
    else if (row.media_type === 'tv') results.push(normalizeTvRow(row));
  }
  return {
    source: 'tmdb',
    attribution: ATTRIBUTION,
    results: results.slice(0, 20),
    page: p,
    totalPages: typeof data.total_pages === 'number' ? data.total_pages : 0
  };
}

/**
 * @param {string} apiKey
 * @param {'movie'|'tv'} media
 */
async function getGenreList(apiKey, media) {
  const m = media === 'movie' ? 'movie' : 'tv';
  const cacheKey = `genres:${m}:v1`;
  const hit = cacheGet(genreCache, cacheKey, GENRE_CACHE_MS);
  if (hit) return hit;

  const data = await tmdbFetchJson(`/genre/${m}/list`, apiKey);
  const genres = (Array.isArray(data.genres) ? data.genres : []).map((g) => ({
    id: g.id,
    name: g.name
  }));
  const payload = { source: 'tmdb', attribution: ATTRIBUTION, genres };
  cacheSet(genreCache, cacheKey, payload);
  return payload;
}

/**
 * @param {string} apiKey
 * @param {{ media: 'movie'|'tv', genreId: number, page?: number }} opts
 */
async function discoverByGenre(apiKey, opts) {
  const m = opts.media === 'movie' ? 'movie' : 'tv';
  const gid = parseInt(String(opts.genreId), 10);
  if (!Number.isFinite(gid) || gid < 1) {
    return { source: 'tmdb', attribution: ATTRIBUTION, results: [], page: 1, totalPages: 0 };
  }
  const p = Math.max(1, Math.min(500, parseInt(String(opts.page || 1), 10) || 1));
  const path = `/discover/${m}?with_genres=${gid}&page=${p}&sort_by=popularity.desc`;
  const data = await tmdbFetchJson(path, apiKey);
  const raw = Array.isArray(data.results) ? data.results : [];
  const norm = m === 'movie' ? normalizeMovieRow : normalizeTvRow;
  const results = raw.slice(0, 20).map((row) => norm(row));
  return {
    source: 'tmdb',
    attribution: ATTRIBUTION,
    results,
    page: p,
    totalPages: typeof data.total_pages === 'number' ? data.total_pages : 0
  };
}

module.exports = {
  getSpotlightTvWeek,
  searchMulti,
  getGenreList,
  discoverByGenre,
  ATTRIBUTION
};
