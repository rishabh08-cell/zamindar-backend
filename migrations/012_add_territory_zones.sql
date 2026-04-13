-- Migration 012: Territory sub-zones defence system
-- Run in: Supabase Dashboard > SQL Editor (after 001–011)

-- ── TERRITORY SUB-ZONES TABLE ───────────────────────────────────────
-- Smaller sub-divisions of a parent zone.  Each sub-zone has its own
-- defence score that decays over time (half-life) and can be eroded
-- by attackers or restored by patrols.

CREATE TABLE IF NOT EXISTS territory_zones (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_zone_id   UUID NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
    owner_user_id    UUID NOT NULL REFERENCES users(id),
    zone_polygon     GEOMETRY(Polygon, 4326) NOT NULL,
    area_m2          NUMERIC NOT NULL DEFAULT 0,
    base_defence     NUMERIC NOT NULL DEFAULT 1.0,
    last_patrolled_at TIMESTAMPTZ DEFAULT NOW(),
    half_life_days   NUMERIC NOT NULL DEFAULT 7.0,
    is_active        BOOLEAN DEFAULT TRUE,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_territory_zones_parent ON territory_zones(parent_zone_id);
CREATE INDEX IF NOT EXISTS idx_territory_zones_owner  ON territory_zones(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_territory_zones_geom   ON territory_zones USING GIST(zone_polygon);
CREATE INDEX IF NOT EXISTS idx_territory_zones_active ON territory_zones(is_active) WHERE is_active = TRUE;

-- ── ZONE ATTACKS TABLE ──────────────────────────────────────────────
-- Log every attack on a territory sub-zone.

CREATE TABLE IF NOT EXISTS zone_attacks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    territory_zone_id   UUID NOT NULL REFERENCES territory_zones(id) ON DELETE CASCADE,
    parent_zone_id      UUID REFERENCES zones(id) ON DELETE SET NULL,
    attacker_user_id    UUID NOT NULL REFERENCES users(id),
    run_id              UUID REFERENCES runs(id),
    erosion_applied     NUMERIC NOT NULL DEFAULT 0,
    loop_count          INTEGER NOT NULL DEFAULT 1,
    defence_before      NUMERIC NOT NULL DEFAULT 0,
    defence_after       NUMERIC NOT NULL DEFAULT 0,
    attack_polygon      GEOMETRY(Polygon, 4326),
    resulted_in_transfer BOOLEAN DEFAULT FALSE,
    attacked_at         TIMESTAMPTZ DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_zone_attacks_zone     ON zone_attacks(territory_zone_id);
CREATE INDEX IF NOT EXISTS idx_zone_attacks_attacker ON zone_attacks(attacker_user_id);
CREATE INDEX IF NOT EXISTS idx_zone_attacks_time     ON zone_attacks(attacked_at DESC);

-- ── ZONE PATROLS TABLE ──────────────────────────────────────────────
-- Log every patrol that restores defence on a territory sub-zone.

CREATE TABLE IF NOT EXISTS zone_patrols (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    territory_zone_id   UUID NOT NULL REFERENCES territory_zones(id) ON DELETE CASCADE,
    parent_zone_id      UUID REFERENCES zones(id) ON DELETE SET NULL,
    patroller_user_id   UUID NOT NULL REFERENCES users(id),
    run_id              UUID REFERENCES runs(id),
    patrol_polygon      GEOMETRY(Polygon, 4326),
    coverage_pct        NUMERIC DEFAULT 1.0,
    defence_before      NUMERIC NOT NULL DEFAULT 0,
    defence_after       NUMERIC NOT NULL DEFAULT 0,
    patrolled_at        TIMESTAMPTZ DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_zone_patrols_zone      ON zone_patrols(territory_zone_id);
CREATE INDEX IF NOT EXISTS idx_zone_patrols_patroller ON zone_patrols(patroller_user_id);
CREATE INDEX IF NOT EXISTS idx_zone_patrols_time      ON zone_patrols(patrolled_at DESC);
