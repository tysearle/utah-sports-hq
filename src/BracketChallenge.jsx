import { useState, useEffect, useMemo, useCallback } from "react";
import { auth } from "./firebase";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  collection,
  getDocs,
} from "firebase/firestore";

const db = getFirestore();

// ===== BRACKET DATA =====
const T = (seed, name, id) => ({ seed, name, id });

const FIRST_FOUR = [
  { id: "ff_west_11", region: "west", teams: [T(11, "Texas", "texas"), T(11, "NC State", "ncstate")] },
  { id: "ff_mw_16", region: "midwest", teams: [T(16, "UMBC", "umbc"), T(16, "Howard", "howard")] },
  { id: "ff_mw_11", region: "midwest", teams: [T(11, "Miami (OH)", "miamioh"), T(11, "SMU", "smu")] },
  { id: "ff_south_16", region: "south", teams: [T(16, "Prairie View A&M", "pvamu"), T(16, "Lehigh", "lehigh")] },
];

const REGIONS = [
  {
    id: "east", name: "East", location: "Washington, D.C.", color: "#4A90D9",
    matchups: [
      [T(1, "Duke", "duke"), T(16, "Siena", "siena")],
      [T(8, "Ohio State", "ohiostate"), T(9, "TCU", "tcu")],
      [T(5, "St. John's", "stjohns"), T(12, "Northern Iowa", "northerniowa")],
      [T(4, "Kansas", "kansas"), T(13, "Cal Baptist", "calbaptist")],
      [T(6, "Louisville", "louisville"), T(11, "South Florida", "southflorida")],
      [T(3, "Michigan St", "michiganst"), T(14, "N Dakota St", "ndakotast")],
      [T(7, "UCLA", "ucla"), T(10, "UCF", "ucf")],
      [T(2, "UConn", "uconn"), T(15, "Furman", "furman")],
    ],
  },
  {
    id: "west", name: "West", location: "San Jose, CA", color: "#4CAF50",
    matchups: [
      [T(1, "Arizona", "arizona"), T(16, "LIU", "liu")],
      [T(8, "Villanova", "villanova"), T(9, "Utah State", "utahstate")],
      [T(5, "Wisconsin", "wisconsin"), T(12, "High Point", "highpoint")],
      [T(4, "Arkansas", "arkansas"), T(13, "Hawai'i", "hawaii")],
      [T(6, "BYU", "byu"), { seed: 11, name: "First Four", id: "ff_west_11", isFirstFour: true }],
      [T(3, "Gonzaga", "gonzaga"), T(14, "Kennesaw St", "kennesawst")],
      [T(7, "Miami (FL)", "miamifl"), T(10, "Missouri", "missouri")],
      [T(2, "Purdue", "purdue"), T(15, "Queens", "queens")],
    ],
  },
  {
    id: "south", name: "South", location: "Houston, TX", color: "#FF6B35",
    matchups: [
      [T(1, "Florida", "florida"), { seed: 16, name: "First Four", id: "ff_south_16", isFirstFour: true }],
      [T(8, "Clemson", "clemson"), T(9, "Iowa", "iowa")],
      [T(5, "Vanderbilt", "vanderbilt"), T(12, "McNeese", "mcneese")],
      [T(4, "Nebraska", "nebraska"), T(13, "Troy", "troy")],
      [T(6, "North Carolina", "unc"), T(11, "VCU", "vcu")],
      [T(3, "Illinois", "illinois"), T(14, "Penn", "penn")],
      [T(7, "Saint Mary's", "saintmarys"), T(10, "Texas A&M", "texasam")],
      [T(2, "Houston", "houston"), T(15, "Idaho", "idaho")],
    ],
  },
  {
    id: "midwest", name: "Midwest", location: "Chicago, IL", color: "#FFD700",
    matchups: [
      [T(1, "Michigan", "michigan"), { seed: 16, name: "First Four", id: "ff_mw_16", isFirstFour: true }],
      [T(8, "Georgia", "georgia"), T(9, "Saint Louis", "saintlouis")],
      [T(5, "Texas Tech", "texastech"), T(12, "Akron", "akron")],
      [T(4, "Alabama", "alabama"), T(13, "Hofstra", "hofstra")],
      [T(6, "Tennessee", "tennessee"), { seed: 11, name: "First Four", id: "ff_mw_11", isFirstFour: true }],
      [T(3, "Virginia", "virginia"), T(14, "Wright State", "wrightst")],
      [T(7, "Kentucky", "kentucky"), T(10, "Santa Clara", "santaclara")],
      [T(2, "Iowa State", "iowastate"), T(15, "Tennessee St", "tennesseest")],
    ],
  },
];

