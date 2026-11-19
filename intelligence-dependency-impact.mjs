// Explicit provisional dependency catalog for MEHRAN MSH.
// Edges describe declared architectural relationships, not verified runtime calls.
export const COMPANY_MODULES = Object.freeze([
  "music", "ai", "social", "instruments", "robotics", "security",
  "intelligence", "logistics", "customer-experience", "labs",
  "governance", "data", "robot-operations"
]);

export const DEPENDENCY_CATALOG_VERSION = 1;

export const MODULE_DEPENDENCIES = Object.freeze([
  ["music", "security"], ["music", "data"], ["music", "customer-experience"],
  ["ai", "security"], ["ai", "data"], ["ai", "governance"],
  ["social", "security"], ["social", "data"], ["social", "customer-experience"],
  ["instruments", "security"], ["instruments", "data"], ["instruments", "logistics"], ["instruments", "customer-experience"],
  ["robotics", "security"], ["robotics", "data"], ["robotics", "governance"], ["robotics", "robot-operations"],
  ["robot-operations", "security"], ["robot-operations", "data"], ["robot-operations", "robotics"],
  ["logistics", "security"], ["logistics", "data"], ["logistics", "customer-experience"],
  ["customer-experience", "security"], ["customer-experience", "data"],
  ["labs", "security"], ["labs", "data"], ["labs", "governance"],
  ["governance", "security"], ["governance", "data"],
  ["intelligence", "security"], ["intelligence", "data"], ["intelligence", "governance"]
].map(([moduleId, dependsOn]) => Object.freeze({ moduleId, dependsOn, source: "provisional_owner_declared_catalog" })));

function walk(start, adjacency) {
  const visited = new Map();
  const queue = (adjacency.get(start) || []).map(moduleId => ({ moduleId, depth: 1 }));
  while (queue.length) {
    const current = queue.shift();
    const previous = visited.get(current.moduleId);
    if (previous !== undefined && previous <= current.depth) continue;
    visited.set(current.moduleId, current.depth);
    for (const next of adjacency.get(current.moduleId) || []) {
      if (next !== start) queue.push({ moduleId: next, depth: current.depth + 1 });
    }
  }
  return [...visited.entries()]
    .map(([moduleId, depth]) => ({ moduleId, depth, relationship: depth === 1 ? "direct" : "transitive" }))
    .sort((a, b) => a.depth - b.depth || a.moduleId.localeCompare(b.moduleId));
}

export function analyzeDependencyImpact(moduleId) {
  if (!COMPANY_MODULES.includes(moduleId)) {
    throw new TypeError("Unknown company module.");
  }
  const dependencies = new Map(COMPANY_MODULES.map(id => [id, []]));
  const dependents = new Map(COMPANY_MODULES.map(id => [id, []]));
  for (const edge of MODULE_DEPENDENCIES) {
    dependencies.get(edge.moduleId).push(edge.dependsOn);
    dependents.get(edge.dependsOn).push(edge.moduleId);
  }
  return {
    moduleId,
    catalogVersion: DEPENDENCY_CATALOG_VERSION,
    directDependencies: [...dependencies.get(moduleId)].sort(),
    transitiveDependencies: walk(moduleId, dependencies),
    directlyAffectedModules: [...dependents.get(moduleId)].sort(),
    affectedModules: walk(moduleId, dependents),
    declaredEdgeCount: MODULE_DEPENDENCIES.length,
    source: "provisional_owner_declared_catalog",
    graphCompleteness: "unverified",
    isRuntimeDependencyProof: false,
    isImpactVerdict: false,
    executionEnabled: false,
    operationPerformed: false,
    limitations: [
      "Edges are provisional architecture declarations, not verified code imports, API calls, or runtime traffic.",
      "An absent edge means unknown or not yet recorded, not proof that no dependency exists.",
      "Impact lists are change-review prompts, not predictions of failure or measured blast radius.",
      "Review actual repositories, contracts, data flows, and tests before approving a change.",
      "No repository is scanned, no external evidence is fetched, and no state is modified."
    ]
  };
}
