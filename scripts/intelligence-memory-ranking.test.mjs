import test from "node:test";
import assert from "node:assert/strict";
import { selectMemoryContext } from "./intelligence-memory-ranking.mjs";

const now = "2026-11-25T12:00:00.000Z";
function memory(overrides = {}) {
  return {
    owner_uid: "owner-1",
    memory_key: "project-goal",
    memory_type: "semantic",
    content: "Build a secure private MSH intelligence core.",
    source: "owner_confirmed",
    importance: 0.9,
    confidence: 0.95,
    source_trust: 1,
    updated_at: "2026-11-25T10:00:00.000Z",
    ...overrides
  };
}

test("selects only the exact owner's active, provenance-backed memory", () => {
  const result = selectMemoryContext([
    memory(),
    memory({ memory_key: "other-owner", owner_uid: "owner-2" }),
    memory({ memory_key: "no-source", source: "" }),
    memory({ memory_key: "deleted", deleted_at: now }),
    memory({ memory_key: "superseded", superseded_by: "new-key" })
  ], { ownerUid: "owner-1", now });
  assert.deepEqual(result.map(item => item.memory_key), ["project-goal"]);
});

test("excludes expired, future-dated, unknown-type and sensitive records", () => {
  const result = selectMemoryContext([
    memory({ memory_key: "expired", expires_at: "2026-11-25T11:59:59.000Z" }),
    memory({ memory_key: "future", updated_at: "2026-11-26T00:00:00.000Z" }),
    memory({ memory_key: "unknown", memory_type: "guess" }),
    memory({ memory_key: "wallet", sensitivity: "wallet" }),
    memory({ memory_key: "private-social", sensitivity: "private_social" })
  ], { ownerUid: "owner-1", now });
  assert.deepEqual(result, []);
});

test("ranks by bounded weighted evidence and is deterministic on ties", () => {
  const result = selectMemoryContext([
    memory({ memory_key: "low", importance: 0.1, confidence: 0.2, source_trust: 0.2 }),
    memory({ memory_key: "zeta" }),
    memory({ memory_key: "alpha" })
  ], { ownerUid: "owner-1", now });
  assert.deepEqual(result.map(item => item.memory_key), ["alpha", "zeta", "low"]);
  assert.equal(result[0].score, result[1].score);
});

test("enforces item, total character, and count budgets", () => {
  const records = Array.from({ length: 5 }, (_, index) =>
    memory({ memory_key: `key-${index}`, content: "x".repeat(80) })
  );
  const result = selectMemoryContext(records, {
    ownerUid: "owner-1", now, maxItems: 2, maxChars: 180, maxItemChars: 60
  });
  assert.equal(result.length, 2);
  assert.ok(result.every(item => item.content.length <= 60));
  const size = result.reduce((sum, item) =>
    sum + item.memory_key.length + item.memory_type.length + item.content.length + item.source.length, 0);
  assert.ok(size <= 180);
});

test("fails closed for missing owner or malformed records", () => {
  assert.deepEqual(selectMemoryContext([memory()], { now }), []);
  assert.deepEqual(selectMemoryContext([null, [], "bad"], { ownerUid: "owner-1", now }), []);
});
