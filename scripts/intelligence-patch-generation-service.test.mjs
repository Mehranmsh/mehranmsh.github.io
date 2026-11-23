import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeAppendOnlyHunkHeader, generatePatchArtifact, normalizeGeneratedDiff } from "./intelligence-patch-generation-service.mjs";
import { buildPatchGenerationPrompt } from "./intelligence-patch-generation.mjs";

const baseSha = "a".repeat(40);
const currentSha = "b".repeat(40);
const env = { AI: { run: async () => { throw new Error("AI must not run in lookup tests"); } } };

test("patch generation retries a transient GitHub 5xx before validating the immutable base", async () => {
  let calls = 0;
  const result = await generatePatchArtifact({
    env,
    baseSha,
    objective: "Add a focused regression test for a verified edge case",
    reserveBudget: async () => ({ allowed: true }),
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return new Response("temporary upstream failure", { status: 502 });
      return Response.json({ sha: currentSha });
    }
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, { ok: false, code: "stale_base_sha" });
});

test("patch generation bounds repeated GitHub 5xx failures to three attempts", async () => {
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
  assert.equal(calls, 4);
  assert.deepEqual(result, { ok: false, code: "main_commit_lookup_failed" });
});

test("patch generation retries transient network failures and then fails closed", async () => {
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
  assert.equal(calls, 4);
  assert.deepEqual(result, { ok: false, code: "main_commit_lookup_failed" });
});


test("patch generation uses the independent Atom ref after REST API failures", async () => {
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
  assert.equal(calls, 4);
  assert.deepEqual(result, { ok: false, code: "stale_base_sha" });
});


test("patch prompt supplies the exact append-only hunk header for the source line count", () => {
  const source = "const first = 1;\nconst second = 2;\n";
  const prompt = buildPatchGenerationPrompt({
    baseSha,
    objective: "Add a focused regression test for a verified edge case",
    source
  });
  assert.equal(prompt.ok, true);
  assert.ok(prompt.system.includes("@@ -2,0 +3,1 @@"));
  assert.match(prompt.system, /no blank line or commentary/);
  assert.match(prompt.system, /Do not omit ,0 or ,1/);
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

test("does not canonicalize patches with context, deletions, or a different path", () => {
  const malformed = "--- a/scripts/intelligence-capabilities.test.mjs\n+++ b/scripts/intelligence-capabilities.test.mjs\n@@ broken\n context\n+addition\n";
  const wrongPath = "--- a/other.js\n+++ b/other.js\n@@ broken\n+addition\n";
  assert.equal(canonicalizeAppendOnlyHunkHeader(malformed, 42), malformed);
  assert.equal(canonicalizeAppendOnlyHunkHeader(wrongPath, 42), wrongPath);
});
