import { useState, useEffect, useCallback, useRef } from "react";
import { auth, db, googleProvider, signInWithPopup, signOut } from "./firebase";
import { onAuthStateChanged } from "firebase/auth";
import { doc, setDoc, collection, getDocs, query, orderBy } from "firebase/firestore";
import BracketChallenge, { loadUserEntries } from "./BracketChallenge";

// --- Admin Config ---
const ADMIN_EMAILS = ["t.m.searle@gmail.com"];

// --- Register user in Firestore on sign-in ---
async function registerUser(u) {
  if (!u) return;
  try {
    await setDoc(doc(db, "users", u.uid), {
      uid: u.uid,
      displayName: u.displayName || "Anonymous",
      email: u.email || null,
      photoURL: u.photoURL || null,
      lastLogin: new Date().toISOString(),
    }, { merge: true });
  } catch (e) {
    console.error("User registration error:", e);
  }
}

// --- Auth Hook ---
function useAuth() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
      if (u) registerUser(u);
    });
    return unsub;
  }, []);

  const login = async () => {
    try {
      const result = await signInWithPopup(auth, googleProvider);
      if (result.user) registerUser(result.user);
    } catch (e) {
      console.error("Sign-in error:", e);
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
    } catch (e) {
      console.error("Sign-out error:", e);
    }
  };

  const isAdmin = user && ADMIN_EMAILS.includes(user.email);

  return { user, authLoading, login, logout, isAdmin };
}

// --- Team Configuration ---
// ESPN team IDs and API paths for each Utah team

const TEAMS_CONFIG = [
  {
    id: "mammoth",
    name: "Utah Mammoth",
    shortName: "Mammoth",
    logo: "https://a.espncdn.com/i/teamlogos/nhl/500/uta.png",
    accent: "#6CACE4",
    league: "NHL",
    leagueTag: "NHL",
    conference: "Central Division",
    espnUrl: "https://www.espn.com/nhl/team/_/name/utah/utah-mammoth",
    ticketUrl: "https://www.ticketmaster.com/utah-mammoth-tickets/artist/3170222",
    venue: "Delta Center",
    // ESPN API paths (proxied through /api/espn?path=...)
    apiTeam: "sports/hockey/nhl/teams/uta",
    apiSchedule: "sports/hockey/nhl/teams/uta/schedule",
    apiStandings: "sports/hockey/nhl/standings",
    apiRoster: "sports/hockey/nhl/teams/uta/roster",
    teamId: "uta",
    espnAbbr: "UTAH",
    sport: "hockey",
    isHockey: true,
    showPlayoffOdds: true,
    hasSalary: true,
    salaryCap: "$88M",
  },
  {
    id: "jazz",
    name: "Utah Jazz",
    shortName: "Jazz",
    logo: "https://a.espncdn.com/i/teamlogos/nba/500/utah.png",
    accent: "#6B3FA0",
    league: "NBA",
    leagueTag: "NBA",
    conference: "Western Conference",
    espnUrl: "https://www.espn.com/nba/team/_/name/utah/utah-jazz",
    ticketUrl: "https://www.nba.com/jazz/tickets",
    venue: "Delta Center",
    apiTeam: "sports/basketball/nba/teams/26",
    apiSchedule: "sports/basketball/nba/teams/26/schedule",
    apiStandings: "sports/basketball/nba/standings",
    apiRoster: "sports/basketball/nba/teams/26/roster",
    teamId: "26",
    espnAbbr: "UTAH",
    sport: "basketball",
    isHockey: false,
    showPlayoffOdds: false,
    hasSalary: true,
    salaryCap: "$140.6M",
  },
  {
    id: "utes-football",
    name: "Utah Utes Football",
    shortName: "Utes FB",
    logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/254.png",
    accent: "#CC0000",
    league: "NCAA",
    leagueTag: "NCAAF",
    conference: "Big 12",
    espnUrl: "https://www.espn.com/college-football/team/_/id/254/utah-utes",
    ticketUrl: "https://utahutes.com/sports/football/schedule",
    venue: "Rice-Eccles Stadium",
    apiTeam: "sports/football/college-football/teams/254",
    apiSchedule: "sports/football/college-football/teams/254/schedule",
    apiStandings: "sports/football/college-football/standings",
    apiRoster: "sports/football/college-football/teams/254/roster",
    teamId: "254",
    espnAbbr: "UTAH",
    sport: "football",
    isHockey: false,
    showPlayoffOdds: false,
    hasSalary: false,
    salaryCap: null,
  },
  {
    id: "utes-basketball",
    name: "Utah Utes Basketball",
    shortName: "Utes BBall",
    logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/254.png",
    accent: "#CC0000",
    league: "NCAA",
    leagueTag: "NCAAM",
    conference: "Big 12",
    espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/254/utah-utes",
    ticketUrl: "https://utahutes.com/sports/mens-basketball/schedule",
    venue: "Jon M. Huntsman Center",
    apiTeam: "sports/basketball/mens-college-basketball/teams/254",
    apiSchedule: "sports/basketball/mens-college-basketball/teams/254/schedule",
    apiStandings: "sports/basketball/mens-college-basketball/standings",
    apiRoster: "sports/basketball/mens-college-basketball/teams/254/roster",
    teamId: "254",
    espnAbbr: "UTAH",
    sport: "basketball",
    isHockey: false,
    showPlayoffOdds: false,
    hasSalary: false,
    salaryCap: null,
  },
  {
    id: "utes-baseball",
    name: "Utah Utes Baseball",
    shortName: "Utes BSB",
    logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/254.png",
    accent: "#CC0000",
    league: "NCAA",
    leagueTag: "NCAAB",
    conference: "Big 12",
    espnUrl: "https://www.espn.com/college-baseball/team/_/id/254/utah-utes",
    ticketUrl: "https://utahutes.com/sports/baseball/schedule",
    venue: "America First Ballpark",
    apiTeam: "sports/baseball/college-baseball/teams/254",
    apiSchedule: "sports/baseball/college-baseball/teams/254/schedule",
    apiStandings: "sports/baseball/college-baseball/standings",
    apiRoster: "sports/baseball/college-baseball/teams/254/roster",
    teamId: "254",
    espnAbbr: "UTAH",
    sport: "baseball",
    isHockey: false,
    showPlayoffOdds: false,
    hasSalary: false,
    salaryCap: null,
  },
];

// --- API Helper---
// In development, Vite proxies /api to ESPN directly.
// In production on Vercel, /api/espn serverless function handles the proxy.

