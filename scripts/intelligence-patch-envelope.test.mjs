import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  calculatePatchArtifactSha256,
  canonicalPatchEnvelopeBytes,
  normalizeWorkerApprovalRecord,
  validatePatchEnvelope
} from "./intelligence-patch-envelope.mjs";

const approvedAt = "2026-11-18T10:00:00.000Z";
const expiresAt = "2026-11-18T10:30:00.000Z";
const taskId = "task_12345678";
const approvalId = "approval_12345678";
const baseSha = "a".repeat(40);
const scopeSha256 = "b".repeat(64);
const file = { path: "docs/proposal.md", status: "added", mode: "100644", content: "# proposal\n" };


test("normalizes the authenticated Worker issued-grant record into trusted approval context", () => {
  const paths = ["docs/a.md", "docs/proposal.md"];
  const scope = { version: 1, paths };
  const workerRecord = {
    id: "00000000-0000-4000-8000-000000000001",
    taskId,
    repository: "Mehranmsh/mehranmsh.github.io",
    branch: "intelligence/patch-task_12345678",
    baseSha,
    scope,
    scopeSha256: createHash("sha256").update(JSON.stringify(scope)).digest("hex"),
    status: "issued",
    issuedAt: Date.parse(approvedAt) / 1000,
    expiresAt: Date.parse(expiresAt) / 1000,
    revokedAt: null,
    consumedAt: null
  };
  const trustedApproval = normalizeWorkerApprovalRecord(workerRecord);
  assert.ok(trustedApproval);
  assert.equal(trustedApproval.status, "approved");
  assert.equal(trustedApproval.approvalId, workerRecord.id);
  assert.equal(trustedApproval.approvedAt, approvedAt);
  assert.deepEqual(trustedApproval.allowedPaths, paths);

  const { envelope } = fixture();
  envelope.approval.approvalId = workerRecord.id;
  envelope.approval.scopeSha256 = workerRecord.scopeSha256;
  envelope.artifactSha256 = calculatePatchArtifactSha256(envelope);
  assert.equal(validatePatchEnvelope(envelope, trustedApproval, new Date("2026-11-18T10:10:00.000Z")).ok, true);
});

test("rejects Worker approval records that are revoked, consumed, malformed, or not owner-issued", () => {
  const paths = ["docs/proposal.md"];
  const scope = { version: 1, paths };
  const workerRecord = {
    id: "00000000-0000-4000-8000-000000000001",
    taskId,
    repository: "Mehranmsh/mehranmsh.github.io",
    branch: "intelligence/patch-task_12345678",
    baseSha,
    scope,
    scopeSha256: createHash("sha256").update(JSON.stringify(scope)).digest("hex"),
    status: "issued",
    issuedAt: Date.parse(approvedAt) / 1000,
    expiresAt: Date.parse(expiresAt) / 1000,
    revokedAt: null,
    consumedAt: null
  };
  assert.equal(normalizeWorkerApprovalRecord({ ...workerRecord, status: "revoked" }), null);
  assert.equal(normalizeWorkerApprovalRecord({ ...workerRecord, consumedAt: Date.parse(approvedAt) / 1000 }), null);
  assert.equal(normalizeWorkerApprovalRecord({ ...workerRecord, repository: "other/repo" }), null);
  assert.equal(normalizeWorkerApprovalRecord({ ...workerRecord, scopeSha256: "c".repeat(64) }), null);
  assert.equal(normalizeWorkerApprovalRecord({ ...workerRecord, scope: { paths } }), null);
  assert.equal(normalizeWorkerApprovalRecord({ ...workerRecord, scope: { ...scope, version: 2 } }), null);
  assert.equal(normalizeWorkerApprovalRecord({ ...workerRecord, scope: { ...scope, extra: true } }), null);
});

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
