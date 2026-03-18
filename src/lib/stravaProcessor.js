const polyline = require('@mapbox/polyline');
const { insertRun } = require('../db/runs');
const { getUserByStravaId } = require('../db/users');
const { supabase } = require('../db/client');
const {
            createZone,
            findOverlappingZones,
            addZoneHistory,
            checkCityCapture,
            deactivateZonesByRun,
} = require('../db/zones');

// ─── CONSTANTS ──────────────────────────────────────────────────────────────
const ZONE_BUFFER_M = 30;        // buffer around route before convex hull
const ZONE_EXPIRY_DAYS = 30;     // zones expire after 30 days
const MAX_ACTIVE_ZONES = 3;      // max active zones per user
const MIN_DISTANCE_KM = 1;       // minimum 1km to qualify
const MIN_POINTS = 5;            // minimum polyline points for a valid route

/**
 * processStravaActivity — Main entry point called by webhook and initialSync
 *
 * Full pipeline:
 * 1. Validate activity (is a Run, has polyline, user exists)
 * 2. Store run in runs table
 * 3. Decode polyline → build GeoJSON LineString
 * 4. Call PostGIS to compute territory polygon (buffered convex hull)
 * 5. Create zone in zones table
 * 6. Detect overlapping zones from other users
 * 7. Record zone_history
 * 8. Find nearest city + check city capture
 * 9. Enforce active window (max 3, evict oldest)
 * 10. Update user aggregate stats
 */
