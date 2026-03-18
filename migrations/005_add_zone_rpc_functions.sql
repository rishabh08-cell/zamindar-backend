-- Zamindar Migration 005: Add RPC functions for territory engine
-- Run in: Supabase Dashboard > SQL Editor (after 001-004)
--
-- These functions are called by stravaProcessor.js to compute
-- territory polygons and find spatial data.

-- ─── 1. COMPUTE ZONE POLYGON FROM GEOJSON ────────────────────────────────
-- Called by stravaProcessor when a new run is processed.
-- Takes a GeoJSON LineString route + buffer distance, returns:
--   - polygon: GeoJSON Polygon (buffered convex hull)
--   - area_m2: area in square metres
--
-- This wraps the compute_zone_polygon function from 004 but accepts
-- GeoJSON text input and returns GeoJSON + area together.

CREATE OR REPLACE FUNCTION compute_zone_polygon_from_geojson(
      p_route_geojson TEXT,
      p_buffer_m NUMERIC DEFAULT 30
  )
RETURNS JSON AS $$
DECLARE
    route_geom GEOMETRY;
    zone_geom GEOMETRY;
    zone_area NUMERIC;
BEGIN
    -- Parse GeoJSON to geometry
    route_geom := ST_GeomFromGeoJSON(p_route_geojson);

    -- Compute buffered convex hull
    -- Buffer the route by p_buffer_m metres (using geography for accurate distance)
    -- Then take convex hull to fill in the enclosed area
    zone_geom := ST_ConvexHull(
              ST_Buffer(route_geom::geography, p_buffer_m)::geometry
          );

    -- Compute area in square metres (using geography for accuracy)
    zone_area := ST_Area(zone_geom::geography);

    -- Return as JSON with both polygon GeoJSON and area
    RETURN json_build_object(
              'polygon', ST_AsGeoJSON(zone_geom)::json,
              'area_m2', ROUND(zone_area)
          );
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- ─── 2. GET ZONES IN BOUNDING BOX ───────────────────────────────────────
-- Called by the map API to fetch zones visible in the viewport.
-- Returns zones with their GeoJSON geometry and user info.

CREATE OR REPLACE FUNCTION get_zones_in_bbox(
      p_bbox TEXT,
      p_active_only BOOLEAN DEFAULT true
  )
RETURNS TABLE(
      id UUID,
      user_id UUID,
      run_id UUID,
      city_id UUID,
      geom JSON,
      area_m2 NUMERIC,
      is_active BOOLEAN,
      control_score INTEGER,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ,
      display_name TEXT,
      avatar_url TEXT
  ) AS $$
BEGIN
    RETURN QUERY
    SELECT
        z.id,
        z.user_id,
        z.run_id,
        z.city_id,
        ST_AsGeoJSON(z.geom)::json AS geom,
        z.area_m2,
        z.is_active,
        z.control_score,
        z.expires_at,
        z.created_at,
        u.display_name,
        u.avatar_url
    FROM zones z
    JOIN users u ON u.id = z.user_id
    WHERE ST_Intersects(z.geom, ST_GeomFromEWKT(p_bbox))
    AND (NOT p_active_only OR z.is_active = true)
    ORDER BY z.created_at DESC
    LIMIT 500;
END;
$$ LANGUAGE plpgsql STABLE;


-- ─── 3. FIND NEAREST CITY ───────────────────────────────────────────────
-- Called by cities.js findCityByLocation.
-- Returns the nearest city within capture_radius_km.

CREATE OR REPLACE FUNCTION find_nearest_city(
      lat NUMERIC,
      lng NUMERIC
  )
RETURNS TABLE(
      id UUID,
      name TEXT,
      state TEXT,
      city_lat NUMERIC,
      city_lng NUMERIC,
      capture_radius_km NUMERIC,
      distance_km NUMERIC
  ) AS $$
BEGIN
    RETURN QUERY
    SELECT
        c.id,
        c.name,
        c.state,
        c.lat AS city_lat,
        c.lng AS city_lng,
        c.capture_radius_km,
        (ST_Distance(
              ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
              ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326)::geography
          ) / 1000.0) AS distance_km
    FROM cities c
    WHERE ST_DWithin(
          ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
          ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326)::geography,
          c.capture_radius_km * 1000  -- convert km to metres for ST_DWithin
    )
    ORDER BY distance_km ASC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE;


-- ─── 4. ADD 'contested' TO zone_history EVENT TYPES ─────────────────────
-- The original CHECK constraint only allows:
--   'claimed', 'defended', 'captured', 'expired', 'decayed'
-- We need 'contested' for when another runner overlaps your zone.

ALTER TABLE zone_history 
    DROP CONSTRAINT IF EXISTS zone_history_event_type_check;

ALTER TABLE zone_history 
    ADD CONSTRAINT zone_history_event_type_check 
    CHECK (event_type IN ('claimed', 'defended', 'captured', 'expired', 'decayed', 'contested'));


-- ─── 5. CREATE RPC-CALLABLE VERSION OF create_zone ──────────────────────
-- The zones.js createZone function tries this RPC first for atomic
-- insert + geometry handling.

CREATE OR REPLACE FUNCTION create_zone_from_geojson(
      p_user_id UUID,
      p_run_id UUID,
      p_city_id UUID,
      p_geojson TEXT,
      p_area_m2 NUMERIC,
      p_expires_at TIMESTAMPTZ
  )
RETURNS JSON AS $$
DECLARE
    new_zone zones%ROWTYPE;
    zone_geom GEOMETRY;
BEGIN
    -- Parse GeoJSON to geometry
    zone_geom := ST_GeomFromGeoJSON(p_geojson);

    -- Ensure it's a valid polygon with SRID 4326
    zone_geom := ST_SetSRID(zone_geom, 4326);

    INSERT INTO zones (user_id, run_id, city_id, geom, area_m2, is_active, control_score, expires_at)
    VALUES (p_user_id, p_run_id, p_city_id, zone_geom, p_area_m2, true, 100, p_expires_at)
    RETURNING * INTO new_zone;

    RETURN json_build_object(
              'id', new_zone.id,
              'user_id', new_zone.user_id,
              'run_id', new_zone.run_id,
              'city_id', new_zone.city_id,
              'area_m2', new_zone.area_m2,
              'is_active', new_zone.is_active,
              'control_score', new_zone.control_score,
              'expires_at', new_zone.expires_at,
              'created_at', new_zone.created_at
          );
END;
$$ LANGUAGE plpgsql;
