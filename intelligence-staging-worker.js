import { buildKnowledgeReviewItem } from "./intelligence-review-queue.mjs";
import { evaluateCapabilityRequest, listCapabilityPolicy } from "./intelligence-capability-policy.mjs";
import { parseApprovalLifetime } from "./intelligence-approval-input.mjs";
import { scoreFindingPriority, compareFindingPriority } from "./intelligence-finding-priority.mjs";
import { buildRemediationPlan } from "./intelligence-remediation-planner.mjs";
import { analyzeDependencyImpact, COMPANY_MODULES } from "./intelligence-dependency-impact.mjs";
import { buildGapTestStrategy } from "./intelligence-gap-test-strategy.mjs";
import { buildEvidenceMetadataReview } from "./intelligence-evidence-review.mjs";
import { OWNER_EVIDENCE_REVIEW_OUTCOMES, buildEvidenceSnapshot, buildOwnerEvidenceReviewHistory } from "./intelligence-owner-evidence-review.mjs";
import { buildEvidenceDrift } from "./intelligence-evidence-drift.mjs";
import { buildEvidenceCorrelation } from "./intelligence-evidence-correlation.mjs";
import { buildEvidenceConsistency } from "./intelligence-evidence-consistency.mjs";
import { EVIDENCE_CORRELATION_REVIEW_OUTCOMES, EVIDENCE_CORRELATION_TYPES, buildEvidenceCorrelationReviewSnapshot, buildEvidenceCorrelationReviewHistory } from "./intelligence-evidence-correlation-review.mjs";
const PI_ME_URL = "https://api.minepi.com/v2/me";
const ALLOWED_ORIGIN = "https://mehranmsh.github.io";
const MAX_BODY_BYTES = 20_000;
const SESSION_SECONDS = 12 * 60 * 60;
const RATE_WINDOW_SECONDS = 60;
const RATE_MAX = 30;

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY"
    }
  });
}

function fail(message, status = 400) {
  return response({ success: false, error: message }, status);
}

function randomId() {
  return crypto.randomUUID();
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url(new Uint8Array(bytes));
}

