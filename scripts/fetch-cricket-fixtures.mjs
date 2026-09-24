import fs from "fs/promises";

const API_TOKEN = process.env.PLAY_CRICKET_KEY;

if (!API_TOKEN) {
  throw new Error("Missing PLAY_CRICKET_KEY");
}

const SITE_ID = 1786;
const SEASON = "2026";
const FIXTURES_PER_TEAM = 9;

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
  if (!m) return null;

  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);

  return new Date(yyyy, mm - 1, dd);
}

function fixtureSortValue(match) {
  const d = parseDMY(match.match_date);
  return d ? d.getTime() : Number.MAX_SAFE_INTEGER;
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

async function fetchFixtures(teamId) {
  const url =
    `https://play-cricket.com/api/v2/matches.json` +
    `?site_id=${encodeURIComponent(SITE_ID)}` +
    `&season=${encodeURIComponent(SEASON)}` +
    `&team_id=${encodeURIComponent(teamId)}` +
    `&api_token=${encodeURIComponent(API_TOKEN)}`;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  const json = await fetchJson(url);

  return (json.matches || [])
    .filter(match => {
      if (match.result) return false;

      const matchDate = parseDMY(match.match_date);
      if (!matchDate) return false;

      return matchDate >= tomorrow;
    })
    .sort((a, b) => fixtureSortValue(a) - fixtureSortValue(b))
    .slice(0, FIXTURES_PER_TEAM);
}

const output = [];

for (const team of TEAMS) {
  console.log(`Fetching upcoming fixtures for ${team.name}`);

  let fix = [];

  try {
    fix = await fetchFixtures(team.id);
  } catch (err) {
    console.error(`Fixture fetch failed for ${team.name}`, err);
  }

  output.push({
    team,
    fix,
    fetched_at: new Date().toISOString()
  });
}

await fs.mkdir("data", { recursive: true });

await fs.writeFile(
  "data/cricket-fixtures.json",
  JSON.stringify(output, null, 2),
  "utf8"
);

console.log("Cricket fixtures updated.");
