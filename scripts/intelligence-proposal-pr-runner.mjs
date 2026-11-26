import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyValidatedPatchInMemory } from "./intelligence-patch-apply.mjs";
import { readBoundedResponse } from "./intelligence-bounded-response.mjs";
import { getIntelligencePatchTarget } from "./intelligence-patch-targets.mjs";

const baseUrl = process.env.MEHRAN_AGENT_URL;
const agentToken = process.env.MEHRAN_AGENT_TOKEN || "";
const ownerToken = process.env.MEHRAN_ORCHESTRATOR_TOKEN || "";
const githubToken = process.env.GITHUB_TOKEN || "";
const runId = String(process.env.GITHUB_RUN_ID || "");
const currentMainSha = String(process.env.GITHUB_SHA || "").toLowerCase();
const repository = "Mehranmsh/mehranmsh.github.io";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const apiRoot = "https://api.github.com";
if (!baseUrl || agentToken.length < 40 || ownerToken.length < 40 || githubToken.length < 40 ||
    !/^[0-9]{1,24}$/.test(runId) || !/^[a-f0-9]{40}$/.test(currentMainSha)) {
  throw new Error("Verified proposal runner configuration is incomplete.");
}
const readJsonResponse = async (response, maxBytes) => {
  const raw = await readBoundedResponse(response, maxBytes);
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    throw new Error("Remote API returned invalid JSON.");
  }
};
const workerRequest = async (path, token, options = {}) => {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: { "Authorization": "Bearer " + token, "Accept": "application/json",
      "Content-Type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(30000)
  });
  const payload = await readJsonResponse(response, 65536);
  if (!response.ok) throw new Error("Worker proposal API HTTP " + response.status + ": " + String(payload.error || "request failed").slice(0,160));
  return payload;
};
const gh = async (path, method = "GET", body = undefined) => {
  const response = await fetch(apiRoot + path, {
    method,
    headers: { "Authorization": "Bearer " + githubToken, "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json",
      "User-Agent": "MEHRAN-INTELLIGENCE-Review-Proposal-Runner" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000)
  });
  const payload = await readJsonResponse(response, 256 * 1024);
  if (!response.ok) throw new Error("GitHub API HTTP " + response.status + " for " + method + " " + path.slice(0,100) + ": " + String(payload.message || "request failed").slice(0,160));
  return payload;
};
const run = (command, args, timeout = 120000) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(command + " failed: " + String(result.error?.message || result.stderr || result.stdout || "unknown").slice(0,240));
  return String(result.stdout || "").trim();
};

const queue = await workerRequest("/agent/v1/patch-proposals/pending", ownerToken);
const proposals = Array.isArray(queue.proposals) ? queue.proposals.slice(0,3) : [];
if (!proposals.length) {
  console.log("No verified patch proposals are waiting for review.");
  process.exit(0);
}

