import test from "node:test";
import assert from "node:assert/strict";
import { createPiTestnetObservationArchive } from "./pi-testnet-observation-archive.mjs";
import { encryptPiTestnetObservationArchive, decryptPiTestnetObservationArchive } from "./pi-testnet-observation-encryption.mjs";
import { createPiTestnetArchiveKeyring } from "./pi-testnet-observation-keyring.mjs";
import { rotatePiTestnetObservationArchive } from "./pi-testnet-observation-rotation.mjs";

const oldKey = Buffer.from("0123456789abcdef0123456789abcdef");
const newKey = Buffer.from("abcdef0123456789abcdef0123456789");
const scope = "pi-launchpad:testnet-health";
const archive = createPiTestnetObservationArchive([{
  schemaVersion: 1, network: "testnet", endpoint: "https://rpc.testnet.minepi.com",
  method: "getHealth", requestId: "rotation-test-1", retrievedAt: "2026-11-26T02:40:00.000Z",
  responseBytes: 64, serializedResponseSha256: "a".repeat(64), result: { state: "opaque" },
  eligibleForMainnetScoring: false, trustNotice: "Testnet only"
}]).archive;
const source = encryptPiTestnetObservationArchive(archive, {
  key: oldKey, keyId: "key-v1", archiveScope: scope
}).envelope;
const ring = createPiTestnetArchiveKeyring({ activeKeyId: "key-v2", keys: [
  { keyId: "key-v1", key: oldKey }, { keyId: "key-v2", key: newKey }
] });

test("rotates an archive and verifies its identity with the new active key", () => {
  const result = rotatePiTestnetObservationArchive(source, { keyring: ring, archiveScope: scope });
  assert.equal(result.accepted, true);
  assert.equal(result.previousKeyId, "key-v1");
  assert.equal(result.activeKeyId, "key-v2");
  assert.equal(result.archiveId, source.archiveId);
  assert.notEqual(result.envelope.iv, source.iv);
  assert.equal(decryptPiTestnetObservationArchive(result.envelope, {
    key: newKey, keyId: "key-v2", archiveScope: scope
  }).accepted, true);
});

test("fails closed when old key is revoked or unavailable", () => {
  const revokedRing = createPiTestnetArchiveKeyring({ activeKeyId: "key-v2", keys: [
    { keyId: "key-v1", key: oldKey, revoked: true }, { keyId: "key-v2", key: newKey }
  ] });
  assert.equal(rotatePiTestnetObservationArchive(source, {
    keyring: revokedRing, archiveScope: scope
  }).code, "source_key_unavailable");
});

test("rejects same-key rotation, wrong scope, and tampered source envelopes", () => {
  const sameRing = createPiTestnetArchiveKeyring({ activeKeyId: "key-v1", keys: [
    { keyId: "key-v1", key: oldKey }
  ] });
  assert.equal(rotatePiTestnetObservationArchive(source, {
    keyring: sameRing, archiveScope: scope
  }).code, "already_using_active_key");
  assert.equal(rotatePiTestnetObservationArchive(source, {
    keyring: ring, archiveScope: "wrong-scope"
  }).code, "invalid_rotation_options");
  assert.equal(rotatePiTestnetObservationArchive({ ...source, tag: Buffer.alloc(16).toString("base64") }, {
    keyring: ring, archiveScope: scope
  }).code, "source_decryption_failed");
});
