import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPiTestnetObservationArchive } from "./pi-testnet-observation-archive.mjs";
import { encryptPiTestnetObservationArchive } from "./pi-testnet-observation-encryption.mjs";
import { createPiTestnetArchiveKeyring } from "./pi-testnet-observation-keyring.mjs";
import { rotatePiTestnetObservationArchive } from "./pi-testnet-observation-rotation.mjs";
import { preparePiTestnetArchiveReplacementIntent } from "./pi-testnet-observation-replacement-intent.mjs";

const oldKey = Buffer.from("0123456789abcdef0123456789abcdef");
const newKey = Buffer.from("abcdef0123456789abcdef0123456789");
const scope = "pi-launchpad:testnet-health";
const archive = createPiTestnetObservationArchive([{
  schemaVersion: 1, network: "testnet", endpoint: "https://rpc.testnet.minepi.com",
  method: "getHealth", requestId: "replace-test-1", retrievedAt: "2026-11-26T02:40:00.000Z",
  responseBytes: 64, serializedResponseSha256: "a".repeat(64), result: { state: "opaque" },
  eligibleForMainnetScoring: false, trustNotice: "Testnet only"
}]).archive;
const source = encryptPiTestnetObservationArchive(archive, {
  key: oldKey, keyId: "key-v1", archiveScope: scope
}).envelope;
const keyring = createPiTestnetArchiveKeyring({ activeKeyId: "key-v2", keys: [
  { keyId: "key-v1", key: oldKey }, { keyId: "key-v2", key: newKey }
] });
const rotated = rotatePiTestnetObservationArchive(source, { keyring, archiveScope: scope }).envelope;
const digest = value => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

test("prepares a verified compare-and-swap replacement intent", () => {
  const result = preparePiTestnetArchiveReplacementIntent(source, rotated, {
    keyring, archiveScope: scope, expectedCurrentEnvelopeSha256: digest(source)
  });
  assert.equal(result.accepted, true);
  assert.equal(result.intent.operation, "compare_and_swap_replace");
  assert.equal(result.intent.archiveId, source.archiveId);
  assert.equal(result.intent.previousKeyId, "key-v1");
  assert.equal(result.intent.replacementKeyId, "key-v2");
  assert.equal(result.intent.expectedCurrentEnvelopeSha256, digest(source));
  assert.equal(result.intent.replacementEnvelopeSha256, digest(rotated));
});

test("rejects stale source versions and changed archive identities", () => {
  assert.equal(preparePiTestnetArchiveReplacementIntent(source, rotated, {
    keyring, archiveScope: scope, expectedCurrentEnvelopeSha256: "0".repeat(64)
  }).code, "source_version_mismatch");
  const otherArchive = createPiTestnetObservationArchive([{
    schemaVersion: 1, network: "testnet", endpoint: "https://rpc.testnet.minepi.com",
    method: "getHealth", requestId: "other-archive", retrievedAt: "2026-11-26T02:41:00.000Z",
    responseBytes: 64, serializedResponseSha256: "b".repeat(64), result: { state: "other" },
    eligibleForMainnetScoring: false, trustNotice: "Testnet only"
  }]).archive;
  const other = encryptPiTestnetObservationArchive(otherArchive, {
    key: newKey, keyId: "key-v2", archiveScope: scope
  }).envelope;
  assert.equal(preparePiTestnetArchiveReplacementIntent(source, other, {
    keyring, archiveScope: scope, expectedCurrentEnvelopeSha256: digest(source)
  }).code, "archive_identity_changed");
});

test("rejects wrong scopes, unknown keys, and tampered replacements", () => {
  assert.equal(preparePiTestnetArchiveReplacementIntent(source, rotated, {
    keyring, archiveScope: "wrong", expectedCurrentEnvelopeSha256: digest(source)
  }).accepted, false);
  const tampered = { ...rotated, tag: Buffer.alloc(16, 9).toString("base64") };
  assert.equal(preparePiTestnetArchiveReplacementIntent(source, tampered, {
    keyring, archiveScope: scope, expectedCurrentEnvelopeSha256: digest(source)
  }).code, "replacement_envelope_verification_failed");
});