async function fetchESPN(apiPath, useV2 = false) {
  // Vercel serverless route
  const url = `/api/espn?path=${encodeURIComponent(apiPath)}${useV2 ? '&v2' : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// --- ESPN Data Parser Hook---
function useTeamData(team) {
  const [schedule, setSchedule] = useState(null);
  const [standings, setStandings] = useState(null);
  const [record, setRecord] = useState("Loading...");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const hasLiveRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        // Derive scoreboard path from apiSchedule (e.g. "sports/basketball/nba/teams/26/schedule" -> "sports/basketball/nba/scoreboard")
        const scoreboardPath = team.apiSchedule.replace(/\/teams\/.*$/, "/scoreboard");
        const [teamData, schedData, standData, scoreboardData] = await Promise.allSettled([
          fetchESPN(team.apiTeam),
          fetchESPN(team.apiSchedule),
          fetchESPN(team.apiStandings, true),
          fetchESPN(scoreboardPath),
        ]);

        if (cancelled) return;

        // Build a map of live scores from the scoreboard endpoint
        const liveScoreMap = {};
        if (scoreboardData.status === "fulfilled") {
          const sbEvents = scoreboardData.value?.events || [];
          for (const ev of sbEvents) {
            const comp = ev.competitions?.[0];
            const statusName = comp?.status?.type?.name || "";
            if (statusName.includes("IN_PROGRESS")) {
              const teamComp = comp?.competitors?.find(
                (c) => String(c.team?.id) === String(team.teamId) || c.team?.abbreviation?.toLowerCase() === team.teamId?.toLowerCase()
              );
              if (teamComp) {
                const opp = comp.competitors.find((c) => c !== teamComp);
                liveScoreMap.us = parseInt(teamComp.score || "0");
                liveScoreMap.them = parseInt(opp?.score || "0");
                liveScoreMap.detail = comp.status?.type?.shortDetail || "";
                liveScoreMap.oppName = opp?.team?.displayName || "";
              }
            }
          }
        }

        // -- Parse record--
        if (teamData.status === "fulfilled") {
          const t = teamData.value?.team;
          if (t) {
            const rec = t.record?.items?.[0]?.summary;
            if (team.isHockey) {
              const stats = t.record?.items?.[0]?.stats || [];
              const w = stats.find((s) => s.name === "wins")?.value;
              const l = stats.find((s) => s.name === "losses")?.value;
              const otl = stats.find((s) => s.name === "otLosses")?.value;
              const pts = stats.find((s) => s.name === "points")?.value;
              setRecord(w != null ? `${w}-${l}-${otl} | ${pts} PTS` : rec || "--");
            } else {
              setRecord(rec || "--");
            }
          }
        }

        // -- Parse schedule--
        if (schedData.status === "fulfilled") {
          const raw = schedData.value;
          const allEvents = raw?.events || raw?.requestedSeason?.events || [];
          // Find games around today: last 5 completed + next 5 upcoming
          const now = new Date();
          const completed = [];
          const upcoming = [];
          for (const ev of allEvents) {
            const sn = ev.competitions?.[0]?.status?.type?.name || ev.status?.type?.name || "";
            const done = sn.includes("FINAL") || sn === "post" || sn === "STATUS_FINAL";
            if (done) completed.push(ev);
            else upcoming.push(ev);
          }
          const events = [...completed.slice(-5), ...upcoming.slice(0, 5)];
          const parsed = events.map((ev) => {
            const comp = ev.competitions?.[0];
            const us = comp?.competitors?.find(
              (c) => String(c.id) === String(team.teamId) || c.team?.abbreviation?.toLowerCase() === team.teamId?.toLowerCase()
            );
            const them = comp?.competitors?.find((c) => c !== us);
            const isHome = us?.homeAway === "home";
            const bcast =
              comp?.broadcasts?.[0]?.names?.[0] ||
              comp?.geoBroadcasts?.[0]?.media?.shortName ||
              "--";
            const statusName = comp?.status?.type?.name || ev.status?.type?.name || "";
            const isFinal = statusName.includes("FINAL") || statusName === "post";
            const isLive = statusName.includes("IN_PROGRESS") || statusName === "STATUS_IN_PROGRESS" || statusName === "in";
            const statusDetail = comp?.status?.type?.shortDetail || comp?.status?.shortDetail || ev.status?.type?.shortDetail || "";

            let result = "";
            let liveScore = null;
            if ((isFinal || isLive) && us && them) {
              const usS = parseInt(us.score?.displayValue || us.score || "0");
              const thS = parseInt(them.score?.displayValue || them.score || "0");
              if (isFinal) {
                result = usS > thS ? `W ${usS}-${thS}` : usS < thS ? `L ${usS}-${thS}` : `T ${usS}-${thS}`;
              }
              if (isLive) {
                // Prefer scoreboard data (has real-time scores) over schedule data
                if (liveScoreMap.detail) {
                  liveScore = { us: liveScoreMap.us, them: liveScoreMap.them, detail: liveScoreMap.detail };
                } else {
                  liveScore = { us: usS, them: thS, detail: statusDetail };
                }
              }
            }

            return {
              date: ev.date || comp?.date,
              opponent: them?.team?.displayName || them?.team?.shortDisplayName || "TBD",
              opponentAbbr: them?.team?.abbreviation || "",
              opponentLogo: them?.team?.logos?.[0]?.href || them?.team?.logo || null,
              home: isHome,
              result,
              status: isLive ? "live" : isFinal ? "post" : "pre",
              broadcast: bcast,
              liveScore,
            };
          });
          hasLiveRef.current = parsed.some((g) => g.status === "live");
          setSchedule(parsed);
        }

        // -- Parse standings--
        if (standData.status === "fulfilled") {
          const raw = standData.value;
          const groups = raw?.children || [];
          let found = [];

          for (const group of groups) {
            // Some structures nest deeper
            const subGroups = group.children || [group];
            for (const sub of subGroups) {
              const entries = sub.standings?.entries || [];
              const match = entries.find(
                (e) =>
                  String(e.team?.id) === String(team.teamId) ||
                  e.team?.abbreviation?.toLowerCase() === team.teamId?.toLowerCase() ||
                  e.team?.abbreviation === team.espnAbbr
              );
              if (match) {
                found = entries.map((e) => {
                  const st = (name) => e.stats?.find((s) => s.name === name);
                  return {
                    team: e.team?.shortDisplayName || e.team?.displayName || "--",
                    logo: e.team?.logos?.[0]?.href,
                    wins: st("wins")?.value ?? st("wins")?.displayValue ?? 0,
                    losses: st("losses")?.value ?? st("losses")?.displayValue ?? 0,
                    otl: st("otLosses")?.value ?? st("OTLosses")?.displayValue ?? 0,
                    pts: st("points")?.value ?? st("points")?.displayValue ?? 0,
                    pct: st("winPercent")?.displayValue ?? st("winPct")?.displayValue ?? "--",
                    gb: st("gamesBehind")?.displayValue ?? "--",
                    overall: st("overall")?.displayValue ?? "",
                    isTarget:
                      String(e.team?.id) === String(team.teamId) ||
                      e.team?.abbreviation?.toLowerCase() === team.teamId?.toLowerCase() ||
                      e.team?.abbreviation === team.espnAbbr,
                  };
                });
                break;
              }
            }
            if (found.length > 0) break;
          }
          setStandings(found.slice(0, 16));
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    // Dynamic refresh: 30s when live game detected, 5min otherwise
    let timerId = null;
    function tick() {
      const delay = hasLiveRef.current ? 30 * 1000 : 5 * 60 * 1000;
      timerId = setTimeout(() => {
        load().then(() => { if (!cancelled) tick(); });
      }, delay);
    }
    tick();
    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, [team.id]);

  return { schedule, standings, record, loading, error };
}

// --- Roster Data Hook ---
function useRosterData(team) {
  const [roster, setRoster] = useState(null);
  const [rosterLoading, setRosterLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setRosterLoading(true);
      try {
        const data = await fetchESPN(team.apiRoster);
        if (cancelled) return;

        let players = [];
        // NBA roster is a flat array
        if (Array.isArray(data.athletes) && data.athletes.length > 0 && data.athletes[0]?.fullName) {
          players = data.athletes.map(p => ({
            name: p.displayName || p.fullName,
            jersey: p.jersey || "--",
            position: p.position?.abbreviation || p.position?.displayName || "--",
            age: p.age || "--",
            experience: p.experience?.years ?? "--",
            salary: p.contract?.salary || null,
            yearsRemaining: p.contract?.yearsRemaining ?? null,
            headshot: p.headshot?.href,
            status: p.status?.name || "Active",
          }));
        }
        // NHL/College roster is grouped by position
        else if (data.athletes) {
          for (const group of data.athletes) {
            const items = group.items || [];
            for (const p of items) {
              players.push({
                name: p.displayName || p.fullName,
                jersey: p.jersey || "--",
                position: p.position?.abbreviation || p.position?.displayName || "--",
                age: p.age || "--",
                experience: p.experience?.years ?? "--",
                salary: p.contract?.salary || null,
                yearsRemaining: p.contract?.yearsRemaining ?? null,
                headshot: p.headshot?.href,
                status: p.status?.name || "Active",
              });
            }
          }
        }

        // Sort by jersey number
        players.sort((a, b) => {
          const na = parseInt(a.jersey) || 999;
          const nb = parseInt(b.jersey) || 999;
          return na - nb;
        });

        setRoster(players);
      } catch (e) {
        if (!cancelled) setRoster([]);
      } finally {
        if (!cancelled) setRosterLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [team.id]);

  return { roster, rosterLoading };
}

// --- Utility helpers---
function formatDate(d) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function formatTime(d) {
  return new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function formatDayDate(d) {
  return new Date(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// --- Tabs---
function Tabs({ tabs, accent }) {
  const [active, setActive] = useState(0);
  return (
    <div>
      <div style={{ display: "flex", gap: 2, marginBottom: 12, borderBottom: `1px solid ${accent}33` }}>
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            onClick={() => setActive(i)}
            style={{
              background: active === i ? accent + "22" : "transparent",
              color: active === i ? accent : "#aaa",
              border: "none",
              borderBottom: active === i ? `2px solid ${accent}` : "2px solid transparent",
              padding: "8px 14px", fontSize: 12,
              fontWeight: active === i ? 700 : 500,
              cursor: "pointer", transition: "all 0.2s",
              letterSpacing: 0.3, textTransform: "uppercase",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div style={{ minHeight: 200 }}>{tabs[active]?.content}</div>
    </div>
  );
}

// --- Schedule Tab---
function ScheduleTab({ schedule, accent }) {
  if (!schedule || schedule.length === 0)
    return <div style={{ color: "#777", padding: 12 }}>No schedule data available</div>;
  const live = schedule.filter((g) => g.status === "live");
  const recent = schedule.filter((g) => g.status === "post");
  const upcoming = schedule.filter((g) => g.status === "pre");

  return (
    <div>
      {/* LIVE GAMES */}
      {live.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          {live.map((g, i) => (
            <div key={`live-${i}`} style={{
              background: "linear-gradient(135deg, #CC000018, #ff440018)",
              border: "1px solid #CC000044",
              borderRadius: 10, padding: "12px 14px", marginBottom: 8,
              animation: "livePulse 2s ease-in-out infinite",
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{
                    background: "#CC0000", color: "#fff", fontSize: 9, fontWeight: 800,
                    padding: "2px 8px", borderRadius: 4, letterSpacing: 1,
                    animation: "liveBlink 1.5s ease-in-out infinite",
                  }}>LIVE</span>
                  <span style={{ color: "#888", fontSize: 11 }}>{g.home ? "vs" : "@"} {g.opponent}</span>
                </div>
                <span style={{ color: "#888", fontSize: 10 }}>{g.broadcast}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16 }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ color: accent, fontSize: 28, fontWeight: 900, fontFamily: "monospace" }}>
                    {g.liveScore?.us ?? 0}
                  </div>
                </div>
                <div style={{ color: "#555", fontSize: 12, textAlign: "center" }}>
                  <div style={{ fontWeight: 700, color: "#CC0000", fontSize: 10 }}>
                    {g.liveScore?.detail || "In Progress"}
                  </div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ color: "#999", fontSize: 28, fontWeight: 900, fontFamily: "monospace" }}>
                    {g.liveScore?.them ?? 0}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {recent.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={subheaderStyle}>Recent Results</div>
          {recent.slice(-5).map((g, i) => (
            <div key={i} style={rowStyle(i)}>
              <div style={{ flex: 1 }}>
                <span style={{ color: "#999", fontSize: 11 }}>{formatDate(g.date)}</span>
                <span style={{ color: "#555", fontSize: 11, margin: "0 6px" }}>{g.home ? "vs" : "@"}</span>
                <span style={{ color: "#eee", fontSize: 13, fontWeight: 500 }}>{g.opponent}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ color: "#666", fontSize: 10 }}>{g.broadcast}</span>
                <span style={{
                  color: g.result?.startsWith("W") ? "#4CAF50" : "#f44336",
                  fontWeight: 700, fontSize: 13, fontFamily: "monospace",
                  minWidth: 80, textAlign: "right",
                }}>
                  {g.result}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      {upcoming.length > 0 && (
        <div>
          <div style={subheaderStyle}>Upcoming Games</div>
          {upcoming.slice(0, 5).map((g, i) => (
            <div key={i} style={rowStyle(i)}>
              <div style={{ flex: 1 }}>
                <div style={{ color: "#999", fontSize: 11 }}>{formatDayDate(g.date)}</div>
                <div>
                  <span style={{ color: "#555", fontSize: 11 }}>{g.home ? "vs" : "@"}</span>{" "}
                  <span style={{ color: "#eee", fontSize: 13, fontWeight: 500 }}>{g.opponent}</span>
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: accent, fontSize: 12, fontWeight: 600 }}>{formatTime(g.date)}</div>
                <div style={{ color: "#888", fontSize: 11 }}>TV: {g.broadcast}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Standings Tab---
function StandingsTab({ standings, accent, team }) {
  if (!standings || standings.length === 0)
    return <div style={{ color: "#777", padding: 12 }}>Standings not available</div>;

  return (
    <div>
      <div style={subheaderStyle}>{team.conference}</div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ color: "#666", borderBottom: "1px solid #333" }}>
            <th style={thStyle}>#</th>
            <th style={{ ...thStyle, textAlign: "left" }}>Team</th>
            <th style={thStyle}>W</th>
            <th style={thStyle}>L</th>
            {team.isHockey && <th style={thStyle}>OTL</th>}
            <th style={thStyle}>{team.isHockey ? "PTS" : team.league === "NBA" ? "GB" : "Overall"}</th>
          </tr>
        </thead>
        <tbody>
          {standings.map((e, i) => (
            <tr key={i} style={{
              background: e.isTarget ? accent + "18" : i % 2 === 0 ? "#1a1a2e" : "transparent",
              borderLeft: e.isTarget ? `3px solid ${accent}` : "3px solid transparent",
            }}>
              <td style={{ ...tdStyle, color: "#888" }}>{i + 1}</td>
              <td style={{ ...tdStyle, textAlign: "left", color: e.isTarget ? accent : "#ddd", fontWeight: e.isTarget ? 700 : 400 }}>
                {e.logo && <img src={e.logo} alt="" style={{ width: 14, height: 14, borderRadius: 2, marginRight: 6, verticalAlign: "middle" }} />}
                {e.team}
              </td>
              <td style={tdStyle}>{e.wins}</td>
              <td style={tdStyle}>{e.losses}</td>
              {team.isHockey && <td style={tdStyle}>{e.otl}</td>}
              <td style={{ ...tdStyle, fontFamily: "monospace" }}>
                {team.isHockey ? e.pts : team.league === "NBA" ? e.gb : e.overall || e.pct}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Roster Tab ---
function RosterTab({ roster, accent, team }) {
  if (!roster || roster.length === 0)
    return <div style={{ color: "#777", padding: 12 }}>Roster not available</div>;

  const totalSalary = roster.reduce((sum, p) => sum + (p.salary || 0), 0);
  const hasSalaryData = roster.some(p => p.salary);

  function formatSalary(val) {
    if (!val) return "--";
    if (val >= 1000000) return "$" + (val / 1000000).toFixed(1) + "M";
    if (val >= 1000) return "$" + (val / 1000).toFixed(0) + "K";
    return "$" + val;
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={subheaderStyle}>{roster.length} Players</div>
        {hasSalaryData && team.salaryCap && (
          <div style={{ fontSize: 10, color: "#888" }}>
            Cap: {team.salaryCap} | Payroll: {formatSalary(totalSalary)}
          </div>
        )}
      </div>
      <div style={{ maxHeight: 300, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ color: "#666", borderBottom: "1px solid #333", position: "sticky", top: 0, background: "#12121f" }}>
              <th style={{ ...thStyle, width: 30 }}>#</th>
              <th style={{ ...thStyle, textAlign: "left" }}>Player</th>
              <th style={{ ...thStyle, width: 40 }}>Pos</th>
              <th style={{ ...thStyle, width: 35 }}>Age</th>
              {hasSalaryData && <th style={{ ...thStyle, width: 70 }}>Salary</th>}
              {hasSalaryData && <th style={{ ...thStyle, width: 40 }}>Yrs</th>}
            </tr>
          </thead>
          <tbody>
            {roster.map((p, i) => (
              <tr key={i} style={{
                background: i % 2 === 0 ? "#1a1a2e" : "transparent",
              }}>
                <td style={{ ...tdStyle, color: accent, fontWeight: 600, fontSize: 11 }}>{p.jersey}</td>
                <td style={{ ...tdStyle, textAlign: "left", color: "#eee", fontWeight: 500 }}>
                  {p.name}
                </td>
                <td style={{ ...tdStyle, fontSize: 10 }}>{p.position}</td>
                <td style={tdStyle}>{p.age}</td>
                {hasSalaryData && <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 10, color: p.salary ? "#8BC34A" : "#555" }}>{formatSalary(p.salary)}</td>}
                {hasSalaryData && <td style={{ ...tdStyle, color: p.yearsRemaining != null ? "#ccc" : "#555" }}>{p.yearsRemaining != null ? p.yearsRemaining : "--"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- Playoff Odds Gauge (Mammoth)---
function PlayoffOddsTab({ team, accent }) {
  const [odds, setOdds] = useState(null);
  const [rank, setRank] = useState(null);
  const [confTeams, setConfTeams] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetchESPN(team.apiStandings, true);
        // Determine which conference our team is in
        const conferences = r?.children || [];
        let myConf = null;
        let myTeamEntry = null;
        for (const conf of conferences) {
          const entries = conf.standings?.entries || [];
          // Also check children (divisions) if entries are nested
          const allEntries = entries.length > 0 ? entries : (conf.children || []).flatMap(d => d.standings?.entries || []);
          const found = allEntries.find(e =>
            String(e.team?.id) === String(team.teamId) ||
            e.team?.abbreviation?.toLowerCase() === team.teamId?.toLowerCase() ||
            e.team?.abbreviation === team.espnAbbr
          );
          if (found) { myConf = conf; myTeamEntry = found; break; }
        }
        if (!myConf || !myTeamEntry) return;

        const allEntries = myConf.standings?.entries || (myConf.children || []).flatMap(d => d.standings?.entries || []);
        const standings = allEntries.map(e => {
          const pts = e.stats?.find(s => s.name === "points")?.value || 0;
          const gp = e.stats?.find(s => s.name === "gamesPlayed")?.value || 0;
          const w = e.stats?.find(s => s.name === "wins")?.value || 0;
          const l = e.stats?.find(s => s.name === "losses")?.value || 0;
          const otl = e.stats?.find(s => s.name === "otLosses")?.value || 0;
          const remaining = 82 - gp;
          const ptPct = gp > 0 ? (w * 2 + otl) / (gp * 2) : 0.5;
          const isUs = e === myTeamEntry;
          return { team: e.team?.abbreviation, displayName: e.team?.displayName, pts, gp, w, l, otl, remaining, ptPct, isUs };
        }).sort((a, b) => b.pts - a.pts);

        const myIdx = standings.findIndex(t => t.isUs);
        const myTeam = standings[myIdx];
        setRank(myIdx + 1);
        setConfTeams(standings.slice(0, 10));

        // Monte Carlo-ish estimate using points pace
        // For each team, project final points using their current pt%
        const projections = standings.map(t => ({
          ...t,
          projPts: Math.round(t.pts + t.remaining * t.ptPct * 2),
        }));
        projections.sort((a, b) => b.projPts - a.projPts);
        const projRank = projections.findIndex(t => t.isUs) + 1;
        const myProj = projections.find(t => t.isUs);

        // Cutline: 8th place team projected points
        const cutlineProj = projections[7]?.projPts || 90;
        const buffer = myProj.projPts - cutlineProj;

        // Calculate probability based on buffer above/below cutline and remaining variance
        // Each remaining game has ~1.1 pts expected, variance matters with more games left
        const variance = Math.sqrt(myTeam.remaining) * 2.5;
        let prob;
        if (variance < 0.1) {
          prob = myIdx < 8 ? 99 : 1;
        } else {
          // Use a sigmoid-like function centered on the cutline
          prob = Math.round(100 / (1 + Math.exp(-buffer / (variance * 0.4))));
        }
        prob = Math.min(99, Math.max(1, prob));
        setOdds(prob);
      } catch (e) {
        console.error("Playoff odds error:", e);
      }
    })();
  }, [team]);

  if (odds === null) return <div style={{ padding: 20, color: "#555" }}>Calculating playoff odds...</div>;

  const radius = 50, stroke = 10;
  const circ = 2 * Math.PI * radius;
  const progress = (odds / 100) * circ;

  return (
    <div style={{ padding: "12px 0" }}>
      <div style={subheaderStyle}>Stanley Cup Playoff Probability</div>
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <svg width="120" height="120" viewBox="0 0 120 120">
          <circle cx="60" cy="60" r={radius} fill="none" stroke="#1a1a2e" strokeWidth={stroke} />
          <circle cx="60" cy="60" r={radius} fill="none" stroke={accent} strokeWidth={stroke}
            strokeDasharray={`${progress} ${circ - progress}`}
            strokeLinecap="round" transform="rotate(-90 60 60)"
            style={{ transition: "stroke-dasharray 1s ease" }}
          />
          <text x="60" y="55" textAnchor="middle" fill="white" fontSize="26" fontWeight="bold">{odds}%</text>
          <text x="60" y="72" textAnchor="middle" fill="#888" fontSize="10">PLAYOFF</text>
        </svg>
        <div>
          <div style={{ color: "#ccc", fontSize: 13, lineHeight: 1.5, marginBottom: 4 }}>
            Currently <span style={{ color: "#fff", fontWeight: 700 }}>{rank ? `#${rank}` : "--"}</span> in the Western Conference.
            {rank && rank <= 8 ? " In a playoff spot." : " Outside the playoff picture."}
          </div>
          <div style={{ fontSize: 11, color: "#666", marginBottom: 6 }}>
            Based on current pace vs. conference standings. Updates with every game.
          </div>
          <div style={{
            color: odds > 90 ? "#4CAF50" : odds > 70 ? "#8BC34A" : odds > 50 ? "#FFC107" : odds > 30 ? "#FF9800" : "#f44336",
            fontSize: 15, fontWeight: 700,
          }}>
            {odds > 95 ? "Clinched / Near Clinch" : odds > 85 ? "Very Likely" : odds > 70 ? "Strong Contender" : odds > 50 ? "In the Hunt" : odds > 30 ? "Bubble Team" : "Longshot"}
          </div>
        </div>
      </div>
      {/* Mini standings */}
      {confTeams.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Conference Standings</div>
          {confTeams.map((t, i) => (
            <div key={t.team} style={{
              display: "flex", alignItems: "center", gap: 8, padding: "4px 8px",
              fontSize: 11, borderRadius: 4,
              background: t.isUs ? accent + "18" : i === 7 ? "#ffffff08" : "transparent",
              borderLeft: t.isUs ? `3px solid ${accent}` : i === 7 ? "3px solid #ffffff22" : "3px solid transparent",
              color: t.isUs ? "#fff" : i < 8 ? "#aaa" : "#555",
              fontWeight: t.isUs ? 700 : 400,
            }}>
              <span style={{ width: 18, textAlign: "right", color: i < 8 ? "#888" : "#444" }}>{i + 1}</span>
              <span style={{ flex: 1 }}>{t.team}</span>
              <span style={{ width: 30, textAlign: "right" }}>{t.pts} pts</span>
              <span style={{ width: 55, textAlign: "right", color: "#555" }}>{t.w}-{t.l}-{t.otl}</span>
            </div>
          ))}
          <div style={{ fontSize: 9, color: "#444", marginTop: 4, paddingLeft: 8 }}>— Top 8 qualify for playoffs —</div>
        </div>
      )}
    </div>
  );
}

