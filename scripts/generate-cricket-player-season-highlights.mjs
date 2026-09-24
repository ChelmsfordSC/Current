import fs from "fs/promises";

const API_TOKEN = process.env.PLAY_CRICKET_KEY;

if (!API_TOKEN) {
  throw new Error("Missing PLAY_CRICKET_KEY");
}

const SITE_ID = 1786;
const SEASON = "2026";
const OUTPUT_FILE = "data/cricket-player-season-highlights.json";

// Chelmsford CC teams to scan for player highlights.
// Amend this list if you want to include/exclude teams from the season highlights page.
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

function parseDMY(dmy) {
  const m = String(dmy || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return 0;

  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);

  return new Date(yyyy, mm - 1, dd).getTime();
}

function sortMatchesOldestFirst(list) {
  return (list || []).slice().sort((a, b) => {
    const ad = parseDMY(a.match_date) || parseDMY(a.last_updated) || 0;
    const bd = parseDMY(b.match_date) || parseDMY(b.last_updated) || 0;

    if (ad !== bd) return ad - bd;

    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });
}

function pickList(json) {
  return json?.result_summary || [];
}

function isCompletedMatch(match) {
  if (!match) return false;

  const code = String(match.result || "").trim();
  const desc = String(match.result_description || "").trim();

  return Boolean(code || desc || match.result_locked === "true");
}

function stripChelmsfordPrefix(label) {
  return String(label || "")
    .replace(/^\s*Chelmsford\s+(?:CC|Cricket\s+Club)\s*/i, "")
    .trim();
}

function safeText(value, fallback = "") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function isNotOut(howOut) {
  const text = String(howOut || "").toLowerCase();
  return text.includes("not out");
}

function isOutForDuck(batter) {
  const runs = Number.parseInt(batter?.runs, 10);
  if (Number.isNaN(runs) || runs !== 0) return false;

  const howOut = String(batter?.how_out || "").trim().toLowerCase();

  // Exclude not out, retired not out and absent/retired type entries.
  if (!howOut) return false;
  if (howOut.includes("not out")) return false;
  if (howOut.includes("retired")) return false;
  if (howOut.includes("absent")) return false;

  return true;
}

function cleanPlayerName(name) {
  return String(name || "").replace(/\s+/g, " ").trim();
}

function matchContext(match, team) {
  const chelIsHome = String(match.home_team_id) === String(team.id);

  const chelTeamName = stripChelmsfordPrefix(
    safeText(chelIsHome ? match.home_team_name : match.away_team_name, team.name)
  ) || team.name;

  const opposition = chelIsHome
    ? `${safeText(match.away_club_name)} ${safeText(match.away_team_name)}`.trim()
    : `${safeText(match.home_club_name)} ${safeText(match.home_team_name)}`.trim();

  const oppositionTeamId = chelIsHome ? match.away_team_id : match.home_team_id;

  return {
    team: chelTeamName,
    team_id: team.id,
    opposition,
    opposition_team_id: oppositionTeamId,
    date: match.match_date || "",
    match_id: match.id || ""
  };
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${url}`);
  }

  return await res.json();
}

async function fetchResultsForTeam(teamId) {
  const url =
    `https://play-cricket.com/api/v2/result_summary.json` +
    `?site_id=${encodeURIComponent(SITE_ID)}` +
    `&season=${encodeURIComponent(SEASON)}` +
    `&team_id=${encodeURIComponent(teamId)}` +
    `&api_token=${encodeURIComponent(API_TOKEN)}`;

  const json = await fetchJson(url);
  return pickList(json);
}

async function fetchMatchDetails(matchId) {
  const url =
    `https://play-cricket.com/api/v2/match_detail.json` +
    `?match_id=${encodeURIComponent(matchId)}` +
    `&api_token=${encodeURIComponent(API_TOKEN)}`;

  const json = await fetchJson(url);
  return json.match_details?.[0] || null;
}

