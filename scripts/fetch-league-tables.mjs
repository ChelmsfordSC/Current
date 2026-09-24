import fs from "fs/promises";

const API_TOKEN = process.env.PLAY_CRICKET_KEY;

if (!API_TOKEN) {
  throw new Error("Missing PLAY_CRICKET_KEY");
}

const SEASON = "2026";
const OUTPUT_FILE = "data/cricket-league-tables-all.json";

/**
 * IMPORTANT
 * =========
 * The Play-Cricket league_table endpoint requires a numeric division_id.
 * Inference from result_summary is not reliable because result_summary does not always
 * expose the league-table division_id needed by league_table.json.
 *
 * Fix: add the 2026 division_id values below.
 * Leave the team_id values unchanged.
 */
const TEAMS = [
  { label: "Sat 1st XI", id: 24293, divisionId: "135282" },
  { label: "Sat 2nd XI", id: 24294, divisionId: "135299" },
  { label: "Sat 3rd XI", id: 24295, divisionId: "135312" },
  { label: "Sat 4th XI", id: 30461, divisionId: "135330" },
  { label: "Sat 5th XI", id: 45348, divisionId: "135332" },
  { label: "NECL 1st XI", id: 324716, divisionId: "134513" },
  { label: "Womens 1st XI", id: 213007, divisionId: "137056" }
];

function isUsableDivisionId(value) {
  const text = String(value || "").trim();
  return text !== "" && text !== "REPLACE_WITH_2026_DIVISION_ID";
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

async function fetchLeagueTable(divisionId) {
  const url =
    `https://play-cricket.com/api/v2/league_table.json` +
    `?division_id=${encodeURIComponent(divisionId)}` +
    `&api_token=${encodeURIComponent(API_TOKEN)}`;

  const json = await fetchJson(url);
  const table = json?.league_table?.[0] || null;

  if (!table) {
    throw new Error(`No league_table returned for division_id ${divisionId}`);
  }

  return table;
}

const output = [];

for (const team of TEAMS) {
  const fetchedAt = new Date().toISOString();

  try {
    if (!isUsableDivisionId(team.divisionId)) {
      throw new Error(
        `Missing divisionId for ${team.label}. ` +
        `Add the current 2026 Play-Cricket division_id in generate-cricket-league-tables-all.mjs.`
      );
    }

    console.log(`Fetching league table for ${team.label}, division_id=${team.divisionId}`);
    const table = await fetchLeagueTable(team.divisionId);

    output.push({
      config: {
        label: team.label,
        team_id: team.id,
        division_id: String(team.divisionId),
        season: SEASON,
        fetched_at: fetchedAt
      },
      data: table
    });

  } catch (error) {
    console.error(`League table fetch failed for ${team.label}`, error);

    output.push({
      config: {
        label: team.label,
        team_id: team.id,
        division_id: isUsableDivisionId(team.divisionId) ? String(team.divisionId) : null,
        season: SEASON,
        fetched_at: fetchedAt
      },
      data: null,
      error: String(error?.message || error)
    });
  }
}

await fs.mkdir("data", { recursive: true });

await fs.writeFile(
  OUTPUT_FILE,
  JSON.stringify(output, null, 2),
  "utf8"
);

console.table(
  output.map(item => ({
    team: item.config.label,
    team_id: item.config.team_id,
    division_id: item.config.division_id || "MISSING",
    status: item.error ? "ERROR" : "OK"
  }))
);

console.log(`Cricket league tables updated: ${OUTPUT_FILE}`);
