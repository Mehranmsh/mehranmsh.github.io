const ALLOWED_ORIGIN = "https://mehranmsh.github.io";
const PI_ME_URL = "https://api.minepi.com/v2/me";

const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100000;

// -------------------------
// RESPONSE
// -------------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods":
        "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization",
      "Vary": "Origin",
      "Cache-Control": "no-store"
    }
  });
}

function error(message, status = 400) {
  return json({
    success: false,
    error: message
  }, status);
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// -------------------------
// GENERAL HELPERS
// -------------------------

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

function cleanUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function validUsername(value) {
  return /^[a-z0-9_]{3,24}$/.test(value);
}

function validEmail(value) {
  if (value.length > 254) return false;

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// -------------------------
// CRYPTO HELPERS
// -------------------------

function toBase64Url(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const padded = base64 + "=".repeat(
    (4 - base64.length % 4) % 4
  );

  const binary = atob(padded);

  return Uint8Array.from(
    binary,
    character => character.charCodeAt(0)
  );
}

async function sha256(value) {
  const data = new TextEncoder().encode(value);

  const digest = await crypto.subtle.digest(
    "SHA-256",
    data
  );

  return toBase64Url(new Uint8Array(digest));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(
    new Uint8Array(16)
  );

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    key,
    256
  );

  return [
    "pbkdf2",
    PBKDF2_ITERATIONS,
    toBase64Url(salt),
    toBase64Url(new Uint8Array(bits))
  ].join("$");
}

async function verifyPassword(password, storedHash) {
  try {
    const parts = storedHash.split("$");

    if (parts.length !== 4) return false;
    if (parts[0] !== "pbkdf2") return false;

    const iterations = Number(parts[1]);

    if (
      !Number.isInteger(iterations) ||
      iterations < 100000 ||
      iterations > 100000
    ) {
      return false;
    }

    const salt = fromBase64Url(parts[2]);
    const expected = fromBase64Url(parts[3]);

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt,
        iterations,
        hash: "SHA-256"
      },
      key,
      256
    );

    const actual = new Uint8Array(bits);

    if (actual.length !== expected.length) return false;

    let difference = 0;

    for (let i = 0; i < actual.length; i++) {
      difference |= actual[i] ^ expected[i];
    }

    return difference === 0;

  } catch {
    return false;
  }
}

function createSessionToken() {
  return toBase64Url(
    crypto.getRandomValues(new Uint8Array(32))
  );
}

// -------------------------
// PI ADMIN AUTHENTICATION
// -------------------------

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

  if (
    user.username.trim().toLowerCase() !== "mehranmsh"
  ) {
    return null;
  }

  return user;
}

// -------------------------
// SOCIAL SESSION HELPERS
// -------------------------

async function createSocialSession(env, userId) {
  const token = createSessionToken();
  const tokenHash = await sha256(token);

  const expiresAt = new Date(
    Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const sessionId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO social_sessions
     (id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?)`
  ).bind(
    sessionId,
    userId,
    tokenHash,
    expiresAt
  ).run();

  return {
    token,
    expiresAt
  };
}

async function getSocialUser(request, env) {
  const authorization = request.headers.get("Authorization");

  if (!authorization) return null;

  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) return null;

  const token = match[1].trim();

  if (token.length < 20 || token.length > 200) {
    return null;
  }

  const tokenHash = await sha256(token);

  const result = await env.DB.prepare(
    `SELECT
       u.id,
       u.username,
       u.email,
       u.display_name,
       u.bio,
       u.avatar_url,
       u.pi_username,
       u.pi_verified,
       u.email_verified,
       u.created_at,
       s.id AS session_id,
       s.expires_at
     FROM social_sessions s
     JOIN social_users u ON u.id = s.user_id
     WHERE s.token_hash = ?
       AND s.expires_at > ?
       AND u.is_active = 1
     LIMIT 1`
  ).bind(
    tokenHash,
    new Date().toISOString()
  ).first();

  if (!result) return null;

  return {
    id: result.id,
    username: result.username,
    email: result.email,
    displayName: result.display_name || "",
    bio: result.bio || "",
    avatarUrl: result.avatar_url || "",
    piUsername: result.pi_username || "",
    piVerified: Boolean(result.pi_verified),
    emailVerified: Boolean(result.email_verified),
    createdAt: result.created_at,
    sessionId: result.session_id
  };
}

// -------------------------
// SOCIAL REGISTER
// -------------------------

async function socialRegister(request, env) {
  const body = await readBody(request);

  if (!body) {
    return error("Invalid request body", 400);
  }

  const username = cleanUsername(body.username);
  const email = cleanEmail(body.email);
  const password = String(body.password || "");
  const displayName = String(
    body.displayName || username
  ).trim();

  if (!validUsername(username)) {
    return error(
      "Username must contain 3 to 24 letters, numbers or underscores",
      400
    );
  }

  if (!validEmail(email)) {
    return error("Invalid email address", 400);
  }

  if (password.length < 10 || password.length > 128) {
    return error(
      "Password must be between 10 and 128 characters",
      400
    );
  }

  if (displayName.length > 60) {
    return error("Display name is too long", 400);
  }

  const existing = await env.DB.prepare(
    `SELECT id
     FROM social_users
     WHERE username = ? OR email = ?
     LIMIT 1`
  ).bind(username, email).first();

  if (existing) {
    return error(
      "Username or email is already registered",
      409
    );
  }

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);

  try {
    await env.DB.prepare(
      `INSERT INTO social_users
       (
         id,
         username,
         email,
         password_hash,
         display_name
       )
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      userId,
      username,
      email,
      passwordHash,
      displayName
    ).run();

    await env.DB.prepare(
      `INSERT INTO social_user_settings (user_id)
       VALUES (?)`
    ).bind(userId).run();

    const session = await createSocialSession(
      env,
      userId
    );

    return json({
      success: true,
      message: "Account created successfully",
      token: session.token,
      expiresAt: session.expiresAt,
      user: {
        id: userId,
        username,
        email,
        displayName,
        emailVerified: false
      }
    }, 201);

  } catch (err) {
    console.error("SOCIAL registration error:", err);

    if (
      String(err.message || "").toLowerCase().includes("unique")
    ) {
      return error(
        "Username or email is already registered",
        409
      );
    }

    throw err;
  }
}

