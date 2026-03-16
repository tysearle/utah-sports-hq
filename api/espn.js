// Vercel Serverless Function -- proxies ESPN API requests to avoid CORS issues.
// Deployed at /api/espn?path=<espn-path>
//
// Examples:
//   /api/espn?path=sports/hockey/nhl/teams/uta
//   /api/espn?path=sports/basketball/nba/teams/26/schedule
//   /api/espn?path=sports/hockey/nhl/standings

const ESPN_BASE_SITE = "https://site.api.espn.com/apis/site/v2";
const ESPN_BASE_V2 = "https://site.api.espn.com/apis/v2";
const ESPN_BASE_WEB = "https://site.web.api.espn.com/apis/v2";
const ESPN_BASE_CORE = "https://sports.core.api.espn.com/v2";

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

  try {
    const espnRes = await fetch(url, {
      headers: {
        "User-Agent": "UtahSportsHQ/1.0",
        Accept: "application/json",
      },
    });

    if (!espnRes.ok) {
      return res
        .status(espnRes.status)
        .json({ error: `ESPN returned ${espnRes.status}`, url });
    }

    const data = await espnRes.json();

    // Cache for 5 minutes at CDN level, 2 minutes in browser
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=120");
    res.setHeader("Access-Control-Allow-Origin", "*");

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message, url });
  }
}
