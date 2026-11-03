
const ALLOWED_ORIGIN = "https://mehranmsh.github.io";
const PI_ME_URL = "https://api.minepi.com/v2/me";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
      "Cache-Control": "no-store"
    }
  });
}

function normalizeStatus(status) {
  const value = String(status || "Planned").trim().toLowerCase();

  if (value === "active") return "Active";
  if (value === "planned") return "Planned";
  if (value === "paused") return "Paused";

  return null;
}

function cleanProject(data) {
  if (!data || typeof data !== "object") return null;

  const name = String(data.name || "").trim();
  const description = String(data.description || "");
  const faDescription = String(
    data.faDescription || data.fa_description || ""
  );
  const url = String(data.url || "").trim();
  const status = normalizeStatus(data.status);

  if (!name || name.length > 100) return null;
  if (description.length > 3000) return null;
  if (faDescription.length > 3000) return null;
  if (url.length > 500 || !status) return null;

  if (url) {
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return null;
      }
    } catch {
      return null;
    }
  }

  return {
    id: String(data.id || crypto.randomUUID()).slice(0, 100),
    name,
    description,
    faDescription,
    url,
    status
  };
}

async function verifyAdmin(accessToken) {
  if (
    typeof accessToken !== "string" ||
    accessToken.length < 10 ||
    accessToken.length > 4096
  ) {
    return null;
  }

  const response = await fetch(PI_ME_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) return null;

  const user = await response.json();

  if (
    typeof user.uid !== "string" ||
    typeof user.username !== "string"
  ) {
    return null;
  }

  if (user.username.trim().toLowerCase() !== "mehranmsh") {
    return null;
  }

  return user;
}

function formatProject(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    faDescription: row.fa_description || "",
    url: row.url || "",
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    if (origin && origin !== ALLOWED_ORIGIN) {
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
          "Access-Control-Allow-Methods":
            "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Vary": "Origin"
        }
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // HEALTH CHECK
      if (path === "/health" && request.method === "GET") {
        return json({
          status: "online",
          service: "MEHRAN MSH AUTH",
          version: "2.0",
          database: Boolean(env.DB)
        });
      }

      // PI AUTHENTICATION
      if (path === "/auth" && request.method === "POST") {
        const body = await request.json();
        const accessToken = body?.accessToken;

        if (
          typeof accessToken !== "string" ||
          accessToken.length < 10 ||
          accessToken.length > 4096
        ) {
          return json({
            success: false,
            error: "Invalid access token"
          }, 400);
        }

        const piResponse = await fetch(PI_ME_URL, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json"
          }
        });

        if (!piResponse.ok) {
          return json({
            success: false,
            error: "Pi authentication failed"
          }, 401);
        }

        const user = await piResponse.json();

        if (
          typeof user.uid !== "string" ||
          typeof user.username !== "string"
        ) {
          return json({
            success: false,
            error: "Invalid Pi user data"
          }, 401);
        }

        const isAdmin =
          user.username.trim().toLowerCase() === "mehranmsh";

        return json({
          success: true,
          uid: user.uid,
          username: user.username,
          isAdmin
        });
      }

      // DATABASE CHECK
      if (path.startsWith("/projects")) {
        if (!env.DB) {
          return json({
            success: false,
            error: "Database binding is missing"
          }, 503);
        }
      }

      // GET ALL PROJECTS
      if (path === "/projects" && request.method === "GET") {
        const result = await env.DB.prepare(
          `SELECT id, name, description, fa_description,
           url, status, created_at, updated_at
           FROM projects
           ORDER BY created_at DESC`
        ).all();

        const projects = (result.results || []).map(formatProject);

        return json({
          success: true,
          projects
        });
      }

      // READ REQUEST BODY FOR WRITE OPERATIONS
      if (
        path === "/projects" &&
        request.method === "POST"
      ) {
        const body = await request.json();

        const user = await verifyAdmin(body?.accessToken);

        if (!user) {
          return json({
            success: false,
            error: "Admin authentication required"
          }, 403);
        }

        const project = cleanProject(body.project || body);

        if (!project) {
          return json({
            success: false,
            error: "Invalid project data"
          }, 400);
        }

        await env.DB.prepare(
          `INSERT INTO projects
           (id, name, description, fa_description, url, status)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             description = excluded.description,
             fa_description = excluded.fa_description,
             url = excluded.url,
             status = excluded.status,
             updated_at = CURRENT_TIMESTAMP`
        ).bind(
          project.id,
          project.name,
          project.description,
          project.faDescription,
          project.url,
          project.status
        ).run();

        const saved = await env.DB.prepare(
          `SELECT * FROM projects WHERE id = ?`
        ).bind(project.id).first();

        return json({
          success: true,
          project: formatProject(saved)
        }, 201);
      }

      // UPDATE PROJECT
      const updateMatch = path.match(/^\/projects\/([^/]+)$/);

      if (updateMatch && request.method === "PUT") {
        const id = decodeURIComponent(updateMatch[1]);
        const body = await request.json();

        const user = await verifyAdmin(body?.accessToken);

        if (!user) {
          return json({
            success: false,
            error: "Admin authentication required"
          }, 403);
        }

        const project = cleanProject({
          ...body.project,
          id
        });

        if (!project) {
          return json({
            success: false,
            error: "Invalid project data"
          }, 400);
        }

        const result = await env.DB.prepare(
          `UPDATE projects SET
             name = ?,
             description = ?,
             fa_description = ?,
             url = ?,
             status = ?,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).bind(
          project.name,
          project.description,
          project.faDescription,
          project.url,
          project.status,
          id
        ).run();

        if (!result.meta || result.meta.changes === 0) {
          return json({
            success: false,
            error: "Project not found"
          }, 404);
        }

        const saved = await env.DB.prepare(
          `SELECT * FROM projects WHERE id = ?`
        ).bind(id).first();

        return json({
          success: true,
          project: formatProject(saved)
        });
      }

      // DELETE PROJECT
      if (updateMatch && request.method === "DELETE") {
        const id = decodeURIComponent(updateMatch[1]);
        const body = await request.json();

        const user = await verifyAdmin(body?.accessToken);

        if (!user) {
          return json({
            success: false,
            error: "Admin authentication required"
          }, 403);
        }

        const result = await env.DB.prepare(
          `DELETE FROM projects WHERE id = ?`
        ).bind(id).run();

        if (!result.meta || result.meta.changes === 0) {
          return json({
            success: false,
            error: "Project not found"
          }, 404);
        }

        return json({
          success: true,
          deleted: true,
          id
        });
      }

      return json({
        success: false,
        error: "Not found"
      }, 404);

    } catch (error) {
      console.error("MEHRAN MSH Worker error:", error);

      return json({
        success: false,
        error: "Internal service error"
      }, 500);
    }
  }
};
