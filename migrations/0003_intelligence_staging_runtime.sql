-- Dedicated INTELLIGENCE staging support tables.
-- Apply only to mehran-msh-intelligence-staging after migrations 0000-0002.
-- No production sessions, owner identifiers, or audit history are copied.

CREATE TABLE IF NOT EXISTS intelligence_staging_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  owner_uid TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_intelligence_staging_sessions_owner
  ON intelligence_staging_sessions(owner_uid, expires_at);

CREATE TABLE IF NOT EXISTS intelligence_staging_audit (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intelligence_staging_audit_owner
  ON intelligence_staging_audit(owner_uid, created_at DESC);

CREATE TABLE IF NOT EXISTS intelligence_staging_rate_limits (
  rate_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER
);
CREATE INDEX IF NOT EXISTS idx_intelligence_staging_rate_limits_window
  ON intelligence_staging_rate_limits(window_started_at);

CREATE TABLE IF NOT EXISTS intelligence_owner_memory (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_intelligence_owner_memory_owner
  ON intelligence_owner_memory(owner_uid, updated_at DESC);
