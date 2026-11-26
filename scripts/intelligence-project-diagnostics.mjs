const DEFAULT_STALE_AFTER_DAYS = 30;
const MAX_RECORDS = 500;
const BLOCKED_STATES = new Set(["blocked", "paused", "waiting", "incomplete"]);
const COMPLETE_STATES = new Set(["complete", "completed", "done"]);

function diagnosticTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeDiagnosticKey(value) {
  return typeof value === "string" ? value.trim().slice(0, 160) : "";
}

function isDiagnosticSafe(record, ownerUid) {
  return record && typeof record === "object" && !Array.isArray(record) &&
    record.owner_uid === ownerUid && !record.deleted_at &&
    (!record.status || record.status === "active") &&
    !new Set(["secret", "credential", "wallet", "financial", "private_social", "health", "identity"])
      .has(String(record.sensitivity || "").toLowerCase());
}

function projectLike(record) {
  const type = String(record.memory_type || record.category || "").toLowerCase();
  return type === "project" || type === "goal" ||
    (typeof record.project_id === "string" && record.project_id.trim().length > 0);
}

/**
 * Produce bounded, owner-scoped, advisory project diagnostics.
 * Requires explicit timestamps and dependency metadata; never mutates records.
 */
export function diagnoseIntelligenceProjectState(records, options = {}) {
  const ownerUid = typeof options.ownerUid === "string" ? options.ownerUid.trim() : "";
  const now = diagnosticTimestamp(options.now) ?? Date.now();
  const staleAfterDays = Number.isFinite(options.staleAfterDays) && options.staleAfterDays >= 1
    ? Math.min(options.staleAfterDays, 3650) : DEFAULT_STALE_AFTER_DAYS;
  const maxRecords = Number.isInteger(options.maxRecords) && options.maxRecords > 0
    ? Math.min(options.maxRecords, MAX_RECORDS) : 100;
  if (!ownerUid || !Array.isArray(records)) {
    return {
      staleRecords: [], blockedProjects: [], unknownDependencyStates: [],
      projectsMissingMetadata: [],
      diagnostics: { omittedRecords: 0, inspectedRecords: 0, advisoryOnly: true }
    };
  }

  const eligible = records.filter(record => isDiagnosticSafe(record, ownerUid))
    .sort((a, b) => safeDiagnosticKey(a.memory_key).localeCompare(safeDiagnosticKey(b.memory_key)));
  const inspected = eligible.slice(0, maxRecords);
  const byKey = new Map();
  for (const record of inspected) {
    const key = safeDiagnosticKey(record.memory_key);
    if (key && !byKey.has(key)) byKey.set(key, record);
  }

  const staleRecords = [];
  const projectsMissingMetadata = [];
  const thresholdMs = staleAfterDays * 86_400_000;
  for (const record of inspected) {
    const key = safeDiagnosticKey(record.memory_key);
    if (!key) continue;
    const updatedAt = diagnosticTimestamp(record.updated_at);
    if (updatedAt !== null && updatedAt <= now && now - updatedAt >= thresholdMs) {
      staleRecords.push({
        memory_key: key,
        age_days: Math.floor((now - updatedAt) / 86_400_000),
        evidence: ["updated_at"],
        advisory: "possibly_stale"
      });
    }
    if (projectLike(record) && (!updatedAt || typeof record.source !== "string" || !record.source.trim())) {
      projectsMissingMetadata.push({
        memory_key: key,
        missing: [
          ...(!updatedAt ? ["valid_updated_at"] : []),
          ...(typeof record.source !== "string" || !record.source.trim() ? ["source"] : [])
        ],
        advisory: "insufficient_metadata"
      });
    }
  }

  const blockedProjects = [];
  const unknownDependencyStates = [];
  for (const record of inspected) {
    const projectKey = safeDiagnosticKey(record.memory_key);
    if (!projectKey || !projectLike(record)) continue;
    const rawDependencies = record.depends_on_keys;
    const dependencies = [...new Set((Array.isArray(rawDependencies)
      ? rawDependencies : (typeof rawDependencies === "string" ? [rawDependencies] : []))
      .map(safeDiagnosticKey).filter(Boolean))].sort();
    if (!dependencies.length) continue;

    const blockedBy = [];
    const unknown = [];
    for (const dependencyKey of dependencies) {
      const dependency = byKey.get(dependencyKey);
      if (!dependency) {
        unknown.push({ memory_key: dependencyKey, reason: "missing_or_out_of_scope" });
        continue;
      }
      const state = String(dependency.project_state || dependency.state || "").toLowerCase().trim();
      if (BLOCKED_STATES.has(state)) {
        blockedBy.push({ memory_key: dependencyKey, state });
      } else if (!COMPLETE_STATES.has(state)) {
        unknown.push({ memory_key: dependencyKey, reason: "state_not_explicitly_complete" });
      }
    }
    if (blockedBy.length) blockedProjects.push({
      memory_key: projectKey, blocked_by: blockedBy,
      evidence: ["owner_scoped_depends_on_keys", "explicit_dependency_state"],
      advisory: "possibly_blocked"
    });
    if (unknown.length) unknownDependencyStates.push({
      memory_key: projectKey, dependencies: unknown,
      advisory: "dependency_status_unknown"
    });
  }

  return {
    staleRecords,
    blockedProjects,
    unknownDependencyStates,
    projectsMissingMetadata,
    diagnostics: {
      omittedRecords: Math.max(0, eligible.length - inspected.length),
      inspectedRecords: inspected.length,
      advisoryOnly: true
    }
  };
}
