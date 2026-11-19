-- Append-only owner review ledger for finding evidence snapshots.
-- Local/CI staging schema only. No production migration is authorized by this file.

CREATE TABLE IF NOT EXISTS intelligence_finding_reviews (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL,
  owner_uid TEXT NOT NULL CHECK(length(owner_uid) BETWEEN 1 AND 200),
  reviewer_uid TEXT NOT NULL CHECK(length(reviewer_uid) BETWEEN 1 AND 200),
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted','rejected','needs_more_info')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  evidence_snapshot_json TEXT NOT NULL
    CHECK(length(evidence_snapshot_json) BETWEEN 2 AND 20000)
    CHECK(json_valid(evidence_snapshot_json))
    CHECK(json_type(evidence_snapshot_json) = 'array'),
  evidence_snapshot_sha256 TEXT NOT NULL
    CHECK(length(evidence_snapshot_sha256) = 64)
    CHECK(evidence_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  evidence_count INTEGER NOT NULL CHECK(evidence_count BETWEEN 0 AND 100),
  reviewed_at INTEGER NOT NULL CHECK(reviewed_at > 0),
  created_at INTEGER NOT NULL CHECK(created_at = reviewed_at),
  CHECK(reviewer_uid = owner_uid),
  CHECK(json_array_length(evidence_snapshot_json) = evidence_count),
  UNIQUE(id, owner_uid),
  FOREIGN KEY(finding_id, owner_uid)
    REFERENCES intelligence_findings(id, owner_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_intelligence_finding_reviews_owner_finding
  ON intelligence_finding_reviews(owner_uid, finding_id, reviewed_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_intelligence_finding_review_audit_insert
AFTER INSERT ON intelligence_finding_reviews
BEGIN
  INSERT INTO intelligence_staging_audit
    (id, owner_uid, action, target_type, target_id, details_json, created_at)
  VALUES (
    lower(hex(randomblob(16))), NEW.owner_uid, 'finding_evidence_review_recorded',
    'finding_review', NEW.id,
    json_object('finding_id', NEW.finding_id, 'outcome', NEW.outcome,
                'evidence_count', NEW.evidence_count,
                'evidence_snapshot_sha256', NEW.evidence_snapshot_sha256,
                'reviewer_uid', NEW.reviewer_uid),
    NEW.reviewed_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_finding_review_immutable
BEFORE UPDATE ON intelligence_finding_reviews
BEGIN
  SELECT RAISE(ABORT, 'owner evidence reviews are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_finding_review_no_delete
BEFORE DELETE ON intelligence_finding_reviews
BEGIN
  SELECT RAISE(ABORT, 'owner evidence reviews are retained');
END;
