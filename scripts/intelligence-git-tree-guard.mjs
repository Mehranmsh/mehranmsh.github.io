import { createHash } from "node:crypto";
import { validatePatchEnvelope } from "./intelligence-patch-envelope.mjs";

const GIT_SHA = /^[a-f0-9]{40}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function blocked(reason) {
  return { ok: false, reason };
}

function validPath(path) {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(path)) return false;
  const parts = path.split("/");
  return parts.every(part =>
    part.length > 0 &&
    part !== "." &&
    part !== ".." &&
    !/[. ]$/.test(part) &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(part) &&
    SAFE_SEGMENT.test(part)
  );
}

function gitBlobSha(content) {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

function normalizeTree(tree, label) {
  if (!tree || typeof tree !== "object" || tree.truncated !== false || !Array.isArray(tree.entries)) {
    throw new Error(`${label} tree is missing, malformed, or truncated.`);
  }
  const leaves = new Map();
  const directories = new Set();
  for (const entry of tree.entries) {
    if (!entry || typeof entry !== "object" || !validPath(entry.path) ||
        !GIT_SHA.test(entry.sha || "") ||
        typeof entry.mode !== "string" ||
        !["blob", "tree", "commit"].includes(entry.type)) {
      throw new Error(`${label} tree contains a malformed entry.`);
    }
    if (entry.type === "tree") {
      if (entry.mode !== "040000" || directories.has(entry.path) || leaves.has(entry.path)) {
        throw new Error(`${label} tree contains an invalid directory entry.`);
      }
      directories.add(entry.path);
      continue;
    }
    if (leaves.has(entry.path) || directories.has(entry.path)) {
      throw new Error(`${label} tree contains a duplicate or colliding path.`);
    }
    leaves.set(entry.path, entry);
  }
  for (const path of leaves.keys()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (leaves.has(parts.slice(0, i).join("/"))) {
        throw new Error(`${label} tree contains a file/directory path collision.`);
      }
    }
  }
  return leaves;
}

/**
 * Pure verifier for GitHub commit/tree snapshots. It performs no network,
 * filesystem, GitHub write, or command execution. Callers must fetch snapshots
 * from the trusted repository and re-fetch immediately before any future write.
 */
export function verifyIntelligenceGitTree({
  expectedRepository,
  baseCommit,
  candidateCommit,
  baseTree,
  candidateTree,
  envelope,
  trustedApproval,
  now = new Date()
}) {
  if (typeof expectedRepository !== "string" || !expectedRepository.includes("/")) {
    return blocked("Expected repository identity is missing.");
  }
  if (!baseCommit || !candidateCommit ||
      baseCommit.repository !== expectedRepository ||
      candidateCommit.repository !== expectedRepository) {
    return blocked("Commit repository identity mismatch.");
  }
  if (!GIT_SHA.test(baseCommit.sha || "") ||
      !GIT_SHA.test(candidateCommit.sha || "") ||
      !GIT_SHA.test(baseCommit.treeSha || "") ||
      !GIT_SHA.test(candidateCommit.treeSha || "")) {
    return blocked("Commit or tree SHA is malformed.");
  }
  if (baseCommit.sha !== envelope?.baseSha) {
    return blocked("Pinned base commit does not match the patch envelope.");
  }
  if (!Array.isArray(candidateCommit.parents) ||
      candidateCommit.parents.length !== 1 ||
      candidateCommit.parents[0] !== baseCommit.sha) {
    return blocked("Candidate commit must have exactly the pinned base as its sole parent.");
  }
  const envelopeResult = validatePatchEnvelope(envelope, trustedApproval, now);
  if (!envelopeResult.ok) return blocked(`Patch envelope rejected: ${envelopeResult.reason}`);

  let base;
  let candidate;
  try {
    base = normalizeTree(baseTree, "Base");
    candidate = normalizeTree(candidateTree, "Candidate");
  } catch (error) {
    return blocked(error.message);
  }
  if (baseTree.sha !== baseCommit.treeSha || candidateTree.sha !== candidateCommit.treeSha) {
    return blocked("Tree snapshot SHA does not match its commit.");
  }

  const changedPaths = new Set();
  for (const [path, before] of base) {
    const after = candidate.get(path);
    if (!after || before.sha !== after.sha || before.mode !== after.mode || before.type !== after.type) {
      changedPaths.add(path);
    }
  }
  for (const path of candidate.keys()) {
    if (!base.has(path)) changedPaths.add(path);
  }

  const declared = new Map(envelope.files.map(file => [file.path, file]));
  if (changedPaths.size !== declared.size ||
      [...changedPaths].some(path => !declared.has(path))) {
    return blocked("Actual Git changed-path set does not exactly match the envelope.");
  }

  for (const path of changedPaths) {
    const before = base.get(path);
    const after = candidate.get(path);
    const file = declared.get(path);
    if (!after) return blocked(`Deletion is not permitted: ${path}`);
    if (after.type !== "blob" || after.mode !== "100644") {
      return blocked(`Changed path is not a regular 100644 blob: ${path}`);
    }
    if (before && (before.type !== "blob" || before.mode !== "100644")) {
      return blocked(`Changed path replaces an unsupported Git object: ${path}`);
    }
    const expectedStatus = before ? "modified" : "added";
    if (file.status !== expectedStatus || file.mode !== after.mode) {
      return blocked(`Envelope status or mode differs from Git for ${path}`);
    }
    if (after.sha !== gitBlobSha(file.content)) {
      return blocked(`Committed Git blob bytes do not match envelope content: ${path}`);
    }
    const byteLength = Buffer.byteLength(file.content, "utf8");
    if (after.size !== undefined && after.size !== byteLength) {
      return blocked(`Committed blob size does not match envelope content: ${path}`);
    }
  }

  return {
    ok: true,
    repository: expectedRepository,
    baseSha: baseCommit.sha,
    candidateSha: candidateCommit.sha,
    baseTreeSha: baseTree.sha,
    candidateTreeSha: candidateTree.sha,
    changedPaths: [...changedPaths].sort(),
    fileCount: changedPaths.size,
    artifactSha256: envelopeResult.artifactSha256
  };
}

export const INTELLIGENCE_GIT_TREE_VERIFIER_VERSION = 1;