// East vs South, West vs Midwest
const FF_PAIRS = [["east", "south"], ["west", "midwest"]];
const SCORING = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16, 6: 32 };
const ROUND_NAMES = { 1: "Round of 64", 2: "Round of 32", 3: "Sweet 16", 4: "Elite 8", 5: "Final Four", 6: "Championship" };
const DEADLINE = new Date("2026-03-19T16:15:00Z"); // 12:15 PM ET

// Build flat team map for lookups
const TEAM_MAP = {};
for (const r of REGIONS) {
  for (const [t1, t2] of r.matchups) {
    if (!t1.isFirstFour) TEAM_MAP[t1.id] = t1;
    if (!t2.isFirstFour) TEAM_MAP[t2.id] = t2;
  }
}
for (const ff of FIRST_FOUR) {
  for (const t of ff.teams) TEAM_MAP[t.id] = t;
}

// Build combo placeholder teams for unresolved First Four slots
const FF_COMBOS = {};
for (const ff of FIRST_FOUR) {
  const combo = {
    seed: ff.teams[0].seed,
    name: `${ff.teams[0].name} / ${ff.teams[1].name}`,
    id: ff.id,
    isCombo: true,
  };
  FF_COMBOS[ff.id] = combo;
  TEAM_MAP[ff.id] = combo;
}

// ===== WIN PROBABILITY (historical seed-based) =====
// Historical R64 win rates for the higher seed (1985-2025)
const SEED_MATCHUP_PCT = {
  "1_16": 99, "2_15": 94, "3_14": 85, "4_13": 79,
  "5_12": 65, "6_11": 63, "7_10": 61, "8_9": 51,
};

function getWinProb(team1, team2) {
  if (!team1 || !team2) return null;
  const s1 = team1.seed, s2 = team2.seed;
  if (s1 === s2) return { fav: null, pct1: 50, pct2: 50 };

  // Direct lookup for standard R64 matchups
  const lo = Math.min(s1, s2), hi = Math.max(s1, s2);
  const key = `${lo}_${hi}`;
  if (SEED_MATCHUP_PCT[key]) {
    const favPct = SEED_MATCHUP_PCT[key];
    return s1 < s2
      ? { fav: team1.id, pct1: favPct, pct2: 100 - favPct }
      : { fav: team2.id, pct1: 100 - favPct, pct2: favPct };
  }

  // For non-standard matchups (later rounds), use log5 formula with seed strength
  // Lower seed = stronger. Use a simple model: strength = (17 - seed) / 16
  const str1 = (17 - s1) / 16, str2 = (17 - s2) / 16;
  const p1 = Math.round((str1 / (str1 + str2)) * 100);
  const p2 = 100 - p1;
  return { fav: p1 >= p2 ? team1.id : team2.id, pct1: p1, pct2: p2 };
}

// ===== HELPERS =====
function resolveTeam(team, picks) {
  if (!team) return null;
  if (!team.isFirstFour) return team;
  const pickedId = picks[team.id];
  // If First Four winner is picked, show that team; otherwise show combo "Team1 / Team2"
  return pickedId ? TEAM_MAP[pickedId] : FF_COMBOS[team.id];
}