async function readJson(request) {
  const type = request.headers.get("Content-Type") || "";
  if (type.split(";")[0].trim().toLowerCase() !== "application/json") return null;
  const length = Number(request.headers.get("Content-Length") || 0);
  if (!Number.isFinite(length) || length > MAX_BODY_BYTES || !request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function bearer(request) {
  const match = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function clean(value, max = 2000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validateApprovalScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope) ||
      Object.keys(scope).length !== 1 || !Array.isArray(scope.paths) ||
      scope.paths.length < 1 || scope.paths.length > 20) return null;
  const paths = [];
  for (const raw of scope.paths) {
    if (typeof raw !== "string" || raw.length < 1 || raw.length > 200 ||
        raw.startsWith("/") || raw.includes("\\") || raw.includes("%") ||
        raw.includes("//") || /[\u0000-\u0020\u007f*?\[\]{}!:#]/.test(raw)) return null;
    const normalized = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    const segments = normalized.split("/");
    if (!normalized || segments.some(segment => !segment || segment === "." || segment === ".." || segment.toLowerCase() === ".git")) return null;
    paths.push(raw);
  }
  if (new Set(paths).size !== paths.length) return null;
  paths.sort();
  return { paths };
}

export async function fetchPiUser(accessToken, fetchImpl = fetch) {
  if (typeof accessToken !== "string" || accessToken.length < 10 || accessToken.length > 4096) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const result = await fetchImpl(PI_ME_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      redirect: "error",
      signal: controller.signal
    });
    if (!result.ok || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(result.headers.get("Content-Type") || "")) return null;
    const declaredLength = Number(result.headers.get("Content-Length") || 0);
    if (declaredLength > 8192) return null;
    if (!result.body) return null;
    const reader = result.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 8192) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const user = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof user?.uid !== "string" || !user.uid.trim() || user.uid.length > 200 ||
        typeof user?.username !== "string" || !user.username.trim() || user.username.length > 100) return null;
    return { uid: user.uid, username: user.username };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function audit(db, ownerUid, action, targetType = "", targetId = "", details = {}) {
  return db.prepare(`
    INSERT INTO intelligence_staging_audit
      (id, owner_uid, action, target_type, target_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(randomId(), ownerUid, action, targetType, targetId, JSON.stringify(details), Math.floor(Date.now() / 1000));
}

async function rateLimit(db, ownerUid, route) {
  const now = Math.floor(Date.now() / 1000);
  const key = await digest(`${ownerUid}:${route}`);
  const result = await db.prepare(`
    INSERT INTO intelligence_staging_rate_limits(rate_key, window_started_at, request_count, blocked_until)
    VALUES (?, ?, 1, NULL)
    ON CONFLICT(rate_key) DO UPDATE SET
      request_count = CASE
        WHEN intelligence_staging_rate_limits.window_started_at <= ? THEN 1
        ELSE intelligence_staging_rate_limits.request_count + 1
      END,
      window_started_at = CASE
        WHEN intelligence_staging_rate_limits.window_started_at <= ? THEN ?
        ELSE intelligence_staging_rate_limits.window_started_at
      END
    RETURNING request_count, window_started_at
  `).bind(key, now, now - RATE_WINDOW_SECONDS, now - RATE_WINDOW_SECONDS, now).first();
  return !!result && Number(result.request_count) <= RATE_MAX;
}

async function verifySession(request, env) {
  const token = bearer(request);
  if (token.length < 40 || token.length > 200) return null;
  const tokenHash = await digest(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(`
    SELECT owner_uid, created_at, expires_at
    FROM intelligence_staging_sessions
    WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
    LIMIT 1
  `).bind(tokenHash, now).first();
  const expected = clean(env.MEHRAN_INTELLIGENCE_STAGING_OWNER_UID, 200);
  const createdAt = Number(row?.created_at);
  const expiresAt = Number(row?.expires_at);
  if (!expected || !row || row.owner_uid !== expected ||
      !Number.isSafeInteger(createdAt) || !Number.isSafeInteger(expiresAt) ||
      createdAt > now || createdAt < now - SESSION_SECONDS ||
      expiresAt <= createdAt || expiresAt > createdAt + SESSION_SECONDS) return null;
  return { uid: row.owner_uid };
}

function uuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}



async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (request.headers.get("Origin") && request.headers.get("Origin") !== ALLOWED_ORIGIN) return fail("Origin not allowed.", 403);
  if (method === "OPTIONS") return response({ success: true });
  if (!env.DB) return fail("Staging database binding is unavailable.", 503);

  if (path === "/health" && method === "GET") {
    try {
      const required = [
        "intelligence_tasks", "intelligence_knowledge", "intelligence_approval_ledger",
        "intelligence_knowledge_relations", "intelligence_staging_sessions",
        "intelligence_staging_audit", "intelligence_staging_rate_limits",
        "intelligence_owner_memory", "intelligence_capability_approvals",
        "intelligence_findings", "intelligence_finding_evidence", "intelligence_finding_reviews", "intelligence_evidence_correlation_reviews"
      ];
      const rows = await env.DB.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${required.map(() => "?").join(",")})`
      ).bind(...required).all();
      const found = new Set((rows.results || []).map(row => row.name));
      const missing = required.filter(name => !found.has(name));
      const foreignKeyState = await env.DB.prepare("PRAGMA foreign_keys").first();
      const foreignKeyViolations = await env.DB.prepare("PRAGMA foreign_key_check").all();
      const foreignKeysEnabled = Number(foreignKeyState?.foreign_keys) === 1;
      const violationCount = (foreignKeyViolations.results || []).length;
      const schemaReady = missing.length === 0 && foreignKeysEnabled && violationCount === 0;
      return response({
        success: true, service: "mehran-intelligence-staging",
        schemaReady, missingTables: missing, foreignKeysEnabled,
        foreignKeyViolations: violationCount, executor: false
      }, schemaReady ? 200 : 503);
    } catch {
      return fail("Staging schema is unavailable.", 503);
    }
  }

  if (path === "/session" && method === "POST") {
    const body = await readJson(request);
    if (!body || Object.keys(body).some(key => key !== "accessToken") || typeof body.accessToken !== "string" || body.accessToken.length < 10 || body.accessToken.length > 4096) return fail("A valid Pi access token is required.");
    const ownerUid = clean(env.MEHRAN_INTELLIGENCE_STAGING_OWNER_UID, 200);
    if (!ownerUid) return fail("Staging owner identity is not configured.", 503);
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!await rateLimit(env.DB, `ip:${clientIp}`, "session-auth")) return fail("Authentication rate limit exceeded.", 429);
    const piFetch = env.PI_IDENTITY?.fetch ? env.PI_IDENTITY.fetch.bind(env.PI_IDENTITY) : fetch;
    const piUser = await fetchPiUser(body.accessToken, piFetch);
    if (!piUser || piUser.uid !== ownerUid || piUser.username.toLowerCase() !== "mehranmsh") return fail("Pi owner verification failed.", 403);
    if (!await rateLimit(env.DB, ownerUid, "session-create")) return fail("Rate limit exceeded.", 429);
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = base64url(tokenBytes);
    const now = Math.floor(Date.now() / 1000);
    const sessionId = randomId();
    const tokenHash = await digest(token);
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO intelligence_staging_sessions(id,token_hash,owner_uid,created_at,expires_at) VALUES(?,?,?,?,?)")
          .bind(sessionId, tokenHash, ownerUid, now, now + SESSION_SECONDS),
        audit(env.DB, ownerUid, "session_created", "session", sessionId)
      ]);
    } catch {
      return fail("Could not create a secure staging session.", 503);
    }
    return response({ success: true, token, expiresAt: now + SESSION_SECONDS }, 201);
  }

  if (path === "/session" && method === "GET") {
    const owner = await verifySession(request, env);
    if (!owner) return fail("Authentication required.", 401);
    if (!await rateLimit(env.DB, owner.uid, "session-read")) return fail("Rate limit exceeded.", 429);
    return response({ success: true, ownerUid: owner.uid });
  }

  if (path === "/session" && method === "DELETE") {
    const owner = await verifySession(request, env);
    if (!owner) return fail("Authentication required.", 401);
    if (!await rateLimit(env.DB, owner.uid, "session-revoke")) return fail("Rate limit exceeded.", 429);
    const tokenHash = await digest(bearer(request));
    const row = await env.DB.prepare("SELECT id FROM intelligence_staging_sessions WHERE token_hash=? AND owner_uid=? AND revoked_at IS NULL").bind(tokenHash, owner.uid).first();
    if (!row) return fail("Session not found.", 404);
    const revokedAt = Math.floor(Date.now() / 1000);
    try {
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE intelligence_staging_sessions SET revoked_at=? WHERE id=? AND owner_uid=? AND revoked_at IS NULL")
          .bind(revokedAt, row.id, owner.uid),
        env.DB.prepare(`
          INSERT INTO intelligence_staging_audit(id,owner_uid,action,target_type,target_id,details_json,created_at)
          SELECT ?,?,?,?,?,?,? WHERE changes() = 1
        `).bind(randomId(), owner.uid, "session_revoked", "session", row.id, "{}", revokedAt)
      ]);
      if (!Number(results?.[0]?.meta?.changes || 0)) return fail("Session was already revoked.", 409);
    } catch {
      return fail("Session revocation failed.", 503);
    }
    return response({ success: true, revoked: true });
  }

  const owner = await verifySession(request, env);
  if (!owner) return fail("Authentication required.", 401);
  if (!await rateLimit(env.DB, owner.uid, `${method}:${path.split("/").slice(1,3).join("/")}`)) return fail("Rate limit exceeded.", 429);

  if (path === "/intelligence/overview" && method === "GET") {
    const now = Math.floor(Date.now() / 1000);
    try {
      const row = await env.DB.prepare(`
        SELECT
          (SELECT COUNT(*) FROM intelligence_knowledge WHERE owner_uid=? AND archived_at IS NULL) AS active_knowledge_count,
          (SELECT COUNT(*) FROM intelligence_knowledge WHERE owner_uid=? AND archived_at IS NOT NULL) AS archived_knowledge_count,
          (SELECT COUNT(*) FROM intelligence_knowledge WHERE owner_uid=? AND verification_status IN ('unreviewed','disputed') AND archived_at IS NULL) AS knowledge_needs_review_count,
          (SELECT COUNT(*) FROM intelligence_knowledge WHERE owner_uid=? AND verification_status='disputed' AND archived_at IS NULL) AS disputed_knowledge_count,
          (SELECT COUNT(*) FROM intelligence_knowledge_relations WHERE owner_uid=? AND relation_type='conflicts_with' AND status IN ('candidate','confirmed')) AS unresolved_conflict_count,
          (SELECT COUNT(*) FROM intelligence_knowledge_relations WHERE owner_uid=? AND status='candidate') AS candidate_relation_count,
          (SELECT COUNT(*) FROM intelligence_owner_memory WHERE owner_uid=? AND archived_at IS NULL) AS active_memory_count,
          (SELECT COUNT(*) FROM intelligence_owner_memory WHERE owner_uid=? AND review_status IN ('unreviewed','disputed') AND archived_at IS NULL) AS memory_needs_review_count,
          (SELECT COUNT(*) FROM intelligence_tasks WHERE created_by=? AND status IN ('queued','accepted')) AS queued_task_count,
          (SELECT COUNT(*) FROM intelligence_tasks WHERE created_by=? AND status='in_progress') AS in_progress_task_count,
          (SELECT COUNT(*) FROM intelligence_capability_approvals WHERE owner_uid=? AND status='issued' AND expires_at>?) AS active_approval_count,
          (SELECT COUNT(*) FROM intelligence_capability_approvals WHERE owner_uid=? AND (status='expired' OR (status='issued' AND expires_at<=?))) AS expired_approval_count
      `).bind(owner.uid, owner.uid, owner.uid, owner.uid, owner.uid, owner.uid,
        owner.uid, owner.uid, owner.uid, owner.uid, owner.uid, now, owner.uid, now).first();
      if (!row) return fail("Intelligence overview is unavailable.", 503);
      const counts = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value) || 0]));
      return response({
        success: true,
        generatedAt: new Date().toISOString(),
        scope: "authenticated_owner_staging_only",
        assessment: "operational_counts_only",
        executionEnabled: false,
        counts,
        limitations: [
          "Counts describe only this owner's isolated staging records.",
          "These metrics do not certify company security, correctness, or production health.",
          "No task, approval, knowledge, or memory state is changed by this overview."
        ]
      });
    } catch {
      return fail("Intelligence overview could not be safely loaded.", 503);
    }
  }

  if (path === "/intelligence/company/assessment-template" && method === "GET") {
    const moduleId = url.searchParams.get("moduleId") || "";
    const templates = {
      music: ["ownership_and_access", "service_health", "content_integrity", "user_experience"],
      ai: ["model_and_provider_configuration", "data_privacy", "access_control", "service_health"],
      social: ["authentication", "authorization", "privacy", "upload_security", "abuse_controls"],
      instruments: ["catalog_integrity", "supplier_workflows", "payments_and_orders", "logistics"],
      robotics: ["device_identity", "safety_boundaries", "update_integrity", "operator_access"],
      security: ["authentication", "authorization", "auditability", "secret_handling", "recovery"],
      intelligence: ["owner_isolation", "knowledge_quality", "approval_boundaries", "assessment_integrity", "observability"],
      logistics: ["workflow_integrity", "tracking", "supplier_access", "exception_handling"],
      "customer-experience": ["privacy", "response_quality", "case_access", "service_continuity"],
      labs: ["experiment_isolation", "data_handling", "reproducibility", "release_gates"],
      governance: ["policy_versioning", "approval_integrity", "audit_trails", "separation_of_duties"],
      data: ["data_classification", "retention", "backup_recovery", "owner_isolation"],
      "robot-operations": ["device_authentication", "command_authorization", "safety_interlocks", "event_audit"]
    };
    const descriptions = {
      ownership_and_access: ["Ownership and access", "Confirm the responsible owner, authentication boundary, and least-privilege roles.", "Documented ownership, role matrix, and negative authorization tests."],
      service_health: ["Service health", "Check availability, dependency failures, and error handling.", "Recent health results, uptime evidence, and representative failure tests."],
      content_integrity: ["Content integrity", "Check validation, integrity controls, and safe rendering of untrusted content.", "Input validation tests, integrity checks, and rendering safety tests."],
      user_experience: ["User experience", "Review critical user journeys and accessible failure states.", "Reproducible journey checks and documented usability findings."],
      model_and_provider_configuration: ["Model and provider configuration", "Verify provider configuration, model boundaries, and failure behavior.", "Redacted configuration inventory and provider failure tests."],
      data_privacy: ["Data privacy", "Check data minimization, retention, and exposure boundaries.", "Data-flow map, retention policy, and privacy tests."],
      access_control: ["Access control", "Verify authorization for each protected operation.", "Role matrix and positive/negative access-control tests."],
      authentication: ["Authentication", "Verify identity proof, session lifecycle, and rejection of invalid credentials.", "Authentication flow tests, session expiry and revocation evidence."],
      authorization: ["Authorization", "Verify each identity can access only permitted resources and actions.", "Cross-owner isolation tests and role/permission matrix."],
      privacy: ["Privacy", "Check private data visibility, consent, and disclosure boundaries.", "Privacy settings, access tests, and data-flow documentation."],
      upload_security: ["Upload security", "Check file type, size, storage isolation, malware handling, and retrieval authorization.", "Upload validation tests, storage policy, and unauthorized retrieval tests."],
      abuse_controls: ["Abuse controls", "Review rate limits, reporting, moderation, and spam resistance.", "Rate-limit tests, abuse workflows, and moderation policy."],
      catalog_integrity: ["Catalog integrity", "Check product identity, pricing consistency, and change history.", "Catalog validation rules and sample reconciliation."],
      supplier_workflows: ["Supplier workflows", "Check supplier identity, access, and approval boundaries.", "Supplier onboarding controls and access tests."],
      payments_and_orders: ["Payments and orders", "Review order state transitions, payment reconciliation, and duplicate handling.", "Test transactions, idempotency evidence, and reconciliation records."],
      logistics: ["Logistics", "Review shipment state, handoffs, and exception handling.", "Tracking lifecycle tests and exception records."],
      device_identity: ["Device identity", "Verify unique device identity and enrollment controls.", "Device enrollment tests and credential lifecycle evidence."],
      safety_boundaries: ["Safety boundaries", "Verify physical safety interlocks and fail-safe behavior.", "Hazard analysis, interlock tests, and operator procedures."],
      update_integrity: ["Update integrity", "Check signed updates, rollback behavior, and version provenance.", "Update signature verification and rollback tests."],
      operator_access: ["Operator access", "Verify authorized operator roles and command boundaries.", "Operator role matrix and denied-command tests."],
      auditability: ["Auditability", "Check completeness, integrity, and access to security audit records.", "Representative audit trails and tamper-resistance tests."],
      secret_handling: ["Secret handling", "Check secret storage, redaction, rotation, and exposure prevention.", "Secret-management policy and redaction/rotation tests; never include secret values."],
      recovery: ["Recovery", "Check backup restoration and incident recovery procedures.", "Restore-test results and recovery runbooks."],
      owner_isolation: ["Owner isolation", "Verify tenant/owner scoping across reads, writes, and search.", "Cross-owner negative tests and database query review."],
      knowledge_quality: ["Knowledge quality", "Review provenance, confidence, freshness, and conflict handling.", "Source references, review records, and conflict-resolution tests."],
      approval_boundaries: ["Approval boundaries", "Verify sensitive actions require valid, scoped, unexpired owner approval.", "Approval lifecycle tests and denied-action evidence."],
      assessment_integrity: ["Assessment integrity", "Ensure findings are evidence-backed and unknowns are not reported as passes.", "Evidence-linked findings, reproducible checks, and explicit unknown states."],
      observability: ["Observability", "Check useful operational events without leaking secrets or personal data.", "Redacted logs, alert tests, and event coverage."],
      workflow_integrity: ["Workflow integrity", "Check state transitions, duplicate handling, and recovery from partial failure.", "State-machine tests and retry/idempotency evidence."],
      tracking: ["Tracking", "Verify status accuracy, event ordering, and traceability.", "Trace samples and event-order tests."],
      supplier_access: ["Supplier access", "Check external party permissions and separation between suppliers.", "Supplier access matrix and cross-supplier isolation tests."],
      exception_handling: ["Exception handling", "Review failed handoffs, retries, and escalation paths.", "Failure-injection tests and escalation records."],
      response_quality: ["Response quality", "Review response accuracy, consistency, and escalation of uncertain cases.", "Sampled quality review and escalation tests."],
      case_access: ["Case access", "Verify only authorized users can access customer cases.", "Case-level authorization tests and audit evidence."],
      service_continuity: ["Service continuity", "Review degraded-mode behavior and recovery objectives.", "Continuity plan and recovery exercise results."],
      experiment_isolation: ["Experiment isolation", "Ensure experiments cannot affect production resources.", "Environment boundaries and isolation tests."],
      data_handling: ["Data handling", "Review collection, access, retention, and disposal of experiment data.", "Data inventory and lifecycle tests."],
      reproducibility: ["Reproducibility", "Check whether experiments can be repeated and independently verified.", "Versioned inputs, procedure, and repeat-run results."],
      release_gates: ["Release gates", "Verify required review and test gates before release.", "Release checklist and blocked-release tests."],
      policy_versioning: ["Policy versioning", "Check policy ownership, change history, and effective versions.", "Version history and approval records."],
      approval_integrity: ["Approval integrity", "Verify approvals bind to exact actions and cannot be reused or altered.", "Scope-binding, expiry, revocation, and replay tests."],
      audit_trails: ["Audit trails", "Check traceability of sensitive decisions and state transitions.", "Correlated audit events and integrity tests."],
      separation_of_duties: ["Separation of duties", "Ensure request, approval, and execution responsibilities are appropriately separated.", "Role design and negative separation-of-duties tests."],
      data_classification: ["Data classification", "Check classification labels and handling rules.", "Data classification inventory and policy tests."],
      retention: ["Retention", "Verify retention periods and deletion/archival behavior.", "Retention policy and lifecycle tests."],
      backup_recovery: ["Backup and recovery", "Check backup integrity and restoration capability.", "Backup verification and restore-test evidence."],
      device_authentication: ["Device authentication", "Verify devices authenticate before exchanging data or receiving commands.", "Device authentication and replay-resistance tests."],
      command_authorization: ["Command authorization", "Ensure device commands are authenticated, scoped, and authorized.", "Command permission matrix and denied-command tests."],
      safety_interlocks: ["Safety interlocks", "Verify independent safety controls block unsafe operations.", "Interlock test records and fail-safe validation."],
      event_audit: ["Event audit", "Check device and operator events are traceable and tamper-evident.", "Event samples, integrity controls, and access tests."]
    };
    if (!Object.prototype.hasOwnProperty.call(templates, moduleId)) {
      return response({ success: false, error: "Unknown company module." }, 404);
    }
    const checks = templates[moduleId].map(id => {
      const item = descriptions[id];
      return { id, title: item[0], objective: item[1], evidenceRequired: item[2], status: "not_run" };
    });
    return response({
      success: true, moduleId, source: "versioned_assessment_blueprint",
      assessmentStatus: "not_started", checks,
      rules: ["A check cannot pass without recorded evidence.", "Missing evidence remains unknown, never passed.", "Findings are recommendations only; no changes are executed."],
      executionEnabled: false
    });
  }

  if (path === "/intelligence/company/modules" && method === "GET") {
    const modules = [
      { id: "music", name: "Mehran Music", area: "product", lifecycle: "registered", purpose: "Music creation, artist presence, audio projects, and music services.", checks: ["ownership_and_access", "service_health", "content_integrity", "user_experience"] },
      { id: "ai", name: "Mehran AI", area: "product", lifecycle: "registered", purpose: "AI-powered experiences and assistant services.", checks: ["model_and_provider_configuration", "data_privacy", "access_control", "service_health"] },
      { id: "social", name: "SOCIAL", area: "product", lifecycle: "in_development", purpose: "Profiles, posts, media, messaging, groups, and discovery.", checks: ["authentication", "authorization", "privacy", "upload_security", "abuse_controls"] },
      { id: "instruments", name: "Mehran Instruments", area: "product", lifecycle: "planned", purpose: "Music instrument and professional studio equipment trade.", checks: ["catalog_integrity", "supplier_workflows", "payments_and_orders", "logistics"] },
      { id: "robotics", name: "Mehran Robotics", area: "product", lifecycle: "planned", purpose: "Future robotics products, services, and integrations.", checks: ["device_identity", "safety_boundaries", "update_integrity", "operator_access"] },
      { id: "security", name: "SECURITY", area: "shared_capability", lifecycle: "registered", purpose: "Identity, access control, threat monitoring, and security governance.", checks: ["authentication", "authorization", "auditability", "secret_handling", "recovery"] },
      { id: "intelligence", name: "INTELLIGENCE", area: "shared_capability", lifecycle: "in_development", purpose: "Organizational knowledge, analysis, planning, assessment, and controlled assistance.", checks: ["owner_isolation", "knowledge_quality", "approval_boundaries", "assessment_integrity", "observability"] },
      { id: "logistics", name: "LOGISTICS", area: "shared_capability", lifecycle: "planned", purpose: "Operational coordination, procurement, delivery, and resource movement.", checks: ["workflow_integrity", "tracking", "supplier_access", "exception_handling"] },
      { id: "customer-experience", name: "CUSTOMER EXPERIENCE", area: "shared_capability", lifecycle: "planned", purpose: "Customer support, feedback, service quality, and user journeys.", checks: ["privacy", "response_quality", "case_access", "service_continuity"] },
      { id: "labs", name: "LABS", area: "shared_capability", lifecycle: "planned", purpose: "Research, experimentation, prototypes, and technical validation.", checks: ["experiment_isolation", "data_handling", "reproducibility", "release_gates"] },
      { id: "governance", name: "GOVERNANCE", area: "shared_capability", lifecycle: "planned", purpose: "Policies, approvals, accountability, and owner oversight.", checks: ["policy_versioning", "approval_integrity", "audit_trails", "separation_of_duties"] },
      { id: "data", name: "DATA", area: "shared_capability", lifecycle: "planned", purpose: "Data organization, quality, retention, and controlled access.", checks: ["data_classification", "retention", "backup_recovery", "owner_isolation"] },
      { id: "robot-operations", name: "ROBOT OPERATIONS", area: "shared_capability", lifecycle: "planned", purpose: "Future fleet operations, device monitoring, and operator workflows.", checks: ["device_authentication", "command_authorization", "safety_interlocks", "event_audit"] }
    ].map(item => ({ ...item, readiness: "not_assessed" }));
    return response({
      success: true,
      company: "MEHRAN MSH",
      registryVersion: 1,
      source: "owner_declared_architecture",
      assessment: "module_inventory_only",
      executionEnabled: false,
      modules,
      limitations: [
        "This is a declared architecture registry, not a live scan of deployed services or repositories.",
        "Every module remains not_assessed until separate evidence-based checks are implemented and run.",
        "No company configuration, task, approval, or production resource is changed."
      ]
    });
  }

  if (path === "/intelligence/company/assessment-coverage" && method === "GET") {
    const modules = [
      { id: "music", checks: ["ownership_and_access", "service_health", "content_integrity", "user_experience"] },
      { id: "ai", checks: ["model_and_provider_configuration", "data_privacy", "access_control", "service_health"] },
      { id: "social", checks: ["authentication", "authorization", "privacy", "upload_security", "abuse_controls"] },
      { id: "instruments", checks: ["catalog_integrity", "supplier_workflows", "payments_and_orders", "logistics"] },
      { id: "robotics", checks: ["device_identity", "safety_boundaries", "update_integrity", "operator_access"] },
      { id: "security", checks: ["authentication", "authorization", "auditability", "secret_handling", "recovery"] },
      { id: "intelligence", checks: ["owner_isolation", "knowledge_quality", "approval_boundaries", "assessment_integrity", "observability"] },
      { id: "logistics", checks: ["workflow_integrity", "tracking", "supplier_access", "exception_handling"] },
      { id: "customer-experience", checks: ["privacy", "response_quality", "case_access", "service_continuity"] },
      { id: "labs", checks: ["experiment_isolation", "data_handling", "reproducibility", "release_gates"] },
      { id: "governance", checks: ["policy_versioning", "approval_integrity", "audit_trails", "separation_of_duties"] },
      { id: "data", checks: ["data_classification", "retention", "backup_recovery", "owner_isolation"] },
      { id: "robot-operations", checks: ["device_authentication", "command_authorization", "safety_interlocks", "event_audit"] }
    ];
    try {
      const rows = await env.DB.prepare(`
        SELECT module_id, check_id, COUNT(*) AS finding_count,
               SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open_finding_count,
               SUM(CASE WHEN evidence_state='sufficient' THEN 1 ELSE 0 END) AS evidence_sufficient_finding_count
        FROM intelligence_findings
        WHERE owner_uid = ?
        GROUP BY module_id, check_id
      `).bind(owner.uid).all();
      const recorded = new Map((rows.results || []).map(row => [
        row.module_id + ":" + row.check_id,
        {
          findingCount: Number(row.finding_count) || 0,
          openFindingCount: Number(row.open_finding_count) || 0,
          evidenceSufficientFindingCount: Number(row.evidence_sufficient_finding_count) || 0
        }
      ]));
      const checks = modules.flatMap(module => module.checks.map(checkId => {
        const counts = recorded.get(module.id + ":" + checkId) || {
          findingCount: 0, openFindingCount: 0, evidenceSufficientFindingCount: 0
        };
        return {
          moduleId: module.id,
          checkId,
          blueprintVersion: 1,
          recordState: counts.findingCount ? "findings_recorded" : "no_recorded_findings",
          ...counts
        };
      }));
      const checksWithFindings = checks.filter(item => item.findingCount > 0).length;
      return response({
        success: true,
        company: "MEHRAN MSH",
        registryVersion: 1,
        blueprintVersion: 1,
        scope: "authenticated_owner_staging_only",
        assessment: "blueprint_coverage_and_recorded_findings_only",
        executionEnabled: false,
        operationPerformed: false,
        modules: modules.length,
        totalChecks: checks.length,
        checksWithFindings,
        checksWithoutRecordedFindings: checks.length - checksWithFindings,
        checks,
        limitations: [
          "This endpoint maps declared blueprint checks to findings already recorded for the authenticated owner.",
          "No recorded finding does not mean a check passed; it means no finding is recorded for that check.",
          "An evidence-sufficient finding is not a check-pass certification.",
          "No check is executed, no evidence is fetched, and no finding or company state is changed."
        ]
      });
    } catch {
      return fail("Assessment coverage is unavailable. Confirm the staging findings schema is present.", 503);
    }
  }

  if (path === "/intelligence/findings/remediation-plans" && method === "GET") {
    const allowedParams = new Set(["module", "limit"]);
    for (const key of url.searchParams.keys()) {
      if (!allowedParams.has(key)) return fail("Unsupported remediation-plan filter.");
    }
    const moduleId = url.searchParams.get("module") || "";
    const rawLimit = url.searchParams.get("limit") || "25";
    const limit = Number(rawLimit);
    const modules = new Set([
      "music", "ai", "social", "instruments", "robotics", "security",
      "intelligence", "logistics", "customer-experience", "labs",
      "governance", "data", "robot-operations"
    ]);
    if (moduleId && !modules.has(moduleId)) return fail("Unknown remediation-plan module filter.");
    if (!/^([1-9][0-9]?|100)$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return fail("Remediation-plan limit must be an integer from 1 to 100.");
    }
    try {
      const rows = await env.DB.prepare(`
        SELECT id, module_id, check_id, severity, status, title, recommendation,
               evidence_state, updated_at
        FROM intelligence_findings
        WHERE owner_uid = ? AND (? = '' OR module_id = ?)
        ORDER BY CASE severity
          WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
          WHEN 'low' THEN 3 WHEN 'info' THEN 4 ELSE 5 END,
          updated_at DESC, id DESC
        LIMIT 500
      `).bind(owner.uid, moduleId, moduleId).all();
      const candidates = (rows.results || [])
        .map(item => ({ item, priority: scoreFindingPriority(item) }))
        .sort((a, b) => b.priority.priorityScore - a.priority.priorityScore)
        .slice(0, limit);
      const plans = candidates.map(({ item, priority }) => ({
        ...buildRemediationPlan(item),
        priorityScore: priority.priorityScore,
        priorityBand: priority.priorityBand
      }));
      return response({
        success: true,
        plans,
        filters: { module: moduleId || null },
        candidateCount: (rows.results || []).length,
        returnedCount: plans.length,
        candidateSetBounded: (rows.results || []).length === 500,
        scope: "authenticated_owner_staging_only",
        assessment: "advisory_remediation_planning_only",
        plannerVersion: "deterministic_remediation_v1",
        executionEnabled: false,
        operationPerformed: false,
        limitations: [
          "Plans are structured suggestions based on recorded finding metadata and a static module guidance catalog.",
          "Affected areas are module-level guidance, not verified repository paths or confirmed root causes.",
          "No source files, external evidence, credentials, or production systems are inspected.",
          "No task is created, no approval is consumed, and no finding or company state is changed."
        ]
      });
    } catch {
      return fail("Remediation plans are unavailable. Confirm the staging findings schema is present.", 503);
    }
  }

  if (path === "/intelligence/findings/priorities" && method === "GET") {
    const allowedParams = new Set(["module", "limit"]);
    for (const key of url.searchParams.keys()) {
      if (!allowedParams.has(key)) return fail("Unsupported priority filter.");
    }
    const moduleId = url.searchParams.get("module") || "";
    const rawLimit = url.searchParams.get("limit") || "25";
    const limit = Number(rawLimit);
    const modules = new Set([
      "music", "ai", "social", "instruments", "robotics", "security",
      "intelligence", "logistics", "customer-experience", "labs",
      "governance", "data", "robot-operations"
    ]);
    if (moduleId && !modules.has(moduleId)) return fail("Unknown priority module filter.");
    if (!/^([1-9][0-9]?|100)$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return fail("Priority limit must be an integer from 1 to 100.");
    }
    try {
      const rows = await env.DB.prepare(`
        SELECT id, module_id, check_id, severity, status, title, recommendation,
               evidence_state, review_due_at, updated_at
        FROM intelligence_findings
        WHERE owner_uid = ? AND (? = '' OR module_id = ?)
        ORDER BY CASE severity
          WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
          WHEN 'low' THEN 3 WHEN 'info' THEN 4 ELSE 5 END,
          updated_at DESC, id DESC
        LIMIT 500
      `).bind(owner.uid, moduleId, moduleId).all();
      const scanned = rows.results || [];
      const ranked = scanned.map(item => ({ ...item, ...scoreFindingPriority(item) }))
        .sort(compareFindingPriority);
      const items = ranked.slice(0, limit);
      return response({
        success: true,
        items,
        filters: { module: moduleId || null },
        candidateCount: scanned.length,
        returnedCount: items.length,
        candidateSetBounded: scanned.length === 500,
        scope: "authenticated_owner_staging_only",
        assessment: "deterministic_metadata_triage_only",
        triageModel: "deterministic_metadata_v1",
        isRiskVerdict: false,
        executionEnabled: false,
        operationPerformed: false,
        limitations: [
          "Priority is a deterministic triage aid based only on recorded severity, status, and evidence state.",
          "The score is not a measured risk probability, security verdict, or certification.",
          "Evidence state changes attention only; sufficient evidence does not reduce the score or prove a check passed.",
          "At most 500 findings are considered per request; a bounded candidate set may omit older records.",
          "No external evidence is fetched and no finding or company state is changed."
        ]
      });
    } catch {
      return fail("Finding priorities are unavailable. Confirm the staging findings schema is present.", 503);
    }
  }

  if (path === "/intelligence/company/dependency-impact" && method === "GET") {
    const allowedParams = new Set(["module"]);
    for (const key of url.searchParams.keys()) {
      if (!allowedParams.has(key)) return fail("Unsupported dependency impact filter.");
    }
    const moduleId = url.searchParams.get("module") || "";
    if (!COMPANY_MODULES.includes(moduleId)) return fail("A valid company module is required.");
    try {
      const analysis = analyzeDependencyImpact(moduleId);
      return response({
        success: true,
        company: "MEHRAN MSH",
        scope: "authenticated_owner_staging_only",
        assessment: "provisional_declared_dependency_impact_only",
        ...analysis
      });
    } catch {
      return fail("Dependency impact analysis is unavailable.", 503);
    }
  }

  if (path === "/intelligence/company/gap-test-strategy" && method === "GET") {
    const allowedParams = new Set(["module"]);
    for (const key of url.searchParams.keys()) {
      if (!allowedParams.has(key)) return fail("Unsupported gap analysis filter.");
    }
    const moduleId = url.searchParams.get("module") || "";
    if (!COMPANY_MODULES.includes(moduleId)) return fail("A valid company module is required.");
    try {
      const rows = await env.DB.prepare(`
        SELECT check_id, COUNT(*) AS finding_count,
          SUM(CASE WHEN status IN ('open','accepted') THEN 1 ELSE 0 END) AS open_finding_count
        FROM intelligence_findings
        WHERE owner_uid = ? AND module_id = ?
        GROUP BY check_id
      `).bind(owner.uid, moduleId).all();
      const strategy = buildGapTestStrategy(moduleId, rows.results || []);
      return response({
        success: true,
        company: "MEHRAN MSH",
        scope: "authenticated_owner_staging_only",
        assessment: "blueprint_gap_signals_and_test_recommendations_only",
        executionEnabled: false,
        operationPerformed: false,
        ...strategy
      });
    } catch {
      return fail("Gap analysis and test strategy are unavailable. Confirm the staging findings schema is present.", 503);
    }
  }

  if (path === "/intelligence/findings/evidence-review" && method === "GET") {
    const allowedParams = new Set(["module", "limit"]);
    for (const key of url.searchParams.keys()) {
      if (!allowedParams.has(key)) return fail("Unsupported evidence review filter.");
    }
    const moduleId = url.searchParams.get("module") || "";
    const rawLimit = url.searchParams.get("limit") || "100";
    const limit = Number(rawLimit);
    if (moduleId && !COMPANY_MODULES.includes(moduleId)) return fail("Unknown evidence review module.");
    if (!/^(?:[1-9]\d?|100)$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return fail("Evidence review limit must be an integer from 1 to 100.");
    }
    try {
      const rows = await env.DB.prepare(`
        SELECT f.id, f.module_id, f.check_id, f.severity, f.status, f.evidence_state,
          COUNT(e.id) AS evidence_count,
          SUM(CASE WHEN e.id IS NOT NULL AND e.content_digest IS NULL THEN 1 ELSE 0 END) AS missing_digest_count,
          SUM(CASE WHEN e.id IS NOT NULL AND e.observed_at IS NULL THEN 1 ELSE 0 END) AS missing_observed_at_count,
          COUNT(e.content_digest) - COUNT(DISTINCT e.content_digest) AS duplicate_digest_count
        FROM intelligence_findings f
        LEFT JOIN intelligence_finding_evidence e
          ON e.finding_id = f.id AND e.owner_uid = f.owner_uid
        WHERE f.owner_uid = ? AND (? = '' OR f.module_id = ?)
        GROUP BY f.id
        ORDER BY f.updated_at DESC, f.id DESC
        LIMIT ?
      `).bind(owner.uid, moduleId, moduleId, limit).all();
      const review = buildEvidenceMetadataReview(rows.results || []);
      return response({
        success: true,
        scope: "authenticated_owner_staging_only",
        assessment: "recorded_evidence_metadata_review_only",
        module: moduleId || null,
        executionEnabled: false,
        operationPerformed: false,
        ...review
      });
    } catch {
      return fail("Evidence metadata review is unavailable. Confirm the staging findings schema is present.", 503);
    }
  }


  if (path === "/intelligence/findings/evidence-correlations/reviews" && method === "GET") {
    const allowedParams = new Set(["correlationKeySha256", "limit"]);
    for (const key of url.searchParams.keys()) {
      if (!allowedParams.has(key)) return fail("Unsupported correlation review history filter.");
    }
    const keyHash = url.searchParams.get("correlationKeySha256") || "";
    const rawLimit = url.searchParams.get("limit") || "50";
    const limit = Number(rawLimit);
    if (keyHash && !/^[0-9a-f]{64}$/.test(keyHash)) return fail("Invalid correlation key hash.");
    if (!/^(?:[1-9]\d?|100)$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return fail("Correlation review history limit must be an integer from 1 to 100.");
    }
    try {
      const rows = await env.DB.prepare(`
        SELECT id, correlation_type, correlation_key_sha256, outcome, reason,
               reviewer_uid, reviewed_at, reference_count,
               correlation_snapshot_sha256, correlation_snapshot_json
        FROM intelligence_evidence_correlation_reviews
        WHERE owner_uid = ? AND (? = '' OR correlation_key_sha256 = ?)
        ORDER BY reviewed_at DESC, id DESC
        LIMIT ?
      `).bind(owner.uid, keyHash, keyHash, limit).all();
      return response({
        success: true,
        scope: "authenticated_owner_staging_only",
        ...buildEvidenceCorrelationReviewHistory(rows.results || [])
      });
    } catch {
      return fail("Correlation review history is unavailable. Confirm staging migration 0011 is present.", 503);
    }
  }

  if (path === "/intelligence/findings/evidence-correlations/reviews" && method === "POST") {
    const body = await readJson(request);
    if (!body || Object.keys(body).some(key => !["correlationType", "correlationKey", "outcome", "reason"].includes(key)) ||
        !EVIDENCE_CORRELATION_TYPES.includes(body.correlationType) ||
        typeof body.correlationKey !== "string" || body.correlationKey.length < 1 || body.correlationKey.length > 200 ||
        /[\u0000-\u001f\u007f]/.test(body.correlationKey) ||
        !EVIDENCE_CORRELATION_REVIEW_OUTCOMES.includes(body.outcome) ||
        typeof body.reason !== "string" || body.reason.length > 1000 ||
        !clean(body.reason, 1000) || clean(body.reason, 1000).length !== body.reason.trim().length) {
      return fail("A valid correlation pattern, owner outcome, and bounded reason are required.");
    }
    try {
      const rows = await env.DB.prepare(`
        SELECT e.id, e.finding_id, f.module_id, f.check_id, e.kind,
               e.source_ref, e.content_digest
        FROM intelligence_finding_evidence e
        INNER JOIN intelligence_findings f
          ON f.id = e.finding_id AND f.owner_uid = e.owner_uid
        WHERE e.owner_uid = ? AND f.owner_uid = ?
        ORDER BY e.id ASC
        LIMIT 501
      `).bind(owner.uid, owner.uid).all();
      const analysis = buildEvidenceCorrelation(rows.results || [], { maxRows: 500, maxGroups: 50 });
      const group = analysis.returnedCorrelationGroups.find(item =>
        item.correlationType === body.correlationType && item.correlationKey === body.correlationKey
      );
      if (!group) return fail("This correlation pattern is no longer present in the current bounded owner-scoped analysis.", 409);
      if (group.referencesTruncated || group.referenceCount > 20) {
        return fail("This correlation group exceeds the 20-reference review snapshot limit and cannot be recorded as a complete review.", 409);
      }
      const snapshot = buildEvidenceCorrelationReviewSnapshot(group.references);
      const keyHashBytes = new Uint8Array(await crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode(body.correlationKey)
      ));
      const keyHash = Array.from(keyHashBytes, byte => byte.toString(16).padStart(2, "0")).join("");
      const snapshotHashBytes = new Uint8Array(await crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode(snapshot.snapshotJson)
      ));
      const snapshotHash = Array.from(snapshotHashBytes, byte => byte.toString(16).padStart(2, "0")).join("");
      const reviewId = randomId();
      const reviewedAt = Math.floor(Date.now() / 1000);
      await env.DB.prepare(`
        INSERT INTO intelligence_evidence_correlation_reviews
          (id, owner_uid, reviewer_uid, correlation_type, correlation_key_sha256,
           outcome, reason, correlation_snapshot_json, correlation_snapshot_sha256,
           reference_count, reviewed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        reviewId, owner.uid, owner.uid, body.correlationType, keyHash,
        body.outcome, clean(body.reason, 1000), snapshot.snapshotJson,
        snapshotHash, snapshot.referenceCount, reviewedAt, reviewedAt
      ).run();
      return response({
        success: true,
        id: reviewId,
        correlationType: body.correlationType,
        correlationKeySha256: keyHash,
        outcome: body.outcome,
        reviewerUid: owner.uid,
        reviewedAt,
        referenceCount: snapshot.referenceCount,
        snapshotSha256: snapshotHash,
        historyIsAppendOnly: true,
        relationshipFactVerified: false,
        evidenceContentVerified: false,
        checkPassed: false,
        executionEnabled: false,
        operationPerformed: true
      }, 201);
    } catch {
      return fail("Correlation owner review could not be recorded. Confirm staging migration 0011 and the current correlation group.", 503);
    }
  }

  if (path === "/intelligence/findings/evidence-consistency" && method === "GET") {
    const allowedParams = new Set(["module"]);
    for (const key of url.searchParams.keys()) {
      if (!allowedParams.has(key)) return fail("Unsupported evidence consistency filter.");
    }
    const moduleId = url.searchParams.get("module") || "";
    if (moduleId && !COMPANY_MODULES.includes(moduleId)) return fail("Unknown evidence consistency module filter.");
    try {
      const rows = await env.DB.prepare(`
        SELECT e.id, e.finding_id, f.module_id, f.check_id, e.kind,
               e.source_ref, e.content_digest
        FROM intelligence_finding_evidence e
        INNER JOIN intelligence_findings f
          ON f.id = e.finding_id AND f.owner_uid = e.owner_uid
        WHERE e.owner_uid = ? AND f.owner_uid = ?
          AND (? = '' OR f.module_id = ?)
        ORDER BY e.id ASC
        LIMIT 501
      `).bind(owner.uid, owner.uid, moduleId, moduleId).all();
      const analysis = buildEvidenceConsistency(rows.results || [], { maxRows: 500, maxGroups: 50 });
      return response({
        success: true,
        company: "MEHRAN MSH",
        scope: "authenticated_owner_staging_only",
        filter: { module: moduleId || null },
        ...analysis
      });
    } catch {
      return fail("Evidence consistency analysis is unavailable. Confirm the staging findings schema is present.", 503);
    }
  }

  if (path === "/intelligence/findings/evidence-correlations" && method === "GET") {
    const allowedParams = new Set(["module"]);
    for (const key of url.searchParams.keys()) {
      if (!allowedParams.has(key)) return fail("Unsupported evidence correlation filter.");
    }
    const moduleId = url.searchParams.get("module") || "";
    const modules = new Set([
      "music", "ai", "social", "instruments", "robotics", "security",
      "intelligence", "logistics", "customer-experience", "labs",
      "governance", "data", "robot-operations"
    ]);
    if (moduleId && !modules.has(moduleId)) return fail("Unknown evidence correlation module filter.");
    try {
      const rows = await env.DB.prepare(`
        SELECT e.id, e.finding_id, f.module_id, f.check_id, e.kind,
               e.source_ref, e.content_digest
        FROM intelligence_finding_evidence e
        INNER JOIN intelligence_findings f
          ON f.id = e.finding_id AND f.owner_uid = e.owner_uid
        WHERE e.owner_uid = ? AND f.owner_uid = ?
          AND (? = '' OR f.module_id = ?)
        ORDER BY e.id ASC
        LIMIT 501
      `).bind(owner.uid, owner.uid, moduleId, moduleId).all();
      const analysis = buildEvidenceCorrelation(rows.results || [], { maxRows: 500, maxGroups: 50 });
      return response({
        success: true,
        company: "MEHRAN MSH",
        scope: "authenticated_owner_staging_only",
        filter: { module: moduleId || null },
        ...analysis
      });
    } catch {
      return fail("Evidence correlation analysis is unavailable. Confirm the staging findings schema is present.", 503);
    }
  }

  if (path === "/intelligence/findings/evidence-drift" && method === "GET") {
    const allowedParams = new Set(["findingId"]);
    for (const key of url.searchParams.keys()) {
      if (!allowedParams.has(key)) return fail("Unsupported evidence drift filter.");
    }
    const findingId = url.searchParams.get("findingId") || "";
    if (!uuid(findingId)) return fail("A valid finding ID is required.");
    try {
      const finding = await env.DB.prepare(
        "SELECT id FROM intelligence_findings WHERE id = ? AND owner_uid = ? LIMIT 1"
      ).bind(findingId, owner.uid).first();
      if (!finding) return fail("Finding not found.", 404);
      const evidenceRows = await env.DB.prepare(`
        SELECT id, kind, content_digest, observed_at
        FROM intelligence_finding_evidence
        WHERE finding_id = ? AND owner_uid = ?
        ORDER BY id ASC
        LIMIT 101
      `).bind(findingId, owner.uid).all();
      if ((evidenceRows.results || []).length > 100) {
        return fail("This finding exceeds the bounded 100-reference drift comparison.", 409);
      }
      const latestReview = await env.DB.prepare(`
        SELECT id, outcome, reviewed_at, evidence_snapshot_json, evidence_snapshot_sha256
        FROM intelligence_finding_reviews
        WHERE finding_id = ? AND owner_uid = ?
        ORDER BY reviewed_at DESC, id DESC
        LIMIT 1
      `).bind(findingId, owner.uid).first();
      let baseline = null;
      if (latestReview) {
        const digestBytes = new Uint8Array(await crypto.subtle.digest(
          "SHA-256", new TextEncoder().encode(latestReview.evidence_snapshot_json)
        ));
        const actualDigest = Array.from(digestBytes, byte => byte.toString(16).padStart(2, "0")).join("");
        if (actualDigest !== latestReview.evidence_snapshot_sha256) {
          return fail("The stored owner review snapshot digest does not match its recorded metadata.", 409);
        }
        baseline = JSON.parse(latestReview.evidence_snapshot_json);
      }
      const drift = buildEvidenceDrift(baseline, evidenceRows.results || []);
      return response({
        success: true,
        findingId,
        scope: "authenticated_owner_staging_only",
        assessment: "metadata_snapshot_drift_only",
        baselineReviewId: latestReview?.id || null,
        baselineOutcome: latestReview?.outcome || null,
        baselineReviewedAt: latestReview ? Number(latestReview.reviewed_at) : null,
        baselineSnapshotSha256: latestReview?.evidence_snapshot_sha256 || null,
        ...drift,
        evidenceContentVerified: false,
        sourceReachabilityChecked: false,
        authenticityVerified: false,
        correctnessVerified: false,
        checkPassed: false,
        isRiskVerdict: false,
        executionEnabled: false,
        operationPerformed: false
      });
    } catch {
      return fail("Evidence snapshot drift analysis is unavailable. Confirm staging migrations 0009 and 0010 are present.", 503);
    }
  }

  if (path === "/intelligence/findings/reviews" && method === "GET") {
    const allowedParams = new Set(["findingId", "limit"]);
    for (const key of url.searchParams.keys()) {
      if (!allowedParams.has(key)) return fail("Unsupported owner review history filter.");
    }
    const findingId = url.searchParams.get("findingId") || "";
    const rawLimit = url.searchParams.get("limit") || "50";
    const limit = Number(rawLimit);
    if (!uuid(findingId)) return fail("A valid finding ID is required.");
    if (!/^(?:[1-9]\d?|100)$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return fail("Review history limit must be an integer from 1 to 100.");
    }
    try {
      const rows = await env.DB.prepare(`
        SELECT id, finding_id, outcome, reason, reviewer_uid, reviewed_at,
               evidence_count, evidence_snapshot_sha256, evidence_snapshot_json
        FROM intelligence_finding_reviews
        WHERE owner_uid = ? AND finding_id = ?
        ORDER BY reviewed_at DESC, id DESC
        LIMIT ?
      `).bind(owner.uid, findingId, limit).all();
      return response({
        success: true,
        scope: "authenticated_owner_staging_only",
        assessment: "append_only_owner_review_history",
        ...buildOwnerEvidenceReviewHistory(rows.results || [])
      });
    } catch {
      return fail("Owner evidence review history is unavailable. Confirm staging migration 0010 is present.", 503);
    }
  }

  const ownerReviewMatch = path.match(/^\/intelligence\/findings\/([0-9a-f-]{36})\/reviews$/i);
  if (ownerReviewMatch && method === "POST") {
    const findingId = ownerReviewMatch[1];
    if (!uuid(findingId)) return fail("Invalid finding ID.");
    const body = await readJson(request);
    if (!body || Object.keys(body).some(key => !["outcome", "reason"].includes(key)) ||
        !OWNER_EVIDENCE_REVIEW_OUTCOMES.includes(body.outcome) ||
        typeof body.reason !== "string" || body.reason.length > 1000 ||
        !clean(body.reason, 1000) || clean(body.reason, 1000).length !== body.reason.trim().length) {
      return fail("A valid review outcome and bounded reason are required.");
    }
    try {
      const finding = await env.DB.prepare(
        "SELECT id FROM intelligence_findings WHERE id = ? AND owner_uid = ? LIMIT 1"
      ).bind(findingId, owner.uid).first();
      if (!finding) return fail("Finding not found.", 404);
      const countRow = await env.DB.prepare(
        "SELECT COUNT(*) AS evidence_count FROM intelligence_finding_evidence WHERE finding_id = ? AND owner_uid = ?"
      ).bind(findingId, owner.uid).first();
      const evidenceCount = Number(countRow?.evidence_count || 0);
      if (!Number.isSafeInteger(evidenceCount) || evidenceCount > 100) {
        return fail("This finding has more than 100 evidence references; review snapshot is bounded and cannot be recorded.", 409);
      }
      const evidenceRows = await env.DB.prepare(`
        SELECT id, kind, content_digest, observed_at
        FROM intelligence_finding_evidence
        WHERE finding_id = ? AND owner_uid = ?
        ORDER BY id ASC
        LIMIT 101
      `).bind(findingId, owner.uid).all();
      const snapshot = buildEvidenceSnapshot(evidenceRows.results || []);
      const snapshotHashBytes = new Uint8Array(await crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode(snapshot.evidenceSnapshotJson)
      ));
      const snapshotHash = Array.from(snapshotHashBytes, byte => byte.toString(16).padStart(2, "0")).join("");
      const reviewId = randomId();
      const reviewedAt = Math.floor(Date.now() / 1000);
      await env.DB.prepare(`
        INSERT INTO intelligence_finding_reviews
          (id, finding_id, owner_uid, reviewer_uid, outcome, reason,
           evidence_snapshot_json, evidence_snapshot_sha256, evidence_count,
           reviewed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        reviewId, findingId, owner.uid, owner.uid, body.outcome,
        clean(body.reason, 1000), snapshot.evidenceSnapshotJson,
        snapshotHash, snapshot.evidenceCount, reviewedAt, reviewedAt
      ).run();
      return response({
        success: true,
        id: reviewId,
        findingId,
        outcome: body.outcome,
        reviewerUid: owner.uid,
        reviewedAt,
        evidenceCount: snapshot.evidenceCount,
        evidenceSnapshotSha256: snapshotHash,
        historyIsAppendOnly: true,
        evidenceContentVerified: false,
        checkPassed: false,
        executionEnabled: false,
        operationPerformed: true
      }, 201);
    } catch {
      return fail("Owner evidence review could not be recorded. Confirm staging migration 0010 and the finding's evidence references.", 503);
    }
  }

  if (path === "/intelligence/findings" && method === "GET") {
    const allowedParams = new Set(["module", "severity", "status", "limit", "offset"]);
    for (const key of url.searchParams.keys()) {
      if (!allowedParams.has(key)) return fail("Unsupported findings filter.");
    }
    const moduleId = url.searchParams.get("module") || "";
    const severity = url.searchParams.get("severity") || "";
    const status = url.searchParams.get("status") || "";
    const rawLimit = url.searchParams.get("limit") || "25";
    const rawOffset = url.searchParams.get("offset") || "0";
    const limit = Number(rawLimit);
    const offset = Number(rawOffset);
    const modules = new Set([
      "music", "ai", "social", "instruments", "robotics", "security",
      "intelligence", "logistics", "customer-experience", "labs",
      "governance", "data", "robot-operations"
    ]);
    const severities = new Set(["critical", "high", "medium", "low", "info", "unrated"]);
    const statuses = new Set(["open", "accepted", "mitigated", "resolved", "false_positive"]);
    if (moduleId && !modules.has(moduleId)) return fail("Unknown findings module filter.");
    if (severity && !severities.has(severity)) return fail("Invalid findings severity filter.");
    if (status && !statuses.has(status)) return fail("Invalid findings status filter.");
    if (!/^([1-9]\d?|100)$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return fail("Findings limit must be an integer from 1 to 100.");
    }
    if (!/^\d+$/.test(rawOffset) || !Number.isSafeInteger(offset) || offset > 10000) {
      return fail("Invalid findings page offset.");
    }
    try {
      const rows = await env.DB.prepare(`
        SELECT f.id, f.module_id, f.check_id, f.blueprint_version,
               f.severity, f.status, f.title, f.description,
               f.evidence_state, f.recommendation, f.status_reason,
               f.review_due_at, f.created_at, f.updated_at, f.created_by,
               (SELECT COUNT(*) FROM intelligence_finding_evidence e
                WHERE e.finding_id = f.id AND e.owner_uid = f.owner_uid) AS evidence_count
        FROM intelligence_findings f
        WHERE f.owner_uid = ?
          AND (? = '' OR f.module_id = ?)
          AND (? = '' OR f.severity = ?)
          AND (? = '' OR f.status = ?)
        ORDER BY
          CASE f.severity
            WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
            WHEN 'low' THEN 3 WHEN 'info' THEN 4 ELSE 5
          END,
          f.updated_at DESC, f.id DESC
        LIMIT ? OFFSET ?
      `).bind(owner.uid, moduleId, moduleId, severity, severity,
        status, status, limit + 1, offset).all();
      const scanned = rows.results || [];
      const items = scanned.slice(0, limit);
      return response({
        success: true,
        items,
        filters: { module: moduleId || null, severity: severity || null, status: status || null },
        offset, limit,
        hasMore: scanned.length > limit,
        nextOffset: scanned.length > limit ? offset + items.length : null,
        scope: "authenticated_owner_staging_only",
        assessment: "recorded_findings_only",
        executionEnabled: false,
        limitations: [
          "Findings are recorded observations, not a security certification.",
          "Evidence count means references are attached; it does not validate their contents or prove a check passed.",
          "This endpoint is read-only and does not create, update, resolve, or execute anything."
        ]
      });
    } catch {
      return fail("Findings are unavailable. Confirm the staging schema migration is present.", 503);
    }
  }

  if (path === "/intelligence/capabilities" && method === "GET") {
    return response({
      success: true,
      executionEnabled: false,
      assessment: "policy_inventory_only",
      capabilities: listCapabilityPolicy()
    });
  }

  if (path === "/intelligence/capability-approvals" && method === "GET") {
    const now = Math.floor(Date.now() / 1000);
    try {
      const rows = await env.DB.prepare(`
        SELECT id,capability,scope,
               CASE WHEN status='issued' AND expires_at<=? THEN 'expired' ELSE status END AS status,
               issued_at,expires_at,revoked_at,consumed_at,consumed_by
        FROM intelligence_capability_approvals
        WHERE owner_uid=?
        ORDER BY issued_at DESC LIMIT 100
      `).bind(now, owner.uid).all();
      return response({ success: true, items: rows.results || [], executionEnabled: false });
    } catch {
      return fail("Capability approvals could not be safely loaded.", 503);
    }
  }

  if (path === "/intelligence/capability-approvals" && method === "POST") {
    const body = await readJson(request);
    const allowed = new Set(["knowledge.create", "memory.create", "knowledge.review", "memory.delete"]);
    if (!body || Object.keys(body).some(key => !["capability", "expiresInSeconds"].includes(key)) ||
        typeof body.capability !== "string" || !allowed.has(body.capability)) {
      return fail("A known approval-tier capability is required.");
    }
    const lifetime = parseApprovalLifetime(body.expiresInSeconds);
    if (!lifetime.valid) return fail("Approval expiry must be an integer number of seconds between 60 and 3600.");
    const now = Math.floor(Date.now() / 1000);
    const id = randomId();
    try {
      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO intelligence_capability_approvals
            (id,owner_uid,capability,scope,status,issued_at,expires_at)
          VALUES(?,?,?,'owner_staging','issued',?,?)
        `).bind(id, owner.uid, body.capability, now, now + lifetime.seconds),
        audit(env.DB, owner.uid, "capability_approval_issued", "capability_approval", id, {
          capability: body.capability,
          scope: "owner_staging",
          expiresAt: now + lifetime.seconds
        })
      ]);
    } catch {
      return fail("Capability approval could not be safely issued.", 503);
    }
    return response({
      success: true, id, capability: body.capability, scope: "owner_staging",
      status: "issued", expiresAt: now + lifetime.seconds, executionEnabled: false
    }, 201);
  }

  const capabilityApprovalMatch = path.match(/^\/intelligence\/capability-approvals\/([0-9a-f-]{36})$/i);
  if (capabilityApprovalMatch && method === "DELETE") {
    const id = capabilityApprovalMatch[1];
    const now = Math.floor(Date.now() / 1000);
    try {
      const results = await env.DB.batch([
        // Migration 0008 records this state transition through its audit trigger.
        // Do not insert a second application-level audit row here.
        env.DB.prepare(`
          UPDATE intelligence_capability_approvals
          SET status='revoked',revoked_at=?
          WHERE id=? AND owner_uid=? AND status='issued' AND expires_at>?
        `).bind(now, id, owner.uid, now)
      ]);
      if (!Number(results?.[0]?.meta?.changes || 0)) return fail("Capability approval not found or no longer revocable.", 409);
      return response({ success: true, id, status: "revoked", executionEnabled: false });
    } catch {
      return fail("Capability approval revocation failed safely.", 503);
    }
  }

  if (path === "/intelligence/capabilities/evaluate" && method === "POST") {
    const body = await readJson(request);
    if (!body || Object.keys(body).some(key => !["capability", "approvalId"].includes(key)) ||
        typeof body.capability !== "string" || body.capability.length > 80 ||
        (Object.hasOwn(body, "approvalId") && !uuid(body.approvalId))) {
      return fail("A capability identifier and optional valid approval ID are required.");
    }
    let approval = null;
    if (Object.hasOwn(body, "approvalId")) {
      const row = await env.DB.prepare(`
        SELECT owner_uid,capability,scope,status,expires_at,revoked_at,consumed_at,consumed_by
        FROM intelligence_capability_approvals
        WHERE id=? AND owner_uid=?
        LIMIT 1
      `).bind(body.approvalId, owner.uid).first();
      if (row) {
        approval = {
          serverVerified: true,
          ownerId: row.owner_uid,
          capability: row.capability,
          scope: row.scope,
          status: row.status,
          expiresAt: Number(row.expires_at),
          revoked: row.revoked_at !== null,
          revokedAt: row.revoked_at,
          consumedAt: row.consumed_at,
          consumedBy: row.consumed_by
        };
      }
    }
    // Approval data is loaded from D1 by this Worker, never trusted from the client.
    // This endpoint only assesses eligibility; it never consumes approval or performs an operation.
    const assessment = evaluateCapabilityRequest({
      capability: body.capability,
      ownerAuthenticated: true,
      sessionValid: true,
      ownerId: owner.uid,
      scope: "owner_staging",
      approval
    });
    try {
      await env.DB.batch([
        audit(env.DB, owner.uid, "capability_assessed", "capability", body.capability, {
          decision: assessment.decision,
          reason: assessment.reason,
          approvalPresented: Boolean(body.approvalId),
          assessmentOnly: true
        })
      ]);
    } catch {
      return fail("Capability assessment could not be safely audited.", 503);
    }
    return response({
      success: true,
      assessment: { ...assessment, executionEnabled: false },
      operationPerformed: false,
      approvalConsumed: false,
      assessmentOnly: true,
      auditRecorded: true
    });
  }

  if (path === "/intelligence/tasks" && method === "GET") {
    const rows = await env.DB.prepare(`
      SELECT id, title, description, assigned_to, priority, status,
             requires_approval, created_at, updated_at
      FROM intelligence_tasks
      WHERE created_by = ?
      ORDER BY created_at DESC LIMIT 100
    `).bind(owner.uid).all();
    return response({ success: true, executionEnabled: false, items: rows.results || [] });
  }

  if (path === "/intelligence/tasks" && method === "POST") {
    const body = await readJson(request);
    if (!body || Object.keys(body).some(key => !["title","description","priority","requiresApproval"].includes(key))) return fail("Invalid task payload.");
    const title = clean(body.title, 160);
    const description = clean(body.description, 3000);
    const priority = clean(body.priority || "normal", 16);
    if (!title || !["high","normal","low"].includes(priority) ||
        (body.requiresApproval !== undefined && typeof body.requiresApproval !== "boolean")) return fail("A title, valid priority and boolean approval flag are required.");
    const id = randomId();
    try {
      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO intelligence_tasks
            (id,title,description,assigned_to,priority,status,requires_approval,created_by)
          VALUES (?,?,?,'mehran_intelligence',?,'queued',?,?)
        `).bind(id, title, description, priority, body.requiresApproval ? 1 : 0, owner.uid),
        audit(env.DB, owner.uid, "task_planned", "task", id, { priority, requiresApproval: !!body.requiresApproval })
      ]);
    } catch {
      return fail("Task could not be recorded.", 503);
    }
    return response({ success: true, id, status: "queued", executionEnabled: false }, 201);
  }

  if (path === "/intelligence/memory" && method === "GET") {
    const state = url.searchParams.get("state") || "active";
    if (!["active", "archived", "all"].includes(state)) return fail("Invalid memory state filter.");
    const rawOffset = url.searchParams.get("offset") || "0";
    const offset = Number(rawOffset);
    if (!/^\d+$/.test(rawOffset) || !Number.isSafeInteger(offset) || offset > 10000) {
      return fail("Invalid memory page offset.");
    }
    const rows = await env.DB.prepare(`
      SELECT id, category, content, memory_kind, source_type, source_ref,
             confidence_score, review_status, reviewed_at, archived_at,
             created_at, updated_at
      FROM intelligence_owner_memory
      WHERE owner_uid = ?
        AND (? = 'all' OR (? = 'archived' AND archived_at IS NOT NULL) OR (? = 'active' AND archived_at IS NULL))
      ORDER BY updated_at DESC, id DESC LIMIT 101 OFFSET ?
    `).bind(owner.uid, state, state, state, offset).all();
    const scanned = rows.results || [];
    const items = scanned.slice(0, 100);
    return response({ success: true, state, items, offset, limit: 100, hasMore: scanned.length > 100 && offset + items.length < 10000, nextOffset: scanned.length > 100 && offset + items.length < 10000 ? offset + items.length : null });
  }

  if (path === "/intelligence/memory" && method === "POST") {
    const body = await readJson(request);
    const allowed = ["category", "content", "memoryKind", "sourceType", "sourceRef", "confidenceScore"];
    if (!body || Object.keys(body).some(key => !allowed.includes(key))) return fail("Invalid memory payload.");
    const category = clean(body.category || "general", 40);
    const content = clean(body.content, 4000);
    const memoryKind = clean(body.memoryKind || "general", 40);
    const sourceType = clean(body.sourceType || "owner_input", 40);
    const sourceRef = body.sourceRef == null ? null : clean(body.sourceRef, 1000);
    const confidenceScore = body.confidenceScore === undefined || body.confidenceScore === null ? null : body.confidenceScore;
    const kinds = ["general", "preference", "goal", "constraint", "decision", "project_context"];
    const sourceTypes = ["owner_input", "knowledge_record", "system_observation"];
    if (!category || typeof body.content !== "string" || !content || body.content.length > 4000 ||
        !kinds.includes(memoryKind) || !sourceTypes.includes(sourceType) ||
        (sourceRef !== null && (!sourceRef || /[\r\n]/.test(sourceRef))) ||
        (confidenceScore !== null && (typeof confidenceScore !== "number" || !Number.isSafeInteger(confidenceScore) || confidenceScore < 0 || confidenceScore > 100)) ||
        (sourceType === "owner_input" && sourceRef !== null) ||
        (sourceType === "knowledge_record" && !uuid(sourceRef))) {
      return fail("Memory content, type, provenance, or confidence is invalid.");
    }
    const id = randomId();
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO intelligence_owner_memory
          (id,owner_uid,category,content,memory_kind,source_type,source_ref,confidence_score)
          VALUES(?,?,?,?,?,?,?,?)`)
          .bind(id, owner.uid, category, content, memoryKind, sourceType, sourceRef, confidenceScore),
        audit(env.DB, owner.uid, "owner_memory_created", "memory", id, { category, memoryKind, sourceType, confidenceScore })
      ]);
    } catch {
      return fail("Owner memory could not be saved; verify that any linked knowledge belongs to this owner.", 503);
    }
    return response({ success: true, id, reviewStatus: "unreviewed" }, 201);
  }

  if (path === "/intelligence/memory/review-queue" && method === "GET") {
    const rawOffset = url.searchParams.get("offset") || "0";
    const offset = Number(rawOffset);
    if (!/^\d+$/.test(rawOffset) || !Number.isSafeInteger(offset) || offset > 10000) {
      return fail("Invalid memory review queue offset.");
    }
    const rows = await env.DB.prepare(`
      SELECT id, category, content, memory_kind, source_type, source_ref,
             confidence_score, review_status, reviewed_at, updated_at
      FROM intelligence_owner_memory
      WHERE owner_uid = ? AND archived_at IS NULL
        AND review_status IN ('disputed','unreviewed')
      ORDER BY CASE review_status WHEN 'disputed' THEN 0 WHEN 'unreviewed' THEN 1 ELSE 2 END,
               updated_at ASC, id ASC
      LIMIT 101 OFFSET ?
    `).bind(owner.uid, offset).all();
    const scanned = rows.results || [];
    const items = scanned.slice(0, 100);
    return response({ success: true, assessment: "owner_review_state_only", items, offset, limit: 100, hasMore: scanned.length > 100 && offset + items.length < 10000, nextOffset: scanned.length > 100 && offset + items.length < 10000 ? offset + items.length : null });
  }

  const memoryMatch = path.match(/^\/intelligence\/memory\/([0-9a-f-]{36})$/i);
  if (memoryMatch && method === "PUT") {
    const id = memoryMatch[1];
    const body = await readJson(request);
    if (!body || Object.keys(body).some(key => !["category", "content", "action"].includes(key))) return fail("Invalid memory update.");
    const action = clean(body.action, 20);
    if (Object.prototype.hasOwnProperty.call(body, "action") &&
        !["confirm", "dispute", "unverify", "archive", "restore"].includes(action)) {
      return fail("Unsupported memory action.");
    }
    const now = new Date().toISOString();
    if (action) {
      const transitions = {
        confirm: { sql: "UPDATE intelligence_owner_memory SET review_status='owner_confirmed',reviewed_at=?,updated_at=? WHERE id=? AND owner_uid=? AND archived_at IS NULL", audit: "owner_memory_confirmed" },
        dispute: { sql: "UPDATE intelligence_owner_memory SET review_status='disputed',reviewed_at=?,updated_at=? WHERE id=? AND owner_uid=? AND archived_at IS NULL", audit: "owner_memory_disputed" },
        unverify: { sql: "UPDATE intelligence_owner_memory SET review_status='unreviewed',reviewed_at=NULL,updated_at=? WHERE id=? AND owner_uid=? AND archived_at IS NULL", audit: "owner_memory_unverified" },
        archive: { sql: "UPDATE intelligence_owner_memory SET archived_at=?,updated_at=? WHERE id=? AND owner_uid=? AND archived_at IS NULL", audit: "owner_memory_archived" },
        restore: { sql: "UPDATE intelligence_owner_memory SET archived_at=NULL,updated_at=? WHERE id=? AND owner_uid=? AND archived_at IS NOT NULL", audit: "owner_memory_restored" }
      };
      const transition = transitions[action];
      if (!transition || Object.keys(body).length !== 1) return fail("Unsupported memory action.");
      const values = action === "confirm" || action === "dispute" || action === "archive"
        ? [now, now, id, owner.uid] : [now, id, owner.uid];
      try {
        const results = await env.DB.batch([
          env.DB.prepare(transition.sql).bind(...values),
          env.DB.prepare(`
            INSERT INTO intelligence_staging_audit(id,owner_uid,action,target_type,target_id,details_json,created_at)
            SELECT ?,?,?,?,?,?,? WHERE changes() = 1
          `).bind(randomId(), owner.uid, transition.audit, "memory", id, "{}", Math.floor(Date.now()/1000))
        ]);
        if (!Number(results?.[0]?.meta?.changes || 0)) return fail("Memory record not found or transition not applicable.", 404);
      } catch {
        return fail("Owner memory transition failed.", 503);
      }
      return response({ success: true, id, action });
    }
    const category = clean(body.category || "general", 40);
    const content = clean(body.content, 4000);
    if (!category || typeof body.content !== "string" || !content || body.content.length > 4000) return fail("Memory category and content are required and bounded.");
    try {
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE intelligence_owner_memory SET category=?,content=?,updated_at=? WHERE id=? AND owner_uid=? AND archived_at IS NULL")
          .bind(category, content, now, id, owner.uid),
        env.DB.prepare(`
          INSERT INTO intelligence_staging_audit(id,owner_uid,action,target_type,target_id,details_json,created_at)
          SELECT ?,?,?,?,?,?,? WHERE changes() = 1
        `).bind(randomId(), owner.uid, "owner_memory_updated", "memory", id, JSON.stringify({ category }), Math.floor(Date.now()/1000))
      ]);
      if (!Number(results?.[0]?.meta?.changes || 0)) return fail("Memory record not found or archived.", 404);
    } catch {
      return fail("Owner memory update failed.", 503);
    }
    return response({ success: true, id });
  }

  const memoryDeleteMatch = path.match(/^\/intelligence\/memory\/([0-9a-f-]{36})$/i);
  if (memoryDeleteMatch && method === "DELETE") {
    const id = memoryDeleteMatch[1];
    try {
      const results = await env.DB.batch([
        env.DB.prepare("DELETE FROM intelligence_owner_memory WHERE id=? AND owner_uid=?")
          .bind(id, owner.uid),
        env.DB.prepare(`
          INSERT INTO intelligence_staging_audit(id,owner_uid,action,target_type,target_id,details_json,created_at)
          SELECT ?,?,?,?,?,?,? WHERE changes() = 1
        `).bind(randomId(), owner.uid, "owner_memory_deleted", "memory", id, "{}", Math.floor(Date.now()/1000))
      ]);
      if (!Number(results?.[0]?.meta?.changes || 0)) return fail("Memory record not found.", 404);
    } catch {
      return fail("Owner memory deletion failed.", 503);
    }
    return response({ success: true, id, deleted: true });
  }

  if (path === "/intelligence/knowledge/review-queue" && method === "GET") {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    const rows = await env.DB.prepare(`
      WITH relation_edges AS (
        SELECT source_knowledge_id AS knowledge_id, relation_type, status
        FROM intelligence_knowledge_relations WHERE owner_uid = ?
        UNION ALL
        SELECT target_knowledge_id AS knowledge_id, relation_type, status
        FROM intelligence_knowledge_relations WHERE owner_uid = ?
      ),
      relation_stats AS (
        SELECT knowledge_id,
          COUNT(*) AS relation_count,
          SUM(CASE WHEN status = 'candidate' THEN 1 ELSE 0 END) AS candidate_relation_count,
          SUM(CASE WHEN relation_type = 'conflicts_with' AND status IN ('candidate','confirmed') THEN 1 ELSE 0 END) AS unresolved_conflict_count
        FROM relation_edges GROUP BY knowledge_id
      )
      SELECT k.id, k.title, k.source_type, k.source_ref, k.observed_at,
             k.confidence_score, k.verification_status, k.archived_at,
             COALESCE(s.relation_count, 0) AS relation_count,
             COALESCE(s.candidate_relation_count, 0) AS candidate_relation_count,
             COALESCE(s.unresolved_conflict_count, 0) AS unresolved_conflict_count
      FROM intelligence_knowledge k
      LEFT JOIN relation_stats s ON s.knowledge_id = k.id
      WHERE k.owner_uid = ? AND (? = 1 OR k.archived_at IS NULL)
      ORDER BY k.updated_at DESC
      LIMIT 500
    `).bind(owner.uid, owner.uid, owner.uid, includeArchived ? 1 : 0).all();
    const scanned = rows.results || [];
    const items = scanned
      .map(item => buildKnowledgeReviewItem(item))
      .filter(item => item.priority > 0)
      .sort((a, b) => b.priority - a.priority || String(a.observedAt || "").localeCompare(String(b.observedAt || "")))
      .slice(0, limit);
    return response({
      success: true,
      items,
      returnedCount: items.length,
      scannedCount: scanned.length,
      scanLimit: 500,
      includeArchived,
      staleAfterDays: 180,
      ordering: "priority_desc_then_oldest_observation",
      assessment: "deterministic_metadata_only",
      limitations: [
        "Priority is a review aid, not a truth score or factual conclusion.",
        "A source reference does not prove that the source was read or is accurate.",
        "At most 500 most recently updated owner records are scanned per request.",
        "No external source retrieval, semantic fact-checking, or autonomous conflict resolution is performed."
      ]
    });
  }

  if (path === "/intelligence/knowledge" && method === "GET") {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const rawOffset = url.searchParams.get("offset") || "0";
    const offset = Number(rawOffset);
    const state = clean(url.searchParams.get("state") || "active", 16);
    const rawQuery = url.searchParams.get("q") || "";
    if (rawQuery.length > 120) return fail("Knowledge search query must be at most 120 characters.");
    const query = clean(rawQuery, 120);
    if (!["active","archived","all"].includes(state)) return fail("Invalid knowledge state.");
    if (!/^\d+$/.test(rawOffset) || !Number.isSafeInteger(offset) || offset > 10000) {
      return fail("Invalid knowledge page offset.");
    }
    const rows = await env.DB.prepare(`
      SELECT id, category, title, content, importance, created_at, updated_at, archived_at,
             source_type, source_ref, observed_at, confidence_score, verification_status
      FROM intelligence_knowledge
      WHERE owner_uid = ?
        AND (? = 'all' OR (? = 'archived' AND archived_at IS NOT NULL) OR (? = 'active' AND archived_at IS NULL))
        AND (? = '' OR instr(lower(title || ' ' || content || ' ' || category || ' ' || COALESCE(source_ref, '')), lower(?)) > 0)
      ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?
    `).bind(owner.uid, state, state, state, query, query, limit + 1, offset).all();
    const scanned = rows.results || [];
    const items = scanned.slice(0, limit);
    return response({
      success: true, state, items, offset, limit,
      hasMore: scanned.length > limit,
      nextOffset: offset + items.length
    });
  }

  if (path === "/intelligence/knowledge/evaluations" && method === "GET") {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const state = clean(url.searchParams.get("state") || "active", 16);
    if (!["active","archived","all"].includes(state)) return fail("Invalid knowledge state.");
    const rows = await env.DB.prepare(`
      WITH relation_edges AS (
        SELECT source_knowledge_id AS knowledge_id, relation_type, status
        FROM intelligence_knowledge_relations
        WHERE owner_uid = ?
        UNION ALL
        SELECT target_knowledge_id AS knowledge_id, relation_type, status
        FROM intelligence_knowledge_relations
        WHERE owner_uid = ?
      ),
      relation_stats AS (
        SELECT knowledge_id,
          COUNT(*) AS relation_count,
          SUM(CASE WHEN status = 'candidate' THEN 1 ELSE 0 END) AS candidate_relation_count,
          SUM(CASE WHEN relation_type = 'conflicts_with' AND status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_conflict_count,
          SUM(CASE WHEN relation_type = 'conflicts_with' AND status IN ('candidate','confirmed') THEN 1 ELSE 0 END) AS unresolved_conflict_count,
          SUM(CASE WHEN relation_type = 'supports' AND status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_support_count,
          SUM(CASE WHEN relation_type = 'supersedes' AND status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_supersedes_count
        FROM relation_edges
        GROUP BY knowledge_id
      )
      SELECT k.id, k.title, k.source_type, k.observed_at, k.confidence_score,
             k.verification_status, k.archived_at, k.created_at, k.updated_at,
             COALESCE(s.relation_count, 0) AS relation_count,
             COALESCE(s.candidate_relation_count, 0) AS candidate_relation_count,
             COALESCE(s.confirmed_conflict_count, 0) AS confirmed_conflict_count,
             COALESCE(s.unresolved_conflict_count, 0) AS unresolved_conflict_count,
             COALESCE(s.confirmed_support_count, 0) AS confirmed_support_count,
             COALESCE(s.confirmed_supersedes_count, 0) AS confirmed_supersedes_count
      FROM intelligence_knowledge k
      LEFT JOIN relation_stats s ON s.knowledge_id = k.id
      WHERE k.owner_uid = ?
        AND (? = 'all' OR (? = 'archived' AND k.archived_at IS NOT NULL) OR (? = 'active' AND k.archived_at IS NULL))
      ORDER BY k.updated_at DESC
      LIMIT ?
    `).bind(owner.uid, owner.uid, owner.uid, state, state, state, limit).all();
    const items = (rows.results || []).map(item => {
      const disputed = item.verification_status === "disputed";
      const ownerVerified = item.verification_status === "owner_verified";
      const archived = !!item.archived_at;
      const hasUnresolvedConflicts = Number(item.unresolved_conflict_count) > 0;
      let reviewState = "needs_review";
      if (disputed) reviewState = "disputed";
      else if (hasUnresolvedConflicts) reviewState = "conflict_unresolved";
      else if (ownerVerified && !archived) reviewState = "owner_verified";
      else if (archived) reviewState = "archived";
      return {
        id: item.id,
        title: item.title,
        sourceType: item.source_type,
        observedAt: item.observed_at,
        recordedConfidenceScore: item.confidence_score,
        verificationStatus: item.verification_status,
        archivedAt: item.archived_at,
        reviewState,
        signals: {
          archived,
          ownerReviewed: item.verification_status !== "unreviewed",
          disputed,
          ownerVerified,
          hasCandidateRelations: Number(item.candidate_relation_count) > 0,
          hasConfirmedConflicts: Number(item.confirmed_conflict_count) > 0,
          hasUnresolvedConflicts,
          supportsCount: Number(item.confirmed_support_count),
          supersedesCount: Number(item.confirmed_supersedes_count)
        },
        relationCount: Number(item.relation_count),
        assessment: "deterministic_metadata_only"
      };
    });
    return response({
      success: true,
      state,
      items,
      limitations: [
        "A source locator does not prove that a source was read or is accurate.",
        "Recorded confidence scores are not independently validated.",
        "No external source retrieval, semantic fact-checking, or autonomous truth selection is performed."
      ]
    });
  }

  if (path === "/intelligence/knowledge" && method === "POST") {
    const body = await readJson(request);
    if (!body || Object.keys(body).some(key => !["category","title","content","importance","sourceType","sourceRef","observedAt","confidenceScore"].includes(key))) return fail("Invalid knowledge payload.");
    const sourceType = clean(body.sourceType || "owner_input", 32);
    const sourceRef = body.sourceRef === undefined ? "" : body.sourceRef;
    const observedAt = body.observedAt === undefined ? "" : body.observedAt;
    const confidenceScore = body.confidenceScore === undefined ? null : body.confidenceScore;
    let externalUrlValid = sourceType !== "external_url";
    if (sourceType === "external_url") {
      try {
        const parsedSourceUrl = new URL(sourceRef);
        externalUrlValid = parsedSourceUrl.protocol === "https:" && !!parsedSourceUrl.hostname &&
          !parsedSourceUrl.username && !parsedSourceUrl.password;
      } catch { externalUrlValid = false; }
    }
    if (!["owner_input","uploaded_document","external_url","system_observation"].includes(sourceType) ||
        typeof sourceRef !== "string" || sourceRef.length > 1000 ||
        typeof observedAt !== "string" || observedAt.length > 40 ||
        (observedAt && (!observedAt.includes("T") || !Number.isFinite(Date.parse(observedAt)) || !(observedAt.endsWith("Z") || /[+-]/.test(observedAt.slice(19))))) ||
        (confidenceScore !== null && (!Number.isInteger(confidenceScore) || confidenceScore < 0 || confidenceScore > 100)) ||
        !externalUrlValid) return fail("Invalid knowledge provenance.");
    const title = clean(body.title, 160);
    const content = clean(body.content, 12000);
    const category = clean(body.category || "company", 40);
    const importance = clean(body.importance || "normal", 16);
    if (!title || !content || !["high","normal","low"].includes(importance)) return fail("Title, content and valid importance are required.");
    const id = randomId();
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO intelligence_knowledge(id,owner_uid,category,title,content,importance,created_by,source_type,source_ref,observed_at,confidence_score) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
          .bind(id, owner.uid, category, title, content, importance, "pi-owner", sourceType, sourceRef, observedAt, confidenceScore),
        audit(env.DB, owner.uid, "knowledge_created", "knowledge", id, { category, importance, sourceType, confidenceScore })
      ]);
    } catch {
      return fail("Knowledge record could not be saved.", 503);
    }
    return response({ success: true, id }, 201);
  }

  const evaluationMatch = path.match(/^\/intelligence\/knowledge\/([0-9a-f-]{36})\/evaluation$/i);
  if (evaluationMatch && method === "GET") {
    const id = evaluationMatch[1];
    const knowledge = await env.DB.prepare(`
      SELECT id, title, source_type, observed_at, confidence_score,
             verification_status, archived_at, created_at, updated_at
      FROM intelligence_knowledge
      WHERE id = ? AND owner_uid = ?
      LIMIT 1
    `).bind(id, owner.uid).first();
    if (!knowledge) return fail("Knowledge record not found.", 404);
    const relationRows = await env.DB.prepare(`
      SELECT relation_type, status, resolved_knowledge_id
      FROM intelligence_knowledge_relations
      WHERE owner_uid = ?
        AND (source_knowledge_id = ? OR target_knowledge_id = ?)
      ORDER BY updated_at DESC
      LIMIT 100
    `).bind(owner.uid, id, id).all();
    const relations = relationRows.results || [];
    const confirmedConflicts = relations.filter(item =>
      item.relation_type === "conflicts_with" && item.status === "confirmed"
    );
    const unresolvedConflicts = relations.filter(item =>
      item.relation_type === "conflicts_with" &&
      ["candidate", "confirmed"].includes(item.status)
    );
    const signals = {
      archived: !!knowledge.archived_at,
      ownerReviewed: knowledge.verification_status !== "unreviewed",
      disputed: knowledge.verification_status === "disputed",
      ownerVerified: knowledge.verification_status === "owner_verified",
      hasCandidateRelations: relations.some(item => item.status === "candidate"),
      hasConfirmedConflicts: confirmedConflicts.length > 0,
      hasUnresolvedConflicts: unresolvedConflicts.length > 0,
      supportsCount: relations.filter(item => item.relation_type === "supports" && item.status === "confirmed").length,
      supersedesCount: relations.filter(item => item.relation_type === "supersedes" && item.status === "confirmed").length
    };
    let reviewState = "needs_review";
    if (signals.disputed) reviewState = "disputed";
    else if (signals.hasUnresolvedConflicts) reviewState = "conflict_unresolved";
    else if (signals.ownerVerified && !signals.archived) reviewState = "owner_verified";
    else if (signals.archived) reviewState = "archived";
    return response({
      success: true,
      evaluation: {
        knowledge: {
          id: knowledge.id,
          title: knowledge.title,
          sourceType: knowledge.source_type,
          observedAt: knowledge.observed_at,
          recordedConfidenceScore: knowledge.confidence_score,
          verificationStatus: knowledge.verification_status,
          archivedAt: knowledge.archived_at
        },
        reviewState,
        signals,
        relationCount: relations.length,
        assessment: "deterministic_metadata_only",
        limitations: [
          "A source locator does not prove that a source was read or is accurate.",
          "The recorded confidence score is not independently validated.",
          "No external source retrieval, semantic fact-checking, or autonomous truth selection is performed."
        ]
      }
    });
  }

  const knowledgeMatch = path.match(/^\/intelligence\/knowledge\/([0-9a-f-]{36})$/i);
  if (knowledgeMatch && method === "PUT") {
    const id = knowledgeMatch[1];
    const body = await readJson(request);
    if (!body || Object.keys(body).some(key => !["action","category","title","content","importance"].includes(key))) return fail("Invalid knowledge payload.");
    const action = body.action || "update";
    if (!["update","archive","restore","verify","dispute","unverify"].includes(action)) return fail("Invalid knowledge action.");
    let statement, auditAction, details = {};
    if (["verify","dispute","unverify"].includes(action)) {
      if (Object.keys(body).some(key => key !== "action")) return fail("Verification review accepts only an action.");
      const nextStatus = ({ verify: "owner_verified", dispute: "disputed", unverify: "unreviewed" })[action];
      statement = env.DB.prepare("UPDATE intelligence_knowledge SET verification_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_uid=? AND archived_at IS NULL AND verification_status<>?")
        .bind(nextStatus, id, owner.uid, nextStatus);
      auditAction = ({ verify: "knowledge_owner_verified", dispute: "knowledge_disputed", unverify: "knowledge_verification_reset" })[action];
      details = { verificationStatus: nextStatus };
    } else if (action === "archive") {
      if (Object.keys(body).some(key => key !== "action")) return fail("Archive accepts only an action.");
      statement = env.DB.prepare("UPDATE intelligence_knowledge SET archived_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_uid=? AND archived_at IS NULL").bind(id, owner.uid);
      auditAction = "knowledge_archived";
    } else if (action === "restore") {
      if (Object.keys(body).some(key => key !== "action")) return fail("Restore accepts only an action.");
      statement = env.DB.prepare("UPDATE intelligence_knowledge SET archived_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_uid=? AND archived_at IS NOT NULL").bind(id, owner.uid);
      auditAction = "knowledge_restored";
    } else {
      if (body.content !== undefined && (typeof body.content !== "string" || body.content.length > 12000)) return fail("Knowledge content must be a string of at most 12000 characters.");
      const existing = await env.DB.prepare("SELECT id,content,archived_at FROM intelligence_knowledge WHERE id=? AND owner_uid=?").bind(id, owner.uid).first();
      if (!existing || existing.archived_at) return fail("Active knowledge record not found.", 404);
      if (body.content !== undefined && body.content !== existing.content) {
        const linked = await env.DB.prepare("SELECT 1 AS found FROM intelligence_knowledge_relations WHERE owner_uid=? AND (source_knowledge_id=? OR target_knowledge_id=?) LIMIT 1").bind(owner.uid, id, id).first();
        if (linked) return fail("Content is evidence-linked. Create a corrected record and relate it instead.", 409);
      }
      const title = body.title === undefined ? null : clean(body.title, 160);
      const category = body.category === undefined ? null : clean(body.category, 40);
      const content = body.content === undefined ? null : clean(body.content, 12000);
      const importance = body.importance === undefined ? null : clean(body.importance, 16);
      if ((body.title !== undefined && !title) || (body.category !== undefined && !category) || (body.content !== undefined && !content) || (body.importance !== undefined && !["high","normal","low"].includes(importance))) return fail("Invalid knowledge fields.");
      if (![body.title,body.category,body.content,body.importance].some(value => value !== undefined)) return fail("At least one knowledge field is required.");
      statement = env.DB.prepare("UPDATE intelligence_knowledge SET title=COALESCE(?,title),category=COALESCE(?,category),content=COALESCE(?,content),importance=COALESCE(?,importance),updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_uid=? AND archived_at IS NULL").bind(title, category, content, importance, id, owner.uid);
      auditAction = "knowledge_updated";
      details = { fields: ["title","category","content","importance"].filter(key => body[key] !== undefined) };
    }
    try {
      const results = await env.DB.batch([statement, env.DB.prepare("INSERT INTO intelligence_staging_audit(id,owner_uid,action,target_type,target_id,details_json,created_at) SELECT ?,?,?,?,?,?,? WHERE changes() = 1").bind(randomId(), owner.uid, auditAction, "knowledge", id, JSON.stringify(details), Math.floor(Date.now()/1000))]);
      if (!Number(results?.[0]?.meta?.changes || 0)) return fail("Knowledge record not found or already in requested state.", 404);
    } catch { return fail("Knowledge mutation failed.", 503); }
    return response({ success: true, id, action, updated: action === "update", archived: action === "archive", restored: action === "restore" });
  }
  if (path === "/intelligence/knowledge/relations" && method === "GET") {
    const status = clean(url.searchParams.get("status"), 20);
    if (status && !["candidate","confirmed","dismissed","resolved"].includes(status)) return fail("Invalid relationship status.");
    const rows = await env.DB.prepare(`
      SELECT id, source_knowledge_id, target_knowledge_id, relation_type, status,
             source_evidence, target_evidence, resolved_knowledge_id, created_at, updated_at
      FROM intelligence_knowledge_relations
      WHERE owner_uid = ? AND (? = '' OR status = ?)
      ORDER BY updated_at DESC LIMIT 100
    `).bind(owner.uid, status, status).all();
    return response({ success: true, items: rows.results || [] });
  }

  if (path === "/intelligence/knowledge/relations" && method === "POST") {
    const body = await readJson(request);
    if (!body || Object.keys(body).some(key => !["sourceId","targetId","relationType","sourceEvidence","targetEvidence"].includes(key))) return fail("Invalid relationship payload.");
    let sourceId = body.sourceId, targetId = body.targetId;
    let sourceEvidence = clean(body.sourceEvidence, 500), targetEvidence = clean(body.targetEvidence, 500);
    const relationType = clean(body.relationType, 32);
    if (!uuid(sourceId) || !uuid(targetId) || sourceId === targetId ||
        !["conflicts_with","supersedes","supports"].includes(relationType) ||
        !sourceEvidence || !targetEvidence ||
        typeof body.sourceEvidence !== "string" || typeof body.targetEvidence !== "string" ||
        body.sourceEvidence.length > 500 || body.targetEvidence.length > 500) return fail("Invalid relationship evidence or IDs.");
    const found = await env.DB.prepare("SELECT id, content, archived_at FROM intelligence_knowledge WHERE id IN (?,?) AND owner_uid=?")
      .bind(sourceId, targetId, owner.uid).all();
    const map = new Map((found.results || []).map(row => [row.id, row]));
    const source = map.get(sourceId), target = map.get(targetId);
    if (!source || !target || source.archived_at || target.archived_at ||
        !source.content.includes(sourceEvidence) || !target.content.includes(targetEvidence)) return fail("Both records and exact evidence must belong to the owner.", 404);
    if (relationType === "conflicts_with" && sourceId > targetId) {
      [sourceId, targetId] = [targetId, sourceId];
      [sourceEvidence, targetEvidence] = [targetEvidence, sourceEvidence];
    }
    const id = randomId();
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO intelligence_knowledge_relations(id,owner_uid,source_knowledge_id,target_knowledge_id,relation_type,status,source_evidence,target_evidence) VALUES(?,?,?,?,?,'candidate',?,?)")
          .bind(id, owner.uid, sourceId, targetId, relationType, sourceEvidence, targetEvidence),
        audit(env.DB, owner.uid, "knowledge_relation_proposed", "knowledge_relation", id, { relationType })
      ]);
    } catch {
      return fail("Relationship rejected by ownership or uniqueness constraints.", 409);
    }
    return response({ success: true, id, status: "candidate" }, 201);
  }

  const relationMatch = path.match(/^\/intelligence\/knowledge\/relations\/([0-9a-f-]{36})$/i);
  if (relationMatch && method === "PUT") {
    const id = relationMatch[1];
    const body = await readJson(request);
    if (!body || Object.keys(body).some(key => !["action","resolvedKnowledgeId"].includes(key)) ||
        !["confirm","dismiss","resolve"].includes(body.action)) return fail("Invalid relationship action.");
    const existing = await env.DB.prepare("SELECT id,relation_type,status,source_knowledge_id,target_knowledge_id FROM intelligence_knowledge_relations WHERE id=? AND owner_uid=?")
      .bind(id, owner.uid).first();
    if (!existing) return fail("Relationship not found.", 404);
    let statement, status;
    if (body.action === "confirm" && existing.status === "candidate") {
      status = "confirmed";
      statement = env.DB.prepare("UPDATE intelligence_knowledge_relations SET status='confirmed',confirmed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_uid=? AND status='candidate'").bind(id, owner.uid);
    } else if (body.action === "dismiss" && existing.status === "candidate") {
      status = "dismissed";
      statement = env.DB.prepare("UPDATE intelligence_knowledge_relations SET status='dismissed',dismissed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_uid=? AND status='candidate'").bind(id, owner.uid);
    } else if (body.action === "resolve" && existing.status === "confirmed" && existing.relation_type === "conflicts_with" &&
               [existing.source_knowledge_id, existing.target_knowledge_id].includes(body.resolvedKnowledgeId)) {
      status = "resolved";
      statement = env.DB.prepare("UPDATE intelligence_knowledge_relations SET status='resolved',resolved_knowledge_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_uid=? AND status='confirmed' AND relation_type='conflicts_with'")
        .bind(body.resolvedKnowledgeId, id, owner.uid);
    } else {
      return fail("Relationship transition is not allowed.", 409);
    }
    try {
      const results = await env.DB.batch([
        statement,
        env.DB.prepare(`
          INSERT INTO intelligence_staging_audit(id,owner_uid,action,target_type,target_id,details_json,created_at)
          SELECT ?,?,?,?,?,?,? WHERE changes() = 1
        `).bind(randomId(), owner.uid, ({ confirm: "knowledge_relation_confirmed", dismiss: "knowledge_relation_dismissed", resolve: "knowledge_relation_resolved" })[body.action], "knowledge_relation", id, JSON.stringify({ status }), Math.floor(Date.now()/1000))
      ]);
      if (!Number(results?.[0]?.meta?.changes || 0)) return fail("Relationship state changed; reload and retry.", 409);
    } catch {
      return fail("Relationship update failed.", 503);
    }
    return response({ success: true, id, status });
  }

  if (path === "/intelligence/approvals" && method === "GET") {
    const now = Math.floor(Date.now() / 1000);
    const rows = await env.DB.prepare(`
      SELECT id,task_id,repository,branch,base_sha,scope_json,scope_sha256,
             CASE WHEN status='issued' AND expires_at<=? THEN 'expired' ELSE status END AS status,
             issued_at,expires_at,revoked_at,consumed_at,consumed_by
      FROM intelligence_approval_ledger WHERE owner_uid=?
      ORDER BY issued_at DESC LIMIT 100
    `).bind(now, owner.uid).all();
    return response({ success: true, items: rows.results || [] });
  }

  if (path === "/intelligence/approvals" && method === "POST") {
    const body = await readJson(request);
    const validatedScope = validateApprovalScope(body?.scope);
    if (!body || Object.keys(body).some(key => !["taskId","repository","branch","baseSha","scope","expiresInSeconds"].includes(key)) ||
        !uuid(body.taskId) || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(body.repository) ||
        !/^[A-Za-z0-9._/-]{1,200}$/.test(body.branch) || !/^[0-9a-f]{40}$/i.test(body.baseSha) ||
        !validatedScope) return fail("Invalid approval scope. Use 1-20 unique, explicit relative paths without wildcards or traversal.");
    const task = await env.DB.prepare("SELECT id FROM intelligence_tasks WHERE id=? AND created_by=?").bind(body.taskId, owner.uid).first();
    if (!task) return fail("Task not found for this owner.", 404);
    const approvalLifetime = parseApprovalLifetime(body.expiresInSeconds);
    if (!approvalLifetime.valid) {
      return fail("Approval expiry must be an integer number of seconds between 60 and 3600.");
    }
    const expiresIn = approvalLifetime.seconds;
    const now = Math.floor(Date.now()/1000);
    const scopeJson = JSON.stringify(validatedScope);
    const scopeHash = await digest(scopeJson);
    const id = randomId();
    if (scopeJson.length > 4096 || Object.keys(body.scope).length === 0) return fail("Approval scope must be a non-empty object within 4 KB.");
    try {
      await env.DB.batch([
        env.DB.prepare("UPDATE intelligence_approval_ledger SET status='expired' WHERE task_id=? AND owner_uid=? AND status='issued' AND expires_at<=?")
          .bind(body.taskId, owner.uid, now),
        env.DB.prepare(`
          INSERT INTO intelligence_staging_audit(id,owner_uid,action,target_type,target_id,details_json,created_at)
          SELECT ?,?,?,?,?,?,? WHERE changes() > 0
        `).bind(randomId(), owner.uid, "approval_expiry_sweep", "task", body.taskId, JSON.stringify({ reason: "new_approval_requested" }), now),
        env.DB.prepare("INSERT INTO intelligence_approval_ledger(id,task_id,owner_uid,owner_username,repository,branch,base_sha,scope_json,scope_sha256,status,issued_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,'issued',?,?)")
          .bind(id, body.taskId, owner.uid, "mehranmsh", body.repository, body.branch, body.baseSha, scopeJson, scopeHash, now, now + expiresIn),
        audit(env.DB, owner.uid, "approval_issued", "approval", id, { taskId: body.taskId, repository: body.repository, branch: body.branch, scopeHash })
      ]);
    } catch {
      return fail("Approval could not be issued. Check task ownership and active approvals.", 409);
    }
    return response({ success: true, id, status: "issued", expiresAt: now + expiresIn }, 201);
  }

  const approvalMatch = path.match(/^\/intelligence\/approvals\/([0-9a-f-]{36})$/i);
  if (approvalMatch && method === "DELETE") {
    const id = approvalMatch[1];
    const now = Math.floor(Date.now()/1000);
    let result;
    try {
      result = await env.DB.batch([
        env.DB.prepare("UPDATE intelligence_approval_ledger SET status='revoked',revoked_at=? WHERE id=? AND owner_uid=? AND status='issued' AND expires_at>?")
          .bind(now, id, owner.uid, now),
        env.DB.prepare("INSERT INTO intelligence_staging_audit(id,owner_uid,action,target_type,target_id,details_json,created_at) SELECT ?,?,?,?,?,?,? WHERE changes() = 1")
          .bind(randomId(), owner.uid, "approval_revoked", "approval", id, "{}", now)
      ]);
    } catch {
      return fail("Approval revocation could not be committed with its audit record.", 503);
    }
    if (!Number(result?.[0]?.meta?.changes || 0)) return fail("Approval not found or no longer revocable.", 409);
    return response({ success: true, id, status: "revoked" });
  }

  return fail("Route not found.", 404);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch {
      return fail("Staging request failed safely.", 503);
    }
  }
};
