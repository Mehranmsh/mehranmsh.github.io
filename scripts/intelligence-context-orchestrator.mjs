import { selectMemoryContextWithGraph } from "./intelligence-memory-ranking.mjs";
import { diagnoseIntelligenceProjectState } from "./intelligence-project-diagnostics.mjs";
import { buildIntelligenceExecutionPlan } from "./intelligence-execution-planner.mjs";
import { buildApprovedPreferenceProfile } from "./intelligence-preference-governance.mjs";

const DEFAULT_LIMITS = Object.freeze({
  maxMemoryItems: 12,
  maxMemoryChars: 6000,
  maxGraphNodes: 40,
  maxGraphEdges: 80,
  maxTasks: 50,
  maxOutputChars: 18000
});
const SENSITIVE = new Set(["secret", "credential", "wallet", "financial", "private_social", "health", "identity"]);

function boundedInteger(value, fallback, maximum) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

/**
 * Build one bounded, owner-scoped snapshot across Intelligence subsystems.
 * This is a read-only coordinator: it does not infer relations, alter memory,
 * approve preferences, make decisions, or execute tasks.
 */
export function buildIntelligenceContextSnapshot(records, options = {}) {
  const ownerUid = typeof options.ownerUid === "string" ? options.ownerUid.trim() : "";
  const empty = {
    memories: [],
    graph: { nodes: [], edges: [], diagnostics: { omittedNodes: 0, omittedEdges: 0, danglingReferences: 0, dependencyCycles: [] } },
    projectDiagnostics: { staleRecords: [], blockedProjects: [], unknownDependencyStates: [], projectsMissingMetadata: [], diagnostics: { omittedRecords: 0, inspectedRecords: 0, advisoryOnly: true } },
    executionPlan: { orderedTasks: [], blockedTasks: [], unresolvedTasks: [], diagnostics: { inspectedTasks: 0, omittedTasks: 0, completedTasksExcluded: 0, activeTasksExcluded: 0, advisoryOnly: true, executionPerformed: false } },
    preferenceProfile: { approvedPreferences: [], rejectedDecisions: [], diagnostics: { ownerScoped: false, advisoryOnly: true, preferencesChanged: false, applied: false } },
    diagnostics: { ownerScoped: false, advisoryOnly: true, memoryChanged: false, preferencesChanged: false, decisionMade: false, executionPerformed: false, outputTrimmed: false }
  };
  if (!ownerUid || !Array.isArray(records)) return empty;

  const limits = {
    maxMemoryItems: boundedInteger(options.maxMemoryItems, DEFAULT_LIMITS.maxMemoryItems, 50),
    maxMemoryChars: boundedInteger(options.maxMemoryChars, DEFAULT_LIMITS.maxMemoryChars, 20000),
    maxGraphNodes: boundedInteger(options.maxGraphNodes, DEFAULT_LIMITS.maxGraphNodes, 100),
    maxGraphEdges: boundedInteger(options.maxGraphEdges, DEFAULT_LIMITS.maxGraphEdges, 200),
    maxTasks: boundedInteger(options.maxTasks, DEFAULT_LIMITS.maxTasks, 100),
    maxOutputChars: Math.max(512, boundedInteger(options.maxOutputChars, DEFAULT_LIMITS.maxOutputChars, 30000))
  };
  const ownerRecords = records.filter(record =>
    record && typeof record === "object" && !Array.isArray(record) &&
    record.owner_uid === ownerUid && !record.deleted_at &&
    (!record.status || record.status === "active") &&
    !SENSITIVE.has(String(record.sensitivity || "").toLowerCase())
  );

  const memory = selectMemoryContextWithGraph(ownerRecords, {
    ...options,
    ownerUid,
    maxItems: limits.maxMemoryItems,
    maxChars: limits.maxMemoryChars,
    graphMaxNodes: limits.maxGraphNodes,
    graphMaxEdges: limits.maxGraphEdges
  });
  const projectDiagnostics = diagnoseIntelligenceProjectState(ownerRecords, {
    ownerUid, now: options.now, staleAfterDays: options.staleAfterDays, maxRecords: options.maxRecords
  });
  const executionPlan = buildIntelligenceExecutionPlan(ownerRecords, {
    ownerUid, maxTasks: limits.maxTasks
  });
  const preferenceProfile = buildApprovedPreferenceProfile(
    Array.isArray(options.preferenceLedger) ? options.preferenceLedger : [],
    { ownerUid }
  );

  const snapshot = {
    memories: memory.memories,
    graph: memory.graph,
    projectDiagnostics,
    executionPlan,
    preferenceProfile,
    diagnostics: {
      ownerScoped: true,
      inputRecords: records.length,
      inspectedOwnerRecords: ownerRecords.length,
      memoryItems: memory.memories.length,
      graphNodes: memory.graph.nodes.length,
      graphEdges: memory.graph.edges.length,
      plannedTasks: executionPlan.orderedTasks.length,
      blockedTasks: executionPlan.blockedTasks.length,
      unresolvedTasks: executionPlan.unresolvedTasks.length,
      approvedPreferences: preferenceProfile.approvedPreferences.length,
      advisoryOnly: true,
      memoryChanged: false,
      preferencesChanged: false,
      decisionMade: false,
      executionPerformed: false,
      outputTrimmed: false
    }
  };

  const serialized = JSON.stringify(snapshot);
  if (serialized.length <= limits.maxOutputChars) return snapshot;

  // Preserve the highest-value compact signals first, then trim graph detail.
  const compact = {
    ...snapshot,
    graph: { ...snapshot.graph, edges: [], diagnostics: { ...snapshot.graph.diagnostics, outputBudgetTrimmed: true } },
    projectDiagnostics: {
      ...snapshot.projectDiagnostics,
      staleRecords: snapshot.projectDiagnostics.staleRecords.slice(0, 20),
      blockedProjects: snapshot.projectDiagnostics.blockedProjects.slice(0, 20),
      unknownDependencyStates: snapshot.projectDiagnostics.unknownDependencyStates.slice(0, 20),
      projectsMissingMetadata: snapshot.projectDiagnostics.projectsMissingMetadata.slice(0, 20)
    },
    executionPlan: {
      ...snapshot.executionPlan,
      orderedTasks: snapshot.executionPlan.orderedTasks.slice(0, 20),
      blockedTasks: snapshot.executionPlan.blockedTasks.slice(0, 20),
      unresolvedTasks: snapshot.executionPlan.unresolvedTasks.slice(0, 20)
    },
    preferenceProfile: {
      ...snapshot.preferenceProfile,
      approvedPreferences: snapshot.preferenceProfile.approvedPreferences.slice(0, 20),
      rejectedDecisions: snapshot.preferenceProfile.rejectedDecisions.slice(0, 20)
    },
    diagnostics: { ...snapshot.diagnostics, outputTrimmed: true }
  };
  while (JSON.stringify(compact).length > limits.maxOutputChars && compact.memories.length) compact.memories.pop();
  while (JSON.stringify(compact).length > limits.maxOutputChars && compact.graph.nodes.length) compact.graph.nodes.pop();
  if (JSON.stringify(compact).length > limits.maxOutputChars) {
    compact.projectDiagnostics = { staleRecords: [], blockedProjects: [], unknownDependencyStates: [], projectsMissingMetadata: [], diagnostics: { advisoryOnly: true, outputBudgetTrimmed: true } };
    compact.executionPlan = { orderedTasks: [], blockedTasks: [], unresolvedTasks: [], diagnostics: { advisoryOnly: true, executionPerformed: false, outputBudgetTrimmed: true } };
    compact.preferenceProfile = { approvedPreferences: [], rejectedDecisions: [], diagnostics: { advisoryOnly: true, preferencesChanged: false, applied: false, outputBudgetTrimmed: true } };
    compact.graph = { nodes: [], edges: [], diagnostics: { omittedNodes: snapshot.graph.nodes.length, omittedEdges: snapshot.graph.edges.length, outputBudgetTrimmed: true } };
    compact.memories = [];
  }
  if (JSON.stringify(compact).length > limits.maxOutputChars) {
    return {
      memories: [],
      graph: { nodes: [], edges: [] },
      projectDiagnostics: {},
      executionPlan: {},
      preferenceProfile: {},
      diagnostics: { ownerScoped: true, advisoryOnly: true, outputTrimmed: true }
    };
  }
  return compact;
}
