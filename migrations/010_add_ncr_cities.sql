-- Migration 010: Add NCR satellite cities
-- Delhi's 20km radius doesn't cover Noida, Gurgaon, Ghaziabad etc.
-- Adding them as separate cities so runners in those areas get city coverage.

INSERT INTO cities (name, state, lat, lng, capture_radius_km, zone_size_km, multiplier, geom) VALUES
('Noida', 'Uttar Pradesh', 28.5355, 77.3910, 12, 0.5, 1.1, ST_SetSRID(ST_MakePoint(77.3910, 28.5355), 4326)),
('Gurgaon', 'Haryana', 28.4595, 77.0266, 14, 0.5, 1.2, ST_SetSRID(ST_MakePoint(77.0266, 28.4595), 4326)),
('Ghaziabad', 'Uttar Pradesh', 28.6692, 77.4538, 10, 0.5, 1.0, ST_SetSRID(ST_MakePoint(77.4538, 28.6692), 4326)),
('Faridabad', 'Haryana', 28.4089, 77.3178, 10, 0.5, 1.0, ST_SetSRID(ST_MakePoint(77.3178, 28.4089), 4326))
ON CONFLICT DO NOTHING;
