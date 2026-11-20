-- Close both approval ledgers to consumption until a separately approved executor exists.
-- Enforce server-time issuance and terminal timestamps for the legacy task/repository ledger.
-- Apply only to the isolated Intelligence staging database.

CREATE TRIGGER IF NOT EXISTS trg_intelligence_approval_issued_at_guard
BEFORE INSERT ON intelligence_approval_ledger
WHEN NEW.issued_at IS NULL
  OR NEW.issued_at <= 0
  OR NEW.issued_at > CAST(strftime('%s','now') AS INTEGER)
  OR NEW.expires_at <= NEW.issued_at
  OR NEW.expires_at > NEW.issued_at + 3600
BEGIN
  SELECT RAISE(ABORT, 'invalid legacy approval issue or expiry timestamp');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_approval_terminal_timestamp_guard
BEFORE UPDATE OF status, revoked_at, consumed_at, consumed_by
ON intelligence_approval_ledger
WHEN OLD.status = 'issued'
 AND (
   (NEW.status = 'revoked' AND (
     NEW.revoked_at IS NULL
     OR NEW.revoked_at < OLD.issued_at
     OR NEW.revoked_at >= OLD.expires_at
     OR NEW.revoked_at > CAST(strftime('%s','now') AS INTEGER)
     OR NEW.consumed_at IS NOT NULL
     OR NEW.consumed_by IS NOT NULL
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
  SELECT RAISE(ABORT, 'invalid legacy approval terminal timestamp or transition');
END;


CREATE TRIGGER IF NOT EXISTS trg_intelligence_capability_approval_revocation_before_expiry_guard
BEFORE UPDATE OF status, revoked_at
ON intelligence_capability_approvals
WHEN OLD.status = 'issued'
 AND NEW.status = 'revoked'
 AND NEW.revoked_at >= OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'capability approval revocation must precede expiry');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_approval_consumption_disabled
BEFORE UPDATE OF status ON intelligence_approval_ledger
WHEN NEW.status = 'consumed'
BEGIN
  SELECT RAISE(ABORT, 'approval consumption is disabled pending executor review');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_capability_approval_consumption_disabled
BEFORE UPDATE OF status ON intelligence_capability_approvals
WHEN NEW.status = 'consumed'
BEGIN
  SELECT RAISE(ABORT, 'capability approval consumption is disabled pending executor review');
END;
