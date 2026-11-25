import test from "node:test";
import assert from "node:assert/strict";
import { selectMemoryContext } from "./intelligence-memory-ranking.mjs";

const now = Date.parse("2026-11-25T12:00:00.000Z");
const record = (key, category, content, extra = {}) => ({
  owner_uid: "owner-1", memory_key: key, category, content,
  importance: 4, source: "owner_chat",
  updated_at: "2026-11-24T12:00:00.000Z", ...extra
});

test("query relevance promotes memories matching the current topic", () => {
  const memories = [
    record("music-goal", "goal", "Build the Mehran Music application"),
    record("social-design", "decision", "Keep SOCIAL clean and minimal")
  ];
  const selected = selectMemoryContext(memories, { ownerUid: "owner-1", now, query: "SOCIAL minimal design" });
  assert.equal(selected[0].memory_key, "social-design");
  assert.ok(selected[0].relevance > selected[1].relevance);
});

test("Persian and Arabic character variants normalize consistently", () => {
  const memories = [
    record("ai-topic", "semantic", "طراحی هوش مصنوعی برای مهران"),
    record("other-topic", "semantic", "موضوعی کاملاً متفاوت")
  ];
  const selected = selectMemoryContext(memories, {
    ownerUid: "owner-1", now, query: "طراحی هوش‌مصنوعی برای مهران"
  });
  assert.equal(selected[0].memory_key, "ai-topic");
  assert.equal(selected[0].relevance, 1);
});

test("exact topic phrases outrank records with the same words in a different order", () => {
  const memories = [
    record("shuffled", "semantic", "مهران مصنوعی طراحی هوش"),
    record("exact-phrase", "semantic", "طراحی هوش مصنوعی مهران")
  ];
  const selected = selectMemoryContext(memories, {
    ownerUid: "owner-1", now, query: "طراحی هوش مصنوعی مهران"
  });
  assert.equal(selected[0].memory_key, "exact-phrase");
  assert.ok(selected[0].relevance > selected[1].relevance);
});

test("memory selection remains owner scoped and excludes invalid provenance", () => {
  const memories = [
    record("valid", "goal", "A durable project goal"),
    record("other-owner", "goal", "Private to another owner", { owner_uid: "owner-2" }),
    record("no-source", "goal", "Missing provenance", { source: "" }),
    record("unknown-type", "unclassified", "Must be excluded")
  ];
  const selected = selectMemoryContext(memories, { ownerUid: "owner-1", now });
  assert.deepEqual(selected.map(item => item.memory_key), ["valid"]);
});

test("progress is normalized as episodic memory and context is bounded", () => {
  const memories = [
    record("milestone", "progress", "x".repeat(100), { importance: 5 }),
    record("constraint", "constraint", "Keep deployment owner-approved")
  ];
  const selected = selectMemoryContext(memories, { ownerUid: "owner-1", now, maxItems: 1, maxChars: 200 });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].memory_type, "episodic");
  assert.ok(selected[0].content.length <= 1200);
});

test("personal credentials and financial details never enter model memory context", () => {
  const memories = [
    record("wallet-note", "decision", "My wallet balance is private"),
    record("credential-note", "decision", "The API key is confidential"),
    record("safe-pi-goal", "goal", "Build the Pi Network ecosystem applications")
  ];
  const selected = selectMemoryContext(memories, { ownerUid: "owner-1", now });
  assert.deepEqual(selected.map(item => item.memory_key), ["safe-pi-goal"]);
});
