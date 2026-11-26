import test from "node:test";
import assert from "node:assert/strict";
import { createPiTestnetObservationMemoryRepository } from "./pi-testnet-observation-memory-repository.mjs";
import {
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
const writer = { id: "writer-1", active: true, roles: ["archive_writer"] };
const reader = { id: "reader-1", active: true, roles: ["archive_reader"] };
const observation = {
  schemaVersion: 1,
  network: "testnet",
  endpoint: "https://rpc.testnet.minepi.com",
  method: "getHealth",
  requestId: "memory-test-1",
  retrievedAt: "2026-11-26T02:40:00.000Z",
  responseBytes: 64,
  serializedResponseSha256: "a".repeat(64),
  result: { state: "opaque", nested: { value: 7 } },
  eligibleForMainnetScoring: false,
  trustNotice: "Testnet only"
};
const archive = createPiTestnetObservationArchive([observation]).archive;
const repository = () => createPiTestnetObservationMemoryRepository({
  archiveScope: policy.archiveScope,
  maxEntries: 10,
  maxArchiveBytes: 5 * 1024 * 1024
});

test("stores and retrieves a policy-authorized archive in volatile memory", () => {
  const repo = repository();
  const writeIntent = createPiTestnetArchiveAppendIntent(archive, writer, policy);
  const stored = repo.append(writeIntent.intent);
  assert.equal(stored.accepted, true);
  assert.equal(stored.duplicate, false);
  const readIntent = createPiTestnetArchiveReadIntent(stored.archiveId, reader, policy);
  const loaded = repo.read(readIntent.intent);
  assert.equal(loaded.accepted, true);
  assert.equal(loaded.archive.records[0].observation.result.nested.value, 7);
  assert.equal(Object.isFrozen(loaded.archive.records[0].observation.result.nested), true);
  assert.equal(repo.size, 1);
});

test("append is idempotent and does not overwrite existing entries", () => {
  const repo = repository();
  const intent = createPiTestnetArchiveAppendIntent(archive, writer, policy).intent;
  assert.equal(repo.append(intent).duplicate, false);
  assert.equal(repo.append(intent).duplicate, true);
  assert.equal(repo.size, 1);
});

test("rejects forged digest, wrong scope, and wrong operation intents", () => {
  const repo = repository();
  const intent = createPiTestnetArchiveAppendIntent(archive, writer, policy).intent;
  assert.equal(repo.append({ ...intent, archiveId: "f".repeat(64) }).code, "archive_id_mismatch");
  assert.equal(repo.append({ ...intent, archiveScope: "other-scope" }).code, "invalid_or_out_of_scope_intent");
  assert.equal(repo.read(intent).code, "invalid_or_out_of_scope_intent");
});

test("re-verifies archive integrity on every read", () => {
  const repo = repository();
  const writeIntent = createPiTestnetArchiveAppendIntent(archive, writer, policy).intent;
  const stored = repo.append(writeIntent);
  const readIntent = createPiTestnetArchiveReadIntent(stored.archiveId, reader, policy).intent;
  assert.equal(repo.verify(readIntent).accepted, true);
  assert.equal(repo.read({ ...readIntent, archiveId: "f".repeat(64) }).code, "archive_not_found");
});

test("enforces entry capacity and rejects invalid repository configuration", () => {
  assert.equal(createPiTestnetObservationMemoryRepository({ archiveScope: "x", maxEntries: 0, maxArchiveBytes: 1024 }).code, "invalid_repository_options");
  const repo = createPiTestnetObservationMemoryRepository({
    archiveScope: policy.archiveScope,
    maxEntries: 1,
    maxArchiveBytes: 5 * 1024 * 1024
  });
  const intent = createPiTestnetArchiveAppendIntent(archive, writer, policy).intent;
  assert.equal(repo.append(intent).accepted, true);
  const secondArchive = createPiTestnetObservationArchive([{
    ...observation,
    requestId: "memory-test-2"
  }]).archive;
  const secondIntent = createPiTestnetArchiveAppendIntent(secondArchive, writer, policy).intent;
  assert.equal(repo.append(secondIntent).code, "repository_capacity_exceeded");
});

test("returns explicit volatile-storage limitations", () => {
  const repo = repository();
  assert.match(repo.notice, /No durability/);
  assert.equal(repo.bytesUsed, 0);
});
