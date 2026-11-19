-- Dedicated INTELLIGENCE staging support tables.
-- Apply only to mehran-msh-intelligence-staging after migrations 0000-0002.
-- No production sessions, owner identifiers, or audit history are copied.

CREATE TABLE IF NOT EXISTS intelligence_staging_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  owner_uid TEXT NOT NULL CHECK(length(owner_uid) > 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK(expires_at > created_at),
  CHECK(revoked_at IS NULL OR revoked_at >= created_at)
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
  request_count INTEGER NOT NULL DEFAULT 0 CHECK(request_count > 0),
  blocked_until INTEGER,
  CHECK(blocked_until IS NULL OR blocked_until >= window_started_at)
);
CREATE INDEX IF NOT EXISTS idx_intelligence_staging_rate_limits_window
  ON intelligence_staging_rate_limits(window_started_at);

CREATE TABLE IF NOT EXISTS intelligence_owner_memory (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general' CHECK(length(category) BETWEEN 1 AND 40),
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 4000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_intelligence_owner_memory_owner
  ON intelligence_owner_memory(owner_uid, updated_at DESC);

-- Approval invariants are enforced in the database, not only in the Worker.
CREATE TRIGGER IF NOT EXISTS trg_intelligence_approval_scope_guard
BEFORE INSERT ON intelligence_approval_ledger
WHEN NEW.expires_at <= NEW.issued_at
  OR NEW.expires_at > NEW.issued_at + 3600
  OR length(NEW.scope_json) > 4096
  OR json_valid(NEW.scope_json) = 0
  OR json_type(NEW.scope_json) <> 'object'
  OR NOT EXISTS (SELECT 1 FROM json_each(NEW.scope_json))
BEGIN
  SELECT RAISE(ABORT, 'invalid approval scope or lifetime');
END;

-- Expiring an issued approval is a state transition and must leave an audit row.
CREATE TRIGGER IF NOT EXISTS trg_intelligence_approval_expiry_audit
AFTER UPDATE OF status ON intelligence_approval_ledger
WHEN OLD.status = 'issued' AND NEW.status = 'expired'
BEGIN
  INSERT INTO intelligence_staging_audit
    (id, owner_uid, action, target_type, target_id, details_json, created_at)
  VALUES (
    lower(hex(randomblob(16))), NEW.owner_uid, 'approval_expired',
    'approval', NEW.id, '{}', CAST(strftime('%s','now') AS INTEGER)
  );
END;
