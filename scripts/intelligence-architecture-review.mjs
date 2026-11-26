const REVIEW_PATHS = Object.freeze([
  "worker.js",
  "scripts/intelligence-agent.mjs",
  "scripts/intelligence-capabilities.mjs",
  ".github/workflows/mehran-intelligence-runner.yml",
  "docs/INTELLIGENCE_EXECUTION_PROTOCOL.md",
  "scripts/intelligence-architecture-review.mjs"
]);
const MAX_FILE_BYTES = 600000;
const MAX_TOTAL_BYTES = 750000;

function lineEvidence(files, patterns, limit = 5) {
  const evidence = [];
  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (patterns.some(pattern => pattern.test(line))) {
        evidence.push({ path: file.path, line: index + 1, signal: line.trim().replace(/\s+/g, " ").slice(0, 180) });
        if (evidence.length >= limit) return evidence;
      }
    }
  }
  return evidence;
}
function section(id, title, files, patterns, interpretation) {
  const evidence = lineEvidence(files, patterns);
  return { id, title, status: evidence.length >= 2 ? "present" : evidence.length === 1 ? "partial" : "not_detected", interpretation, evidence };
}
export function buildIntelligenceArchitectureReview(input) {
  const fail = message => { throw new Error(message); };
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("A review input object is required.");
  const commitSha = typeof input.commitSha === "string" ? input.commitSha.toLowerCase() : "";
  if (!/^[a-f0-9]{40}$/.test(commitSha)) fail("A verified 40-character source commit SHA is required.");
  if (!Array.isArray(input.files) || input.files.length !== REVIEW_PATHS.length) fail("The review requires the complete fixed six-file source set.");
  const seen = new Set();
  let totalBytes = 0;
  const files = input.files.map(file => {
    if (!file || typeof file.path !== "string" || !REVIEW_PATHS.includes(file.path) || seen.has(file.path) || typeof file.content !== "string") fail("A source file is outside the exact architecture-review allowlist.");
    seen.add(file.path);
    const bytes = new TextEncoder().encode(file.content).byteLength;
    if (bytes > MAX_FILE_BYTES) fail("An architecture-review source file exceeds the 600 KB limit.");
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) fail("Architecture review exceeded the 750 KB aggregate source limit.");
    return { path: file.path, content: file.content };
  });
  if (REVIEW_PATHS.some(path => !seen.has(path))) fail("The architecture-review source set is incomplete.");
  const layers = [
    section("api_scheduler", "API, authentication, and scheduler", files, [/agent/, /async function ingestPrivateIntelligenceInbox/, /scheduler/i, /Authorization/], "Maps authenticated Worker boundaries, private inbox ingestion, and scheduled execution entry points."),
    section("orchestration", "Mission and task orchestration", files, [/createIntelligenceWorkPackage/, /intelligence_work_packages/, /intelligence_tasks/, /dependsOn|dependencies/], "Maps work-package creation, task state, dependency ordering, and report finalization."),
    section("capabilities", "Capability and permission model", files, [/INTELLIGENCE_CAPABILITIES/, /PREAPPROVED_INTELLIGENCE_ACTION_TYPES/, /permissionTier/, /validateIntelligenceCapabilityRequest/], "Maps the explicit capability registry, permission tiers, input schemas, and action validation."),
    section("memory", "Memory and context layer", files, [/selectMemoryContext/, /intelligence_memory/i, /memory_context/i, /persistIntelligence.*Memory/i], "Detects memory selection and persistence primitives; source evidence does not prove production data quality or retention behavior."),
    section("ai_quota", "AI provider routing and quota governance", files, [/runIntelligenceAI/, /reserveSocialWorkersAIBudget/, /WORKERS_AI_INTELLIGENCE_DAILY_RESERVATION_CREDITS/, /daily_quota_circuit_open/], "Maps provider routing, reservation guards, product-level budgets, and fail-closed quota behavior."),
    section("execution", "Execution adapters and isolated testing", files, [/runFixedRepositoryTests/, /architecture_review/, /source_security_audit/, /docker.*network.*none/i], "Maps bounded runner actions, deterministic review execution, and isolated test execution."),
    section("security", "Security and governance controls", files, [/validatePrivateIntelligenceMission/, /INTELLIGENCE_INSPECT_ALLOWED_PATHS/, /MAX_BODY_BYTES/, /requiresApproval/, /secret_access|arbitrary_shell/], "Maps source allowlists, approval boundaries, bounded inputs, and forbidden-action policy."),
    section("evaluation", "Evaluation, quality, and observability", files, [/verifyIntelligenceReport/, /repository_quality_check/, /test/, /workflowRunId/, /outputSha256/], "Maps regression checks, report verification, execution provenance, and test evidence.")
  ];
  const worker = files.find(file => file.path === "worker.js").content;
  const gaps = [];
  if (layers.find(item => item.id === "memory").status !== "present") gaps.push({ id: "memory_evidence_incomplete", severity: "high", detail: "The fixed source set does not expose enough explicit memory selection and persistence signals to verify a complete durable-memory lifecycle." });
  if (!/WORKERS_AI_INTELLIGENCE_DAILY_RESERVATION_CREDITS/.test(worker)) gaps.push({ id: "intelligence_quota_boundary_not_verified", severity: "high", detail: "A dedicated Intelligence reservation boundary was not detected in the inspected Worker source." });
  if (!/owner_uid|ownerUid/.test(worker)) gaps.push({ id: "owner_scope_not_verified", severity: "medium", detail: "Owner-scoped persistence or authorization signals were not detected in the inspected source set." });
  gaps.push({ id: "runtime_validation_required", severity: "medium", detail: "Static source evidence cannot establish live D1 contents, deployed Worker parity, real provider quota availability, or end-to-end behavior. Verify those separately before production reliance." });
  const roadmap = [
    { phase: 1, name: "Trusted foundation", actions: ["Keep identity, owner authorization, and capability policy centralized.", "Bind every task and report to an immutable source revision.", "Preserve fail-closed behavior for unknown actions and missing evidence."] },
    { phase: 2, name: "Cognitive memory", actions: ["Define episodic, semantic, and procedural memory records.", "Add provenance, confidence, retention, correction, and deletion policies.", "Separate owner memory from customer and public workspace context."] },
    { phase: 3, name: "Orchestration", actions: ["Use a deterministic planner to select bounded specialist capabilities.", "Track dependencies, retries, checkpoints, and cancellation as durable state.", "Require explicit approval for external writes, publication, merge, and deployment."] },
    { phase: 4, name: "Evaluation and resource isolation", actions: ["Add task-level quality gates and evidence-based completion criteria.", "Keep owner-reserved inference capacity isolated from customer budgets and queues.", "Expose quota, cost, latency, and failure telemetry without leaking prompts or secrets."] }
  ];
  return {
    type: "intelligence_architecture_review",
    generatedAt: new Date().toISOString(),
    mode: "deterministic_static_evidence_no_ai_inference",
    repository: typeof input.repository === "string" ? input.repository.slice(0, 120) : "unknown",
    commitSha,
    source: { filesInspected: files.length, totalBytes, allowlist: REVIEW_PATHS },
    summary: { layersDetected: layers.filter(item => item.status === "present").length, layersPartial: layers.filter(item => item.status === "partial").length, layersNotDetected: layers.filter(item => item.status === "not_detected").length, gaps: gaps.length },
    architecture: layers,
    gaps,
    targetBlueprint: ["Identity and trust boundary", "Deterministic orchestrator and durable task state", "Owner-isolated memory and context retrieval", "Policy-governed specialist capability registry", "Quota-aware provider gateway with reserved owner capacity", "Sandboxed execution adapters and approval-gated external actions", "Evidence-linked evaluation, audit, and observability"],
    roadmap,
    limitations: ["This is deterministic source analysis, not an LLM-generated semantic review.", "Evidence is limited to the six fixed files and exact commit SHA listed above.", "No repository code was executed, no external AI provider was called, and no source or production state was modified."]
  };
}