function getGameTeams(regionId, round, gameIndex, picks) {
  if (round === 1) {
    const region = REGIONS.find((r) => r.id === regionId);
    const [raw1, raw2] = region.matchups[gameIndex];
    return [resolveTeam(raw1, picks), resolveTeam(raw2, picks)];
  }
  const prev1 = picks[`${regionId}_${round - 1}_${gameIndex * 2}`];
  const prev2 = picks[`${regionId}_${round - 1}_${gameIndex * 2 + 1}`];
  return [prev1 ? TEAM_MAP[prev1] : null, prev2 ? TEAM_MAP[prev2] : null];
}

function getRegionWinner(regionId, picks) {
  const winnerId = picks[`${regionId}_4_0`];
  return winnerId ? TEAM_MAP[winnerId] : null;
}

function getFinalFourTeams(gameIndex, picks) {
  const [r1, r2] = FF_PAIRS[gameIndex];
  return [getRegionWinner(r1, picks), getRegionWinner(r2, picks)];
}

function getChampTeams(picks) {
  const w1Id = picks["ff_0"];
  const w2Id = picks["ff_1"];
  return [w1Id ? TEAM_MAP[w1Id] : null, w2Id ? TEAM_MAP[w2Id] : null];
}

function countPicks(picks) {
  return Object.keys(picks).filter((k) => picks[k]).length;
}

// When a pick changes, clear any downstream picks that depended on it
function clearDownstream(picks, key, newPick) {
  const newPicks = { ...picks, [key]: newPick };
  const parts = key.split("_");

  // First Four pick changed → update any R1 picks that used the combo ID
  if (key.startsWith("ff_") && !key.startsWith("ff_0") && !key.startsWith("ff_1")) {
    for (const region of REGIONS) {
      region.matchups.forEach(([t1, t2], gi) => {
        const r1Key = `${region.id}_1_${gi}`;
        if (t1.isFirstFour && t1.id === key) {
          // If user had picked the combo team, auto-update to the actual picked team
          if (newPicks[r1Key] === key) {
            newPicks[r1Key] = newPick;
          }
          // If the old specific pick no longer matches, clear it
          const oldPick = picks[key];
          if (oldPick && newPicks[r1Key] === oldPick && oldPick !== newPick) {
            delete newPicks[r1Key];
          }
        }
        if (t2.isFirstFour && t2.id === key) {
          if (newPicks[r1Key] === key) {
            newPicks[r1Key] = newPick;
          }
          const oldPick = picks[key];
          if (oldPick && newPicks[r1Key] === oldPick && oldPick !== newPick) {
            delete newPicks[r1Key];
          }
        }
      });
    }
  }

  // Regional pick changed → clear downstream in that region and beyond
  if (parts.length === 3) {
    const [regionId, roundStr, gameStr] = parts;
    const round = parseInt(roundStr);
    const game = parseInt(gameStr);
    const oldPick = picks[key];

    if (oldPick && oldPick !== newPick) {
      // Clear next round game that this feeds into
      for (let r = round + 1; r <= 4; r++) {
        const nextGame = Math.floor(game / Math.pow(2, r - round));
        const nextKey = `${regionId}_${r}_${nextGame}`;
        if (newPicks[nextKey] === oldPick) {
          delete newPicks[nextKey];
        }
      }
      // Clear Final Four picks that reference old winner
      const ffIdx = FF_PAIRS.findIndex((p) => p.includes(regionId));
      if (ffIdx >= 0 && newPicks[`ff_${ffIdx}`] === oldPick) {
        delete newPicks[`ff_${ffIdx}`];
      }
      if (newPicks["champ"] === oldPick) {
        delete newPicks["champ"];
      }
    }
  }

  // Final Four pick changed
  if (key === "ff_0" || key === "ff_1") {
    const oldPick = picks[key];
    if (oldPick && oldPick !== newPick && newPicks["champ"] === oldPick) {
      delete newPicks["champ"];
    }
  }

  return newPicks;
}

