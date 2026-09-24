import fs from "fs/promises";

const API_TOKEN = process.env.PLAY_CRICKET_KEY;

if (!API_TOKEN) {
  throw new Error("Missing PLAY_CRICKET_KEY");
}

const SITE_ID = 1786;
const SEASON = "2026";

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

function pickList(json) {
  return json?.result_summary || [];
}

function sortMatchesNewestFirst(list) {
  return (list || []).slice().sort((a, b) => {
    const ad = parseDMY(a.match_date) || parseDMY(a.last_updated) || 0;
    const bd = parseDMY(b.match_date) || parseDMY(b.last_updated) || 0;

    if (bd !== ad) return bd - ad;

    return (Number(b.id) || 0) - (Number(a.id) || 0);
  });
}

function pickLatest(list) {
  return sortMatchesNewestFirst(list)[0] || null;
}

function isCompletedResult(match) {
  if (!match) return false;

  const code = String(match.result || "").trim();
  const desc = String(match.result_description || "").trim();

  // Include only matches with a visible result, description, or locked result.
  // This avoids future fixtures or matches where no result has yet been recorded.
  return Boolean(code || desc || match.result_locked === "true");
}

function pickFormGuide(list, limit = 5) {
  return sortMatchesNewestFirst(list)
    .filter(isCompletedResult)
    .slice(0, limit)
    .reverse(); // oldest to most recent, as required by the webpage form guide
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
  const list = pickList(json);

  return {
    // Keeps the latest-match scorebox behaviour unchanged.
    match: pickLatest(list),

    // New field for the webpage form guide.
    // This is separate from match, so it does not affect the current latest-match display.
    form: pickFormGuide(list, 5)
  };
}

async function fetchMatchDetails(matchId) {
  const url =
    `https://play-cricket.com/api/v2/match_detail.json` +
    `?match_id=${encodeURIComponent(matchId)}` +
    `&api_token=${encodeURIComponent(API_TOKEN)}`;

  const perf = {
    runs: [],
    wickets: []
  };

  try {
    const json = await fetchJson(url);
    const details = json.match_details?.[0];

    if (!details || !details.innings) {
      return perf;
    }

    details.innings.forEach(inn => {
      if (inn.team_batting_name && inn.team_batting_name.includes("Chelmsford")) {
        if (inn.bat) {
          inn.bat.forEach(b => {
            const r = parseInt(b.runs, 10);

            if (!Number.isNaN(r) && r >= 50) {
              const isNotOut =
                b.how_out &&
                b.how_out.toLowerCase().includes("not out");

              perf.runs.push({
                name: b.batsman_name,
                score: r,
                notOut: isNotOut
              });
            }
          });
        }
      } else {
        if (inn.bowl) {
          inn.bowl.forEach(bw => {
            const w = parseInt(bw.wickets, 10);

            if (!Number.isNaN(w) && w >= 3) {
              perf.wickets.push({
                name: bw.bowler_name,
                w,
                r: bw.runs
              });
            }
          });
        }
      }
    });

  } catch (e) {
    console.error(`Detail fetch failed for match ${matchId}`, e);
  }

  return perf;
}

const output = [];

for (const team of TEAMS) {
  console.log(`Fetching latest result and form guide for ${team.name}`);

  const { match, form } = await fetchResultsForTeam(team.id);

  let perf = {
    runs: [],
    wickets: []
  };

  // Performance highlights remain based only on the latest match.
  // This keeps the existing webpage scorebox behaviour unchanged.
  if (match && match.id) {
    perf = await fetchMatchDetails(match.id);
  }

  output.push({
    team,
    match,
    perf,
    form,
    fetched_at: new Date().toISOString()
  });
}

await fs.mkdir("data", {
  recursive: true
});

await fs.writeFile(
  "data/cricket-scores.json",
  JSON.stringify(output, null, 2),
  "utf8"
);

console.log("Cricket scores updated.");
