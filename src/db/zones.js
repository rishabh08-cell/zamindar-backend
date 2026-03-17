const { supabase } = require('./client');

/**
 * Zamindar — Zones DB Module
 *
 * "My run is my area" — each zone is a territory polygon
 * created from a runner's actual route. No grids.
 *
 * The run's polyline is decoded, buffered by 30m, and the
 * convex hull becomes the zone polygon stored as PostGIS geometry.
 */

// ─── CREATE ZONE FROM RUN ──────────────────────────────────────────────────

/**
 * Creates a zone from a processed run.
 * The polygon should already be computed (convex hull of buffered route).
 *
 * @param {Object} params
 * @param {string} params.userId - Owner
 * @param {string} params.runId - Source run
 * @param {string} params.cityId - Nearest city (nullable)
 * @param {Object} params.geojson - GeoJSON Polygon geometry
 * @param {number} params.areaM2 - Area in square metres
 * @param {string} params.expiresAt - ISO timestamp (30 days from run)
 */
async function createZone({ userId, runId, cityId, geojson, areaM2, expiresAt }) {
  const { data, error } = await supabase.rpc('create_zone_from_geojson', {
    p_user_id: userId,
    p_run_id: runId,
    p_city_id: cityId,
    p_geojson: JSON.stringify(geojson),
    p_area_m2: areaM2,
    p_expires_at: expiresAt,
  });

  // Fallback: direct insert if RPC not available yet
  if (error && error.message.includes('function')) {
    const { data: inserted, error: insertErr } = await supabase
      .from('zones')
      .insert({
        user_id: userId,
        run_id: runId,
        city_id: cityId,
        geom: geojson, // Supabase PostGIS accepts GeoJSON directly
        area_m2: areaM2,
        is_active: true,
        control_score: 100,
        expires_at: expiresAt,
      })
      .select()
      .single();

    if (insertErr) throw insertErr;
    return inserted;
  }

  if (error) throw error;
  return data;
}

// ─── GET ZONES BY USER ─────────────────────────────────────────────────────

