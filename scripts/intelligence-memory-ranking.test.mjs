import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMemoryRelations, selectMemoryContext, selectMemoryContextWithGraph } from "./intelligence-memory-ranking.mjs";

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

test("health and identity classified memories are excluded from model context", () => {
  const memories = [
    record("health-note", "semantic", "Private health context", { sensitivity: "health" }),
    record("identity-note", "semantic", "Private identity context", { sensitivity: "identity" }),
    record("safe-note", "semantic", "A non-sensitive project note")
  ];
  const selected = selectMemoryContext(memories, { ownerUid: "owner-1", now });
  assert.deepEqual(selected.map(item => item.memory_key), ["safe-note"]);
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


test("a newer explicit decision supersedes the older decision without deleting history", () => {
  const memories = [
    record("ui-theme-old", "decision", "Use a gold and black interface", { updated_at: "2026-11-20T12:00:00.000Z" }),
    record("ui-theme-new", "decision", "Use a blue and black interface", {
      updated_at: "2026-11-24T12:00:00.000Z", supersedes_key: "ui-theme-old", relation_confirmed: true, relation_confirmed_by: "owner-1"
    })
  ];
  const relations = analyzeMemoryRelations(memories);
  assert.equal(relations.supersededKeys.has(JSON.stringify(["owner-1", "ui-theme-old"])), true);
  const selected = selectMemoryContext(memories, { ownerUid: "owner-1", now, query: "interface theme" });
  assert.deepEqual(selected.map(item => item.memory_key), ["ui-theme-new"]);
  assert.equal(memories.length, 2, "history remains untouched");
});

test("an older or cross-owner record cannot supersede another owner's decision", () => {
  const memories = [
    record("current", "decision", "Current owner decision", { updated_at: "2026-11-24T12:00:00.000Z" }),
    record("stale", "decision", "Stale attempted replacement", {
      updated_at: "2026-11-20T12:00:00.000Z", supersedes_key: "current", relation_confirmed: true, relation_confirmed_by: "owner-1"
    }),
    record("foreign", "decision", "Foreign owner replacement", {
      owner_uid: "owner-2", updated_at: "2026-11-25T11:00:00.000Z", supersedes_key: "current", relation_confirmed: true, relation_confirmed_by: "owner-2"
    })
  ];
  const relations = analyzeMemoryRelations(memories);
  assert.equal(relations.supersededKeys.size, 0);
});

test("explicit conflicts are surfaced instead of silently choosing a winner", () => {
  const memories = [
    record("choice-a", "decision", "Enable public registration", { conflicts_with: ["choice-b"], relation_confirmed: true, relation_confirmed_by: "owner-1" }),
    record("choice-b", "decision", "Disable public registration")
  ];
  const selected = selectMemoryContext(memories, { ownerUid: "owner-1", now });
  assert.deepEqual(selected.map(item => item.relation_status), ["conflict", "conflict"]);
});

test("memory relations never cross owner boundaries", () => {
  const memories = [
    record("private-a", "decision", "A private decision", { conflicts_with: ["private-b"], relation_confirmed: true, relation_confirmed_by: "owner-1" }),
    record("private-b", "decision", "Another owner's decision", { owner_uid: "owner-2" })
  ];
  const relations = analyzeMemoryRelations(memories);
  assert.equal(relations.conflictedKeys.size, 0);
});


test("unconfirmed model-suggested relations cannot rewrite owner memory", () => {
  const memories = [
    record("decision-old", "decision", "Keep the interface dark", { updated_at: "2026-11-20T12:00:00.000Z" }),
    record("decision-new", "decision", "Change the interface to bright", {
      updated_at: "2026-11-24T12:00:00.000Z", supersedes_key: "decision-old",
      conflicts_with: ["decision-old"], relation_confirmed: true, relation_confirmed_by: "assistant"
    })
  ];
  const selected = selectMemoryContext(memories, { ownerUid: "owner-1", now });
  assert.equal(selected.length, 2);
  assert.ok(selected.every(item => item.relation_status === "current"));
});


test("combined memory context returns a bounded owner-scoped graph without changing ranking", () => {
  const memories = [
    record("project-a", "project", "Build project A", {
      related_keys: ["goal-a"], relation_confirmed: true, relation_confirmed_by: "owner-1"
    }),
    record("goal-a", "goal", "Finish the first milestone"),
    record("foreign", "goal", "Private foreign memory", { owner_uid: "owner-2" })
  ];
  const ordinary = selectMemoryContext(memories, { ownerUid: "owner-1", now, query: "project" });
  const combined = selectMemoryContextWithGraph(memories, {
    ownerUid: "owner-1", now, query: "project", graphMaxNodes: 1, graphMaxEdges: 1
  });
  assert.deepEqual(combined.memories, ordinary);
  assert.deepEqual(combined.graph.nodes.map(node => node.id), ["goal-a"]);
  assert.equal(combined.graph.diagnostics.omittedNodes, 1);
  assert.equal(combined.graph.edges.length, 0);
  assert.ok(!combined.graph.nodes.some(node => node.id === "foreign"));
});
