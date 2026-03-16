// Vercel Serverless Function -- proxies ESPN API requests to avoid CORS issues.
// Deployed at /api/espn?path=<espn-path>
//
// Features:
//   - In-memory cache with smart TTLs (survives warm function instances)
//   - Stale-while-revalidate: serves stale cache while fetching fresh data
//   - Different TTLs based on data type (schedule vs standings vs roster)
//
// Examples:
//   /api/espn?path=sports/hockey/nhl/teams/uta
//   /api/espn?path=sports/basketball/nba/teams/26/schedule
//   /api/espn?path=sports/hockey/nhl/standings

const ESPN_BASE_SITE = "https://site.api.espn.com/apis/site/v2";
const ESPN_BASE_V2 = "https://site.api.espn.com/apis/v2";
const ESPN_BASE_WEB = "https://site.web.api.espn.com/apis/v2";
const ESPN_BASE_CORE = "https://sports.core.api.espn.com/v2";

// --------------- In-Memory Cache ---------------
// Persists across requests on warm Vercel function instances.
// Each entry: { data, timestamp, staleAt, expireAt }
const cache = new Map();

// Max cache entries to prevent memory bloat
const MAX_CACHE_SIZE = 500;

// TTL config in seconds based on path patterns
function getTTL(path) {
  // Schedule data changes frequently (scores, game status)
  if (path.includes("/schedule")) return { fresh: 120, stale: 300 }; // 2 min fresh, 5 min stale
  // Standings update after games
  if (path.includes("/standings")) return { fresh: 300, stale: 900 }; // 5 min fresh, 15 min stale
  // Roster changes are rare
  if (path.includes("/roster")) return { fresh: 3600, stale: 7200 }; // 1 hr fresh, 2 hr stale
  // Player statistics update after games
  if (path.includes("/statistics")) return { fresh: 600, stale: 1800 }; // 10 min fresh, 30 min stale
  // Team info is very stable
  if (path.match(/\/teams\/[^/]+$/)) return { fresh: 3600, stale: 7200 }; // 1 hr fresh, 2 hr stale
  // Default
  return { fresh: 180, stale: 600 }; // 3 min fresh, 10 min stale
}

function getCacheKey(url) {
  return url;
}

function evictExpired() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now > entry.expireAt) {
      cache.delete(key);
    }
  }
}

function evictOldestIfNeeded() {
  if (cache.size <= MAX_CACHE_SIZE) return;
  // Delete oldest entries first
  const entries = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
  const toDelete = entries.slice(0, cache.size - MAX_CACHE_SIZE + 50); // free up 50 slots
  for (const [key] of toDelete) {
    cache.delete(key);
  }
}

// --------------- Handler ---------------
export default async function handler(req, res) {
  const { path, v2, web, core, ...extra } = req.query;

  if (!path) {
    return res.status(400).json({ error: "Missing 'path' query parameter" });
  }

  // Only allow ESPN sports API paths
  if (!path.startsWith("sports/")) {
    return res.status(400).json({ error: "Path must start with 'sports/'" });
  }

  const base = core !== undefined ? ESPN_BASE_CORE : web !== undefined ? ESPN_BASE_WEB : v2 !== undefined ? ESPN_BASE_V2 : ESPN_BASE_SITE;
  // Forward extra query params (season, seasontype, etc.)
  const params = new URLSearchParams(extra);
  const qs = params.toString() ? `?${params.toString()}` : "";
  const url = `${base}/${path}${qs}`;

  const cacheKey = getCacheKey(url);
  const now = Date.now();
  const cached = cache.get(cacheKey);
  const ttl = getTTL(path);

  // Check cache
  if (cached) {
    const isFresh = now < cached.staleAt;
    const isStale = now >= cached.staleAt && now < cached.expireAt;

    if (isFresh) {
      // Serve fresh cache immediately
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=120");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("X-Cache", "HIT");
      return res.status(200).json(cached.data);
    }

    if (isStale) {
      // Serve stale cache immediately, revalidate in background
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=120");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("X-Cache", "STALE");

      // Fire-and-forget background revalidation
      fetchAndCache(url, cacheKey, ttl).catch(() => {});

      return res.status(200).json(cached.data);
    }
    // Expired — fall through to fetch
  }

  // Cache miss or expired — fetch from ESPN
  try {
    const data = await fetchAndCache(url, cacheKey, ttl);

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=120");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("X-Cache", "MISS");

    return res.status(200).json(data);
  } catch (err) {
    // If we have stale/expired data and the fetch fails, serve it as fallback
    if (cached) {
      res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=60");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("X-Cache", "FALLBACK");
      return res.status(200).json(cached.data);
    }
    return res.status(err.status || 500).json({ error: err.message, url });
  }
}

// --------------- Fetch + Cache Helper ---------------
async function fetchAndCache(url, cacheKey, ttl) {
  const espnRes = await fetch(url, {
    headers: {
      "User-Agent": "SaltCitySports/1.0",
      Accept: "application/json",
    },
  });

  if (!espnRes.ok) {
    const err = new Error(`ESPN returned ${espnRes.status}`);
    err.status = espnRes.status;
    throw err;
  }

  const data = await espnRes.json();
  const now = Date.now();

  // Store in cache
  cache.set(cacheKey, {
    data,
    timestamp: now,
    staleAt: now + ttl.fresh * 1000,
    expireAt: now + ttl.stale * 1000,
  });

  // Periodic cleanup
  evictExpired();
  evictOldestIfNeeded();

  return data;
}
