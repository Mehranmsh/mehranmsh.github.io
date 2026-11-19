-- Append-only owner decisions for current Intelligence recommendations.
-- Local/CI staging schema only. No Production migration is authorized by this file.

CREATE TABLE IF NOT EXISTS intelligence_evidence_decision_reviews (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL CHECK(length(owner_uid) BETWEEN 1 AND 200),
  reviewer_uid TEXT NOT NULL CHECK(length(reviewer_uid) BETWEEN 1 AND 200),
  review_key_sha256 TEXT NOT NULL
    CHECK(length(review_key_sha256) = 64)
    CHECK(review_key_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_type TEXT NOT NULL CHECK(source_type IN (
    'finding_metadata','correlation_candidate','consistency_candidate'
  )),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 200),
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
  UNIQUE(id, owner_uid)
);

CREATE INDEX IF NOT EXISTS idx_intelligence_decision_reviews_owner_key
  ON intelligence_evidence_decision_reviews(owner_uid, review_key_sha256, reviewed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_decision_reviews_owner_time
  ON intelligence_evidence_decision_reviews(owner_uid, reviewed_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_intelligence_decision_review_audit_insert
AFTER INSERT ON intelligence_evidence_decision_reviews
BEGIN
  INSERT INTO intelligence_staging_audit
    (id, owner_uid, action, target_type, target_id, details_json, created_at)
  VALUES (
    lower(hex(randomblob(16))), NEW.owner_uid, 'evidence_decision_review_recorded',
    'evidence_decision_review', NEW.id,
    json_object('review_key_sha256', NEW.review_key_sha256,
                'source_type', NEW.source_type,
                'source_id', NEW.source_id,
                'outcome', NEW.outcome,
                'review_snapshot_sha256', NEW.review_snapshot_sha256,
                'reviewer_uid', NEW.reviewer_uid),
    NEW.reviewed_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_decision_review_immutable
BEFORE UPDATE ON intelligence_evidence_decision_reviews
BEGIN
  SELECT RAISE(ABORT, 'evidence decision reviews are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_decision_review_no_delete
BEFORE DELETE ON intelligence_evidence_decision_reviews
BEGIN
  SELECT RAISE(ABORT, 'evidence decision reviews are retained');
END;