async function getZonesByUser(userId, { activeOnly = true } = {}) {
  let query = supabase
    .from('zones')
    .select('*, runs(distance_km, duration_sec, created_at)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (activeOnly) {
    query = query.eq('is_active', true);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// ─── GET ZONES BY BOUNDING BOX ─────────────────────────────────────────────
// Used by the map endpoint to fetch zones visible in the viewport.

async function getZonesByBbox(bbox, { activeOnly = true } = {}) {
  // bbox = { west, south, east, north }
  // PostGIS envelope for spatial query
  const envelope = `SRID=4326;POLYGON((${bbox.west} ${bbox.south}, ${bbox.east} ${bbox.south}, ${bbox.east} ${bbox.north}, ${bbox.west} ${bbox.north}, ${bbox.west} ${bbox.south}))`;

  const { data, error } = await supabase.rpc('get_zones_in_bbox', {
    p_bbox: envelope,
    p_active_only: activeOnly,
  });

  // Fallback: fetch all active zones (no spatial filter)
  if (error && error.message.includes('function')) {
    let query = supabase
      .from('zones')
      .select('*, users(display_name, avatar_url)')
      .order('created_at', { ascending: false })
      .limit(200);

    if (activeOnly) {
      query = query.eq('is_active', true);
    }

    const { data: fallback, error: fbErr } = await query;
    if (fbErr) throw fbErr;
    return fallback;
  }

  if (error) throw error;
  return data;
}

// ─── GET ZONE BY ID ────────────────────────────────────────────────────────

async function getZoneById(zoneId) {
  const { data, error } = await supabase
    .from('zones')
    .select('*, users(display_name, avatar_url), runs(distance_km, polyline)')
    .eq('id', zoneId)
    .single();

  if (error) throw error;
  return data;
}

// ─── FIND OVERLAPPING ZONES ────────────────────────────────────────────────
// Given a new zone's geometry, find all active zones from OTHER users that
// intersect with it. Used by the territory engine to create conflicts.

async function findOverlappingZones(geojson, excludeUserId) {
  const { data, error } = await supabase.rpc('find_overlapping_zones', {
    new_zone_geom: JSON.stringify(geojson),
    exclude_user: excludeUserId,
  });

  if (error) {
    console.warn('[zones] find_overlapping_zones RPC failed:', error.message);
    return [];
  }
  return data || [];
}

// ─── DEACTIVATE EXPIRED ZONES ──────────────────────────────────────────────
// Called by a daily cron job. Zones expire 30 days after the run.

async function deactivateExpiredZones() {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('zones')
    .update({ is_active: false, updated_at: now })
    .eq('is_active', true)
    .lt('expires_at', now)
    .select('id, user_id');

  if (error) throw error;
  return data || [];
}

// ─── DEACTIVATE ZONES BY RUN ───────────────────────────────────────────────
// When a run is deleted or a user's oldest run gets evicted from active window.

async function deactivateZonesByRun(runId) {
  const { data, error } = await supabase
    .from('zones')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('run_id', runId)
    .select();

  if (error) throw error;
  return data || [];
}

// ─── CITY COVERAGE ─────────────────────────────────────────────────────────

/**
 * Get how much area a user covers within a city's capture radius.
 * Uses the PostGIS helper function defined in the migration.
 */
async function getUserCityArea(userId, cityId) {
  const { data, error } = await supabase.rpc('get_user_city_area', {
    p_user_id: userId,
    p_city_id: cityId,
  });

  if (error) {
    console.warn('[zones] get_user_city_area RPC failed:', error.message);
    return 0;
  }
  return data || 0;
}

/**
 * Check if a user has crossed the capture threshold for a city.
 * Capture = own >= 20% of the city's area.
 * Returns { captured: bool, percentage: number, thresholdPct: number }
 */
async function checkCityCapture(userId, cityId) {
  const { data: city, error: cityErr } = await supabase
    .from('cities')
    .select('city_area_m2, capture_threshold, captured_by')
    .eq('id', cityId)
    .single();

  if (cityErr || !city) return { captured: false, percentage: 0, thresholdPct: 20 };

  const userArea = await getUserCityArea(userId, cityId);
  const percentage = city.city_area_m2 > 0 ? (userArea / city.city_area_m2) * 100 : 0;
  const thresholdPct = (city.capture_threshold || 0.20) * 100;

  const captured = percentage >= thresholdPct;

  // If newly captured, update the city
  if (captured && city.captured_by !== userId) {
    await supabase
      .from('cities')
      .update({
        captured_by: userId,
        captured_at: new Date().toISOString(),
        total_covered_m2: userArea,
      })
      .eq('id', cityId);
  }

  return { captured, percentage: Math.round(percentage * 100) / 100, thresholdPct };
}

/**
 * Get total coverage across all users for a city (team progress).
 * The 50% collective goal.
 */
async function getCityTeamCoverage(cityId) {
  const { data, error } = await supabase
    .from('city_coverage')
    .select('user_id, covered_area_m2, zone_count')
    .eq('city_id', cityId)
    .order('covered_area_m2', { ascending: false });

  if (error) return { contributors: [], totalArea: 0, percentage: 0 };

  const { data: city } = await supabase
    .from('cities')
    .select('city_area_m2')
    .eq('id', cityId)
    .single();

  const totalArea = (data || []).reduce((sum, r) => sum + (r.covered_area_m2 || 0), 0);
  const percentage = city?.city_area_m2 > 0 ? (totalArea / city.city_area_m2) * 100 : 0;

  return {
    contributors: data || [],
    totalArea,
    percentage: Math.round(percentage * 100) / 100,
    teamGoalPct: 50,
  };
}

// ─── ZONE HISTORY ──────────────────────────────────────────────────────────

async function addZoneHistory({ zoneId, userId, runId, eventType, areaM2, cityId }) {
  const { data, error } = await supabase
    .from('zone_history')
    .insert({
      zone_id: zoneId,
      user_id: userId,
      run_id: runId,
      event_type: eventType,
      area_m2: areaM2 || 0,
      city_id: cityId,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getRecentActivity({ cityId, limit = 20 } = {}) {
  let query = supabase
    .from('zone_history')
    .select('*, users(display_name, avatar_url), cities(name)')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (cityId) {
    query = query.eq('city_id', cityId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// ─── LEADERBOARD ───────────────────────────────────────────────────────────

async function getAreaLeaderboard({ cityId, limit = 20 } = {}) {
  let query = supabase
    .from('zones')
    .select('user_id, users(display_name, avatar_url)')
    .eq('is_active', true);

  if (cityId) {
    query = query.eq('city_id', cityId);
  }

  // Supabase doesn't support GROUP BY directly, so we fetch and aggregate
  const { data, error } = await query;
  if (error) return [];

  // Aggregate area per user
  const userAreas = {};
  (data || []).forEach(z => {
    if (!userAreas[z.user_id]) {
      userAreas[z.user_id] = {
        user_id: z.user_id,
        display_name: z.users?.display_name || 'Runner',
        avatar_url: z.users?.avatar_url,
        total_area_m2: 0,
        zone_count: 0,
      };
    }
    userAreas[z.user_id].total_area_m2 += z.area_m2 || 0;
    userAreas[z.user_id].zone_count += 1;
  });

  return Object.values(userAreas)
    .sort((a, b) => b.total_area_m2 - a.total_area_m2)
    .slice(0, limit);
}

// ─── EXPORTS ───────────────────────────────────────────────────────────────

module.exports = {
  createZone,
  getZonesByUser,
  getZonesByBbox,
  getZoneById,
  findOverlappingZones,
  deactivateExpiredZones,
  deactivateZonesByRun,
  getUserCityArea,
  checkCityCapture,
  getCityTeamCoverage,
  addZoneHistory,
  getRecentActivity,
  getAreaLeaderboard,
};
