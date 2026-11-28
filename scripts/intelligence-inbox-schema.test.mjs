import test from "node:test";
import assert from "node:assert/strict";
import { validatePrivateIntelligenceMission, resolvePrivateIntelligenceInspectionPaths } from "./intelligence-inbox-schema.mjs";

function validMission() {
  return {
    schema_version: 1,
    mission_id: "mehran-intelligence-inbox-test-2026",
    status: "pending_ingestion",
    title: "Bounded diagnostic test",
    objective: "Inspect the current implementation and report verified findings with source evidence.",
    scope: {
      mode: "read_only_diagnostic",
      allowed_actions: [
        "inspect_repository",
        "source_security_audit",
        "repository_quality_check",
        "run_repository_tests"
      ],
      forbidden: [
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
      ]
    }
  };
}

test("accepts a valid bounded private diagnostic mission", () => {
  assert.deepEqual(validatePrivateIntelligenceMission(validMission()), []);
});

test("reports the exact status and scope mismatches that previously failed silently", () => {
  const mission = validMission();
  mission.status = "pending";
  mission.scope.mode = "read_only_diagnostic_and_planning";
  assert.deepEqual(validatePrivateIntelligenceMission(mission), [
    "status_mismatch",
    "scope_mode_mismatch"
  ]);
});

test("accepts a bounded repair mission with proposal and isolated test actions", () => {\n  const mission = validMission();\n  mission.scope.mode = "bounded_app_repair";\n  mission.scope.allowed_actions.push("propose_code_patch");\n  assert.deepEqual(validatePrivateIntelligenceMission(mission), []);\n});\n\ntest("rejects incomplete repair actions and repair actions in a read-only mission", () => {\n  const missingProposal = validMission();\n  missingProposal.scope.mode = "bounded_app_repair";\n  assert.deepEqual(validatePrivateIntelligenceMission(missingProposal), ["repair_actions_incomplete"]);\n  const readOnly = validMission();\n  readOnly.scope.allowed_actions.push("propose_code_patch");\n  assert.deepEqual(validatePrivateIntelligenceMission(readOnly), ["repair_action_in_read_only_scope"]);\n});\n\ntest("rejects missing required safety restrictions", () => {
  const mission = validMission();
  mission.scope.forbidden = ["deployment"];
  assert.deepEqual(validatePrivateIntelligenceMission(mission), ["forbidden_actions_incomplete"]);
});

test("rejects malformed mission documents without throwing", () => {
  assert.deepEqual(validatePrivateIntelligenceMission(null), ["invalid_document"]);
  assert.deepEqual(validatePrivateIntelligenceMission([]), ["invalid_document"]);
});

test("accepts an exact per-mission inspection path allowlist", () => {
  const mission = validMission();
  mission.scope.inspect_paths = [
    "scripts/intelligence-capabilities.mjs",
    "scripts/intelligence-agent.mjs",
    "docs/INTELLIGENCE_EXECUTION_PROTOCOL.md"
  ];
  assert.deepEqual(validatePrivateIntelligenceMission(mission), []);
  assert.deepEqual(resolvePrivateIntelligenceInspectionPaths(mission), mission.scope.inspect_paths);
});

test("accepts app-wide safe inspection paths", () => {
  const appMission = validMission();
  appMission.scope.inspect_paths = ["social/index.js", "login.html", "music-studio/index.mjs"];
  assert.deepEqual(validatePrivateIntelligenceMission(appMission), []);
  assert.deepEqual(resolvePrivateIntelligenceInspectionPaths(appMission), appMission.scope.inspect_paths);
});

test("rejects private or unsafe inspection paths, duplicates, and empty lists", () => {
  for (const inspect_paths of [
    ["worker.js", "../secrets.txt"],
    ["src/wallet-balance.js"],
    ["src/user-data.json"],
    ["worker.js", "worker.js"],
    []
  ]) {
    const mission = validMission();
    mission.scope.inspect_paths = inspect_paths;
    assert.deepEqual(validatePrivateIntelligenceMission(mission), ["inspection_paths_invalid"]);
  }
});

test("uses a small safe default inspection scope when no paths are supplied", () => {
  assert.deepEqual(resolvePrivateIntelligenceInspectionPaths(validMission()), [
    "scripts/intelligence-agent.mjs",
    "scripts/intelligence-capabilities.mjs",
    "docs/INTELLIGENCE_EXECUTION_PROTOCOL.md"
  ]);
});
