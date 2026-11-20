-- Owner identity is permanent for knowledge and owner memory.
-- Prevent direct D1 writes from transferring private records between owners.

CREATE TRIGGER IF NOT EXISTS trg_intelligence_knowledge_owner_uid_immutable
BEFORE UPDATE OF owner_uid ON intelligence_knowledge
WHEN NEW.owner_uid IS NOT OLD.owner_uid
BEGIN
  SELECT RAISE(ABORT, 'knowledge owner identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_owner_memory_owner_uid_immutable
BEFORE UPDATE OF owner_uid ON intelligence_owner_memory
WHEN NEW.owner_uid IS NOT OLD.owner_uid
BEGIN
  SELECT RAISE(ABORT, 'owner memory identity is immutable');
END;
