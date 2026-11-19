-- Separate approval ledger for INTELLIGENCE capabilities.
-- Do not reuse intelligence_approval_ledger: that table authorizes task/repository
-- scopes and has different semantics. This ledger is assessment-only until a
-- separately reviewed executor and atomic consumption design are approved.

CREATE TABLE IF NOT EXISTS intelligence_capability_approvals (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL CHECK(length(owner_uid) > 0),
  capability TEXT NOT NULL CHECK(capability IN (
    'knowledge.create', 'memory.create', 'knowledge.review', 'memory.delete'
  )),
  scope TEXT NOT NULL CHECK(scope = 'owner_staging'),
  status TEXT NOT NULL DEFAULT 'issued'
    CHECK(status IN ('issued', 'revoked', 'consumed', 'expired')),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  consumed_at INTEGER,
  consumed_by TEXT,
  CHECK(expires_at > issued_at AND expires_at <= issued_at + 3600),
  CHECK(
    (status IN ('issued', 'expired') AND revoked_at IS NULL AND consumed_at IS NULL AND consumed_by IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND consumed_at IS NULL AND consumed_by IS NULL)
    OR (status = 'consumed' AND revoked_at IS NULL AND consumed_at IS NOT NULL AND consumed_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_intelligence_capability_approval_owner
  ON intelligence_capability_approvals(owner_uid, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_intelligence_capability_approval_active
  ON intelligence_capability_approvals(owner_uid, capability, expires_at)
  WHERE status = 'issued';

CREATE TRIGGER IF NOT EXISTS trg_intelligence_capability_approval_insert_guard
BEFORE INSERT ON intelligence_capability_approvals
WHEN NEW.status <> 'issued'
  OR NEW.revoked_at IS NOT NULL
  OR NEW.consumed_at IS NOT NULL
  OR NEW.consumed_by IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'new capability approvals must start issued');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_capability_approval_identity_immutable
BEFORE UPDATE OF id, owner_uid, capability, scope, issued_at, expires_at
ON intelligence_capability_approvals
WHEN NEW.id IS NOT OLD.id
  OR NEW.owner_uid IS NOT OLD.owner_uid
  OR NEW.capability IS NOT OLD.capability
  OR NEW.scope IS NOT OLD.scope
  OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'capability approval identity and scope are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_capability_approval_transition_guard
BEFORE UPDATE OF status ON intelligence_capability_approvals
WHEN OLD.status <> NEW.status
 AND NOT (OLD.status = 'issued' AND NEW.status IN ('revoked', 'consumed', 'expired'))
BEGIN
  SELECT RAISE(ABORT, 'invalid capability approval state transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_capability_approval_terminal_metadata_immutable
BEFORE UPDATE OF revoked_at, consumed_at, consumed_by
ON intelligence_capability_approvals
WHEN OLD.status IN ('revoked', 'consumed', 'expired')
 AND (NEW.revoked_at IS NOT OLD.revoked_at
   OR NEW.consumed_at IS NOT OLD.consumed_at
   OR NEW.consumed_by IS NOT OLD.consumed_by)
BEGIN
  SELECT RAISE(ABORT, 'terminal capability approval metadata is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_capability_approval_audit
AFTER UPDATE OF status ON intelligence_capability_approvals
WHEN OLD.status = 'issued' AND NEW.status IN ('revoked', 'consumed', 'expired')
BEGIN
  INSERT INTO intelligence_staging_audit
    (id, owner_uid, action, target_type, target_id, details_json, created_at)
  VALUES (
    lower(hex(randomblob(16))), NEW.owner_uid,
    CASE NEW.status
      WHEN 'revoked' THEN 'capability_approval_revoked'
      WHEN 'consumed' THEN 'capability_approval_consumed'
      ELSE 'capability_approval_expired'
    END,
    'capability_approval', NEW.id,
    json_object('capability', NEW.capability, 'scope', NEW.scope),
    CASE NEW.status
      WHEN 'revoked' THEN NEW.revoked_at
      WHEN 'consumed' THEN NEW.consumed_at
      ELSE CAST(strftime('%s','now') AS INTEGER)
    END
  );
END;
