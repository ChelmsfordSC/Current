-- Migration: add team_competitions table
-- Run this once in the D1 console against the gms-data database,
-- BEFORE deploying the updated gms-scraper code.
--
-- This table records which competition(s) each team is known to play in,
-- based on GMS's own /api/competitions?team=<teamId> response (already
-- fetched daily by the 'competitions' stage -- this just keeps the
-- team -> comp_id link that was previously being discarded).
--
-- It's what lets the scraper resolve comp_id for fixtures discovered by
-- the full-season team-fixtures backfill, which otherwise have no
-- comp_id signal in GMS's own response at all.

CREATE TABLE IF NOT EXISTS team_competitions (
  club_team_id TEXT NOT NULL,
  comp_id      TEXT NOT NULL,
  last_updated TEXT NOT NULL,
  PRIMARY KEY (club_team_id, comp_id)
);
