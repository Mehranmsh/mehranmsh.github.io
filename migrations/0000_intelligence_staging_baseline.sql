-- MEHRAN INTELLIGENCE isolated staging prerequisites.
-- Apply ONLY to a newly created, empty, non-production D1 database.
-- This is a minimal schema baseline for validating migrations 0001 and 0002.
-- It intentionally creates no owner, admin, session, or production data.

CREATE TABLE IF NOT EXISTS intelligence_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assigned_to TEXT NOT NULL DEFAULT 'mehran_intelligence',
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'queued',
  requires_approval INTEGER NOT NULL DEFAULT 0,
  result_text TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  action_type TEXT NOT NULL DEFAULT '',
  action_payload TEXT NOT NULL DEFAULT '{}',
  agent_claimed_at TEXT,
  agent_claim_id TEXT,
  scheduler_claimed_at TEXT,
  scheduler_claim_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_intelligence_tasks_queue
  ON intelligence_tasks(status, assigned_to, created_at);

CREATE TABLE IF NOT EXISTS intelligence_knowledge (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'company',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  importance TEXT NOT NULL DEFAULT 'normal',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_intelligence_knowledge_owner_active
  ON intelligence_knowledge(owner_uid, archived_at, importance, updated_at DESC);
