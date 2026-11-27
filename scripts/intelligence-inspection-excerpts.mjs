const INSPECTION_ANCHORS = Object.freeze({
  "worker.js": [
    "const ownerOrchestrationRoute =",
    'if (path === "/agent/v1/repository/analyze"',
    "const system = [",
    "const validFindings =",
    "function validateIntelligenceWorkPackage",
    "verifyIntelligenceReport",
    "pending-finalization",
    'if (path === "/agent/v1/tasks/next"'
  ],
  ".github/workflows/mehran-intelligence-runner.yml": [
    "verifyIntelligenceResultCheckpoint",
    'const claimed = await request("/agent/v1/tasks/next")',
    "async function execute(task)",
    'if (task.actionType === "run_repository_tests")',
    'if (task.actionType === "inspect_repository")',
    "const resultReadyCheckpoint",
    "pending-finalization",
    "resultSha256"
  ],
  "scripts/intelligence-agent.mjs": [
    "async function main()",
    "const allowedActions",
    "async function request("
  ],
  "scripts/intelligence-capabilities.mjs": [
    "inspect_repository: freezeCapability",
    "run_repository_tests: freezeCapability",
    "propose_code_patch: freezeCapability",
    "create_pull_request: freezeCapability",
    "merge_pull_request: freezeCapability",
    "deploy: freezeCapability"
  ],
  "scripts/intelligence-capabilities.test.mjs": [
    'test("repository inspection combines deterministic inventory',
    'test("runner resumes a durable completed result checkpoint',
    'test("Intelligence task recovery is claim-token scoped',
    'test("Private package reports are verified',
    'test("Terminal work packages with unstored reports',
    'test("semantic repository analysis is owner-authenticated',
    'test("merge, deployment, secrets, wallet and arbitrary shell'
  ],
  "docs/INTELLIGENCE_EXECUTION_PROTOCOL.md": [
    "## Planning and dependency rules",
    "## Error and recovery protocol",
    "## Approval boundaries",
    "## Evidence and verification",
    "## Acceptance criteria for the protocol",
    "## Implementation status and remaining gaps"
});

const DEFAULT_MAX_CHARS = 2800;
const MAX_WINDOWS = 7;
const WINDOW_CHARS = 360;

function boundedInteger(value, fallback, maximum) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function extractWindow(source, index, budget) {
  const half = Math.floor(budget / 2);
  let start = Math.max(0, index - half);
  let end = Math.min(source.length, start + budget);
  start = Math.max(0, end - budget);
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const nextLine = source.indexOf("\n", end);
  const lineEnd = nextLine < 0 ? source.length : nextLine;
  if (lineEnd - lineStart <= budget) {
    start = lineStart;
    end = lineEnd;
  }
  if (end - start > budget) end = start + budget;
  return { start, end, text: source.slice(start, end) };
}

/**
 * Select deterministic, path-aware source windows for bounded semantic review.
 * Excerpts are evidence only: callers must continue to treat source as untrusted.
 */
export function buildIntelligenceInspectionExcerpt(path, source, maxChars = DEFAULT_MAX_CHARS) {
  if (typeof path !== "string" || typeof source !== "string" || !source.trim()) return "";
  const limit = boundedInteger(maxChars, DEFAULT_MAX_CHARS, DEFAULT_MAX_CHARS);
  const anchors = INSPECTION_ANCHORS[path] || [];
  const windows = [];
  const seenStarts = new Set();

  for (const anchor of anchors) {
    if (windows.length >= MAX_WINDOWS) break;
    const index = source.indexOf(anchor);
    if (index < 0) continue;
    const window = extractWindow(source, index, WINDOW_CHARS);
    if (seenStarts.has(window.start) || windows.some(item => window.start < item.end && item.start < window.end)) continue;
    seenStarts.add(window.start);
    windows.push(window);
  }

  if (!windows.length) return source.slice(0, limit);

  let excerpt = "";
  for (const window of windows) {
    const marker = `\n[${path} bytes ${window.start}-${window.end}]\n`;
    const separator = excerpt ? "\n" : "";
    const remaining = limit - excerpt.length - separator.length - marker.length;
    if (remaining <= 0) break;
    const text = window.text.slice(0, Math.min(window.text.length, remaining));
    if (!text.trim()) continue;
    excerpt += separator + marker + text;
  }
  return excerpt.slice(0, limit);
}

export const INTELLIGENCE_INSPECTION_EXCERPT_POLICY = Object.freeze({
  maxCharsPerFile: DEFAULT_MAX_CHARS,
  maxWindowsPerFile: MAX_WINDOWS,
  maxCharsPerWindow: WINDOW_CHARS,
  selection: "deterministic_path_aware_source_windows",
  sourceExecution: false
});
