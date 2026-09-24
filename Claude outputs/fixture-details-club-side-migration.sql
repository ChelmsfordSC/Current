ALTER TABLE fixture_details ADD COLUMN club_side TEXT;

UPDATE fixture_details SET club_side = (SELECT f.club_side FROM fixtures f WHERE f.fixture_id = fixture_details.fixture_id) WHERE club_side IS NULL;
