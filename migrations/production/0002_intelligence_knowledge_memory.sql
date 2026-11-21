-- Owner-scoped MEHRAN Intelligence knowledge and explicit memory.
-- Apply only after production migration 0001 and a verified production schema review.
-- No automatic ingestion, external fetching, or autonomous memory writes.

CREATE TABLE IF NOT EXISTS intelligence_knowledge (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'company',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  importance TEXT NOT NULL DEFAULT 'normal'
    CHECK (importance IN ('high','normal','low')),
  source_type TEXT NOT NULL DEFAULT 'owner_input'
    CHECK (source_type IN ('owner_input','uploaded_document','external_url','system_observation')),
  source_ref TEXT NOT NULL DEFAULT '',
  source_title TEXT NOT NULL DEFAULT '',
  source_excerpt TEXT NOT NULL DEFAULT '',
  observed_at TEXT,
  recorded_confidence INTEGER
    CHECK (recorded_confidence IS NULL OR recorded_confidence BETWEEN 0 AND 100),
  verification_status TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (verification_status IN ('unreviewed','owner_verified','disputed')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_intelligence_knowledge_owner_active
  ON intelligence_knowledge(owner_uid, archived_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_intelligence_knowledge_owner_category
  ON intelligence_knowledge(owner_uid, category, archived_at);

CREATE TABLE IF NOT EXISTS intelligence_owner_memory (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  memory_type TEXT NOT NULL DEFAULT 'fact'
    CHECK (memory_type IN ('fact','preference','instruction','project_decision')),
  category TEXT NOT NULL DEFAULT 'general',
  content TEXT NOT NULL,
  importance TEXT NOT NULL DEFAULT 'normal'
    CHECK (importance IN ('high','normal','low')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_intelligence_memory_owner_active
  ON intelligence_owner_memory(owner_uid, archived_at, updated_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_intelligence_knowledge_owner_immutable
BEFORE UPDATE OF owner_uid ON intelligence_knowledge
WHEN NEW.owner_uid <> OLD.owner_uid
BEGIN SELECT RAISE(ABORT, 'knowledge owner is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_memory_owner_immutable
BEFORE UPDATE OF owner_uid ON intelligence_owner_memory
WHEN NEW.owner_uid <> OLD.owner_uid
BEGIN SELECT RAISE(ABORT, 'memory owner is immutable'); END;
