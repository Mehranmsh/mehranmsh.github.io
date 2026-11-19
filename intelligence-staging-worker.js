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
  if (!type.toLowerCase().includes("application/json")) return null;
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

async function fetchPiUser(accessToken) {
  if (typeof accessToken !== "string" || accessToken.length < 10 || accessToken.length > 4096) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const result = await fetch(PI_ME_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: controller.signal
    });
    if (!result.ok) return null;
    const user = await result.json();
    if (typeof user?.uid !== "string" || !user.uid || typeof user?.username !== "string" || !user.username) return null;
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
  if (!expected || !row || row.owner_uid !== expected ||
      !Number.isFinite(Number(row.created_at)) ||
      Number(row.created_at) < now - SESSION_SECONDS ||
      Number(row.expires_at) > Number(row.created_at) + SESSION_SECONDS) return null;
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
        "intelligence_owner_memory"
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
    if (!body || Object.keys(body).some(key => key !== "accessToken")) return fail("A Pi access token is required.");
    const ownerUid = clean(env.MEHRAN_INTELLIGENCE_STAGING_OWNER_UID, 200);
    if (!ownerUid) return fail("Staging owner identity is not configured.", 503);
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!await rateLimit(env.DB, `ip:${clientIp}`, "session-auth")) return fail("Authentication rate limit exceeded.", 429);
    const piUser = await fetchPiUser(body.accessToken);
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
          SELECT ?,?,?,?,?,?,? WHERE EXISTS (
            SELECT 1 FROM intelligence_staging_sessions
            WHERE id=? AND owner_uid=? AND revoked_at=?
          )
        `).bind(randomId(), owner.uid, "session_revoked", "session", row.id, "{}", revokedAt, row.id, owner.uid, revokedAt)
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
    const rows = await env.DB.prepare(`
      SELECT id, category, content, created_at, updated_at
      FROM intelligence_owner_memory
      WHERE owner_uid = ?
      ORDER BY updated_at DESC LIMIT 100
    `).bind(owner.uid).all();
    return response({ success: true, items: rows.results || [] });
  }

  if (path === "/intelligence/memory" && method === "POST") {
    const body = await readJson(request);
    if (!body || Object.keys(body).some(key => !["category","content"].includes(key))) return fail("Invalid memory payload.");
    const category = clean(body.category || "general", 40);
    const content = clean(body.content, 4000);
    if (!category || !content || body.content.length > 4000) return fail("Memory category and content are required and bounded.");
    const id = randomId();
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO intelligence_owner_memory(id,owner_uid,category,content) VALUES(?,?,?,?)")
          .bind(id, owner.uid, category, content),
        audit(env.DB, owner.uid, "owner_memory_created", "memory", id, { category })
      ]);
    } catch {
      return fail("Owner memory could not be saved.", 503);
    }
    return response({ success: true, id }, 201);
  }

  const memoryMatch = path.match(/^\/intelligence\/memory\/([0-9a-f-]{36})$/i);
  if (memoryMatch && method === "PUT") {
    const id = memoryMatch[1];
    const body = await readJson(request);
    if (!body || Object.keys(body).some(key => !["category","content"].includes(key))) return fail("Invalid memory update.");
    const category = clean(body.category || "general", 40);
    const content = clean(body.content, 4000);
    if (!category || !content || body.content.length > 4000) return fail("Memory category and content are required and bounded.");
    const updatedAt = new Date().toISOString();
    try {
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE intelligence_owner_memory SET category=?,content=?,updated_at=? WHERE id=? AND owner_uid=?")
          .bind(category, content, updatedAt, id, owner.uid),
        env.DB.prepare(`
          INSERT INTO intelligence_staging_audit(id,owner_uid,action,target_type,target_id,details_json,created_at)
          SELECT ?,?,?,?,?,?,? WHERE EXISTS (
            SELECT 1 FROM intelligence_owner_memory WHERE id=? AND owner_uid=? AND updated_at=?
          )
        `).bind(randomId(), owner.uid, "owner_memory_updated", "memory", id, JSON.stringify({ category }), Math.floor(Date.now()/1000), id, owner.uid, updatedAt)
      ]);
      if (!Number(results?.[0]?.meta?.changes || 0)) return fail("Memory record not found.", 404);
    } catch {
      return fail("Owner memory update failed.", 503);
    }
    return response({ success: true, id });
  }

  if (path === "/intelligence/knowledge" && method === "GET") {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const rows = await env.DB.prepare(`
      SELECT id, category, title, content, importance, created_at, updated_at
      FROM intelligence_knowledge
      WHERE owner_uid = ? AND archived_at IS NULL
      ORDER BY updated_at DESC LIMIT ?
    `).bind(owner.uid, limit).all();
    return response({ success: true, items: rows.results || [] });
  }

  if (path === "/intelligence/knowledge" && method === "POST") {
    const body = await readJson(request);
    if (!body || Object.keys(body).some(key => !["category","title","content","importance"].includes(key))) return fail("Invalid knowledge payload.");
    const title = clean(body.title, 160);
    const content = clean(body.content, 12000);
    const category = clean(body.category || "company", 40);
    const importance = clean(body.importance || "normal", 16);
    if (!title || !content || !["high","normal","low"].includes(importance)) return fail("Title, content and valid importance are required.");
    const id = randomId();
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO intelligence_knowledge(id,owner_uid,category,title,content,importance,created_by) VALUES(?,?,?,?,?,?,?)")
          .bind(id, owner.uid, category, title, content, importance, "pi-owner"),
        audit(env.DB, owner.uid, "knowledge_created", "knowledge", id, { category, importance })
      ]);
    } catch {
      return fail("Knowledge record could not be saved.", 503);
    }
    return response({ success: true, id }, 201);
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
          SELECT ?,?,?,?,?,?,? WHERE EXISTS (
            SELECT 1 FROM intelligence_knowledge_relations WHERE id=? AND owner_uid=? AND status=?
          )
        `).bind(randomId(), owner.uid, ({ confirm: "knowledge_relation_confirmed", dismiss: "knowledge_relation_dismissed", resolve: "knowledge_relation_resolved" })[body.action], "knowledge_relation", id, JSON.stringify({ status }), Math.floor(Date.now()/1000), id, owner.uid, status)
      ]);
      if (!Number(results?.[0]?.meta?.changes || 0)) return fail("Relationship state changed; reload and retry.", 409);
    } catch {
      return fail("Relationship update failed.", 503);
    }
    return response({ success: true, id, status });
  }

  if (path === "/intelligence/approvals" && method === "GET") {
    const rows = await env.DB.prepare(`
      SELECT id,task_id,repository,branch,base_sha,scope_json,scope_sha256,status,
             issued_at,expires_at,revoked_at,consumed_at,consumed_by
      FROM intelligence_approval_ledger WHERE owner_uid=?
      ORDER BY issued_at DESC LIMIT 100
    `).bind(owner.uid).all();
    return response({ success: true, items: rows.results || [] });
  }

  if (path === "/intelligence/approvals" && method === "POST") {
    const body = await readJson(request);
    if (!body || Object.keys(body).some(key => !["taskId","repository","branch","baseSha","scope","expiresInSeconds"].includes(key)) ||
        !uuid(body.taskId) || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(body.repository) ||
        !/^[A-Za-z0-9._/-]{1,200}$/.test(body.branch) || !/^[0-9a-f]{40}$/i.test(body.baseSha) ||
        !body.scope || typeof body.scope !== "object" || Array.isArray(body.scope)) return fail("Invalid approval scope.");
    const task = await env.DB.prepare("SELECT id FROM intelligence_tasks WHERE id=? AND created_by=?").bind(body.taskId, owner.uid).first();
    if (!task) return fail("Task not found for this owner.", 404);
    const expiresIn = Math.min(3600, Math.max(60, Number(body.expiresInSeconds) || 600));
    const now = Math.floor(Date.now()/1000);
    const scopeJson = JSON.stringify(body.scope);
    const scopeHash = await digest(scopeJson);
    const id = randomId();
    try {
      await env.DB.batch([
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
    const result = await env.DB.batch([
      env.DB.prepare("UPDATE intelligence_approval_ledger SET status='revoked',revoked_at=? WHERE id=? AND owner_uid=? AND status='issued' AND expires_at>?")
        .bind(now, id, owner.uid, now),
      env.DB.prepare("INSERT INTO intelligence_staging_audit(id,owner_uid,action,target_type,target_id,details_json,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM intelligence_approval_ledger WHERE id=? AND owner_uid=? AND status='revoked' AND revoked_at=?)")
        .bind(randomId(), owner.uid, "approval_revoked", "approval", id, "{}", now, id, owner.uid, now)
    ]);
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
