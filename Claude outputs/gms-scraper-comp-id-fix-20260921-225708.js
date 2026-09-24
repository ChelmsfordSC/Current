export default {
  async scheduled(event, env, ctx) {
    const stage = cronToStage(event.cron);
    ctx.waitUntil(runStage(env, stage));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const stage = url.searchParams.get('stage') || 'core';
    const result = await runStage(env, stage);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'content-type': 'application/json' }
    });
  }
};

// Map each Cron Trigger's schedule string to which stage it runs.
// Set these to match whatever schedules you add in the dashboard's
// Triggers tab (Settings > Triggers > Cron Triggers).
function cronToStage(cron) {
  if (cron === '0 */6 * * *') return 'leagues';       // every 6 hours
  if (cron === '0 3 * * *') return 'competitions';     // once a day at 03:00
  if (cron === '0 4 * * *') return 'team-fixtures';    // once a day at 04:00 -- add this Cron Trigger in the dashboard
  if (cron === '0 5 * * *') return 'fixture-details';  // once a day at 05:00 -- add this Cron Trigger in the dashboard
  return 'core';                                        // everything else (e.g. */20 * * * *)
}

const BASE_HEADERS = {
  'Accept': 'application/json',
  'Referer': 'https://www.chelmsfordsc.org.uk/',
  'Origin': 'https://www.chelmsfordsc.org.uk',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
};

