-- Append-only owner decisions for current priority action-plan recommendations.
-- Local/CI staging schema only. No Production migration is authorized by this file.

CREATE TABLE IF NOT EXISTS intelligence_priority_action_reviews (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL CHECK(length(owner_uid) BETWEEN 1 AND 200),
  reviewer_uid TEXT NOT NULL CHECK(length(reviewer_uid) BETWEEN 1 AND 200),
  finding_id TEXT NOT NULL,
  module_id TEXT NOT NULL CHECK(length(module_id) BETWEEN 1 AND 80),
  check_id TEXT NOT NULL CHECK(length(check_id) BETWEEN 1 AND 120),
  action_key_sha256 TEXT NOT NULL
    CHECK(length(action_key_sha256) = 64)
    CHECK(action_key_sha256 NOT GLOB '*[^0-9a-f]*'),
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted','rejected','needs_more_info')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  review_snapshot_json TEXT NOT NULL
    CHECK(length(review_snapshot_json) BETWEEN 2 AND 20000)
    CHECK(json_valid(review_snapshot_json))
    CHECK(json_type(review_snapshot_json) = 'object'),
  review_snapshot_sha256 TEXT NOT NULL
    CHECK(length(review_snapshot_sha256) = 64)
    CHECK(review_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  reviewed_at INTEGER NOT NULL CHECK(reviewed_at > 0),
  created_at INTEGER NOT NULL CHECK(created_at = reviewed_at),
  CHECK(reviewer_uid = owner_uid),
  UNIQUE(id, owner_uid),
  FOREIGN KEY(finding_id, owner_uid)
    REFERENCES intelligence_findings(id, owner_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_intelligence_priority_action_reviews_owner_key
  ON intelligence_priority_action_reviews(owner_uid, action_key_sha256, reviewed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_priority_action_reviews_owner_time
  ON intelligence_priority_action_reviews(owner_uid, reviewed_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_intelligence_priority_action_review_audit_insert
AFTER INSERT ON intelligence_priority_action_reviews
BEGIN
  INSERT INTO intelligence_staging_audit
    (id, owner_uid, action, target_type, target_id, details_json, created_at)
  VALUES (
    lower(hex(randomblob(16))), NEW.owner_uid, 'priority_action_review_recorded',
    'priority_action_review', NEW.id,
    json_object('action_key_sha256', NEW.action_key_sha256,
                'finding_id', NEW.finding_id,
                'module_id', NEW.module_id,
                'check_id', NEW.check_id,
                'outcome', NEW.outcome,
                'review_snapshot_sha256', NEW.review_snapshot_sha256,
                'reviewer_uid', NEW.reviewer_uid),
    NEW.reviewed_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_priority_action_review_immutable
BEFORE UPDATE ON intelligence_priority_action_reviews
BEGIN
  SELECT RAISE(ABORT, 'priority action reviews are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_priority_action_review_no_delete
BEFORE DELETE ON intelligence_priority_action_reviews
BEGIN
  SELECT RAISE(ABORT, 'priority action reviews are retained');
END;
