import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { auth, db } from "./firebase";
import {
  doc,
  setDoc,
  getDoc,
  collection,
  getDocs,
  addDoc,
  query,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
} from "firebase/firestore";

// ===== BRACKET DEADLINE =====
// Thursday March 19, 2026 at 12:15 PM ET (UTC-4)
const BRACKET_DEADLINE = new Date("2026-03-19T12:15:00-04:00");

function isBracketLocked() {
  return Date.now() >= BRACKET_DEADLINE.getTime();
}

function getTimeUntilDeadline() {
  const diff = BRACKET_DEADLINE.getTime() - Date.now();
  if (diff <= 0) return null;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

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

// ===== SCORING ENGINE =====
// Given actual results, find each bracket game key whose winner matches

// Build a reverse lookup: for each team id, which R1 game key does it appear in?
const TEAM_TO_R1_GAME = {};
for (const region of REGIONS) {
  region.matchups.forEach(([t1, t2], gi) => {
    const gameKey = `${region.id}_1_${gi}`;
    if (!t1.isFirstFour) TEAM_TO_R1_GAME[t1.id] = { gameKey, region: region.id, gameIndex: gi };
    if (!t2.isFirstFour) TEAM_TO_R1_GAME[t2.id] = { gameKey, region: region.id, gameIndex: gi };
    // Also map First Four placeholder IDs
    if (t1.isFirstFour) {
      const ff = FIRST_FOUR.find((f) => f.id === t1.id);
      if (ff) ff.teams.forEach((t) => { TEAM_TO_R1_GAME[t.id] = { gameKey, region: region.id, gameIndex: gi, isFirstFour: t1.id }; });
    }
    if (t2.isFirstFour) {
      const ff = FIRST_FOUR.find((f) => f.id === t2.id);
      if (ff) ff.teams.forEach((t) => { TEAM_TO_R1_GAME[t.id] = { gameKey, region: region.id, gameIndex: gi, isFirstFour: t2.id }; });
    }
  });
}

// Build actual results from ESPN game data
// Returns an object: { "east_1_0": "duke", "east_2_0": "duke", ... }
function buildActualResults(games) {
  const results = {};
  if (!games || !games.length) return results;

  // Get only completed games with winners
  const completed = games.filter((g) => g.status === "final" && g.winnerId);

  // First pass: map First Four results
  for (const game of completed) {
    if (game.round === 0) {
      // First Four game - find which First Four slot this belongs to
      for (const ff of FIRST_FOUR) {
        const ids = ff.teams.map((t) => t.id);
        if (ids.includes(game.winnerId)) {
          results[ff.id] = game.winnerId;
          break;
        }
      }
    }
  }

  // Second pass: map Round 1 (R64) results
  for (const game of completed) {
    if (game.round === 1 || (!game.round && game.winnerId)) {
      const winnerInfo = TEAM_TO_R1_GAME[game.winnerId];
      const loserInfo = TEAM_TO_R1_GAME[game.loserId];
      if (winnerInfo && loserInfo && winnerInfo.gameKey === loserInfo.gameKey) {
        results[winnerInfo.gameKey] = game.winnerId;
      }
    }
  }

  // For rounds 2-4: walk the bracket forward using actual results
  for (const region of REGIONS) {
    for (let round = 2; round <= 4; round++) {
      const gamesInRound = 8 / Math.pow(2, round);
      for (let gi = 0; gi < gamesInRound; gi++) {
        // The two feeder games
        const feeder1Key = `${region.id}_${round - 1}_${gi * 2}`;
        const feeder2Key = `${region.id}_${round - 1}_${gi * 2 + 1}`;
        const team1 = results[feeder1Key];
        const team2 = results[feeder2Key];
        if (!team1 || !team2) continue;

        // Find if there's a completed game between these two teams
        const match = completed.find(
          (g) => (g.winnerId === team1 || g.winnerId === team2) &&
                 (g.loserId === team1 || g.loserId === team2)
        );
        if (match) {
          results[`${region.id}_${round}_${gi}`] = match.winnerId;
        }
      }
    }
  }

  // Final Four
  for (let gi = 0; gi < 2; gi++) {
    const [r1, r2] = FF_PAIRS[gi];
    const team1 = results[`${r1}_4_0`]; // region winner
    const team2 = results[`${r2}_4_0`];
    if (!team1 || !team2) continue;
    const match = completed.find(
      (g) => (g.winnerId === team1 || g.winnerId === team2) &&
             (g.loserId === team1 || g.loserId === team2)
    );
    if (match) {
      results[`ff_${gi}`] = match.winnerId;
    }
  }

  // Championship
  const ffWinner1 = results["ff_0"];
  const ffWinner2 = results["ff_1"];
  if (ffWinner1 && ffWinner2) {
    const match = completed.find(
      (g) => (g.winnerId === ffWinner1 || g.winnerId === ffWinner2) &&
             (g.loserId === ffWinner1 || g.loserId === ffWinner2)
    );
    if (match) {
      results["champ"] = match.winnerId;
    }
  }

  return results;
}

// Score a user's picks against actual results
function scoreBracket(picks, actualResults) {
  let total = 0;
  const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  let correctPicks = 0;
  let possiblePicks = 0;

  // Score regional rounds (1-4) for each region
  for (const region of REGIONS) {
    for (let round = 1; round <= 4; round++) {
      const gamesInRound = 8 / Math.pow(2, round);
      for (let gi = 0; gi < gamesInRound; gi++) {
        const key = `${region.id}_${round}_${gi}`;
        if (actualResults[key]) {
          possiblePicks++;
          if (picks[key] === actualResults[key]) {
            const pts = SCORING[round] || 0;
            total += pts;
            breakdown[round] = (breakdown[round] || 0) + pts;
            correctPicks++;
          }
        }
      }
    }
  }

  // Score Final Four (round 5)
  for (let gi = 0; gi < 2; gi++) {
    const key = `ff_${gi}`;
    if (actualResults[key]) {
      possiblePicks++;
      if (picks[key] === actualResults[key]) {
        total += SCORING[5];
        breakdown[5] = (breakdown[5] || 0) + SCORING[5];
        correctPicks++;
      }
    }
  }

  // Score Championship (round 6)
  if (actualResults["champ"]) {
    possiblePicks++;
    if (picks["champ"] === actualResults["champ"]) {
      total += SCORING[6];
      breakdown[6] = (breakdown[6] || 0) + SCORING[6];
      correctPicks++;
    }
  }

  return { total, breakdown, correctPicks, possiblePicks };
}

// Fetch results from our API
async function fetchTournamentResults() {
  try {
    const resp = await fetch("/api/ncaa-results");
    if (!resp.ok) return null;
    const data = await resp.json();
    return data;
  } catch (e) {
    console.error("Failed to fetch tournament results:", e);
    return null;
  }
}

// ===== FIRESTORE =====
function entryDocId(uid, entryNum) {
  return entryNum === 1 ? uid : `${uid}_${entryNum}`;
}

async function saveBracket(user, picks, entryName, entryNum = 1, profile = null) {
  if (!user) return;
  try {
    const username = profile?.username || user.displayName || "Anonymous";
    const photoURL = profile?.photoURL || user.photoURL || null;
    await setDoc(doc(db, "brackets", entryDocId(user.uid, entryNum)), {
      picks,
      entryName: entryName || "",
      entryNum,
      ownerUid: user.uid,
      displayName: username,
      photoURL,
      email: user.email || null,
      updatedAt: new Date().toISOString(),
    });
    return true;
  } catch (e) {
    console.error("Save failed:", e);
    return false;
  }
}

async function loadBracket(uid, entryNum = 1) {
  try {
    const snap = await getDoc(doc(db, "brackets", entryDocId(uid, entryNum)));
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

async function loadUserEntries(uid) {
  try {
    const results = await Promise.all([
      getDoc(doc(db, "brackets", entryDocId(uid, 1))),
      getDoc(doc(db, "brackets", entryDocId(uid, 2))),
    ]);
    return results.map((snap, i) => {
      if (!snap.exists()) return null;
      const d = snap.data();
      return { entryNum: i + 1, picks: d.picks || {}, entryName: d.entryName || "", updatedAt: d.updatedAt };
    });
  } catch (e) {
    console.error("Load entries failed:", e);
    return [null, null];
  }
}

async function loadLeaderboard() {
  try {
    // Fetch brackets and user profiles in parallel
    const [bracketSnap, usersSnap] = await Promise.all([
      getDocs(collection(db, "brackets")),
      getDocs(collection(db, "users")),
    ]);
    // Build a map of uid -> latest user profile data
    const userMap = {};
    usersSnap.forEach((d) => {
      const data = d.data();
      userMap[d.id] = { photoURL: data.photoURL, displayName: data.username || data.displayName };
    });
    const entries = [];
    bracketSnap.forEach((d) => {
      const data = d.data();
      const uid = data.ownerUid || d.id;
      const freshUser = userMap[uid];
      entries.push({
        docId: d.id,
        ownerUid: uid,
        entryNum: data.entryNum || 1,
        entryName: data.entryName || "",
        displayName: freshUser?.displayName || data.displayName || "Anonymous",
        photoURL: freshUser?.photoURL || data.photoURL,
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

// Export for use in App.jsx banner
export { loadUserEntries };

// ===== COMPONENTS =====

function MatchupBox({ team1, team2, picked, onPick, gameKey, disabled }) {
  const isSelected1 = picked === team1?.id;
  const isSelected2 = picked === team2?.id;

  const handleClick = (teamId) => {
    if (disabled) return;
    onPick(teamId);
  };

  return (
    <div style={{
      background: "#12121f", border: "1px solid #2a2a3e", borderRadius: 6,
      minWidth: 140, fontSize: 11, overflow: "hidden",
    }}>
      {/* Team 1 */}
      <div
        onClick={() => handleClick(team1?.id)}
        style={{
          padding: "6px 8px", display: "flex", alignItems: "center", gap: 6,
          borderBottom: "1px solid #2a2a3e",
          background: isSelected1 ? "#CC000022" : team1 ? "#ffffff04" : "#1a1a2e",
          cursor: !disabled && team1 ? "pointer" : "default",
          transition: "all 0.15s",
        }}
        onMouseEnter={(e) => {
          if (!disabled && team1) e.currentTarget.style.background = "#CC000044";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = isSelected1 ? "#CC000022" : team1 ? "#ffffff04" : "#1a1a2e";
        }}
      >
        {/* Radio circle */}
        <div style={{
          width: 12, height: 12, borderRadius: "50%",
          border: isSelected1 ? "3px solid #CC0000" : "2px solid #444",
          background: isSelected1 ? "#CC0000" : "transparent",
          flexShrink: 0,
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {team1 ? (
            <>
              <div style={{ fontSize: 9, color: "#666", fontWeight: 700 }}>
                {team1.seed}
              </div>
              <div style={{
                fontSize: 10, fontWeight: isSelected1 ? 700 : 500,
                color: isSelected1 ? "#fff" : team1.isCombo ? "#9a9aaa" : "#ccc",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                fontStyle: team1.isCombo ? "italic" : "normal",
              }}>
                {team1.name}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 9, color: "#333", fontStyle: "italic" }}>—</div>
          )}
        </div>
      </div>

      {/* Team 2 */}
      <div
        onClick={() => handleClick(team2?.id)}
        style={{
          padding: "6px 8px", display: "flex", alignItems: "center", gap: 6,
          background: isSelected2 ? "#CC000022" : team2 ? "#ffffff04" : "#1a1a2e",
          cursor: !disabled && team2 ? "pointer" : "default",
          transition: "all 0.15s",
        }}
        onMouseEnter={(e) => {
          if (!disabled && team2) e.currentTarget.style.background = "#CC000044";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = isSelected2 ? "#CC000022" : team2 ? "#ffffff04" : "#1a1a2e";
        }}
      >
        {/* Radio circle */}
        <div style={{
          width: 12, height: 12, borderRadius: "50%",
          border: isSelected2 ? "3px solid #CC0000" : "2px solid #444",
          background: isSelected2 ? "#CC0000" : "transparent",
          flexShrink: 0,
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {team2 ? (
            <>
              <div style={{ fontSize: 9, color: "#666", fontWeight: 700 }}>
                {team2.seed}
              </div>
              <div style={{
                fontSize: 10, fontWeight: isSelected2 ? 700 : 500,
                color: isSelected2 ? "#fff" : team2.isCombo ? "#9a9aaa" : "#ccc",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                fontStyle: team2.isCombo ? "italic" : "normal",
              }}>
                {team2.name}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 9, color: "#333", fontStyle: "italic" }}>—</div>
          )}
        </div>
      </div>
    </div>
  );
}

function useIsMobile(breakpoint = 700) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth <= breakpoint : false
  );
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= breakpoint);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [breakpoint]);
  return isMobile;
}

function MobileRegionView({ region, picks, onPick }) {
  const rounds = [1, 2, 3, 4];
  const matchupsPerRound = [8, 4, 2, 1];
  const roundLabels = { 1: "Round of 64", 2: "Round of 32", 3: "Sweet 16", 4: "Elite 8" };
  const [activeRound, setActiveRound] = useState(1);

  // Count picks per round for this region
  const roundProgress = {};
  let regionTotal = 0;
  const regionMax = 15; // 8+4+2+1
  rounds.forEach((round) => {
    const games = matchupsPerRound[round - 1];
    let picked = 0;
    for (let gi = 0; gi < games; gi++) {
      if (picks[`${region.id}_${round}_${gi}`]) picked++;
    }
    roundProgress[round] = { picked, total: games };
    regionTotal += picked;
  });

  const regionComplete = regionTotal === regionMax;

  return (
    <div style={{
      background: "#0a0a16", borderRadius: 12, border: `1px solid ${regionComplete ? region.color + "66" : "#2a2a3e"}`,
      padding: 12, marginBottom: 12,
    }}>
      {/* Region Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{ width: 4, height: 28, borderRadius: 2, background: region.color }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>
            {region.name} Region
          </div>
          <div style={{ fontSize: 10, color: "#888" }}>{region.location}</div>
        </div>
        {/* Region progress badge */}
        <div style={{
          background: regionComplete ? "#4CAF5022" : region.color + "15",
          border: `1px solid ${regionComplete ? "#4CAF5066" : region.color + "44"}`,
          borderRadius: 8, padding: "4px 10px", textAlign: "center",
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: regionComplete ? "#4CAF50" : region.color }}>
            {regionComplete ? "✓" : `${regionTotal}/${regionMax}`}
          </div>
          <div style={{ fontSize: 8, color: regionComplete ? "#4CAF50" : "#666" }}>
            {regionComplete ? "Complete" : "picks"}
          </div>
        </div>
      </div>

      {/* Region winner display */}
      {(() => {
        const winner = getRegionWinner(region.id, picks);
        return winner ? (
          <div style={{
            background: region.color + "15", border: `1px solid ${region.color}44`,
            borderRadius: 8, padding: "6px 12px", marginBottom: 10, textAlign: "center",
            fontSize: 11, color: region.color, fontWeight: 600,
          }}>
            🏆 Region Winner: <span style={{ color: "#fff" }}>{winner.seed} {winner.name}</span>
          </div>
        ) : null;
      })()}

      {/* Round Tabs with progress dots */}
      <div style={{ display: "flex", gap: 3, marginBottom: 10, overflowX: "auto" }}>
        {rounds.map((round) => {
          const active = activeRound === round;
          const { picked, total } = roundProgress[round];
          const roundDone = picked === total;
          return (
            <button key={round} onClick={() => setActiveRound(round)} style={{
              flex: 1, background: active ? region.color + "22" : roundDone ? "#4CAF5010" : "#12121f",
              border: active ? `1px solid ${region.color}66` : roundDone ? "1px solid #4CAF5044" : "1px solid #2a2a3e",
              borderRadius: 6, padding: "6px 4px", cursor: "pointer",
              color: active ? region.color : roundDone ? "#4CAF50" : "#666",
              fontSize: 9, fontWeight: 700,
              textTransform: "uppercase", letterSpacing: 0.3, whiteSpace: "nowrap",
              transition: "all 0.15s",
            }}>
              {round === 1 ? "R64" : round === 2 ? "R32" : round === 3 ? "S16" : "E8"}
              <div style={{ fontSize: 7, marginTop: 2, color: active ? region.color : roundDone ? "#4CAF50" : "#555" }}>
                {roundDone ? "✓" : `${picked}/${total}`}
              </div>
            </button>
          );
        })}
      </div>

      {/* Round instruction */}
      <div style={{
        fontSize: 10, color: "#888", marginBottom: 8, padding: "0 2px",
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span>
          {roundLabels[activeRound]} — <span style={{ color: region.color }}>Tap a team</span> to pick the winner
        </span>
        <span style={{ color: "#FFD700", fontSize: 9 }}>{SCORING[activeRound]} pt{SCORING[activeRound] > 1 ? "s" : ""} each</span>
      </div>

      {/* Active Round Matchups */}
      <div style={{ display: "grid", gridTemplateColumns: matchupsPerRound[activeRound - 1] === 1 ? "1fr" : "1fr 1fr", gap: 8 }}>
        {Array.from({ length: matchupsPerRound[activeRound - 1] }, (_, gameIdx) => {
          const [t1, t2] = getGameTeams(region.id, activeRound, gameIdx, picks);
          const gameKey = `${region.id}_${activeRound}_${gameIdx}`;
          return (
            <MatchupBox
              key={gameKey}
              team1={t1}
              team2={t2}
              picked={picks[gameKey]}
              onPick={(teamId) => onPick(gameKey, teamId)}
              gameKey={gameKey}
              disabled={!t1 || !t2}
            />
          );
        })}
      </div>

      {/* Next round hint */}
      {roundProgress[activeRound].picked === roundProgress[activeRound].total && activeRound < 4 && (
        <button onClick={() => setActiveRound(activeRound + 1)} style={{
          width: "100%", marginTop: 10, padding: "8px", background: region.color + "15",
          border: `1px solid ${region.color}44`, borderRadius: 8,
          color: region.color, fontSize: 11, fontWeight: 600, cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        }}>
          ✓ Round complete — Continue to {roundLabels[activeRound + 1]} →
        </button>
      )}
    </div>
  );
}

function RegionalBracketView({ region, picks, onPick }) {
  const rounds = [1, 2, 3, 4];
  const matchupsPerRound = [8, 4, 2, 1];
  const spacingMultipliers = [1, 2, 4, 8];
  const MATCHUP_HEIGHT = 64;
  const VERTICAL_GAP = 8;

  return (
    <div style={{
      background: "#0a0a16", borderRadius: 12, border: "1px solid #2a2a3e",
      padding: 16, marginBottom: 16, overflowX: "auto",
    }}>
      {/* Region Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, marginBottom: 20,
      }}>
        <div style={{
          width: 6, height: 24, borderRadius: 3, background: region.color,
        }} />
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>
            {region.name} Region
          </div>
          <div style={{ fontSize: 11, color: "#888" }}>
            {region.location}
          </div>
        </div>
      </div>

      {/* Bracket Grid */}
      <div style={{
        display: "flex", gap: 24, minWidth: "min-content",
        alignItems: "flex-start", paddingBottom: 16,
      }}>
        {rounds.map((round, roundIdx) => {
          const numMatchups = matchupsPerRound[roundIdx];
          const spacing = spacingMultipliers[roundIdx];
          const totalHeight = numMatchups * MATCHUP_HEIGHT * spacing + (numMatchups - 1) * VERTICAL_GAP;

          return (
            <div key={round} style={{
              display: "flex", flexDirection: "column", alignItems: "center",
            }}>
              {/* Round Header */}
              <div style={{
                textAlign: "center", marginBottom: 12, minWidth: 140,
              }}>
                <div style={{
                  fontSize: 10, fontWeight: 700, color: region.color,
                  textTransform: "uppercase", letterSpacing: 0.5,
                }}>
                  {ROUND_NAMES[round]}
                </div>
                <div style={{
                  fontSize: 8, color: "#666", marginTop: 2,
                }}>
                  {SCORING[round]} pts
                </div>
              </div>

              {/* Matchups Container */}
              <div style={{
                display: "flex", flexDirection: "column", gap: `${VERTICAL_GAP}px`,
                height: totalHeight,
                justifyContent: "space-around",
              }}>
                {Array.from({ length: numMatchups }, (_, gameIdx) => {
                  const [t1, t2] = getGameTeams(region.id, round, gameIdx, picks);
                  const gameKey = `${region.id}_${round}_${gameIdx}`;
                  return (
                    <MatchupBox
                      key={gameKey}
                      team1={t1}
                      team2={t2}
                      picked={picks[gameKey]}
                      onPick={(teamId) => onPick(gameKey, teamId)}
                      gameKey={gameKey}
                      disabled={!t1 || !t2}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Region Winner Display */}
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", minWidth: 140,
        }}>
          <div style={{
            fontSize: 9, color: "#666", textTransform: "uppercase",
            letterSpacing: 0.5, marginBottom: 12, textAlign: "center",
          }}>
            Champion
          </div>
          {(() => {
            const winner = getRegionWinner(region.id, picks);
            return winner ? (
              <div style={{
                background: region.color + "15", border: `2px solid ${region.color}`,
                borderRadius: 6, padding: "8px 12px", textAlign: "center",
              }}>
                <div style={{ fontSize: 8, color: region.color, fontWeight: 700 }}>
                  {winner.seed}
                </div>
                <div style={{
                  fontSize: 10, fontWeight: 700, color: region.color,
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}>
                  {winner.name}
                </div>
              </div>
            ) : (
              <div style={{
                width: 140, height: 24, background: "#1a1a2e",
                borderRadius: 4, border: "1px solid #2a2a3e",
              }} />
            );
          })()}
        </div>
      </div>
    </div>
  );
}

function FirstFourView({ picks, onPick }) {
  return (
    <div style={{
      background: "#0a0a16", borderRadius: 12, border: "1px solid #2a2a3e",
      padding: 16,
    }}>
      <div style={{
        fontSize: 16, fontWeight: 700, color: "#fff", marginBottom: 4,
      }}>
        First Four
      </div>
      <div style={{
        fontSize: 12, color: "#888", marginBottom: 20,
      }}>
        Pick the winner of each play-in game (Dayton, OH). Winners advance to the main bracket.
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
        gap: 16,
      }}>
        {FIRST_FOUR.map((ff) => {
          const regionName = REGIONS.find((r) => r.id === ff.region)?.name || ff.region;
          return (
            <div key={ff.id}>
              <div style={{
                fontSize: 9, color: "#666", marginBottom: 8,
                textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700,
              }}>
                {regionName} — {ff.teams[0].seed} Seed
              </div>
              <MatchupBox
                team1={ff.teams[0]}
                team2={ff.teams[1]}
                picked={picks[ff.id]}
                onPick={(teamId) => onPick(ff.id, teamId)}
                gameKey={ff.id}
                disabled={false}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FinalFourView({ picks, onPick }) {
  return (
    <div>
      {/* Final Four Semifinals */}
      <div style={{
        background: "#0a0a16", borderRadius: 12, border: "1px solid #2a2a3e",
        padding: 16, marginBottom: 24,
      }}>
        <div style={{
          fontSize: 16, fontWeight: 700, color: "#fff", marginBottom: 4,
        }}>
          Final Four Semifinals
        </div>
        <div style={{
          fontSize: 12, color: "#888", marginBottom: 20,
        }}>
          Lucas Oil Stadium — Indianapolis, IN | 16 pts each
        </div>

        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
          gap: 16,
        }}>
          {FF_PAIRS.map((pair, i) => {
            const [t1, t2] = getFinalFourTeams(i, picks);
            const r1 = REGIONS.find((r) => r.id === pair[0]);
            const r2 = REGIONS.find((r) => r.id === pair[1]);
            return (
              <div key={i}>
                <div style={{
                  fontSize: 9, color: "#666", marginBottom: 8,
                  textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700,
                }}>
                  {r1.name} vs {r2.name}
                </div>
                <MatchupBox
                  team1={t1}
                  team2={t2}
                  picked={picks[`ff_${i}`]}
                  onPick={(teamId) => onPick(`ff_${i}`, teamId)}
                  gameKey={`ff_${i}`}
                  disabled={!t1 || !t2}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Championship */}
      <div style={{
        background: "#0a0a16", borderRadius: 12, border: "1px solid #2a2a3e",
        padding: 16, marginBottom: 24,
      }}>
        <div style={{
          fontSize: 16, fontWeight: 700, color: "#FFD700", marginBottom: 4,
        }}>
          National Championship
        </div>
        <div style={{
          fontSize: 12, color: "#888", marginBottom: 20,
        }}>
          32 pts
        </div>

        {(() => {
          const [t1, t2] = getChampTeams(picks);
          return (
            <div style={{ maxWidth: 300 }}>
              <MatchupBox
                team1={t1}
                team2={t2}
                picked={picks["champ"]}
                onPick={(teamId) => onPick("champ", teamId)}
                gameKey="champ"
                disabled={!t1 || !t2}
              />
            </div>
          );
        })()}

        {/* Champion Display */}
        {picks["champ"] && TEAM_MAP[picks["champ"]] && (
          <div style={{
            background: "linear-gradient(135deg, #FFD70022, #CC000022)",
            border: "1px solid #FFD70044", borderRadius: 12,
            padding: 16, textAlign: "center", marginTop: 16,
          }}>
            <div style={{ fontSize: 28, marginBottom: 4 }}>🏆</div>
            <div style={{
              fontSize: 10, color: "#888", textTransform: "uppercase",
              letterSpacing: 1, marginBottom: 4,
            }}>
              Your National Champion
            </div>
            <div style={{
              fontSize: 18, fontWeight: 900, color: "#FFD700", marginBottom: 2,
            }}>
              {TEAM_MAP[picks["champ"]].name}
            </div>
            <div style={{ fontSize: 11, color: "#ccc" }}>
              ({TEAM_MAP[picks["champ"]].seed} seed)
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


function Leaderboard({ entries, currentUid, isMobile, actualResults, resultsInfo, onSwitchTab }) {
  // Score each entry against actual results
  const scored = entries.map((entry) => {
    const score = actualResults ? scoreBracket(entry.picks, actualResults) : { total: 0, breakdown: {}, correctPicks: 0, possiblePicks: 0 };
    return { ...entry, score };
  });

  // Sort by score descending, then by correct picks, then by total picks
  const sorted = scored.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    if (b.score.correctPicks !== a.score.correctPicks) return b.score.correctPicks - a.score.correctPicks;
    return countPicks(b.picks) - countPicks(a.picks);
  });

  const hasScoring = resultsInfo && resultsInfo.completedGames > 0;
  const totalPicks = hasScoring ? (sorted[0]?.score.possiblePicks || 63) : 67;
  const gridCols = isMobile
    ? "32px 1fr 44px 50px"
    : "44px 1fr 90px 80px 150px";

  const medalIcons = ["🥇", "🥈", "🥉"];
  const medalColors = ["#FFD700", "#C0C0C0", "#CD7F32"];
  const top3 = sorted.slice(0, 3);
  const rest = sorted.slice(3);

  // ─── Empty State ───
  if (sorted.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: isMobile ? "40px 20px" : "60px 20px" }}>
        <div style={{ fontSize: 56, marginBottom: 12 }}>🏀</div>
        <div style={{ fontSize: isMobile ? 18 : 22, fontWeight: 700, color: "#fff", marginBottom: 6 }}>No Brackets Yet</div>
        <div style={{ fontSize: isMobile ? 12 : 14, color: "#888", marginBottom: 20, maxWidth: 340, margin: "0 auto 20px" }}>
          Be the first to fill out your bracket and claim the top spot!
        </div>
        {onSwitchTab && (
          <button onClick={() => onSwitchTab("bracket")} style={{
            padding: "10px 28px", background: "#CC0000", color: "#fff", fontWeight: 700,
            fontSize: 14, borderRadius: 8, border: "none", cursor: "pointer",
            transition: "opacity 0.15s",
          }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
          >
            Fill Out Your Bracket
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      {/* ─── Podium (top 3) ─── */}
      {!isMobile && top3.length >= 2 && (
        <div style={{
          padding: "24px 16px 20px",
          background: "linear-gradient(180deg, #1a1a35 0%, #12121f 100%)",
          borderRadius: "12px 12px 0 0", border: "1px solid #2a2a3e", borderBottom: "none",
        }}>
          <div style={{ textAlign: "center", fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 16 }}>
            March Madness 2026
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 12 }}>
            {[1, 0, 2].map((podiumIdx) => {
              const entry = top3[podiumIdx];
              if (!entry) return <div key={podiumIdx} style={{ minWidth: 100 }} />;
              const isFirst = podiumIdx === 0;
              const medal = medalIcons[podiumIdx];
              const color = medalColors[podiumIdx];
              const champion = entry.picks["champ"] ? TEAM_MAP[entry.picks["champ"]]?.name : "—";
              const isMe = entry.ownerUid === currentUid;
              const avatarSize = isFirst ? 48 : 40;
              return (
                <div key={entry.docId} style={{
                  textAlign: "center", borderRadius: 12,
                  padding: isFirst ? "12px 16px 20px" : "12px 10px 14px",
                  minWidth: isFirst ? 120 : 100,
                  background: `linear-gradient(180deg, ${color}18, ${color}05)`,
                  border: `1px solid ${color}40`,
                }}>
                  <div style={{ fontSize: isFirst ? 28 : 22, marginBottom: 4 }}>{isFirst ? "👑" : medal}</div>
                  {entry.photoURL ? (
                    <img src={entry.photoURL} alt="" referrerPolicy="no-referrer" style={{
                      width: avatarSize, height: avatarSize, borderRadius: "50%",
                      border: `2px solid ${color}`, objectFit: "cover", display: "block", margin: "0 auto 6px",
                    }} />
                  ) : (
                    <div style={{
                      width: avatarSize, height: avatarSize, borderRadius: "50%",
                      background: "#CC000033", border: `2px solid ${color}`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: isFirst ? 18 : 14, fontWeight: 700, color: "#CC0000",
                      margin: "0 auto 6px",
                    }}>
                      {(entry.entryName || entry.displayName || "?")[0].toUpperCase()}
                    </div>
                  )}
                  <div style={{ fontSize: 12, fontWeight: 600, color: isMe ? "#fff" : "#ccc", marginBottom: 2 }}>
                    {entry.entryName || entry.displayName}
                    {isMe && <span style={{ fontSize: 8, color: "#CC0000" }}> (you)</span>}
                  </div>
                  <div style={{ fontSize: isFirst ? 24 : 20, fontWeight: 800, color }}>
                    {entry.score.total}
                  </div>
                  <div style={{ fontSize: 9, color: "#666", marginTop: 2 }}>🏆 {champion}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ─── Prize Banner ─── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
        padding: isMobile ? "8px 10px" : "10px 16px",
        background: "linear-gradient(90deg, #CC000015, #CC000005)",
        border: "1px solid #2a2a3e",
        borderTop: !isMobile && top3.length >= 2 ? "none" : undefined,
        borderRadius: !isMobile && top3.length >= 2 ? 0 : "12px 12px 0 0",
      }}>
        <span style={{ fontSize: 16 }}>💰</span>
        <span style={{ fontSize: isMobile ? 11 : 12, color: "#CC0000", fontWeight: 600 }}>Prize:</span>
        <span style={{ fontSize: isMobile ? 13 : 14, color: "#FFD700", fontWeight: 800 }}>$75 Cash</span>
        {!isMobile && <span style={{ color: "#555", fontSize: 11 }}> · Best score wins · Free entry</span>}
      </div>

      {/* ─── Stats Bar ─── */}
      <div style={{
        display: "flex", justifyContent: "center", gap: isMobile ? 16 : 28,
        padding: isMobile ? "10px" : "12px 16px",
        border: "1px solid #2a2a3e", borderTop: "none",
        background: "#12121f",
      }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: isMobile ? 16 : 18, fontWeight: 800, color: "#fff" }}>{sorted.length}</div>
          <div style={{ fontSize: isMobile ? 9 : 10, color: "#666", textTransform: "uppercase", letterSpacing: 0.5 }}>Brackets</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: isMobile ? 16 : 18, fontWeight: 800, color: hasScoring ? "#4CAF50" : "#555" }}>
            {hasScoring ? resultsInfo.completedGames : 0}
          </div>
          <div style={{ fontSize: isMobile ? 9 : 10, color: "#666", textTransform: "uppercase", letterSpacing: 0.5 }}>Games Played</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: isMobile ? 16 : 18, fontWeight: 800, color: "#FFD700" }}>192</div>
          <div style={{ fontSize: isMobile ? 9 : 10, color: "#666", textTransform: "uppercase", letterSpacing: 0.5 }}>Max Points</div>
        </div>
        {hasScoring && resultsInfo?.lastUpdated && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: isMobile ? 16 : 18, fontWeight: 800, color: "#4CAF50" }}>🟢</div>
            <div style={{ fontSize: isMobile ? 9 : 10, color: "#666", textTransform: "uppercase", letterSpacing: 0.5 }}>Live</div>
          </div>
        )}
      </div>

      {/* ─── Scoring Legend ─── */}
      <div style={{
        display: "flex", justifyContent: "center", gap: isMobile ? 4 : 8,
        padding: isMobile ? "8px 6px" : "10px 16px",
        border: "1px solid #2a2a3e", borderTop: "none",
        background: "#12121f", flexWrap: "wrap",
      }}>
        {[
          { label: "R64", pts: 1 }, { label: "R32", pts: 2 }, { label: "S16", pts: 4 },
          { label: "E8", pts: 8 }, { label: "FF", pts: 16 }, { label: "Champ", pts: 32 },
        ].map(({ label, pts }) => (
          <span key={label} style={{
            fontSize: isMobile ? 9 : 10, padding: isMobile ? "2px 6px" : "3px 8px",
            borderRadius: 6, background: "#ffffff08", color: "#888",
          }}>
            {label} <span style={{ color: "#FFD700", fontWeight: 600 }}>+{pts}</span>
          </span>
        ))}
      </div>

      {/* ─── Table ─── */}
      <div style={{ background: "#12121f", borderRadius: "0 0 12px 12px", overflow: "hidden", border: "1px solid #2a2a3e", borderTop: "none" }}>
        {/* Header */}
        <div style={{
          display: "grid", gridTemplateColumns: gridCols,
          padding: isMobile ? "8px 10px" : "10px 16px", borderBottom: "1px solid #2a2a3e",
          fontSize: isMobile ? 9 : 10, color: "#666", textTransform: "uppercase", letterSpacing: 0.5,
        }}>
          <div>#</div>
          <div>Player</div>
          <div style={{ textAlign: "center" }}>{isMobile ? "✓" : "Correct"}</div>
          <div style={{ textAlign: "center" }}>Score</div>
          {!isMobile && <div style={{ textAlign: "center" }}>Breakdown</div>}
        </div>

        {sorted.map((entry, i) => {
          const isMe = entry.ownerUid === currentUid;
          const champion = entry.picks["champ"] ? TEAM_MAP[entry.picks["champ"]]?.name : "—";
          const { total, breakdown, correctPicks, possiblePicks } = entry.score;
          const pickCount = hasScoring ? correctPicks : countPicks(entry.picks);
          const pickMax = hasScoring ? possiblePicks : 67;
          const pickPct = pickMax > 0 ? (pickCount / pickMax) * 100 : 0;
          return (
            <div key={entry.docId} style={{
              display: "grid", gridTemplateColumns: gridCols,
              padding: isMobile ? "8px 10px" : "14px 16px", borderBottom: "1px solid #1a1a2e",
              background: isMe ? "#CC000012" : i % 2 === 0 ? "#0f0f1e" : "transparent",
              borderLeft: isMe ? "3px solid #CC0000" : "3px solid transparent",
              transition: "background 0.15s",
            }}
              onMouseEnter={(e) => { if (!isMe) e.currentTarget.style.background = i % 2 === 0 ? "#14142a" : "#0c0c1a"; }}
              onMouseLeave={(e) => { if (!isMe) e.currentTarget.style.background = isMe ? "#CC000012" : i % 2 === 0 ? "#0f0f1e" : "transparent"; }}
            >
              <div style={{
                fontWeight: 700, fontSize: isMobile ? 12 : 14, alignSelf: "center",
                color: i < 3 ? medalColors[i] : "#888",
              }}>
                {i < 3 ? medalIcons[i] : i + 1}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 6 : 10, minWidth: 0 }}>
                {!isMobile && (
                  entry.photoURL ? (
                    <img src={entry.photoURL} alt="" referrerPolicy="no-referrer"
                      style={{ width: 28, height: 28, borderRadius: "50%", border: isMe ? "2px solid #CC0000" : `1px solid ${i < 3 ? medalColors[i] + "66" : "#333"}`, flexShrink: 0, objectFit: "cover" }}
                    />
                  ) : (
                    <div style={{
                      width: 28, height: 28, borderRadius: "50%", background: "#CC000022",
                      border: isMe ? "2px solid #CC0000" : `1px solid ${i < 3 ? medalColors[i] + "66" : "#333"}`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 12, fontWeight: 700, color: "#CC0000", flexShrink: 0,
                    }}>
                      {(entry.entryName || entry.displayName || "?")[0].toUpperCase()}
                    </div>
                  )
                )}
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    fontSize: isMobile ? 11 : 13, fontWeight: isMe ? 700 : 500, color: isMe ? "#fff" : "#ccc",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {entry.entryName || entry.displayName} {isMe && <span style={{ fontSize: 9, color: "#CC0000" }}>(you)</span>}
                  </div>
                  {!isMobile && (
                    <div style={{ fontSize: 10, color: "#555", display: "flex", alignItems: "center", gap: 4 }}>
                      🏆 {champion}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ textAlign: "center", alignSelf: "center" }}>
                <div style={{ color: hasScoring ? "#4CAF50" : "#888", fontSize: isMobile ? 11 : 13 }}>
                  {pickCount}/{pickMax}
                </div>
                {!isMobile && (
                  <div style={{ width: 44, height: 3, background: "#ffffff10", borderRadius: 2, margin: "3px auto 0" }}>
                    <div style={{ height: "100%", borderRadius: 2, background: hasScoring ? "#4CAF50" : "#555", width: `${Math.min(pickPct, 100)}%`, transition: "width 0.3s" }} />
                  </div>
                )}
              </div>
              <div style={{ textAlign: "center", color: "#FFD700", fontSize: isMobile ? 14 : 16, fontWeight: 700, alignSelf: "center" }}>
                {total}
              </div>
              {!isMobile && hasScoring && (
                <div style={{ display: "flex", gap: 4, alignItems: "center", justifyContent: "center", flexWrap: "wrap" }}>
                  {[1, 2, 3, 4, 5, 6].map((r) => {
                    const pts = breakdown[r] || 0;
                    if (!pts) return null;
                    const labels = { 1: "R64", 2: "R32", 3: "S16", 4: "E8", 5: "FF", 6: "CH" };
                    return (
                      <span key={r} style={{
                        fontSize: 9, padding: "2px 5px", borderRadius: 4,
                        background: "#FFD70015", color: "#FFD700", whiteSpace: "nowrap",
                      }}>
                        {labels[r]}:{pts}
                      </span>
                    );
                  })}
                  {!Object.values(breakdown).some((v) => v > 0) && (
                    <span style={{ fontSize: 9, color: "#444" }}>—</span>
                  )}
                </div>
              )}
              {!isMobile && !hasScoring && (
                <div style={{ textAlign: "center", fontSize: 9, color: "#444", alignSelf: "center" }}>—</div>
              )}
            </div>
          );
        })}
      </div>

      {/* ─── Footer ─── */}
      <div style={{ textAlign: "center", padding: "12px", fontSize: 10, color: "#444" }}>
        Salt City Sports — March Madness 2026 Bracket Challenge | Max possible: 192 pts
      </div>
    </div>
  );
}

// ===== CHAT =====
function BracketChat({ user, isMobile }) {
  const [messages, setMessages] = useState([]);
  const [newMsg, setNewMsg] = useState("");
  const [sending, setSending] = useState(false);
  const [username, setUsername] = useState("");
  const [usernameSet, setUsernameSet] = useState(false);
  const [usernameInput, setUsernameInput] = useState("");
  const [savingUsername, setSavingUsername] = useState(false);
  const [editingUsername, setEditingUsername] = useState(false);
  const bottomRef = useRef(null);
  const chatRef = useRef(null);

  // Load username from Firestore on mount
  useEffect(() => {
    if (!user) return;
    getDoc(doc(db, "users", user.uid)).then((snap) => {
      if (snap.exists() && snap.data().chatUsername) {
        setUsername(snap.data().chatUsername);
        setUsernameSet(true);
      }
    });
  }, [user]);

  // Real-time listener for chat messages
  useEffect(() => {
    const q = query(
      collection(db, "bracketChat"),
      orderBy("createdAt", "asc"),
      limit(200)
    );
    const unsub = onSnapshot(q, (snap) => {
      const msgs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setMessages(msgs);
    });
    return unsub;
  }, []);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const saveUsername = async () => {
    if (!user || !usernameInput.trim()) return;
    setSavingUsername(true);
    try {
      await setDoc(doc(db, "users", user.uid), {
        chatUsername: usernameInput.trim(),
      }, { merge: true });
      setUsername(usernameInput.trim());
      setUsernameSet(true);
      setEditingUsername(false);
    } catch (err) {
      console.error("Username save failed:", err);
    }
    setSavingUsername(false);
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    if (!user || !newMsg.trim() || sending || !usernameSet) return;
    setSending(true);
    try {
      await addDoc(collection(db, "bracketChat"), {
        text: newMsg.trim(),
        uid: user.uid,
        username: username,
        photoURL: null,
        createdAt: serverTimestamp(),
      });
      setNewMsg("");
    } catch (err) {
      console.error("Send failed:", err);
    }
    setSending(false);
  };

  // Group consecutive messages from same user
  const grouped = [];
  messages.forEach((msg, i) => {
    const prev = i > 0 ? messages[i - 1] : null;
    const sameUser = prev && prev.uid === msg.uid;
    const closeInTime = prev?.createdAt?.seconds && msg.createdAt?.seconds
      && (msg.createdAt.seconds - prev.createdAt.seconds) < 120;
    msg._showHeader = !sameUser || !closeInTime;
    grouped.push(msg);
  });

  // Username setup / edit prompt
  const usernamePrompt = (isEdit) => (
    <div style={{
      padding: "14px 16px", borderTop: isEdit ? "none" : "1px solid #2a2a3e",
      background: isEdit ? "transparent" : "#12121f",
    }}>
      {!isEdit && (
        <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>
          Pick a username to start chatting
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={usernameInput}
          onChange={(e) => setUsernameInput(e.target.value.slice(0, 20))}
          placeholder="Choose a username..."
          maxLength={20}
          style={{
            flex: 1, background: "#0a0a16", border: "1px solid #2a2a3e",
            borderRadius: 8, padding: "10px 14px", color: "#ccc",
            fontSize: 13, outline: "none",
          }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveUsername(); } }}
          onFocus={(e) => (e.target.style.borderColor = "#4CAF5066")}
          onBlur={(e) => (e.target.style.borderColor = "#2a2a3e")}
        />
        <button onClick={saveUsername} disabled={!usernameInput.trim() || savingUsername} style={{
          background: usernameInput.trim() ? "#4CAF50" : "#1a1a2e",
          border: "none", borderRadius: 8, padding: "10px 16px",
          color: usernameInput.trim() ? "#fff" : "#444",
          fontSize: 12, fontWeight: 700, cursor: usernameInput.trim() ? "pointer" : "default",
          transition: "all 0.2s", flexShrink: 0,
        }}>
          {savingUsername ? "..." : isEdit ? "Update" : "Set Username"}
        </button>
        {isEdit && (
          <button onClick={() => setEditingUsername(false)} style={{
            background: "transparent", border: "1px solid #2a2a3e", borderRadius: 8,
            padding: "10px 12px", color: "#888", fontSize: 12, cursor: "pointer",
          }}>Cancel</button>
        )}
      </div>
    </div>
  );

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: isMobile ? "calc(100vh - 180px)" : "calc(100vh - 200px)",
      background: "#0a0a16", borderRadius: 12, border: "1px solid #2a2a3e",
      overflow: "hidden",
    }}>
      {/* Chat Header */}
      <div style={{
        padding: "12px 16px", borderBottom: "1px solid #2a2a3e",
        background: "#12121f", display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>Bracket Talk</div>
          <div style={{ fontSize: 11, color: "#888" }}>
            Chat with other bracket challengers — trash talk encouraged
          </div>
        </div>
        {user && usernameSet && (
          <button onClick={() => { setUsernameInput(username); setEditingUsername(!editingUsername); }}
            style={{
              background: "#ffffff08", border: "1px solid #2a2a3e", borderRadius: 8,
              padding: "4px 10px", color: "#888", fontSize: 10, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 4,
            }}>
            <span style={{ color: "#4CAF50", fontWeight: 700 }}>@{username}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        )}
      </div>

      {/* Username edit area */}
      {editingUsername && usernamePrompt(true)}

      {/* Messages */}
      <div ref={chatRef} style={{
        flex: 1, overflowY: "auto", padding: "12px 16px",
        display: "flex", flexDirection: "column", gap: 2,
      }}>
        {messages.length === 0 ? (
          <div style={{ textAlign: "center", padding: 40, color: "#444" }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🏀</div>
            <div style={{ fontSize: 13, color: "#555" }}>No messages yet. Start the conversation!</div>
          </div>
        ) : (
          grouped.map((msg) => {
            const isMe = msg.uid === user?.uid;
            const displayName = msg.username || msg.displayName || "Anonymous";
            return (
              <div key={msg.id} style={{
                marginTop: msg._showHeader ? 12 : 1,
              }}>
                {msg._showHeader && (
                  <div style={{
                    display: "flex", alignItems: "center", gap: 8,
                    marginBottom: 4,
                  }}>
                    <div style={{
                      width: 22, height: 22, borderRadius: "50%",
                      background: isMe ? "#CC000033" : "#2a2a3e",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 10, color: isMe ? "#CC0000" : "#888", fontWeight: 700, flexShrink: 0,
                      border: isMe ? "1px solid #CC000066" : "1px solid #333",
                    }}>
                      {displayName[0].toUpperCase()}
                    </div>
                    <span style={{
                      fontSize: 11, fontWeight: 700,
                      color: isMe ? "#CC0000" : "#ccc",
                    }}>
                      {displayName}
                    </span>
                    <span style={{ fontSize: 9, color: "#444" }}>
                      {msg.createdAt?.seconds
                        ? new Date(msg.createdAt.seconds * 1000).toLocaleTimeString("en-US", {
                            hour: "numeric", minute: "2-digit",
                          })
                        : "..."
                      }
                    </span>
                  </div>
                )}
                <div style={{
                  marginLeft: 30,
                  padding: "6px 12px",
                  background: isMe ? "#CC000012" : "#ffffff06",
                  borderRadius: 8,
                  borderLeft: isMe ? "2px solid #CC000044" : "2px solid transparent",
                  fontSize: 13, color: "#ddd", lineHeight: 1.5,
                  wordBreak: "break-word",
                }}>
                  {msg.text}
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      {!user ? (
        <div style={{
          padding: "14px 16px", borderTop: "1px solid #2a2a3e",
          textAlign: "center", color: "#555", fontSize: 12, background: "#12121f",
        }}>
          Sign in to join the conversation
        </div>
      ) : !usernameSet ? (
        usernamePrompt(false)
      ) : (
        <form onSubmit={sendMessage} style={{
          display: "flex", gap: 8, padding: "10px 12px",
          borderTop: "1px solid #2a2a3e", background: "#12121f",
        }}>
          <input
            type="text"
            value={newMsg}
            onChange={(e) => setNewMsg(e.target.value)}
            placeholder="Type a message..."
            maxLength={500}
            style={{
              flex: 1, background: "#0a0a16", border: "1px solid #2a2a3e",
              borderRadius: 8, padding: "10px 14px", color: "#ccc",
              fontSize: 13, outline: "none",
            }}
            onFocus={(e) => (e.target.style.borderColor = "#CC000066")}
            onBlur={(e) => (e.target.style.borderColor = "#2a2a3e")}
          />
          <button type="submit" disabled={!newMsg.trim() || sending} style={{
            background: newMsg.trim() ? "#CC0000" : "#1a1a2e",
            border: "none", borderRadius: 8, padding: "10px 18px",
            color: newMsg.trim() ? "#fff" : "#444",
            fontSize: 13, fontWeight: 700, cursor: newMsg.trim() ? "pointer" : "default",
            transition: "all 0.2s", flexShrink: 0,
          }}>
            {sending ? "..." : "Send"}
          </button>
        </form>
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

// ===== CONTEST RULES =====
function ContestRules({ isMobile }) {
  const sectionStyle = {
    background: "#12121f", borderRadius: 12, border: "1px solid #2a2a3e",
    padding: isMobile ? 16 : 24, marginBottom: 16,
  };
  const headingStyle = {
    fontSize: 16, fontWeight: 700, color: "#fff", marginBottom: 12,
    borderBottom: "1px solid #2a2a3e", paddingBottom: 8,
  };
  const paraStyle = { fontSize: 13, color: "#ccc", lineHeight: 1.7, marginBottom: 10 };
  const labelStyle = { fontWeight: 600, color: "#fff" };

  return (
    <div style={{ maxWidth: 700, margin: "0 auto" }}>
      <div style={sectionStyle}>
        <div style={headingStyle}>Official Contest Rules — March Madness Bracket Challenge 2026</div>
        <p style={paraStyle}>
          <span style={labelStyle}>1. Sponsor.</span> This contest ("Contest") is operated by Salt City Sports ("Sponsor"), an independent sports fan website located at saltcitysportsutah.com. This Contest is not affiliated with, endorsed by, or sponsored by the NCAA, ESPN, or any collegiate athletic program.
        </p>
        <p style={paraStyle}>
          <span style={labelStyle}>2. Eligibility.</span> The Contest is open to legal residents of the United States who are 18 years of age or older at the time of entry. Employees of Salt City Sports and their immediate family members are not eligible. Void where prohibited by law.
        </p>
        <p style={paraStyle}>
          <span style={labelStyle}>3. Entry Period.</span> The Contest entry period begins when the bracket form is made available on saltcitysportsutah.com and ends on <span style={{ color: "#FFD700" }}>Thursday, March 19, 2026 at 12:15 PM Eastern Time</span>. All entries must be submitted before this deadline. Late entries will not be accepted. Each registered user may submit up to two (2) bracket entries.
        </p>
        <p style={paraStyle}>
          <span style={labelStyle}>4. How to Enter.</span> To enter, you must create a free account on saltcitysportsutah.com and complete a bracket by selecting predicted winners for all 67 games of the 2026 NCAA Division I Men's Basketball Tournament. No purchase is necessary. Entry is free.
        </p>
        <p style={paraStyle}>
          <span style={labelStyle}>5. Scoring & Winner Determination.</span> Brackets are scored using a standard points system based on correct predictions in each round. The entry with the highest total score at the conclusion of the tournament's Championship Game will be declared the winner. In the event of a tie, the prize will be split equally among tied participants.
        </p>
        <p style={paraStyle}>
          <span style={labelStyle}>6. Prize.</span> One (1) Grand Prize of <span style={{ color: "#22c55e", fontWeight: 700 }}>$75.00 USD</span> will be awarded to the winning participant. The prize will be delivered via Venmo or PayPal within 14 days of the Championship Game. The winner is responsible for any applicable taxes. No prize substitution or transfer is permitted.
        </p>
        <p style={paraStyle}>
          <span style={labelStyle}>7. Winner Notification.</span> The winner will be notified via the email address associated with their Salt City Sports account. If the winner does not respond within 7 days of notification, the prize may be forfeited and awarded to the next highest-scoring participant.
        </p>
        <p style={paraStyle}>
          <span style={labelStyle}>8. Privacy.</span> Personal information collected during this Contest (name, email, payment details for prize fulfillment) will be used solely for the purpose of administering the Contest and delivering the prize. See our Privacy Policy for more information.
        </p>
        <p style={paraStyle}>
          <span style={labelStyle}>9. Limitation of Liability.</span> Sponsor is not responsible for technical failures, errors, or interruptions that may affect Contest participation. Sponsor reserves the right to modify, suspend, or cancel the Contest at any time for any reason, including if fraud or technical issues compromise the integrity of the Contest.
        </p>
        <p style={paraStyle}>
          <span style={labelStyle}>10. General.</span> By entering, participants agree to be bound by these Official Rules and the decisions of the Sponsor, which are final and binding. This Contest is governed by the laws of the State of Utah.
        </p>
        <p style={{ fontSize: 11, color: "#666", marginTop: 16, textAlign: "center" }}>
          Last updated: March 16, 2026 &nbsp;|&nbsp; Questions? Contact saltcitysportsutah@gmail.com
        </p>
      </div>
    </div>
  );
}

// ===== MAIN COMPONENT =====
export default function BracketChallenge({ user, onBack, initialEntry, initialTab }) {
  const isMobile = useIsMobile();
  const [picks, setPicks] = useState({});
  const [tab, setTab] = useState(initialTab || "bracket");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [leaderboard, setLeaderboard] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [entryName, setEntryName] = useState("");
  const [entryNum, setEntryNum] = useState(initialEntry || 1);
  const [entryExists, setEntryExists] = useState([false, false]);
  const [userProfile, setUserProfile] = useState(null);
  const [locked, setLocked] = useState(isBracketLocked());
  const [countdown, setCountdown] = useState(getTimeUntilDeadline());
  const [actualResults, setActualResults] = useState(null);
  const [resultsInfo, setResultsInfo] = useState(null);

  // Update lock state and countdown every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setLocked(isBracketLocked());
      setCountdown(getTimeUntilDeadline());
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // Fetch tournament results and auto-refresh every 2 minutes
  useEffect(() => {
    let cancelled = false;
    const doFetch = async () => {
      const data = await fetchTournamentResults();
      if (data && !cancelled) {
        const results = buildActualResults(data.games || []);
        setActualResults(results);
        setResultsInfo({
          completedGames: data.completedGames || 0,
          totalGames: data.totalGames || 0,
          lastUpdated: data.lastUpdated,
        });
      }
    };
    // Only poll after the bracket locks (tournament has started)
    if (isBracketLocked()) {
      doFetch();
      const interval = setInterval(doFetch, 120000); // every 2 minutes
      return () => { cancelled = true; clearInterval(interval); };
    }
    return () => { cancelled = true; };
  }, []);

  // Load user's Firestore profile
  useEffect(() => {
    if (user) {
      getDoc(doc(db, "users", user.uid)).then((snap) => {
        if (snap.exists()) setUserProfile(snap.data());
      });
    }
  }, [user]);

  // Load user's bracket and leaderboard on mount or entry switch
  useEffect(() => {
    setLoaded(false);
    setPicks({});
    setEntryName("");
    setSaved(false);
    if (user) {
      loadBracket(user.uid, entryNum).then(({ picks: p, entryName: en }) => {
        if (p && Object.keys(p).length > 0) setPicks(p);
        if (en) setEntryName(en);
        setLoaded(true);
      });
      // Check which entries exist
      loadUserEntries(user.uid).then((results) => {
        setEntryExists([
          !!(results[0] && Object.keys(results[0]?.picks || {}).length > 0),
          !!(results[1] && Object.keys(results[1]?.picks || {}).length > 0),
        ]);
      });
    } else {
      setLoaded(true);
    }
    loadLeaderboard().then(setLeaderboard);
  }, [user, entryNum]);

  const switchEntry = (num) => {
    if (num === entryNum) return;
    setEntryNum(num);
  };

  const handlePick = useCallback((gameKey, teamId) => {
    if (isBracketLocked()) return; // Bracket is locked
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
    if (!user || isBracketLocked()) return;
    setSaving(true);
    const ok = await saveBracket(user, picks, entryName, entryNum, userProfile);
    setSaving(false);
    if (ok) {
      setSaved(true);
      setEntryExists((prev) => { const n = [...prev]; n[entryNum - 1] = true; return n; });
      loadLeaderboard().then(setLeaderboard);
    }
  };

  const totalPicks = countPicks(picks);

  const viewTabs = [
    { id: "bracket", label: "Bracket" },
    { id: "first4", label: "First Four" },
    { id: "ff", label: "Final Four" },
    { id: "lb", label: "Leaderboard" },
    { id: "chat", label: "Chat" },
    { id: "rules", label: "Rules" },
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
        borderBottom: "1px solid #2a2a3e",
        padding: isMobile ? "12px 14px" : "14px 20px",
        position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(12px)",
      }}>
        {/* Top row: Back, title, entry switcher */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          marginBottom: isMobile ? 8 : 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 12 }}>
            <button onClick={onBack} style={{
              background: "#1a1a2e", border: "1px solid #2a2a3e", borderRadius: 8,
              padding: isMobile ? "4px 8px" : "6px 12px", color: "#888", fontSize: 12, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 4,
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              {!isMobile && "Back"}
            </button>
            <div>
              <h1 style={{ margin: 0, fontSize: isMobile ? 14 : 18, fontWeight: 800, letterSpacing: -0.5 }}>
                🏀 March Madness <span style={{ color: "#CC0000" }}>2026</span>
              </h1>
              {!isMobile && <p style={{ margin: 0, fontSize: 10, color: "#666" }}>BRACKET CHALLENGE</p>}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* Entry Switcher */}
            {user && (
              <div style={{ display: "flex", gap: 3, background: "#0a0a16", borderRadius: 8, padding: 2 }}>
                {[1, 2].map((num) => {
                  const active = entryNum === num;
                  const exists = entryExists[num - 1];
                  return (
                    <button key={num} onClick={() => switchEntry(num)} style={{
                      background: active ? "#CC000033" : "transparent",
                      border: active ? "1px solid #CC000066" : "1px solid transparent",
                      borderRadius: 6, padding: isMobile ? "4px 8px" : "5px 12px",
                      color: active ? "#fff" : exists ? "#888" : "#444",
                      fontSize: isMobile ? 10 : 11, fontWeight: active ? 700 : 500,
                      cursor: "pointer", transition: "all 0.2s", whiteSpace: "nowrap",
                    }}>
                      {isMobile ? `#${num}` : `Entry ${num}`} {exists && !active ? "✓" : ""}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Progress */}
            {!isMobile && (
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: "#888" }}>{totalPicks}/67</div>
                <div style={{ width: 80, height: 4, background: "#1a1a2e", borderRadius: 2, marginTop: 2 }}>
                  <div style={{
                    width: `${(totalPicks / 67) * 100}%`, height: "100%",
                    background: totalPicks === 67 ? "#4CAF50" : "#CC0000",
                    borderRadius: 2, transition: "width 0.3s",
                  }} />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Bottom row (mobile: full width): entry name + save */}
        {user ? (
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            marginTop: isMobile ? 10 : 8,
            paddingTop: isMobile ? 10 : 8,
            borderTop: "1px solid #1a1a2e",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
              <label style={{ fontSize: isMobile ? 9 : 10, color: "#666", whiteSpace: "nowrap", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>Entry Name</label>
              <input
                type="text"
                value={entryName}
                onChange={(e) => { if (!locked) { setEntryName(e.target.value); setSaved(false); } }}
                placeholder={userProfile?.username || user.displayName || "Entry name"}
                disabled={locked}
                style={{
                  background: "#1a1a2e", border: "1px solid #2a2a3e", borderRadius: 8,
                  padding: isMobile ? "6px 10px" : "8px 12px", color: locked ? "#666" : "#ccc",
                  fontSize: isMobile ? 11 : 12, flex: 1, minWidth: 0,
                  outline: "none", opacity: locked ? 0.6 : 1,
                }}
              />
            </div>
            <button onClick={handleSave} disabled={saving || locked} style={{
              background: locked ? "#44444422" : saved ? "#4CAF5022" : "#CC000022",
              border: `1px solid ${locked ? "#44444466" : saved ? "#4CAF5066" : "#CC000066"}`,
              borderRadius: 8, padding: isMobile ? "6px 12px" : "8px 16px",
              color: locked ? "#666" : saved ? "#4CAF50" : "#CC0000",
              fontSize: isMobile ? 11 : 12, fontWeight: 700, cursor: locked ? "not-allowed" : saving ? "wait" : "pointer",
              whiteSpace: "nowrap", flexShrink: 0,
            }}>
              {locked ? "🔒 Locked" : saving ? "..." : saved ? "✓ Saved" : "Save"}
            </button>
          </div>
        ) : (
          !isMobile && <div style={{ fontSize: 11, color: "#666" }}>Sign in to save</div>
        )}
      </header>

      {/* Deadline Banner */}
      <div style={{
        background: locked ? "#CC000015" : "#FFD70010",
        borderBottom: `1px solid ${locked ? "#CC000033" : "#FFD70033"}`,
        padding: "6px 20px",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
        fontSize: 11, fontWeight: 600,
      }}>
        {locked ? (
          <span style={{ color: "#CC0000" }}>🔒 Brackets are locked — entries were due Thu, Mar 19 at 12:15 PM ET</span>
        ) : (
          <>
            <span style={{ color: "#FFD700" }}>⏰ Entries due: Thu, Mar 19 at 12:15 PM ET</span>
            {countdown && <span style={{ color: "#888", fontSize: 10 }}>({countdown})</span>}
          </>
        )}
      </div>

      {/* Tab Navigation */}
      <div style={{
        display: "flex", gap: 2, padding: "0 20px",
        background: "#0d0d1a", borderBottom: "1px solid #1a1a2e",
        overflowX: "auto", whiteSpace: "nowrap",
      }}>
        {viewTabs.map((t) => {
          const isActive = tab === t.id;
          const color = t.id === "ff" ? "#CC0000" : t.id === "lb" ? "#FFD700" : t.id === "chat" ? "#4CAF50" : t.id === "rules" ? "#aaa" : "#4A90D9";
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
      <main style={{ padding: isMobile ? "12px 8px" : "20px" }}>
        {!loaded ? (
          <div style={{ textAlign: "center", padding: 60, color: "#555" }}>Loading bracket...</div>
        ) : (
          <>
            {tab === "bracket" && (
              <div>
                {isMobile && (
                  <>
                    {/* Mobile progress overview */}
                    <div style={{
                      background: "#12121f", borderRadius: 12, border: "1px solid #2a2a3e",
                      padding: 14, marginBottom: 12,
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>Your Bracket Progress</div>
                        <div style={{
                          fontSize: 12, fontWeight: 700,
                          color: totalPicks === 67 ? "#4CAF50" : totalPicks > 0 ? "#FFD700" : "#666",
                        }}>
                          {totalPicks}/67 picks
                        </div>
                      </div>
                      {/* Progress bar */}
                      <div style={{ width: "100%", height: 8, background: "#0a0a16", borderRadius: 4, marginBottom: 8, overflow: "hidden" }}>
                        <div style={{
                          width: `${(totalPicks / 67) * 100}%`, height: "100%",
                          background: totalPicks === 67
                            ? "linear-gradient(90deg, #4CAF50, #66BB6A)"
                            : totalPicks > 30
                            ? "linear-gradient(90deg, #FFD700, #FFA000)"
                            : "linear-gradient(90deg, #CC0000, #FF4444)",
                          borderRadius: 4, transition: "width 0.3s",
                        }} />
                      </div>
                      {/* Step guide */}
                      <div style={{ display: "flex", gap: 4, justifyContent: "space-between" }}>
                        {[
                          { label: "4 Regions", done: totalPicks >= 60 },
                          { label: "First Four", done: FIRST_FOUR.every((ff) => picks[ff.id]) },
                          { label: "Final Four", done: picks["ff_0"] && picks["ff_1"] },
                          { label: "Champion", done: !!picks["champ"] },
                        ].map((step, i) => (
                          <div key={i} style={{
                            flex: 1, textAlign: "center", fontSize: 9,
                            color: step.done ? "#4CAF50" : "#666", fontWeight: step.done ? 600 : 400,
                          }}>
                            {step.done ? "✓ " : ""}{step.label}
                          </div>
                        ))}
                      </div>
                      {totalPicks === 0 && (
                        <div style={{
                          marginTop: 10, padding: "8px 12px", background: "#FFD70010",
                          border: "1px solid #FFD70033", borderRadius: 8,
                          fontSize: 11, color: "#FFD700", textAlign: "center",
                        }}>
                          👇 Start by picking winners in each matchup below
                        </div>
                      )}
                      {totalPicks > 0 && totalPicks < 67 && (
                        <div style={{
                          marginTop: 8, fontSize: 10, color: "#888", textAlign: "center",
                        }}>
                          {totalPicks < 60
                            ? "Pick winners in each region, then fill out First Four, Final Four & Championship tabs"
                            : "Almost there! Check the First Four, Final Four & Championship tabs to finish"
                          }
                        </div>
                      )}
                    </div>
                  </>
                )}
                {isMobile
                  ? REGIONS.map((r) => (
                      <MobileRegionView key={r.id} region={r} picks={picks} onPick={handlePick} />
                    ))
                  : REGIONS.map((r) => (
                      <RegionalBracketView key={r.id} region={r} picks={picks} onPick={handlePick} />
                    ))
                }
              </div>
            )}
            {tab === "first4" && <FirstFourView picks={picks} onPick={handlePick} />}
            {tab === "ff" && <FinalFourView picks={picks} onPick={handlePick} />}
            {tab === "lb" && <Leaderboard entries={leaderboard} currentUid={user?.uid} isMobile={isMobile} actualResults={actualResults} resultsInfo={resultsInfo} onSwitchTab={setTab} />}
            {tab === "chat" && <BracketChat user={user} isMobile={isMobile} />}
            {tab === "rules" && <ContestRules isMobile={isMobile} />}
          </>
        )}
      </main>

      {/* Mobile sticky bottom bar */}
      {isMobile && user && !locked && (tab === "bracket" || tab === "first4" || tab === "ff") && (
        <div style={{
          position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 200,
          background: "linear-gradient(180deg, transparent 0%, #0a0a16 15%)",
          paddingTop: 20,
        }}>
          <div style={{
            background: "#12121f", borderTop: "1px solid #2a2a3e",
            padding: "10px 12px", display: "flex", alignItems: "center", gap: 10,
          }}>
            {/* Progress ring */}
            <div style={{ position: "relative", width: 40, height: 40, flexShrink: 0 }}>
              <svg width="40" height="40" viewBox="0 0 40 40">
                <circle cx="20" cy="20" r="16" fill="none" stroke="#1a1a2e" strokeWidth="4" />
                <circle cx="20" cy="20" r="16" fill="none"
                  stroke={totalPicks === 67 ? "#4CAF50" : "#CC0000"} strokeWidth="4"
                  strokeDasharray={`${(totalPicks / 67) * 100.5} 100.5`}
                  strokeLinecap="round"
                  transform="rotate(-90 20 20)"
                  style={{ transition: "stroke-dasharray 0.3s" }}
                />
              </svg>
              <div style={{
                position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 9, fontWeight: 700, color: totalPicks === 67 ? "#4CAF50" : "#fff",
              }}>
                {totalPicks === 67 ? "✓" : totalPicks}
              </div>
            </div>
            {/* Status text */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#fff" }}>
                {totalPicks === 67 ? "Bracket Complete!" : `${67 - totalPicks} picks remaining`}
              </div>
              <div style={{ fontSize: 9, color: "#888" }}>
                {saved ? "✓ Your bracket is saved" : totalPicks === 0 ? "Tap teams to start picking" : !saved ? "Unsaved changes" : ""}
              </div>
            </div>
            {/* Save button */}
            <button onClick={handleSave} disabled={saving || totalPicks === 0} style={{
              background: saved ? "#4CAF50" : "#CC0000",
              border: "none", borderRadius: 10,
              padding: "10px 20px",
              color: "#fff", fontSize: 13, fontWeight: 700,
              cursor: saving ? "wait" : totalPicks === 0 ? "not-allowed" : "pointer",
              opacity: totalPicks === 0 ? 0.4 : 1,
              whiteSpace: "nowrap", flexShrink: 0,
              transition: "all 0.2s",
            }}>
              {saving ? "Saving..." : saved ? "✓ Saved!" : "Save Bracket"}
            </button>
          </div>
        </div>
      )}

      {/* Spacer for mobile sticky bar */}
      {isMobile && user && !locked && (tab === "bracket" || tab === "first4" || tab === "ff") && (
        <div style={{ height: 80 }} />
      )}

      {/* Footer */}
      <footer style={{
        textAlign: "center", padding: "16px 20px", borderTop: "1px solid #1a1a2e",
        color: "#444", fontSize: 10,
      }}>
        Salt City Sports — March Madness 2026 Bracket Challenge | Max possible: 192 pts
      </footer>
    </div>
  );
}
