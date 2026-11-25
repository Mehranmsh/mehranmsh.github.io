const BLOCKED_SENSITIVITY = new Set(["secret", "credential", "wallet", "financial", "private_social"]);
const RELATION_FIELDS = Object.freeze({
  related_keys: "related",
  supports_keys: "supports",
  depends_on_keys: "depends_on"
});
const DEFAULT_LIMITS = Object.freeze({ maxNodes: 100, maxEdges: 200 });

function safeKey(value) {
  return typeof value === "string" ? value.trim().slice(0, 160) : "";
}

function isSafeRecord(record) {
  return record && typeof record === "object" && !Array.isArray(record) &&
    typeof record.owner_uid === "string" && record.owner_uid.trim() &&
    safeKey(record.memory_key) && !record.deleted_at &&
    (!record.status || record.status === "active") &&
    !BLOCKED_SENSITIVITY.has(String(record.sensitivity || "").toLowerCase());
}

/**
 * Build a bounded, read-only graph from owner-confirmed metadata.
 * Graph edges are descriptive only: they never execute tasks or change memory.
 */
export function buildIntelligenceKnowledgeGraph(records, options = {}) {
  const ownerUid = typeof options.ownerUid === "string" ? options.ownerUid.trim() : "";
  const maxNodes = Number.isInteger(options.maxNodes) && options.maxNodes > 0
    ? Math.min(options.maxNodes, 500) : DEFAULT_LIMITS.maxNodes;
  const maxEdges = Number.isInteger(options.maxEdges) && options.maxEdges > 0
    ? Math.min(options.maxEdges, 1000) : DEFAULT_LIMITS.maxEdges;
  if (!ownerUid || !Array.isArray(records)) {
    return { nodes: [], edges: [], diagnostics: { omittedNodes: 0, omittedEdges: 0, danglingReferences: 0, dependencyCycles: [] } };
  }

  const eligible = records.filter(record => isSafeRecord(record) && record.owner_uid.trim() === ownerUid);
  const byKey = new Map();
  for (const record of eligible) {
    const key = safeKey(record.memory_key);
    if (!byKey.has(key)) byKey.set(key, record);
  }
  const ordered = [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b));
  const nodes = ordered.slice(0, maxNodes).map(([key, record]) => ({
    id: key,
    type: typeof record.memory_type === "string" ? record.memory_type.slice(0, 40) : "unknown",
    label: key
  }));
  const included = new Set(nodes.map(node => node.id));
  let omittedEdges = 0;
  let danglingReferences = 0;
  const edges = [];
  for (const [from, record] of ordered) {
    if (!included.has(from) || record.relation_confirmed !== true ||
        record.relation_confirmed_by !== ownerUid) continue;
    for (const [field, relation] of Object.entries(RELATION_FIELDS)) {
      const raw = record[field];
      const targets = Array.isArray(raw) ? raw : (typeof raw === "string" ? [raw] : []);
      for (const rawTarget of targets) {
        const to = safeKey(rawTarget);
        if (!to || to === from) continue;
        if (!byKey.has(to)) { danglingReferences++; continue; }
        if (!included.has(to)) { omittedEdges++; continue; }
        if (edges.length >= maxEdges) { omittedEdges++; continue; }
        edges.push({ from, to, relation });
      }
    }
  }
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.relation.localeCompare(b.relation) || a.to.localeCompare(b.to));

  const adjacency = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) if (edge.relation === "depends_on") adjacency.get(edge.from)?.push(edge.to);
  const visiting = new Set();
  const visited = new Set();
  const cycleSet = new Set();
  function visit(node, path) {
    if (visiting.has(node)) {
      const start = path.indexOf(node);
      if (start >= 0) cycleSet.add([...path.slice(start), node].join(" -> "));
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of adjacency.get(node) || []) visit(next, [...path, node]);
    visiting.delete(node);
    visited.add(node);
  }
  for (const node of nodes) visit(node.id, []);
  return {
    nodes,
    edges,
    diagnostics: {
      omittedNodes: Math.max(0, ordered.length - nodes.length),
      omittedEdges,
      danglingReferences,
      dependencyCycles: [...cycleSet].sort()
    }
  };
}
