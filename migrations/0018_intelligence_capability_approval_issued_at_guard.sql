-- Prevent direct D1 inserts from backdating or future-dating approval issuance.
-- Historical positive timestamps remain valid for deterministic fixture replay;
-- future timestamps are never accepted as server-issued authority.
CREATE TRIGGER IF NOT EXISTS trg_intelligence_capability_approval_issued_at_guard
BEFORE INSERT ON intelligence_capability_approvals
WHEN NEW.issued_at IS NULL
  OR NEW.issued_at <= 0
  OR NEW.issued_at > CAST(strftime('%s','now') AS INTEGER)
  OR NEW.expires_at <= NEW.issued_at
  OR NEW.expires_at > NEW.issued_at + 3600
BEGIN
  SELECT RAISE(ABORT, 'invalid capability approval issue or expiry timestamp');
END;
