-- MEHRAN INTELLIGENCE owner-confirmed knowledge relationships.
-- Apply only to a dedicated non-production D1 database during validation.
-- Relationships are metadata, never permissions or automatic truth selection.

CREATE TABLE IF NOT EXISTS intelligence_knowledge_relations (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  source_knowledge_id TEXT NOT NULL,
  target_knowledge_id TEXT NOT NULL,
  relation_type TEXT NOT NULL
    CHECK (relation_type IN ('conflicts_with', 'supersedes', 'supports')),
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'confirmed', 'dismissed', 'resolved')),
  source_evidence TEXT NOT NULL
    CHECK (length(trim(source_evidence)) BETWEEN 1 AND 500),
  target_evidence TEXT NOT NULL
    CHECK (length(trim(target_evidence)) BETWEEN 1 AND 500),
  resolved_knowledge_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TEXT,
  dismissed_at TEXT,
  FOREIGN KEY (source_knowledge_id) REFERENCES intelligence_knowledge(id) ON DELETE RESTRICT,
  FOREIGN KEY (target_knowledge_id) REFERENCES intelligence_knowledge(id) ON DELETE RESTRICT,
  FOREIGN KEY (resolved_knowledge_id) REFERENCES intelligence_knowledge(id) ON DELETE RESTRICT,
  CHECK (source_knowledge_id <> target_knowledge_id),
  CHECK (relation_type <> 'conflicts_with' OR source_knowledge_id < target_knowledge_id),
  CHECK (
    (status = 'resolved' AND resolved_knowledge_id IN (source_knowledge_id, target_knowledge_id))
    OR (status <> 'resolved' AND resolved_knowledge_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_intelligence_knowledge_relation_unique
  ON intelligence_knowledge_relations(owner_uid, source_knowledge_id, target_knowledge_id, relation_type);

CREATE INDEX IF NOT EXISTS idx_intelligence_knowledge_relation_owner_status
  ON intelligence_knowledge_relations(owner_uid, status, updated_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_intelligence_knowledge_relation_owner_insert
BEFORE INSERT ON intelligence_knowledge_relations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM intelligence_knowledge s
    JOIN intelligence_knowledge t ON t.id = NEW.target_knowledge_id
    WHERE s.id = NEW.source_knowledge_id
      AND s.owner_uid = NEW.owner_uid
      AND t.owner_uid = NEW.owner_uid
      AND NEW.owner_uid <> 'system_seed'
  ) THEN RAISE(ABORT, 'knowledge relationship owner mismatch') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_knowledge_relation_owner_update
BEFORE UPDATE OF owner_uid, source_knowledge_id, target_knowledge_id
ON intelligence_knowledge_relations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM intelligence_knowledge s
    JOIN intelligence_knowledge t ON t.id = NEW.target_knowledge_id
    WHERE s.id = NEW.source_knowledge_id
      AND s.owner_uid = NEW.owner_uid
      AND t.owner_uid = NEW.owner_uid
      AND NEW.owner_uid <> 'system_seed'
  ) THEN RAISE(ABORT, 'knowledge relationship owner mismatch') END;
END;
