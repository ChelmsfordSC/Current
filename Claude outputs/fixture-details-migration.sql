-- Adds support for the "Show Detail" click-through data (scorers, team
-- sheets, coaching roles, match officials) confirmed live against
-- gmsfeed.co.uk on 2026-09-18. Run this once against the gms-data D1
-- database (Cloudflare dashboard > D1 > gms-data > Console) before deploying
-- the updated gms-scraper/gms-api code.

-- GMS's own internal fixture UUID (distinct from our slugified fixture_id),
-- needed to key the per-fixture detail lookup. Populated going forward as
-- fixtures/results/matchdays get (re-)scraped with showDetail:yes on.
ALTER TABLE fixtures ADD COLUMN gms_fixture_uuid TEXT;

CREATE TABLE fixture_details (
  fixture_id TEXT PRIMARY KEY,
  gms_fixture_uuid TEXT,
  competition_name TEXT,
  venue_address TEXT,
  -- 'no_details' when GMS returns "No more details available" (e.g. an
  -- upcoming fixture with nothing entered yet); 'has_details' once scorers/
  -- team sheets/etc are actually present.
  status TEXT NOT NULL DEFAULT 'no_details',
  home_scorers_text TEXT,
  away_scorers_text TEXT,
  -- JSON arrays -- see parseFixtureDetail()/parsePlayerLi() in gms-scraper
  -- for the exact shape (squad_number, name, is_captain, is_goalkeeper,
  -- tag, goals[], withheld/count for redacted entries).
  home_team_sheet TEXT,
  away_team_sheet TEXT,
  -- JSON arrays of {role, name}
  home_coaching_roles TEXT,
  away_coaching_roles TEXT,
  match_officials TEXT,
  home_crest_url TEXT,
  away_crest_url TEXT,
  eh_fixture_link TEXT,
  last_updated TEXT,
  FOREIGN KEY (fixture_id) REFERENCES fixtures(fixture_id)
);

CREATE INDEX idx_fixture_details_status ON fixture_details(status);
