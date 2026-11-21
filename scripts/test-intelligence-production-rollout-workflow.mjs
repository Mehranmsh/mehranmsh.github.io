import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/intelligence-production-d1-rollout.yml", import.meta.url),
  "utf8",
);

assert.ok(workflow.includes("ROLLOUT_ACTION: ${{ inputs.action }}"));
assert.ok(workflow.includes("ROLLOUT_CONFIRMATION: ${{ inputs.confirmation }}"));
assert.ok(workflow.includes("secrets.CLOUDFLARE_ACCOUNT_ID || vars.CLOUDFLARE_ACCOUNT_ID"));
assert.ok(workflow.includes("CLOUDFLARE_ACCOUNT_ID_SECRET: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}"));
assert.ok(workflow.includes("CLOUDFLARE_ACCOUNT_ID_VARIABLE: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}"));

const lines = workflow.split("\n");
const runBodies = [];
let collecting = false;
for (const line of lines) {
  if (line === "        run: |") {
    collecting = true;
    continue;
  }
  if (collecting && line.trim() && !line.startsWith("          ")) collecting = false;
  if (collecting) runBodies.push(line);
}
assert.ok(
  !runBodies.join("\n").includes("${{ inputs."),
  "Untrusted workflow_dispatch inputs must never be interpolated directly into shell scripts.",
);
assert.ok(workflow.includes("APPLY-INTELLIGENCE-0001-TO-PRODUCTION"));
assert.ok(workflow.includes("APPLY-INTELLIGENCE-0002-TO-PRODUCTION"));
assert.ok(workflow.includes("if: github.event_name == 'workflow_dispatch' && inputs.action == 'apply-0001'"));
assert.ok(workflow.includes("if: github.event_name == 'workflow_dispatch' && inputs.action == 'apply-0002'"));
assert.ok(workflow.includes('branches:\n      - "intelligence/production-compatible-v1"'));
assert.ok(workflow.includes("if: github.event_name == 'workflow_dispatch' || github.event_name == 'push'"));
assert.ok(workflow.includes("ROLLOUT_ACTION: ${{ github.event_name == 'push' && 'preflight-0001' || inputs.action }}"));
assert.ok(workflow.includes("if: github.event_name == 'push' || (github.event_name == 'workflow_dispatch'"));

console.log("PASS: production rollout inputs are environment-bound and protected from shell interpolation.");
