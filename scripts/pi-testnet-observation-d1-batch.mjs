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
             AND source_sha256 = ?
         )`,
      [input.operationId, input.operationId, input.archiveScope,
       input.archiveId, input.sourceEnvelopeSha256, input.operationId,
       input.archiveScope, input.archiveId, input.sourceEnvelopeSha256]
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
         AND EXISTS (
           SELECT 1 FROM pi_testnet_archives
           WHERE archive_scope = ? AND archive_id = ?
             AND envelope_sha256 = ?
         )`,
      [input.operationId, input.archiveScope, input.archiveId,
       input.replacementEnvelopeSha256]
    ),
    statement(
      `INSERT INTO pi_testnet_archive_replacement_journal
       (operation_id, sequence, state, record_json, record_sha256)
       SELECT operation_id, 2, 'committed', ?, ?
       FROM pi_testnet_archive_replacement_ops
       WHERE operation_id = ? AND state = 'committed'
         AND archive_scope = ? AND archive_id = ?
         AND replacement_sha256 = ?
         AND EXISTS (
           SELECT 1 FROM pi_testnet_archives
           WHERE archive_scope = ? AND archive_id = ?
             AND envelope_sha256 = ?
         )
       ON CONFLICT(operation_id, sequence) DO NOTHING`,
      [input.committedRecordJson, input.committedRecordSha256,
       input.operationId, input.archiveScope, input.archiveId,
       input.replacementEnvelopeSha256, input.archiveScope,
       input.archiveId, input.replacementEnvelopeSha256]
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
      expectedEnvelopeSha256: input.replacementEnvelopeSha256,
      preparedRecordSha256: input.preparedRecordSha256
    }),
    executionRules: Object.freeze([
      "Execute phase1 in exactly one D1Database.batch call.",
      "Read back archive and prepared journal after phase1; verify exact digests.",
      "If source digest remains, leave prepared state for recovery; if an unknown digest appears, stop for manual reconciliation.",
      "Execute phase2 in exactly one D1Database.batch call only after replacement read-back verification.",
      "Read back and verify the committed journal after phase2.",
      "Never use individual run calls for the multi-statement phases."
    ]),
    limitation: "D1 batch provides atomicity per batch, not one interactive transaction across phase1, read-back, and phase2. A crash between phases leaves a recoverable prepared operation."
  });
}
