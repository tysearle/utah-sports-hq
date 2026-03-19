// Vercel Serverless Function -- fetches live NCAA Tournament results from ESPN
// Returns game results mapped to our bracket game keys for scoring

const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard";

// Map ESPN team IDs / abbreviations to our internal team IDs
// This mapping connects ESPN's team data to our bracket data
const ESPN_TO_BRACKET = {
  // East
  "150": "duke", "399": "siena", "194": "ohiostate", "2628": "tcu",
  "2599": "stjohns", "2460": "northerniowa", "2305": "kansas", "68": "calbaptist",
  "97": "louisville", "58": "southflorida", "127": "michiganst", "2449": "ndakotast",
  "26": "ucla", "2116": "ucf", "41": "uconn", "231": "furman",
  // West
  "12": "arizona", "288": "liu", "222": "villanova", "328": "utahstate",
  "275": "wisconsin", "2314": "highpoint", "8": "arkansas", "62": "hawaii",
  "252": "byu", "2166": "gonzaga", "2320": "kennesawst",
  "2390": "miamifl", "142": "missouri", "2509": "purdue", "2547": "queens",
  // South
  "57": "florida", "2116": "ucf", "228": "clemson", "2294": "iowa",
  "238": "vanderbilt", "2377": "mcneese", "158": "nebraska", "2653": "troy",
  "153": "unc", "2670": "vcu", "356": "illinois", "219": "penn",
  "2608": "saintmarys", "245": "texasam", "248": "houston", "70": "idaho",
  // Midwest
  "130": "michigan", "2168": "georgia", "139": "saintlouis",
  "2641": "texastech", "2006": "akron", "333": "alabama", "2275": "hofstra",
  "2633": "tennessee", "258": "virginia", "2750": "wrightst",
  "96": "kentucky", "2541": "santaclara", "66": "iowastate", "2634": "tennesseest",
  // First Four teams
  "251": "texas", "152": "ncstate", "2674": "umbc", "47": "howard",
  "193": "miamioh", "2567": "smu",
  "2504": "pvamu", "2329": "lehigh",
};

// Alternative: match by team name if ESPN ID mapping fails
const NAME_TO_BRACKET = {};
// We'll build this dynamically from the response

// --------------- Origin Checking ---------------
const ALLOWED_ORIGINS = [
  "https://saltcitysportsutah.com",
  "https://www.saltcitysportsutah.com",
];

function getAllowedOrigin(req) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (origin.startsWith("http://localhost:")) return origin;
  if (origin.includes(".vercel.app")) return origin;
  return null;
}