// --- Quick Links---
function QuickLinks({ team, accent }) {
  const btnBase = {
    flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
    padding: "10px 12px", background: "#1a1a2e", border: `1px solid ${accent}44`,
    borderRadius: 8, color: "#eee", textDecoration: "none", fontSize: 12, fontWeight: 600,
    cursor: "pointer", transition: "all 0.2s",
  };
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
      <a href={team.espnUrl} target="_blank" rel="noopener noreferrer" style={btnBase}
        onMouseEnter={(e) => { e.currentTarget.style.background = accent + "33"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "#1a1a2e"; }}
      ><span style={{display:"inline-flex",alignItems:"center",gap:4}}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg> Watch on ESPN</span></a>
      <a href={team.ticketUrl} target="_blank" rel="noopener noreferrer" style={btnBase}
        onMouseEnter={(e) => { e.currentTarget.style.background = accent + "33"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "#1a1a2e"; }}
      ><span style={{display:"inline-flex",alignItems:"center",gap:4}}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 9a3 3 0 013-3h14a3 3 0 013 3v0a3 3 0 01-3 3v0a3 3 0 013 3v0a3 3 0 01-3 3H5a3 3 0 01-3-3v0a3 3 0 013-3v0a3 3 0 01-3-3z"/></svg> Buy Tickets</span></a>
    </div>
  );
}

