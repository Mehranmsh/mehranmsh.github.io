import assert from "node:assert/strict";
import test from "node:test";
import { validatePatchProposal } from "./intelligence-patch-policy.mjs";

const path = "scripts/intelligence-capabilities.test.mjs";
const base = {
  baseSha: "a".repeat(40),
  targetPaths: [path],
  summary: "Add a focused regression test",
  diff: `--- a/${path}
+++ b/${path}
@@ -1,1 +1,1 @@
-old
+new
`
};

test("accepts a structurally valid bounded test-only patch", () => {
  assert.equal(validatePatchProposal(base).ok, true);
});

test("rejects unsafe or excessive hunk line positions", () => {
  for (const position of ["9007199254740992", "1000001"]) {
    const input = { ...base, diff: base.diff.replace("@@ -1,1 +1,1 @@", `@@ -${position},1 +1,1 @@`) };
    assert.equal(validatePatchProposal(input).code, "invalid_hunk_position");
  }
});

test("rejects unsafe or excessive hunk counts", () => {
  for (const count of ["9007199254740992", "8193"]) {
    const input = { ...base, diff: base.diff.replace("@@ -1,1 +1,1 @@", `@@ -1,${count} +1,1 @@`) };
    assert.equal(validatePatchProposal(input).code, "invalid_hunk_counts");
  }
});

test("accepts the second exact allowlisted test target and rejects production paths", () => {
  const targetPath = "scripts/intelligence-inbox-schema.test.mjs";
  const input = {
    ...base,
    targetPaths: [targetPath],
    diff: `--- a/${targetPath}
+++ b/${targetPath}
@@ -1,0 +2,1 @@
+test("bounded case", () => {});
`
  };
  assert.equal(validatePatchProposal(input).ok, true);
  assert.equal(validatePatchProposal({ ...input, targetPaths: ["worker.js"] }).code, "path_not_allowed");
});
