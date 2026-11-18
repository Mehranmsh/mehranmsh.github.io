import test from "node:test";
import assert from "node:assert/strict";
import {
  calculatePatchArtifactSha256,
  canonicalPatchEnvelopeBytes,
  validatePatchEnvelope
} from "./intelligence-patch-envelope.mjs";

const approvedAt = "2026-11-18T10:00:00.000Z";
const expiresAt = "2026-11-18T10:30:00.000Z";
const taskId = "task_12345678";
const approvalId = "approval_12345678";
const baseSha = "a".repeat(40);
const scopeSha256 = "b".repeat(64);
const file = { path: "docs/proposal.md", status: "added", mode: "100644", content: "# proposal\n" };

function fixture() {
  const trustedApproval = {
    status: "approved", taskId, approvalId, approvedAt, expiresAt,
    scopeSha256, baseSha, allowedPaths: ["docs/proposal.md"]
  };
  const envelope = {
    protocolVersion: 1, taskId,
    approval: { approvalId, approvedAt, expiresAt, scopeSha256, baseSha },
    baseSha, files: [file], artifactSha256: ""
  };
  envelope.artifactSha256 = calculatePatchArtifactSha256(envelope);
  return { envelope, trustedApproval };
}

test("accepts an envelope bound to the trusted owner approval", () => {
  const { envelope, trustedApproval } = fixture();
  const result = validatePatchEnvelope(envelope, trustedApproval, new Date("2026-11-18T10:10:00.000Z"));
  assert.equal(result.ok, true);
  assert.equal(result.taskId, taskId);
  assert.equal(result.fileCount, 1);
});

test("canonical digest is stable regardless of object key order", () => {
  const { envelope } = fixture();
  const reordered = {
    artifactSha256: envelope.artifactSha256,
    files: envelope.files,
    baseSha: envelope.baseSha,
    approval: envelope.approval,
    taskId: envelope.taskId,
    protocolVersion: envelope.protocolVersion
  };
  assert.deepEqual(canonicalPatchEnvelopeBytes(envelope), canonicalPatchEnvelopeBytes(reordered));
});

test("rejects tampered content and digest", () => {
  const { envelope, trustedApproval } = fixture();
  envelope.files[0].content += "tampered";
  assert.equal(validatePatchEnvelope(envelope, trustedApproval, new Date("2026-11-18T10:10:00Z")).ok, false);
});

test("rejects task, approval, scope, and base mismatches", () => {
  for (const mutate of [
    approval => ({ ...approval, taskId: "task_other123" }),
    approval => ({ ...approval, approvalId: "approval_other123" }),
    approval => ({ ...approval, scopeSha256: "c".repeat(64) }),
    approval => ({ ...approval, baseSha: "d".repeat(40) })
  ]) {
    const { envelope, trustedApproval } = fixture();
    assert.equal(validatePatchEnvelope(envelope, mutate(trustedApproval), new Date("2026-11-18T10:10:00Z")).ok, false);
  }
});

test("rejects expired, premature, and revoked approvals", () => {
  const { envelope, trustedApproval } = fixture();
  assert.equal(validatePatchEnvelope(envelope, trustedApproval, new Date(expiresAt)).ok, false);
  assert.equal(validatePatchEnvelope(envelope, trustedApproval, new Date("2026-11-18T09:59:59Z")).ok, false);
  assert.equal(validatePatchEnvelope(envelope, { ...trustedApproval, status: "revoked" }, new Date("2026-11-18T10:10:00Z")).ok, false);
});

test("rejects paths outside the exact approved path set", () => {
  const { envelope, trustedApproval } = fixture();
  trustedApproval.allowedPaths = ["docs/another.md"];
  assert.equal(validatePatchEnvelope(envelope, trustedApproval, new Date("2026-11-18T10:10:00Z")).ok, false);
});

test("rejects unknown envelope fields and malformed timestamps", () => {
  const { envelope, trustedApproval } = fixture();
  assert.equal(validatePatchEnvelope({ ...envelope, extra: true }, trustedApproval, new Date("2026-11-18T10:10:00Z")).ok, false);
  const malformed = { ...envelope, approval: { ...envelope.approval, expiresAt: "tomorrow" } };
  malformed.artifactSha256 = calculatePatchArtifactSha256(malformed);
  assert.equal(validatePatchEnvelope(malformed, trustedApproval, new Date("2026-11-18T10:10:00Z")).ok, false);
});

test("rejects duplicate file paths", () => {
  const { envelope, trustedApproval } = fixture();
  envelope.files = [file, file];
  envelope.artifactSha256 = calculatePatchArtifactSha256(envelope);
  assert.equal(validatePatchEnvelope(envelope, trustedApproval, new Date("2026-11-18T10:10:00Z")).ok, false);
});

test("rejects unrecognized fields inside individual file entries", () => {
  const { envelope, trustedApproval } = fixture();
  envelope.files[0].unexpected = "not part of protocol";
  envelope.artifactSha256 = calculatePatchArtifactSha256(envelope);
  assert.equal(validatePatchEnvelope(envelope, trustedApproval, new Date("2026-11-18T10:10:00Z")).ok, false);
});

test("rejects approvals marked revoked or already consumed", () => {
  const { envelope, trustedApproval } = fixture();
  const now = new Date("2026-11-18T10:10:00.000Z");
  assert.equal(validatePatchEnvelope(envelope, { ...trustedApproval, revokedAt: "2026-11-18T10:05:00.000Z" }, now).ok, false);
  assert.equal(validatePatchEnvelope(envelope, { ...trustedApproval, consumedAt: "2026-11-18T10:05:00.000Z" }, now).ok, false);
});
test("rejects malformed or empty trusted allowlists", () => {
  const { envelope, trustedApproval } = fixture();
  const now = new Date("2026-11-18T10:10:00.000Z");
  assert.equal(validatePatchEnvelope(envelope, { ...trustedApproval, allowedPaths: [] }, now).ok, false);
  assert.equal(validatePatchEnvelope(envelope, { ...trustedApproval, allowedPaths: [null] }, now).ok, false);
});
