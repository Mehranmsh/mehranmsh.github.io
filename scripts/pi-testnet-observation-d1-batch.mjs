import { createHash } from "node:crypto";
import { verifyPiTestnetArchiveReplacementJournal } from "./pi-testnet-observation-replacement-journal.mjs";

const HEX_256 = /^[a-f0-9]{64}$/;
const SCOPE = /^[a-zA-Z0-9._:-]{1,100}$/;
const OPERATION_ID = /^[a-zA-Z0-9._:-]{1,120}$/;

function isPlainRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function statement(sql, params) {
  return Object.freeze({ sql, params: Object.freeze(params.slice()) });
}

/**
 * Builds two D1 batch phases. Phase 1 atomically creates the operation intent,
 * CAS-replaces the envelope, and appends the prepared journal record.
 * The caller MUST read back and verify the envelope between phases.
 * Phase 2 atomically marks the operation committed and appends the terminal
 * journal record. This is intentionally staged, not an interactive transaction.
 *
 * Execute each phase with D1Database.batch(). Do not execute statements one by
 * one with run(), and do not treat a D1 Session as a transaction.
 */
export function buildPiTestnetArchiveD1ReplacementPlan(input) {
  if (!isPlainRecord(input) ||
      typeof input.operationId !== "string" || !OPERATION_ID.test(input.operationId) ||
      typeof input.archiveScope !== "string" || !SCOPE.test(input.archiveScope) ||
      typeof input.archiveId !== "string" || !HEX_256.test(input.archiveId) ||
      typeof input.sourceEnvelopeSha256 !== "string" || !HEX_256.test(input.sourceEnvelopeSha256) ||
      typeof input.replacementEnvelopeSha256 !== "string" || !HEX_256.test(input.replacementEnvelopeSha256) ||
      input.sourceEnvelopeSha256 === input.replacementEnvelopeSha256 ||
      typeof input.replacementEnvelopeJson !== "string" ||
      input.replacementEnvelopeJson.length < 2 ||
      input.replacementEnvelopeJson.length > 7 * 1024 * 1024 ||
      typeof input.preparedRecordJson !== "string" ||
      input.preparedRecordJson.length < 2 || input.preparedRecordJson.length > 16 * 1024 ||
      !HEX_256.test(input.preparedRecordSha256) ||
      typeof input.committedRecordJson !== "string" ||
      input.committedRecordJson.length < 2 || input.committedRecordJson.length > 16 * 1024 ||
      !HEX_256.test(input.committedRecordSha256)) {
    return Object.freeze({ accepted: false, code: "invalid_d1_replacement_plan_input" });
  }

  let replacementEnvelope, preparedRecord, committedRecord;
  try {
    replacementEnvelope = JSON.parse(input.replacementEnvelopeJson);
    preparedRecord = JSON.parse(input.preparedRecordJson);
    committedRecord = JSON.parse(input.committedRecordJson);
  } catch {
    return Object.freeze({ accepted: false, code: "invalid_d1_plan_json" });
  }
  const replacementDigest = createHash("sha256")
    .update(JSON.stringify(replacementEnvelope), "utf8").digest("hex");
  const journalCheck = verifyPiTestnetArchiveReplacementJournal([preparedRecord, committedRecord]);
  if (!isPlainRecord(replacementEnvelope) ||
      replacementEnvelope.archiveScope !== input.archiveScope ||
      replacementEnvelope.archiveId !== input.archiveId ||
      replacementDigest !== input.replacementEnvelopeSha256 ||
      JSON.stringify(replacementEnvelope) !== input.replacementEnvelopeJson ||
      JSON.stringify(preparedRecord) !== input.preparedRecordJson ||
      JSON.stringify(committedRecord) !== input.committedRecordJson ||
      !journalCheck.accepted || journalCheck.state !== "committed" ||
      journalCheck.archiveScope !== input.archiveScope ||
      journalCheck.archiveId !== input.archiveId ||
      journalCheck.sourceEnvelopeSha256 !== input.sourceEnvelopeSha256 ||
      journalCheck.replacementEnvelopeSha256 !== input.replacementEnvelopeSha256 ||
      preparedRecord.recordSha256 !== input.preparedRecordSha256 ||
      committedRecord.recordSha256 !== input.committedRecordSha256) {
    return Object.freeze({ accepted: false, code: "d1_plan_integrity_validation_failed" });
  }

  const phase1 = Object.freeze([
    statement(
      `INSERT INTO pi_testnet_archive_replacement_ops
       (operation_id, archive_scope, archive_id, source_sha256, replacement_sha256,
        replacement_envelope_json, prepared_record_json, prepared_record_sha256, state)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'prepared'
       WHERE EXISTS (
         SELECT 1 FROM pi_testnet_archives
         WHERE archive_scope = ? AND archive_id = ? AND envelope_sha256 = ?
       )
       ON CONFLICT(operation_id) DO NOTHING`,
      [input.operationId, input.archiveScope, input.archiveId,
       input.sourceEnvelopeSha256, input.replacementEnvelopeSha256,
       input.replacementEnvelopeJson, input.preparedRecordJson,
       input.preparedRecordSha256, input.archiveScope, input.archiveId,
       input.sourceEnvelopeSha256]
    ),
    statement(
      `UPDATE pi_testnet_archives
       SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           envelope_json = (
             SELECT replacement_envelope_json
             FROM pi_testnet_archive_replacement_ops
             WHERE operation_id = ? AND state = 'prepared'
           ),
           envelope_sha256 = (
             SELECT replacement_sha256
             FROM pi_testnet_archive_replacement_ops
             WHERE operation_id = ? AND state = 'prepared'
           )
       WHERE archive_scope = ? AND archive_id = ? AND envelope_sha256 = ?
         AND EXISTS (
           SELECT 1 FROM pi_testnet_archive_replacement_ops
           WHERE operation_id = ? AND state = 'prepared'
             AND archive_scope = ? AND archive_id = ?
             AND source_sha256 = ? AND replacement_sha256 = ?
             AND replacement_envelope_json = ?
             AND prepared_record_json = ? AND prepared_record_sha256 = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM pi_testnet_archive_replacement_journal
           WHERE operation_id = ? AND sequence = 1
             AND (state <> 'prepared' OR record_json <> ? OR record_sha256 <> ?)
         )`,
      [input.operationId, input.operationId, input.archiveScope,
       input.archiveId, input.sourceEnvelopeSha256, input.operationId,
       input.archiveScope, input.archiveId, input.sourceEnvelopeSha256,
       input.replacementEnvelopeSha256, input.replacementEnvelopeJson,
       input.preparedRecordJson, input.preparedRecordSha256,
       input.operationId, input.preparedRecordJson, input.preparedRecordSha256]
    ),
    statement(
      `INSERT INTO pi_testnet_archive_replacement_journal
       (operation_id, sequence, state, record_json, record_sha256)
       SELECT operation_id, 1, 'prepared', prepared_record_json, prepared_record_sha256
       FROM pi_testnet_archive_replacement_ops
       WHERE operation_id = ? AND state = 'prepared'
       ON CONFLICT(operation_id, sequence) DO NOTHING`,
      [input.operationId]
    )
  ]);

  const phase2 = Object.freeze([
    statement(
      `UPDATE pi_testnet_archive_replacement_ops
       SET state = 'committed'
       WHERE operation_id = ? AND state = 'prepared'
         AND archive_scope = ? AND archive_id = ?
         AND source_sha256 = ? AND replacement_sha256 = ?
         AND replacement_envelope_json = ?
         AND prepared_record_json = ? AND prepared_record_sha256 = ?
         AND EXISTS (
           SELECT 1 FROM pi_testnet_archives
           WHERE archive_scope = ? AND archive_id = ?
             AND envelope_sha256 = ?
         )
         AND EXISTS (
           SELECT 1 FROM pi_testnet_archive_replacement_journal
           WHERE operation_id = ? AND sequence = 1 AND state = 'prepared'
             AND record_json = ? AND record_sha256 = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM pi_testnet_archive_replacement_journal
           WHERE operation_id = ? AND sequence = 2
             AND (state <> 'committed' OR record_json <> ? OR record_sha256 <> ?)
         )`,
      [input.operationId, input.archiveScope, input.archiveId,
       input.sourceEnvelopeSha256, input.replacementEnvelopeSha256,
       input.replacementEnvelopeJson, input.preparedRecordJson,
       input.preparedRecordSha256, input.archiveScope, input.archiveId,
       input.replacementEnvelopeSha256, input.operationId,
       input.preparedRecordJson, input.preparedRecordSha256,
       input.operationId, input.committedRecordJson, input.committedRecordSha256]
    ),
    statement(
      `INSERT INTO pi_testnet_archive_replacement_journal
       (operation_id, sequence, state, record_json, record_sha256)
       SELECT operation_id, 2, 'committed', ?, ?
       FROM pi_testnet_archive_replacement_ops
       WHERE operation_id = ? AND state = 'committed'
         AND archive_scope = ? AND archive_id = ?
         AND source_sha256 = ? AND replacement_sha256 = ?
         AND replacement_envelope_json = ?
         AND prepared_record_json = ? AND prepared_record_sha256 = ?
         AND EXISTS (
           SELECT 1 FROM pi_testnet_archives
           WHERE archive_scope = ? AND archive_id = ?
             AND envelope_sha256 = ?
         )
         AND EXISTS (
           SELECT 1 FROM pi_testnet_archive_replacement_journal
           WHERE operation_id = ? AND sequence = 1 AND state = 'prepared'
             AND record_json = ? AND record_sha256 = ?
         )
       ON CONFLICT(operation_id, sequence) DO NOTHING`,
      [input.committedRecordJson, input.committedRecordSha256,
       input.operationId, input.archiveScope, input.archiveId,
       input.sourceEnvelopeSha256, input.replacementEnvelopeSha256,
       input.replacementEnvelopeJson, input.preparedRecordJson,
       input.preparedRecordSha256, input.archiveScope, input.archiveId,
       input.replacementEnvelopeSha256, input.operationId,
       input.preparedRecordJson, input.preparedRecordSha256]
    )
  ]);

  return Object.freeze({
    accepted: true,
    adapter: "cloudflare-d1-batch",
    phase1,
    phase2,
    requiredReadback: Object.freeze({
      archiveScope: input.archiveScope,
      archiveId: input.archiveId,
      operationId: input.operationId,
      expectedSourceEnvelopeSha256: input.sourceEnvelopeSha256,
      expectedEnvelopeSha256: input.replacementEnvelopeSha256,
      expectedPreparedRecordJson: input.preparedRecordJson,
      preparedRecordSha256: input.preparedRecordSha256,
      expectedCommittedRecordJson: input.committedRecordJson,
      committedRecordSha256: input.committedRecordSha256
    }),
    executionRules: Object.freeze([
      "Execute phase1 in exactly one D1Database.batch call.",
      "Read back archive and prepared journal after phase1; verify exact digests.",
      "If source digest remains, leave prepared state for recovery; if an unknown digest appears, stop for manual reconciliation.",
      "Execute phase2 in exactly one D1Database.batch call only after replacement read-back verification.",
      "Before phase2, require exact operation payload and prepared journal JSON/digest matches; otherwise stop.",
      "After phase2, require exact committed journal JSON and digest read-back; an ignored uniqueness conflict is not success.",
      "Never use individual run calls for the multi-statement phases."
    ]),
    limitation: "D1 batch provides atomicity per batch, not one interactive transaction across phase1, read-back, and phase2. A crash between phases leaves a recoverable prepared operation."
  });
}


