import fs from 'fs/promises';
import path from 'path';

const CLUB_ID = "e9ba26d3-7e18-4772-abb0-584e887c9d38";
const API_BASE = "https://gmsfeed.co.uk/api/v1";

// Mapping Configuration for Teams
const TEAMS = [
  // Men's Teams
  { name: "Men's 1st XI", category: "mens", id: "7f1e9f14-a8e7-41f8-adee-775ba06b4640" },
  { name: "Men's 2nd XI", category: "mens", id: "ddc92ea3-426d-48c6-b732-31053e3ccbeb" },
  { name: "Men's 3rd XI", category: "mens", id: "de71af7a-ce05-4580-8068-db017efdbb12" },
  { name: "Men's 4th XI", category: "mens", id: "47e1e6e9-120c-4185-ad68-be7b70b76eac" },
  { name: "Men's 5th XI", category: "mens", id: "f7caa8cd-13e9-41ec-8dec-dbb6a08150db" },
  { name: "Men's 6th XI", category: "mens", id: "0a427e96-f92d-4f3c-be6a-5f9963b7d448" },
  { name: "Men's 7th XI", category: "mens", id: "a078330a-7a2c-4b35-be42-3fbdc1154980" },
  { name: "Men's 8th XI", category: "mens", id: "a4021954-7f9a-4e57-9604-3897ccd80c0b" },
  { name: "Men's O50's Supervets", category: "mens", id: "11cc043b-4c8a-4db8-b3dc-44bbc11377c5" },
  { name: "Men's O60's Evergreens", category: "mens", id: "793f5407-9721-4771-9b68-b48e65ce781b" },

  // Women's Teams
  { name: "Women's 1st XI", category: "womens", id: "3176f8e1-f036-4874-bfbd-6034c56b12ad" },
  { name: "Women's 2nd XI", category: "womens", id: "5e8b2c21-b039-4f41-8611-565a3136948e" },
  { name: "Women's 3rd XI", category: "womens", id: "98cbe9c6-8190-4e3a-bc09-c2417844d82b" },
  { name: "Women's 4th XI", category: "womens", id: "06424d34-7918-4d24-bba4-b0608426dc56" },
  { name: "Women's 5th XI", category: "womens", id: "09083ed3-cd42-4c8a-9cd1-0813729badb8" },
  { name: "Women's 6th XI", category: "womens", id: null }, // Not being run
  { name: "Women's 7th XI", category: "womens", id: "56641dbe-ade5-44f3-8611-1a3ad3ed6e4d" }
];

async function fetchJson(endpoint) {
  try {
    const res = await fetch(`${API_BASE}/${endpoint}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`Failed fetching ${endpoint}:`, err.message);
    return [];
  }
}

async function main() {
  console.log("Fetching Hockey Data...");

  // Fetch all club fixtures, results, and live matches
  const [fixtures, results, liveGames] = await Promise.all([
    fetchJson(`clubs/${CLUB_ID}/fixtures`),
    fetchJson(`clubs/${CLUB_ID}/results`),
    fetchJson(`clubs/${CLUB_ID}/live`)
  ]);

  const teamData = [];

  for (const team of TEAMS) {
    let teamFixtures = [];
    let teamResults = [];
    let leagueTable = [];

    if (team.id) {
      // Filter fixtures and results for this team
      teamFixtures = (fixtures || [])
        .filter(f => f.home_team_id === team.id || f.away_team_id === team.id)
        .slice(0, 5);

      teamResults = (results || [])
        .filter(r => r.home_team_id === team.id || r.away_team_id === team.id)
        .slice(0, 5);

      // Fetch League Table for Team
      leagueTable = await fetchJson(`teams/${team.id}/table`);
    }

    teamData.push({
      ...team,
      fixtures: teamFixtures,
      results: teamResults,
      table: leagueTable
    });
  }

  const output = {
    lastUpdated: new Date().toISOString(),
    liveGames: liveGames || [],
    teams: teamData
  };

  const dir = path.join(process.cwd(), 'data');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'hockey-data.json'), JSON.stringify(output, null, 2));
  console.log("Hockey data fetched and written to data/hockey-data.json successfully.");
}

main();
