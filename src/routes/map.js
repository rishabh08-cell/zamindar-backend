const express = require('express');
const router = express.Router();

// GET /map/geojson - returns territory GeoJSON for the frontend
router.get('/geojson', async (req, res) => {
    try {
    // TODO: Wire up to DB queries
    res.json({ type: 'FeatureCollection', features: [] });
} catch (err) {
      console.error('Map GeoJSON error:', err);
    res.status(500).json({ error: 'Internal server error' });
}
});

// GET /map/cities - returns city data
router.get('/cities', async (req, res) => {
    try {
    res.json({ cities: [] });
} catch (err) {
      res.status(500).json({ error: 'Internal server error' });
}
});

module.exports = router;
