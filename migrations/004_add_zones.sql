-- Zamindar Zones Migration
-- "My run is my area" — no grids, your run polygon IS your territory
-- Run in: Supabase Dashboard > SQL Editor (after 001, 002, 003)

-- ─── ZONES TABLE ────────────────────────────────────────────────────────────
-- Each zone is a territory polygon created from a single run.
-- The runner's buffered route polyline becomes the zone geometry.
-- Overlaps between zones are computed dynamically via PostGIS.

CREATE TABLE IF NOT EXISTS zones (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  run_id        UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  city_id       UUID REFERENCES cities(id),

  -- The actual territory polygon (buffered convex hull of the run route)
  geom          GEOMETRY(Polygon, 4326) NOT NULL,
  area_m2       NUMERIC NOT NULL DEFAULT 0,

  -- Ownership state
  is_active     BOOLEAN DEFAULT true,
  control_score INTEGER DEFAULT 100 CHECK (control_score BETWEEN 0 AND 100),
  expires_at    TIMESTAMPTZ,

  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Spatial index — the workhorse for all overlap/bbox queries
CREATE INDEX IF NOT EXISTS idx_zones_geom ON zones USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_zones_user_id ON zones(user_id);
CREATE INDEX IF NOT EXISTS idx_zones_city_id ON zones(city_id);
CREATE INDEX IF NOT EXISTS idx_zones_run_id ON zones(run_id);
CREATE INDEX IF NOT EXISTS idx_zones_active ON zones(is_active) WHERE is_active = true;

-- ─── ZONE OVERLAPS TABLE ────────────────────────────────────────────────────
-- Materialised record of where two zones intersect.
-- Created when a new zone overlaps an existing one.
-- The overlap geometry is the ST_Intersection of both zone polygons.

CREATE TABLE IF NOT EXISTS zone_overlaps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_a_id       UUID NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  zone_b_id       UUID NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  overlap_geom    GEOMETRY(Polygon, 4326),
  overlap_area_m2 NUMERIC DEFAULT 0,

  -- Who currently controls the overlapping region
  -- NULL = genuinely contested (neither side dominant)
  resolved_owner_id UUID REFERENCES users(id),
  score_a         INTEGER DEFAULT 50,
  score_b         INTEGER DEFAULT 50,

  status          TEXT DEFAULT 'contested' CHECK (status IN ('contested', 'resolved', 'expired')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),

  -- Prevent duplicate overlap records for the same pair
  UNIQUE (zone_a_id, zone_b_id)
);

CREATE INDEX IF NOT EXISTS idx_zone_overlaps_zone_a ON zone_overlaps(zone_a_id);
CREATE INDEX IF NOT EXISTS idx_zone_overlaps_zone_b ON zone_overlaps(zone_b_id);
CREATE INDEX IF NOT EXISTS idx_zone_overlaps_geom ON zone_overlaps USING GIST(overlap_geom);

-- ─── ZONE HISTORY TABLE ────────────────────────────────────────────────────
-- Every ownership event for the activity feed and leaderboards.

