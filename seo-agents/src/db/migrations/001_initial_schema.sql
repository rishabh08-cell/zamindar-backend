-- CMS Connector - Initial Schema
-- Run against Supabase PostgreSQL

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- Users
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  google_access_token TEXT,
  google_refresh_token TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CMS Connections (one user can have many)
-- ============================================================
CREATE TABLE IF NOT EXISTS cms_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('wordpress', 'strapi')),
  site_url TEXT NOT NULL,
  site_name TEXT NOT NULL DEFAULT '',
  credentials_encrypted TEXT NOT NULL,
  schema_cache JSONB,
  is_active BOOLEAN DEFAULT TRUE,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, platform, site_url)
);

CREATE INDEX idx_cms_connections_user ON cms_connections(user_id);

-- ============================================================
-- Content Sources (Google Docs, Sheets, Pepper, etc.)
-- ============================================================
CREATE TABLE IF NOT EXISTS content_sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('google_doc', 'google_sheet', 'pepper_doc')),
  source_ref TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  column_mapping JSONB,
  last_fetched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_content_sources_user ON content_sources(user_id);

-- ============================================================
-- Publications (tracks what's published where)
-- ============================================================
CREATE TABLE IF NOT EXISTS publications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_source_id UUID REFERENCES content_sources(id) ON DELETE SET NULL,
  cms_connection_id UUID NOT NULL REFERENCES cms_connections(id) ON DELETE CASCADE,
  cms_post_id TEXT,
  cms_post_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'pending_review', 'needs_input', 'publishing', 'published', 'failed', 'update_available')
  ),
  content_snapshot JSONB NOT NULL,
  field_mapping JSONB DEFAULT '{}',
  missing_fields JSONB DEFAULT '[]',
  error_message TEXT,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_publications_user ON publications(user_id);
CREATE INDEX idx_publications_cms ON publications(cms_connection_id);
CREATE INDEX idx_publications_status ON publications(status);

-- ============================================================
-- Publish Logs (audit trail)
-- ============================================================
CREATE TABLE IF NOT EXISTS publish_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  publication_id UUID NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'sync', 'audit')),
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_publish_logs_publication ON publish_logs(publication_id);

-- ============================================================
-- SEO Playbooks (per-user overrides)
-- ============================================================
CREATE TABLE IF NOT EXISTS seo_playbooks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Default',
  content TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_seo_playbooks_user ON seo_playbooks(user_id);

-- ============================================================
-- Updated_at trigger
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_cms_connections_updated_at BEFORE UPDATE ON cms_connections FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_content_sources_updated_at BEFORE UPDATE ON content_sources FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_publications_updated_at BEFORE UPDATE ON publications FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_seo_playbooks_updated_at BEFORE UPDATE ON seo_playbooks FOR EACH ROW EXECUTE FUNCTION update_updated_at();
