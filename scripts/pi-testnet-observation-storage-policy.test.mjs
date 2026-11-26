import test from "node:test";
import assert from "node:assert/strict";
import {
  validatePiTestnetArchiveStoragePolicy,
  authorizePiTestnetArchiveAction,
  createPiTestnetArchiveAppendIntent,
  createPiTestnetArchiveReadIntent
} from "./pi-testnet-observation-storage-policy.mjs";
import { createPiTestnetObservationArchive } from "./pi-testnet-observation-archive.mjs";

const policy = {
  schemaVersion: 1,
  archiveScope: "pi-launchpad:testnet-health",
  retentionDays: 365,
  maxArchiveBytes: 5 * 1024 * 1024,
  allowAppend: true,
  allowRead: true
};
const writer = { id: "operator-1", active: true, roles: ["archive_writer"] };
const reader = { id: "auditor-1", active: true, roles: ["archive_reader"] };
const archive = createPiTestnetObservationArchive([{
  schemaVersion: 1,
  network: "testnet",
  endpoint: "https://rpc.testnet.minepi.com",
  method: "getHealth",
  requestId: "health-1",
  retrievedAt: "2026-11-26T02:40:00.000Z",
  responseBytes: 64,
  serializedResponseSha256: "a".repeat(64),
  result: { state: "opaque" },
  eligibleForMainnetScoring: false,
  trustNotice: "Testnet only"
}]).archive;

test("validates explicit bounded retention and append/read policy", () => {
  assert.equal(validatePiTestnetArchiveStoragePolicy(policy).accepted, true);
  assert.equal(validatePiTestnetArchiveStoragePolicy({ ...policy, retentionDays: 0 }).code, "invalid_storage_policy");
  assert.equal(validatePiTestnetArchiveStoragePolicy({ ...policy, maxArchiveBytes: 99_000_000 }).code, "invalid_storage_policy");
  assert.equal(validatePiTestnetArchiveStoragePolicy({ ...policy, allowAppend: false }).code, "invalid_storage_policy");
});

test("enforces active principal roles and rejects client-shaped or unknown actions", () => {
  assert.equal(authorizePiTestnetArchiveAction("append", writer, policy).accepted, true);
  assert.equal(authorizePiTestnetArchiveAction("read", writer, policy).code, "forbidden");
  assert.equal(authorizePiTestnetArchiveAction("read", reader, policy).accepted, true);
  assert.equal(authorizePiTestnetArchiveAction("delete", writer, policy).code, "action_not_allowed");
  assert.equal(authorizePiTestnetArchiveAction("append", { ...writer, active: false }, policy).code, "invalid_principal");
  assert.equal(authorizePiTestnetArchiveAction("append", { ...writer, roles: "archive_admin" }, policy).code, "invalid_principal");
});

test("creates append-only intent only for integrity-verified bounded archives", () => {
  const intent = createPiTestnetArchiveAppendIntent(archive, writer, policy);
  assert.equal(intent.accepted, true);
  assert.equal(intent.intent.operation, "append_only");
  assert.equal(intent.intent.overwriteAllowed, false);
  assert.equal(intent.intent.deletionAllowed, false);
  assert.equal(intent.intent.recordCount, 1);
  assert.match(intent.intent.archiveId, /^[a-f0-9]{64}$/);
  assert.match(intent.notice, /No storage operation/);
  assert.equal(createPiTestnetArchiveAppendIntent(archive, reader, policy).code, "forbidden");
  assert.equal(createPiTestnetArchiveAppendIntent({ ...archive, manifestSha256: "0".repeat(64) }, writer, policy).code, "manifest_integrity_mismatch");
});

test("read intent is scoped and does not return archive data", () => {
  const id = "b".repeat(64);
  const result = createPiTestnetArchiveReadIntent(id, reader, policy);
  assert.equal(result.accepted, true);
  assert.equal(result.intent.archiveScope, policy.archiveScope);
  assert.equal(Object.hasOwn(result.intent, "payload"), false);
  assert.equal(createPiTestnetArchiveReadIntent("not-an-id", reader, policy).code, "invalid_archive_id");
  assert.equal(createPiTestnetArchiveReadIntent(id, writer, policy).code, "forbidden");
});

test("storage policy explicitly blocks overwrite and deletion semantics", () => {
  const validated = validatePiTestnetArchiveStoragePolicy(policy);
  assert.equal(validated.policy.appendOnly, true);
  assert.equal(validated.policy.overwriteAllowed, false);
  assert.equal(validated.policy.deletionAllowed, false);
});
