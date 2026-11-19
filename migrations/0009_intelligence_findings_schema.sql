-- Owner-scoped, append-evidence Findings schema for isolated Intelligence staging.
-- This migration is local/CI-only until separately reviewed and explicitly authorized.
-- It adds no executor, scanner, scheduler, or production integration.

CREATE TABLE IF NOT EXISTS intelligence_findings (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL CHECK(length(owner_uid) BETWEEN 1 AND 200),
  module_id TEXT NOT NULL CHECK(length(module_id) BETWEEN 1 AND 80),
  check_id TEXT NOT NULL CHECK(length(check_id) BETWEEN 1 AND 120),
  blueprint_version TEXT NOT NULL CHECK(length(blueprint_version) BETWEEN 1 AND 40),
  severity TEXT NOT NULL DEFAULT 'unrated'
    CHECK(severity IN ('critical','high','medium','low','info','unrated')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','accepted','mitigated','resolved','false_positive')),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 160),
  description TEXT NOT NULL CHECK(length(trim(description)) BETWEEN 1 AND 4000),
  evidence_state TEXT NOT NULL DEFAULT 'missing'
    CHECK(evidence_state IN ('missing','partial','sufficient','contradictory')),
  recommendation TEXT CHECK(recommendation IS NULL OR length(recommendation) <= 2000),
  status_reason TEXT CHECK(status_reason IS NULL OR length(status_reason) <= 1000),
  review_due_at INTEGER,
  created_at INTEGER NOT NULL CHECK(created_at > 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 120),
  UNIQUE(id, owner_uid),
  CHECK(status = 'open' OR length(trim(COALESCE(status_reason,''))) > 0),
  CHECK(status <> 'accepted' OR review_due_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_intelligence_findings_owner_status
  ON intelligence_findings(owner_uid, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_intelligence_findings_owner_module
  ON intelligence_findings(owner_uid, module_id, severity, status);
CREATE INDEX IF NOT EXISTS idx_intelligence_findings_owner_check
  ON intelligence_findings(owner_uid, module_id, check_id, blueprint_version);

CREATE TABLE IF NOT EXISTS intelligence_finding_evidence (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL,
  owner_uid TEXT NOT NULL CHECK(length(owner_uid) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK(kind IN (
    'document','code_review','test_run','configuration_review',
    'owner_observation','other'
  )),
  source_ref TEXT NOT NULL
    CHECK(length(source_ref) BETWEEN 1 AND 200)
    CHECK(source_ref NOT GLOB '*[^A-Za-z0-9._:-]*')
    CHECK(instr(lower(source_ref), '://') = 0),
  content_digest TEXT
    CHECK(content_digest IS NULL OR (
      length(content_digest) = 64 AND
      content_digest NOT GLOB '*[^0-9a-f]*'
    )),
  observed_at INTEGER,
  note TEXT NOT NULL CHECK(length(trim(note)) BETWEEN 1 AND 500),
  created_at INTEGER NOT NULL CHECK(created_at > 0),
  FOREIGN KEY(finding_id, owner_uid)
    REFERENCES intelligence_findings(id, owner_uid)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_intelligence_finding_evidence_owner_finding
  ON intelligence_finding_evidence(owner_uid, finding_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_intelligence_finding_identity_immutable
BEFORE UPDATE OF id, owner_uid, module_id, check_id, blueprint_version, created_at, created_by
ON intelligence_findings
WHEN NEW.id IS NOT OLD.id
  OR NEW.owner_uid IS NOT OLD.owner_uid
  OR NEW.module_id IS NOT OLD.module_id
  OR NEW.check_id IS NOT OLD.check_id
  OR NEW.blueprint_version IS NOT OLD.blueprint_version
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.created_by IS NOT OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'finding identity and provenance are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_finding_updated_at_monotonic
BEFORE UPDATE ON intelligence_findings
WHEN NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'finding updated_at cannot move backwards');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_finding_transition_reason
BEFORE UPDATE OF status ON intelligence_findings
WHEN OLD.status <> NEW.status
 AND length(trim(COALESCE(NEW.status_reason,''))) = 0
BEGIN
  SELECT RAISE(ABORT, 'finding status transitions require a reason');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_finding_severity_reason
BEFORE UPDATE OF severity ON intelligence_findings
WHEN OLD.severity <> NEW.severity
 AND length(trim(COALESCE(NEW.status_reason,''))) = 0
BEGIN
  SELECT RAISE(ABORT, 'finding severity changes require a reason');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_finding_audit_insert
AFTER INSERT ON intelligence_findings
BEGIN
  INSERT INTO intelligence_staging_audit
    (id, owner_uid, action, target_type, target_id, details_json, created_at)
  VALUES (
    lower(hex(randomblob(16))), NEW.owner_uid, 'finding_created',
    'finding', NEW.id,
    json_object('module_id', NEW.module_id, 'check_id', NEW.check_id,
                'severity', NEW.severity, 'status', NEW.status,
                'evidence_state', NEW.evidence_state),
    NEW.created_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_finding_audit_update
AFTER UPDATE ON intelligence_findings
BEGIN
  INSERT INTO intelligence_staging_audit
    (id, owner_uid, action, target_type, target_id, details_json, created_at)
  VALUES (
    lower(hex(randomblob(16))), NEW.owner_uid, 'finding_updated',
    'finding', NEW.id,
    json_object('severity', NEW.severity, 'status', NEW.status,
                'evidence_state', NEW.evidence_state,
                'status_reason', NEW.status_reason),
    NEW.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_finding_no_delete
BEFORE DELETE ON intelligence_findings
BEGIN
  SELECT RAISE(ABORT, 'findings are retained; use an audited status transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_finding_evidence_audit_insert
AFTER INSERT ON intelligence_finding_evidence
BEGIN
  INSERT INTO intelligence_staging_audit
    (id, owner_uid, action, target_type, target_id, details_json, created_at)
  VALUES (
    lower(hex(randomblob(16))), NEW.owner_uid, 'finding_evidence_attached',
    'finding_evidence', NEW.id,
    json_object('finding_id', NEW.finding_id, 'kind', NEW.kind,
                'source_ref', NEW.source_ref, 'observed_at', NEW.observed_at),
    NEW.created_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_finding_evidence_immutable
BEFORE UPDATE ON intelligence_finding_evidence
BEGIN
  SELECT RAISE(ABORT, 'evidence references are immutable; append a new reference');
END;

CREATE TRIGGER IF NOT EXISTS trg_intelligence_finding_evidence_no_delete
BEFORE DELETE ON intelligence_finding_evidence
BEGIN
  SELECT RAISE(ABORT, 'evidence references are retained');
END;
