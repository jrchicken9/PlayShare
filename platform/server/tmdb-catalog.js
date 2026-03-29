/**
 * TMDB-backed catalog helpers (API key stays on the server).
 * @see https://developer.themoviedb.org/docs/getting-started
 */

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

const SPOTLIGHT_CACHE_MS = parseInt(process.env.PLAYSHARE_TMDB_CACHE_MS || '600000', 10);
const GENRE_CACHE_MS = parseInt(process.env.PLAYSHARE_TMDB_GENRE_CACHE_MS || '86400000', 10);
const WATCH_PROVIDERS_CACHE_MS = parseInt(process.env.PLAYSHARE_TMDB_WATCH_CACHE_MS || '900000', 10);

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
 * Trending movies or TV (weekly) for dashboard spotlight — normalized for clients.
 * @param {string} apiKey
 * @param {'movie'|'tv'} media
 */
async function getSpotlightTrendingWeek(apiKey, media) {
  const m = media === 'movie' ? 'movie' : 'tv';
  const cacheKey = `spotlight:${m}:week:v1`;
  const hit = cacheGet(cache, cacheKey, SPOTLIGHT_CACHE_MS);
  if (hit) return hit;

  const data = await tmdbFetchJson(`/trending/${m}/week`, apiKey);
  const raw = Array.isArray(data.results) ? data.results : [];
  const norm = m === 'movie' ? normalizeMovieRow : normalizeTvRow;
  const results = raw.slice(0, 12).map((row) => norm(row));

  const payload = {
    source: 'tmdb',
    attribution: ATTRIBUTION,
    results,
    media: m
  };
  cacheSet(cache, cacheKey, payload);
  return payload;
}