const CALL_GAP_MS = 4000;
const RETRY_WAIT_MS = 6000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callGms(showType, params, isRetry = false) {
  const qs = new URLSearchParams({
    method: 'api',
    show: showType,
    sort_by: 'fixtureTime',
    // showDetail:yes is purely additive -- confirmed live against gmsfeed.co.uk's
    // own widget-builder tool: it just tags each existing card with an extra
    // "gms-detaillink" class and a data-fixture="<uuid>" attribute, nothing else
    // about the card markup changes. That UUID is GMS's own internal fixture ID
    // (distinct from our slugified fixture_id) and is the only way to key the
    // separate per-fixture "show=fixture" detail call (see callGmsFixtureDetail).
    options: 'showList:yes,showGender:yes,showDetail:yes',
    ...params
  });
  const url = `https://gmsfeed.co.uk/api/show/refresh?${qs.toString()}`;
  const res = await fetch(url, { headers: BASE_HEADERS });
  const bodyText = await res.text();
  if (res.status === 429 && !isRetry) {
    await sleep(RETRY_WAIT_MS);
    return callGms(showType, params, true);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${bodyText.slice(0, 500)}`);
  try {
    return JSON.parse(bodyText);
  } catch (e) {
    throw new Error(`Non-JSON response: ${bodyText.slice(0, 500)}`);
  }
}

async function callGmsCompetitions(teamId, isRetry = false) {
  const url = `https://gmsfeed.co.uk/api/competitions?team=${encodeURIComponent(teamId)}`;
  const res = await fetch(url, { headers: BASE_HEADERS });
  const bodyText = await res.text();
  if (res.status === 429 && !isRetry) {
    await sleep(RETRY_WAIT_MS);
    return callGmsCompetitions(teamId, true);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${bodyText.slice(0, 500)}`);
  try {
    return JSON.parse(bodyText);
  } catch (e) {
    throw new Error(`Non-JSON response: ${bodyText.slice(0, 500)}`);
  }
}

// Per-fixture "Show Detail" click-through (scorers, team sheets, coaching
// roles, match officials) lives behind its own call, keyed by GMS's own
// fixture UUID rather than our slugified fixture_id -- confirmed live via
// gmsfeed.co.uk's own widget-builder tool: clicking a detail-enabled card
// fires GET /api/show?method=api&show=fixture&options=id:<uuid>&club_id=...
// (note: /api/show, NOT /api/show/refresh -- different path to the other
// calls). A fixture with nothing entered yet returns a "No more details
// available" sentinel in the html rather than an error.
async function callGmsFixtureDetail(gmsFixtureUuid, clubId, isRetry = false) {
  const qs = new URLSearchParams({
    method: 'api',
    show: 'fixture',
    options: `id:${gmsFixtureUuid}`,
    club_id: clubId
  });
  const url = `https://gmsfeed.co.uk/api/show?${qs.toString()}`;
  const res = await fetch(url, { headers: BASE_HEADERS });
  const bodyText = await res.text();
  if (res.status === 429 && !isRetry) {
    await sleep(RETRY_WAIT_MS);
    return callGmsFixtureDetail(gmsFixtureUuid, clubId, true);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${bodyText.slice(0, 500)}`);
  try {
    return JSON.parse(bodyText);
  } catch (e) {
    throw new Error(`Non-JSON response: ${bodyText.slice(0, 500)}`);
  }
}

async function logRun(env, showType, clubId, compId, status, message, now) {
  await env.DB.prepare(
    `INSERT INTO scrape_log (show_type, club_id, comp_id, status, message, run_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(showType, clubId ?? null, compId ?? null, status, String(message).slice(0, 1900), now).run();
}

// ---------------------------------------------------------------------------
// HTML PARSING
// ---------------------------------------------------------------------------

function slugify(text) {
  return String(text).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function decodeEntities(text) {
  return String(text)
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
}

// GMS renders fixture_date as "12 Sep 2026" (its own display format), which
// is what we store in fixture_date for backwards compatibility with
// anything already reading that column -- but it's useless for date-range
// filtering or chronological sorting in SQLite (it's not ISO, and string
// comparison/sort on "DD Mon YYYY" is close to meaningless: "20 Mar 2027"
// sorts before "03 Apr 2027" because "2" < "0" comes first alphabetically on
// the day digit, etc). This derives a proper ISO "YYYY-MM-DD" companion
// value at parse time so callers (like /api/today) can filter/sort on it
// directly instead of silently never matching anything.
const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
};
function toIsoDate(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).trim().match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (!m) return null;
  const [, day, monthWord, year] = m;
  const mon = MONTHS[monthWord.slice(0, 3).toLowerCase()];
  if (!mon) return null;
  return `${year}-${mon}-${day.padStart(2, '0')}`;
}

// GMS appends a gender tag to the club's own team name in some scrape
// contexts ("Chelmsford 4 (M)") but not others ("Chelmsford 4") for the
// exact same real-world match, depending on whether club_id was passed
// alongside comp_id in that particular call. Stripping it before building
// the fixture_id means the same match always slugifies to the same ID no
// matter which scrape path (fixtures/results vs matchdays) wrote it, so the
// ON CONFLICT upsert merges them into one row instead of inserting a
// duplicate. The raw name (with the tag, when present) is still kept in
// home_team_name/away_team_name for display.
function stripGenderSuffix(name) {
  if (!name) return name;
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

// The divider div between the two team names is "gms-carddivide gms-cardtime"
// containing a kickoff time (e.g. "15:00") for an unplayed fixture, but once
// a match has been played GMS swaps the class to something outcome-specific
// -- confirmed live as "gms-carddivide gms-win" containing a score ("5 - 3")
// -- and presumably "gms-loss"/"gms-draw" for the other outcomes, though
// we've only directly observed "gms-win" so far. Matching the class loosely
// (any "gms-carddivide ..." rather than the literal "gms-cardtime") means we
// don't need to enumerate every outcome class GMS might use: we just look at
// the divider's *content* afterward to decide whether it's a time or a
// score. Previously this was hardcoded to the literal cardtime class, so a
// played match's card failed the regex entirely and the whole fixture --
// not just its score -- was silently dropped by the parser.
const CARD_RE = new RegExp(
  // Since showDetail:yes was added to every call's options (see callGms),
  // GMS tags each card with an extra "gms-detaillink" class and a
  // data-fixture="<uuid>" attribute -- both optional here so this still
  // matches fine against any response that doesn't have showDetail on.
  '<div class="gms-card(?: gms-detaillink)?"(?:\\s+data-fixture="(?<gmsFixtureUuid>[^"]*)")?>\\s*' +
  '<div class="gms-carddate">(?<date>[^<]*)<\\/div>\\s*' +
  '<div class="gms-cardfixture">\\s*' +
  '<div class="gms-cardhome">(?:<div class="">(?<homeOpponent>[^<]*)<\\/div>|<div data-team="(?<homeClubId>[^"]*)" class="gms-clubteam">(?<homeClubName>[^<]*)<\\/div>)<\\/div>\\s*' +
  '<div class="gms-carddivide[^"]*">(?<divide>[^<]*)<\\/div>\\s*' +
  '<div class="gms-cardaway">(?:<div class="">(?<awayOpponent>[^<]*)<\\/div>|<div data-team="(?<awayClubId>[^"]*)" class="gms-clubteam">(?<awayClubName>[^<]*)<\\/div>)<\\/div>\\s*' +
  '<\\/div>\\s*' +
  '<div class="gms-cardvenue">(?:<a href="(?<venueUrl>[^"]*)"[^>]*>(?<venueLinkText>[^<]*)<\\/a>|(?<venuePlain>[^<]*))<\\/div>\\s*' +
  '<\\/div>',
  'g'
);

// A played match's divider holds a plain "N - N" score instead of a time.
const SCORE_RE = /^(\d+)\s*-\s*(\d+)$/;

function parseFixtureCards(html) {
  if (!html || typeof html !== 'string') return [];
  const items = [];
  let m;
  CARD_RE.lastIndex = 0;
  while ((m = CARD_RE.exec(html)) !== null) {
    const g = m.groups;
    const homeIsClub = g.homeClubId !== undefined;
    const awayIsClub = g.awayClubId !== undefined;
    const homeName = homeIsClub ? g.homeClubName : g.homeOpponent;
    const awayName = awayIsClub ? g.awayClubName : g.awayOpponent;
    const clubTeamId = homeIsClub ? g.homeClubId : (awayIsClub ? g.awayClubId : null);
    const clubSide = homeIsClub ? 'home' : (awayIsClub ? 'away' : null);

    if (!homeName && !awayName) continue;

    const venueName = g.venueLinkText !== undefined ? g.venueLinkText : g.venuePlain;
    const cleanHomeName = homeName ? decodeEntities(homeName).trim() : null;
    const cleanAwayName = awayName ? decodeEntities(awayName).trim() : null;
    const idHomeName = stripGenderSuffix(cleanHomeName);
    const idAwayName = stripGenderSuffix(cleanAwayName);
    const cleanDate = g.date ? g.date.trim() : null;
    const fixtureId = slugify(`${cleanDate}_${idHomeName}_${idAwayName}`);

    const divideText = g.divide ? decodeEntities(g.divide).trim() : '';
    const scoreMatch = divideText.match(SCORE_RE);
    let fixtureTime = null, homeScore = null, awayScore = null, status = null;
    if (scoreMatch) {
      homeScore = parseInt(scoreMatch[1], 10);
      awayScore = parseInt(scoreMatch[2], 10);
      status = 'completed';
    } else {
      fixtureTime = divideText || null;
    }

    items.push({
      fixture_id: fixtureId,
      home_team_name: cleanHomeName,
      away_team_name: cleanAwayName,
      fixture_date: cleanDate,
      fixture_date_iso: toIsoDate(cleanDate),
      fixture_time: fixtureTime,
      status: status,
      home_score: homeScore,
      away_score: awayScore,
      club_team_id: clubTeamId,
      club_side: clubSide,
      venue_name: venueName ? decodeEntities(venueName).trim() : null,
      venue_url: g.venueUrl || null,
      gms_fixture_uuid: g.gmsFixtureUuid || null
    });
  }
  return items;
}

// A per-team fixtures/results call (show=fixtures|results&team=<club_team_id>)
// returns that team's WHOLE season, not just the club-wide "next match day"
// snapshot -- but GMS stops tagging either side with data-team/gms-clubteam
// once it's scoped to one known team, since it no longer needs to
// disambiguate which side is "us". parseFixtureCards() still parses these
// cards fine (both sides just fall into the plain "opponent" branch), so we
// reuse it and then figure out which side is the team we asked for by name,
// tagging club_team_id/club_side ourselves afterward.
function parseFixtureCardsForTeam(html, teamName, teamId) {
  const items = parseFixtureCards(html);
  const target = stripGenderSuffix(teamName || '').toLowerCase();
  if (!target) return items;
  for (const item of items) {
    const home = stripGenderSuffix(item.home_team_name || '').toLowerCase();
    const away = stripGenderSuffix(item.away_team_name || '').toLowerCase();
    if (home === target) {
      item.club_team_id = teamId;
      item.club_side = 'home';
    } else if (away === target) {
      item.club_team_id = teamId;
      item.club_side = 'away';
    }
  }
  return items;
}

const TEAM_ROW_RE = /<tr><td><a href="([^"]*)"[^>]*>([^<]*)<\/a><\/td><td>([^<]*)<\/td><\/tr>/g;

function parseTeamRows(html) {
  if (!html || typeof html !== 'string') return [];
  const items = [];
  let m;
  TEAM_ROW_RE.lastIndex = 0;
  while ((m = TEAM_ROW_RE.exec(html)) !== null) {
    const [, ehLink, name, gender] = m;
    if (!name) continue;
    const cleanName = decodeEntities(name).trim();
    const cleanGender = (gender || '').trim();
    items.push({
      team_id: `${cleanName}_${cleanGender}`,
      name: cleanName,
      gender: cleanGender,
      eh_link: ehLink || null
    });
  }
  return items;
}

const OPTION_RE = /<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g;

function parseCompetitionOptions(html) {
  if (!html || typeof html !== 'string') return [];
  const items = [];
  let m;
  OPTION_RE.lastIndex = 0;
  while ((m = OPTION_RE.exec(html)) !== null) {
    const [, value, rawName] = m;
    if (!value) continue;
    const decoded = decodeEntities(rawName).trim();
    const seasonMatch = decoded.match(/\(([^)]+)\)\s*$/);
    const season = seasonMatch ? seasonMatch[1] : null;
    const name = seasonMatch ? decoded.slice(0, seasonMatch.index).trim() : decoded;
    const lower = name.toLowerCase();
    const gender = lower.includes('women') ? 'F' : (lower.includes('men') ? 'M' : null);
    items.push({ comp_id: value, name, season, gender });
  }
  return items;
}

const STANDINGS_ROW_RE = new RegExp(
  '<tr data-team="(?<teamId>[^"]*)">' +
  '<td>(?<position>[^<]*)<\\/td>' +
  '<td>(?<teamName>[^<]*)<\\/td>' +
  '<td>(?<played>[^<]*)<\\/td>' +
  '<td>(?<won>[^<]*)<\\/td>' +
  '<td>(?<drawn>[^<]*)<\\/td>' +
  '<td>(?<lost>[^<]*)<\\/td>' +
  '<td class="gms-nomobile">(?<gf>[^<]*)<\\/td>' +
  '<td class="gms-nomobile">(?<ga>[^<]*)<\\/td>' +
  '<td>(?<gd>[^<]*)<\\/td>' +
  '<td>(?<points>[^<]*)<\\/td>' +
  '<\\/tr>',
  'g'
);

function toIntOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

function parseStandingsRows(html) {
  if (!html || typeof html !== 'string') return [];
  const items = [];
  let m;
  STANDINGS_ROW_RE.lastIndex = 0;
  while ((m = STANDINGS_ROW_RE.exec(html)) !== null) {
    const g = m.groups;
    items.push({
      team_id: g.teamId || null,
      team_name: g.teamName ? decodeEntities(g.teamName).trim() : null,
      position: toIntOrNull(g.position),
      played: toIntOrNull(g.played),
      won: toIntOrNull(g.won),
      drawn: toIntOrNull(g.drawn),
      lost: toIntOrNull(g.lost),
      goals_for: toIntOrNull(g.gf),
      goals_against: toIntOrNull(g.ga),
      goal_difference: toIntOrNull(g.gd),
      points: toIntOrNull(g.points)
    });
  }
  return items;
}

// The detail view uses a couple of extra HTML entities the other parsers
// never encounter (&nbsp; for spacing, &times; for the "Names Withheld
// (×N)" count, &prime; for a minutes-mark like "50′") -- kept as a
// separate helper rather than widening decodeEntities() so the existing
// parsers' behaviour can't shift under them.
function decodeDetailEntities(text) {
  return decodeEntities(text)
    .replace(/&nbsp;/g, ' ')
    .replace(/&times;/g, '×')
    .replace(/&prime;/g, "'");
}

// Each <li> in a team sheet is one of:
//   "Names Withheld (×6)"                        -- an aggregate bucket of
//                                                    redacted players, no
//                                                    squad number
//   "85 Name Withheld"                           -- ...vs. a SPECIFIC numbered
//                                                    player whose own name is
//                                                    withheld (confirmed live,
//                                                    Witham 4 v Chelmsford 7,
//                                                    12 Sep 2026) -- distinct
//                                                    from the bucket above
//   "24 Joanna McNeice"                          -- squad number + name
//   "72 Amelia Beth (C)"                         -- ...with a (C)aptain/(GK) tag
//   "2 Louise Acton<b>50′</b><b>FG</b>"          -- ...plus one or more
//                                                    <b>time</b><b>type</b>
//                                                    pairs for goals (FG/PS/PC
//                                                    confirmed live; the same
//                                                    shape would also carry
//                                                    card codes like YC/RC if
//                                                    GMS has one entered --
//                                                    not yet seen in a real
//                                                    response, so not assumed)
//   " Ellah Bolaky"                              -- name only, no squad number
function parsePlayerLi(rawLi) {
  const events = [];
  const boldValues = [];
  const boldRe = /<b>([^<]*)<\/b>/g;
  let bm;
  while ((bm = boldRe.exec(rawLi)) !== null) boldValues.push(decodeDetailEntities(bm[1]).trim());
  for (let i = 0; i + 1 < boldValues.length; i += 2) {
    if (boldValues[i]) events.push({ time: boldValues[i], type: boldValues[i + 1] || null });
  }
  // Drop the <b>...</b> spans (tag+content) before stripping remaining tags,
  // so the event text itself can't leak into the name/number/tag parse below.
  const withoutEvents = rawLi.replace(/<b>[^<]*<\/b>/g, '');
  const core = decodeDetailEntities(withoutEvents.replace(/<[^>]*>/g, ' '))
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const aggregateWithheld = core.match(/^Names?\s+Withheld(?:\s*\(×(\d+)\))?$/i);
  if (aggregateWithheld) {
    return {
      withheld: true,
      count: aggregateWithheld[1] ? parseInt(aggregateWithheld[1], 10) : 1,
      squad_number: null,
      name: null,
      is_captain: false,
      is_goalkeeper: false,
      tag: null,
      goals: []
    };
  }

  const tagMatch = core.match(/\(([^)]+)\)\s*$/);
  const tag = tagMatch ? tagMatch[1] : null;
  const withoutTag = (tagMatch ? core.slice(0, tagMatch.index) : core).trim();
  const numMatch = withoutTag.match(/^(\d+)\s+(.*)$/);
  const squadNumber = numMatch ? numMatch[1] : null;
  const rawName = (numMatch ? numMatch[2] : withoutTag).trim() || null;
  const perPlayerWithheld = rawName ? /^Names?\s+Withheld$/i.test(rawName) : false;

  return {
    withheld: perPlayerWithheld,
    count: perPlayerWithheld ? 1 : null,
    squad_number: squadNumber,
    name: perPlayerWithheld ? null : rawName,
    is_captain: tag === 'C',
    is_goalkeeper: tag === 'GK',
    tag: tag && tag !== 'C' && tag !== 'GK' ? tag : null,
    goals: events
  };
}