/**
 * Builds read-only D1 queries for crash recovery. The adapter must execute
 * these reads before deciding whether to retry phase1, proceed to phase2,
 * or stop for manual reconciliation. This function performs no I/O.
 */
export function buildPiTestnetArchiveD1RecoveryReadbackPlan(input) {
  if (!isPlainRecord(input) ||
      typeof input.operationId !== "string" || !OPERATION_ID.test(input.operationId) ||
      typeof input.archiveScope !== "string" || !SCOPE.test(input.archiveScope) ||
      typeof input.archiveId !== "string" || !HEX_256.test(input.archiveId) ||
      typeof input.sourceEnvelopeSha256 !== "string" || !HEX_256.test(input.sourceEnvelopeSha256) ||
      typeof input.replacementEnvelopeSha256 !== "string" || !HEX_256.test(input.replacementEnvelopeSha256) ||
      input.sourceEnvelopeSha256 === input.replacementEnvelopeSha256) {
    return Object.freeze({ accepted: false, code: "invalid_d1_recovery_readback_input" });
  }

  const archive = statement(
    `SELECT archive_scope, archive_id, envelope_json, envelope_sha256
     FROM pi_testnet_archives
     WHERE archive_scope = ? AND archive_id = ?`,
    [input.archiveScope, input.archiveId]
  );
  const operation = statement(
    `SELECT operation_id, archive_scope, archive_id, source_sha256,
            replacement_sha256, replacement_envelope_json,
            prepared_record_json, prepared_record_sha256, state
     FROM pi_testnet_archive_replacement_ops
     WHERE operation_id = ? AND archive_scope = ? AND archive_id = ?
       AND source_sha256 = ? AND replacement_sha256 = ?`,
    [input.operationId, input.archiveScope, input.archiveId,
     input.sourceEnvelopeSha256, input.replacementEnvelopeSha256]
  );
  const journal = statement(
    `SELECT operation_id, sequence, state, record_json, record_sha256
     FROM pi_testnet_archive_replacement_journal
     WHERE operation_id = ? AND sequence IN (1, 2)
     ORDER BY sequence ASC`,
    [input.operationId]
  );

  return Object.freeze({
    accepted: true,
    adapter: "cloudflare-d1-read-only-recovery",
    statements: Object.freeze([archive, operation, journal]),
    expected: Object.freeze({
      operationId: input.operationId,
      archiveScope: input.archiveScope,
      archiveId: input.archiveId,
      sourceEnvelopeSha256: input.sourceEnvelopeSha256,
      replacementEnvelopeSha256: input.replacementEnvelopeSha256
    }),
    decisionRules: Object.freeze([
      "Require exactly one archive row and verify its envelope JSON digest and scope/id identity.",
      "Require exactly one operation row whose complete immutable payload matches the requested operation.",
      "Verify every returned journal row by parsing and validating the complete hash-linked journal.",
      "If the archive digest equals source, a fresh compare-and-swap retry may be considered only after authorization and exact operation/journal checks.",
      "If the archive digest equals replacement, proceed only when the prepared operation and sequence-1 journal match exactly; then build phase2 and verify sequence-2 readback.",
      "If the archive digest matches neither source nor replacement, stop for manual reconciliation; never overwrite automatically.",
      "Missing rows, duplicate or conflicting rows, malformed JSON, or any digest mismatch fail closed."
    ]),
    limitation: "Read-only query plan only. It does not execute D1 reads, authenticate principals, decrypt envelopes, run recovery, or commit phase2."
  });
}
