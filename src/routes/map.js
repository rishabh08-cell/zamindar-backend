const express = require('express');
const router = express.Router();
const { supabase } = require('../db/client');
const { getLeaderboard } = require('../db/users');

// GET /map/territories - Returns territory data for the map
router.get('/territories', async (req, res) => {
        try {
                    const { data: runs, error } = await supabase
                        .from('runs')
                        .select('id, user_id, polyline, distance_km, zones_claimed, created_at, users(display_name)')
                        .order('created_at', { ascending: false })
                        .limit(100);

            if (error) throw error;

            const territories = (runs || []).map(run => ({
                            runner_id: run.user_id,
                            runner_name: run.users?.display_name || 'Unknown',
                            distance_m: (run.distance_km || 0) * 1000,
                            zones_claimed: run.zones_claimed || 0,
                            created_at: run.created_at,
                            contested: false,
                            geojson: null,
            }));

            res.json({ territories });
        } catch (err) {
                    console.error('Territories error:', err);
                    res.json({ territories: [] });
        }
});

// GET /map/cities - Returns city markers
router.get('/cities', async (req, res) => {
        try {
                    const { data: cities, error } = await supabase
                        .from('cities')
                        .select('id, name, state, lat, lng, capture_radius_km, multiplier');

            if (error) throw error;

            const formatted = (cities || []).map(c => ({
                            id: c.id,
                            name: c.name,
                            state: c.state,
                            lat: parseFloat(c.lat),
                            lng: parseFloat(c.lng),
                            capture_radius_m: (c.capture_radius_km || 15) * 1000,
                            multiplier: c.multiplier || 1.0,
                            zamindar: null,
            }));

            res.json({ cities: formatted });
        } catch (err) {
                    console.error('Cities error:', err);
                    res.json({ cities: [] });
        }
});

// GET /map/leaderboard - Top runners
router.get('/leaderboard', async (req, res) => {
        try {
                    const leaderboard = await getLeaderboard({ limit: 20 });
                    res.json({ leaderboard: leaderboard || [] });
        } catch (err) {
                    console.error('Leaderboard error:', err);
                    res.json({ leaderboard: [] });
        }
});

// GET /map/geojson - Full GeoJSON FeatureCollection
router.get('/geojson', async (req, res) => {
        try {
                    const { data: runs, error } = await supabase
                        .from('runs')
                        .select('id, user_id, polyline, distance_km, created_at, users(display_name)')
                        .order('created_at', { ascending: false })
                        .limit(200);

            if (error) throw error;

            const features = (runs || [])
                        .filter(r => r.polyline)
                        .map(run => ({
                                            type: 'Feature',
                                            properties: {
                                                                    run_id: run.id,
                                                                    runner_id: run.user_id,
                                                                    runner_name: run.users?.display_name || 'Unknown',
                                                                    distance_km: run.distance_km,
                                    created_at: run.created_at,
                                            },
                                            geometry: null,
                        }));

            res.json({ type: 'FeatureCollection', features });
        } catch (err) {
                    console.error('GeoJSON error:', err);
                    res.json({ type: 'FeatureCollection', features: [] });
        }
});

module.exports = router;
