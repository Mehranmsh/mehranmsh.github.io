import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { calculatePatchArtifactSha256 } from "./intelligence-patch-envelope.mjs";
import { verifyIntelligenceGitTree } from "./intelligence-git-tree-guard.mjs";

const repository = "Mehranmsh/mehranmsh.github.io";
const baseSha = "a".repeat(40);
const candidateSha = "c".repeat(40);
const baseTreeSha = "1".repeat(40);
const candidateTreeSha = "2".repeat(40);
const approvedAt = "2026-11-18T10:00:00.000Z";
const expiresAt = "2026-11-18T10:30:00.000Z";
const content = "# verified\n";
const path = "docs/proposal.md";

function blobSha(text) {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
}
function fixture() {
  const trustedApproval = {
    status: "approved", taskId: "task_12345678", approvalId: "approval_12345678",
    approvedAt, expiresAt, scopeSha256: "b".repeat(64), baseSha, allowedPaths: [path]
  };
  const envelope = {
    protocolVersion: 1, taskId: trustedApproval.taskId,
    approval: {
      approvalId: trustedApproval.approvalId, approvedAt, expiresAt,
      scopeSha256: trustedApproval.scopeSha256, baseSha
    },
    baseSha,
    files: [{ path, status: "added", mode: "100644", content }],
    artifactSha256: ""
  };
  envelope.artifactSha256 = calculatePatchArtifactSha256(envelope);
  const baseCommit = { repository, sha: baseSha, treeSha: baseTreeSha, parents: ["9".repeat(40)] };
  const candidateCommit = { repository, sha: candidateSha, treeSha: candidateTreeSha, parents: [baseSha] };
  const baseTree = { sha: baseTreeSha, truncated: false, entries: [] };
  const candidateTree = {
    sha: candidateTreeSha, truncated: false,
    entries: [{ path, mode: "100644", type: "blob", sha: blobSha(content), size: Buffer.byteLength(content) }]
  };
  const input = {
    expectedRepository: repository, expectedBranch: "intelligence/patch-task_12345678", candidateBranch: "intelligence/patch-task_12345678", baseCommit, candidateCommit,
    baseTree, candidateTree, envelope, trustedApproval,
    now: new Date("2026-11-18T10:10:00.000Z")
  };
  return { input, baseCommit, candidateCommit, baseTree, candidateTree, envelope, trustedApproval };
}

test("accepts an exact added Markdown blob on a single-parent candidate commit", () => {
  const { input } = fixture();
  const result = verifyIntelligenceGitTree(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.changedPaths, [path]);
});

test("rejects a changed path not declared in the envelope", () => {
  const { input } = fixture();
  input.candidateTree.entries.push({
    path: "docs/extra.md", mode: "100644", type: "blob", sha: blobSha("extra")
  });
  assert.equal(verifyIntelligenceGitTree(input).ok, false);
});

test("rejects a declared file missing from the candidate tree", () => {
  const { input } = fixture();
  input.candidateTree.entries = [];
  assert.equal(verifyIntelligenceGitTree(input).ok, false);
});

test("rejects byte content that differs from the committed blob SHA", () => {
  const { input } = fixture();
  input.candidateTree.entries[0].sha = blobSha("different bytes");
  assert.equal(verifyIntelligenceGitTree(input).ok, false);
});

test("rejects deleted files", () => {
  const { input } = fixture();
  input.baseTree.entries = [{ path, mode: "100644", type: "blob", sha: blobSha(content) }];
  input.candidateTree.entries = [];
  input.envelope.files[0].status = "added";
  input.envelope.artifactSha256 = calculatePatchArtifactSha256(input.envelope);
  assert.equal(verifyIntelligenceGitTree(input).ok, false);
});

test("accepts a byte-exact modification and requires modified status", () => {
  const { input } = fixture();
  const oldContent = "# old\n";
  input.baseTree.entries = [{ path, mode: "100644", type: "blob", sha: blobSha(oldContent) }];
  input.envelope.files[0].status = "modified";
  input.envelope.artifactSha256 = calculatePatchArtifactSha256(input.envelope);
  assert.equal(verifyIntelligenceGitTree(input).ok, true);
  input.envelope.files[0].status = "added";
  input.envelope.artifactSha256 = calculatePatchArtifactSha256(input.envelope);
  assert.equal(verifyIntelligenceGitTree(input).ok, false);
});

test("rejects truncated trees and tree SHA mismatches", () => {
  const { input } = fixture();
  input.candidateTree.truncated = true;
  assert.equal(verifyIntelligenceGitTree(input).ok, false);
  input.candidateTree.truncated = false;
  input.candidateTree.sha = "3".repeat(40);
  assert.equal(verifyIntelligenceGitTree(input).ok, false);
});

test("rejects merge commits and commits with unexpected parents", () => {
  const { input } = fixture();
  input.candidateCommit.parents = [baseSha, "9".repeat(40)];
  assert.equal(verifyIntelligenceGitTree(input).ok, false);
  input.candidateCommit.parents = ["8".repeat(40)];
  assert.equal(verifyIntelligenceGitTree(input).ok, false);
});

test("rejects repository identity mismatches", () => {
  const { input } = fixture();
  input.candidateCommit.repository = "other/repo";
  assert.equal(verifyIntelligenceGitTree(input).ok, false);
});

test("rejects symlink, executable, and submodule changes", () => {
  for (const entry of [
    { path, mode: "120000", type: "blob", sha: blobSha(content) },
    { path, mode: "100755", type: "blob", sha: blobSha(content) },
    { path, mode: "160000", type: "commit", sha: "d".repeat(40) }
  ]) {
    const { input } = fixture();
    input.candidateTree.entries = [entry];
    assert.equal(verifyIntelligenceGitTree(input).ok, false);
  }
});

test("rejects malformed, duplicate, and colliding tree paths", () => {
  for (const entries of [
    [{ path: "../escape.md", mode: "100644", type: "blob", sha: blobSha(content) }],
    [
      { path, mode: "100644", type: "blob", sha: blobSha(content) },
      { path, mode: "100644", type: "blob", sha: blobSha(content) }
    ],
    [
      { path: "docs/a", mode: "100644", type: "blob", sha: blobSha(content) },
      { path: "docs/a/b.md", mode: "100644", type: "blob", sha: blobSha(content) }
    ]
  ]) {
    const { input } = fixture();
    input.candidateTree.entries = entries;
    assert.equal(verifyIntelligenceGitTree(input).ok, false);
  }
});

test("rejects changed content sizes and expired approvals", () => {
  const { input } = fixture();
  input.candidateTree.entries[0].size = 999;
  assert.equal(verifyIntelligenceGitTree(input).ok, false);
  input.candidateTree.entries[0].size = Buffer.byteLength(content);
  input.now = new Date(expiresAt);
  assert.equal(verifyIntelligenceGitTree(input).ok, false);
});

test("rejects main, mismatched, or non-task-scoped candidate branches", () => {
  for (const [expectedBranch, candidateBranch] of [
    ["main", "main"],
    ["intelligence/patch-task_12345678", "intelligence/patch-task_other123"],
    ["feature/random", "feature/random"]
  ]) {
    const { input } = fixture();
    input.expectedBranch = expectedBranch;
    input.candidateBranch = candidateBranch;
    assert.equal(verifyIntelligenceGitTree(input).ok, false);
  }
});

test("rejects a candidate commit identical to the pinned base", () => {
  const { input } = fixture();
  input.candidateCommit.sha = baseSha;
  assert.equal(verifyIntelligenceGitTree(input).ok, false);
});
