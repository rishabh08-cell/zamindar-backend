-- Zamindar Seed Cities - Run AFTER 001_initial_schema.sql

INSERT INTO cities (name, state, lat, lng, capture_radius_km, zone_size_km, multiplier, geom) VALUES
('Mumbai', 'Maharashtra', 19.0760, 72.8777, 20, 0.5, 1.5, ST_SetSRID(ST_MakePoint(72.8777, 19.0760), 4326)),
('Delhi', 'Delhi', 28.7041, 77.1025, 20, 0.5, 1.5, ST_SetSRID(ST_MakePoint(77.1025, 28.7041), 4326)),
('Bengaluru', 'Karnataka', 12.9716, 77.5946, 18, 0.5, 1.3, ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326)),
('Hyderabad', 'Telangana', 17.3850, 78.4867, 16, 0.5, 1.2, ST_SetSRID(ST_MakePoint(78.4867, 17.3850), 4326)),
('Chennai', 'Tamil Nadu', 13.0827, 80.2707, 16, 0.5, 1.2, ST_SetSRID(ST_MakePoint(80.2707, 13.0827), 4326)),
('Kolkata', 'West Bengal', 22.5726, 88.3639, 16, 0.5, 1.2, ST_SetSRID(ST_MakePoint(88.3639, 22.5726), 4326)),
('Pune', 'Maharashtra', 18.5204, 73.8567, 15, 0.5, 1.2, ST_SetSRID(ST_MakePoint(73.8567, 18.5204), 4326)),
('Ahmedabad', 'Gujarat', 23.0225, 72.5714, 15, 0.5, 1.1, ST_SetSRID(ST_MakePoint(72.5714, 23.0225), 4326)),
('Jaipur', 'Rajasthan', 26.9124, 75.7873, 14, 0.5, 1.1, ST_SetSRID(ST_MakePoint(75.7873, 26.9124), 4326)),
('Lucknow', 'Uttar Pradesh', 26.8467, 80.9462, 14, 0.5, 1.0, ST_SetSRID(ST_MakePoint(80.9462, 26.8467), 4326)),
('Chandigarh', 'Chandigarh', 30.7333, 76.7794, 12, 0.5, 1.0, ST_SetSRID(ST_MakePoint(76.7794, 30.7333), 4326)),
('Goa', 'Goa', 15.2993, 74.1240, 12, 0.5, 1.0, ST_SetSRID(ST_MakePoint(74.1240, 15.2993), 4326)),
('Kochi', 'Kerala', 9.9312, 76.2673, 12, 0.5, 1.0, ST_SetSRID(ST_MakePoint(76.2673, 9.9312), 4326)),
('Indore', 'Madhya Pradesh', 22.7196, 75.8577, 12, 0.5, 1.0, ST_SetSRID(ST_MakePoint(75.8577, 22.7196), 4326)),
('Coimbatore', 'Tamil Nadu', 11.0168, 76.9558, 12, 0.5, 1.0, ST_SetSRID(ST_MakePoint(76.9558, 11.0168), 4326))
ON CONFLICT DO NOTHING;