// Coaching-role and match-official <li>s are both a plain "Role: Name" pair
// (e.g. "First Aider: Karen Bryant", "Umpire: Stephen Parish").
function parseRoleLi(rawLi) {
  const decoded = decodeDetailEntities(rawLi.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  const idx = decoded.indexOf(':');
  if (idx === -1) return { role: null, name: decoded || null };
  return { role: decoded.slice(0, idx).trim(), name: decoded.slice(idx + 1).trim() };
}

// Parses the response of callGmsFixtureDetail(). Confirmed live against four
// real fixtures: three played matches (varying coaching roles/match officials
// coverage, multi-goal scorers, per-player and aggregate withheld names) and
// one upcoming match with nothing entered yet (which returns a "No more
// details available" sentinel instead of the usual markup -- stored as
// status='no_details' rather than treated as an error, so the fixture-details
// stage can skip re-fetching it too often).
function parseFixtureDetail(html) {
  if (!html || typeof html !== 'string') return null;
  const noDetails = /<b>No more details available<\/b>/.test(html);
  const compMatch = html.match(/<div class="gms-cardcomp">([^<]*)<\/div>/);
  const addressMatch = html.match(/<div class="gms-cardaddress">([^<]*)<\/div>/);
  const ehMatch = html.match(/href="([^"]*)"[^>]*>England Hockey Link<\/a>/);

  const result = {
    competition_name: compMatch ? decodeEntities(compMatch[1]).trim() : null,
    venue_address: addressMatch ? decodeEntities(addressMatch[1]).trim() : null,
    eh_fixture_link: ehMatch ? ehMatch[1] : null,
    status: noDetails ? 'no_details' : 'has_details',
    home_scorers_text: null,
    away_scorers_text: null,
    home_team_sheet: null,
    away_team_sheet: null,
    home_coaching_roles: null,
    away_coaching_roles: null,
    home_crest_url: null,
    away_crest_url: null,
    match_officials: null
  };
  if (noDetails) return result;

  const scorersMatch = html.match(
    /<div class="gms-cardscorers"><div class="gms-cardhome"><div>([\s\S]*?)<\/div><\/div><div class="gms-carddivide"><\/div><div class="gms-cardaway"><div>([\s\S]*?)<\/div><\/div><\/div>/
  );
  if (scorersMatch) {
    result.home_scorers_text = decodeDetailEntities(scorersMatch[1]).trim() || null;
    result.away_scorers_text = decodeDetailEntities(scorersMatch[2]).trim() || null;
  }

  // Each team's block is <div><div class="gms-players"><img src="<crest>">
  // <b>Team Name</b><ul>...</ul></div>[<div class="gms-officials"><br>
  // <b>Coaching Roles</b><ul>...</ul></div>]</div> -- appears twice (home,
  // then away). The Coaching Roles block (nested per-team, prefixed with a
  // <br>) is distinct from the Match Officials block below (a sibling after
  // both teams, no <br> prefix) -- that's what tells the two apart. Confirmed
  // live that the <br> is sometimes self-closed (<br/>) and sometimes not
  // (<br>) depending on which GMS response you hit, so both are accepted.
  const TEAM_BLOCK_RE = /<div><div class="gms-players">(?:<img[^>]*src="([^"]*)"[^>]*>(?:<\/img>)?)?<b>([^<]*)<\/b><ul>([\s\S]*?)<\/ul><\/div>(?:<div class="gms-officials"><br\/?><b>Coaching Roles<\/b><ul>([\s\S]*?)<\/ul><\/div>)?<\/div>/g;
  const teams = [];
  let tm;
  while ((tm = TEAM_BLOCK_RE.exec(html)) !== null) {
    const [, crestUrl, teamName, playersUl, coachingUl] = tm;
    const players = [];
    const liRe = /<li>([\s\S]*?)<\/li>/g;
    let lm;
    while ((lm = liRe.exec(playersUl)) !== null) players.push(parsePlayerLi(lm[1]));
    const coaching = [];
    if (coachingUl) {
      const cliRe = /<li>([\s\S]*?)<\/li>/g;
      let cm;
      while ((cm = cliRe.exec(coachingUl)) !== null) coaching.push(parseRoleLi(cm[1]));
    }
    teams.push({ team_name: decodeEntities(teamName).trim(), crest_url: crestUrl || null, players, coaching_roles: coaching });
  }
  if (teams[0]) {
    result.home_team_sheet = JSON.stringify(teams[0].players);
    result.home_coaching_roles = JSON.stringify(teams[0].coaching_roles);
    result.home_crest_url = teams[0].crest_url;
  }
  if (teams[1]) {
    result.away_team_sheet = JSON.stringify(teams[1].players);
    result.away_coaching_roles = JSON.stringify(teams[1].coaching_roles);
    result.away_crest_url = teams[1].crest_url;
  }

  const officialsMatch = html.match(/<div class="gms-officials"><b>Match Officials<\/b><ul>([\s\S]*?)<\/ul><\/div>/);
  if (officialsMatch) {
    const officials = [];
    const oliRe = /<li>([\s\S]*?)<\/li>/g;
    let om;
    while ((om = oliRe.exec(officialsMatch[1])) !== null) officials.push(parseRoleLi(om[1]));
    result.match_officials = JSON.stringify(officials);
  }
  return result;
}

