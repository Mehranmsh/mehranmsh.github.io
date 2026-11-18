import { createHash } from "node:crypto";

const SHA = /^[a-f0-9]{40}$/;
const ALLOWED_PATHS = new Set([
  ".github/workflows/intelligence-patch-guard.yml",
  "docs/INTELLIGENCE-CODE-CHANGE-SAFETY.md",
  "docs/INTELLIGENCE-GIT-TREE-VERIFICATION.md",
  "docs/INTELLIGENCE-PATCH-ARTIFACT-CONTRACT.md",
  "scripts/intelligence-git-tree-guard.mjs",
  "scripts/intelligence-git-tree-guard.test.mjs",
  "scripts/intelligence-patch-envelope.mjs",
  "scripts/intelligence-patch-envelope.test.mjs",
  "scripts/intelligence-patch-guard.mjs",
  "scripts/intelligence-patch-guard.test.mjs",
  "scripts/intelligence-github-readonly-audit.mjs",
  "scripts/intelligence-github-readonly-audit.test.mjs"
]);

function fail(reason) { return { ok: false, reason }; }

function gitBlobSha(bytes) {
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

function leafMap(tree, label) {
  if (!tree || tree.truncated !== false || !Array.isArray(tree.tree)) {
    throw new Error(`${label} tree is missing or truncated.`);
  }
  const map = new Map();
  for (const item of tree.tree) {
    if (!item || typeof item.path !== "string" || !SHA.test(item.sha || "") ||
        typeof item.mode !== "string" || !["blob", "tree", "commit"].includes(item.type)) {
      throw new Error(`${label} tree has malformed entries.`);
    }
    if (item.type === "tree") continue;
    if (map.has(item.path)) throw new Error(`${label} tree has duplicate paths.`);
    map.set(item.path, item);
  }
  return map;
}

export async function verifyReadOnlyGitHubSnapshot({
  repository, baseCommit, headCommit, baseTree, headTree,
  comparison, fetchBlob, allowedPaths = ALLOWED_PATHS
}) {
  if (typeof repository !== "string" || !repository.includes("/")) return fail("Repository identity missing.");
  if (!baseCommit || !headCommit || baseCommit.repository !== repository || headCommit.repository !== repository) {
    return fail("Commit repository identity mismatch.");
  }
  if (!SHA.test(baseCommit.sha || "") || !SHA.test(headCommit.sha || "") ||
      !SHA.test(baseCommit.treeSha || "") || !SHA.test(headCommit.treeSha || "")) {
    return fail("Malformed commit or tree SHA.");
  }
  if (!Array.isArray(headCommit.parents) || headCommit.parents.length === 0 || headCommit.sha === baseCommit.sha || headCommit.parents[0] !== baseCommit.sha) {
    return fail("Head commit must be a new commit whose first parent is the pinned base.");
  }
  if (comparison?.base_commit?.sha !== baseCommit.sha ||
      comparison?.merge_base_commit?.sha !== baseCommit.sha ||
      !Array.isArray(comparison?.commits) ||
      comparison.commits.at(-1)?.sha !== headCommit.sha) {
    return fail("GitHub comparison is not bound to the exact base, merge-base, and head commits.");
  }
  if (baseTree?.sha !== baseCommit.treeSha || headTree?.sha !== headCommit.treeSha) {
    return fail("Tree SHA does not match commit metadata.");
  }
  let base, head;
  try { base = leafMap(baseTree, "Base"); head = leafMap(headTree, "Head"); }
  catch (e) { return fail(e.message); }

  const changed = new Map();
  for (const [path, before] of base) {
    const after = head.get(path);
    if (!after) changed.set(path, "removed");
    else if (before.sha !== after.sha || before.mode !== after.mode || before.type !== after.type) changed.set(path, "modified");
  }
  for (const path of head.keys()) if (!base.has(path)) changed.set(path, "added");

  if (comparison?.too_large === true || !Array.isArray(comparison?.files)) return fail("GitHub comparison is incomplete.");
  const compareMap = new Map();
  for (const file of comparison.files) {
    if (!file || typeof file.filename !== "string" || compareMap.has(file.filename)) return fail("Malformed comparison file list.");
    compareMap.set(file.filename, file.status);
  }
  if (changed.size !== compareMap.size || [...changed].some(([path, status]) => compareMap.get(path) !== status)) {
    return fail("Git tree changes do not exactly match GitHub compare file list.");
  }
  if (changed.size !== allowedPaths.size || [...changed.keys()].some(path => !allowedPaths.has(path))) {
    return fail("Changed path set differs from the exact approved allowlist.");
  }

  const verified = [];
  for (const [path, status] of changed) {
    if (status !== "added" && status !== "modified") return fail(`Deletion or unsupported change: ${path}`);
    const item = head.get(path);
    if (!item || item.type !== "blob" || item.mode !== "100644") return fail(`Unsupported Git object or mode: ${path}`);
    if (typeof fetchBlob !== "function") return fail("Read-only blob fetch function missing.");
    const blob = await fetchBlob(item.sha);
    if (!blob || !(blob.bytes instanceof Uint8Array)) return fail(`Blob response malformed: ${path}`);
    if (gitBlobSha(blob.bytes) !== item.sha) return fail(`Git blob digest mismatch: ${path}`);
    if (blob.bytes.length !== item.size && Number.isInteger(item.size)) return fail(`Git blob size mismatch: ${path}`);
    verified.push({ path, status, blobSha: item.sha, bytes: blob.bytes.length });
  }

  return {
    ok: true, repository, baseSha: baseCommit.sha, headSha: headCommit.sha,
    baseTreeSha: baseTree.sha, headTreeSha: headTree.sha,
    changedFiles: verified.sort((a,b)=>a.path.localeCompare(b.path))
  };
}

const EXPECTED_REPOSITORY = "Mehranmsh/mehranmsh.github.io";
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const API_TIMEOUT_MS = 10_000;

async function readBoundedBody(response) {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined) {
    const size = Number(declared);
    if (!Number.isFinite(size) || size < 0 || size > MAX_API_RESPONSE_BYTES) {
      throw new Error("GitHub API response exceeds the configured size limit.");
    }
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_API_RESPONSE_BYTES) {
      throw new Error("GitHub API response exceeds the configured size limit.");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_API_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("GitHub API response exceeds the configured size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function githubGet(url, token, fetchImpl = globalThis.fetch) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.origin !== "https://api.github.com" ||
      !parsed.pathname.startsWith(`/repos/${EXPECTED_REPOSITORY}/`) ||
      parsed.username || parsed.password || parsed.hash) {
    throw new Error("Read-only adapter rejected a non-allowlisted GitHub API URL.");
  }
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!response.ok) throw new Error(`GitHub read failed (${response.status}).`);
  const contentType = response.headers?.get?.("content-type") || "";
  if (contentType.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new Error("GitHub API returned an unexpected content type.");
  }
  const body = await readBoundedBody(response);
  try { return JSON.parse(body); }
  catch { throw new Error("GitHub API returned invalid JSON."); }
}

