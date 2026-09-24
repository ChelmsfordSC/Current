import fs from "fs/promises";

const API_TOKEN = process.env.PLAY_CRICKET_KEY;

if (!API_TOKEN) {
  throw new Error("Missing PLAY_CRICKET_KEY");
}

const SITE_ID = 1786;
const SEASON = "2026";
const CLUB_MATCH_TEXT = "chelmsford";
const OUTPUT_FILE = "data/cricket-club-statistics.json";
const TOP_N = 20;

const TEAMS = [
  { name: "Sat 1st XI", id: 24293 },
  { name: "Sat 2nd XI", id: 24294 },
  { name: "Sat 3rd XI", id: 24295 },
  { name: "Sat 4th XI", id: 30461 },
  { name: "Sat 5th XI", id: 45348 },
  { name: "Sat 6th XI", id: 105976 },
  { name: "NECL 1st XI", id: 324716 },
  { name: "Sun 1st XI", id: 30938 },
  { name: "Twenty20", id: 133549 },
  { name: "Womens 1st XI", id: 213007 }
];

const TEAM_IDS = new Set(TEAMS.map(team => String(team.id)));
const TEAM_NAME_BY_ID = new Map(TEAMS.map(team => [String(team.id), team.name]));

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstValue(obj, keys, fallback = "") {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
      return obj[key];
    }
  }
  return fallback;
}

