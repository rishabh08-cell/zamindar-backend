const polyline = require('@mapbox/polyline');
const { insertRun } = require('../db/runs');
const { getUserByStravaId } = require('../db/users');
const { supabase } = require('../db/client');
const {
                createZone,
                findOverlappingZones,
                addZoneHistory,
                checkCityCapture,
} = require('../db/zones');

// ─── CONSTANTS ──────────────────────────────────────────────────────────────
const ZONE_BUFFER_M = 30;        // buffer around route before convex hull
const SIEGE_HOURS = 48;          // contested zones get a 48hr siege timer
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
 * 5. Create zone (PERMANENT — no expiry unless contested)
 * 6. Record zone_history
 * 7. Find nearest city + check city capture
 * 8. Detect overlapping zones → start siege on contested zones
 * 9. Update user aggregate stats
 *
 * TERRITORY RULES:
 * - Every run creates a permanent zone. No cap on zones per user.
 * - Zones have NO automatic expiry. Your land is yours forever.
 * - Zones only enter a decay/siege state when another runner's
 *   territory overlaps yours. Then a 48hr siege timer starts.
 * - This rewards runners who explore obscure routes — unchallenged
 *   land stays yours indefinitely.
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
    let zonePolygon = null;
                let areaM2 = 0;

    try {
                        const { data: pgResult, error: pgError } = await supabase.rpc('compute_zone_polygon_from_geojson', {
                                                p_route_geojson: JSON.stringify(routeGeoJSON),
                                                p_buffer_m: ZONE_BUFFER_M,
                        });

                    if (pgError) {
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
                        const fallbackResult = await computePolygonFallback(routeGeoJSON, ZONE_BUFFER_M);
                        if (fallbackResult) {
                                                zonePolygon = fallbackResult.polygon;
                                                areaM2 = fallbackResult.area_m2;
                        }
    }

    // If PostGIS failed, compute a simple convex hull in JS
    if (!zonePolygon) {
                        console.log('[processor] PostGIS polygon computation failed — using JS convex hull');
                        zonePolygon = computeConvexHullJS(coordinates);
                        areaM2 = computeAreaFromGeoJSON(zonePolygon);
    }

    if (!zonePolygon) {
                        console.error(`[processor] Could not compute zone polygon for run ${run.id}`);
                        return { run, zone: null };
    }

    // Update run record with computed area
    try {
                        await supabase.from('runs').update({ area_m2: areaM2 }).eq('id', run.id);
    } catch (err) {
                        console.warn('[processor] Failed to update run area:', err.message);
    }

    // ── Step 6: Find nearest city ────────────────────────────────────────
    let cityId = null;
                try {
                                    const centroid = getCentroid(coordinates);
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

                    if (cityId) {
                                            await supabase.from('runs').update({ city_id: cityId }).eq('id', run.id);
                    }
                } catch (err) {
                                    console.warn('[processor] City lookup failed:', err.message);
                }

    // ── Step 7: Create zone — PERMANENT, no expiry ───────────────────────
    // Zones live forever unless another runner contests them.
    // Only contested zones get a siege timer (set in Step 9).
    let zone = null;
                try {
                                    zone = await createZone({
                                                            userId: user.id,
                                                            runId: run.id,
                                                            cityId,
                                                            geojson: zonePolygon,
                                                            areaM2,
                                                            expiresAt: null, // PERMANENT — no automatic expiry
                                    });
                                    console.log(`[processor] Zone ${zone.id} created (${(areaM2 / 1000000).toFixed(3)} km²) — permanent`);
                } catch (err) {
                                    console.error(`[processor] Failed to create zone:`, err.message);
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

    // ── Step 9: Detect overlapping zones → start siege ───────────────────
    // When your new zone overlaps another runner's zone, BOTH the overlap
    // and the existing zone get a 48hr siege timer. The defender must run
    // again in that area to defend, or they lose the contested portion.
    let overlaps = [];
                try {
                                    overlaps = await findOverlappingZones(zonePolygon, user.id);
                                    if (overlaps.length > 0) {
                                                            console.log(`[processor] Found ${overlaps.length} overlapping zone(s) — starting siege`);

                                        const siegeExpiry = new Date(Date.now() + SIEGE_HOURS * 60 * 60 * 1000).toISOString();

                                        for (const overlap of overlaps) {
                                                                    // Record overlap in zone_overlaps table
                                                                try {
                                                                                                await supabase.from('zone_overlaps').upsert({
                                                                                                                                    zone_a_id: overlap.zone_id,    // existing (defender)
                                                                                                                                    zone_b_id: zone.id,            // new (challenger)
                                                                                                                                    overlap_area_m2: overlap.overlap_area_m2 || 0,
                                                                                                                                    score_a: 60,   // defender gets slight advantage
                                                                                                                                    score_b: 40,   // challenger starts lower
                                                                                                                                    status: 'contested',
                                                                                                            }, {
                                                                                                                                    onConflict: 'zone_a_id,zone_b_id',
                                                                                                            });
                                                                } catch (overlapErr) {
                                                                                                console.warn('[processor] Failed to record overlap:', overlapErr.message);
                                                                }

                                                                // Set siege timer on the EXISTING zone that was overlapped
                                                                // This is the only time a zone gets an expires_at value
                                                                try {
                                                                                                await supabase.from('zones').update({
                                                                                                                                    expires_at: siegeExpiry,
                                                                                                                                    updated_at: new Date().toISOString(),
                                                                                                            }).eq('id', overlap.zone_id).is('expires_at', null);
                                                                                                // Only set expiry if it doesn't already have one (don't shorten existing siege)
                                                                } catch (siegeErr) {
                                                                                                console.warn('[processor] Failed to set siege timer:', siegeErr.message);
                                                                }

                                                                // Record contested event in zone_history
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

    // ── Step 11: Update user aggregate stats ─────────────────────────────
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

                    console.log(`[processor] User stats: ${totalDistanceKm.toFixed(1)}km, ${zonesOwned} zones, ${(totalAreaM2 / 1000000).toFixed(3)} km²`);
    } catch (err) {
                        console.warn('[processor] Failed to update user stats:', err.message);
    }

    console.log(`[processor] Done: activity ${stravaActivityId} for ${user.display_name} — ${distanceKm.toFixed(1)}km, ${(areaM2 / 1000000).toFixed(3)} km², ${overlaps.length} conflicts`);

    return {
                        run,
                        zone,
                        overlaps: overlaps.length,
                        cityId,
    };
}


// ─── PostGIS FALLBACK ────────────────────────────────────────────────────────

async function computePolygonFallback(routeGeoJSON, bufferM) {
                try {
                                    const { data, error } = await supabase.rpc('compute_zone_polygon', {
                                                            route: JSON.stringify(routeGeoJSON),
                                                            buffer_m: bufferM,
                                    });
                                    if (!error && data) {
                                                            return { polygon: data, area_m2: 0 };
                                    }
                } catch (err) {
                                    // Fall through to JS computation
                }
                return null;
}


// ─── JS CONVEX HULL (fallback when PostGIS is unavailable) ──────────────────

function computeConvexHullJS(coordinates) {
                if (!coordinates || coordinates.length < 3) return null;

    const pts = [...new Map(coordinates.map(p => [p.join(','), p])).values()];
                if (pts.length < 3) return null;

    let lowest = 0;
                for (let i = 1; i < pts.length; i++) {
                                    if (pts[i][1] < pts[lowest][1] || (pts[i][1] === pts[lowest][1] && pts[i][0] < pts[lowest][0])) {
                                                            lowest = i;
                                    }
                }
                [pts[0], pts[lowest]] = [pts[lowest], pts[0]];
                const pivot = pts[0];

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

    const hull = [pts[0], pts[1]];
                for (let i = 2; i < pts.length; i++) {
                                    while (hull.length > 1 && cross(hull[hull.length - 2], hull[hull.length - 1], pts[i]) <= 0) {
                                                            hull.pop();
                                    }
                                    hull.push(pts[i]);
                }

    if (hull.length < 3) return null;
                const ring = [...hull, hull[0]];
                return { type: 'Polygon', coordinates: [ring] };
}

function cross(o, a, b) {
                return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}


// ─── AREA COMPUTATION (Shoelace formula) ─────────────────────────────────────

function computeAreaFromGeoJSON(polygon) {
                if (!polygon || !polygon.coordinates || !polygon.coordinates[0]) return 0;
                const ring = polygon.coordinates[0];
                if (ring.length < 4) return 0;

    const avgLat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
                const latM = 111320;
                const lngM = 111320 * Math.cos(avgLat * Math.PI / 180);

    let area = 0;
                for (let i = 0; i < ring.length - 1; i++) {
                                    const x1 = ring[i][0] * lngM, y1 = ring[i][1] * latM;
                                    const x2 = ring[i + 1][0] * lngM, y2 = ring[i + 1][1] * latM;
                                    area += x1 * y2 - x2 * y1;
                }
                return Math.abs(area / 2);
}


// ─── GEO HELPERS ─────────────────────────────────────────────────────────────

function getCentroid(coordinates) {
                const n = coordinates.length;
                const sum = coordinates.reduce((acc, [lng, lat]) => [acc[0] + lng, acc[1] + lat], [0, 0]);
                return [sum[0] / n, sum[1] / n];
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
