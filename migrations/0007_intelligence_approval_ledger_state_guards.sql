-- Enforce immutable approval scope and one-way lifecycle transitions.
-- Apply only after migrations 0000-0006 on the isolated INTELLIGENCE staging D1.

CREATE TRIGGER IF NOT EXISTS trg_intelligence_approval_insert_issued_only
BEFORE INSERT ON intelligence_approval_ledger
WHEN NEW.status <> 'issued'
BEGIN
  SELECT RAISE(ABORT, 'new approvals must start issued');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_approval_insert_metadata
BEFORE INSERT ON intelligence_approval_ledger
WHEN NEW.revoked_at IS NOT NULL OR NEW.consumed_at IS NOT NULL OR NEW.consumed_by IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'new approval cannot contain terminal metadata');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_approval_state_transition
BEFORE UPDATE OF status ON intelligence_approval_ledger
WHEN OLD.status <> NEW.status
 AND NOT (OLD.status = 'issued' AND NEW.status IN ('revoked', 'expired', 'consumed'))
BEGIN
  SELECT RAISE(ABORT, 'invalid approval state transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_approval_scope_immutable
BEFORE UPDATE OF id, task_id, owner_uid, owner_username, repository, branch,
                 base_sha, scope_json, scope_sha256, issued_at, expires_at
ON intelligence_approval_ledger
WHEN NEW.id IS NOT OLD.id
  OR NEW.task_id IS NOT OLD.task_id
  OR NEW.owner_uid IS NOT OLD.owner_uid
  OR NEW.owner_username IS NOT OLD.owner_username
  OR NEW.repository IS NOT OLD.repository
  OR NEW.branch IS NOT OLD.branch
  OR NEW.base_sha IS NOT OLD.base_sha
  OR NEW.scope_json IS NOT OLD.scope_json
  OR NEW.scope_sha256 IS NOT OLD.scope_sha256
  OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'approval identity and scope are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_approval_terminal_metadata
BEFORE UPDATE OF status, revoked_at, consumed_at, consumed_by
ON intelligence_approval_ledger
WHEN (NEW.status = 'revoked' AND
      (NEW.revoked_at IS NULL OR NEW.consumed_at IS NOT NULL OR NEW.consumed_by IS NOT NULL))
  OR (NEW.status = 'consumed' AND
      (NEW.consumed_at IS NULL OR NEW.consumed_by IS NULL OR NEW.revoked_at IS NOT NULL))
  OR (NEW.status IN ('issued', 'expired') AND
      (NEW.revoked_at IS NOT NULL OR NEW.consumed_at IS NOT NULL OR NEW.consumed_by IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'approval terminal metadata does not match state');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_approval_terminal_metadata_immutable
BEFORE UPDATE OF revoked_at, consumed_at, consumed_by
ON intelligence_approval_ledger
WHEN OLD.status IN ('revoked', 'expired', 'consumed')
 AND (NEW.revoked_at IS NOT OLD.revoked_at
   OR NEW.consumed_at IS NOT OLD.consumed_at
   OR NEW.consumed_by IS NOT OLD.consumed_by)
BEGIN
  SELECT RAISE(ABORT, 'terminal approval metadata is immutable');
END;
