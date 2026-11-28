import { isAllowedInspectionPath } from "./intelligence-patch-policy.mjs";

const REQUIRED_ACTIONS = Object.freeze([
  "inspect_repository",
  "source_security_audit",
  "repository_quality_check"
]);

export const PRIVATE_INTELLIGENCE_INSPECTION_PATHS = Object.freeze([
  "worker.js",
  "scripts/intelligence-agent.mjs",
  "scripts/intelligence-capabilities.mjs",
  "scripts/intelligence-capabilities.test.mjs",
  ".github/workflows/mehran-intelligence-runner.yml",
  "docs/INTELLIGENCE_EXECUTION_PROTOCOL.md"
]);

const DEFAULT_INSPECTION_PATHS = Object.freeze([
  "scripts/intelligence-agent.mjs",
  "scripts/intelligence-capabilities.mjs",
  "docs/INTELLIGENCE_EXECUTION_PROTOCOL.md"
]);

export function resolvePrivateIntelligenceInspectionPaths(mission) {
  const paths = mission?.scope?.inspect_paths;
  return Array.isArray(paths) ? [...paths] : [...DEFAULT_INSPECTION_PATHS];
}

const REQUIRED_FORBIDDEN = Object.freeze([
  "source_changes",
  "patch_application",
  "branch_creation",
  "pull_request_creation",
  "merge",
  "deployment",
  "secret_access",
  "arbitrary_shell",
  "changes_to_production_state"
]);

/**
 * Validate the narrow private inbox contract. Returns stable, non-sensitive
 * reason codes so rejected missions are diagnosable without logging payloads.
 */
export function validatePrivateIntelligenceMission(mission) {
  const reasons = [];
  if (!mission || typeof mission !== "object" || Array.isArray(mission)) {
    return ["invalid_document"];
  }
  if (mission.schema_version !== 1) reasons.push("schema_version_mismatch");
  if (mission.status !== "pending_ingestion") reasons.push("status_mismatch");
  if (typeof mission.mission_id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{7,100}$/i.test(mission.mission_id)) {
    reasons.push("mission_id_invalid");
  }
  if (typeof mission.title !== "string" || !mission.title.trim()) reasons.push("title_invalid");
  if (typeof mission.objective !== "string" || mission.objective.trim().length < 40) {
    reasons.push("objective_invalid");
  }
  if (!mission.scope || typeof mission.scope !== "object" ||
      mission.scope.mode !== "read_only_diagnostic") {
    reasons.push("scope_mode_mismatch");
  }
  if (!Array.isArray(mission.scope?.allowed_actions) ||
      !REQUIRED_ACTIONS.every(action => mission.scope.allowed_actions.includes(action))) {
    reasons.push("allowed_actions_incomplete");
  }
  if (mission.scope?.inspect_paths !== undefined) {
    const paths = mission.scope.inspect_paths;
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 6 ||
        new Set(paths).size !== paths.length ||
        paths.some(path => !isAllowedInspectionPath(path))) {
      reasons.push("inspection_paths_invalid");
    }
  }
  if (!Array.isArray(mission.scope?.forbidden) ||
      !REQUIRED_FORBIDDEN.every(action => mission.scope.forbidden.includes(action))) {
    reasons.push("forbidden_actions_incomplete");
  }
  return reasons;
}
