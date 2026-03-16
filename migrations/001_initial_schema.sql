-- Zamindar Initial Schema Migration
-- Run in: Supabase Dashboard > SQL Editor

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    strava_id BIGINT UNIQUE NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at TIMESTAMPTZ,
    total_distance_km NUMERIC DEFAULT 0,
    zones_owned INTEGER DEFAULT 0,
    primary_city_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );

CREATE TABLE IF NOT EXISTS cities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    state TEXT,
    lat NUMERIC NOT NULL,
    lng NUMERIC NOT NULL,
    capture_radius_km NUMERIC DEFAULT 15,
    zone_size_km NUMERIC DEFAULT 0.5,
    multiplier NUMERIC DEFAULT 1.0,
    geom GEOMETRY(Point, 4326),
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

CREATE TABLE IF NOT EXISTS runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    strava_activity_id TEXT UNIQUE,
    polyline TEXT,
    distance_km NUMERIC,
    duration_sec INTEGER,
    city_id UUID REFERENCES cities(id),
    zones_claimed INTEGER DEFAULT 0,
    zones_defended INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

CREATE TABLE IF NOT EXISTS zone_conflicts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zone_id TEXT NOT NULL,
    challenger_id UUID REFERENCES users(id),
    defender_id UUID REFERENCES users(id),
    challenger_km NUMERIC,
    defender_km NUMERIC,
    status TEXT DEFAULT 'active',
    winner_id UUID REFERENCES users(id),
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_runs_user_id ON runs(user_id);
CREATE INDEX IF NOT EXISTS idx_runs_city_id ON runs(city_id);
CREATE INDEX IF NOT EXISTS idx_zone_conflicts_zone_id ON zone_conflicts(zone_id);
CREATE INDEX IF NOT EXISTS idx_cities_geom ON cities USING GIST(geom);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE zone_conflicts ENABLE ROW LEVEL SECURITY;
