-- Append-only owner decisions for bounded evidence-correlation snapshots.
-- Local/CI staging schema only. No production migration is authorized by this file.

CREATE TABLE IF NOT EXISTS intelligence_evidence_correlation_reviews (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL CHECK(length(owner_uid) BETWEEN 1 AND 200),
  reviewer_uid TEXT NOT NULL CHECK(length(reviewer_uid) BETWEEN 1 AND 200),
  correlation_type TEXT NOT NULL CHECK(correlation_type IN (
    'shared_digest','shared_source_reference','source_reference_digest_variance_candidate'
  )),
  correlation_key_sha256 TEXT NOT NULL
    CHECK(length(correlation_key_sha256) = 64)
    CHECK(correlation_key_sha256 NOT GLOB '*[^0-9a-f]*'),
  outcome TEXT NOT NULL CHECK(outcome IN ('related','unrelated','needs_more_info')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  correlation_snapshot_json TEXT NOT NULL
    CHECK(length(correlation_snapshot_json) BETWEEN 2 AND 20000)
    CHECK(json_valid(correlation_snapshot_json))
    CHECK(json_type(correlation_snapshot_json) = 'array'),
  correlation_snapshot_sha256 TEXT NOT NULL
    CHECK(length(correlation_snapshot_sha256) = 64)
    CHECK(correlation_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  reference_count INTEGER NOT NULL CHECK(reference_count BETWEEN 2 AND 20),
  reviewed_at INTEGER NOT NULL CHECK(reviewed_at > 0),
  created_at INTEGER NOT NULL CHECK(created_at = reviewed_at),
  CHECK(reviewer_uid = owner_uid),
  CHECK(json_array_length(correlation_snapshot_json) = reference_count),
  UNIQUE(id, owner_uid)
);

CREATE INDEX IF NOT EXISTS idx_intelligence_correlation_reviews_owner_key
  ON intelligence_evidence_correlation_reviews(owner_uid, correlation_key_sha256, reviewed_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_intelligence_correlation_review_audit_insert
AFTER INSERT ON intelligence_evidence_correlation_reviews
BEGIN
  INSERT INTO intelligence_staging_audit
    (id, owner_uid, action, target_type, target_id, details_json, created_at)
  VALUES (
    lower(hex(randomblob(16))), NEW.owner_uid, 'evidence_correlation_review_recorded',
    'evidence_correlation_review', NEW.id,
    json_object('correlation_type', NEW.correlation_type,
                'correlation_key_sha256', NEW.correlation_key_sha256,
                'outcome', NEW.outcome,
                'reference_count', NEW.reference_count,
                'correlation_snapshot_sha256', NEW.correlation_snapshot_sha256,
                'reviewer_uid', NEW.reviewer_uid),
    NEW.reviewed_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_correlation_review_immutable
BEFORE UPDATE ON intelligence_evidence_correlation_reviews
BEGIN
  SELECT RAISE(ABORT, 'evidence correlation reviews are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_correlation_review_no_delete
BEFORE DELETE ON intelligence_evidence_correlation_reviews
BEGIN
  SELECT RAISE(ABORT, 'evidence correlation reviews are retained');
END;
