const ESPN_BASE = "https://site.api.espn.com/apis/site/v2";

export default async function handler(req, res) {
  const { path } = req.query;

  if (!path) {
    return res.status(400).json({ error: "Missing 'path' query parameter" });
  }

  if (!path.startsWith("sports/")) {
    return res.status(400).json({ error: "Path must start with 'sports/'" });
  }

  const url = `${ESPN_BASE}/${path}`;

  try {
    const espnRes = await fetch(url, {
      headers: {
        "User-Agent": "UtahSportsHQ/1.0",
        Accept: "application/json",
      },
    });

    if (!espnRes.ok) {
      return res.status(espnRes.status).json({ error: `ESPN returned ${espnRes.status}`, url });
    }

    const data = await espnRes.json();

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=120");
    res.setHeader("Access-Control-Allow-Origin", "*");

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message, url });
  }
}
