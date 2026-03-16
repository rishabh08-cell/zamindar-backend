-- ============================================================
-- Zamindar — Enable Supabase Realtime
-- Run in: Supabase Dashboard → SQL Editor
-- AFTER 001 and 002 migrations
-- ============================================================

-- Enable realtime publication for tables we want to broadcast changes from.
-- Supabase listens to these via Postgres logical replication (wal2json).

-- Add tables to the supabase_realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE runs;
ALTER PUBLICATION supabase_realtime ADD TABLE zone_conflicts;
ALTER PUBLICATION supabase_realtime ADD TABLE cities;
ALTER PUBLICATION supabase_realtime ADD TABLE users;

-- Note: we use Supabase Broadcast (server → client push) rather than
-- Postgres Changes (DB change → client) for territory updates.
-- This is intentional — Broadcast lets us shape the payload precisely
-- (sending pre-computed GeoJSON diffs) rather than raw row data.
-- Postgres Changes are still useful for debugging in the Supabase dashboard.

-- Verify realtime is enabled
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
ORDER BY tablename;