// -------------------------
// SOCIAL LOGIN
// -------------------------

async function socialLogin(request, env) {
  const body = await readBody(request);

  if (!body) {
    return error("Invalid request body", 400);
  }

  const identifier = String(
    body.identifier || body.email || body.username || ""
  ).trim().toLowerCase();

  const password = String(body.password || "");

  if (
    !identifier ||
    identifier.length > 254 ||
    !password ||
    password.length > 128
  ) {
    return error("Invalid username/email or password", 400);
  }

  const user = await env.DB.prepare(
    `SELECT
       id,
       username,
       email,
       password_hash,
       display_name,
       email_verified,
       is_active
     FROM social_users
     WHERE email = ? OR username = ?
     LIMIT 1`
  ).bind(
    identifier,
    identifier
  ).first();

  if (
    !user ||
    !user.is_active
  ) {
    return error("Invalid username/email or password", 401);
  }

  const valid = await verifyPassword(
    password,
    user.password_hash
  );

  if (!valid) {
    return error("Invalid username/email or password", 401);
  }

  const session = await createSocialSession(
    env,
    user.id
  );

  return json({
    success: true,
    message: "Login successful",
    token: session.token,
    expiresAt: session.expiresAt,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.display_name || "",
      emailVerified: Boolean(user.email_verified)
    }
  });
}

// -------------------------
// SOCIAL LOGOUT
// -------------------------

async function socialLogout(request, env) {
  const authorization = request.headers.get("Authorization");

  if (!authorization) {
    return error("Authentication required", 401);
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return error("Invalid session", 401);
  }

  const token = match[1].trim();
  const tokenHash = await sha256(token);

  await env.DB.prepare(
    `DELETE FROM social_sessions
     WHERE token_hash = ?`
  ).bind(tokenHash).run();

  return json({
    success: true,
    message: "Logged out successfully"
  });
}

// -------------------------
// SOCIAL CURRENT USER
// -------------------------

async function socialMe(request, env) {
  const user = await getSocialUser(request, env);

  if (!user) {
    return error("Authentication required", 401);
  }

  delete user.sessionId;

  return json({
    success: true,
    user
  });
}

