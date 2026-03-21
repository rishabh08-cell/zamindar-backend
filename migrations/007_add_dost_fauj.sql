-- Migration 007: Friends (Dost) and Armies (Fauj) system
-- Depends on: 006_user_identity_and_strava_connections.sql

-- ─── Friendships (Dost) ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS friendships (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'blocked')),
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT friendships_no_self CHECK (requester_id != recipient_id),
    CONSTRAINT friendships_unique_pair UNIQUE (requester_id, recipient_id)
);

CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id);
CREATE INDEX IF NOT EXISTS idx_friendships_recipient ON friendships(recipient_id);
CREATE INDEX IF NOT EXISTS idx_friendships_status ON friendships(status);

-- ─── Armies (Fauj) ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS faujs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL UNIQUE,
    leader_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    color           TEXT NOT NULL DEFAULT '#ff6b00',
    max_members     INTEGER NOT NULL DEFAULT 8,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_faujs_leader ON faujs(leader_id);

CREATE TABLE IF NOT EXISTS fauj_members (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fauj_id         UUID NOT NULL REFERENCES faujs(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'sipahi' CHECK (role IN ('senapati', 'sipahi')),
    joined_at       TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT fauj_members_unique_user UNIQUE (user_id)  -- one fauj per user
);

CREATE INDEX IF NOT EXISTS idx_fauj_members_fauj ON fauj_members(fauj_id);
CREATE INDEX IF NOT EXISTS idx_fauj_members_user ON fauj_members(user_id);

-- ─── Fauj Invites ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fauj_invites (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fauj_id         UUID NOT NULL REFERENCES faujs(id) ON DELETE CASCADE,
    invited_by      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invited_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT fauj_invites_unique UNIQUE (fauj_id, invited_user_id)
);

CREATE INDEX IF NOT EXISTS idx_fauj_invites_user ON fauj_invites(invited_user_id);
CREATE INDEX IF NOT EXISTS idx_fauj_invites_fauj ON fauj_invites(fauj_id);

-- ─── Fauj leave cooldown tracking ───────────────────────────────────────────
-- Stored on users table as a nullable timestamp
ALTER TABLE users ADD COLUMN IF NOT EXISTS fauj_cooldown_until TIMESTAMPTZ;

-- ─── Enable RLS ─────────────────────────────────────────────────────────────
ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE faujs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fauj_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE fauj_invites ENABLE ROW LEVEL SECURITY;
