const express = require('express');
const router = express.Router();
const { supabase } = require('../db/client');
const { getLeaderboard } = require('../db/users');
const { getZonesByBbox } = require('../db/zones');

// GET /map/territories - Returns territory data for the map
// Now reads from zones table (actual territory polygons) instead of runs
router.get('/territories', async (req, res) => {
            try {
                            const { bbox } = req.query;

                let zones;
                            if (bbox) {
                                                const [west, south, east, north] = bbox.split(',').map(Number);
                                                zones = await getZonesByBbox({ west, south, east, north });
                            } else {
                                                // Default: all of India
                                zones = await getZonesByBbox({ west: 68, south: 6, east: 97, north: 37 });
                            }

                const territories = (zones || []).map(z => {
                                    // geom could be a GeoJSON object (from RPC) or a raw PostGIS value
                                                                  let geojson = null;
                                    if (z.geom) {
                                                            geojson = typeof z.geom === 'string' ? JSON.parse(z.geom) : z.geom;
                                    }

                                                                  return {
                                                                                          zone_id: z.id,
                                                                                          runner_id: z.user_id,
                                                                                          runner_name: z.display_name || z.users?.display_name || 'Runner',
                                                                                          area_m2: z.area_m2 || 0,
                                                                                          control_score: z.control_score || 100,
                                                                                          is_active: z.is_active,
                                                                                          expires_at: z.expires_at,
                                                                                          created_at: z.created_at,
                                                                                          contested: z.control_score < 60,
                                                                                          siege_expires: z.control_score < 60 ? z.expires_at : null,
                                                                                          distance_m: 0,
                                                                                          geojson,
                                                                  };
                });

                res.json({ territories, count: territories.length });
            } catch (err) {
                            console.error('Territories error:', err);
                            res.json({ territories: [], count: 0 });
            }
});

// GET /map/cities - Returns city markers with capture info
router.get('/cities', async (req, res) => {
            try {
                            const { data: cities, error } = await supabase
                                .from('cities')
                                .select('id, name, state, lat, lng, capture_radius_km, multiplier, captured_by, users!cities_captured_by_fkey(display_name)');

                if (error) {
                                    // Fallback without join if FK doesn't exist yet
                                const { data: fallbackCities, error: fbErr } = await supabase
                                        .from('cities')
                                        .select('id, name, state, lat, lng, capture_radius_km, multiplier, captured_by');

                                if (fbErr) throw fbErr;

                                const formatted = (fallbackCities || []).map(c => ({
                                                        id: c.id,
                                                        name: c.name,
                                                        state: c.state,
                                                        lat: parseFloat(c.lat),
                                                        lng: parseFloat(c.lng),
                                                        capture_radius_km: c.capture_radius_km || 15,
                                                        multiplier: c.multiplier || 1.0,
                                                        zamindar: null,
                                                        captured_by: c.captured_by,
                                }));
                                    return res.json({ cities: formatted });
                }

                const formatted = (cities || []).map(c => ({
                                    id: c.id,
                                    name: c.name,
                                    state: c.state,
                                    lat: parseFloat(c.lat),
                                    lng: parseFloat(c.lng),
                                    capture_radius_km: c.capture_radius_km || 15,
                                    multiplier: c.multiplier || 1.0,
                                    zamindar: c.users?.display_name || null,
                                    captured_by: c.captured_by,
                }));

                res.json({ cities: formatted });
            } catch (err) {
                            console.error('Cities error:', err);
                            res.json({ cities: [] });
            }
});

// GET /map/leaderboard - Top runners by area owned
router.get('/leaderboard', async (req, res) => {
            try {
                            // Try area-based leaderboard from zones first
                const { data: zoneStats, error: zoneErr } = await supabase
                                .from('zones')
                                .select('user_id, area_m2, users(display_name, avatar_url, strava_id)')
                                .eq('is_active', true);

                if (!zoneErr && zoneStats && zoneStats.length > 0) {
                                    // Aggregate by user
                                const userMap = {};
                                    zoneStats.forEach(z => {
                                                            if (!userMap[z.user_id]) {
                                                                                        userMap[z.user_id] = {
                                                                                                                        strava_id: z.users?.strava_id,
                                                                                                                        name: z.users?.display_name || 'Runner',
                                                                                                                        avatar_url: z.users?.avatar_url,
                                                                                                                        total_area: 0,
                                                                                                                        zone_count: 0,
                                                                                                };
                                                            }
                                                            userMap[z.user_id].total_area += z.area_m2 || 0;
                                                            userMap[z.user_id].zone_count += 1;
                                    });

                                const leaderboard = Object.entries(userMap)
                                        .map(([userId, stats]) => ({
                                                                    user_id: userId,
                                                                    ...stats,
                                        }))
                                        .sort((a, b) => b.total_area - a.total_area)
                                        .slice(0, 20);

                                return res.json({ leaderboard });
                }

                // Fallback to users table leaderboard
                const leaderboard = await getLeaderboard({ limit: 20 });
                            res.json({ leaderboard: leaderboard || [] });
            } catch (err) {
                            console.error('Leaderboard error:', err);
                            res.json({ leaderboard: [] });
            }
});

// GET /map/geojson - Full GeoJSON FeatureCollection of active zones
router.get('/geojson', async (req, res) => {
            try {
                            const zones = await getZonesByBbox({ west: 68, south: 6, east: 97, north: 37 });

                const features = (zones || []).map(z => {
                                    let geometry = null;
                                    if (z.geom) {
                                                            geometry = typeof z.geom === 'string' ? JSON.parse(z.geom) : z.geom;
                                    }

                                                               return {
                                                                                       type: 'Feature',
                                                                                       properties: {
                                                                                                                   zone_id: z.id,
                                                                                                                   runner_id: z.user_id,
                                                                                                                   runner_name: z.display_name || z.users?.display_name || 'Runner',
                                                                                                                   area_m2: z.area_m2,
                                                                                                                   area_km2: z.area_m2 ? (z.area_m2 / 1000000).toFixed(3) : '0',
                                                                                                                   control_score: z.control_score,
                                                                                                                   is_active: z.is_active,
                                                                                                                   created_at: z.created_at,
                                                                                                                   expires_at: z.expires_at,
                                                                                               },
                                                                                       geometry,
                                                               };
                }).filter(f => f.geometry !== null);

                res.json({ type: 'FeatureCollection', features });
            } catch (err) {
                            console.error('GeoJSON error:', err);
                            res.json({ type: 'FeatureCollection', features: [] });
            }
});

module.exports = router;