async function processStravaActivity(activityData) {
            const {
                            id: stravaActivityId,
                            athlete,
                            map: activityMap,
                            distance,
                            moving_time,
                            type,
            } = activityData;

    // ── Step 1: Validate ─────────────────────────────────────────────────
    if (type !== 'Run') {
                    console.log(`[processor] Skipping non-run activity ${stravaActivityId} (type: ${type})`);
                    return null;
    }

    const user = await getUserByStravaId(athlete.id);
            if (!user) {
                            console.log(`[processor] No user found for Strava athlete ${athlete.id}`);
                            return null;
            }

    if (!activityMap || !activityMap.summary_polyline) {
                    console.log(`[processor] Activity ${stravaActivityId} has no polyline (indoor/treadmill?)`);
                    return null;
    }

    const distanceKm = distance / 1000;
            if (distanceKm < MIN_DISTANCE_KM) {
                            console.log(`[processor] Activity ${stravaActivityId} too short (${distanceKm.toFixed(1)}km < ${MIN_DISTANCE_KM}km)`);
                            return null;
            }

    // ── Step 2: Decode polyline ──────────────────────────────────────────
    const decoded = polyline.decode(activityMap.summary_polyline);
            if (!decoded || decoded.length < MIN_POINTS) {
                            console.log(`[processor] Activity ${stravaActivityId} polyline too sparse (${decoded?.length || 0} points)`);
                            return null;
            }

    // ── Step 3: Store run ────────────────────────────────────────────────
    let run;
            try {
                            run = await insertRun({
                                                userId: user.id,
                                                stravaActivityId: String(stravaActivityId),
                                                polyline: activityMap.summary_polyline,
                                                distanceKm,
                                                durationSec: moving_time,
                                                cityId: null, // will update after city lookup
                            });
                            console.log(`[processor] Run ${run.id} stored for ${user.display_name}`);
            } catch (err) {
                            if (err.code === '23505') {
                                                console.log(`[processor] Activity ${stravaActivityId} already processed (duplicate)`);
                                                return null;
                            }
                            throw err;
            }

    // ── Step 4: Build GeoJSON LineString from decoded polyline ────────────
    // polyline.decode returns [[lat, lng], ...] — GeoJSON needs [lng, lat]
    const coordinates = decoded.map(([lat, lng]) => [lng, lat]);
            const routeGeoJSON = {
                            type: 'LineString',
                            coordinates,
            };

    // ── Step 5: Compute territory polygon via PostGIS ────────────────────
    // Uses ST_Buffer + ST_ConvexHull to turn the route into a territory polygon
    let zonePolygon = null;
            let areaM2 = 0;

    try {
                    const { data: pgResult, error: pgError } = await supabase.rpc('compute_zone_polygon_from_geojson', {
                                        p_route_geojson: JSON.stringify(routeGeoJSON),
                                        p_buffer_m: ZONE_BUFFER_M,
                    });

                if (pgError) {
                                    // Fallback: try raw SQL via the pg pool or a simpler RPC
                        console.warn(`[processor] RPC compute_zone_polygon_from_geojson failed: ${pgError.message}`);
                                    console.log('[processor] Trying direct SQL fallback...');

                        const fallbackResult = await computePolygonFallback(routeGeoJSON, ZONE_BUFFER_M);
                                    if (fallbackResult) {
                                                            zonePolygon = fallbackResult.polygon;
                                                            areaM2 = fallbackResult.area_m2;
                                    }
                } else if (pgResult) {
                                    zonePolygon = pgResult.polygon || pgResult;
                                    areaM2 = pgResult.area_m2 || 0;
                }
    } catch (err) {
                    console.error(`[processor] Polygon computation error:`, err.message);
                    // Try fallback
                const fallbackResult = await computePolygonFallback(routeGeoJSON, ZONE_BUFFER_M);
                    if (fallbackResult) {
                                        zonePolygon = fallbackResult.polygon;
                                        areaM2 = fallbackResult.area_m2;
                    }
    }

    // If we still don't have a polygon, compute a simple convex hull in JS
    if (!zonePolygon) {
                    console.log('[processor] PostGIS polygon computation failed — using JS convex hull');
                    zonePolygon = computeConvexHullJS(coordinates);
                    // Rough area estimate using Shoelace formula (good enough for ranking)
                areaM2 = computeAreaFromGeoJSON(zonePolygon);
    }

    if (!zonePolygon) {
                    console.error(`[processor] Could not compute zone polygon for run ${run.id}`);
                    return { run, zone: null };
    }

    // ── Step 5b: Also store the route geometry on the run record ─────────
    try {
                    await supabase.from('runs').update({
                                        area_m2: areaM2,
                    }).eq('id', run.id);
    } catch (err) {
                    console.warn('[processor] Failed to update run area:', err.message);
    }

    // ── Step 6: Find nearest city ────────────────────────────────────────
    let cityId = null;
            try {
                            // Get centroid of the route
                const centroid = getCentroid(coordinates);

                // Find the closest city within capture radius
                const { data: cities } = await supabase
                                .from('cities')
                                .select('id, name, lat, lng, capture_radius_km');

                if (cities && cities.length > 0) {
                                    for (const city of cities) {
                                                            const dist = haversineKm(centroid[1], centroid[0], parseFloat(city.lat), parseFloat(city.lng));
                                                            if (dist <= (city.capture_radius_km || 15)) {
                                                                                        cityId = city.id;
                                                                                        console.log(`[processor] Run is within ${city.name} (${dist.toFixed(1)}km from centre)`);
                                                                                        break;
                                                            }
                                    }
                }

                // Update run with city
                if (cityId) {
                                    await supabase.from('runs').update({ city_id: cityId }).eq('id', run.id);
                }
            } catch (err) {
                            console.warn('[processor] City lookup failed:', err.message);
            }

    // ── Step 7: Create zone ──────────────────────────────────────────────
    const expiresAt = new Date(Date.now() + ZONE_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

    let zone = null;
            try {
                            zone = await createZone({
                                                userId: user.id,
                                                runId: run.id,
                                                cityId,
                                                geojson: zonePolygon,
                                                areaM2,
                                                expiresAt,
                            });
                            console.log(`[processor] Zone ${zone.id} created (${(areaM2 / 1000000).toFixed(3)} km²)`);
            } catch (err) {
                            console.error(`[processor] Failed to create zone:`, err.message);
                            // Run is stored even if zone fails — can retry later
                return { run, zone: null };
            }

    // ── Step 8: Record zone history ──────────────────────────────────────
    try {
                    await addZoneHistory({
                                        zoneId: zone.id,
                                        userId: user.id,
                                        runId: run.id,
                                        eventType: 'claimed',
                                        areaM2,
                                        cityId,
                    });
    } catch (err) {
                    console.warn('[processor] Failed to record zone history:', err.message);
    }

    // ── Step 9: Detect overlapping zones (conflicts) ─────────────────────
    let overlaps = [];
            try {
                            overlaps = await findOverlappingZones(zonePolygon, user.id);
                            if (overlaps.length > 0) {
                                                console.log(`[processor] Found ${overlaps.length} overlapping zone(s) from other runners`);

                                for (const overlap of overlaps) {
                                                        // Record overlap in zone_overlaps table
                                                    try {
                                                                                await supabase.from('zone_overlaps').upsert({
                                                                                                                zone_a_id: overlap.zone_id,    // existing zone
                                                                                                                zone_b_id: zone.id,            // new zone
                                                                                                                overlap_area_m2: overlap.overlap_area_m2 || 0,
                                                                                                                score_a: 60,   // defender gets slight base advantage
                                                                                                                score_b: 40,   // challenger starts lower
                                                                                                                status: 'contested',
                                                                                        }, {
                                                                                                                onConflict: 'zone_a_id,zone_b_id',
                                                                                        });
                                                    } catch (overlapErr) {
                                                                                console.warn('[processor] Failed to record overlap:', overlapErr.message);
                                                    }

                                                    // Record in zone_history for the affected user
                                                    try {
                                                                                await addZoneHistory({
                                                                                                                zoneId: overlap.zone_id,
                                                                                                                userId: overlap.owner_id,
                                                                                                                runId: run.id,
                                                                                                                eventType: 'contested',
                                                                                                                areaM2: overlap.overlap_area_m2 || 0,
                                                                                                                cityId,
                                                                                        });
                                                    } catch (histErr) {
                                                                                // zone_history has CHECK on event_type — 'contested' might not be in the list
                                                            // Fall through gracefully
                                                            console.warn('[processor] Zone history contested event failed:', histErr.message);
                                                    }
                                }
                            }
            } catch (err) {
                            console.warn('[processor] Overlap detection failed:', err.message);
            }

    // ── Step 10: Check city capture ──────────────────────────────────────
    if (cityId) {
                    try {
                                        const captureResult = await checkCityCapture(user.id, cityId);
                                        if (captureResult.captured) {
                                                                console.log(`[processor] ${user.display_name} captured the city! (${captureResult.percentage.toFixed(1)}% coverage)`);
                                        } else {
                                                                console.log(`[processor] City coverage: ${captureResult.percentage.toFixed(1)}% (need ${captureResult.thresholdPct}%)`);
                                        }
                    } catch (err) {
                                        console.warn('[processor] City capture check failed:', err.message);
                    }
    }

    // ── Step 11: Enforce active window (max 3 zones per user) ────────────
    try {
                    const { data: activeZones } = await supabase
                        .from('zones')
                        .select('id, run_id, created_at, area_m2')
                        .eq('user_id', user.id)
                        .eq('is_active', true)
                        .order('created_at', { ascending: false });

                if (activeZones && activeZones.length > MAX_ACTIVE_ZONES) {
                                    // Evict oldest zones beyond the limit
                        const toEvict = activeZones.slice(MAX_ACTIVE_ZONES);
                                    for (const oldZone of toEvict) {
                                                            console.log(`[processor] Evicting oldest zone ${oldZone.id} (active window exceeded)`);
                                                            await deactivateZonesByRun(oldZone.run_id);

                                        // Record eviction in history
                                        try {
                                                                    await addZoneHistory({
                                                                                                    zoneId: oldZone.id,
                                                                                                    userId: user.id,
                                                                                                    runId: oldZone.run_id,
                                                                                                    eventType: 'expired',
                                                                                                    areaM2: oldZone.area_m2 || 0,
                                                                                                    cityId: null,
                                                                    });
                                        } catch (histErr) {
                                                                    console.warn('[processor] Zone eviction history failed:', histErr.message);
                                        }
                                    }
                }
    } catch (err) {
                    console.warn('[processor] Active window enforcement failed:', err.message);
    }

    // ── Step 12: Update user aggregate stats ─────────────────────────────
    try {
                    // Recount from actual zone data for accuracy
                const { data: userZones } = await supabase
                        .from('zones')
                        .select('area_m2')
                        .eq('user_id', user.id)
                        .eq('is_active', true);

                const totalAreaM2 = (userZones || []).reduce((sum, z) => sum + (z.area_m2 || 0), 0);
                    const zonesOwned = (userZones || []).length;
                    const totalDistanceKm = (user.total_distance_km || 0) + distanceKm;

                await supabase.from('users').update({
                                    total_distance_km: totalDistanceKm,
                                    zones_owned: zonesOwned,
                                    total_area_m2: totalAreaM2,
                }).eq('id', user.id);

                console.log(`[processor] User stats updated: ${totalDistanceKm.toFixed(1)}km, ${zonesOwned} zones, ${(totalAreaM2 / 1000000).toFixed(3)} km²`);
    } catch (err) {
                    console.warn('[processor] Failed to update user stats:', err.message);
    }

    console.log(`[processor] ✅ Activity ${stravaActivityId} fully processed for ${user.display_name}: ${distanceKm.toFixed(1)}km → ${(areaM2 / 1000000).toFixed(3)} km² territory`);

    return {
                    run,
                    zone,
                    overlaps: overlaps.length,
                    cityId,
    };
}


// ─── PostGIS FALLBACK ────────────────────────────────────────────────────────
// If the RPC doesn't exist yet, try a raw SQL approach via supabase.rpc
// with a generic SQL execution function, or compute in JS.

async function computePolygonFallback(routeGeoJSON, bufferM) {
            try {
                            // Try using the helper function defined in migration 004
                const { data, error } = await supabase.rpc('compute_zone_polygon', {
                                    route: JSON.stringify(routeGeoJSON),
                                    buffer_m: bufferM,
                });

                if (!error && data) {
                                    return {
                                                            polygon: data,
                                                            area_m2: 0, // will be computed separately
                                    };
                }
            } catch (err) {
                            // Fall through to JS computation
            }

    return null;
}


// ─── JS CONVEX HULL (fallback when PostGIS is unavailable) ──────────────────
// Graham scan algorithm for computing convex hull from [lng, lat] coordinates

function computeConvexHullJS(coordinates) {
            if (!coordinates || coordinates.length < 3) return null;

    // Remove duplicate points
    const pts = [...new Map(coordinates.map(p => [p.join(','), p])).values()];
            if (pts.length < 3) return null;

    // Find lowest point (min lat, then min lng as tiebreaker)
    let lowest = 0;
            for (let i = 1; i < pts.length; i++) {
                            if (pts[i][1] < pts[lowest][1] || (pts[i][1] === pts[lowest][1] && pts[i][0] < pts[lowest][0])) {
                                                lowest = i;
                            }
            }
            [pts[0], pts[lowest]] = [pts[lowest], pts[0]];
            const pivot = pts[0];

    // Sort by polar angle relative to pivot
    pts.sort((a, b) => {
                    if (a === pivot) return -1;
                    if (b === pivot) return 1;
                    const angleA = Math.atan2(a[1] - pivot[1], a[0] - pivot[0]);
                    const angleB = Math.atan2(b[1] - pivot[1], b[0] - pivot[0]);
                    if (angleA !== angleB) return angleA - angleB;
                    const distA = (a[0] - pivot[0]) ** 2 + (a[1] - pivot[1]) ** 2;
                    const distB = (b[0] - pivot[0]) ** 2 + (b[1] - pivot[1]) ** 2;
                    return distA - distB;
    });

    // Graham scan
    const hull = [pts[0], pts[1]];
            for (let i = 2; i < pts.length; i++) {
                            while (hull.length > 1 && cross(hull[hull.length - 2], hull[hull.length - 1], pts[i]) <= 0) {
                                                hull.pop();
                            }
                            hull.push(pts[i]);
            }

    if (hull.length < 3) return null;

    // Close the ring for GeoJSON Polygon
    const ring = [...hull, hull[0]];

    return {
                    type: 'Polygon',
                    coordinates: [ring],
    };
}

function cross(o, a, b) {
            return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}


// ─── AREA COMPUTATION (Shoelace formula on geographic coords) ────────────────
// Approximate — converts to metres using latitude-dependent scaling

function computeAreaFromGeoJSON(polygon) {
            if (!polygon || !polygon.coordinates || !polygon.coordinates[0]) return 0;

    const ring = polygon.coordinates[0];
            if (ring.length < 4) return 0; // need at least 3 points + closing point

    // Convert to approximate metres using center latitude
    const avgLat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
            const latM = 111320; // metres per degree latitude
    const lngM = 111320 * Math.cos(avgLat * Math.PI / 180); // metres per degree longitude

    // Shoelace formula
    let area = 0;
            for (let i = 0; i < ring.length - 1; i++) {
                            const x1 = ring[i][0] * lngM;
                            const y1 = ring[i][1] * latM;
                            const x2 = ring[i + 1][0] * lngM;
                            const y2 = ring[i + 1][1] * latM;
                            area += x1 * y2 - x2 * y1;
            }

    return Math.abs(area / 2);
}


// ─── GEO HELPERS ─────────────────────────────────────────────────────────────

function getCentroid(coordinates) {
            const n = coordinates.length;
            const sum = coordinates.reduce((acc, [lng, lat]) => [acc[0] + lng, acc[1] + lat], [0, 0]);
            return [sum[0] / n, sum[1] / n]; // [lng, lat]
}

function haversineKm(lat1, lon1, lat2, lon2) {
            const R = 6371;
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLon = (lon2 - lon1) * Math.PI / 180;
            const a =
                            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                            Math.sin(dLon / 2) * Math.sin(dLon / 2);
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


// ─── EXPORTS ─────────────────────────────────────────────────────────────────
module.exports = { processStravaActivity };
