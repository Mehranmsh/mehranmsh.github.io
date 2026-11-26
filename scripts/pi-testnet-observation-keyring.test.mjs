import test from "node:test";
import assert from "node:assert/strict";
import { createPiTestnetArchiveKeyring } from "./pi-testnet-observation-keyring.mjs";

const oldKey = Buffer.from("0123456789abcdef0123456789abcdef");
const activeKey = Buffer.from("abcdef0123456789abcdef0123456789");

test("resolves active encryption key and historical decryption keys as defensive copies", () => {
  const ring = createPiTestnetArchiveKeyring({
    activeKeyId: "key-v2",
    keys: [{ keyId: "key-v1", key: oldKey }, { keyId: "key-v2", key: activeKey }]
  });
  assert.equal(ring.accepted, true);
  const active = ring.getActiveEncryptionKey();
  assert.equal(active.keyId, "key-v2");
  active.key.fill(0);
  assert.deepEqual(ring.getActiveEncryptionKey().key, activeKey);
  assert.deepEqual(ring.getDecryptionKey("key-v1").key, oldKey);
});

test("fails closed for duplicate, malformed, unknown, or revoked keys", () => {
  assert.equal(createPiTestnetArchiveKeyring({ activeKeyId: "k", keys: [
    { keyId: "k", key: oldKey }, { keyId: "k", key: activeKey }
  ] }).accepted, false);
  assert.equal(createPiTestnetArchiveKeyring({ activeKeyId: "k", keys: [
    { keyId: "k", key: Buffer.alloc(16) }
  ] }).accepted, false);
  const ring = createPiTestnetArchiveKeyring({ activeKeyId: "active", keys: [
    { keyId: "active", key: activeKey },
    { keyId: "revoked", key: oldKey, revoked: true }
  ] });
  assert.equal(ring.getDecryptionKey("revoked"), null);
  assert.equal(ring.getDecryptionKey("missing"), null);
  assert.equal(ring.getActiveEncryptionKey().keyId, "active");
});

test("rejects a missing or revoked active key", () => {
  assert.equal(createPiTestnetArchiveKeyring({ activeKeyId: "missing", keys: [
    { keyId: "other", key: oldKey }
  ] }).code, "active_key_unavailable");
  assert.equal(createPiTestnetArchiveKeyring({ activeKeyId: "revoked", keys: [
    { keyId: "revoked", key: oldKey, revoked: true }
  ] }).code, "active_key_unavailable");
});

test("does not let later configuration mutation change the active key", () => {
  const config = { activeKeyId: "key-v1", keys: [
    { keyId: "key-v1", key: oldKey }, { keyId: "key-v2", key: activeKey }
  ] };
  const ring = createPiTestnetArchiveKeyring(config);
  config.activeKeyId = "key-v2";
  assert.equal(ring.activeKeyId, "key-v1");
  assert.equal(ring.getActiveEncryptionKey().keyId, "key-v1");
});