// --- Team Widget---
function TeamWidget({ team, isDragging, dragHandlers }) {
  const { schedule, standings, record, loading, error } = useTeamData(team);
  const { roster, rosterLoading } = useRosterData(team);

  const tabs = [
    { label: "Schedule", content: <ScheduleTab schedule={schedule} accent={team.accent} /> },
    { label: "Standings", content: <StandingsTab standings={standings} accent={team.accent} team={team} /> },
  ];
  tabs.push({ label: "Roster", content: rosterLoading ?
    <div style={{ color: "#888", padding: 20, textAlign: "center" }}>Loading roster...</div> :
    <RosterTab roster={roster} accent={team.accent} team={team} />
  });
  if (team.showPlayoffOdds) {
    tabs.push({ label: "Playoff Odds", content: <PlayoffOddsTab team={team} accent={team.accent} /> });
  }

  return (
    <div draggable {...dragHandlers} style={{
      background: "#12121f",
      border: isDragging ? `2px solid ${team.accent}` : "1px solid #2a2a3e",
      borderRadius: 14, padding: 0, cursor: "grab",
      opacity: isDragging ? 0.6 : 1, transition: "all 0.25s ease",
      boxShadow: isDragging ? `0 12px 40px ${team.accent}33` : "0 4px 20px rgba(0,0,0,0.3)",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        background: `linear-gradient(135deg, ${team.accent}22 0%, #12121f 100%)`,
        borderBottom: `1px solid ${team.accent}33`, padding: "14px 18px",
        display: "flex", alignItems: "center", gap: 12,
      }}>
        <div style={{ cursor: "grab", color: "#555", fontSize: 18, userSelect: "none", lineHeight: 1 }}><svg width="18" height="18" viewBox="0 0 24 24" fill="#555"><circle cx="8" cy="4" r="2"/><circle cx="16" cy="4" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="20" r="2"/><circle cx="16" cy="20" r="2"/></svg></div>
        <img src={team.logo} alt={team.name}
          style={{ width: 44, height: 44, borderRadius: 8, background: "#222", objectFit: "contain", padding: 3 }}
          onError={(e) => { e.target.style.display = "none"; }}
        />
        <div style={{ flex: 1 }}>
          <div style={{ color: "#fff", fontSize: 16, fontWeight: 700 }}>{team.name}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
            <span style={{ color: team.accent, fontSize: 13, fontWeight: 600 }}>{record}</span>
            <span style={{
              background: team.accent + "22", color: team.accent, fontSize: 9,
              padding: "2px 6px", borderRadius: 4, fontWeight: 700,
            }}>{team.leagueTag}</span>
            {schedule?.some((g) => g.status === "live") && (
              <span style={{
                background: "#CC0000", color: "#fff", fontSize: 9, fontWeight: 800,
                padding: "2px 6px", borderRadius: 4, letterSpacing: 0.5,
                animation: "liveBlink 1.5s ease-in-out infinite",
              }}>LIVE</span>
            )}
            {error && <span style={{ color: "#f44336", fontSize: 10 }}>! {error}</span>}
          </div>
          <div style={{ color: "#666", fontSize: 11, marginTop: 1, display: "flex", alignItems: "center", gap: 3 }}><svg width="11" height="11" viewBox="0 0 24 24" fill="#666" stroke="none"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg> {team.venue}</div>
        </div>
        <a href={team.espnUrl} target="_blank" rel="noopener noreferrer" style={{
          background: team.accent + "22", border: `1px solid ${team.accent}44`,
          borderRadius: 6, padding: "6px 10px", color: team.accent,
          fontSize: 10, fontWeight: 700, textDecoration: "none", textTransform: "uppercase",
        }}>ESPN</a>
      </div>

      {/* Body */}
      <div style={{ padding: "12px 18px 16px" }}>
        {loading ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 200, gap: 10 }}>
            <div style={{
              width: 24, height: 24,
              border: `3px solid ${team.accent}33`, borderTop: `3px solid ${team.accent}`,
              borderRadius: "50%", animation: "spin 1s linear infinite",
            }} />
            <span style={{ color: "#888", fontSize: 13 }}>Fetching live data...</span>
          </div>
        ) : (
          <Tabs tabs={tabs} accent={team.accent} />
        )}
        <QuickLinks team={team} accent={team.accent} />
      </div>
    </div>
  );
}