// ---------------------------------------------------------------------------
// DB WRITES
// ---------------------------------------------------------------------------

async function upsertFixtureItems(env, items, now) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  // COALESCE(excluded.x, fixtures.x): a scrape that doesn't know a field
  // (e.g. matchdays has no club_team_id/club_side; fixtures/results have no
  // comp_id) must not blow away a value a different scrape already wrote
  // for the same fixture_id. Only an explicit non-null value overwrites.
  const stmt = env.DB.prepare(`
    INSERT INTO fixtures (
      fixture_id, comp_id, home_team_name, away_team_name,
      fixture_date, fixture_date_iso, fixture_time, status, home_score, away_score,
      scorers, venue_name, venue_url, club_team_id, club_side, gms_fixture_uuid, last_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fixture_id) DO UPDATE SET
      comp_id=COALESCE(excluded.comp_id, fixtures.comp_id),
      home_team_name=excluded.home_team_name,
      away_team_name=excluded.away_team_name,
      fixture_date=excluded.fixture_date,
      fixture_date_iso=COALESCE(excluded.fixture_date_iso, fixtures.fixture_date_iso),
      fixture_time=COALESCE(excluded.fixture_time, fixtures.fixture_time),
      status=CASE WHEN excluded.status = 'completed' THEN 'completed' ELSE fixtures.status END,
      home_score=COALESCE(excluded.home_score, fixtures.home_score),
      away_score=COALESCE(excluded.away_score, fixtures.away_score),
      scorers=COALESCE(excluded.scorers, fixtures.scorers),
      venue_name=COALESCE(excluded.venue_name, fixtures.venue_name),
      venue_url=COALESCE(excluded.venue_url, fixtures.venue_url),
      club_team_id=COALESCE(excluded.club_team_id, fixtures.club_team_id),
      club_side=COALESCE(excluded.club_side, fixtures.club_side),
      gms_fixture_uuid=COALESCE(excluded.gms_fixture_uuid, fixtures.gms_fixture_uuid),
      last_updated=excluded.last_updated
  `);
  let count = 0;
  for (const item of items) {
    // Wrapped per-item: a single bad row (e.g. a status value D1's CHECK
    // constraint rejects) used to throw out of this whole function, silently
    // dropping every other fixture already parsed in the same GMS response
    // along with it -- confirmed live when one team's entire 'results' call
    // (several real fixtures) was lost because just one of them had a
    // score. Now a bad row is skipped and logged; everything else still
    // gets written.
    try {
      await stmt.bind(
        item.fixture_id,
        item.comp_id ?? null,
        item.home_team_name,
        item.away_team_name,
        item.fixture_date,
        item.fixture_date_iso ?? null,
        item.fixture_time,
        item.status ?? 'scheduled',
        item.home_score ?? null,
        item.away_score ?? null,
        item.scorers ?? null,
        item.venue_name ?? null,
        item.venue_url ?? null,
        item.club_team_id ?? null,
        item.club_side ?? null,
        item.gms_fixture_uuid ?? null,
        now
      ).run();
      count++;
    } catch (err) {
      await logRun(env, 'upsert-fixture-error', null, null, 'error',
        `${item.fixture_id}: ${err.message}`, now);
    }
  }
  return count;
}

