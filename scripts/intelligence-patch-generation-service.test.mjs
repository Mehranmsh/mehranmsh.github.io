import test from "node:test";
import assert from "node:assert/strict";
import { generatePatchArtifact } from "./intelligence-patch-generation-service.mjs";

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
