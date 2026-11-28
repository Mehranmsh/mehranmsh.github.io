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
        "source_changes",
        "patch_application",
        "branch_creation",
        "pull_request_creation",
        "merge",
        "deployment",
        "secret_access",
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

test("accepts a bounded repair mission with proposal and isolated test actions", () => {
  const mission = validMission();
  mission.scope.mode = "bounded_app_repair";
  mission.scope.allowed_actions.push("propose_code_patch");
  mission.scope.patch_target_path = "worker.js";
  mission.scope.forbidden = ["direct_source_writes","production_patch_application","unisolated_branch_creation","non_draft_pull_request_creation","merge","deployment","secret_access","credential_or_token_output","wallet_data_access","wallet_operations","financial_operations","arbitrary_shell","changes_to_production_state"];
  assert.deepEqual(validatePrivateIntelligenceMission(mission), []);
});

test("rejects incomplete repair actions and repair actions in a read-only mission", () => {
  const missingProposal = validMission();
  missingProposal.scope.mode = "bounded_app_repair";
  missingProposal.scope.forbidden = ["direct_source_writes","production_patch_application","unisolated_branch_creation","non_draft_pull_request_creation","merge","deployment","secret_access","credential_or_token_output","wallet_data_access","wallet_operations","financial_operations","arbitrary_shell","changes_to_production_state"];
  assert.deepEqual(validatePrivateIntelligenceMission(missingProposal), ["repair_actions_incomplete", "repair_target_path_invalid"]);
  const readOnly = validMission();
  readOnly.scope.allowed_actions.push("propose_code_patch");
  assert.deepEqual(validatePrivateIntelligenceMission(readOnly), ["repair_action_in_read_only_scope"]);
});

test("rejects missing required safety restrictions", () => {
  const mission = validMission();
  mission.scope.forbidden = ["deployment"];
  assert.deepEqual(validatePrivateIntelligenceMission(mission), ["forbidden_actions_incomplete"]);
});

test("rejects malformed mission documents without throwing", () => {
  assert.deepEqual(validatePrivateIntelligenceMission(null), ["invalid_document"]);
  assert.deepEqual(validatePrivateIntelligenceMission([]), ["invalid_document"]);
});

test("accepts the dynamic app inventory capability in a private mission", () => {
  const mission = validMission();
  mission.scope.inspect_paths = ["@app-inventory"];
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
  assert.deepEqual(resolvePrivateIntelligenceInspectionPaths(validMission()), ["@app-inventory"]);
});

test("requires one explicit allowlisted patch target for bounded repair missions", () => {
  const missingTarget = validMission();
  missingTarget.scope.mode = "bounded_app_repair";
  missingTarget.scope.allowed_actions.push("propose_code_patch");
  missingTarget.scope.forbidden = ["direct_source_writes","production_patch_application","unisolated_branch_creation","non_draft_pull_request_creation","merge","deployment","secret_access","credential_or_token_output","wallet_data_access","wallet_operations","financial_operations","arbitrary_shell","changes_to_production_state"];
  assert.deepEqual(validatePrivateIntelligenceMission(missingTarget), ["repair_target_path_invalid"]);

  const validRepair = structuredClone(missingTarget);
  validRepair.scope.patch_target_path = "worker.js";
  assert.deepEqual(validatePrivateIntelligenceMission(validRepair), []);

  for (const path of ["../worker.js", ".env", "src/wallet-balance.js", ".github/workflows/deploy.yml"]) {
    const invalidRepair = structuredClone(validRepair);
    invalidRepair.scope.patch_target_path = path;
    assert.deepEqual(validatePrivateIntelligenceMission(invalidRepair), ["repair_target_path_invalid"]);
  }
});

test("rejects repair targets on read-only missions", () => {
  const mission = validMission();
  mission.scope.patch_target_path = "worker.js";
  assert.deepEqual(validatePrivateIntelligenceMission(mission), ["repair_target_path_in_read_only_scope"]);
});