// Upserts the parsed output of parseFixtureDetail() for one fixture. detail
// is never null here (parseFixtureDetail always returns an object, even for
// the 'no_details' case) -- guarded anyway since this is called from a loop
// over live network results.
async function upsertFixtureDetail(env, fixtureId, gmsFixtureUuid, clubSide, detail, now) {
  if (!detail) return;
  await env.DB.prepare(`
    INSERT INTO fixture_details (
      fixture_id, gms_fixture_uuid, club_side, competition_name, venue_address, status,
      home_scorers_text, away_scorers_text, home_team_sheet, away_team_sheet,
      home_coaching_roles, away_coaching_roles, home_crest_url, away_crest_url,
      match_officials, eh_fixture_link, last_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fixture_id) DO UPDATE SET
      gms_fixture_uuid=excluded.gms_fixture_uuid,
      club_side=COALESCE(excluded.club_side, fixture_details.club_side),
      competition_name=excluded.competition_name,
      venue_address=excluded.venue_address,
      status=excluded.status,
      home_scorers_text=excluded.home_scorers_text,
      away_scorers_text=excluded.away_scorers_text,
      home_team_sheet=excluded.home_team_sheet,
      away_team_sheet=excluded.away_team_sheet,
      home_coaching_roles=excluded.home_coaching_roles,
      away_coaching_roles=excluded.away_coaching_roles,
      home_crest_url=excluded.home_crest_url,
      away_crest_url=excluded.away_crest_url,
      match_officials=excluded.match_officials,
      eh_fixture_link=excluded.eh_fixture_link,
      last_updated=excluded.last_updated
  `).bind(
    fixtureId, gmsFixtureUuid, clubSide ?? null, detail.competition_name, detail.venue_address, detail.status,
    detail.home_scorers_text, detail.away_scorers_text, detail.home_team_sheet, detail.away_team_sheet,
    detail.home_coaching_roles, detail.away_coaching_roles, detail.home_crest_url, detail.away_crest_url,
    detail.match_officials, detail.eh_fixture_link, now
  ).run();
}

async function upsertTeamItems(env, items, clubId, now) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  const stmt = env.DB.prepare(`
    INSERT INTO teams (team_id, club_id, comp_id, name, gender, eh_link, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(team_id) DO UPDATE SET
      club_id=excluded.club_id, comp_id=excluded.comp_id,
      name=excluded.name, gender=excluded.gender,
      eh_link=excluded.eh_link, last_updated=excluded.last_updated
  `);
  let count = 0;
  for (const item of items) {
    await stmt.bind(
      item.team_id, clubId,
      item.comp_id ?? null,
      item.name,
      item.gender,
      item.eh_link ?? null,
      now
    ).run();
    count++;
  }
  return count;
}

async function upsertCompetitions(env, items, now) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  const stmt = env.DB.prepare(`
    INSERT INTO competitions (comp_id, name, season, gender, division, last_updated)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(comp_id) DO UPDATE SET
      name=excluded.name, season=excluded.season, gender=excluded.gender,
      division=excluded.division, last_updated=excluded.last_updated
  `);
  let count = 0;
  for (const item of items) {
    await stmt.bind(item.comp_id, item.name, item.season ?? null, item.gender ?? null, null, now).run();
    count++;
  }
  return count;
}

// runCompetitionsStage already calls /api/competitions?team=<teamId> for
// every known team and gets back exactly which competition(s) that team
// plays in -- but until now that link was thrown away the moment
// upsertCompetitions() folded the results into the shared `competitions`
// table (comp_id, name, season, gender only -- no team). Recording it here
// instead is what lets resolveCompIdForTeamFixture() below answer "which
// competition is THIS fixture in" for fixtures the full-season
// runTeamFixturesStage() backfill discovers, which otherwise have no
// comp_id signal anywhere in GMS's own per-team response (see
// parseFixtureCardsForTeam's comment). Delete-then-insert per team on every
// run (same pattern as upsertStandings below) so a team that drops out of
// a competition between seasons doesn't leave a stale row behind.
async function upsertTeamCompetitions(env, teamId, items, now) {
  if (!teamId) return 0;
  await env.DB.prepare(`DELETE FROM team_competitions WHERE club_team_id = ?`).bind(teamId).run();
  if (!Array.isArray(items) || items.length === 0) return 0;
  const stmt = env.DB.prepare(`
    INSERT INTO team_competitions (club_team_id, comp_id, last_updated)
    VALUES (?, ?, ?)
    ON CONFLICT(club_team_id, comp_id) DO UPDATE SET last_updated=excluded.last_updated
  `);
  let count = 0;
  for (const item of items) {
    if (!item.comp_id) continue;
    await stmt.bind(teamId, item.comp_id, now).run();
    count++;
  }
  return count;
}

// Resolves which competition a team-scoped fixture belongs to, using the
// team_competitions link populated above. If the team is only known to
// play in one competition, that's the unambiguous answer -- the common
// case (one league division per team per season). If it plays in more than
// one (e.g. a league plus a cup), disambiguate by checking which of those
// competitions' standings table (populated by the 'leagues' stage) actually
// lists the opponent by name -- a team only appears in league_standings for
// competitions it's actually registered in. Returns null (leave the
// fixture's comp_id unresolved) rather than guess wrong when there are zero
// candidates, or more than one candidate whose standings both list the
// opponent.
async function resolveCompIdForTeamFixture(env, clubTeamId, opponentName) {
  if (!clubTeamId) return null;
  const { results: candidates } = await env.DB.prepare(
    `SELECT comp_id FROM team_competitions WHERE club_team_id = ?`
  ).bind(clubTeamId).all();
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].comp_id;

  const target = stripGenderSuffix(opponentName || '').toLowerCase();
  if (!target) return null;

  const matches = [];
  for (const { comp_id } of candidates) {
    const { results: standingRows } = await env.DB.prepare(
      `SELECT team_name FROM league_standings WHERE comp_id = ?`
    ).bind(comp_id).all();
    const found = (standingRows || []).some(
      r => stripGenderSuffix(r.team_name || '').toLowerCase() === target
    );
    if (found) matches.push(comp_id);
  }
  return matches.length === 1 ? matches[0] : null;
}

