import assert from "node:assert/strict";
import test from "node:test";
import { getIntelligencePatchTarget, isAllowedIntelligencePatchTarget, INTELLIGENCE_PATCH_TARGETS } from "./intelligence-patch-targets.mjs";

test("patch targets are an explicit test-only allowlist with fixed local test commands", () => {
  assert.deepEqual(Object.keys(INTELLIGENCE_PATCH_TARGETS).sort(), [
    "scripts/intelligence-capabilities.test.mjs",
    "scripts/intelligence-inbox-schema.test.mjs"
  ]);
  for (const [path, policy] of Object.entries(INTELLIGENCE_PATCH_TARGETS)) {
    assert.equal(isAllowedIntelligencePatchTarget(path), true);
    assert.equal(policy.testCommand, "node --test " + path);
    assert.equal(getIntelligencePatchTarget(path).testCommand, policy.testCommand);
  }
});

test("patch target registry rejects production paths, traversal, and lookalike names", () => {
  for (const path of [
    "worker.js",
    "index.html",
    "scripts/intelligence-agent.mjs",
    "../scripts/intelligence-capabilities.test.mjs",
    "scripts/intelligence-capabilities.test.mjs/../../worker.js",
    "scripts/Intelligence-capabilities.test.mjs",
    "scripts/unknown.test.mjs"
  ]) {
    assert.equal(isAllowedIntelligencePatchTarget(path), false, path);
    assert.equal(getIntelligencePatchTarget(path), null, path);
  }
});
