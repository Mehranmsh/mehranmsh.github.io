import { isAllowedInspectionPath } from "./intelligence-patch-policy.mjs";

const REQUIRED_ACTIONS = Object.freeze([
  "inspect_repository",
  "source_security_audit",
  "repository_quality_check"
]);
const REPAIR_ACTIONS = Object.freeze(["run_repository_tests","propose_code_patch"]);

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
  "direct_source_writes",
  "production_patch_application",
  "unisolated_branch_creation",
  "non_draft_pull_request_creation",
  "merge",
  "deployment",
  "secret_access",
  "credential_or_token_output",
  "wallet_data_access",
  "wallet_operations",
  "financial_operations",
  "arbitrary_shell",
  "changes_to_production_state"
]);

/**
 * Validate the private inbox contract. Diagnostic missions stay read-only;
 * bounded repair missions may generate one allowlisted proposal and use the
 * isolated test-gated draft-PR runner. Production writes, merge, deploy,
 * secrets, wallet data, and arbitrary shell remain prohibited.
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
  const mode = mission.scope?.mode;
  if (!mission.scope || typeof mission.scope !== "object" ||
      !["read_only_diagnostic","bounded_app_repair"].includes(mode)) {
    reasons.push("scope_mode_mismatch");
  }
  const allowed = mission.scope?.allowed_actions;
  if (!Array.isArray(allowed) || !REQUIRED_ACTIONS.every(action => allowed.includes(action))) {
    reasons.push("allowed_actions_incomplete");
  }
  if (mode === "bounded_app_repair" &&
      (!REPAIR_ACTIONS.every(action => Array.isArray(allowed) && allowed.includes(action)))) {
    reasons.push("repair_actions_incomplete");
  }
  if (mode === "read_only_diagnostic" && Array.isArray(allowed) && allowed.includes("propose_code_patch")) {
    reasons.push("repair_action_in_read_only_scope");
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