async function upsertStandings(env, compId, items, now) {
  if (!compId || !Array.isArray(items) || items.length === 0) return 0;
  await env.DB.prepare(`DELETE FROM league_standings WHERE comp_id = ?`).bind(compId).run();
  const stmt = env.DB.prepare(`
    INSERT INTO league_standings (
      comp_id, team_id, team_name, played, won, drawn, lost,
      goals_for, goals_against, goal_difference, points, position, last_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let count = 0;
  for (const item of items) {
    await stmt.bind(
      compId,
      item.team_id ?? null,
      item.team_name ?? null,
      item.played ?? null,
      item.won ?? null,
      item.drawn ?? null,
      item.lost ?? null,
      item.goals_for ?? null,
      item.goals_against ?? null,
      item.goal_difference ?? null,
      item.points ?? null,
      item.position ?? null,
      now
    ).run();
    count++;
  }
  return count;
}

// One-time cleanup for fixture rows that were already duplicated in D1
// before the fixture_id fix went in (see stripGenderSuffix comment above).
// Groups existing rows by (date, time, gender-stripped home, gender-stripped
// away) and, for each group with more than one row, converges them onto the
// ID today's scraper would actually compute for that match (canonicalId) --
// NOT just whichever row happens to have club_team_id set. That matters:
// if the survivor kept a legacy _m-suffixed ID, the very next scrape (which
// always computes the stripped/canonical ID now) would insert a fresh row
// under that canonical ID, recreating the duplicate all over again. Deletes
// the other row(s) in the group FIRST, then renames/updates the surviving
// row to the canonical ID with all groups' non-null fields merged in. Safe
// to run more than once: once every group's survivor already has its
// canonical ID, it's a no-op. Trigger by visiting this Worker's URL with
// ?stage=dedupe.
async function dedupeFixtures(env) {
  const now = new Date().toISOString();
  const { results: rows } = await env.DB.prepare(`SELECT * FROM fixtures`).all();

  const groups = new Map();
  for (const row of rows) {
    const strippedHome = stripGenderSuffix(row.home_team_name);
    const strippedAway = stripGenderSuffix(row.away_team_name);
    // Time is deliberately excluded from the key/canonicalId now: since the
    // scraper fix that lets played-match cards parse at all, the same real
    // match can show up with a kickoff time before it's played and a score
    // in that same slot afterward, and previously (when only kickoff-time
    // cards ever parsed successfully) a rescheduled kickoff time would also
    // have produced a phantom duplicate under the old time-inclusive ID.
    // Date + gender-stripped team names is a sufficient natural key: our
    // teams don't play the same opponent twice on one date.
    const canonicalId = slugify(`${row.fixture_date}_${strippedHome}_${strippedAway}`);
    const key = [row.fixture_date, strippedHome, strippedAway].join('|');
    if (!groups.has(key)) groups.set(key, { rows: [], canonicalId });
    groups.get(key).rows.push(row);
  }

  let mergedGroups = 0;
  let deletedRows = 0;
  const mergeFields = [
    'comp_id', 'club_team_id', 'club_side', 'venue_name', 'venue_url',
    'home_score', 'away_score', 'scorers', 'home_team_id', 'away_team_id',
    'venue_id', 'fixture_date_iso', 'fixture_time'
  ];

  for (const { rows: groupRows, canonicalId } of groups.values()) {
    if (groupRows.length < 2) continue;

    // Prefer a row that already has the canonical ID as the survivor;
    // otherwise fall back to the one with club_team_id set and rename it.
    let primary = groupRows.find(r => r.fixture_id === canonicalId);
    if (!primary) {
      const sorted = [...groupRows].sort((a, b) => (b.club_team_id ? 1 : 0) - (a.club_team_id ? 1 : 0));
      primary = sorted[0];
    }
    const originalPrimaryId = primary.fixture_id;
    const dupes = groupRows.filter(r => r.fixture_id !== originalPrimaryId);

    const merged = { ...primary };
    for (const dupe of dupes) {
      for (const field of mergeFields) {
        if (merged[field] == null && dupe[field] != null) merged[field] = dupe[field];
      }
      // Unlike the other fields, both rows will usually already have SOME
      // status ('scheduled' is the default), so plain "prefer non-null"
      // wouldn't ever let 'completed' win over a stale 'scheduled' -- prefer
      // it explicitly whichever row it came from.
      if (dupe.status === 'completed') merged.status = 'completed';
    }

    // Delete every other row in the group FIRST -- if one of them currently
    // holds the canonical ID, this frees it up before we rename the
    // survivor onto it, avoiding a uniqueness conflict on fixture_id.
    for (const dupe of dupes) {
      await env.DB.prepare(`DELETE FROM fixtures WHERE fixture_id = ?`).bind(dupe.fixture_id).run();
      deletedRows++;
    }

    await env.DB.prepare(`
      UPDATE fixtures SET
        fixture_id = ?, comp_id = ?, club_team_id = ?, club_side = ?, venue_name = ?, venue_url = ?,
        home_score = ?, away_score = ?, scorers = ?, home_team_id = ?, away_team_id = ?,
        venue_id = ?, fixture_date_iso = ?, fixture_time = ?, status = ?, last_updated = ?
      WHERE fixture_id = ?
    `).bind(
      canonicalId,
      merged.comp_id ?? null, merged.club_team_id ?? null, merged.club_side ?? null,
      merged.venue_name ?? null, merged.venue_url ?? null, merged.home_score ?? null,
      merged.away_score ?? null, merged.scorers ?? null, merged.home_team_id ?? null,
      merged.away_team_id ?? null, merged.venue_id ?? null, merged.fixture_date_iso ?? null,
      merged.fixture_time ?? null, merged.status ?? 'scheduled', now, originalPrimaryId
    ).run();

    mergedGroups++;
  }

  await logRun(env, 'dedupe', null, null, 'done', `merged ${mergedGroups} groups, deleted ${deletedRows} rows`, now);
  return { dedupe: { status: 'done', merged_groups: mergedGroups, deleted_rows: deletedRows } };
}

// One-time (but safe to re-run) fixer for fixtures that already existed
// with comp_id IS NULL before resolveCompIdForTeamFixture() went in above --
// almost entirely rows the team-fixtures full-season backfill discovered,
// since that's the one path with no comp_id signal from GMS at all. Needs
// team_competitions to actually have data in it first (run ?stage=
// competitions at least once after deploying this), or every row here will
// come back unresolved. Only touches rows still missing a comp_id; once one
// gets set (from this or the normal team-fixtures/leagues paths), it's left
// alone on every later run. Trigger by visiting this Worker's URL with
// ?stage=backfill-comp-ids.
async function backfillCompIds(env) {
  const now = new Date().toISOString();
  const { results: rows } = await env.DB.prepare(`
    SELECT fixture_id, club_team_id, club_side, home_team_name, away_team_name
    FROM fixtures
    WHERE comp_id IS NULL AND club_team_id IS NOT NULL
  `).all();

  let resolved = 0, unresolved = 0;
  for (const row of rows || []) {
    const opponentName = row.club_side === 'home' ? row.away_team_name : row.home_team_name;
    const compId = await resolveCompIdForTeamFixture(env, row.club_team_id, opponentName);
    if (compId) {
      await env.DB.prepare(`UPDATE fixtures SET comp_id = ?, last_updated = ? WHERE fixture_id = ?`)
        .bind(compId, now, row.fixture_id).run();
      resolved++;
    } else {
      unresolved++;
    }
  }

  await logRun(env, 'backfill-comp-ids', null, null, 'done',
    `resolved ${resolved}, unresolved ${unresolved} of ${rows ? rows.length : 0} candidates`, now);
  return { backfillCompIds: { status: 'done', resolved, unresolved, candidates: rows ? rows.length : 0 } };
}

// ---------------------------------------------------------------------------
// STAGES
// ---------------------------------------------------------------------------

async function runCoreStage(env) {
  const clubId = env.CLUB_ID;
  const now = new Date().toISOString();
  const summary = {};

  const showTypes = ['fixtures', 'results', 'teams'];
  for (let i = 0; i < showTypes.length; i++) {
    const showType = showTypes[i];
    if (i > 0) await sleep(CALL_GAP_MS);
    try {
      const data = await callGms(showType, { club_id: clubId });
      const items = showType === 'teams'
        ? parseTeamRows(data.html)
        : parseFixtureCards(data.html);
      const count = showType === 'teams'
        ? await upsertTeamItems(env, items, clubId, now)
        : await upsertFixtureItems(env, items, now);
      summary[showType] = { status: count > 0 ? 'success' : 'empty', rows: count };
      await logRun(env, showType, clubId, null, summary[showType].status, JSON.stringify(data).slice(0, 1900), now);
    } catch (err) {
      summary[showType] = { status: 'error', rows: 0 };
      await logRun(env, showType, clubId, null, 'error', err.message, now);
    }
  }

  await env.DB.prepare(`DELETE FROM scrape_log WHERE run_at < datetime('now', '-30 days')`).run();
  return summary;
}

async function runCompetitionsStage(env) {
  const now = new Date().toISOString();
  const { results: clubTeams } = await env.DB.prepare(
    `SELECT DISTINCT club_team_id FROM fixtures WHERE club_team_id IS NOT NULL`
  ).all();

  if (!clubTeams || clubTeams.length === 0) {
    await logRun(env, 'competitions', null, null, 'skipped', 'No club_team_id values yet', now);
    return { competitions: { status: 'skipped', rows: 0, teams: 0 } };
  }

  let compRows = 0;
  for (let i = 0; i < clubTeams.length; i++) {
    const teamId = clubTeams[i].club_team_id;
    if (i > 0) await sleep(CALL_GAP_MS);
    try {
      const data = await callGmsCompetitions(teamId);
      const items = parseCompetitionOptions(data.html);
      const rows = await upsertCompetitions(env, items, now);
      await upsertTeamCompetitions(env, teamId, items, now);
      compRows += rows;
      await logRun(env, 'competitions', null, null, rows > 0 ? 'success' : 'empty', JSON.stringify(data).slice(0, 1900), now);
    } catch (err) {
      await logRun(env, 'competitions', null, null, 'error', err.message, now);
    }
  }
  return { competitions: { status: 'done', rows: compRows, teams: clubTeams.length } };
}

// Full-season backfill for every team we've discovered a club_team_id for
// (that discovery still only happens via a data-team attribute turning up in
// a club-wide "next match day" card -- there's no direct team lookup GMS
// exposes, confirmed via a 404 on both a guessed /api/teams?club= endpoint
// and passing a plain name instead of a UUID to team=). Once a team IS
// known, though, this pulls its whole season in one shot rather than
// waiting weeks for "next match day" rotations to surface each fixture.
// Cheap enough to run daily rather than every 20 minutes: ~2 calls per known
// team, CALL_GAP_MS apart.
async function runTeamFixturesStage(env) {
  const now = new Date().toISOString();
  const { results: teamRows } = await env.DB.prepare(`
    SELECT club_team_id,
           CASE WHEN club_side = 'home' THEN home_team_name ELSE away_team_name END AS team_name
    FROM fixtures
    WHERE club_team_id IS NOT NULL
    GROUP BY club_team_id
  `).all();

  if (!teamRows || teamRows.length === 0) {
    await logRun(env, 'team-fixtures', null, null, 'skipped', 'No known club_team_id values yet', now);
    return { teamFixtures: { status: 'skipped', rows: 0, teams: 0 } };
  }

  let totalRows = 0;
  for (let i = 0; i < teamRows.length; i++) {
    const { club_team_id: teamId, team_name: teamName } = teamRows[i];
    // No extra gap here: the inner loop already sleeps CALL_GAP_MS after
    // EVERY call including the last one for this team, so that trailing
    // sleep already covers the gap before the next team's first call. This
    // used to also sleep here on top of that, doubling the gap between
    // teams to no benefit -- ~30s of dead time across 9 teams for nothing.
    for (const showType of ['fixtures', 'results']) {
      try {
        const data = await callGms(showType, { team: teamId });
        const items = parseFixtureCardsForTeam(data.html, teamName, teamId);
        // This is the one call in the whole pipeline that discovers fixtures
        // far outside GMS's own near-term "matchdays" window (see
        // resolveCompIdForTeamFixture's comment) -- so it's also the one
        // place comp_id has to be actively resolved rather than just passed
        // through, or these rows would sit with comp_id: null indefinitely.
        for (const item of items) {
          if (item.club_team_id === teamId && !item.comp_id) {
            const opponentName = item.club_side === 'home' ? item.away_team_name : item.home_team_name;
            item.comp_id = await resolveCompIdForTeamFixture(env, teamId, opponentName);
          }
        }
        const rows = await upsertFixtureItems(env, items, now);
        totalRows += rows;
        await logRun(env, `team-${showType}`, null, null, rows > 0 ? 'success' : 'empty', JSON.stringify(data).slice(0, 1900), now);
      } catch (err) {
        await logRun(env, `team-${showType}`, null, null, 'error', err.message, now);
      }
      await sleep(CALL_GAP_MS);
    }
  }
  return { teamFixtures: { status: 'done', rows: totalRows, teams: teamRows.length } };
}

async function runLeaguesStage(env) {
  const now = new Date().toISOString();
  const summary = {};
  const { results: comps } = await env.DB.prepare(
    `SELECT DISTINCT comp_id FROM competitions`
  ).all();

  // matchdays (called with comp_id only, no club_id) returns EVERY club's
  // fixtures in that competition, not just ours -- and unlike a club_id-
  // scoped call, GMS doesn't tag either side with data-team/gms-clubteam
  // here, so there's no per-card signal to tell "our" match apart from an
  // opponent-vs-opponent one in the same division. Left unfiltered this
  // bloated `fixtures` with matches we have no interest in. Scope it down
  // by matching against the `teams` table instead -- that's populated by
  // the club-scoped 'teams' show type (always called with club_id), so it's
  // a reliable list of Chelmsford's own team names independent of this
  // call. If it's empty (e.g. very first run, before a core-stage 'teams'
  // scrape has happened yet), skip filtering rather than risk silently
  // dropping every matchday fixture.
  const { results: ownTeamRows } = await env.DB.prepare(`SELECT name FROM teams`).all();
  const ownTeamNames = new Set(
    (ownTeamRows || []).map(r => stripGenderSuffix(r.name).toLowerCase())
  );

  for (const showType of ['league', 'matchdays']) {
    if (!comps || comps.length === 0) {
      summary[showType] = { status: 'skipped', rows: 0, competitions: 0 };
      await logRun(env, showType, null, null, 'skipped', 'No known competition IDs yet', now);
      continue;
    }
    let totalRows = 0;
    for (let i = 0; i < comps.length; i++) {
      const compId = comps[i].comp_id;
      if (i > 0) await sleep(CALL_GAP_MS);
      try {
        const data = await callGms(showType, { comp_id: compId });
        let count;
        if (showType === 'league') {
          const items = parseStandingsRows(data.html);
          count = await upsertStandings(env, compId, items, now);
        } else {
          const allItems = parseFixtureCards(data.html).map(item => ({ ...item, comp_id: compId }));
          const items = ownTeamNames.size > 0
            ? allItems.filter(item => {
                const home = stripGenderSuffix(item.home_team_name || '').toLowerCase();
                const away = stripGenderSuffix(item.away_team_name || '').toLowerCase();
                return ownTeamNames.has(home) || ownTeamNames.has(away);
              })
            : allItems;
          count = await upsertFixtureItems(env, items, now);
        }
        totalRows += count;
        await logRun(env, showType, null, compId, count > 0 ? 'success' : 'empty', JSON.stringify(data).slice(0, 1900), now);
      } catch (err) {
        await logRun(env, showType, null, compId, 'error', err.message, now);
      }
    }
    summary[showType] = { status: 'done', rows: totalRows, competitions: comps.length };
    await sleep(CALL_GAP_MS);
  }
  return summary;
}

// Backfills the "Show Detail" click-through data (scorers, team sheets,
// coaching roles, match officials) for known fixtures. Only fixtures we
// already have a GMS UUID for (via CARD_RE picking up data-fixture, now that
// showDetail:yes is on every call) and within a rolling window are
// considered -- there's no value polling matches from months ago, and
// upcoming fixtures rarely have anything filled in far in advance. A fixture
// already marked 'has_details' is never re-fetched (once scorers/team sheets
// are in, GMS doesn't seem to change them); a 'no_details' one is re-checked
// at most once a day, in case officials/team sheets get added closer to or
// after the match.
const DETAIL_RECHECK_MS = 24 * 60 * 60 * 1000;

async function runFixtureDetailsStage(env) {
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const clubId = env.CLUB_ID;

  const { results: candidates } = await env.DB.prepare(`
    SELECT f.fixture_id, f.gms_fixture_uuid, f.club_side, d.status, d.last_updated
    FROM fixtures f
    LEFT JOIN fixture_details d ON d.fixture_id = f.fixture_id
    WHERE f.gms_fixture_uuid IS NOT NULL
      AND f.fixture_date_iso IS NOT NULL
      AND f.fixture_date_iso BETWEEN date('now', '-30 days') AND date('now', '+14 days')
  `).all();

  let fetched = 0, skipped = 0, errored = 0;
  let isFirstCall = true;

  for (const row of candidates || []) {
    if (row.status === 'has_details') { skipped++; continue; }
    if (row.status === 'no_details' && row.last_updated && (nowMs - Date.parse(row.last_updated)) < DETAIL_RECHECK_MS) {
      skipped++;
      continue;
    }
    if (!isFirstCall) await sleep(CALL_GAP_MS);
    isFirstCall = false;
    try {
      const data = await callGmsFixtureDetail(row.gms_fixture_uuid, clubId);
      const detail = parseFixtureDetail(data.html);
      // row.club_side ('home'/'away'/null) tags which side of the detail
      // response is *our* team, so gms-api can hand back a club-vs-opponent
      // view without every caller having to know or look up home/away.
      await upsertFixtureDetail(env, row.fixture_id, row.gms_fixture_uuid, row.club_side, detail, now);
      fetched++;
    } catch (err) {
      errored++;
      await logRun(env, 'fixture-details', clubId, null, 'error', `${row.fixture_id}: ${err.message}`, now);
    }
  }

  await logRun(env, 'fixture-details', clubId, null, 'done',
    `fetched ${fetched}, skipped ${skipped}, errored ${errored} of ${candidates ? candidates.length : 0} candidates`, now);
  return { fixtureDetails: { status: 'done', fetched, skipped, errored, candidates: candidates ? candidates.length : 0 } };
}

// A stage's own CALL_GAP_MS spacing only protects against a SINGLE
// invocation calling GMS too fast -- it does nothing if two invocations of
// the same stage are running at once (e.g. the daily team-fixtures cron
// firing at the same time as a manual ?stage=team-fixtures trigger, which
// is exactly what happened on 2026-09-18: both ran concurrently, doubling
// the real call rate to GMS and triggering a run of "Too Many Attempts"
// 429s that looked like the Worker had hung). This is a simple D1-backed
// advisory lock, one row per stage, to stop that specific failure mode.
const LOCK_MAX_AGE_MS = 10 * 60 * 1000; // stages normally finish in 1-2 min; a lock older than this is treated as abandoned (e.g. the isolate got killed mid-run) rather than blocking forever.

async function acquireLock(env, stage, maxAgeMs) {
  const now = new Date();
  const nowIso = now.toISOString();
  // Atomic fast path: if no lock row exists yet, this INSERT creates it;
  // if one does, ON CONFLICT DO NOTHING leaves it untouched. Either way we
  // then read the row back and compare its locked_at to the timestamp we
  // just tried to write: an exact match means our INSERT is the one that
  // actually landed (nobody else held the lock), and a mismatch means an
  // existing lock won instead. This avoids relying on D1's .run() result
  // shape (e.g. meta.changes) to tell the two cases apart -- getting that
  // field wrong previously meant a freshly-created lock could be mistaken
  // for someone else's and never get released, wedging the stage locked
  // until the 10-minute staleness window passed.
  await env.DB.prepare(`
    INSERT INTO stage_locks (stage, locked_at) VALUES (?, ?)
    ON CONFLICT(stage) DO NOTHING
  `).bind(stage, nowIso).run();

  const row = await env.DB.prepare(`SELECT locked_at FROM stage_locks WHERE stage = ?`).bind(stage).first();
  if (!row) return false; // shouldn't happen, but don't crash the stage over it
  if (row.locked_at === nowIso) return true; // our INSERT won

  // Someone else's lock row already existed. Only steal it if it looks
  // abandoned -- this narrow path does have a small race window, but it
  // only matters for recovering a genuinely stuck lock, not the normal
  // case this is meant to prevent.
  if ((now.getTime() - new Date(row.locked_at).getTime()) > maxAgeMs) {
    await env.DB.prepare(`UPDATE stage_locks SET locked_at = ? WHERE stage = ?`).bind(nowIso, stage).run();
    return true;
  }
  return false;
}

async function releaseLock(env, stage) {
  await env.DB.prepare(`DELETE FROM stage_locks WHERE stage = ?`).bind(stage).run();
}

async function runStage(env, stage) {
  const acquired = await acquireLock(env, stage, LOCK_MAX_AGE_MS);
  if (!acquired) {
    await logRun(env, stage, null, null, 'skipped',
      'Stage already running elsewhere (locked) -- skipped to avoid doubling up GMS calls',
      new Date().toISOString());
    return { [stage]: { status: 'skipped', reason: 'already running (locked)' } };
  }
  try {
    if (stage === 'competitions') return await runCompetitionsStage(env);
    if (stage === 'leagues') return await runLeaguesStage(env);
    if (stage === 'team-fixtures') return await runTeamFixturesStage(env);
    if (stage === 'fixture-details') return await runFixtureDetailsStage(env);
    if (stage === 'dedupe') return await dedupeFixtures(env);
    if (stage === 'backfill-comp-ids') return await backfillCompIds(env);
    return await runCoreStage(env);
  } finally {
    await releaseLock(env, stage);
  }
}
