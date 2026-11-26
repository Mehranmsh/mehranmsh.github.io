import { selectMemoryContextWithGraph } from "./intelligence-memory-ranking.mjs";
import { diagnoseIntelligenceProjectState } from "./intelligence-project-diagnostics.mjs";
import { buildIntelligenceExecutionPlan } from "./intelligence-execution-planner.mjs";
import { buildApprovedPreferenceProfile } from "./intelligence-preference-governance.mjs";
import { evaluateIntelligenceOptions } from "./intelligence-decision-engine.mjs";
import { buildIntelligenceGoalLifecycle } from "./intelligence-goal-lifecycle.mjs";
import { compareIntelligencePlanVersions } from "./intelligence-plan-history.mjs";
import { learnFromIntelligencePlanOutcomes } from "./intelligence-plan-learning.mjs";

const DEFAULT_LIMITS = Object.freeze({
  maxMemoryItems: 12,
  maxMemoryChars: 6000,
  maxGraphNodes: 40,
  maxGraphEdges: 80,
  maxTasks: 50,
  maxInputRecords: 5000,
  maxPreferenceLedger: 1000,
  maxDecisionOptions: 50,
  maxDecisionCriteria: 30,
  maxGoalTaskProposals: 100,
  maxProgressEvents: 200,
  maxPlanRevisions: 50,
  maxPlanProgressEvents: 500,
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
    decisionEvaluation: { rankedOptions: [], excludedOptions: [], reviewRequired: [], diagnostics: { advisoryOnly: true, decisionMade: false, executionPerformed: false, preferencesApplied: false } },
    goalLifecycle: { goals: [], acceptedTaskProposals: [], rejectedTaskProposals: [], progress: { acceptedEvents: 0, ignoredEvents: 0, taskStates: [] }, executionPlans: [], replanningSuggestions: [], diagnostics: { ownerScoped: false, advisoryOnly: true, recordsChanged: false, tasksCreated: false, tasksExecuted: false, approvalRequired: true } },
    planHistory: { revisions: [], comparison: null, outcomes: [], diagnostics: { ownerScoped: false, advisoryOnly: true, recordsChanged: false, historyWritten: false, approvalRequired: true } },
    planLearning: { patterns: [], observations: [], diagnostics: { ownerScoped: false, advisoryOnly: true, causalClaims: false, recordsChanged: false, preferencesChanged: false, approvalRequired: true } },
    diagnostics: { ownerScoped: false, advisoryOnly: true, memoryChanged: false, preferencesChanged: false, decisionMade: false, executionPerformed: false, outputTrimmed: false }
  };
  if (!ownerUid || !Array.isArray(records)) return empty;

  const limits = {
    maxMemoryItems: boundedInteger(options.maxMemoryItems, DEFAULT_LIMITS.maxMemoryItems, 50),
    maxMemoryChars: boundedInteger(options.maxMemoryChars, DEFAULT_LIMITS.maxMemoryChars, 20000),
    maxGraphNodes: boundedInteger(options.maxGraphNodes, DEFAULT_LIMITS.maxGraphNodes, 100),
    maxGraphEdges: boundedInteger(options.maxGraphEdges, DEFAULT_LIMITS.maxGraphEdges, 200),
    maxTasks: boundedInteger(options.maxTasks, DEFAULT_LIMITS.maxTasks, 100),
    maxInputRecords: boundedInteger(options.maxInputRecords, DEFAULT_LIMITS.maxInputRecords, 10000),
    maxPreferenceLedger: boundedInteger(options.maxPreferenceLedger, DEFAULT_LIMITS.maxPreferenceLedger, 1000),
    maxDecisionOptions: boundedInteger(options.maxDecisionOptions, DEFAULT_LIMITS.maxDecisionOptions, 50),
    maxDecisionCriteria: boundedInteger(options.maxDecisionCriteria, DEFAULT_LIMITS.maxDecisionCriteria, 30),
    maxGoalTaskProposals: boundedInteger(options.maxGoalTaskProposals, DEFAULT_LIMITS.maxGoalTaskProposals, 100),
    maxProgressEvents: boundedInteger(options.maxProgressEvents, DEFAULT_LIMITS.maxProgressEvents, 500),
    maxPlanRevisions: boundedInteger(options.maxPlanRevisions, DEFAULT_LIMITS.maxPlanRevisions, 50),
    maxPlanProgressEvents: boundedInteger(options.maxPlanProgressEvents, DEFAULT_LIMITS.maxPlanProgressEvents, 500),
    maxOutputChars: Math.max(512, boundedInteger(options.maxOutputChars, DEFAULT_LIMITS.maxOutputChars, 30000))
  };
  const boundedRecords = records.slice(0, limits.maxInputRecords);
  const ownerRecords = boundedRecords.filter(record =>
    record && typeof record === "object" && !Array.isArray(record) &&
    record.owner_uid === ownerUid && !record.deleted_at &&
    (!record.status || record.status === "active") &&
    !SENSITIVE.has(String(record.sensitivity || "").toLowerCase())
  );

  const preferenceLedger = Array.isArray(options.preferenceLedger) ? options.preferenceLedger.slice(-limits.maxPreferenceLedger) : [];
  const decisionOptions = Array.isArray(options.decisionOptions) ? options.decisionOptions.slice(0, limits.maxDecisionOptions) : [];
  const decisionCriteria = Array.isArray(options.decisionCriteria) ? options.decisionCriteria.slice(0, limits.maxDecisionCriteria) : [];
  const goalTaskProposals = Array.isArray(options.goalTaskProposals) ? options.goalTaskProposals.slice(0, limits.maxGoalTaskProposals) : [];
  const progressEvents = Array.isArray(options.progressEvents) ? options.progressEvents.slice(0, limits.maxProgressEvents) : [];
  const planRevisions = Array.isArray(options.planRevisions) ? options.planRevisions.slice(-limits.maxPlanRevisions) : [];
  const planProgressEvents = Array.isArray(options.planProgressEvents) ? options.planProgressEvents.slice(-limits.maxPlanProgressEvents) : [];

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
    preferenceLedger,
    { ownerUid }
  );

  const decisionEvaluation = decisionOptions.length && decisionCriteria.length
    ? evaluateIntelligenceOptions(decisionOptions, decisionCriteria, {
        ownerUid,
        actorUid: options.actorUid,
        approvedPreferenceProfile: preferenceProfile,
        allowApprovedPreferences: options.allowApprovedPreferences === true
      })
    : {
        rankedOptions: [], excludedOptions: [], reviewRequired: [],
        diagnostics: { advisoryOnly: true, decisionMade: false, executionPerformed: false, preferencesApplied: false, skipped: true }
      };

  const goalLifecycle = buildIntelligenceGoalLifecycle(
    ownerRecords,
    goalTaskProposals,
    progressEvents,
    { ownerUid, actorUid: options.actorUid, maxItems: limits.maxTasks }
  );

  const planHistory = compareIntelligencePlanVersions(
    planRevisions,
    planProgressEvents,
    { ownerUid, actorUid: options.actorUid, maxRevisions: options.maxPlanRevisions, maxTasks: limits.maxTasks }
  );

  const planLearning = learnFromIntelligencePlanOutcomes(
    planRevisions,
    planProgressEvents,
    { ownerUid, actorUid: options.actorUid, maxRevisions: limits.maxPlanRevisions,
      maxEvents: limits.maxPlanProgressEvents, minObservations: options.minPlanLearningObservations }
  );

  const snapshot = {
    memories: memory.memories,
    graph: memory.graph,
    projectDiagnostics,
    executionPlan,
    preferenceProfile,
    decisionEvaluation,
    goalLifecycle,
    planHistory,
    planLearning,
    diagnostics: {
      ownerScoped: true,
      inputRecords: records.length,
      inspectedInputRecords: boundedRecords.length,
      omittedInputRecords: Math.max(0, records.length - boundedRecords.length),
      auxiliaryInputBounds: {
        preferenceLedgerOmitted: Math.max(0, (Array.isArray(options.preferenceLedger) ? options.preferenceLedger.length : 0) - preferenceLedger.length),
        decisionOptionsOmitted: Math.max(0, (Array.isArray(options.decisionOptions) ? options.decisionOptions.length : 0) - decisionOptions.length),
        decisionCriteriaOmitted: Math.max(0, (Array.isArray(options.decisionCriteria) ? options.decisionCriteria.length : 0) - decisionCriteria.length),
        goalTaskProposalsOmitted: Math.max(0, (Array.isArray(options.goalTaskProposals) ? options.goalTaskProposals.length : 0) - goalTaskProposals.length),
        progressEventsOmitted: Math.max(0, (Array.isArray(options.progressEvents) ? options.progressEvents.length : 0) - progressEvents.length),
        planRevisionsOmitted: Math.max(0, (Array.isArray(options.planRevisions) ? options.planRevisions.length : 0) - planRevisions.length),
        planProgressEventsOmitted: Math.max(0, (Array.isArray(options.planProgressEvents) ? options.planProgressEvents.length : 0) - planProgressEvents.length)
      },
      inspectedOwnerRecords: ownerRecords.length,
      memoryItems: memory.memories.length,
      graphNodes: memory.graph.nodes.length,
      graphEdges: memory.graph.edges.length,
      plannedTasks: executionPlan.orderedTasks.length,
      blockedTasks: executionPlan.blockedTasks.length,
      unresolvedTasks: executionPlan.unresolvedTasks.length,
      approvedPreferences: preferenceProfile.approvedPreferences.length,
      decisionOptionsRanked: decisionEvaluation.rankedOptions.length,
      decisionReviewRequired: decisionEvaluation.reviewRequired.length,
      goalTaskProposalsAccepted: goalLifecycle.acceptedTaskProposals.length,
      goalReplanningSuggestions: goalLifecycle.replanningSuggestions.length,
      planHistoryRevisions: planHistory.revisions.length,
      planHistoryChanges: planHistory.comparison ? planHistory.comparison.added.length + planHistory.comparison.removed.length + planHistory.comparison.changed.length : 0,
      planLearningPatterns: planLearning.patterns.length,
      planLearningObservations: planLearning.diagnostics.observationsAccepted || 0,
      preferencesAppliedForEvaluation: decisionEvaluation.diagnostics.preferencesApplied === true,
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
    goalLifecycle: { ...snapshot.goalLifecycle, acceptedTaskProposals: [], rejectedTaskProposals: [], progress: { acceptedEvents: snapshot.goalLifecycle.progress.acceptedEvents, ignoredEvents: snapshot.goalLifecycle.progress.ignoredEvents, taskStates: [] }, executionPlans: [], replanningSuggestions: [] },
    planHistory: { ...snapshot.planHistory, revisions: snapshot.planHistory.revisions.slice(-2), outcomes: snapshot.planHistory.outcomes.slice(-10) },
    planLearning: { ...snapshot.planLearning, patterns: snapshot.planLearning.patterns.slice(0, 10), observations: snapshot.planLearning.observations.slice(-10) },
    decisionEvaluation: {
      ...snapshot.decisionEvaluation,
      rankedOptions: snapshot.decisionEvaluation.rankedOptions.slice(0, 20),
      excludedOptions: snapshot.decisionEvaluation.excludedOptions.slice(0, 20),
      reviewRequired: snapshot.decisionEvaluation.reviewRequired.slice(0, 20)
    },
    diagnostics: { ...snapshot.diagnostics, outputTrimmed: true }
  };
  while (JSON.stringify(compact).length > limits.maxOutputChars && compact.memories.length) compact.memories.pop();
  while (JSON.stringify(compact).length > limits.maxOutputChars && compact.graph.nodes.length) compact.graph.nodes.pop();
  if (JSON.stringify(compact).length > limits.maxOutputChars) {
    compact.projectDiagnostics = { staleRecords: [], blockedProjects: [], unknownDependencyStates: [], projectsMissingMetadata: [], diagnostics: { advisoryOnly: true, outputBudgetTrimmed: true } };
    compact.executionPlan = { orderedTasks: [], blockedTasks: [], unresolvedTasks: [], diagnostics: { advisoryOnly: true, executionPerformed: false, outputBudgetTrimmed: true } };
    compact.preferenceProfile = { approvedPreferences: [], rejectedDecisions: [], diagnostics: { advisoryOnly: true, preferencesChanged: false, applied: false, outputBudgetTrimmed: true } };
    compact.goalLifecycle = { goals: [], acceptedTaskProposals: [], rejectedTaskProposals: [], progress: { acceptedEvents: 0, ignoredEvents: 0, taskStates: [] }, executionPlans: [], replanningSuggestions: [], diagnostics: { advisoryOnly: true, tasksCreated: false, tasksExecuted: false, approvalRequired: true, outputBudgetTrimmed: true } };
    compact.decisionEvaluation = { rankedOptions: [], excludedOptions: [], reviewRequired: [], diagnostics: { advisoryOnly: true, decisionMade: false, executionPerformed: false, outputBudgetTrimmed: true } };
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
      decisionEvaluation: {},
      goalLifecycle: {},
      diagnostics: { ownerScoped: true, advisoryOnly: true, outputTrimmed: true }
    };
  }
  return compact;
}
