-- Migration 009: Add home city to users
-- When users sign up, they pick their city. The map centers on it by default.

ALTER TABLE users ADD COLUMN IF NOT EXISTS home_city_id UUID REFERENCES cities(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_home_city ON users(home_city_id);
