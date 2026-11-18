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
  "scripts/intelligence-patch-guard.test.mjs"
]);

function fail(reason) { return { ok: false, reason }; }

function gitBlobSha(bytes) {
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\\0`, "utf8"))
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
  if (!Array.isArray(headCommit.parents) || headCommit.parents.length === 0 || headCommit.sha === baseCommit.sha) {
    return fail("Head commit metadata is invalid or identical to base.");
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

async function githubGet(url, token) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!response.ok) throw new Error(`GitHub read failed (${response.status}) for ${url}`);
  return response.json();
}

export async function runReadOnlyAudit(env = process.env) {
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  const baseRef = env.MEHRAN_AUDIT_BASE_REF;
  const headRef = env.MEHRAN_AUDIT_HEAD_REF;
  if (!repository || !token || !baseRef || !headRef) throw new Error("Missing read-only audit environment.");
  const api = "https://api.github.com";
  const get = path => githubGet(`${api}/repos/${repository}/${path}`, token);
  const [base, head] = await Promise.all([
    get(`commits/${encodeURIComponent(baseRef)}`),
    get(`commits/${encodeURIComponent(headRef)}`)
  ]);
  const [baseTree, headTree, comparison] = await Promise.all([
    get(`git/trees/${base.commit.tree.sha}?recursive=1`),
    get(`git/trees/${head.commit.tree.sha}?recursive=1`),
    get(`compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(headRef)}`)
  ]);
  const result = await verifyReadOnlyGitHubSnapshot({
    repository,
    baseCommit: { repository, sha: base.sha, treeSha: base.commit.tree.sha, parents: base.parents.map(p=>p.sha) },
    headCommit: { repository, sha: head.sha, treeSha: head.commit.tree.sha, parents: head.parents.map(p=>p.sha) },
    baseTree, headTree, comparison,
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
