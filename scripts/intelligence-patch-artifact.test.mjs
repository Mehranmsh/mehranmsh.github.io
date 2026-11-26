import assert from "node:assert/strict";
import test from "node:test";
import { createPatchArtifactRecord, verifyPatchArtifactRecord } from "./intelligence-patch-artifact.mjs";

const targetPath = "scripts/intelligence-capabilities.test.mjs";
const validInput = {
  proposalId: "123e4567-e89b-42d3-a456-426614174000",
  createdAt: "2026-11-26T00:00:00.000Z",
  baseSha: "a".repeat(40),
  targetPath,
  targetPaths: [targetPath],
  summary: "Add a focused regression test",
  diff: `--- a/${targetPath}
+++ b/${targetPath}
@@ -10,0 +11,1 @@
+test("artifact regression", () => {});
`
};

test("creates and verifies a canonical patch artifact", async () => {
  const created = await createPatchArtifactRecord(validInput);
  assert.equal(created.ok, true);
  const verified = await verifyPatchArtifactRecord(created.artifact, created.artifactSha256);
  assert.equal(verified.ok, true);
  assert.equal(verified.mode, "verify_only");
});

test("rejects malformed UUIDs instead of accepting arbitrary hyphen placement", async () => {
  for (const proposalId of [
    "------------------------------------",
    "12345678-1234-1234-1234-123456789abc",
    "123e4567e89b42d3a45642661417400000"
  ]) {
    const result = await createPatchArtifactRecord({ ...validInput, proposalId });
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_proposal_id");
  }
});

test("verifier rejects malformed identifiers and non-canonical timestamps", async () => {
  const created = await createPatchArtifactRecord(validInput);
  assert.equal(created.ok, true);
  const malformedId = { ...created.artifact, proposalId: "------------------------------------" };
  assert.equal((await verifyPatchArtifactRecord(malformedId, created.artifactSha256)).code, "invalid_artifact_metadata");
  const malformedDate = { ...created.artifact, createdAt: "2026-11-26" };
  assert.equal((await verifyPatchArtifactRecord(malformedDate, created.artifactSha256)).code, "invalid_artifact_metadata");
  const nonStringDate = { ...created.artifact, createdAt: { toString: () => "2026-11-26T00:00:00.000Z" } };
  assert.equal((await verifyPatchArtifactRecord(nonStringDate, created.artifactSha256)).code, "invalid_artifact_metadata");
});

test("verifier rejects unexpected artifact fields and tampered digests", async () => {
  const created = await createPatchArtifactRecord(validInput);
  assert.equal(created.ok, true);
  assert.equal((await verifyPatchArtifactRecord({ ...created.artifact, trusted: true }, created.artifactSha256)).code, "artifact_schema_mismatch");
  assert.equal((await verifyPatchArtifactRecord({ ...created.artifact, diff: created.artifact.diff + "+\n" }, created.artifactSha256)).code, "diff_digest_mismatch");
});