CREATE TABLE IF NOT EXISTS zone_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id       UUID NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id),
  run_id        UUID REFERENCES runs(id),
  event_type    TEXT NOT NULL CHECK (event_type IN ('claimed', 'defended', 'captured', 'expired', 'decayed')),
  area_m2       NUMERIC DEFAULT 0,
  city_id       UUID REFERENCES cities(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zone_history_user_id ON zone_history(user_id);
CREATE INDEX IF NOT EXISTS idx_zone_history_zone_id ON zone_history(zone_id);
CREATE INDEX IF NOT EXISTS idx_zone_history_created ON zone_history(created_at DESC);

-- ─── CITY COVERAGE TRACKING ────────────────────────────────────────────────
-- Tracks how much area each user owns within a city's capture radius.
-- City capture threshold: own 20% of city area → individual capture.
-- Team goal: collectively reach 50% to "liberate" the city.

CREATE TABLE IF NOT EXISTS city_coverage (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id       UUID NOT NULL REFERENCES cities(id),
  user_id       UUID NOT NULL REFERENCES users(id),
  covered_area_m2 NUMERIC DEFAULT 0,
  zone_count    INTEGER DEFAULT 0,
  last_run_at   TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (city_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_city_coverage_city ON city_coverage(city_id);

-- ─── ADD city_area_m2 TO CITIES ─────────────────────────────────────────────
-- Total area of the city (within capture_radius_km) for percentage calculations.

ALTER TABLE cities ADD COLUMN IF NOT EXISTS city_area_m2 NUMERIC;

-- Compute city areas from capture_radius_km (circle area = pi * r^2)
UPDATE cities SET city_area_m2 = PI() * POWER(capture_radius_km * 1000, 2);

-- ─── ADD capture_threshold + captured_by TO CITIES ──────────────────────────

ALTER TABLE cities ADD COLUMN IF NOT EXISTS capture_threshold NUMERIC DEFAULT 0.20;
ALTER TABLE cities ADD COLUMN IF NOT EXISTS captured_by UUID REFERENCES users(id);
ALTER TABLE cities ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ;
ALTER TABLE cities ADD COLUMN IF NOT EXISTS total_covered_m2 NUMERIC DEFAULT 0;

-- ─── ADD polyline_geom TO RUNS ──────────────────────────────────────────────
-- Store the decoded route as a PostGIS LineString for spatial queries.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS route_geom GEOMETRY(LineString, 4326);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS area_m2 NUMERIC;

CREATE INDEX IF NOT EXISTS idx_runs_route_geom ON runs USING GIST(route_geom);

-- ─── UPDATE users TABLE ─────────────────────────────────────────────────────

ALTER TABLE users ADD COLUMN IF NOT EXISTS total_area_m2 NUMERIC DEFAULT 0;

-- ─── RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE zone_overlaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE zone_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE city_coverage ENABLE ROW LEVEL SECURITY;

-- ─── HELPER FUNCTION: compute zone polygon from a run's polyline ────────────
-- Takes a LineString and buffers it to create the territory polygon.
-- Buffer = 30m gives the route a ~60m wide territory band.

CREATE OR REPLACE FUNCTION compute_zone_polygon(route GEOMETRY, buffer_m NUMERIC DEFAULT 30)
RETURNS GEOMETRY AS $$
  SELECT ST_ConvexHull(
    ST_Buffer(route::geography, buffer_m)::geometry
  );
$$ LANGUAGE sql IMMUTABLE;

-- ─── HELPER FUNCTION: find overlapping active zones ─────────────────────────

CREATE OR REPLACE FUNCTION find_overlapping_zones(new_zone_geom GEOMETRY, exclude_user UUID)
RETURNS TABLE(
  zone_id UUID,
  owner_id UUID,
  overlap_geom GEOMETRY,
  overlap_area_m2 NUMERIC
) AS $$
  SELECT
    z.id AS zone_id,
    z.user_id AS owner_id,
    ST_Intersection(z.geom, new_zone_geom) AS overlap_geom,
    ST_Area(ST_Intersection(z.geom, new_zone_geom)::geography) AS overlap_area_m2
  FROM zones z
  WHERE z.is_active = true
    AND z.user_id != exclude_user
    AND ST_Intersects(z.geom, new_zone_geom)
    AND ST_Area(ST_Intersection(z.geom, new_zone_geom)::geography) > 10
  ORDER BY overlap_area_m2 DESC;
$$ LANGUAGE sql STABLE;

-- ─── HELPER FUNCTION: get user's total area in a city ───────────────────────

CREATE OR REPLACE FUNCTION get_user_city_area(p_user_id UUID, p_city_id UUID)
RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(
    ST_Area(
      ST_Intersection(
        z.geom,
        ST_Buffer(c.geom::geography, c.capture_radius_km * 1000)::geometry
      )::geography
    )
  ), 0)
  FROM zones z
  JOIN cities c ON c.id = p_city_id
  WHERE z.user_id = p_user_id
    AND z.is_active = true
    AND ST_Intersects(z.geom, ST_Buffer(c.geom::geography, c.capture_radius_km * 1000)::geometry);
$$ LANGUAGE sql STABLE;
