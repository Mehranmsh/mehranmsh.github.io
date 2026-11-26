import test from "node:test";
import assert from "node:assert/strict";
import { buildIntelligenceKnowledgeGraph } from "./intelligence-knowledge-graph.mjs";

const record = (key, extra = {}) => ({
  owner_uid: "owner-a", memory_key: key, memory_type: "semantic", ...extra
});
const confirmed = { relation_confirmed: true, relation_confirmed_by: "owner-a" };

test("builds deterministic owner-confirmed project and dependency links", () => {
  const records = [
    record("project", { related_keys: ["goal"], depends_on_keys: ["goal"], ...confirmed }),
    record("goal", { depends_on_keys: ["project"], ...confirmed })
  ];
  const graph = buildIntelligenceKnowledgeGraph(records, { ownerUid: "owner-a" });
  assert.deepEqual(graph.nodes.map(node => node.id), ["goal", "project"]);
  assert.deepEqual(graph.edges, [
    { from: "goal", to: "project", relation: "depends_on" },
    { from: "project", to: "goal", relation: "depends_on" },
    { from: "project", to: "goal", relation: "related" }
  ]);
  assert.equal(graph.diagnostics.dependencyCycles.length, 1);
});

test("never links across owners or accepts unconfirmed model suggestions", () => {
  const graph = buildIntelligenceKnowledgeGraph([
    record("local", { related_keys: ["foreign"], ...confirmed }),
    record("foreign", { owner_uid: "owner-b" }),
    record("suggested", { related_keys: ["local"] })
  ], { ownerUid: "owner-a" });
  assert.deepEqual(graph.nodes.map(node => node.id), ["local", "suggested"]);
  assert.deepEqual(graph.edges, []);
  assert.equal(graph.diagnostics.danglingReferences, 1);
});

test("excludes health and identity classified records", () => {
  const graph = buildIntelligenceKnowledgeGraph([
    record("safe"),
    record("health-note", { sensitivity: "health" }),
    record("identity-note", { sensitivity: "identity" })
  ], { ownerUid: "owner-a" });
  assert.deepEqual(graph.nodes.map(node => node.id), ["safe"]);
});

test("excludes deleted, inactive, and sensitive records", () => {
  const graph = buildIntelligenceKnowledgeGraph([
    record("active"),
    record("deleted", { deleted_at: "2026-01-01" }),
    record("inactive", { status: "archived" }),
    record("wallet", { sensitivity: "wallet" })
  ], { ownerUid: "owner-a" });
  assert.deepEqual(graph.nodes.map(node => node.id), ["active"]);
});

test("bounds nodes and edges and reports omitted data", () => {
  const graph = buildIntelligenceKnowledgeGraph([
    record("a", { related_keys: ["b", "c"], ...confirmed }),
    record("b"), record("c")
  ], { ownerUid: "owner-a", maxNodes: 2, maxEdges: 1 });
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.diagnostics.omittedNodes, 1);
  assert.equal(graph.diagnostics.omittedEdges, 1);
});

test("does not mutate source records and handles invalid input", () => {
  const records = [record("a", { related_keys: ["b"], ...confirmed }), record("b")];
  const before = structuredClone(records);
  buildIntelligenceKnowledgeGraph(records, { ownerUid: "owner-a" });
  assert.deepEqual(records, before);
  assert.deepEqual(buildIntelligenceKnowledgeGraph(null, { ownerUid: "owner-a" }).nodes, []);
  assert.deepEqual(buildIntelligenceKnowledgeGraph(records, {}).edges, []);
});
