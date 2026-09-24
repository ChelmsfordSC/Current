ALTER TABLE fixtures ADD COLUMN gms_fixture_uuid TEXT;

CREATE TABLE fixture_details (
  fixture_id TEXT PRIMARY KEY,
  gms_fixture_uuid TEXT,
  competition_name TEXT,
  venue_address TEXT,
  status TEXT NOT NULL DEFAULT 'no_details',
  home_scorers_text TEXT,
  away_scorers_text TEXT,
  home_team_sheet TEXT,
  away_team_sheet TEXT,
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