for (const proposal of proposals) {
  const proposalId = String(proposal.proposalId || "");
  const baseSha = String(proposal.baseSha || "").toLowerCase();
  const artifactPath = String(proposal.path || "");
  const artifactSha256 = String(proposal.artifactSha256 || "");
  const targetPath = String(proposal.targetPath || "");
  const targetPolicy = getIntelligencePatchTarget(targetPath);
  const createdAt = typeof proposal.createdAt === "string" ? proposal.createdAt : "";
  const proposalDate = new Date(createdAt);
  if (!UUID_V4.test(proposalId) || !/^[a-f0-9]{40}$/.test(baseSha) ||
      !Number.isFinite(proposalDate.getTime()) || proposalDate.toISOString() !== createdAt ||
      !targetPolicy ||
      artifactPath !== "patch-proposals/" + String(proposal.createdAt || "").slice(0,4) + "/" + String(proposal.createdAt || "").slice(5,7) + "/" + proposalId + ".json" ||
      !/^[a-f0-9]{64}$/.test(artifactSha256)) {
    console.log("Skipping malformed proposal metadata.");
    continue;
  }

  let claimed = false;
  try {
    await workerRequest("/agent/v1/patch-proposals/claim", ownerToken, {
      method: "POST", body: JSON.stringify({ proposalId, runId })
    });
    claimed = true;
  } catch (error) {
    console.log("Proposal claim skipped: " + String(error.message || error).slice(0,180));
    continue;
  }

  try {
    const existing = await gh("/repos/" + repository + "/pulls?state=open&head=Mehranmsh%3Aintelligence%2Fproposal-" + proposalId);
    if (Array.isArray(existing) && existing.length) {
      await workerRequest("/agent/v1/patch-proposals/complete", ownerToken, {
        method: "POST", body: JSON.stringify({ proposalId, runId, status: "pull_request_created" })
      });
      console.log("Existing review PR confirmed for proposal " + proposalId + ": " + existing[0].html_url);
      continue;
    }

    if (baseSha !== currentMainSha) throw new Error("Proposal base is stale relative to this runner main snapshot.");
    const artifact = await workerRequest(
      "/agent/v1/patch-proposals/artifact?path=" + encodeURIComponent(artifactPath) +
        "&artifactSha256=" + encodeURIComponent(artifactSha256) +
        "&runId=" + encodeURIComponent(runId),
      agentToken
    );
    if (artifact.success !== true || artifact.proposalId !== proposalId ||
        artifact.baseSha !== baseSha || artifact.targetPath !== targetPath ||
        artifact.artifactSha256 !== artifactSha256 || artifact.diffSha256 !== proposal.diffSha256 ||
        typeof artifact.diff !== "string" || artifact.diff.length > 8192) {
      throw new Error("Verified artifact metadata does not match the queued proposal.");
    }

    const tempRoot = mkdtempSync(join(tmpdir(), "mehran-verified-patch-"));
    const workspace = join(tempRoot, "repo");
    try {
      run("git", ["worktree", "add", "--detach", workspace, baseSha]);
      const source = readFileSync(join(workspace, targetPath), "utf8");
      const applied = applyValidatedPatchInMemory({
        baseSha, expectedBaseSha: baseSha, source, targetPath,
        summary: String(artifact.summary || ""), diff: artifact.diff
      });
      if (!applied.ok || typeof applied.content !== "string") {
        throw new Error("Patch application rejected by the explicit append-only test policy: " + String(applied.code || "unknown"));
      }
      writeFileSync(join(workspace, targetPath), applied.content, { encoding: "utf8", flag: "w" });

      const image = "node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a";
      const dockerArgs = [
        "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "768m",
        "--cpus", "1", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
        "--mount", "type=bind,src=" + workspace + ",dst=/workspace,readonly",
        "--workdir", "/workspace", image, "sh", "-c",
        "node --check worker.js && " + targetPolicy.testCommand
      ];
      const test = spawnSync("docker", dockerArgs, { encoding: "utf8", timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
      if (test.error || test.status !== 0) {
        throw new Error("Isolated target test suite rejected the proposal: " +
          String(test.error?.message || test.stderr || test.stdout || "unknown").slice(-700));
      }
      const output = String(test.stdout || "");
      const passMatch = output.match(/# pass (\d+)/);
      const failMatch = output.match(/# fail (\d+)/);
      if (!passMatch || Number(failMatch?.[1] || 0) !== 0) {
        throw new Error("Isolated test output did not confirm a zero-failure result.");
      }

      const commitInfo = await gh("/repos/" + repository + "/git/commits/" + baseSha);
      const blob = await gh("/repos/" + repository + "/git/blobs", "POST", {
        content: applied.content, encoding: "utf-8"
      });
      const tree = await gh("/repos/" + repository + "/git/trees", "POST", {
        base_tree: commitInfo.tree.sha,
        tree: [{ path: targetPath, mode: "100644", type: "blob", sha: blob.sha }]
      });
      const commit = await gh("/repos/" + repository + "/git/commits", "POST", {
        message: "INTELLIGENCE: " + String(artifact.summary).slice(0,120),
        tree: tree.sha, parents: [baseSha]
      });
      const reviewBranch = "intelligence/proposal-" + proposalId;
      await gh("/repos/" + repository + "/git/refs", "POST", {
        ref: "refs/heads/" + reviewBranch, sha: commit.sha
      });
      const pr = await gh("/repos/" + repository + "/pulls", "POST", {
        title: "[INTELLIGENCE] " + String(artifact.summary).slice(0,130),
        head: reviewBranch, base: "main", draft: true,
        body: [
          "## Automated, bounded proposal",
          "",
          String(artifact.summary),
          "",
          "- Source base: `" + baseSha + "`",
          "- Proposal: `" + proposalId + "`",
          "- Changed path: `" + targetPath + "`",
          "- Patch policy: one allowlisted test file; append-only additions; no deletions or replacements",
          "- Validation: isolated, network-disabled Node test container",
          "- Test result: " + Number(passMatch[1]) + " passed, 0 failed",
          "",
          "This is a draft for owner review. It is never merged or deployed automatically."
        ].join("\n")
      });
      await workerRequest("/agent/v1/patch-proposals/complete", ownerToken, {
        method: "POST", body: JSON.stringify({ proposalId, runId, status: "pull_request_created" })
      });
      console.log("Created draft review PR #" + pr.number + ": " + pr.html_url);
    } finally {
      try { run("git", ["worktree", "remove", "--force", workspace], 30000); } catch {}
      rmSync(tempRoot, { recursive: true, force: true });
    }
  } catch (error) {
    console.log("Proposal " + proposalId + " failed closed: " + String(error.message || error).slice(0,500));
    if (claimed) {
      try {
        await workerRequest("/agent/v1/patch-proposals/complete", ownerToken, {
          method: "POST", body: JSON.stringify({ proposalId, runId, status: "failed" })
        });
      } catch (completionError) {
        console.log("Proposal failure state could not be finalized; its claim lease expires after 15 minutes.");
      }
    }
  }
}
