import assert from "node:assert/strict";
import test from "node:test";
import { applyValidatedPatchInMemory } from "./intelligence-patch-apply.mjs";

const targetPath = "scripts/intelligence-capabilities.test.mjs";
const baseSha = "a".repeat(40);
const source = "const existing = true;\n";
const diff = `--- a/${targetPath}
+++ b/${targetPath}
@@ -1,0 +2,1 @@
+test("safe append", () => {});
`;

test("applies a validated append-only patch in memory", () => {
  const result = applyValidatedPatchInMemory({
    baseSha, expectedBaseSha: baseSha, source, targetPath,
    summary: "Append a focused regression test", diff
  });
  assert.equal(result.ok, true);
  assert.equal(result.content, source + 'test("safe append", () => {});\n');
  assert.equal(result.mode, "in_memory_only");
});

test("rejects null and array input without throwing", () => {
  assert.deepEqual(applyValidatedPatchInMemory(null), { ok: false, code: "invalid_input" });
  assert.deepEqual(applyValidatedPatchInMemory([]), { ok: false, code: "invalid_input" });
});

test("rejects stale bases and oversized source input", () => {
  assert.equal(applyValidatedPatchInMemory({
    baseSha, expectedBaseSha: "b".repeat(40), source, targetPath,
    summary: "Append a focused regression test", diff
  }).code, "stale_base_sha");
  assert.equal(applyValidatedPatchInMemory({
    baseSha, expectedBaseSha: baseSha, source: "x".repeat(128 * 1024) + "\n",
    targetPath, summary: "Append a focused regression test", diff
  }).code, "invalid_source");
});

test("rejects source without a final newline and excessive source line counts", () => {
  assert.equal(applyValidatedPatchInMemory({
    baseSha, expectedBaseSha: baseSha, source: "missing newline", targetPath,
    summary: "Append a focused regression test", diff
  }).code, "invalid_source");
  const manyLines = "x\n".repeat(20001);
  assert.equal(applyValidatedPatchInMemory({
    baseSha, expectedBaseSha: baseSha, source: manyLines, targetPath,
    summary: "Append a focused regression test", diff
  }).code, "invalid_source");
});

test("never accepts a deletion or a patch targeting another file", () => {
  const deletion = diff.replace("@@ -1,0 +2,1 @@", "@@ -1,1 +1,0 @@").replace("+test(\"safe append\", () => {});", "-const existing = true;");
  assert.notEqual(applyValidatedPatchInMemory({
    baseSha, expectedBaseSha: baseSha, source, targetPath,
    summary: "Append a focused regression test", diff: deletion
  }).ok, true);
  const wrongPath = diff.replaceAll(targetPath, "scripts/other.test.mjs");
  assert.equal(applyValidatedPatchInMemory({
    baseSha, expectedBaseSha: baseSha, source, targetPath: "scripts/other.test.mjs",
    summary: "Append a focused regression test", diff: wrongPath
  }).code, "path_not_allowed");
});