export default async function handler(req, res) {
  const corsOrigin = getAllowedOrigin(req) || "https://www.saltcitysportsutah.com";
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");

  try {
    // Fetch NCAA tournament scoreboard - ESPN groups=100 is the NCAA tournament
    const dates = getTournamentDates();
    const allGames = [];

    for (const date of dates) {
      try {
        const url = `${ESPN_SCOREBOARD}?dates=${date}&groups=100&limit=100`;
        const resp = await fetch(url, {
          headers: { "User-Agent": "UtahSportsHQ/1.0", Accept: "application/json" },
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data.events) {
            for (const event of data.events) {
              const game = parseGame(event);
              if (game) allGames.push(game);
            }
          }
        }
      } catch (e) {
        console.error(`Error fetching date ${date}:`, e.message);
      }
    }

    // Also try the current scoreboard (live games)
    try {
      const liveUrl = `${ESPN_SCOREBOARD}?groups=100&limit=100`;
      const liveResp = await fetch(liveUrl, {
        headers: { "User-Agent": "UtahSportsHQ/1.0", Accept: "application/json" },
      });
      if (liveResp.ok) {
        const liveData = await liveResp.json();
        if (liveData.events) {
          for (const event of liveData.events) {
            const game = parseGame(event);
            if (game && !allGames.find((g) => g.espnId === game.espnId)) {
              allGames.push(game);
            }
          }
        }
      }
    } catch (e) {
      console.error("Error fetching live scoreboard:", e.message);
    }

    // Build results object: { winnerId, loserId, status, score }
    const results = {};
    for (const game of allGames) {
      if (game.winnerId) {
        results[game.espnId] = game;
      }
    }

    return res.status(200).json({
      games: allGames,
      results,
      lastUpdated: new Date().toISOString(),
      totalGames: allGames.length,
      completedGames: allGames.filter((g) => g.status === "final").length,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function parseGame(event) {
  try {
    const competition = event.competitions?.[0];
    if (!competition) return null;

    const competitors = competition.competitors || [];
    if (competitors.length !== 2) return null;

    const team1 = competitors[0];
    const team2 = competitors[1];

    const team1Id = mapTeam(team1.team);
    const team2Id = mapTeam(team2.team);

    const status = competition.status?.type?.name || event.status?.type?.name || "unknown";
    const statusDetail = competition.status?.type?.detail || event.status?.type?.detail || "";
    const isComplete = status === "STATUS_FINAL" || statusDetail.toLowerCase().includes("final");

    const score1 = parseInt(team1.score) || 0;
    const score2 = parseInt(team2.score) || 0;

    let winnerId = null;
    let loserId = null;
    if (isComplete && score1 !== score2) {
      winnerId = score1 > score2 ? team1Id : team2Id;
      loserId = score1 > score2 ? team2Id : team1Id;
    }

    // Try to determine round from event notes
    let round = null;
    const notes = event.notes || competition.notes || [];
    for (const note of notes) {
      const headline = (note.headline || "").toLowerCase();
      if (headline.includes("first four")) round = 0;
      else if (headline.includes("1st round") || headline.includes("first round") || headline.includes("round of 64")) round = 1;
      else if (headline.includes("2nd round") || headline.includes("second round") || headline.includes("round of 32")) round = 2;
      else if (headline.includes("sweet 16") || headline.includes("sweet sixteen") || headline.includes("regional semifinal")) round = 3;
      else if (headline.includes("elite 8") || headline.includes("elite eight") || headline.includes("regional final")) round = 4;
      else if (headline.includes("final four") || headline.includes("national semifinal")) round = 5;
      else if (headline.includes("championship") || headline.includes("national championship") || headline.includes("title game")) round = 6;
    }

    return {
      espnId: event.id,
      team1Id,
      team2Id,
      team1Name: team1.team?.displayName || team1.team?.name || "Unknown",
      team2Name: team2.team?.displayName || team2.team?.name || "Unknown",
      team1EspnId: team1.team?.id,
      team2EspnId: team2.team?.id,
      score1,
      score2,
      winnerId,
      loserId,
      round,
      status: isComplete ? "final" : status === "STATUS_IN_PROGRESS" ? "live" : "scheduled",
      statusDetail,
      startTime: event.date,
      broadcast: competition.broadcasts?.[0]?.names?.[0] || competition.geoBroadcasts?.[0]?.media?.shortName || "",
    };
  } catch (e) {
    return null;
  }
}

function mapTeam(espnTeam) {
  if (!espnTeam) return null;
  // Try ESPN ID first
  if (ESPN_TO_BRACKET[espnTeam.id]) return ESPN_TO_BRACKET[espnTeam.id];
  // Try abbreviation-based matching
  const abbr = (espnTeam.abbreviation || "").toLowerCase();
  const name = (espnTeam.displayName || espnTeam.name || "").toLowerCase();

  // Common name matching fallbacks
  const nameMap = {
    "duke": "duke", "siena": "siena", "ohio state": "ohiostate", "tcu": "tcu",
    "st. john's": "stjohns", "northern iowa": "northerniowa", "kansas": "kansas",
    "california baptist": "calbaptist", "louisville": "louisville", "south florida": "southflorida",
    "michigan state": "michiganst", "north dakota state": "ndakotast",
    "ucla": "ucla", "ucf": "ucf", "uconn": "uconn", "connecticut": "uconn", "furman": "furman",
    "arizona": "arizona", "liu": "liu", "long island": "liu", "villanova": "villanova",
    "utah state": "utahstate", "wisconsin": "wisconsin", "high point": "highpoint",
    "arkansas": "arkansas", "hawai'i": "hawaii", "hawaii": "hawaii",
    "byu": "byu", "brigham young": "byu", "gonzaga": "gonzaga", "kennesaw state": "kennesawst",
    "miami": "miamifl", "missouri": "missouri", "purdue": "purdue", "queens": "queens",
    "florida": "florida", "clemson": "clemson", "iowa": "iowa",
    "vanderbilt": "vanderbilt", "mcneese": "mcneese", "mcneese state": "mcneese",
    "nebraska": "nebraska", "troy": "troy",
    "north carolina": "unc", "unc": "unc", "vcu": "vcu", "virginia commonwealth": "vcu",
    "illinois": "illinois", "penn": "penn", "pennsylvania": "penn",
    "saint mary's": "saintmarys", "texas a&m": "texasam", "houston": "houston", "idaho": "idaho",
    "michigan": "michigan", "georgia": "georgia", "saint louis": "saintlouis",
    "texas tech": "texastech", "akron": "akron", "alabama": "alabama", "hofstra": "hofstra",
    "tennessee": "tennessee", "virginia": "virginia", "wright state": "wrightst",
    "kentucky": "kentucky", "santa clara": "santaclara", "iowa state": "iowastate",
    "tennessee state": "tennesseest",
    "texas": "texas", "nc state": "ncstate", "north carolina state": "ncstate",
    "umbc": "umbc", "howard": "howard",
    "miami (oh)": "miamioh", "miami ohio": "miamioh", "smu": "smu",
    "prairie view a&m": "pvamu", "prairie view": "pvamu", "lehigh": "lehigh",
  };

  for (const [pattern, id] of Object.entries(nameMap)) {
    if (name.includes(pattern)) return id;
  }
  return null;
}

function getTournamentDates() {
  // NCAA Tournament 2026 dates: March 17-19 (First Four), March 20-23 (R64/R32),
  // March 27-28 (Sweet 16/Elite 8), April 4 (Final Four), April 6 (Championship)
  const dates = [];
  // First Four
  dates.push("20260317", "20260318", "20260319");
  // Round of 64
  dates.push("20260320", "20260321");
  // Round of 32
  dates.push("20260322", "20260323");
  // Sweet 16
  dates.push("20260327", "20260328");
  // Elite 8
  dates.push("20260329", "20260330");
  // Final Four
  dates.push("20260404");
  // Championship
  dates.push("20260406");
  return dates;
}
