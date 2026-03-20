-- Zamindar Migration 006: Decouple User Identity from Strava
-- Users are independent entities. Strava (and future data sources) are linked connections.
-- Run in: Supabase Dashboard > SQL Editor (after 001–005)

-- ─── STRAVA CONNECTIONS TABLE ────────────────────────────────────────────────
-- Holds all Strava-specific data that was previously on the users table.
-- One user can have one Strava connection. In future, similar tables for
-- Garmin, Apple Health, etc.

CREATE TABLE IF NOT EXISTS strava_connections (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strava_id     BIGINT UNIQUE NOT NULL,
    access_token  TEXT,
    refresh_token TEXT,
    token_expires_at TIMESTAMPTZ,
    scopes        TEXT DEFAULT 'activity:read_all',
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id)   -- one Strava connection per user
);

CREATE INDEX IF NOT EXISTS idx_strava_connections_user_id ON strava_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_strava_connections_strava_id ON strava_connections(strava_id);

-- ─── MIGRATE EXISTING DATA ──────────────────────────────────────────────────
-- Move Strava tokens from users → strava_connections for all existing users.

INSERT INTO strava_connections (user_id, strava_id, access_token, refresh_token, token_expires_at)
SELECT id, strava_id, access_token, refresh_token, token_expires_at
FROM users
WHERE strava_id IS NOT NULL
ON CONFLICT (strava_id) DO NOTHING;

-- ─── ADD NEW COLUMNS TO USERS ───────────────────────────────────────────────
-- Email + password for standalone auth. Both nullable so existing
-- Strava-only users keep working.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Make strava_id nullable — users no longer require Strava to exist.
-- First drop the NOT NULL constraint, keep UNIQUE for backward compat.
ALTER TABLE users ALTER COLUMN strava_id DROP NOT NULL;

-- ─── SESSIONS TABLE ─────────────────────────────────────────────────────────
-- Simple JWT session tracking. Enables sign-out and multi-device management.

CREATE TABLE IF NOT EXISTS sessions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL,     -- SHA-256 of the JWT for revocation checks
  device_info  TEXT,              -- User-Agent or device identifier
  expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ─── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE strava_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

-- ─── CLEANUP HELPER ──────────────────────────────────────────────────────────
-- Cron-friendly function to purge expired sessions.
CREATE OR REPLACE FUNCTION cleanup_expired_sessions()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM sessions WHERE expires_at < NOW();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
