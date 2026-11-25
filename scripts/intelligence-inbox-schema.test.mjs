import test from "node:test";
import assert from "node:assert/strict";
import { validatePrivateIntelligenceMission } from "./intelligence-inbox-schema.mjs";

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
        "credential_or_token_output",
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

test("rejects missing required safety restrictions", () => {
  const mission = validMission();
  mission.scope.forbidden = ["deployment"];
  assert.deepEqual(validatePrivateIntelligenceMission(mission), ["forbidden_actions_incomplete"]);
});

test("rejects malformed mission documents without throwing", () => {
  assert.deepEqual(validatePrivateIntelligenceMission(null), ["invalid_document"]);
  assert.deepEqual(validatePrivateIntelligenceMission([]), ["invalid_document"]);
});

test("accepts explicit semantic analysis mode and rejects unknown modes", () => {
  const mission = validMission();
  mission.analysis_mode = "semantic";
  assert.deepEqual(validatePrivateIntelligenceMission(mission), []);
  mission.analysis_mode = "unbounded";
  assert.deepEqual(validatePrivateIntelligenceMission(mission), ["analysis_mode_invalid"]);
});
