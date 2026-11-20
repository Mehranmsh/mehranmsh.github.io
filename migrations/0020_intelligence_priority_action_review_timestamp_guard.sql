-- Guard owner priority-action review timestamps at the database boundary.
-- Staging/CI only. Do not apply to Production without separate authorization.

CREATE TRIGGER IF NOT EXISTS trg_intelligence_priority_action_review_timestamp_guard
BEFORE INSERT ON intelligence_priority_action_reviews
WHEN NEW.reviewed_at > CAST(strftime('%s', 'now') AS INTEGER)
  OR NEW.created_at > CAST(strftime('%s', 'now') AS INTEGER)
BEGIN
  SELECT RAISE(ABORT, 'priority action review timestamps cannot be in the future');
END;
