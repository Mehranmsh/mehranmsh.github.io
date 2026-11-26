import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { executePiTestnetArchiveReplacementTransaction } from "./pi-testnet-observation-transaction.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

function setup({ conflict = false, badReadback = false } = {}) {
  const source = { archiveScope: "test-scope", keyId: "old", ciphertext: "source" };
  const replacement = { archiveScope: "test-scope", keyId: "new", ciphertext: "replacement" };
  const state = { envelope: source, journal: [] };
  const calls = [];
  const tx = {
    async assertAuthorized(principal, scope) {
      calls.push("authorize");
      return principal.principalId === "owner" && scope === "test-scope";
    },
    async readCurrentEnvelope() {
      calls.push("read-current");
      return state.envelope;
    },
    async readJournal() {
      calls.push("read-journal");
      return state.journal.slice();
    },
    async appendJournalRecord(scope, archiveId, record) {
      calls.push("append-journal");
      state.journal.push(record);
    },
    async compareAndSwapEnvelope({ expectedEnvelopeSha256, replacementEnvelope }) {
      calls.push("cas");
      if (conflict || hash(state.envelope) !== expectedEnvelopeSha256) return false;
      state.envelope = replacementEnvelope;
      return true;
    }
  };
  let rolledBack = false;
  const provider = {
    supportsAtomicTransactions: true,
    async withTransaction(callback) {
      const before = { envelope: state.envelope, journal: state.journal.slice() };
      try {
        const result = await callback(tx);
        return result;
      } catch (error) {
        state.envelope = before.envelope;
        state.journal = before.journal;
        rolledBack = true;
        throw error;
      }
    }
  };
  const intent = {
    operation: "compare_and_swap_replace",
    archiveScope: "test-scope",
    archiveId: "a".repeat(64),
    expectedCurrentEnvelopeSha256: hash(source),
    replacementEnvelopeSha256: hash(replacement),
    replacementEnvelope: replacement
  };
  if (badReadback) {
    const original = tx.readCurrentEnvelope;
    let reads = 0;
    tx.readCurrentEnvelope = async (...args) => {
      reads++;
      const value = await original(...args);
      return reads === 2 ? { ...value, ciphertext: "tampered" } : value;
    };
  }
  return {
    input: { principal: { authenticated: true, role: "archive_admin", principalId: "owner" }, intent },
    provider, state, calls, get rolledBack() { return rolledBack; }
  };
}

test("commits prepared, CAS, read-back and committed journal in one transaction", async () => {
  const fixture = setup();
  const result = await executePiTestnetArchiveReplacementTransaction(fixture.input, fixture.provider);
  assert.equal(result.accepted, true);
  assert.equal(result.action, "replacement_committed_atomically");
  assert.equal(fixture.state.journal.length, 2);
  assert.deepEqual(fixture.calls, [
    "authorize", "read-current", "read-journal", "append-journal",
    "cas", "read-current", "append-journal", "read-journal"
  ]);
});

test("rejects a CAS conflict and relies on provider rollback", async () => {
  const fixture = setup({ conflict: true });
  await assert.rejects(
    executePiTestnetArchiveReplacementTransaction(fixture.input, fixture.provider),
    /compare_and_swap_failed/
  );
  assert.equal(fixture.rolledBack, true);
  assert.equal(fixture.state.envelope.keyId, "old");
  assert.equal(fixture.state.journal.length, 0);
});

test("rolls back if replacement read-back digest does not match", async () => {
  const fixture = setup({ badReadback: true });
  await assert.rejects(
    executePiTestnetArchiveReplacementTransaction(fixture.input, fixture.provider),
    /replacement_readback_verification_failed/
  );
  assert.equal(fixture.rolledBack, true);
  assert.equal(fixture.state.envelope.keyId, "old");
  assert.equal(fixture.state.journal.length, 0);
});

test("rejects providers that do not declare atomic transaction support", async () => {
  const fixture = setup();
  const result = await executePiTestnetArchiveReplacementTransaction(
    fixture.input,
    { ...fixture.provider, supportsAtomicTransactions: false }
  );
  assert.deepEqual(result, { accepted: false, code: "invalid_transaction_contract_or_input" });
});
