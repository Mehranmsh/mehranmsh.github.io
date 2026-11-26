import test from "node:test";
import assert from "node:assert/strict";
import {
  encryptPiTestnetObservationArchive,
  decryptPiTestnetObservationArchive
} from "./pi-testnet-observation-encryption.mjs";
import { createPiTestnetObservationArchive } from "./pi-testnet-observation-archive.mjs";

const key = Buffer.from("0123456789abcdef0123456789abcdef");
const wrongKey = Buffer.from("abcdef0123456789abcdef0123456789");
const options = { key, keyId: "test-key-v1", archiveScope: "pi-launchpad:testnet-health" };
const observation = {
  schemaVersion: 1,
  network: "testnet",
  endpoint: "https://rpc.testnet.minepi.com",
  method: "getHealth",
  requestId: "encryption-test-1",
  retrievedAt: "2026-11-26T02:40:00.000Z",
  responseBytes: 64,
  serializedResponseSha256: "a".repeat(64),
  result: { state: "opaque" },
  eligibleForMainnetScoring: false,
  trustNotice: "Testnet only"
};
const archive = createPiTestnetObservationArchive([observation]).archive;

test("encrypts and decrypts a verified archive with AES-256-GCM", () => {
  const encrypted = encryptPiTestnetObservationArchive(archive, options);
  assert.equal(encrypted.accepted, true);
  assert.equal(encrypted.envelope.algorithm, "aes-256-gcm");
  const decrypted = decryptPiTestnetObservationArchive(encrypted.envelope, options);
  assert.equal(decrypted.accepted, true);
  assert.equal(decrypted.archive.manifestSha256, archive.manifestSha256);
});

test("uses a fresh nonce for each encryption of the same archive", () => {
  const first = encryptPiTestnetObservationArchive(archive, options);
  const second = encryptPiTestnetObservationArchive(archive, options);
  assert.notEqual(first.envelope.iv, second.envelope.iv);
  assert.notEqual(first.envelope.ciphertext, second.envelope.ciphertext);
});

test("rejects wrong keys, key IDs, and archive scopes", () => {
  const encrypted = encryptPiTestnetObservationArchive(archive, options);
  assert.equal(decryptPiTestnetObservationArchive(encrypted.envelope, {
    key: wrongKey, keyId: "test-key-v1"
  }).code, "decryption_or_authentication_failed");
  assert.equal(decryptPiTestnetObservationArchive(encrypted.envelope, {
    key, keyId: "other-key"
  }).code, "invalid_decryption_options");
  assert.equal(decryptPiTestnetObservationArchive(encrypted.envelope, {
    key, keyId: "test-key-v1", archiveScope: "other-scope"
  }).code, "invalid_decryption_options");
});

test("rejects ciphertext, tag, and authenticated metadata tampering", () => {
  const encrypted = encryptPiTestnetObservationArchive(archive, options);
  const alteredCiphertext = { ...encrypted.envelope, ciphertext: encrypted.envelope.ciphertext.slice(0, -4) + "AAAA" };
  assert.equal(decryptPiTestnetObservationArchive(alteredCiphertext, options).accepted, false);
  const alteredTag = { ...encrypted.envelope, tag: Buffer.alloc(16, 1).toString("base64") };
  assert.equal(decryptPiTestnetObservationArchive(alteredTag, options).accepted, false);
  const alteredScope = { ...encrypted.envelope, archiveScope: "different-scope" };
  assert.equal(decryptPiTestnetObservationArchive(alteredScope, options).accepted, false);
});

test("rejects malformed keys, invalid envelopes, and invalid source archives", () => {
  assert.equal(encryptPiTestnetObservationArchive(archive, {
    ...options, key: Buffer.alloc(16)
  }).code, "invalid_encryption_options");
  assert.equal(encryptPiTestnetObservationArchive({}, options).accepted, false);
  assert.equal(decryptPiTestnetObservationArchive({}, options).code, "invalid_encryption_envelope");
});

test("does not expose or persist the supplied key in the envelope", () => {
  const encrypted = encryptPiTestnetObservationArchive(archive, options);
  const serialized = JSON.stringify(encrypted.envelope);
  assert.equal(serialized.includes(key.toString("hex")), false);
  assert.equal(Object.hasOwn(encrypted.envelope, "key"), false);
});