// -------------------------
// MAIN WORKER
// -------------------------

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    if (origin && origin !== ALLOWED_ORIGIN) {
      return new Response("Forbidden", {
        status: 403
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
          "Access-Control-Allow-Methods":
            "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization",
          "Vary": "Origin"
        }
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // -------------------------
      // DATABASE AVAILABILITY
      // -------------------------

      const socialPaths = [
        "/social/register",
        "/social/login",
        "/social/logout",
        "/social/me"
      ];

      if (
        path.startsWith("/projects") ||
        socialPaths.includes(path)
      ) {
        if (!env.DB) {
          return error(
            "Database binding is missing",
            503
          );
        }
      }

      // -------------------------
      // HEALTH CHECK
      // -------------------------

      if (
        path === "/health" &&
        request.method === "GET"
      ) {
        let database = false;

        try {
          if (env.DB) {
            await env.DB.prepare(
              "SELECT 1 AS test"
            ).first();

            database = true;
          }
        } catch (err) {
          console.error("Database health check:", err);
        }

        return json({
          status: "online",
          service: "MEHRAN MSH AUTH",
          version: "3.1",
          database
        });
      }

      // -------------------------
      // PI AUTHENTICATION
      // -------------------------

      if (
        path === "/auth" &&
        request.method === "POST"
      ) {
        const body = await readBody(request);
        const accessToken = body?.accessToken;

        if (
          typeof accessToken !== "string" ||
          accessToken.length < 10 ||
          accessToken.length > 4096
        ) {
          return error("Invalid access token", 400);
        }

        const piResponse = await fetch(PI_ME_URL, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json"
          }
        });

        if (!piResponse.ok) {
          return error(
            "Pi authentication failed",
            401
          );
        }

        const user = await piResponse.json();

        if (
          typeof user.uid !== "string" ||
          typeof user.username !== "string"
        ) {
          return error("Invalid Pi user data", 401);
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

      // -------------------------
      // SOCIAL REGISTER
      // -------------------------

      if (
        path === "/social/register" &&
        request.method === "POST"
      ) {
        return await socialRegister(request, env);
      }

      // -------------------------
      // SOCIAL LOGIN
      // -------------------------

      if (
        path === "/social/login" &&
        request.method === "POST"
      ) {
        return await socialLogin(request, env);
      }

      // -------------------------
      // SOCIAL LOGOUT
      // -------------------------

      if (
        path === "/social/logout" &&
        request.method === "POST"
      ) {
        return await socialLogout(request, env);
      }

      // -------------------------
      // SOCIAL CURRENT USER
      // -------------------------

      if (
        path === "/social/me" &&
        request.method === "GET"
      ) {
        return await socialMe(request, env);
      }

      // -------------------------
      // GET ALL PROJECTS
      // -------------------------

      if (
        path === "/projects" &&
        request.method === "GET"
      ) {
        const result = await env.DB.prepare(
          `SELECT
             id,
             name,
             description,
             fa_description,
             url,
             status,
             created_at,
             updated_at
           FROM projects
           ORDER BY created_at DESC`
        ).all();

        const projects = (result.results || [])
          .map(formatProject);

        return json({
          success: true,
          projects
        });
      }

      // -------------------------
      // CREATE PROJECT
      // -------------------------

      if (
        path === "/projects" &&
        request.method === "POST"
      ) {
        const body = await readBody(request);

        if (!body) {
          return error("Invalid request body", 400);
        }

        const user = await verifyAdmin(
          body?.accessToken
        );

        if (!user) {
          return error(
            "Admin authentication required",
            403
          );
        }

        const project = cleanProject(
          body.project || body
        );

        if (!project) {
          return error(
            "Invalid project data",
            400
          );
        }

        await env.DB.prepare(
          `INSERT INTO projects
           (
             id,
             name,
             description,
             fa_description,
             url,
             status
           )
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
          `SELECT *
           FROM projects
           WHERE id = ?`
        ).bind(project.id).first();

        return json({
          success: true,
          project: formatProject(saved)
        }, 201);
      }

      // -------------------------
      // UPDATE PROJECT
      // -------------------------

      const updateMatch = path.match(
        /^\/projects\/([^/]+)$/
      );

      if (
        updateMatch &&
        request.method === "PUT"
      ) {
        const id = decodeURIComponent(
          updateMatch[1]
        );

        const body = await readBody(request);

        if (!body) {
          return error("Invalid request body", 400);
        }

        const user = await verifyAdmin(
          body?.accessToken
        );

        if (!user) {
          return error(
            "Admin authentication required",
            403
          );
        }

        const project = cleanProject({
          ...body.project,
          id
        });

        if (!project) {
          return error(
            "Invalid project data",
            400
          );
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

        if (
          !result.meta ||
          result.meta.changes === 0
        ) {
          return error("Project not found", 404);
        }

        const saved = await env.DB.prepare(
          `SELECT *
           FROM projects
           WHERE id = ?`
        ).bind(id).first();

        return json({
          success: true,
          project: formatProject(saved)
        });
      }

      // -------------------------
      // DELETE PROJECT
      // -------------------------

      if (
        updateMatch &&
        request.method === "DELETE"
      ) {
        const id = decodeURIComponent(
          updateMatch[1]
        );

        const body = await readBody(request);

        if (!body) {
          return error("Invalid request body", 400);
        }

        const user = await verifyAdmin(
          body?.accessToken
        );

        if (!user) {
          return error(
            "Admin authentication required",
            403
          );
        }

        const result = await env.DB.prepare(
          `DELETE FROM projects
           WHERE id = ?`
        ).bind(id).run();

        if (
          !result.meta ||
          result.meta.changes === 0
        ) {
          return error("Project not found", 404);
        }

        return json({
          success: true,
          deleted: true,
          id
        });
      }

      // -------------------------
      // NOT FOUND
      // -------------------------

      return error("Not found", 404);

    } catch (err) {
      console.error(
        "MEHRAN MSH Worker error:",
        err
      );

      return error(
        "Internal service error",
        500
      );
    }
  }
};
