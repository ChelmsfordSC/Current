const ALLOWED_ORIGINS = [
  'https://www.chelmsfordsc.org.uk',
  'https://chelmsfordsc.org.uk',
  'https://csc-display.github.io'
];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const corsHeaders = buildCorsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    const apiKey = request.headers.get('X-API-Key');
    if (apiKey !== env.API_KEY) return json({ error: 'Unauthorized' }, 401, corsHeaders);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (await isRateLimited(env, ip)) return json({ error: 'Too many requests' }, 429, corsHeaders);

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/today') {
        // fixture_date is stored as GMS renders it ("12 Sep 2026"), which
        // doesn't compare equal to an ISO date string -- this was silently
        // never matching anything before fixture_date_iso existed.
        const today = new Date().toISOString().slice(0, 10);
        const { results } = await env.DB.prepare(
          `SELECT * FROM fixtures WHERE fixture_date_iso = ? ORDER BY fixture_time`
        ).bind(today).all();
        return json({ fixtures: results }, 200, corsHeaders);
      }
      if (path === '/api/fixtures') {
        // Same underlying issue: ORDER BY fixture_date on the raw "DD Mon
        // YYYY" text sorts alphabetically, not chronologically. Rows from
        // before the fixture_date_iso backfill (which happens naturally as
        // each fixture gets re-scraped) sort first since NULL is treated as
        // smallest -- self-corrects within a day of the scraper deploy.
        //
        // Optional filters, all combinable with AND: ?team=<club_team_id>,
        // ?comp_id=<comp_id>, ?from=<YYYY-MM-DD>, ?to=<YYYY-MM-DD> (both
        // compared against fixture_date_iso, inclusive). All are bound
        // params, so a malformed value just matches nothing rather than
        // erroring.
        const team = url.searchParams.get('team');
        const compId = url.searchParams.get('comp_id');
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');

        const conditions = [];
        const binds = [];
        if (team) { conditions.push('club_team_id = ?'); binds.push(team); }
        if (compId) { conditions.push('comp_id = ?'); binds.push(compId); }
        if (from) { conditions.push('fixture_date_iso >= ?'); binds.push(from); }
        if (to) { conditions.push('fixture_date_iso <= ?'); binds.push(to); }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const { results } = await env.DB.prepare(
          `SELECT * FROM fixtures ${where} ORDER BY fixture_date_iso, fixture_time`
        ).bind(...binds).all();
        return json({ fixtures: results }, 200, corsHeaders);
      }
      if (path.startsWith('/api/fixtures/') && path.endsWith('/details')) {
        // Scorers, team sheets, coaching roles and match officials --
        // populated by gms-scraper's separate 'fixture-details' stage, which
        // only covers a rolling window of fixtures (roughly the last month
        // to the next fortnight) and only once GMS itself has something to
        // show, so this is commonly 'not found' or status:'no_details' for
        // a fixture outside that window or with nothing entered yet.
        const id = decodeURIComponent(path.slice('/api/fixtures/'.length, -'/details'.length));
        const row = await env.DB.prepare(`SELECT * FROM fixture_details WHERE fixture_id = ?`).bind(id).first();
        if (!row) return json({ error: 'Not found' }, 404, corsHeaders);
        return json({
          ...row,
          // Stored as JSON text (see gms-scraper's parseFixtureDetail) --
          // parsed back out here so callers get real nested JSON rather than
          // a JSON string inside JSON.
          home_team_sheet: row.home_team_sheet ? JSON.parse(row.home_team_sheet) : null,
          away_team_sheet: row.away_team_sheet ? JSON.parse(row.away_team_sheet) : null,
          home_coaching_roles: row.home_coaching_roles ? JSON.parse(row.home_coaching_roles) : null,
          away_coaching_roles: row.away_coaching_roles ? JSON.parse(row.away_coaching_roles) : null,
          match_officials: row.match_officials ? JSON.parse(row.match_officials) : null
        }, 200, corsHeaders);
      }
      if (path.startsWith('/api/fixtures/')) {
        const id = path.split('/').pop();
        const row = await env.DB.prepare(`SELECT * FROM fixtures WHERE fixture_id = ?`).bind(id).first();
        if (!row) return json({ error: 'Not found' }, 404, corsHeaders);
        return json(row, 200, corsHeaders);
      }
      if (path === '/api/teams') {
        // Self-serve list of Chelmsford's own teams as the pipeline
        // currently knows them -- club_team_id only ever gets discovered
        // via a data-team attribute turning up in a club-wide or
        // competition-scoped fixtures/matchdays card, so this reads that
        // discovery straight out of `fixtures` rather than the separate
        // `teams` table (which uses its own name+gender natural key and
        // doesn't carry GMS's club_team_id at all).
        const { results } = await env.DB.prepare(`
          SELECT club_team_id,
                 (CASE WHEN club_side = 'home' THEN home_team_name ELSE away_team_name END) AS team_name,
                 COUNT(*) AS fixture_count,
                 MAX(fixture_date_iso) AS last_seen
          FROM fixtures
          WHERE club_team_id IS NOT NULL
          GROUP BY club_team_id
          ORDER BY team_name
        `).all();
        return json({ teams: results }, 200, corsHeaders);
      }
      if (path === '/api/leagues') {
        // Self-serve lookup so callers can find a comp_id by name instead of
        // emailing us for one. Only lists leagues gms-scraper has actually
        // seen one of our own teams playing in (populated by the
        // 'competitions' stage from real club_team_id values in fixtures),
        // so it naturally stays scoped to leagues relevant to this club.
        const search = url.searchParams.get('search');
        let query = `SELECT comp_id, name, season, gender FROM competitions`;
        const stmt = search
          ? env.DB.prepare(`${query} WHERE name LIKE ? ORDER BY name`).bind(`%${search}%`)
          : env.DB.prepare(`${query} ORDER BY name`);
        const { results } = await stmt.all();
        return json({ leagues: results }, 200, corsHeaders);
      }
      if (path.startsWith('/api/leagues/')) {
        // Direct lookup once a caller already has a comp_id cached, so they
        // don't have to re-search by name just to refresh one competition's
        // details.
        const compId = decodeURIComponent(path.slice('/api/leagues/'.length));
        const row = await env.DB.prepare(
          `SELECT comp_id, name, season, gender FROM competitions WHERE comp_id = ?`
        ).bind(compId).first();
        if (!row) return json({ error: 'Not found' }, 404, corsHeaders);
        return json(row, 200, corsHeaders);
      }
      if (path === '/api/standings') {
        const compId = url.searchParams.get('comp_id');
        const { results } = await env.DB.prepare(
          `SELECT * FROM league_standings WHERE comp_id = ? ORDER BY position`
        ).bind(compId).all();
        return json({ standings: results }, 200, corsHeaders);
      }
      if (path === '/api/status/history') {
        // Optional ?limit= (default 20, capped at 100) so a caller can spot
        // patterns -- like a cluster of 429s -- without going into D1
        // directly.
        const limitParam = parseInt(url.searchParams.get('limit') || '20', 10);
        const limit = Math.min(Math.max(Number.isNaN(limitParam) ? 20 : limitParam, 1), 100);
        const { results } = await env.DB.prepare(
          `SELECT * FROM scrape_log ORDER BY id DESC LIMIT ?`
        ).bind(limit).all();
        return json({ history: results }, 200, corsHeaders);
      }
      if (path === '/api/status') {
        const row = await env.DB.prepare(`SELECT * FROM scrape_log ORDER BY id DESC LIMIT 1`).first();
        return json({ last_scrape: row }, 200, corsHeaders);
      }
      return json({ error: 'Not found' }, 404, corsHeaders);
    } catch (err) {
      return json({ error: 'Server error', message: err.message }, 500, corsHeaders);
    }
  }
};

function buildCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'X-API-Key, Content-Type',
    'Content-Type': 'application/json'
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}

async function isRateLimited(env, ip) {
  const key = `rl:${ip}`;
  const current = await env.RATE_LIMIT.get(key);
  const count = current ? parseInt(current, 10) : 0;
  if (count >= 60) return true;
  await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: 60 });
  return false;
}
