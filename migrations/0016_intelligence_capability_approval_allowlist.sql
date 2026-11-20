-- Keep the capability approval ledger aligned with the Worker allowlist.
-- memory.delete is permanently disabled until a separately reviewed deletion
-- workflow exists. This guard also protects direct SQL writes that bypass HTTP.
CREATE TRIGGER IF NOT EXISTS trg_intelligence_capability_approval_capability_guard
BEFORE INSERT ON intelligence_capability_approvals
WHEN NEW.capability NOT IN ('knowledge.create', 'memory.create', 'knowledge.review')
BEGIN
  SELECT RAISE(ABORT, 'capability is not available for approval');
END;
