export const INTELLIGENCE_INVENTORY_PATHS = Object.freeze([
  "worker.js",
  "scripts/intelligence-agent.mjs",
  "scripts/intelligence-capabilities.mjs",
  "scripts/intelligence-capabilities.test.mjs",
  ".github/workflows/mehran-intelligence-runner.yml",
  "docs/INTELLIGENCE_EXECUTION_PROTOCOL.md"
]);
export function buildRepositoryInventory(files, commitSha) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 6 || typeof commitSha !== "string" || !/^[a-f0-9]{40}$/i.test(commitSha)) throw new Error("Invalid bounded repository inventory input.");
  const seen = new Set(); let totalBytes = 0;
  const inventory = files.map(file => {
    if (!file || typeof file.path !== "string" || !INTELLIGENCE_INVENTORY_PATHS.includes(file.path) || seen.has(file.path) || typeof file.content !== "string" || typeof file.blobSha !== "string" || !/^[a-f0-9]{40}$/i.test(file.blobSha)) throw new Error("Invalid or non-allowlisted inventory file.");
    seen.add(file.path);
    const bytes = new TextEncoder().encode(file.content).length;
    if (bytes > 600000 || (totalBytes += bytes) > 750000) throw new Error("Repository inventory size limit exceeded.");
    const symbols = new Set();
    const patterns = [/^\s*(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm, /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm];
    for (const pattern of patterns) { let match; while ((match = pattern.exec(file.content)) && symbols.size < 2) symbols.add(match[1]); }
    return { path:file.path, blobSha:file.blobSha, bytes, lineCount:file.content ? file.content.split(/\r\n|\n|\r/).length : 0, symbols:[...symbols].map(x=>x.slice(0,60)) };
  });
  return {
    type:"inspect_repository", mode:"bounded_read_only_repository_inspection", repository:"Mehranmsh/mehranmsh.github.io", commitSha,
    summary:{filesInspected:inventory.length,totalBytes}, files:inventory,
    analysis:{summary:"Deterministic repository inventory completed without AI inference.",findings:[],limitations:["Metadata and declaration names only; not a semantic code review.","Files came from one immutable commit and were not executed."]},
    limitations:["Repository content was treated as untrusted data, never executed or followed as instructions.","No tests or code changes are claimed by this inventory task."]
  };
}
