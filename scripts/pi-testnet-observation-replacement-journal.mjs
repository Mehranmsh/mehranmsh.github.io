import { createHash } from "node:crypto";

const HEX_256 = /^[a-f0-9]{64}$/;
const STATES = new Set(["prepared", "committed", "aborted"]);

function isPlainRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map(k =>
    JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function validBase(record) {
  return isPlainRecord(record) &&
    typeof record.archiveScope === "string" && /^[a-zA-Z0-9._:-]{1,100}$/.test(record.archiveScope) &&
    typeof record.archiveId === "string" && HEX_256.test(record.archiveId) &&
    typeof record.sourceEnvelopeSha256 === "string" && HEX_256.test(record.sourceEnvelopeSha256) &&
    typeof record.replacementEnvelopeSha256 === "string" && HEX_256.test(record.replacementEnvelopeSha256) &&
    record.sourceEnvelopeSha256 !== record.replacementEnvelopeSha256 &&
    Number.isSafeInteger(record.sequence) && record.sequence >= 1;
}
function recordDigest(record) {
  const { recordSha256, ...body } = record;
  return sha256(canonicalJson(body));
}

/** Builds an immutable journal record; persistence and transactionality belong to the adapter. */
export function createPiTestnetArchiveReplacementJournalRecord(input, previousRecord = null) {
  if (!isPlainRecord(input) || !validBase(input) ||
      !STATES.has(input.state) ||
      (input.state === "prepared" && input.observedEnvelopeSha256 !== undefined) ||
      (input.state === "committed" && input.observedEnvelopeSha256 !== input.replacementEnvelopeSha256) ||
      (input.state === "aborted" && input.observedEnvelopeSha256 !== input.sourceEnvelopeSha256)) {
    return Object.freeze({ accepted: false, code: "invalid_journal_record" });
  }
  if (previousRecord === null) {
    if (input.sequence !== 1 || input.previousRecordSha256 !== null || input.state !== "prepared") {
      return Object.freeze({ accepted: false, code: "invalid_initial_journal_record" });
    }
  } else {
    const previous = verifyPiTestnetArchiveReplacementJournal([previousRecord]);
    if (!previous.accepted || previousRecord.state !== "prepared" ||
        input.sequence !== previousRecord.sequence + 1 ||
        input.previousRecordSha256 !== previousRecord.recordSha256 ||
        input.archiveScope !== previousRecord.archiveScope ||
        input.archiveId !== previousRecord.archiveId ||
        input.sourceEnvelopeSha256 !== previousRecord.sourceEnvelopeSha256 ||
        input.replacementEnvelopeSha256 !== previousRecord.replacementEnvelopeSha256 ||
        !["committed", "aborted"].includes(input.state)) {
      return Object.freeze({ accepted: false, code: "invalid_journal_transition" });
    }
  }
  const body = {
    schemaVersion: 1,
    journalType: "pi-testnet-archive-replacement",
    sequence: input.sequence,
    previousRecordSha256: input.previousRecordSha256,
    archiveScope: input.archiveScope,
    archiveId: input.archiveId,
    sourceEnvelopeSha256: input.sourceEnvelopeSha256,
    replacementEnvelopeSha256: input.replacementEnvelopeSha256,
    state: input.state,
    ...(input.observedEnvelopeSha256 === undefined ? {} : {
      observedEnvelopeSha256: input.observedEnvelopeSha256
    })
  };
  return Object.freeze({ accepted: true, record: freeze({
    ...body, recordSha256: recordDigest(body)
  }) });
}

/** Verifies a complete bounded hash-linked journal and its legal state transitions. */
export function verifyPiTestnetArchiveReplacementJournal(records) {
  if (!Array.isArray(records) || records.length < 1 || records.length > 1000) {
    return Object.freeze({ accepted: false, code: "invalid_journal_length" });
  }
  let previous = null;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!isPlainRecord(record) || record.schemaVersion !== 1 ||
        record.journalType !== "pi-testnet-archive-replacement" ||
        !validBase(record) || !STATES.has(record.state) ||
        record.sequence !== index + 1 ||
        (record.previousRecordSha256 !== null && !HEX_256.test(record.previousRecordSha256)) ||
        (record.state === "prepared" && record.observedEnvelopeSha256 !== undefined) ||
        (record.state === "committed" && record.observedEnvelopeSha256 !== record.replacementEnvelopeSha256) ||
        (record.state === "aborted" && record.observedEnvelopeSha256 !== record.sourceEnvelopeSha256) ||
        record.recordSha256 !== recordDigest(record)) {
      return Object.freeze({ accepted: false, code: "journal_record_integrity_failed", index });
    }
    if (index === 0) {
      if (record.previousRecordSha256 !== null || record.state !== "prepared") {
        return Object.freeze({ accepted: false, code: "invalid_initial_journal_record", index });
      }
    } else if (record.previousRecordSha256 !== previous.recordSha256 ||
        record.archiveScope !== previous.archiveScope ||
        record.archiveId !== previous.archiveId ||
        record.sourceEnvelopeSha256 !== previous.sourceEnvelopeSha256 ||
        record.replacementEnvelopeSha256 !== previous.replacementEnvelopeSha256 ||
        previous.state !== "prepared" ||
        !["committed", "aborted"].includes(record.state)) {
      return Object.freeze({ accepted: false, code: "invalid_journal_transition", index });
    }
    previous = record;
  }
  return Object.freeze({
    accepted: true,
    recordCount: records.length,
    state: previous.state,
    archiveScope: previous.archiveScope,
    archiveId: previous.archiveId,
    sourceEnvelopeSha256: previous.sourceEnvelopeSha256,
    replacementEnvelopeSha256: previous.replacementEnvelopeSha256,
    lastRecordSha256: previous.recordSha256,
    recovery: previous.state === "prepared" ? "reconcile_storage_before_retry" : "terminal"
  });
}

/** Classifies storage after a crash; unknown versions always require manual review. */
export function classifyPiTestnetArchiveReplacementRecovery(preparedRecord, currentEnvelopeSha256) {
  const verified = verifyPiTestnetArchiveReplacementJournal([preparedRecord]);
  if (!verified.accepted || preparedRecord.state !== "prepared" ||
      typeof currentEnvelopeSha256 !== "string" || !HEX_256.test(currentEnvelopeSha256)) {
    return Object.freeze({ accepted: false, code: "invalid_recovery_input" });
  }
  if (currentEnvelopeSha256 === preparedRecord.sourceEnvelopeSha256) {
    return Object.freeze({ accepted: true, action: "safe_to_retry_compare_and_swap" });
  }
  if (currentEnvelopeSha256 === preparedRecord.replacementEnvelopeSha256) {
    return Object.freeze({ accepted: true, action: "replacement_already_applied_record_commit" });
  }
  return Object.freeze({
    accepted: true,
    action: "manual_reconciliation_required",
    notice: "Stored envelope matches neither verified version. Do not overwrite or retry automatically."
  });
}
