-- Protect the shared staging audit ledger from post-write tampering.
-- Approval lifecycle timestamps must also be bounded by the immutable issue time
-- and the database clock; future-dated or pre-issue terminal events are rejected.

CREATE TRIGGER IF NOT EXISTS trg_intelligence_staging_audit_no_update
BEFORE UPDATE ON intelligence_staging_audit
BEGIN
  SELECT RAISE(ABORT, 'staging audit records are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_staging_audit_no_delete
BEFORE DELETE ON intelligence_staging_audit
BEGIN
  SELECT RAISE(ABORT, 'staging audit records are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_capability_approval_terminal_timestamp_guard
BEFORE UPDATE OF status, revoked_at, consumed_at, consumed_by
ON intelligence_capability_approvals
WHEN OLD.status = 'issued'
 AND (
   (NEW.status = 'revoked' AND (
     NEW.revoked_at IS NULL
     OR NEW.revoked_at < OLD.issued_at
     OR NEW.revoked_at > CAST(strftime('%s','now') AS INTEGER)
     OR NEW.consumed_at IS NOT NULL
     OR NEW.consumed_by IS NOT NULL
   ))
   OR
   (NEW.status = 'consumed' AND (
     NEW.consumed_at IS NULL
     OR NEW.consumed_at < OLD.issued_at
     OR NEW.consumed_at > CAST(strftime('%s','now') AS INTEGER)
     OR NEW.revoked_at IS NOT NULL
     OR length(trim(NEW.consumed_by)) NOT BETWEEN 1 AND 128
   ))
   OR
   (NEW.status = 'expired' AND (
     OLD.expires_at > CAST(strftime('%s','now') AS INTEGER)
     OR NEW.revoked_at IS NOT NULL
     OR NEW.consumed_at IS NOT NULL
     OR NEW.consumed_by IS NOT NULL
   ))
 )
BEGIN
  SELECT RAISE(ABORT, 'invalid capability approval terminal timestamp or transition');
END;