function addBattingAndBowlingHighlights({ details, match, team, output }) {
  if (!details || !Array.isArray(details.innings)) return;

  const context = matchContext(match, team);

  details.innings.forEach(innings => {
    const battingTeamId = String(innings.team_batting_id || "");
    const battingTeamName = String(innings.team_batting_name || "");
    const chelmsfordBatting =
      battingTeamId === String(team.id) || battingTeamName.toLowerCase().includes("chelmsford");

    if (chelmsfordBatting && Array.isArray(innings.bat)) {
      innings.bat.forEach(batter => {
        const runs = Number.parseInt(batter.runs, 10);
        if (Number.isNaN(runs)) return;

        const player = cleanPlayerName(batter.batsman_name);
        if (!player || player.toLowerCase().includes("selected member not found")) return;

        const notOut = isNotOut(batter.how_out);
        const scoreText = `${runs}${notOut ? "*" : ""}`;

        const item = {
          player,
          runs,
          score: scoreText,
          not_out: notOut,
          team: context.team,
          team_id: context.team_id,
          opposition: context.opposition,
          date: context.date,
          match_id: context.match_id
        };

        if (runs >= 100) {
          output.centuries.push(item);
        } else if (runs >= 50 && runs <= 99) {
          output.half_centuries.push(item);
        }

        if (isOutForDuck(batter)) {
          output.ducks.push({
            player,
            team: context.team,
            team_id: context.team_id,
            opposition: context.opposition,
            date: context.date,
            match_id: context.match_id
          });
        }
      });
    }

    // When the opposition is batting, Chelmsford players appear in the bowling figures.
    if (!chelmsfordBatting && Array.isArray(innings.bowl)) {
      innings.bowl.forEach(bowler => {
        const wickets = Number.parseInt(bowler.wickets, 10);
        const runs = Number.parseInt(bowler.runs, 10);

        if (Number.isNaN(wickets) || Number.isNaN(runs)) return;
        if (wickets < 5) return;

        const player = cleanPlayerName(bowler.bowler_name);
        if (!player || player.toLowerCase().includes("selected member not found")) return;

        output.five_fors.push({
          player,
          wickets,
          runs,
          figures: `${wickets}-${runs}`,
          team: context.team,
          team_id: context.team_id,
          opposition: context.opposition,
          date: context.date,
          match_id: context.match_id
        });
      });
    }
  });
}

function summariseDucks(ducks) {
  const grouped = new Map();

  ducks.forEach(duck => {
    const key = duck.player.toLowerCase();
    const existing = grouped.get(key) || {
      player: duck.player,
      count: 0,
      ducks: []
    };

    existing.count += 1;
    existing.ducks.push(duck);
    grouped.set(key, existing);
  });

  return [...grouped.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.player.localeCompare(b.player);
  });
}

const output = {
  generated_at: new Date().toISOString(),
  season: SEASON,
  centuries: [],
  half_centuries: [],
  five_fors: [],
  ducks: [],
  duck_hunt: [],
  errors: []
};

const seenMatchTeamPairs = new Set();

for (const team of TEAMS) {
  try {
    console.log(`Fetching completed matches for ${team.name}`);

    const matches = sortMatchesOldestFirst(fetchResultsForTeam ? await fetchResultsForTeam(team.id) : [])
      .filter(isCompletedMatch)
      .filter(match => match && match.id);

    for (const match of matches) {
      const key = `${team.id}:${match.id}`;
      if (seenMatchTeamPairs.has(key)) continue;
      seenMatchTeamPairs.add(key);

      try {
        console.log(`Fetching scorecard ${match.id} for ${team.name}`);
        const details = await fetchMatchDetails(match.id);
        addBattingAndBowlingHighlights({ details, match, team, output });
      } catch (error) {
        console.error(`Detail fetch failed for match ${match.id}`, error);
        output.errors.push({
          team: team.name,
          team_id: team.id,
          match_id: match.id,
          error: String(error?.message || error)
        });
      }
    }
  } catch (error) {
    console.error(`Result summary fetch failed for ${team.name}`, error);
    output.errors.push({
      team: team.name,
      team_id: team.id,
      error: String(error?.message || error)
    });
  }
}

output.centuries.sort((a, b) => b.runs - a.runs || a.player.localeCompare(b.player));
output.half_centuries.sort((a, b) => b.runs - a.runs || a.player.localeCompare(b.player));
output.five_fors.sort((a, b) => b.wickets - a.wickets || a.runs - b.runs || a.player.localeCompare(b.player));
output.duck_hunt = summariseDucks(output.ducks);

await fs.mkdir("data", { recursive: true });

await fs.writeFile(
  OUTPUT_FILE,
  JSON.stringify(output, null, 2),
  "utf8"
);

console.table({
  centuries: output.centuries.length,
  half_centuries: output.half_centuries.length,
  five_fors: output.five_fors.length,
  ducks: output.ducks.length,
  duck_hunt_players: output.duck_hunt.length,
  errors: output.errors.length
});

console.log(`Cricket player season highlights updated: ${OUTPUT_FILE}`);