function normaliseName(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDMY(dmy) {
  const match = String(dmy || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;

  return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
}

function isOnOrBeforeToday(dmy) {
  const matchDate = parseDMY(dmy);
  if (!matchDate) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  matchDate.setHours(0, 0, 0, 0);

  return matchDate <= today;
}

function parseOversToBalls(value) {
  if (value === null || value === undefined || value === "") return 0;

  const text = String(value).trim();
  const [oversText, ballsText = "0"] = text.split(".");
  return asNumber(oversText, 0) * 6 + asNumber(ballsText, 0);
}

function ballsToOvers(balls) {
  const fullOvers = Math.floor(balls / 6);
  const remainingBalls = balls % 6;
  return Number(`${fullOvers}.${remainingBalls}`);
}

function isNotOut(howOut) {
  const text = String(howOut || "").toLowerCase();
  return text.includes("not out") || text === "no" || text === "retired not out";
}

function inningsBattingTeamId(innings) {
  return String(firstValue(innings, ["team_batting_id", "batting_team_id", "team_id"], ""));
}

function inningsBowlingTeamId(innings) {
  return String(firstValue(innings, ["team_bowling_id", "bowling_team_id"], ""));
}

function isChelmsfordBattingInnings(innings) {
  const teamId = inningsBattingTeamId(innings);
  const teamName = String(firstValue(innings, ["team_batting_name", "batting_team_name", "team_name"], "")).toLowerCase();
  return TEAM_IDS.has(teamId) || teamName.includes(CLUB_MATCH_TEXT);
}

function isChelmsfordBowlingInnings(innings) {
  const bowlingTeamId = inningsBowlingTeamId(innings);
  const bowlingTeamName = String(firstValue(innings, ["team_bowling_name", "bowling_team_name"], "")).toLowerCase();

  if (TEAM_IDS.has(bowlingTeamId) || bowlingTeamName.includes(CLUB_MATCH_TEXT)) return true;
  return !isChelmsfordBattingInnings(innings);
}

function getBattingTeamLabel(innings, match) {
  const teamId = inningsBattingTeamId(innings);
  if (TEAM_NAME_BY_ID.has(teamId)) return TEAM_NAME_BY_ID.get(teamId);
  return normaliseName(firstValue(innings, ["team_batting_name", "team_name"], match.source_team || "Chelmsford CC"));
}

function getBowlingTeamLabel(innings, match) {
  const teamId = inningsBowlingTeamId(innings);
  if (TEAM_NAME_BY_ID.has(teamId)) return TEAM_NAME_BY_ID.get(teamId);

  // Play-Cricket often does not expose the Chelmsford bowling team name in innings.bowl.
  // The match was fetched through the specific Chelmsford team endpoint, so source_team is the best team label.
  return normaliseName(match.source_team || firstValue(innings, ["team_bowling_name", "bowling_team_name"], "Chelmsford CC"));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${url}`);
  return await res.json();
}

async function fetchMatchesForTeam(team) {
  const url =
    `https://play-cricket.com/api/v2/matches.json` +
    `?site_id=${encodeURIComponent(SITE_ID)}` +
    `&season=${encodeURIComponent(SEASON)}` +
    `&team_id=${encodeURIComponent(team.id)}` +
    `&api_token=${encodeURIComponent(API_TOKEN)}`;

  const json = await fetchJson(url);
  return (json.matches || []).map(match => ({ ...match, source_team: team.name, source_team_id: team.id }));
}

async function fetchAllMatches() {
  const allMatches = [];

  for (const team of TEAMS) {
    console.log(`Fetching matches for ${team.name}`);
    const matches = await fetchMatchesForTeam(team);
    allMatches.push(...matches);
  }

  const unique = new Map();

  for (const match of allMatches) {
    const matchId = String(firstValue(match, ["id", "match_id"], ""));
    if (!matchId) continue;
    if (!isOnOrBeforeToday(match.match_date)) continue;

    unique.set(matchId, { ...match, id: matchId });
  }

  return [...unique.values()].sort((a, b) => {
    const ad = parseDMY(a.match_date)?.getTime() || 0;
    const bd = parseDMY(b.match_date)?.getTime() || 0;
    return ad - bd;
  });
}

async function fetchMatchDetail(matchId) {
  const url =
    `https://play-cricket.com/api/v2/match_detail.json` +
    `?match_id=${encodeURIComponent(matchId)}` +
    `&api_token=${encodeURIComponent(API_TOKEN)}`;

  const json = await fetchJson(url);
  return json.match_details?.[0] || json.match_detail?.[0] || json.match_details || null;
}

function addBatting(battingMap, innings, match) {
  const teamLabel = getBattingTeamLabel(innings, match);

  for (const bat of innings.bat || innings.batting || []) {
    const player = normaliseName(firstValue(bat, ["batsman_name", "player_name", "name"], ""));
    if (!player) continue;

    const runs = asNumber(firstValue(bat, ["runs", "runs_scored"], 0));
    const balls = asNumber(firstValue(bat, ["balls", "balls_faced"], 0));
    const fours = asNumber(firstValue(bat, ["fours", "4s", "four"], 0));
    const sixes = asNumber(firstValue(bat, ["sixes", "6s", "six"], 0));
    const notOut = isNotOut(firstValue(bat, ["how_out", "dismissal"], ""));

    if (!battingMap.has(player)) {
      battingMap.set(player, {
        player,
        teams: new Set(),
        matches: new Set(),
        innings: 0,
        not_outs: 0,
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0,
        high_score: 0,
        high_score_not_out: false,
        fifties: 0,
        hundreds: 0
      });
    }

    const row = battingMap.get(player);
    row.teams.add(teamLabel);
    row.matches.add(String(match.id));
    row.innings += 1;
    row.not_outs += notOut ? 1 : 0;
    row.runs += runs;
    row.balls += balls;
    row.fours += fours;
    row.sixes += sixes;
    row.fifties += runs >= 50 && runs < 100 ? 1 : 0;
    row.hundreds += runs >= 100 ? 1 : 0;

    if (runs > row.high_score || (runs === row.high_score && notOut && !row.high_score_not_out)) {
      row.high_score = runs;
      row.high_score_not_out = notOut;
    }
  }
}

function addBowling(bowlingMap, innings, match) {
  const teamLabel = getBowlingTeamLabel(innings, match);

  for (const bowl of innings.bowl || innings.bowling || []) {
    const player = normaliseName(firstValue(bowl, ["bowler_name", "player_name", "name"], ""));
    if (!player) continue;

    const wickets = asNumber(firstValue(bowl, ["wickets", "w"], 0));
    const runs = asNumber(firstValue(bowl, ["runs", "runs_conceded", "r"], 0));
    const maidens = asNumber(firstValue(bowl, ["maidens", "m"], 0));
    const balls = parseOversToBalls(firstValue(bowl, ["overs", "o"], 0));
    const wides = asNumber(firstValue(bowl, ["wides", "wd"], 0));
    const no_balls = asNumber(firstValue(bowl, ["no_balls", "nb"], 0));

    if (!bowlingMap.has(player)) {
      bowlingMap.set(player, {
        player,
        teams: new Set(),
        matches: new Set(),
        innings: 0,
        balls: 0,
        maidens: 0,
        runs: 0,
        wickets: 0,
        wides: 0,
        no_balls: 0,
        best_wickets: 0,
        best_runs: 999999,
        three_wickets: 0,
        five_wickets: 0
      });
    }

    const row = bowlingMap.get(player);
    row.teams.add(teamLabel);
    row.matches.add(String(match.id));
    row.innings += 1;
    row.balls += balls;
    row.maidens += maidens;
    row.runs += runs;
    row.wickets += wickets;
    row.wides += wides;
    row.no_balls += no_balls;
    row.three_wickets += wickets >= 3 ? 1 : 0;
    row.five_wickets += wickets >= 5 ? 1 : 0;

    if (wickets > row.best_wickets || (wickets === row.best_wickets && wickets > 0 && runs < row.best_runs)) {
      row.best_wickets = wickets;
      row.best_runs = runs;
    }
  }
}

function finaliseBatting(battingMap) {
  return [...battingMap.values()]
    .map(row => {
      const outs = row.innings - row.not_outs;
      const average = outs > 0 ? row.runs / outs : null;
      const strike_rate = row.balls > 0 ? (row.runs / row.balls) * 100 : null;

      return {
        player: row.player,
        teams: [...row.teams].sort().join(", "),
        matches: row.matches.size,
        innings: row.innings,
        not_outs: row.not_outs,
        runs: row.runs,
        balls: row.balls,
        fours: row.fours,
        sixes: row.sixes,
        high_score: row.high_score,
        high_score_display: `${row.high_score}${row.high_score_not_out ? "*" : ""}`,
        average,
        strike_rate,
        fifties: row.fifties,
        hundreds: row.hundreds
      };
    })
    .filter(row => row.innings > 0)
    .sort((a, b) => b.runs - a.runs || b.high_score - a.high_score || a.player.localeCompare(b.player))
    .slice(0, TOP_N);
}

function finaliseBowling(bowlingMap) {
  return [...bowlingMap.values()]
    .map(row => {
      const overs = ballsToOvers(row.balls);
      const average = row.wickets > 0 ? row.runs / row.wickets : null;
      const economy = row.balls > 0 ? row.runs / (row.balls / 6) : null;
      const strike_rate = row.wickets > 0 ? row.balls / row.wickets : null;

      return {
        player: row.player,
        teams: [...row.teams].sort().join(", "),
        matches: row.matches.size,
        innings: row.innings,
        balls: row.balls,
        overs,
        maidens: row.maidens,
        runs: row.runs,
        wickets: row.wickets,
        wides: row.wides,
        no_balls: row.no_balls,
        best: row.best_wickets > 0 ? `${row.best_wickets}-${row.best_runs}` : "—",
        average,
        economy,
        strike_rate,
        three_wickets: row.three_wickets,
        five_wickets: row.five_wickets
      };
    })
    .filter(row => row.innings > 0)
    .sort((a, b) => b.wickets - a.wickets || b.innings - a.innings || a.player.localeCompare(b.player))
    .slice(0, TOP_N);
}

const uniqueMatches = await fetchAllMatches();
console.log(`Found ${uniqueMatches.length} unique Chelmsford matches on or before today.`);

const battingMap = new Map();
const bowlingMap = new Map();
let scorecardsProcessed = 0;

for (const match of uniqueMatches) {
  console.log(`Fetching scorecard for match ${match.id} (${match.match_date || "no date"})`);

  try {
    const detail = await fetchMatchDetail(match.id);
    if (!detail || !Array.isArray(detail.innings)) continue;

    let processedThisMatch = false;

    for (const innings of detail.innings) {
      if (isChelmsfordBattingInnings(innings)) {
        addBatting(battingMap, innings, match);
        processedThisMatch = true;
      }

      if (isChelmsfordBowlingInnings(innings)) {
        addBowling(bowlingMap, innings, match);
        processedThisMatch = true;
      }
    }

    if (processedThisMatch) scorecardsProcessed += 1;
  } catch (err) {
    console.error(`Failed to process match ${match.id}`, err);
  }
}

const output = {
  site_id: SITE_ID,
  season: SEASON,
  generated_at: new Date().toISOString(),
  match_count: uniqueMatches.length,
  scorecards_processed: scorecardsProcessed,
  batting: finaliseBatting(battingMap),
  bowling: finaliseBowling(bowlingMap)
};

await fs.mkdir("data", { recursive: true });
await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");

console.log(`Club statistics updated: ${OUTPUT_FILE}`);
console.log(`Batters: ${output.batting.length}, bowlers: ${output.bowling.length}`);
