-- MEHRAN INTELLIGENCE owner-scoped knowledge relationships.
-- Apply only to a dedicated non-production D1 database during validation.
-- Historical knowledge records are never deleted or rewritten by this migration.

CREATE TABLE IF NOT EXISTS intelligence_knowledge_relationships (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  left_knowledge_id TEXT NOT NULL,
  right_knowledge_id TEXT NOT NULL,
  relation_type TEXT NOT NULL
    CHECK (relation_type IN ('conflicts_with', 'supersedes', 'supports')),
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'confirmed', 'dismissed', 'resolved')),
  proposed_by TEXT NOT NULL
    CHECK (proposed_by IN ('owner', 'intelligence')),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  direction_from_knowledge_id TEXT,
  direction_to_knowledge_id TEXT,
  resolution_knowledge_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TEXT,
  dismissed_at TEXT,
  resolved_at TEXT,
  CHECK (left_knowledge_id < right_knowledge_id),
  CHECK (
    (relation_type = 'conflicts_with' AND direction_from_knowledge_id IS NULL AND direction_to_knowledge_id IS NULL)
    OR (relation_type IN ('supersedes', 'supports')
      AND direction_from_knowledge_id IS NOT NULL
      AND direction_to_knowledge_id IS NOT NULL
      AND direction_from_knowledge_id IN (left_knowledge_id, right_knowledge_id)
      AND direction_to_knowledge_id IN (left_knowledge_id, right_knowledge_id)
      AND direction_from_knowledge_id <> direction_to_knowledge_id)
  ),
  CHECK (
    (status = 'resolved' AND relation_type = 'conflicts_with' AND resolution_knowledge_id IS NOT NULL AND resolution_knowledge_id IN (left_knowledge_id, right_knowledge_id))
    OR (status <> 'resolved' AND resolution_knowledge_id IS NULL)
  ),
  FOREIGN KEY (left_knowledge_id) REFERENCES intelligence_knowledge(id),
  FOREIGN KEY (right_knowledge_id) REFERENCES intelligence_knowledge(id),
  FOREIGN KEY (direction_from_knowledge_id) REFERENCES intelligence_knowledge(id),
  FOREIGN KEY (direction_to_knowledge_id) REFERENCES intelligence_knowledge(id),
  FOREIGN KEY (resolution_knowledge_id) REFERENCES intelligence_knowledge(id),
  UNIQUE (owner_uid, left_knowledge_id, right_knowledge_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_intelligence_knowledge_relationship_owner_status
  ON intelligence_knowledge_relationships(owner_uid, status, updated_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_intelligence_relationship_owner_insert
BEFORE INSERT ON intelligence_knowledge_relationships
BEGIN
  SELECT CASE WHEN NEW.owner_uid = 'system_seed'
    THEN RAISE(ABORT, 'system knowledge relationships are immutable') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM intelligence_knowledge
    WHERE id = NEW.left_knowledge_id AND owner_uid = NEW.owner_uid AND archived_at IS NULL
  ) THEN RAISE(ABORT, 'left knowledge must be active and owned by relationship owner') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM intelligence_knowledge
    WHERE id = NEW.right_knowledge_id AND owner_uid = NEW.owner_uid AND archived_at IS NULL
  ) THEN RAISE(ABORT, 'right knowledge must be active and owned by relationship owner') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_relationship_owner_update
BEFORE UPDATE ON intelligence_knowledge_relationships
BEGIN
  SELECT CASE WHEN NEW.owner_uid = 'system_seed'
    THEN RAISE(ABORT, 'system knowledge relationships are immutable') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM intelligence_knowledge
    WHERE id = NEW.left_knowledge_id AND owner_uid = NEW.owner_uid
  ) THEN RAISE(ABORT, 'left knowledge must be owned by relationship owner') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM intelligence_knowledge
    WHERE id = NEW.right_knowledge_id AND owner_uid = NEW.owner_uid
  ) THEN RAISE(ABORT, 'right knowledge must be owned by relationship owner') END;
END;
