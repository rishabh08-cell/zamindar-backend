-- Zamindar Migration 011: Add RPC to get user zones with GeoJSON geometry
-- Run in: Supabase Dashboard > SQL Editor (after 010)

CREATE OR REPLACE FUNCTION get_zones_by_user(
    p_user_id UUID,
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
    distance_km NUMERIC,
    duration_sec INTEGER,
    run_created_at TIMESTAMPTZ
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
        r.distance_km,
        r.duration_sec,
        r.created_at AS run_created_at
    FROM zones z
    LEFT JOIN runs r ON r.id = z.run_id
    WHERE z.user_id = p_user_id
    AND (NOT p_active_only OR z.is_active = true)
    ORDER BY z.created_at DESC;
END;
$$ LANGUAGE plpgsql STABLE;
