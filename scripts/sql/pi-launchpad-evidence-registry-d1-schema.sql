-- Proposed Cloudflare D1 schema for immutable Pi Launchpad evidence records.
-- Review-only migration: do not apply to a live database without separate approval.
-- This schema stores evidence projections only. It does not ingest data, verify chain truth,
-- enable scoring, or grant wallet/transaction capabilities.

CREATE TABLE IF NOT EXISTS pi_launchpad_evidence_records (
  record_id TEXT PRIMARY KEY
    CHECK(length(record_id) = 37 AND substr(record_id, 1, 5) = 'plev_'
      AND substr(record_id, 6) NOT GLOB '*[^0-9a-f]*'),
  network_id TEXT NOT NULL CHECK(network_id IN ('pi-mainnet', 'pi-testnet')),
  asset_identifier TEXT NOT NULL CHECK(length(asset_identifier) BETWEEN 1 AND 256),
  evidence_id TEXT NOT NULL CHECK(length(evidence_id) BETWEEN 1 AND 160),
  evidence_type TEXT NOT NULL CHECK(evidence_type IN (
    'official_project_claim',
    'chain_indexer_observation',
    'dex_indexer_observation',
    'security_audit_claim',
    'community_claim'
  )),
  field_name TEXT NOT NULL CHECK(length(field_name) BETWEEN 1 AND 64),
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  provenance_json TEXT NOT NULL CHECK(
    json_valid(provenance_json)
    AND json_type(provenance_json, '$.source') IS 'object'
    AND json_type(provenance_json, '$.source.sourceId') IS 'text'
    AND json_type(provenance_json, '$.source.kind') IS 'text'
    AND json_type(provenance_json, '$.source.url') IS 'text'
    AND json_type(provenance_json, '$.observedAt') IS 'text'
  ),
  verification_status TEXT NOT NULL CHECK(verification_status IN (
    'unverified', 'signature_verified', 'attestation_rejected'
  )),
  chain_verification_status TEXT NOT NULL DEFAULT 'not_verified'
    CHECK(chain_verification_status = 'not_verified'),
  scoring_status TEXT NOT NULL DEFAULT 'blocked_pending_independent_chain_verification'
    CHECK(scoring_status = 'blocked_pending_independent_chain_verification'),
  registry_version TEXT NOT NULL CHECK(length(registry_version) BETWEEN 1 AND 32),
  created_at TEXT NOT NULL,
  UNIQUE(network_id, asset_identifier, record_id)
) STRICT;

CREATE INDEX IF NOT EXISTS pi_launchpad_evidence_asset_idx
  ON pi_launchpad_evidence_records(network_id, asset_identifier, created_at);

CREATE INDEX IF NOT EXISTS pi_launchpad_evidence_source_idx
  ON pi_launchpad_evidence_records(
    json_extract(provenance_json, '$.source.sourceId'), created_at
  );

CREATE TRIGGER IF NOT EXISTS pi_launchpad_evidence_records_no_update
BEFORE UPDATE ON pi_launchpad_evidence_records
BEGIN
  SELECT RAISE(ABORT, 'Pi Launchpad evidence records are append-only');
END;

CREATE TRIGGER IF NOT EXISTS pi_launchpad_evidence_records_no_delete
BEFORE DELETE ON pi_launchpad_evidence_records
BEGIN
  SELECT RAISE(ABORT, 'Pi Launchpad evidence records cannot be deleted');
END;
