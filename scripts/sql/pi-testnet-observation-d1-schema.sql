-- Cloudflare D1 schema proposal for Pi Testnet archive replacement.
-- Apply only after human review and an explicit deployment authorization.
-- No credentials, bindings, or live database operations are included.

CREATE TABLE IF NOT EXISTS pi_testnet_archives (
  archive_scope TEXT NOT NULL,
  archive_id TEXT NOT NULL CHECK(length(archive_id) = 64 AND archive_id NOT GLOB '*[^0-9a-f]*'),
  envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)
    AND json_extract(envelope_json, '$.archive_scope') = archive_scope
    AND json_extract(envelope_json, '$.archive_id') = archive_id),
  envelope_sha256 TEXT NOT NULL CHECK(length(envelope_sha256) = 64 AND envelope_sha256 NOT GLOB '*[^0-9a-f]*'),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (archive_scope, archive_id)
) STRICT;

CREATE TABLE IF NOT EXISTS pi_testnet_archive_replacement_ops (
  operation_id TEXT PRIMARY KEY,
  archive_scope TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  replacement_sha256 TEXT NOT NULL CHECK(length(replacement_sha256) = 64 AND replacement_sha256 NOT GLOB '*[^0-9a-f]*'),
  replacement_envelope_json TEXT NOT NULL CHECK(json_valid(replacement_envelope_json)
    AND json_extract(replacement_envelope_json, '$.archive_scope') = archive_scope
    AND json_extract(replacement_envelope_json, '$.archive_id') = archive_id),
  prepared_record_json TEXT NOT NULL,
  prepared_record_sha256 TEXT NOT NULL CHECK(length(prepared_record_sha256) = 64 AND prepared_record_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('prepared', 'committed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (archive_scope, archive_id)
    REFERENCES pi_testnet_archives(archive_scope, archive_id),
  CHECK(source_sha256 <> replacement_sha256)
) STRICT;

CREATE TABLE IF NOT EXISTS pi_testnet_archive_replacement_journal (
  operation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence IN (1, 2)),
  state TEXT NOT NULL CHECK(state IN ('prepared', 'committed')),
  record_json TEXT NOT NULL,
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256) = 64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (operation_id, sequence),
  UNIQUE (operation_id, state),
  FOREIGN KEY (operation_id)
    REFERENCES pi_testnet_archive_replacement_ops(operation_id)
) STRICT;

CREATE TRIGGER IF NOT EXISTS pi_testnet_replacement_journal_no_update
BEFORE UPDATE ON pi_testnet_archive_replacement_journal
BEGIN
  SELECT RAISE(ABORT, 'replacement journal is append-only');
END;

CREATE TRIGGER IF NOT EXISTS pi_testnet_replacement_journal_no_delete
BEFORE DELETE ON pi_testnet_archive_replacement_journal
BEGIN
  SELECT RAISE(ABORT, 'replacement journal cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS pi_testnet_replacement_ops_immutable_fields
BEFORE UPDATE ON pi_testnet_archive_replacement_ops
WHEN NEW.operation_id <> OLD.operation_id
  OR NEW.archive_scope <> OLD.archive_scope
  OR NEW.archive_id <> OLD.archive_id
  OR NEW.source_sha256 <> OLD.source_sha256
  OR NEW.replacement_sha256 <> OLD.replacement_sha256
  OR NEW.replacement_envelope_json <> OLD.replacement_envelope_json
  OR NEW.prepared_record_json <> OLD.prepared_record_json
  OR NEW.prepared_record_sha256 <> OLD.prepared_record_sha256
  OR NOT (OLD.state = 'prepared' AND NEW.state = 'committed')
BEGIN
  SELECT RAISE(ABORT, 'invalid replacement operation mutation');
END;

CREATE TRIGGER IF NOT EXISTS pi_testnet_replacement_ops_no_delete
BEFORE DELETE ON pi_testnet_archive_replacement_ops
BEGIN
  SELECT RAISE(ABORT, 'replacement operation cannot be deleted');
END;
