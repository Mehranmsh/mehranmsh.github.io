-- MEHRAN INTELLIGENCE scoped approval ledger.
-- Apply only to a dedicated non-production D1 database during validation.
-- The migration is idempotent so it can coexist with the Worker bootstrap helper.

CREATE TABLE IF NOT EXISTS intelligence_approval_ledger (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  owner_username TEXT NOT NULL,
  repository TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  scope_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued'
    CHECK (status IN ('issued', 'revoked', 'consumed', 'expired')),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  consumed_at INTEGER,
  consumed_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES intelligence_tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_intelligence_approval_task
  ON intelligence_approval_ledger(task_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_intelligence_approval_owner
  ON intelligence_approval_ledger(owner_uid, issued_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_intelligence_approval_active_task
  ON intelligence_approval_ledger(task_id, owner_uid)
  WHERE status = 'issued';
