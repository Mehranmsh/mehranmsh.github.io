import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { encryptPiTestnetObservationArchive } from "./pi-testnet-observation-encryption.mjs";
import { createPiTestnetArchiveReplacementJournalRecord } from "./pi-testnet-observation-replacement-journal.mjs";
import { evaluatePiTestnetArchiveRecovery } from "./pi-testnet-observation-recovery-gate.mjs";

const scope = "pi-launchpad:testnet-health";
const archive = {
  schemaVersion: 1, archiveType: "pi-testnet-observation-archive",
  createdAt: null, recordCount: 0, duplicateCount: 0, records: [],
  manifestSha256: ""
};
// Produce a valid empty manifest digest using the same canonical manifest rule.
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(k => JSON.stringify(k)+":"+canonical(value[k])).join(",") + "}";
}
archive.manifestSha256 = createHash("sha256").update(canonical({
  schemaVersion: 1, archiveType: archive.archiveType, createdAt: null,
  recordCount: 0, duplicateCount: 0, records: []
}), "utf8").digest("hex");
const key1 = randomBytes(32), key2 = randomBytes(32);
const keyring = {
  accepted: true,
  getDecryptionKey(id) {
    if (id === "key-1") return { keyId: id, key: key1 };
    if (id === "key-2") return { keyId: id, key: key2 };
    return null;
  }
};
const source = encryptPiTestnetObservationArchive(archive, {
  key: key1, keyId: "key-1", archiveScope: scope
}).envelope;
const replacement = encryptPiTestnetObservationArchive(archive, {
  key: key2, keyId: "key-2", archiveScope: scope
}).envelope;
const digest = value => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const journal = createPiTestnetArchiveReplacementJournalRecord({
  sequence: 1, previousRecordSha256: null, archiveScope: scope,
  archiveId: source.archiveId, sourceEnvelopeSha256: digest(source),
  replacementEnvelopeSha256: digest(replacement), state: "prepared"
}).record;
const principal = { authenticated: true, role: "archive_admin", principalId: "server-user-1" };

test("allows source-preserving retry only after authorization and envelope readback", () => {
  const result = evaluatePiTestnetArchiveRecovery({
    principal, keyring, journal: [journal], currentEnvelope: source, archiveScope: scope
  });
  assert.equal(result.accepted, true);
  assert.equal(result.action, "retry_compare_and_swap_after_fresh_authorization");
});

test("recognizes already-applied replacement only after decrypting readback", () => {
  const result = evaluatePiTestnetArchiveRecovery({
    principal, keyring, journal: [journal], currentEnvelope: replacement, archiveScope: scope
  });
  assert.equal(result.action, "prepare_commit_record_after_readback");
});

test("fails closed for unauthenticated callers, wrong scope, and unknown envelope", () => {
  assert.equal(evaluatePiTestnetArchiveRecovery({
    principal: { ...principal, authenticated: false }, keyring, journal: [journal],
    currentEnvelope: source, archiveScope: scope
  }).accepted, false);
  assert.equal(evaluatePiTestnetArchiveRecovery({
    principal, keyring, journal: [journal], currentEnvelope: source, archiveScope: "other"
  }).accepted, false);
  const unknown = { ...replacement, archiveScope: scope, ciphertext: source.ciphertext };
  assert.equal(evaluatePiTestnetArchiveRecovery({
    principal, keyring, journal: [journal], currentEnvelope: unknown, archiveScope: scope
  }).accepted, false);
});

test("unknown but validly encrypted envelope requires manual reconciliation", () => {
  const third = encryptPiTestnetObservationArchive(archive, {
    key: randomBytes(32), keyId: "key-3", archiveScope: scope
  }).envelope;
  const extendedKeyring = {
    ...keyring,
    getDecryptionKey(id) {
      if (id === "key-3") return { keyId: id, key: thirdKey };
      return keyring.getDecryptionKey(id);
    }
  };
  const thirdKey = randomBytes(32);
  const validThird = encryptPiTestnetObservationArchive(archive, {
    key: thirdKey, keyId: "key-3", archiveScope: scope
  }).envelope;
  const result = evaluatePiTestnetArchiveRecovery({
    principal, keyring: extendedKeyring, journal: [journal],
    currentEnvelope: validThird, archiveScope: scope
  });
  assert.equal(result.action, "manual_reconciliation_required");
});
