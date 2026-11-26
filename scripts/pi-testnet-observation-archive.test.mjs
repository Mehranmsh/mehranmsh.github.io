import test from "node:test";
import assert from "node:assert/strict";
import {
  createPiTestnetObservationArchive,
  verifyPiTestnetObservationArchive,
  retrievePiTestnetObservation
} from "./pi-testnet-observation-archive.mjs";

const makeObservation = (id = "health-1", state = "opaque", time = "2026-11-26T02:40:00.000Z") => ({
  schemaVersion: 1,
  network: "testnet",
  endpoint: "https://rpc.testnet.minepi.com",
  method: "getHealth",
  requestId: id,
  retrievedAt: time,
  responseBytes: 64,
  serializedResponseSha256: "a".repeat(64),
  result: { state, nested: { count: 1 } },
  eligibleForMainnetScoring: false,
  trustNotice: "Testnet only"
});

test("builds and verifies a deterministic bounded archive", () => {
  const observation = makeObservation();
  const first = createPiTestnetObservationArchive([observation], { createdAt: "2026-11-26T03:00:00.000Z" });
  const second = createPiTestnetObservationArchive([observation], { createdAt: "2026-11-26T03:00:00.000Z" });
  assert.equal(first.accepted, true);
  assert.equal(first.archive.manifestSha256, second.archive.manifestSha256);
  assert.equal(verifyPiTestnetObservationArchive(first.archive).accepted, true);
  assert.equal(Object.isFrozen(first.archive.records[0].observation.result.nested), true);
});

test("deduplicates identical observation identities without merging different records", () => {
  const observation = makeObservation();
  const result = createPiTestnetObservationArchive([observation, observation, makeObservation("health-2")]);
  assert.equal(result.accepted, true);
  assert.equal(result.archive.recordCount, 2);
  assert.equal(result.archive.duplicateCount, 1);
});

test("rejects malformed, Mainnet, stale-schema, and oversized inputs", () => {
  assert.equal(createPiTestnetObservationArchive({}).code, "invalid_archive_input");
  assert.equal(createPiTestnetObservationArchive([makeObservation("x")], { maxRecords: 0 }).code, "invalid_record_limit");
  assert.equal(createPiTestnetObservationArchive(Array.from({ length: 2 }, (_, i) => makeObservation(String(i))), { maxRecords: 1 }).code, "record_limit_exceeded");
  const wrongNetwork = makeObservation();
  wrongNetwork.network = "mainnet";
  assert.equal(createPiTestnetObservationArchive([wrongNetwork]).code, "unsupported_observation");
  const noDigest = makeObservation();
  noDigest.serializedResponseSha256 = "bad";
  assert.equal(createPiTestnetObservationArchive([noDigest]).code, "invalid_response_digest");
  const huge = makeObservation();
  huge.result = { data: "x".repeat(1024 * 1024) };
  assert.equal(createPiTestnetObservationArchive([huge]).code, "record_too_large");
});

test("detects tampering in observation, record digest, and manifest", () => {
  const created = createPiTestnetObservationArchive([makeObservation()]);
  const tamperedRecord = structuredClone(created.archive);
  tamperedRecord.records[0].observation.result.state = "changed";
  assert.equal(verifyPiTestnetObservationArchive(tamperedRecord).code, "record_integrity_mismatch");
  const tamperedManifest = structuredClone(created.archive);
  tamperedManifest.duplicateCount = 10;
  assert.equal(verifyPiTestnetObservationArchive(tamperedManifest).code, "manifest_integrity_mismatch");
});

test("retrieves only after full archive verification", () => {
  const created = createPiTestnetObservationArchive([makeObservation()]);
  const id = created.archive.records[0].observationId;
  const found = retrievePiTestnetObservation(created.archive, id);
  assert.equal(found.accepted, true);
  assert.equal(found.record.observation.result.state, "opaque");
  assert.equal(retrievePiTestnetObservation(created.archive, "f".repeat(64)).code, "observation_not_found");
  const tampered = structuredClone(created.archive);
  tampered.records[0].observation.result.state = "spoofed";
  assert.equal(retrievePiTestnetObservation(tampered, id).code, "record_integrity_mismatch");
});

test("rejects duplicate identities inside a hand-crafted manifest", () => {
  const created = createPiTestnetObservationArchive([makeObservation()]);
  const malformed = structuredClone(created.archive);
  malformed.records.push(structuredClone(malformed.records[0]));
  malformed.recordCount++;
  assert.equal(verifyPiTestnetObservationArchive(malformed).code, "observation_identity_mismatch");
});
