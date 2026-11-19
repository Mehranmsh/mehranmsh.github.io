-- Additive knowledge provenance fields for isolated INTELLIGENCE staging.
-- Apply only after migrations 0000-0003 on mehran-msh-intelligence-staging.
-- This migration does not ingest sources or verify claims automatically.

ALTER TABLE intelligence_knowledge
  ADD COLUMN source_type TEXT NOT NULL DEFAULT 'owner_input'
  CHECK (source_type IN ('owner_input','uploaded_document','external_url','system_observation'));

ALTER TABLE intelligence_knowledge
  ADD COLUMN source_ref TEXT NOT NULL DEFAULT ''
  CHECK (length(source_ref) <= 1000 AND instr(source_ref, char(10)) = 0 AND instr(source_ref, char(13)) = 0);

ALTER TABLE intelligence_knowledge
  ADD COLUMN observed_at TEXT NOT NULL DEFAULT ''
  CHECK (length(observed_at) <= 40);

ALTER TABLE intelligence_knowledge
  ADD COLUMN confidence_score INTEGER
  CHECK (confidence_score IS NULL OR (typeof(confidence_score) = 'integer' AND confidence_score BETWEEN 0 AND 100));

ALTER TABLE intelligence_knowledge
  ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unreviewed'
  CHECK (verification_status IN ('unreviewed','owner_verified','disputed'));

CREATE TRIGGER IF NOT EXISTS trg_intelligence_knowledge_provenance_guard_insert
BEFORE INSERT ON intelligence_knowledge
WHEN (NEW.source_type = 'external_url' AND (
       substr(lower(NEW.source_ref),1,8) <> 'https://'
       OR instr(substr(NEW.source_ref,9), '@') > 0
     ))
  OR (NEW.source_type <> 'external_url' AND length(NEW.source_ref) > 1000)
  OR (NEW.observed_at <> '' AND (
       length(NEW.observed_at) < 20
       OR substr(NEW.observed_at,11,1) <> 'T'
       OR substr(NEW.observed_at,20,1) NOT IN ('Z','+','-')
     ))
BEGIN
  SELECT RAISE(ABORT, 'invalid knowledge provenance');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_knowledge_provenance_guard_update
BEFORE UPDATE OF source_type, source_ref, observed_at, confidence_score
ON intelligence_knowledge
WHEN (NEW.source_type = 'external_url' AND (
       substr(lower(NEW.source_ref),1,8) <> 'https://'
       OR instr(substr(NEW.source_ref,9), '@') > 0
     ))
  OR (NEW.observed_at <> '' AND (
       length(NEW.observed_at) < 20
       OR substr(NEW.observed_at,11,1) <> 'T'
       OR substr(NEW.observed_at,20,1) NOT IN ('Z','+','-')
     ))
  OR EXISTS (
       SELECT 1 FROM intelligence_knowledge_relations r
       WHERE r.owner_uid = OLD.owner_uid
         AND (r.source_knowledge_id = OLD.id OR r.target_knowledge_id = OLD.id)
     )
BEGIN
  SELECT RAISE(ABORT, 'invalid or evidence-linked knowledge provenance');
END;
