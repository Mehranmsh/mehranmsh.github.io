import test from "node:test";
import assert from "node:assert/strict";
import { validateIntelligencePatch, INTELLIGENCE_PATCH_LIMITS } from "./intelligence-patch-guard.mjs";

const valid = (path = "docs/proposal.md", content = "# Safe proposal\n") => ({
  path, content, status: "added", mode: "100644"
});

test("accepts a small documentation-only patch", () => {
  const result = validateIntelligencePatch([valid()]);
  assert.equal(result.ok, true);
  assert.equal(result.fileCount, 1);
  assert.equal(result.totalBytes, Buffer.byteLength("# Safe proposal\n"));
});

test("rejects paths outside the strict allowlist", () => {
  for (const path of ["worker.js", ".github/workflows/run.yml", "docs/../worker.js", "/docs/a.md", "docs\\secret.md", "docs/readme.txt"]) {
    assert.equal(validateIntelligencePatch([valid(path)]).ok, false, path);
  }
});

test("rejects ambiguous and platform-sensitive path segments", () => {
  for (const path of [
    "docs//nested.md", "docs/./nested.md", "docs/../nested.md",
    "docs/name .md", "docs/NUL.md", "docs/CON.md",
    "docs/folder./nested.md", "docs/zero\u200bwidth.md", "docs/trailing./nested.md"
  ]) {
    assert.equal(validateIntelligencePatch([valid(path)]).ok, false, path);
  }
});

test("requires explicit status and regular-file mode metadata", () => {
  const { status, ...withoutStatus } = valid();
  const { mode, ...withoutMode } = valid();
  assert.equal(validateIntelligencePatch([withoutStatus]).ok, false);
  assert.equal(validateIntelligencePatch([withoutMode]).ok, false);
  assert.equal(validateIntelligencePatch([{ ...valid(), mode: "120000" }]).ok, false);
  assert.equal(validateIntelligencePatch([{ ...valid(), mode: "160000" }]).ok, false);
});

test("rejects duplicate paths and unsupported file operations", () => {
  assert.equal(validateIntelligencePatch([valid(), valid()]).ok, false);
  assert.equal(validateIntelligencePatch([{ ...valid(), status: "deleted" }]).ok, false);
  assert.equal(validateIntelligencePatch([{ ...valid(), status: "renamed" }]).ok, false);
});

test("enforces file count and per-file size limits", () => {
  const tooMany = Array.from({ length: INTELLIGENCE_PATCH_LIMITS.maxFiles + 1 }, (_, i) => valid(`docs/${i}.md`));
  assert.equal(validateIntelligencePatch(tooMany).ok, false);
  assert.equal(validateIntelligencePatch([valid("docs/large.md", "x".repeat(INTELLIGENCE_PATCH_LIMITS.maxFileBytes + 1))]).ok, false);
});

test("enforces total patch size", () => {
  const chunk = "x".repeat(40 * 1024);
  const files = Array.from({ length: 5 }, (_, i) => valid(`docs/${i}.md`, chunk));
  assert.equal(validateIntelligencePatch(files).ok, false);
});

test("rejects likely credential material and binary content", () => {
  assert.equal(validateIntelligencePatch([valid("docs/leak.md", "token: ghp_abcdefghijklmnopqrstuvwxyz123456")]).ok, false);
  assert.equal(validateIntelligencePatch([valid("docs/binary.md", "abc\u0000def")]).ok, false);
});

test("rejects malformed entries, non-text values, and invalid Unicode", () => {
  assert.equal(validateIntelligencePatch(null).ok, false);
  assert.equal(validateIntelligencePatch([null]).ok, false);
  assert.equal(validateIntelligencePatch([{ path: "docs/a.md", content: new Uint8Array([1, 2]), status: "added", mode: "100644" }]).ok, false);
  assert.equal(validateIntelligencePatch([valid("docs/a.md", "\ud800")]).ok, false);
});

test("rejects case-insensitive path collisions on common filesystems", () => {
  const files = [valid("docs/Guide.md"), valid("docs/guide.md")];
  assert.equal(validateIntelligencePatch(files).ok, false);
});