export async function runReadOnlyAudit(env = process.env, fetchImpl = globalThis.fetch, allowedPaths = ALLOWED_PATHS) {
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  const baseSha = env.MEHRAN_AUDIT_BASE_SHA;
  const headSha = env.GITHUB_SHA;
  if (repository !== EXPECTED_REPOSITORY || !token || !SHA.test(baseSha || "") || !SHA.test(headSha || "")) throw new Error("Missing, untrusted, or malformed read-only audit environment.");
  const api = "https://api.github.com";
  const get = path => githubGet(`${api}/repos/${repository}/${path}`, token, fetchImpl);
  const [base, head] = await Promise.all([
    get(`commits/${baseSha}`),
    get(`commits/${headSha}`)
  ]);
  for (const [label, commit] of [["base", base], ["head", head]]) {
    if (!commit || !SHA.test(commit.sha || "") ||
        !SHA.test(commit.commit?.tree?.sha || "") ||
        !Array.isArray(commit.parents) ||
        commit.parents.some(parent => !SHA.test(parent?.sha || ""))) {
      throw new Error(`GitHub returned malformed ${label} commit metadata.`);
    }
  }
  const [baseTree, headTree, comparison] = await Promise.all([
    get(`git/trees/${base.commit.tree.sha}?recursive=1`),
    get(`git/trees/${head.commit.tree.sha}?recursive=1`),
    get(`compare/${baseSha}...${headSha}`)
  ]);
  if (!baseTree || !headTree || !Array.isArray(baseTree.tree) ||
      !Array.isArray(headTree.tree) || typeof baseTree.truncated !== "boolean" ||
      typeof headTree.truncated !== "boolean") {
    throw new Error("GitHub returned malformed tree metadata.");
  }
  const result = await verifyReadOnlyGitHubSnapshot({
    repository,
    baseCommit: { repository, sha: base.sha, treeSha: base.commit.tree.sha, parents: base.parents.map(p=>p.sha) },
    headCommit: { repository, sha: head.sha, treeSha: head.commit.tree.sha, parents: head.parents.map(p=>p.sha) },
    baseTree, headTree, comparison,
    allowedPaths,
    fetchBlob: async sha => {
      const blob = await get(`git/blobs/${sha}`);
      if (blob.encoding !== "base64" || typeof blob.content !== "string") throw new Error("Unsupported GitHub blob encoding.");
      return { bytes: new Uint8Array(Buffer.from(blob.content.replace(/\\n/g, ""), "base64")) };
    }
  });
  if (!result.ok) throw new Error(result.reason);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runReadOnlyAudit().then(result => {
    console.log(JSON.stringify({
      ok: result.ok, repository: result.repository,
      baseSha: result.baseSha, headSha: result.headSha,
      changedFiles: result.changedFiles.length,
      paths: result.changedFiles.map(file => file.path)
    }, null, 2));
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