// --- Shared Styles---
const subheaderStyle = {
  fontSize: 11, color: "#888", textTransform: "uppercase",
  letterSpacing: 1, marginBottom: 6, fontWeight: 600,
};
const rowStyle = (i) => ({
  display: "flex", justifyContent: "space-between", alignItems: "center",
  padding: "8px 10px", background: i % 2 === 0 ? "#1a1a2e" : "transparent",
  borderRadius: 6, marginBottom: 2,
});
const thStyle = { textAlign: "center", padding: "4px 6px", fontWeight: 600 };
const tdStyle = { padding: "6px", color: "#ccc", textAlign: "center" };

// --- Main Dashboard---
export default function App() {
  const { user, authLoading, login, logout, isAdmin } = useAuth();
  const [showBracket, setShowBracket] = useState(false);
  const [bracketEntry, setBracketEntry] = useState(1);
  const [userEntries, setUserEntries] = useState([null, null]);
  const [order, setOrder] = useState(() => TEAMS_CONFIG.map((t) => t.id));
  const [draggedId, setDraggedId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(new Date());

  // Load user bracket entries for banner display
  useEffect(() => {
    if (user) {
      loadUserEntries(user.uid).then(setUserEntries);
    } else {
      setUserEntries([null, null]);
    }
  }, [user, showBracket]); // re-fetch when returning from bracket

  // Auto-update the "last refresh" display every minute
  useEffect(() => {
    const t = setInterval(() => setLastRefresh(new Date()), 60000);
    return () => clearInterval(t);
  }, []);

  const handleDragStart = useCallback((e, id) => {
    setDraggedId(id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", id);
  }, []);
  const handleDragOver = useCallback((e, id) => { e.preventDefault(); setDragOverId(id); }, []);
  const handleDrop = useCallback((e, targetId) => {
    e.preventDefault();
    if (!draggedId || draggedId === targetId) { setDraggedId(null); setDragOverId(null); return; }
    setOrder((prev) => {
      const n = [...prev]; const si = n.indexOf(draggedId); const ti = n.indexOf(targetId);
      n.splice(si, 1); n.splice(ti, 0, draggedId); return n;
    });
    setDraggedId(null); setDragOverId(null);
  }, [draggedId]);
  const handleDragEnd = useCallback(() => { setDraggedId(null); setDragOverId(null); }, []);

  // Load admin users + bracket data
  const loadAdminUsers = async () => {
    setAdminLoading(true);
    try {
      // Fetch both collections in parallel
      const [usersSnap, bracketsSnap] = await Promise.all([
        getDocs(query(collection(db, "users"), orderBy("lastLogin", "desc"))),
        getDocs(collection(db, "brackets")),
      ]);

      // Build bracket map keyed by ownerUid
      const bracketsByUser = {};
      bracketsSnap.docs.forEach((d) => {
        const b = d.data();
        const uid = b.ownerUid || d.id;
        if (!bracketsByUser[uid]) bracketsByUser[uid] = [];
        bracketsByUser[uid].push({
          entryNum: b.entryNum || 1,
          entryName: b.entryName || "",
          picks: b.picks || {},
          updatedAt: b.updatedAt || null,
          champion: b.picks?.champ || null,
          displayName: b.displayName || "Anonymous",
          photoURL: b.photoURL || null,
          email: b.email || null,
        });
      });

      // Build user map from "users" collection
      const userMap = {};
      usersSnap.docs.forEach((d) => {
        const u = d.data();
        userMap[u.uid] = { ...u, brackets: bracketsByUser[u.uid] || [] };
      });

      // Add bracket-only users (submitted a bracket but haven't signed in since the users collection was added)
      for (const uid of Object.keys(bracketsByUser)) {
        if (!userMap[uid]) {
          const first = bracketsByUser[uid][0];
          userMap[uid] = {
            uid,
            displayName: first.displayName,
            email: first.email,
            photoURL: first.photoURL,
            lastLogin: first.updatedAt,
            brackets: bracketsByUser[uid],
            bracketOnly: true, // signed up before users collection existed
          };
        }
      }

      // Sort: users with brackets first, then by last login
      const allUsers = Object.values(userMap).sort((a, b) => {
        const aHas = a.brackets.length > 0 ? 1 : 0;
        const bHas = b.brackets.length > 0 ? 1 : 0;
        if (aHas !== bHas) return bHas - aHas;
        return new Date(b.lastLogin || 0) - new Date(a.lastLogin || 0);
      });

      setAdminUsers(allUsers);
    } catch (e) {
      console.error("Admin load error:", e);
    }
    setAdminLoading(false);
  };

  // Show Bracket Challenge if active
  if (showBracket) {
    return <BracketChallenge user={user} onBack={() => { setShowBracket(false); setShowLeaderboard(false); }} initialEntry={bracketEntry} initialTab={showLeaderboard ? "lb" : "bracket"} />;
  }

  // Show Admin Panel
  if (showAdmin && isAdmin) {
    const totalUsers = adminUsers.length;
    const usersWithBrackets = adminUsers.filter((u) => u.brackets.length > 0).length;
    const totalBrackets = adminUsers.reduce((sum, u) => sum + u.brackets.length, 0);
    const signUpOnly = totalUsers - usersWithBrackets;

    return (
      <div style={{
        minHeight: "100vh",
        background: "linear-gradient(180deg, #0a0a16 0%, #0f0f1e 50%, #0a0a16 100%)",
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        color: "#fff",
      }}>
        <header style={{
          background: "linear-gradient(135deg, #12121f 0%, #1a1a30 100%)",
          borderBottom: "1px solid #2a2a3e", padding: "14px 20px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(12px)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={() => setShowAdmin(false)} style={{
              background: "#1a1a2e", border: "1px solid #2a2a3e", borderRadius: 8,
              padding: "6px 12px", color: "#888", fontSize: 12, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 4,
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              Back
            </button>
            <div>
              <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, letterSpacing: -0.5 }}>
                Salt City Sports <span style={{ color: "#CC0000" }}>Admin</span>
              </h1>
              <p style={{ margin: 0, fontSize: 10, color: "#666" }}>USER MANAGEMENT</p>
            </div>
          </div>
          <button onClick={loadAdminUsers} style={{
            background: "#1a1a2e", border: "1px solid #2a2a3e", borderRadius: 8,
            padding: "6px 12px", color: "#888", fontSize: 11, cursor: "pointer",
          }}>Refresh</button>
        </header>

        <main style={{ padding: 20, maxWidth: 1000, margin: "0 auto" }}>
          {/* Stats Cards */}
          {!adminLoading && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 20 }}>
              {[
                { label: "Total Users", value: totalUsers, color: "#4A90D9" },
                { label: "With Brackets", value: usersWithBrackets, color: "#4CAF50" },
                { label: "Total Brackets", value: totalBrackets, color: "#FF6B35" },
                { label: "Sign-Up Only", value: signUpOnly, color: "#888" },
              ].map((stat) => (
                <div key={stat.label} style={{
                  background: "#12121f", border: "1px solid #2a2a3e", borderRadius: 10,
                  padding: "14px 16px", textAlign: "center",
                }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: stat.color }}>{stat.value}</div>
                  <div style={{ fontSize: 10, color: "#666", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 4 }}>{stat.label}</div>
                </div>
              ))}
            </div>
          )}

          {adminLoading ? (
            <div style={{ textAlign: "center", padding: 60, color: "#555" }}>Loading users...</div>
          ) : adminUsers.length === 0 ? (
            <div style={{ textAlign: "center", padding: 60, color: "#555" }}>No users registered yet.</div>
          ) : (
            <div style={{ background: "#12121f", borderRadius: 12, overflow: "hidden", border: "1px solid #2a2a3e" }}>
              {/* Table Header */}
              <div style={{
                display: "grid", gridTemplateColumns: "36px 1fr 1fr 100px 1fr",
                padding: "10px 16px", borderBottom: "1px solid #2a2a3e",
                fontSize: 10, color: "#666", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700,
              }}>
                <div>#</div>
                <div>User</div>
                <div>Email</div>
                <div style={{ textAlign: "center" }}>Brackets</div>
                <div>Last Active</div>
              </div>

              {adminUsers.map((u, i) => {
                const hasBrackets = u.brackets.length > 0;
                return (
                  <div key={u.uid}>
                    {/* User Row */}
                    <div style={{
                      display: "grid", gridTemplateColumns: "36px 1fr 1fr 100px 1fr",
                      padding: "10px 16px", borderBottom: hasBrackets ? "none" : "1px solid #1a1a2e",
                      background: i % 2 === 0 ? "#0f0f1e" : "transparent",
                      alignItems: "center",
                    }}>
                      <div style={{ color: "#888", fontWeight: 700, fontSize: 12 }}>{i + 1}</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        {u.photoURL ? (
                          <img src={u.photoURL} alt="" referrerPolicy="no-referrer"
                            style={{ width: 26, height: 26, borderRadius: "50%", border: "1px solid #333", flexShrink: 0 }}
                          />
                        ) : (
                          <div style={{
                            width: 26, height: 26, borderRadius: "50%", background: "#2a2a3e",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: 11, color: "#888", fontWeight: 700, flexShrink: 0,
                          }}>
                            {(u.displayName || "?")[0].toUpperCase()}
                          </div>
                        )}
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: "#ccc", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {u.displayName || "Anonymous"}
                          </div>
                          {u.bracketOnly && (
                            <div style={{ fontSize: 9, color: "#FF6B35" }}>pre-registration</div>
                          )}
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {u.email || "—"}
                      </div>
                      <div style={{ textAlign: "center" }}>
                        {hasBrackets ? (
                          <span style={{
                            background: "#4CAF5022", color: "#4CAF50", fontSize: 11, fontWeight: 700,
                            padding: "2px 10px", borderRadius: 10, border: "1px solid #4CAF5044",
                          }}>
                            {u.brackets.length}
                          </span>
                        ) : (
                          <span style={{ fontSize: 11, color: "#444" }}>—</span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: "#666" }}>
                        {u.lastLogin ? new Date(u.lastLogin).toLocaleDateString("en-US", {
                          month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                        }) : "—"}
                      </div>
                    </div>

                    {/* Bracket Details (inline, beneath the user row) */}
                    {hasBrackets && (
                      <div style={{
                        padding: "0 16px 10px 52px",
                        background: i % 2 === 0 ? "#0f0f1e" : "transparent",
                        borderBottom: "1px solid #1a1a2e",
                      }}>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {u.brackets.map((b, bi) => {
                            const numPicks = Object.keys(b.picks || {}).filter((k) => b.picks[k]).length;
                            const champName = b.champion && b.picks[b.champion] ? null : null; // just use champion ID
                            return (
                              <div key={bi} style={{
                                background: "#0a0a16", border: "1px solid #2a2a3e", borderRadius: 8,
                                padding: "6px 12px", fontSize: 10, color: "#888",
                                display: "flex", alignItems: "center", gap: 8,
                              }}>
                                <div style={{
                                  width: 6, height: 6, borderRadius: "50%",
                                  background: numPicks === 67 ? "#4CAF50" : numPicks > 0 ? "#FF6B35" : "#444",
                                }} />
                                <div>
                                  <span style={{ fontWeight: 600, color: "#ccc" }}>
                                    {b.entryName || `Entry ${b.entryNum}`}
                                  </span>
                                  <span style={{ color: "#555", marginLeft: 6 }}>
                                    {numPicks}/67 picks
                                  </span>
                                  {b.champion && (
                                    <span style={{ color: "#FFD700", marginLeft: 6 }}>
                                      Champ: {b.champion}
                                    </span>
                                  )}
                                </div>
                                {b.updatedAt && (
                                  <div style={{ fontSize: 9, color: "#444", marginLeft: 4 }}>
                                    {new Date(b.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </main>
      </div>
    );
  }

  const hasAnyBracket = userEntries.some((e) => e && Object.keys(e.picks || {}).length > 0);
  const entry1 = userEntries[0];
  const entry2 = userEntries[1];
  const entry1Picks = entry1 ? Object.keys(entry1.picks || {}).length : 0;
  const entry2Picks = entry2 ? Object.keys(entry2.picks || {}).length : 0;

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(180deg, #0a0a16 0%, #0f0f1e 50%, #0a0a16 100%)",
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      color: "#fff",
    }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes livePulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.85; } }
        @keyframes liveBlink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes bannerShimmer { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
        .mm-banner {
          width: 100%;
          background: linear-gradient(135deg, #FF6B35 0%, #CC0000 40%, #8B0000 70%, #FF6B35 100%);
          background-size: 200% 200%;
          animation: bannerShimmer 4s ease infinite;
          border: none; border-radius: 14px;
          padding: 16px 24px;
          cursor: pointer; transition: transform 0.2s, box-shadow 0.2s;
          display: flex; align-items: center; justify-content: space-between;
          box-shadow: 0 4px 20px #CC000044;
        }
        .mm-banner-content { display: flex; align-items: center; gap: 14px; }
        .mm-banner-emoji { font-size: 32px; }
        .mm-banner-title { font-size: 18px; font-weight: 900; color: #fff; letter-spacing: -0.5px; text-shadow: 0 2px 8px #00000066; }
        .mm-banner-sub { font-size: 12px; color: #ffffffcc; font-weight: 500; margin-top: 2px; }
        .mm-banner-cta {
          background: #ffffff22; backdrop-filter: blur(4px);
          border-radius: 8px; padding: 8px 18px;
          color: #fff; font-size: 13px; font-weight: 700;
          border: 1px solid #ffffff33; white-space: nowrap;
          display: flex; align-items: center; gap: 6px; flex-shrink: 0;
        }
        @media (max-width: 600px) {
          .mm-banner { flex-direction: column; gap: 12px; padding: 14px 16px; align-items: stretch; }
          .mm-banner-content { gap: 10px; }
          .mm-banner-emoji { font-size: 24px; }
          .mm-banner-title { font-size: 15px; }
          .mm-banner-sub { font-size: 11px; }
          .mm-banner-cta { justify-content: center; padding: 10px 16px; white-space: normal; min-width: 0 !important; flex: 1; }
        }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0a0a16; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
        a:hover { filter: brightness(1.2); }
        @media (max-width: 600px) {
          .ush-header { flex-direction: column !important; gap: 10px !important; padding: 12px 14px !important; align-items: flex-start !important; }
          .ush-header-right { width: 100% !important; flex-direction: row !important; justify-content: space-between !important; }
          .ush-leaderboard-btn { padding: 6px 10px !important; font-size: 11px !important; }
          .ush-subtitle { display: none !important; }
          .ush-pills { padding: 10px 14px 0 !important; gap: 6px !important; }
          .ush-pills button { padding: 5px 10px !important; font-size: 11px !important; }
          .ush-grid { padding: 12px 10px 30px !important; grid-template-columns: 1fr !important; gap: 14px !important; }
        }
      `}</style>

      {/* Header */}
      <header className="ush-header" style={{
        background: "linear-gradient(135deg, #12121f 0%, #1a1a30 100%)",
        borderBottom: "1px solid #2a2a3e", padding: "16px 28px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(12px)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ fontSize: 32, lineHeight: 1 }}><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#CC0000" strokeWidth="1.5"><path d="M8 21l4-10 4 10"/><path d="M2 21l6-14 3.5 7"/><path d="M14.5 14L18 7l4 14"/><line x1="2" y1="21" x2="22" y2="21"/></svg></div>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: -0.5 }}>
              Utah Sports <span style={{ color: "#CC0000" }}>HQ</span>
            </h1>
            <p className="ush-subtitle" style={{ margin: 0, fontSize: 11, color: "#666", letterSpacing: 0.5 }}>
              LIVE DASHBOARD | AUTO-REFRESHES EVERY 5 MIN | DRAG TO REARRANGE
            </p>
          </div>
        </div>
        <div className="ush-header-right" style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <button onClick={() => { setBracketEntry(1); setShowBracket(true); setShowLeaderboard(true); }}
            className="ush-leaderboard-btn"
            style={{
              background: "#FFD70015", border: "1px solid #FFD70044", borderRadius: 8,
              padding: "8px 14px", color: "#FFD700", fontSize: 12, fontWeight: 600,
              cursor: "pointer", display: "flex", alignItems: "center", gap: 6, transition: "all 0.2s",
              whiteSpace: "nowrap",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#FFD70033")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "#FFD70015")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>
            Live Leaderboard
          </button>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: "#555" }}>Auto-refresh</div>
            <div style={{ fontSize: 12, color: "#888", fontFamily: "monospace" }}>{lastRefresh.toLocaleTimeString()}</div>
          </div>
          {/* Auth */}
          {authLoading ? null : user ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {isAdmin && (
                <button onClick={() => { setShowAdmin(true); loadAdminUsers(); }}
                  style={{
                    background: "#4A90D915", border: "1px solid #4A90D944", borderRadius: 8,
                    padding: "6px 10px", color: "#4A90D9", fontSize: 11, fontWeight: 600,
                    cursor: "pointer", display: "flex", alignItems: "center", gap: 4, transition: "all 0.2s",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#4A90D933")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "#4A90D915")}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197"/></svg>
                  Admin
                </button>
              )}
              <img src={user.photoURL} alt="" style={{ width: 30, height: 30, borderRadius: "50%", border: "2px solid #CC0000" }} referrerPolicy="no-referrer" />
              <div>
                <div style={{ fontSize: 11, color: "#ccc", fontWeight: 600, maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.displayName?.split(" ")[0]}</div>
                <button onClick={logout} style={{ background: "none", border: "none", color: "#888", fontSize: 9, cursor: "pointer", padding: 0, textDecoration: "underline" }}>Sign out</button>
              </div>
            </div>
          ) : (
            <button onClick={login} style={{
              background: "#1a1a2e", border: "1px solid #CC000066", borderRadius: 8,
              padding: "8px 14px", color: "#CC0000", fontSize: 12, fontWeight: 600,
              cursor: "pointer", display: "flex", alignItems: "center", gap: 6, transition: "all 0.2s",
            }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#CC000022")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "#1a1a2e")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
              Sign in
            </button>
          )}
        </div>
      </header>

      {/* March Madness Banner */}
      <div style={{ padding: "14px 28px 0" }}>
        {user && hasAnyBracket ? (
          /* Returning user banner — show entries & stats */
          <div className="mm-banner" style={{ cursor: "default" }}>
            <div className="mm-banner-content">
              <span className="mm-banner-emoji">🏀</span>
              <div style={{ textAlign: "left" }}>
                <div className="mm-banner-title">March Madness 2026</div>
                <div className="mm-banner-sub">Your brackets are live — edit or add a second entry</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[1, 2].map((num) => {
                const entry = userEntries[num - 1];
                const picks = entry ? Object.keys(entry.picks || {}).length : 0;
                const exists = picks > 0;
                const name = entry?.entryName || (num === 1 ? "Entry 1" : "Entry 2");
                const champion = entry?.picks?.champ;
                return (
                  <button key={num} onClick={() => { setBracketEntry(num); setShowBracket(true); }}
                    className="mm-banner-cta"
                    style={{ flexDirection: "column", alignItems: "flex-start", gap: 2, padding: "8px 16px", minWidth: 150 }}
                  >
                    {exists ? (
                      <>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
                          <span style={{ fontWeight: 700, fontSize: 13 }}>{name}</span>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </div>
                        <div style={{ fontSize: 10, color: "#ffffffaa", fontWeight: 400 }}>{picks}/67 picks • Score: 0</div>
                      </>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 16, opacity: 0.6 }}>+</span>
                        <span style={{ fontWeight: 600, fontSize: 12 }}>Add Entry {num}</span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          /* New user / not signed in banner */
          <button
            className="mm-banner"
            onClick={() => {
              if (!user) { login(); return; }
              setBracketEntry(1);
              setShowBracket(true);
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.01)"; e.currentTarget.style.boxShadow = "0 6px 30px #CC000066"; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.boxShadow = "0 4px 20px #CC000044"; }}
          >
            <div className="mm-banner-content">
              <span className="mm-banner-emoji">🏀</span>
              <div style={{ textAlign: "left" }}>
                <div className="mm-banner-title">March Madness 2026 Bracket Challenge</div>
                <div className="mm-banner-sub">Make your picks, compete on the leaderboard, and prove you know college hoops</div>
              </div>
            </div>
            <div className="mm-banner-cta">
              {user ? "Fill Out Bracket" : "Sign In & Play"}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          </button>
        )}
      </div>

      {/* Team Pills */}
      <div className="ush-pills" style={{ padding: "10px 28px 0", display: "flex", gap: 8, flexWrap: "wrap" }}>
        {TEAMS_CONFIG.map((team) => (
          <button key={team.id}
            onClick={() => document.getElementById(`widget-${team.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
            style={{
              background: team.accent + "15", border: `1px solid ${team.accent}44`, borderRadius: 20,
              padding: "6px 16px", color: team.accent, fontSize: 12, fontWeight: 600,
              cursor: "pointer", transition: "all 0.2s", display: "flex", alignItems: "center", gap: 6,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = team.accent + "33")}
            onMouseLeave={(e) => (e.currentTarget.style.background = team.accent + "15")}
          >
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: team.accent, display: "inline-block" }} />
            {team.shortName}
          </button>
        ))}
      </div>

      {/* Widget Grid */}
      <main className="ush-grid" style={{
        padding: "20px 28px 40px", display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(440px, 1fr))",
        gap: 20, maxWidth: 1400, margin: "0 auto",
      }}>
        {order.map((id, index) => {
          const team = TEAMS_CONFIG.find((t) => t.id === id);
          if (!team) return null;
          return (
            <div key={id} id={`widget-${id}`}
              style={{ animation: `fadeIn 0.4s ease ${index * 0.08}s both`, position: "relative" }}>
              {dragOverId === id && draggedId !== id && (
                <div style={{ position: "absolute", top: -3, left: 0, right: 0, height: 3, background: team.accent, borderRadius: 2, zIndex: 10 }} />
              )}
              <TeamWidget team={team} isDragging={draggedId === id}
                dragHandlers={{
                  onDragStart: (e) => handleDragStart(e, id),
                  onDragOver: (e) => handleDragOver(e, id),
                  onDrop: (e) => handleDrop(e, id),
                  onDragEnd: handleDragEnd,
                }}
              />
            </div>
          );
        })}
      </main>

      <footer style={{ textAlign: "center", padding: "20px 28px", borderTop: "1px solid #1a1a2e", color: "#444", fontSize: 11 }}>
        Utah Sports HQ | Live data from ESPN API via serverless proxy | Auto-refreshes every 5 minutes
      </footer>
    </div>
  );
}
