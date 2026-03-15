import { useState, useEffect, useCallback } from "react";

// âââ Team Configuration âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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
    teamId: "uta",
    sport: "hockey",
    isHockey: true,
    showPlayoffOdds: true,
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
    teamId: "26",
    sport: "basketball",
    isHockey: false,
    showPlayoffOdds: false,
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
    teamId: "254",
    sport: "football",
    isHockey: false,
    showPlayoffOdds: false,
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
    teamId: "254",
    sport: "basketball",
    isHockey: false,
    showPlayoffOdds: false,
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
    teamId: "254",
    sport: "baseball",
    isHockey: false,
    showPlayoffOdds: false,
  },
];

// âââ API Helper âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// In development, Vite proxies /api to ESPN directly.
// In production on Vercel, /api/espn serverless function handles the proxy.

async function fetchESPN(apiPath) {
  // Vercel serverless route
  const url = `/api/espn?path=${encodeURIComponent(apiPath)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// âââ ESPN Data Parser Hook ââââââââââââââââââââââââââââââââââââââââââââââââââââ
function useTeamData(team) {
  const [schedule, setSchedule] = useState(null);
  const [standings, setStandings] = useState(null);
  const [record, setRecord] = useState("Loading...");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const [teamData, schedData, standData] = await Promise.allSettled([
          fetchESPN(team.apiTeam),
          fetchESPN(team.apiSchedule),
          fetchESPN(team.apiStandings),
        ]);

        if (cancelled) return;

        // ââ Parse record ââââââââââââââââââââââââââââââââââââââââââââââ
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
              setRecord(w != null ? `${w}-${l}-${otl} â¢ ${pts} PTS` : rec || "â");
            } else {
              setRecord(rec || "â");
            }
          }
        }

        // ââ Parse schedule ââââââââââââââââââââââââââââââââââââââââââââ
        if (schedData.status === "fulfilled") {
          const raw = schedData.value;
          const events = raw?.events || raw?.requestedSeason?.events || [];
          const parsed = events.slice(0, 20).map((ev) => {
            const comp = ev.competitions?.[0];
            const us = comp?.competitors?.find(
              (c) => String(c.id) === String(team.teamId) || c.team?.abbreviation?.toLowerCase() === team.teamId?.toLowerCase()
            );
            const them = comp?.competitors?.find((c) => c !== us);
            const isHome = us?.homeAway === "home";
            const bcast =
              comp?.broadcasts?.[0]?.names?.[0] ||
              comp?.geoBroadcasts?.[0]?.media?.shortName ||
              "â";
            const statusName = comp?.status?.type?.name || ev.status?.type?.name || "";
            const isFinal = statusName.includes("FINAL") || statusName === "post";

            let result = "";
            if (isFinal && us && them) {
              const usS = parseInt(us.score?.displayValue || us.score || "0");
              const thS = parseInt(them.score?.displayValue || them.score || "0");
              result = usS > thS ? `W ${usS}-${thS}` : usS < thS ? `L ${usS}-${thS}` : `T ${usS}-${thS}`;
            }

            return {
              date: ev.date || comp?.date,
              opponent: them?.team?.displayName || them?.team?.shortDisplayName || "TBD",
              home: isHome,
              result,
              status: isFinal ? "post" : "pre",
              broadcast: bcast,
            };
          });
          setSchedule(parsed);
        }

        // ââ Parse standings âââââââââââââââââââââââââââââââââââââââââââ
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
                  e.team?.abbreviation?.toLowerCase() === team.teamId?.toLowerCase()
              );
              if (match) {
                found = entries.map((e) => {
                  const st = (name) => e.stats?.find((s) => s.name === name);
                  return {
                    team: e.team?.shortDisplayName || e.team?.displayName || "â",
                    logo: e.team?.logos?.[0]?.href,
                    wins: st("wins")?.value ?? st("wins")?.displayValue ?? 0,
                    losses: st("losses")?.value ?? st("losses")?.displayValue ?? 0,
                    otl: st("otLosses")?.value ?? st("OTLosses")?.displayValue ?? 0,
                    pts: st("points")?.value ?? st("points")?.displayValue ?? 0,
                    pct: st("winPercent")?.displayValue ?? st("winPct")?.displayValue ?? "â",
                    gb: st("gamesBehind")?.displayValue ?? "â",
                    overall: st("overall")?.displayValue ?? "",
                    isTarget:
                      String(e.team?.id) === String(team.teamId) ||
                      e.team?.abbreviation?.toLowerCase() === team.teamId?.toLowerCase(),
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
    // Auto-refresh every 5 minutes
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [team.id]);

  return { schedule, standings, record, loading, error };
}

// âââ Utility helpers âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function formatDate(d) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function formatTime(d) {
  return new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function formatDayDate(d) {
  return new Date(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// âââ Tabs âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

// âââ Schedule Tab âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function ScheduleTab({ schedule, accent }) {
  if (!schedule || schedule.length === 0)
    return <div style={{ color: "#777", padding: 12 }}>No schedule data available</div>;
  const recent = schedule.filter((g) => g.status === "post");
  const upcoming = schedule.filter((g) => g.status === "pre");

  return (
    <div>
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
                <div style={{ color: "#888", fontSize: 11 }}>ðº {g.broadcast}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// âââ Standings Tab ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

// âââ Playoff Odds Gauge (Mammoth) ââââââââââââââââââââââââââââââââââââââââââââ
function PlayoffOddsTab({ record, accent }) {
  // Simple estimate from win% â in a real app, you'd fetch from an odds API
  const parts = record?.match(/(\d+)-(\d+)-(\d+)/);
  let odds = 50;
  if (parts) {
    const [_, w, l, otl] = parts.map(Number);
    const gp = w + l + otl;
    const ptPct = gp > 0 ? (w * 2 + otl) / (gp * 2) : 0.5;
    // Rough model: .550+ pts% â 95%+, .500 â 50%, below .480 drops fast
    odds = Math.min(99, Math.max(1, Math.round(ptPct * 180 - 40)));
  }

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
          <div style={{ color: "#ccc", fontSize: 13, lineHeight: 1.5, marginBottom: 6 }}>
            Estimated from current record and points percentage. Updates automatically as new games are played.
          </div>
          <div style={{
            color: odds > 90 ? "#4CAF50" : odds > 60 ? "#8BC34A" : odds > 40 ? "#FFC107" : "#f44336",
            fontSize: 15, fontWeight: 700,
          }}>
            {odds > 90 ? "Virtually Clinched" : odds > 70 ? "Strong Contender" : odds > 50 ? "In the Hunt" : "Needs Help"}
          </div>
        </div>
      </div>
    </div>
  );
}

// âââ Quick Links ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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
      >ðº Watch on ESPN</a>
      <a href={team.ticketUrl} target="_blank" rel="noopener noreferrer" style={btnBase}
        onMouseEnter={(e) => { e.currentTarget.style.background = accent + "33"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "#1a1a2e"; }}
      >ðï¸ Buy Tickets</a>
    </div>
  );
}

// âââ Team Widget ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function TeamWidget({ team, isDragging, dragHandlers }) {
  const { schedule, standings, record, loading, error } = useTeamData(team);

  const tabs = [
    { label: "Schedule", content: <ScheduleTab schedule={schedule} accent={team.accent} /> },
    { label: "Standings", content: <StandingsTab standings={standings} accent={team.accent} team={team} /> },
  ];
  if (team.showPlayoffOdds) {
    tabs.push({ label: "Playoff Odds", content: <PlayoffOddsTab record={record} accent={team.accent} /> });
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
        <div style={{ cursor: "grab", color: "#555", fontSize: 18, userSelect: "none" }}>â ¿</div>
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
            {error && <span style={{ color: "#f44336", fontSize: 10 }}>â  {error}</span>}
          </div>
          <div style={{ color: "#666", fontSize: 11, marginTop: 1 }}>ð {team.venue}</div>
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

// âââ Shared Styles ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

// âââ Main Dashboard âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
export default function App() {
  const [order, setOrder] = useState(() => TEAMS_CONFIG.map((t) => t.id));
  const [draggedId, setDraggedId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [lastRefresh, setLastRefresh] = useState(new Date());

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

  const filteredOrder = order.filter((id) => {
    if (!searchQuery) return true;
    return TEAMS_CONFIG.find((t) => t.id === id)?.name.toLowerCase().includes(searchQuery.toLowerCase());
  });

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
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0a0a16; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
        a:hover { filter: brightness(1.2); }
      `}</style>

      {/* Header */}
      <header style={{
        background: "linear-gradient(135deg, #12121f 0%, #1a1a30 100%)",
        borderBottom: "1px solid #2a2a3e", padding: "16px 28px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(12px)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ fontSize: 32 }}>â°ï¸</div>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: -0.5 }}>
              Utah Sports <span style={{ color: "#CC0000" }}>HQ</span>
            </h1>
            <p style={{ margin: 0, fontSize: 11, color: "#666", letterSpacing: 0.5 }}>
              LIVE DASHBOARD â¢ AUTO-REFRESHES EVERY 5 MIN â¢ DRAG TO REARRANGE
            </p>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ position: "relative" }}>
            <input type="text" placeholder="Filter teams..." value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                background: "#1a1a2e", border: "1px solid #2a2a3e", borderRadius: 8,
                padding: "8px 12px 8px 32px", color: "#ccc", fontSize: 13, outline: "none", width: 180,
              }}
            />
            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "#555" }}>ð</span>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: "#555" }}>Auto-refresh</div>
            <div style={{ fontSize: 12, color: "#888", fontFamily: "monospace" }}>{lastRefresh.toLocaleTimeString()}</div>
          </div>
        </div>
      </header>

      {/* Team Pills */}
      <div style={{ padding: "14px 28px 0", display: "flex", gap: 8, flexWrap: "wrap" }}>
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
      <main style={{
        padding: "20px 28px 40px", display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(440px, 1fr))",
        gap: 20, maxWidth: 1400, margin: "0 auto",
      }}>
        {filteredOrder.map((id, index) => {
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
        Utah Sports HQ â¢ Live data from ESPN API via serverless proxy â¢ Auto-refreshes every 5 minutes
      </footer>
    </div>
  );
}