export function compactIntelligenceArchitectureReview(report, maxChars = 2900) {
  if (!report || report.type !== "intelligence_architecture_review" ||
      !Number.isInteger(maxChars) || maxChars < 512) {
    throw new Error("A valid architecture review and bounded output size are required.");
  }
  const compact = {
    type: report.type,
    generatedAt: report.generatedAt,
    mode: report.mode,
    repository: report.repository,
    commitSha: report.commitSha,
    source: {
      filesInspected: Number(report.source?.filesInspected || 0),
      totalBytes: Number(report.source?.totalBytes || 0)
    },
    summary: report.summary,
    architecture: (Array.isArray(report.architecture) ? report.architecture : []).map(item => ({
      id: String(item?.id || "").slice(0, 40),
      title: String(item?.title || "").slice(0, 80),
      status: item?.status,
      evidence: (Array.isArray(item?.evidence) ? item.evidence : []).slice(0, 1).map(ev => ({
        path: String(ev?.path || "").slice(0, 100),
        line: Number(ev?.line || 0)
      }))
    })),
    gaps: (Array.isArray(report.gaps) ? report.gaps : []).slice(0, 4).map(item => ({
      id: String(item?.id || "").slice(0, 60),
      severity: item?.severity,
      detail: String(item?.detail || "").slice(0, 100)
    })),
    targetBlueprint: (Array.isArray(report.targetBlueprint) ? report.targetBlueprint : []).slice(0, 7).map(item => String(item).slice(0, 64)),
    roadmap: (Array.isArray(report.roadmap) ? report.roadmap : []).slice(0, 4).map(item => ({
      phase: Number(item?.phase || 0),
      name: String(item?.name || "").slice(0, 40),
      actions: (Array.isArray(item?.actions) ? item.actions : []).slice(0, 1).map(action => String(action).slice(0, 90))
    })),
    limitations: (Array.isArray(report.limitations) ? report.limitations : []).slice(0, 2).map(item => String(item).slice(0, 100))
  };
  let serialized = JSON.stringify(compact);
  if (serialized.length > maxChars) {
    compact.architecture = compact.architecture.map(item => ({ ...item, title: item.title.slice(0, 48), evidence: item.evidence.slice(0, 1) }));
    compact.gaps = compact.gaps.slice(0, 3).map(item => ({ ...item, detail: item.detail.slice(0, 64) }));
    compact.targetBlueprint = compact.targetBlueprint.slice(0, 5).map(item => item.slice(0, 48));
    compact.roadmap = compact.roadmap.slice(0, 3).map(item => ({ ...item, name: item.name.slice(0, 28), actions: item.actions.slice(0, 1).map(action => action.slice(0, 60)) }));
    compact.limitations = compact.limitations.slice(0, 1).map(item => item.slice(0, 80));
    serialized = JSON.stringify(compact);
  }
  if (serialized.length > maxChars) throw new Error("Architecture review exceeds the bounded task-result size.");
  return serialized;
}
