import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeAppendOnlyHunkHeader, generatePatchArtifact, inspectGeneratedDiffShape, normalizeGeneratedDiff } from "./intelligence-patch-generation-service.mjs";
import { buildPatchGenerationPrompt } from "./intelligence-patch-generation.mjs";

const baseSha = "a".repeat(40);
const currentSha = "b".repeat(40);
const env = { AI: { run: async () => { throw new Error("AI must not run in lookup tests"); } } };

test("patch generation verifies the immutable base using concurrent independent GitHub refs", async () => {
  let calls = 0;
  const result = await generatePatchArtifact({
    env,
    baseSha,
    objective: "Add a focused regression test for a verified edge case",
    reserveBudget: async () => ({ allowed: true }),
    fetchImpl: async url => {
      calls++;
      if (String(url).includes("/commits/main")) return new Response("temporary upstream failure", { status: 502 });
      if (String(url).includes("/git/ref/heads/main")) return Response.json({ object: { sha: currentSha } });
      return new Response(
        `<feed><entry><id>tag:github.com,2008:Grit::Commit/${currentSha}</id></entry></feed>`,
        { status: 200 }
      );
    }
  });
  assert.equal(calls, 3);
  assert.deepEqual(result, { ok: false, code: "stale_base_sha" });
});

test("patch generation bounds repeated failures across all independent GitHub refs", async () => {
  let calls = 0;
  const result = await generatePatchArtifact({
    env,
    baseSha,
    objective: "Add a focused regression test for a verified edge case",
    reserveBudget: async () => ({ allowed: true }),
    fetchImpl: async () => {
      calls++;
      return new Response("temporary upstream failure", { status: 502 });
    }
  });
  assert.equal(calls, 6);
  assert.deepEqual(result, { ok: false, code: "main_commit_lookup_failed" });
});

test("patch generation retries independent ref lookups after network failures and fails closed", async () => {
  let calls = 0;
  const result = await generatePatchArtifact({
    env,
    baseSha,
    objective: "Add a focused regression test for a verified edge case",
    reserveBudget: async () => ({ allowed: true }),
    fetchImpl: async () => {
      calls++;
      throw new Error("temporary network failure");
    }
  });
  assert.equal(calls, 6);
  assert.deepEqual(result, { ok: false, code: "main_commit_lookup_failed" });
});

test("patch generation accepts the independent Atom ref when REST endpoints fail", async () => {
  let calls = 0;
  const result = await generatePatchArtifact({
    env,
    baseSha,
    objective: "Add a focused regression test for a verified edge case",
    reserveBudget: async () => ({ allowed: true }),
    fetchImpl: async url => {
      calls++;
      if (String(url).includes("api.github.com")) {
        return new Response("temporary upstream failure", { status: 502 });
      }
      return new Response(
        `<feed><entry><id>tag:github.com,2008:Grit::Commit/${currentSha}</id></entry></feed>`,
        { status: 200 }
      );
    }
  });
  assert.equal(calls, 3);
  assert.deepEqual(result, { ok: false, code: "stale_base_sha" });
});

test("patch generation fails closed when independent GitHub refs disagree", async () => {
  let calls = 0;
  const result = await generatePatchArtifact({
    env,
    baseSha,
    objective: "Add a focused regression test for a verified edge case",
    reserveBudget: async () => ({ allowed: true }),
    fetchImpl: async url => {
      calls++;
      if (String(url).includes("/commits/main")) return Response.json({ sha: currentSha });
      if (String(url).includes("/git/ref/heads/main")) return Response.json({ object: { sha: "c".repeat(40) } });
      return new Response("<feed></feed>", { status: 200 });
    }
  });
  assert.equal(calls, 6);
  assert.deepEqual(result, { ok: false, code: "main_commit_lookup_failed" });
});


test("patch prompt supplies the exact append-only hunk header for the source line count", () => {
  const source = "const first = 1;\nconst second = 2;\n";
  const prompt = buildPatchGenerationPrompt({
    baseSha,
    objective: "Add a focused regression test for a verified edge case",
    source
  });
  assert.equal(prompt.ok, true);
  assert.ok(prompt.system.includes("@@ -2,0 +3,K @@"));
  assert.match(prompt.system, /no blank line or commentary/);
  assert.match(prompt.system, /Do not omit ,0 or ,K/);
});

test("generated patch normalization converts CRLF and adds the required final newline", () => {
  assert.equal(normalizeGeneratedDiff("--- a/file\r\n+++ b/file\r\n@@ -1,0 +2,1 @@\r\n+test"), "--- a/file\n+++ b/file\n@@ -1,0 +2,1 @@\n+test\n");
  assert.equal(normalizeGeneratedDiff("--- a/file\n+++ b/file\n"), "--- a/file\n+++ b/file\n");
});

test("generated patch normalization rejects bare carriage returns", () => {
  assert.equal(normalizeGeneratedDiff("--- a/file\r+++ b/file"), null);
});

test("canonicalizes only malformed hunk counts for exact-path additions-only patches", () => {
  const input = [
    "--- a/scripts/intelligence-capabilities.test.mjs",
    "+++ b/scripts/intelligence-capabilities.test.mjs",
    "@@ malformed header",
    "+test(\"safe append-only case\", () => {});",
    "+test(\"second safe case\", () => {});",
    ""
  ].join("\n");
  const output = canonicalizeAppendOnlyHunkHeader(input, 42);
  assert.equal(output.split("\n")[2], "@@ -42,0 +43,2 @@");
  assert.equal(output.split("\n").slice(3).join("\n"), input.split("\n").slice(3).join("\n"));
});

test("canonicalizes safe context but rejects deletions and a different path", () => {
  const context = "--- a/scripts/intelligence-capabilities.test.mjs\\n+++ b/scripts/intelligence-capabilities.test.mjs\\n@@ broken\\n context\\n+addition\\n";
  const deletion = "--- a/scripts/intelligence-capabilities.test.mjs\\n+++ b/scripts/intelligence-capabilities.test.mjs\\n@@ broken\\n-deletion\\n+addition\\n";
  const wrongPath = "--- a/other.js\\n+++ b/other.js\\n@@ broken\\n+addition\\n";
  assert.equal(canonicalizeAppendOnlyHunkHeader(context, 42), "--- a/scripts/intelligence-capabilities.test.mjs\\n+++ b/scripts/intelligence-capabilities.test.mjs\\n@@ -42,0 +43,1 @@\\n+addition\\n");
  assert.equal(canonicalizeAppendOnlyHunkHeader(deletion, 42), deletion);
  assert.equal(canonicalizeAppendOnlyHunkHeader(wrongPath, 42), wrongPath);
});
test("diff diagnostics expose only structural metadata and identify unsafe payload shapes", () => {
  const malformed = [
    "--- a/scripts/intelligence-capabilities.test.mjs",
    "+++ b/scripts/intelligence-capabilities.test.mjs",
    "@@ malformed",
    "+one",
    " context",
    "+two",
    ""
  ].join("\n");
  const diagnostic = inspectGeneratedDiffShape(malformed);
  assert.equal(diagnostic.reason, "contains_non_addition");
  assert.equal(diagnostic.exactPath, true);
  assert.equal(diagnostic.additions, 2);
  assert.equal(diagnostic.contexts, 1);
  assert.equal(diagnostic.deletions, 0);
  assert.equal(Object.hasOwn(diagnostic, "raw"), false);
  assert.equal(Object.hasOwn(diagnostic, "diff"), false);
});