// ===== FIRESTORE =====
async function saveBracket(user, picks, entryName) {
  if (!user) return;
  try {
    await setDoc(doc(db, "brackets", user.uid), {
      picks,
      entryName: entryName || "",
      displayName: user.displayName || "Anonymous",
      photoURL: user.photoURL || null,
      email: user.email || null,
      updatedAt: new Date().toISOString(),
    });
    return true;
  } catch (e) {
    console.error("Save failed:", e);
    return false;
  }
}

async function loadBracket(uid) {
  try {
    const snap = await getDoc(doc(db, "brackets", uid));
    if (snap.exists()) {
      const data = snap.data();
      return { picks: data.picks || {}, entryName: data.entryName || "" };
    }
    return { picks: {}, entryName: "" };
  } catch (e) {
    console.error("Load failed:", e);
    return { picks: {}, entryName: "" };
  }
}

async function loadLeaderboard() {
  try {
    const snap = await getDocs(collection(db, "brackets"));
    const entries = [];
    snap.forEach((d) => {
      const data = d.data();
      entries.push({
        uid: d.id,
        entryName: data.entryName || "",
        displayName: data.displayName || "Anonymous",
        photoURL: data.photoURL,
        picks: data.picks || {},
        updatedAt: data.updatedAt,
      });
    });
    return entries;
  } catch (e) {
    console.error("Leaderboard load failed:", e);
    return [];
  }
}

// ===== COMPONENTS =====

function TeamRow({ team, isSelected, isPicked, onPick, color, disabled, winPct, isFav }) {
  if (!team) {
    return (
      <div style={{
        padding: "10px 12px", display: "flex", alignItems: "center", gap: 8,
        color: "#444", fontSize: 13, fontStyle: "italic",
      }}>
        <span style={{ width: 24, textAlign: "center", fontSize: 11, color: "#333" }}>—</span>
        <span>Waiting for pick...</span>
      </div>
    );
  }

  return (
    <div
      onClick={() => !disabled && onPick(team.id)}
      style={{
        padding: "10px 12px", display: "flex", alignItems: "center", gap: 8,
        background: isSelected ? (color || "#CC0000") + "22" : "transparent",
        borderLeft: isSelected ? `3px solid ${color || "#CC0000"}` : "3px solid transparent",
        cursor: disabled ? "default" : "pointer",
        transition: "all 0.15s",
        opacity: isPicked && !isSelected ? 0.4 : 1,
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = isSelected ? (color || "#CC0000") + "22" : "#ffffff08"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = isSelected ? (color || "#CC0000") + "22" : "transparent"; }}
    >
      <span style={{
        width: 24, textAlign: "center", fontSize: 11, fontWeight: 700,
        color: isSelected ? color || "#CC0000" : "#666",
      }}>
        {team.seed}
      </span>
      <span style={{
        flex: 1, fontSize: team.isCombo ? 11 : 13, fontWeight: isSelected ? 700 : 500,
        color: isSelected ? "#fff" : isPicked ? "#555" : team.isCombo ? "#9a9aaa" : "#ccc",
        fontStyle: team.isCombo ? "italic" : "normal",
      }}>
        {team.name}
      </span>
      {winPct != null && !isPicked && (
        <span style={{
          fontSize: 10, fontWeight: isFav ? 700 : 400,
          color: isFav ? "#4CAF50" : "#555",
          minWidth: 32, textAlign: "right",
        }}>
          {winPct}%
        </span>
      )}
      {isSelected && (
        <span style={{ color: color || "#CC0000", fontSize: 14, fontWeight: 700 }}>✓</span>
      )}
    </div>
  );
}

