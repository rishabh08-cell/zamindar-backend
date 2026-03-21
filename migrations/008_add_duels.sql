-- Migration 008: Dwandva (Duel) system — friendly challenges between fauj mates
-- Depends on: 007_add_dost_fauj.sql

CREATE TABLE IF NOT EXISTS duels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    challenger_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    opponent_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fauj_id         UUID NOT NULL REFERENCES faujs(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'completed', 'cancelled')),
    expires_at      TIMESTAMPTZ,        -- when the duel window ends (set on accept)
    winner_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT duels_no_self CHECK (challenger_id != opponent_id)
);

CREATE INDEX IF NOT EXISTS idx_duels_challenger ON duels(challenger_id);
CREATE INDEX IF NOT EXISTS idx_duels_opponent ON duels(opponent_id);
CREATE INDEX IF NOT EXISTS idx_duels_status ON duels(status) WHERE status IN ('pending', 'accepted');
CREATE INDEX IF NOT EXISTS idx_duels_expires ON duels(expires_at) WHERE status = 'accepted';

ALTER TABLE duels ENABLE ROW LEVEL SECURITY;
