-- Enforce integer confidence scores for private owner memory at the database boundary.
-- Apply only after migrations 0000-0005 on mehran-msh-intelligence-staging.
-- Worker validation remains in place; these triggers protect direct/future DB writers.

CREATE TRIGGER IF NOT EXISTS trg_intelligence_owner_memory_confidence_integer_insert
BEFORE INSERT ON intelligence_owner_memory
WHEN NEW.confidence_score IS NOT NULL
  AND typeof(NEW.confidence_score) <> 'integer'
BEGIN
  SELECT RAISE(ABORT, 'owner memory confidence score must be an integer');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_owner_memory_confidence_integer_update
BEFORE UPDATE OF confidence_score ON intelligence_owner_memory
WHEN NEW.confidence_score IS NOT NULL
  AND typeof(NEW.confidence_score) <> 'integer'
BEGIN
  SELECT RAISE(ABORT, 'owner memory confidence score must be an integer');
END;