function MatchupCard({ team1, team2, picked, onPick, color, gameKey, roundPoints }) {
  const prob = getWinProb(team1, team2);

  return (
    <div style={{
      background: "#12121f", border: "1px solid #2a2a3e", borderRadius: 10,
      overflow: "hidden", minWidth: 200,
    }}>
      <TeamRow
        team={team1} isSelected={picked === team1?.id}
        isPicked={!!picked} onPick={onPick} color={color}
        disabled={!team1}
        winPct={prob?.pct1} isFav={prob?.fav === team1?.id}
      />
      {/* Probability bar */}
      {prob && !picked && team1 && team2 && (
        <div style={{ display: "flex", height: 3, background: "#1a1a2e" }}>
          <div style={{
            width: `${prob.pct1}%`, height: "100%",
            background: prob.fav === team1?.id ? "#4CAF50" : "#ffffff18",
            transition: "width 0.3s",
          }} />
          <div style={{
            width: `${prob.pct2}%`, height: "100%",
            background: prob.fav === team2?.id ? "#4CAF50" : "#ffffff18",
            transition: "width 0.3s",
          }} />
        </div>
      )}
      {(picked || !prob || !team1 || !team2) && <div style={{ borderTop: "1px solid #2a2a3e" }} />}
      <TeamRow
        team={team2} isSelected={picked === team2?.id}
        isPicked={!!picked} onPick={onPick} color={color}
        disabled={!team2}
        winPct={prob?.pct2} isFav={prob?.fav === team2?.id}
      />
      {roundPoints && (
        <div style={{
          borderTop: "1px solid #2a2a3e", padding: "3px 12px",
          fontSize: 9, color: "#555", textAlign: "right",
        }}>
          {roundPoints} pt{roundPoints > 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}

function FirstFourTab({ picks, onPick, color }) {
  return (
    <div>
      <div style={{ ...sectionHeader }}>First Four — Dayton, OH</div>
      <div style={{ color: "#888", fontSize: 12, marginBottom: 16 }}>
        Pick the winner of each play-in game. Winners advance to the main bracket.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
        {FIRST_FOUR.map((ff) => {
          const regionName = REGIONS.find((r) => r.id === ff.region)?.name || ff.region;
          return (
            <div key={ff.id}>
              <div style={{ fontSize: 10, color: "#666", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
                {regionName} Region — {ff.teams[0].seed} Seed
              </div>
              <MatchupCard
                team1={ff.teams[0]} team2={ff.teams[1]}
                picked={picks[ff.id]}
                onPick={(teamId) => onPick(ff.id, teamId)}
                color={color}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RegionTab({ region, picks, onPick }) {
  const rounds = [1, 2, 3, 4];
  const gamesPerRound = [8, 4, 2, 1];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <div style={{
          width: 6, height: 24, borderRadius: 3,
          background: region.color,
        }} />
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>{region.name} Region</div>
          <div style={{ fontSize: 11, color: "#888" }}>{region.location}</div>
        </div>
      </div>

      {rounds.map((round) => {
        const numGames = gamesPerRound[round - 1];
        return (
          <div key={round} style={{ marginBottom: 20 }}>
            <div style={{ ...sectionHeader, color: region.color }}>
              {ROUND_NAMES[round]}
              <span style={{ fontSize: 10, color: "#555", marginLeft: 8, fontWeight: 400 }}>
                {SCORING[round]} pt{SCORING[round] > 1 ? "s" : ""} each
              </span>
            </div>
            <div style={{
              display: "grid",
              gridTemplateColumns: `repeat(auto-fill, minmax(${round <= 2 ? "220px" : "260px"}, 1fr))`,
              gap: 10,
            }}>
              {Array.from({ length: numGames }, (_, gi) => {
                const [t1, t2] = getGameTeams(region.id, round, gi, picks);
                const gameKey = `${region.id}_${round}_${gi}`;
                return (
                  <MatchupCard
                    key={gameKey}
                    team1={t1} team2={t2}
                    picked={picks[gameKey]}
                    onPick={(teamId) => onPick(gameKey, teamId)}
                    color={region.color}
                    roundPoints={SCORING[round]}
                  />
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Region Winner */}
      {(() => {
        const winner = getRegionWinner(region.id, picks);
        return winner ? (
          <div style={{
            background: region.color + "15", border: `1px solid ${region.color}44`,
            borderRadius: 12, padding: 16, textAlign: "center",
          }}>
            <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>
              {region.name} Region Champion
            </div>
            <div style={{ fontSize: 20, fontWeight: 800, color: region.color }}>
              ({winner.seed}) {winner.name}
            </div>
          </div>
        ) : null;
      })()}
    </div>
  );
}

function FinalFourTab({ picks, onPick }) {
  return (
    <div>
      <div style={{ textAlign: "center", marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#fff" }}>Final Four</div>
        <div style={{ fontSize: 12, color: "#888" }}>Lucas Oil Stadium — Indianapolis, IN</div>
      </div>

      <div style={{ ...sectionHeader, color: "#CC0000" }}>
        National Semifinals
        <span style={{ fontSize: 10, color: "#555", marginLeft: 8, fontWeight: 400 }}>16 pts each</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12, marginBottom: 24 }}>
        {FF_PAIRS.map((pair, i) => {
          const [t1, t2] = getFinalFourTeams(i, picks);
          const r1 = REGIONS.find((r) => r.id === pair[0]);
          const r2 = REGIONS.find((r) => r.id === pair[1]);
          return (
            <div key={i}>
              <div style={{ fontSize: 10, color: "#666", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
                {r1.name} vs {r2.name}
              </div>
              <MatchupCard
                team1={t1} team2={t2}
                picked={picks[`ff_${i}`]}
                onPick={(teamId) => onPick(`ff_${i}`, teamId)}
                color="#CC0000"
                roundPoints={16}
              />
            </div>
          );
        })}
      </div>

      <div style={{ ...sectionHeader, color: "#FFD700" }}>
        National Championship
        <span style={{ fontSize: 10, color: "#555", marginLeft: 8, fontWeight: 400 }}>32 pts</span>
      </div>
      {(() => {
        const [t1, t2] = getChampTeams(picks);
        return (
          <div style={{ maxWidth: 300, margin: "0 auto" }}>
            <MatchupCard
              team1={t1} team2={t2}
              picked={picks["champ"]}
              onPick={(teamId) => onPick("champ", teamId)}
              color="#FFD700"
              roundPoints={32}
            />
          </div>
        );
      })()}

      {/* Champion Display */}
      {picks["champ"] && TEAM_MAP[picks["champ"]] && (
        <div style={{
          background: "linear-gradient(135deg, #FFD70022, #CC000022)",
          border: "1px solid #FFD70044", borderRadius: 16, padding: 24,
          textAlign: "center", marginTop: 24,
        }}>
          <div style={{ fontSize: 32, marginBottom: 4 }}>🏆</div>
          <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 2, marginBottom: 4 }}>
            Your National Champion
          </div>
          <div style={{ fontSize: 28, fontWeight: 900, color: "#FFD700" }}>
            {TEAM_MAP[picks["champ"]].name}
          </div>
          <div style={{ fontSize: 13, color: "#ccc", marginTop: 4 }}>
            ({TEAM_MAP[picks["champ"]].seed} seed)
          </div>
        </div>
      )}
    </div>
  );
}

function Leaderboard({ entries, currentUid }) {
  // Sort by number of picks for now (score will be 0 until games are played)
  const sorted = [...entries].sort((a, b) => {
    const aPicks = countPicks(a.picks);
    const bPicks = countPicks(b.picks);
    return bPicks - aPicks;
  });

  return (
    <div>
      <div style={{ textAlign: "center", marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#fff" }}>Leaderboard</div>
        <div style={{ fontSize: 12, color: "#888" }}>
          {sorted.length} bracket{sorted.length !== 1 ? "s" : ""} submitted
        </div>
        <div style={{ fontSize: 11, color: "#555", marginTop: 4 }}>
          Scoring starts when games begin March 19. Points: R64=1, R32=2, S16=4, E8=8, FF=16, Champ=32
        </div>
      </div>

      {sorted.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "#555" }}>
          No brackets submitted yet. Be the first!
        </div>
      ) : (
        <div style={{ background: "#12121f", borderRadius: 12, overflow: "hidden", border: "1px solid #2a2a3e" }}>
          {/* Header */}
          <div style={{
            display: "grid", gridTemplateColumns: "40px 1fr 80px 80px",
            padding: "10px 16px", borderBottom: "1px solid #2a2a3e",
            fontSize: 10, color: "#666", textTransform: "uppercase", letterSpacing: 0.5,
          }}>
            <div>#</div>
            <div>Player</div>
            <div style={{ textAlign: "center" }}>Picks</div>
            <div style={{ textAlign: "center" }}>Score</div>
          </div>

          {sorted.map((entry, i) => {
            const isMe = entry.uid === currentUid;
            const numPicks = countPicks(entry.picks);
            const champion = entry.picks["champ"] ? TEAM_MAP[entry.picks["champ"]]?.name : "—";
            return (
              <div key={entry.uid} style={{
                display: "grid", gridTemplateColumns: "40px 1fr 80px 80px",
                padding: "12px 16px", borderBottom: "1px solid #1a1a2e",
                background: isMe ? "#CC000012" : i % 2 === 0 ? "#0f0f1e" : "transparent",
                borderLeft: isMe ? "3px solid #CC0000" : "3px solid transparent",
              }}>
                <div style={{ color: i < 3 ? "#FFD700" : "#888", fontWeight: 700, fontSize: 14 }}>
                  {i + 1}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {entry.photoURL && (
                    <img src={entry.photoURL} alt="" referrerPolicy="no-referrer"
                      style={{ width: 24, height: 24, borderRadius: "50%", border: isMe ? "2px solid #CC0000" : "1px solid #333" }}
                    />
                  )}
                  <div>
                    <div style={{ fontSize: 13, fontWeight: isMe ? 700 : 500, color: isMe ? "#fff" : "#ccc" }}>
                      {entry.entryName || entry.displayName} {isMe && <span style={{ fontSize: 9, color: "#CC0000" }}>(you)</span>}
                    </div>
                    <div style={{ fontSize: 10, color: "#555" }}>
                      Champion: {champion}
                    </div>
                  </div>
                </div>
                <div style={{ textAlign: "center", color: "#888", fontSize: 13, alignSelf: "center" }}>
                  {numPicks}/67
                </div>
                <div style={{ textAlign: "center", color: "#FFD700", fontSize: 15, fontWeight: 700, alignSelf: "center" }}>
                  0
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ===== STYLES =====
const sectionHeader = {
  fontSize: 12, fontWeight: 700, textTransform: "uppercase",
  letterSpacing: 1, marginBottom: 10, color: "#888",
  display: "flex", alignItems: "center",
};

// ===== MAIN COMPONENT =====
export default function BracketChallenge({ user, onBack }) {
  const [picks, setPicks] = useState({});
  const [tab, setTab] = useState("east");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [leaderboard, setLeaderboard] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [entryName, setEntryName] = useState("");

  // Load user's bracket and leaderboard on mount
  useEffect(() => {
    if (user) {
      loadBracket(user.uid).then(({ picks: p, entryName: en }) => {
        if (p && Object.keys(p).length > 0) setPicks(p);
        if (en) setEntryName(en);
        setLoaded(true);
      });
    } else {
      setLoaded(true);
    }
    loadLeaderboard().then(setLeaderboard);
  }, [user]);

  const handlePick = useCallback((gameKey, teamId) => {
    setPicks((prev) => {
      // If clicking the same team, deselect
      if (prev[gameKey] === teamId) {
        const next = { ...prev };
        delete next[gameKey];
        return next;
      }
      return clearDownstream(prev, gameKey, teamId);
    });
    setSaved(false);
  }, []);

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    const ok = await saveBracket(user, picks, entryName);
    setSaving(false);
    if (ok) {
      setSaved(true);
      // Refresh leaderboard
      loadLeaderboard().then(setLeaderboard);
    }
  };

  const totalPicks = countPicks(picks);

  const tabs = [
    { id: "first4", label: "First Four" },
    ...REGIONS.map((r) => ({ id: r.id, label: r.name })),
    { id: "ff", label: "Final Four" },
    { id: "lb", label: "Leaderboard" },
  ];

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(180deg, #0a0a16 0%, #0f0f1e 50%, #0a0a16 100%)",
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      color: "#fff",
    }}>
      {/* Header */}
      <header style={{
        background: "linear-gradient(135deg, #12121f 0%, #1a1a30 100%)",
        borderBottom: "1px solid #2a2a3e", padding: "14px 20px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(12px)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={onBack} style={{
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
              🏀 March Madness <span style={{ color: "#CC0000" }}>2026</span>
            </h1>
            <p style={{ margin: 0, fontSize: 10, color: "#666" }}>BRACKET CHALLENGE</p>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, color: "#888" }}>{totalPicks}/67 picks</div>
            <div style={{
              width: 80, height: 4, background: "#1a1a2e", borderRadius: 2, marginTop: 2,
            }}>
              <div style={{
                width: `${(totalPicks / 67) * 100}%`, height: "100%",
                background: totalPicks === 67 ? "#4CAF50" : "#CC0000",
                borderRadius: 2, transition: "width 0.3s",
              }} />
            </div>
          </div>

          {user ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="text"
                value={entryName}
                onChange={(e) => { setEntryName(e.target.value); setSaved(false); }}
                placeholder={user.displayName || "Entry name"}
                style={{
                  background: "#1a1a2e", border: "1px solid #2a2a3e", borderRadius: 8,
                  padding: "8px 12px", color: "#ccc", fontSize: 12, width: 140,
                  outline: "none",
                }}
              />
              <button onClick={handleSave} disabled={saving} style={{
                background: saved ? "#4CAF5022" : "#CC000022",
                border: `1px solid ${saved ? "#4CAF5066" : "#CC000066"}`,
                borderRadius: 8, padding: "8px 16px",
                color: saved ? "#4CAF50" : "#CC0000",
                fontSize: 12, fontWeight: 700, cursor: saving ? "wait" : "pointer",
              }}>
                {saving ? "Saving..." : saved ? "✓ Saved" : "Save Bracket"}
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 11, color: "#666" }}>Sign in to save</div>
          )}
        </div>
      </header>

      {/* Tab Navigation */}
      <div style={{
        display: "flex", gap: 2, padding: "0 20px",
        background: "#0d0d1a", borderBottom: "1px solid #1a1a2e",
        overflowX: "auto", whiteSpace: "nowrap",
      }}>
        {tabs.map((t) => {
          const isActive = tab === t.id;
          const region = REGIONS.find((r) => r.id === t.id);
          const color = region?.color || (t.id === "ff" ? "#CC0000" : t.id === "lb" ? "#FFD700" : "#888");
          return (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              background: isActive ? color + "15" : "transparent",
              border: "none",
              borderBottom: isActive ? `2px solid ${color}` : "2px solid transparent",
              padding: "10px 14px", fontSize: 11, fontWeight: isActive ? 700 : 500,
              color: isActive ? color : "#666",
              cursor: "pointer", transition: "all 0.2s",
              textTransform: "uppercase", letterSpacing: 0.3,
              flexShrink: 0,
            }}>
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <main style={{ padding: "20px", maxWidth: 1100, margin: "0 auto" }}>
        {!loaded ? (
          <div style={{ textAlign: "center", padding: 60, color: "#555" }}>Loading bracket...</div>
        ) : (
          <>
            {tab === "first4" && <FirstFourTab picks={picks} onPick={handlePick} color="#CC0000" />}
            {REGIONS.map((r) => tab === r.id && <RegionTab key={r.id} region={r} picks={picks} onPick={handlePick} />)}
            {tab === "ff" && <FinalFourTab picks={picks} onPick={handlePick} />}
            {tab === "lb" && <Leaderboard entries={leaderboard} currentUid={user?.uid} />}
          </>
        )}
      </main>

      {/* Footer */}
      <footer style={{
        textAlign: "center", padding: "16px 20px", borderTop: "1px solid #1a1a2e",
        color: "#444", fontSize: 10,
      }}>
        Utah Sports HQ — March Madness 2026 Bracket Challenge | Max possible: 192 pts
      </footer>
    </div>
  );
}
