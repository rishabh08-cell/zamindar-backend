const express = require('express');
const router = express.Router();
const {
  getZonesByUser,
  getZonesByBbox,
  getZoneById,
  checkCityCapture,
  getCityTeamCoverage,
  getRecentActivity,
  getAreaLeaderboard,
} = require('../db/zones');

// GET /zones?bbox=west,south,east,north
router.get('/', async (req, res) => {
  try {
    const { bbox } = req.query;
    let zones;
    if (bbox) {
      const [west, south, east, north] = bbox.split(',').map(Number);
      zones = await getZonesByBbox({ west, south, east, north });
    } else {
      zones = await getZonesByBbox({ west: 68, south: 6, east: 97, north: 37 });
    }
    const features = (zones || []).map(z => ({
      type: 'Feature',
      geometry: z.geom,
      properties: {
        zone_id: z.id,
        user_id: z.user_id,
        run_id: z.run_id,
        area_m2: z.area_m2,
        area_km2: z.area_m2 ? (z.area_m2 / 1000000).toFixed(3) : '0',
        control_score: z.control_score,
        runner_name: z.users?.display_name || 'Runner',
        created_at: z.created_at,
        expires_at: z.expires_at,
      },
    }));
    res.json({ type: 'FeatureCollection', features, count: features.length });
  } catch (err) {
    console.error('[zones] GET / error:', err.message);
    res.status(500).json({ error: 'Failed to fetch zones' });
  }
});

// GET /zones/leaderboard
router.get('/leaderboard', async (req, res) => {
  try {
    const leaderboard = await getAreaLeaderboard({
      cityId: req.query.cityId,
      limit: parseInt(req.query.limit) || 20,
    });
    const formatted = leaderboard.map((entry, i) => ({
      rank: i + 1,
      user_id: entry.user_id,
      display_name: entry.display_name,
      total_area_m2: entry.total_area_m2,
      total_area_km2: (entry.total_area_m2 / 1000000).toFixed(3),
      zone_count: entry.zone_count,
    }));
    res.json({ leaderboard: formatted });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// GET /zones/activity
router.get('/activity', async (req, res) => {
  try {
    const activity = await getRecentActivity({
      cityId: req.query.cityId,
      limit: parseInt(req.query.limit) || 20,
    });
    res.json({ activity });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// GET /zones/user/:userId
router.get('/user/:userId', async (req, res) => {
  try {
    const zones = await getZonesByUser(req.params.userId);
    const totalArea = (zones || []).reduce((sum, z) => sum + (z.area_m2 || 0), 0);
    res.json({
      zones: zones || [],
      count: (zones || []).length,
      total_area_m2: totalArea,
      total_area_km2: (totalArea / 1000000).toFixed(3),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user zones' });
  }
});

// GET /zones/city/:cityId/capture
router.get('/city/:cityId/capture', async (req, res) => {
  try {
    const { userId } = req.query;
    const cityId = req.params.cityId;
    const teamCoverage = await getCityTeamCoverage(cityId);
    let userCapture = null;
    if (userId) {
      userCapture = await checkCityCapture(userId, cityId);
    }
    res.json({ city_id: cityId, team: teamCoverage, user: userCapture });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check city capture' });
  }
});

// GET /zones/:id
router.get('/:id', async (req, res) => {
  try {
    const zone = await getZoneById(req.params.id);
    if (!zone) return res.status(404).json({ error: 'Zone not found' });
    res.json({ zone });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch zone' });
  }
});

module.exports = router;

module.exports = router;