/** @param {string} apiKey */
async function getSpotlightTvWeek(apiKey) {
  return getSpotlightTrendingWeek(apiKey, 'tv');
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

/**
 * Best-effort deep links for TMDB/JustWatch provider IDs (search by title).
 * @param {string} title
 * @returns {string | null}
 */
function openUrlForProvider(providerId, title) {
  const t = String(title || '').trim();
  if (!t) return null;
  const q = encodeURIComponent(t);
  /** @type {Record<number, string>} */
  const map = {
    8: `https://www.netflix.com/search?q=${q}`,
    1796: `https://www.netflix.com/search?q=${q}`,
    9: `https://www.primevideo.com/search?phrase=${q}`,
    10: `https://www.amazon.com/s?k=${q}&i=instant-video`,
    119: `https://www.primevideo.com/search?phrase=${q}`,
    337: `https://www.disneyplus.com/search?q=${q}`,
    15: `https://www.hulu.com/search?q=${q}`,
    384: `https://www.max.com/search?q=${q}`,
    1899: `https://www.max.com/search?q=${q}`,
    386: `https://www.peacocktv.com/search?q=${q}`,
    387: `https://www.peacocktv.com/search?q=${q}`,
    531: `https://www.paramountplus.com/search/?q=${q}`,
    350: `https://tv.apple.com/search?term=${q}`,
    283: `https://www.youtube.com/results?search_query=${q}`,
    528: `https://www.youtube.com/results?search_query=${q}`,
    230: `https://www.crave.ca/search?q=${q}`,
    468: `https://www.crave.ca/search?q=${q}`,
    2: `https://tv.apple.com/search?term=${q}`,
    3: `https://tv.apple.com/search?term=${q}`
  };
  const u = map[Number(providerId)];
  return u || null;
}

/**
 * @param {object | null | undefined} reg TMDB watch providers payload for one region
 * @returns {{ providerId: number, providerName: string, logoPath: string | null, monetization: string }[]}
 */
function mergeWatchProvidersForRegion(reg) {
  if (!reg || typeof reg !== 'object') return [];
  /** @type {Map<number, { providerId: number, providerName: string, logoPath: string | null, monetization: string }>} */
  const byId = new Map();
  const rank = { flatrate: 0, free: 0, rent: 1, buy: 2 };
  const add = (arr, monetization) => {
    if (!Array.isArray(arr)) return;
    for (const p of arr) {
      const id = p && typeof p.provider_id === 'number' ? p.provider_id : null;
      if (!id) continue;
      const name = String((p && p.provider_name) || 'Service').trim() || 'Service';
      const logoPath = p && typeof p.logo_path === 'string' ? p.logo_path : null;
      const prev = byId.get(id);
      const rPrev = prev ? rank[prev.monetization] ?? 9 : 99;
      const rNew = rank[monetization] ?? 9;
      if (!prev || rNew < rPrev) {
        byId.set(id, { providerId: id, providerName: name, logoPath, monetization });
      }
    }
  };
  add(reg.flatrate, 'flatrate');
  add(reg.free, 'free');
  add(reg.rent, 'rent');
  add(reg.buy, 'buy');
  return Array.from(byId.values()).sort((a, b) => {
    const ra = rank[a.monetization] ?? 9;
    const rb = rank[b.monetization] ?? 9;
    if (ra !== rb) return ra - rb;
    return (a.providerName || '').localeCompare(b.providerName || '');
  });
}

/**
 * @param {string} apiKey
 * @param {'movie'|'tv'} media
 * @param {number} tmdbId
 * @param {string} [titleHint] for openUrl generation
 * @param {string} [regionOverride] ISO country (default env PLAYSHARE_STREAMING_REGION or US)
 */
async function getWatchProviders(apiKey, media, tmdbId, titleHint = '', regionOverride = '') {
  const id = parseInt(String(tmdbId), 10);
  if (!Number.isFinite(id) || id < 1) {
    return { source: 'tmdb', attribution: ATTRIBUTION, ok: false, error: 'bad_id', providers: [] };
  }
  const m = media === 'movie' ? 'movie' : 'tv';
  const cacheKey = `watch:${m}:${id}:v1`;
  const hit = cacheGet(cache, cacheKey, WATCH_PROVIDERS_CACHE_MS);
  if (hit) {
    const title = String(titleHint || '').trim();
    return {
      ...hit,
      titleHint: title,
      providers: Array.isArray(hit.providers)
        ? hit.providers.map((p) => ({
            ...p,
            openUrl: openUrlForProvider(p.providerId, title)
          }))
        : []
    };
  }

  let data;
  try {
    data = await tmdbFetchJson(`/${m}/${id}/watch/providers`, apiKey);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    err.status = e && e.status;
    throw err;
  }

  const wantRegion = String(
    regionOverride || process.env.PLAYSHARE_STREAMING_REGION || 'US'
  )
    .toUpperCase()
    .slice(0, 8);
  const results = data && typeof data.results === 'object' ? data.results : {};
  const keys = Object.keys(results);
  const regionKey = keys.includes(wantRegion) ? wantRegion : keys.length ? keys[0] : null;
  const reg = regionKey ? results[regionKey] : null;
  const providersRaw = mergeWatchProvidersForRegion(reg);
  const title = String(titleHint || '').trim();
  const providers = providersRaw.map((p) => ({
    ...p,
    logoUrl: p.logoPath ? `${IMAGE_BASE}/w45${p.logoPath}` : null,
    openUrl: openUrlForProvider(p.providerId, title)
  }));

  const tmdbWatchPageUrl = reg && typeof reg.link === 'string' ? reg.link : null;

  const payload = {
    source: 'tmdb',
    attribution: ATTRIBUTION,
    ok: true,
    region: regionKey,
    tmdbWatchPageUrl,
    providers,
    rawResultKeys: keys
  };
  cacheSet(cache, cacheKey, payload);
  return { ...payload, titleHint: title };
}

module.exports = {
  getSpotlightTrendingWeek,
  getSpotlightTvWeek,
  searchMulti,
  getGenreList,
  discoverByGenre,
  getWatchProviders,
  ATTRIBUTION
};
