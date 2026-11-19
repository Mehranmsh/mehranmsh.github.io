-- Owner-memory governance and provenance for the isolated INTELLIGENCE staging DB.
-- Apply only after migrations 0000-0004 on mehran-msh-intelligence-staging.
-- This migration is additive and intentionally not idempotent.

ALTER TABLE intelligence_owner_memory
  ADD COLUMN memory_kind TEXT NOT NULL DEFAULT 'general'
  CHECK(memory_kind IN ('general','preference','goal','constraint','decision','project_context'));

ALTER TABLE intelligence_owner_memory
  ADD COLUMN source_type TEXT NOT NULL DEFAULT 'owner_input'
  CHECK(source_type IN ('owner_input','knowledge_record','system_observation'));

ALTER TABLE intelligence_owner_memory
  ADD COLUMN source_ref TEXT
  CHECK(source_ref IS NULL OR (length(source_ref) BETWEEN 1 AND 1000 AND instr(source_ref, char(10)) = 0 AND instr(source_ref, char(13)) = 0));

ALTER TABLE intelligence_owner_memory
  ADD COLUMN confidence_score INTEGER
  CHECK(confidence_score IS NULL OR confidence_score BETWEEN 0 AND 100);

ALTER TABLE intelligence_owner_memory
  ADD COLUMN review_status TEXT NOT NULL DEFAULT 'unreviewed'
  CHECK(review_status IN ('unreviewed','owner_confirmed','disputed'));

ALTER TABLE intelligence_owner_memory
  ADD COLUMN reviewed_at TEXT;

ALTER TABLE intelligence_owner_memory
  ADD COLUMN archived_at TEXT;

CREATE INDEX IF NOT EXISTS idx_intelligence_owner_memory_review
  ON intelligence_owner_memory(owner_uid, review_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_owner_memory_active
  ON intelligence_owner_memory(owner_uid, archived_at, updated_at DESC);

-- Provenance must identify a knowledge record owned by the same Pi owner.
CREATE TRIGGER IF NOT EXISTS trg_intelligence_owner_memory_knowledge_source_insert
BEFORE INSERT ON intelligence_owner_memory
WHEN NEW.source_type = 'knowledge_record'
  AND NOT EXISTS (
    SELECT 1 FROM intelligence_knowledge k
    WHERE k.id = NEW.source_ref AND k.owner_uid = NEW.owner_uid
  )
BEGIN
  SELECT RAISE(ABORT, 'memory knowledge source must belong to the same owner');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_owner_memory_knowledge_source_update
BEFORE UPDATE OF source_type, source_ref, owner_uid ON intelligence_owner_memory
WHEN NEW.source_type = 'knowledge_record'
  AND NOT EXISTS (
    SELECT 1 FROM intelligence_knowledge k
    WHERE k.id = NEW.source_ref AND k.owner_uid = NEW.owner_uid
  )
BEGIN
  SELECT RAISE(ABORT, 'memory knowledge source must belong to the same owner');
END;

-- A memory's source identity is immutable after creation. Corrected provenance
-- requires a new memory record, preserving the original evidence trail.
CREATE TRIGGER IF NOT EXISTS trg_intelligence_owner_memory_provenance_immutable
BEFORE UPDATE OF source_type, source_ref ON intelligence_owner_memory
WHEN OLD.source_type <> NEW.source_type
  OR COALESCE(OLD.source_ref, '') <> COALESCE(NEW.source_ref, '')
BEGIN
  SELECT RAISE(ABORT, 'owner memory provenance is immutable');
END;

-- Direct database writes must obey the same source semantics as the Worker.
-- Owner-entered memories cannot carry a misleading external/knowledge locator.
CREATE TRIGGER IF NOT EXISTS trg_intelligence_owner_memory_owner_input_source_insert
BEFORE INSERT ON intelligence_owner_memory
WHEN NEW.source_type = 'owner_input' AND NEW.source_ref IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'owner_input memory cannot have a source reference');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_owner_memory_owner_input_source_update
BEFORE UPDATE OF source_type, source_ref ON intelligence_owner_memory
WHEN NEW.source_type = 'owner_input' AND NEW.source_ref IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'owner_input memory cannot have a source reference');
END;

-- Archiving is reversible and distinct from deletion. Review metadata can still
-- be updated while archived; the owner remains the only authenticated reviewer.
