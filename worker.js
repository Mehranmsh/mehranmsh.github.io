const ALLOWED_ORIGIN = "https://mehranmsh.github.io";
const FIREBASE_WEB_API_KEY = "AIzaSyBNezoCzAUXi1D7vC_stoUnQuN_JHR-rDM";
const PI_ME_URL = "https://api.minepi.com/v2/me";
const RAPIDFILE_API = "https://api.rapidfile.cc/v1";

const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100000;
const MAX_BODY_BYTES = 100000;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_POST_MEDIA = 10;

function json(data, status = 200) {
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

function error(message, status = 400) {
  return json({ success: false, error: message }, status);
}

async function readBody(request) {
  try {
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

    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function getBearer(request) {
  const match = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function cleanText(value, max = 5000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function safeLimit(value, fallback = 30, max = 50) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? Math.min(number, max) : fallback;
}

function validHttpsUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(
    atob(base64 + "=".repeat((4 - base64.length % 4) % 4)),
    char => char.charCodeAt(0)
  );
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return toBase64Url(new Uint8Array(digest));
}

async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256
  );
  return [
    "pbkdf2",
    iterations,
    toBase64Url(salt),
    toBase64Url(new Uint8Array(bits))
  ].join("$");
}

async function verifyPassword(password, storedHash) {
  try {
    if (typeof storedHash !== "string") return { valid: false, needsUpgrade: false };

    const parts = storedHash.split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2") {
      return { valid: false, needsUpgrade: false };
    }

    const iterations = Number(parts[1]);
    if (iterations !== PBKDF2_ITERATIONS) {
      return { valid: false, needsUpgrade: false };
    }

    const salt = fromBase64Url(parts[2]);
    const expected = fromBase64Url(parts[3]);
    if (salt.length !== 16 || expected.length !== 32) {
      return { valid: false, needsUpgrade: false };
    }

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      key,
      256
    );

    const actual = new Uint8Array(bits);
    let difference = 0;
    for (let i = 0; i < actual.length; i++) {
      difference |= actual[i] ^ expected[i];
    }

    return { valid: difference === 0, needsUpgrade: false };
  } catch {
    return { valid: false, needsUpgrade: false };
  }
}

function createSessionToken() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function checkRateLimit(env, request, scope, maxAttempts, windowSeconds, blockSeconds) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = await sha256(`${scope}:${ip}`);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - windowSeconds;

  const row = await env.DB.prepare(`
    INSERT INTO social_auth_limits(rate_key,attempts,window_started_at,blocked_until)
    VALUES(?,1,?,NULL)
    ON CONFLICT(rate_key) DO UPDATE SET
      attempts=CASE
        WHEN social_auth_limits.window_started_at<=?
          OR (social_auth_limits.blocked_until IS NOT NULL AND social_auth_limits.blocked_until<=?)
        THEN 1 ELSE social_auth_limits.attempts+1 END,
      window_started_at=CASE
        WHEN social_auth_limits.window_started_at<=?
          OR (social_auth_limits.blocked_until IS NOT NULL AND social_auth_limits.blocked_until<=?)
        THEN excluded.window_started_at ELSE social_auth_limits.window_started_at END,
      blocked_until=CASE
        WHEN social_auth_limits.window_started_at<=?
          OR (social_auth_limits.blocked_until IS NOT NULL AND social_auth_limits.blocked_until<=?)
        THEN NULL ELSE social_auth_limits.blocked_until END
    RETURNING attempts,blocked_until
  `).bind(
    key, now,
    windowStart, now,
    windowStart, now,
    windowStart, now
  ).first();

  if (!row) throw new Error("Rate limit check failed");
  if (row.blocked_until && Number(row.blocked_until) > now) return false;

  if (Number(row.attempts) > maxAttempts) {
    await env.DB.prepare(
      "UPDATE social_auth_limits SET blocked_until=? WHERE rate_key=?"
    ).bind(now + blockSeconds, key).run();
    return false;
  }

  return true;
}

async function ensureSocialTables(env) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS social_auth_limits(
      rate_key TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      window_started_at INTEGER NOT NULL,
      blocked_until INTEGER
    )`,

    `CREATE TABLE IF NOT EXISTS social_users(
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT '',
      pi_username TEXT UNIQUE,
      pi_verified INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      email_verified INTEGER NOT NULL DEFAULT 0,
      email_verified_at TEXT,
      firebase_uid TEXT
    )`,

    `CREATE TABLE IF NOT EXISTS social_profile_photos(
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      photo_url TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_social_profile_photos_user
      ON social_profile_photos(user_id,sort_order,created_at)`,

    `CREATE TABLE IF NOT EXISTS social_sessions(
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      FOREIGN KEY(user_id) REFERENCES social_users(id)
    )`,

    `CREATE TABLE IF NOT EXISTS social_user_settings(
      user_id TEXT PRIMARY KEY,
      is_private INTEGER NOT NULL DEFAULT 0,
      allow_messages TEXT NOT NULL DEFAULT 'everyone',
      allow_comments TEXT NOT NULL DEFAULT 'everyone',
      show_online_status INTEGER NOT NULL DEFAULT 1,
      show_activity_status INTEGER NOT NULL DEFAULT 1,
      language TEXT NOT NULL DEFAULT 'en',
      theme TEXT NOT NULL DEFAULT 'dark',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES social_users(id),
      CHECK(allow_messages IN ('everyone','followers','none')),
      CHECK(allow_comments IN ('everyone','followers','none'))
    )`,

    `CREATE TABLE IF NOT EXISTS social_extended_settings(
      user_id TEXT PRIMARY KEY,
      preferences_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES social_users(id)
    )`,

    `CREATE TABLE IF NOT EXISTS social_support_tickets(
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      category TEXT NOT NULL,
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS social_uploads(
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      acl TEXT NOT NULL DEFAULT 'private',
      status TEXT NOT NULL DEFAULT 'uploading',
      url TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE INDEX IF NOT EXISTS idx_social_uploads_user
      ON social_uploads(user_id,created_at)`,

    `CREATE TABLE IF NOT EXISTS social_posts(
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      media_json TEXT NOT NULL DEFAULT '[]',
      visibility TEXT NOT NULL DEFAULT 'public',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE INDEX IF NOT EXISTS idx_social_posts_created
      ON social_posts(created_at DESC)`,

    `CREATE INDEX IF NOT EXISTS idx_social_posts_user
      ON social_posts(user_id,created_at DESC)`,

    `CREATE TABLE IF NOT EXISTS social_post_likes(
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(post_id,user_id)
    )`,

    `CREATE TABLE IF NOT EXISTS social_comments(
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE INDEX IF NOT EXISTS idx_social_comments_post
      ON social_comments(post_id,created_at)`,

    `CREATE TABLE IF NOT EXISTS social_follows(
      follower_id TEXT NOT NULL,
      following_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(follower_id,following_id)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_social_follows_following
      ON social_follows(following_id)`,

    `CREATE TABLE IF NOT EXISTS social_follow_requests(
      id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(requester_id,target_id)
    )`,

    `CREATE TABLE IF NOT EXISTS social_blocks(
      blocker_id TEXT NOT NULL,
      blocked_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(blocker_id,blocked_id)
    )`,

    `CREATE TABLE IF NOT EXISTS social_reports(
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS social_bookmarks(
      user_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(user_id,post_id)
    )`,

    `CREATE TABLE IF NOT EXISTS social_post_views(
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(post_id,user_id)
    )`,

    `CREATE TABLE IF NOT EXISTS social_notifications(
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      actor_id TEXT,
      type TEXT NOT NULL,
      target_id TEXT,
      message TEXT NOT NULL DEFAULT '',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE INDEX IF NOT EXISTS idx_social_notifications_user
      ON social_notifications(user_id,created_at DESC)`,

    `CREATE TABLE IF NOT EXISTS social_stories(
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      media_url TEXT NOT NULL,
      media_type TEXT NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS social_story_views(
      story_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(story_id,user_id)
    )`,

    `CREATE TABLE IF NOT EXISTS social_story_reactions(
      story_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reaction TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(story_id,user_id)
    )`,

    `CREATE TABLE IF NOT EXISTS social_conversations(
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'private',
      title TEXT NOT NULL DEFAULT '',
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS social_conversation_members(
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_read_at TEXT,
      PRIMARY KEY(conversation_id,user_id)
    )`,

    `CREATE TABLE IF NOT EXISTS social_messages(
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      media_json TEXT NOT NULL DEFAULT '[]',
      reply_to TEXT,
      forwarded_from TEXT,
      edited_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE INDEX IF NOT EXISTS idx_social_messages_conversation
      ON social_messages(conversation_id,created_at DESC)`,

    `CREATE TABLE IF NOT EXISTS social_message_reactions(
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reaction TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(message_id,user_id)
    )`,

    `CREATE TABLE IF NOT EXISTS social_channels(
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      username TEXT COLLATE NOCASE UNIQUE,
      is_private INTEGER NOT NULL DEFAULT 0,
      invite_code TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS social_channel_members(
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'subscriber',
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(channel_id,user_id)
    )`,

    `CREATE TABLE IF NOT EXISTS social_channel_posts(
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      media_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      edited_at TEXT
    )`,

    `CREATE TABLE IF NOT EXISTS social_channel_pins(
      channel_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(channel_id,post_id)
    )`,

    `CREATE TABLE IF NOT EXISTS social_group_invites(
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS social_bots(
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      token_hash TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  ];

  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
  try { await env.DB.prepare("ALTER TABLE social_users ADD COLUMN firebase_uid TEXT").run(); } catch {}
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_social_users_firebase_uid ON social_users(firebase_uid)").run();
  try { await env.DB.prepare("ALTER TABLE social_reports ADD COLUMN status TEXT NOT NULL DEFAULT 'open'").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE social_reports ADD COLUMN resolved_at TEXT").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE social_reports ADD COLUMN resolved_by TEXT").run(); } catch {}
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
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function getSocialUser(request, env) {
  const token = getBearer(request);
  if (token.length < 20 || token.length > 200) return null;

  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(`
    SELECT
      u.id,u.username,u.email,u.display_name,u.bio,u.avatar_url,
      u.pi_username,u.pi_verified,u.email_verified,u.created_at,
      s.id AS session_id,s.expires_at
    FROM social_sessions s
    JOIN social_users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.is_active=1
    LIMIT 1
  `).bind(tokenHash, new Date().toISOString()).first();

  if (!row) return null;

  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name || "",
    bio: row.bio || "",
    avatarUrl: row.avatar_url || "",
    piUsername: row.pi_username || "",
    piVerified: Boolean(row.pi_verified),
    emailVerified: Boolean(row.email_verified),
    isCreator: Boolean(row.pi_verified && String(row.pi_username || "").trim().toLowerCase() === "mehranmsh"),
    creatorLabel: Boolean(row.pi_verified && String(row.pi_username || "").trim().toLowerCase() === "mehranmsh") ? "Creator" : "",
    createdAt: row.created_at,
    sessionId: row.session_id,
    sessionExpiresAt: row.expires_at
  };
}

async function createSocialSession(env, userId) {
  const token = createSessionToken();
  const tokenHash = await sha256(token);
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();

  await env.DB.prepare(`
    INSERT INTO social_sessions(id,user_id,token_hash,expires_at)
    VALUES(?,?,?,?)
  `).bind(id, userId, tokenHash, expiresAt).run();

  return { token, tokenHash, id, expiresAt };
}

async function createSessionTokenAndHash() {
  const token = createSessionToken();
  const tokenHash = await sha256(token);
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  return { token, tokenHash, id, expiresAt };
}

async function socialRegister(request, env) {
  if (!await checkRateLimit(env, request, "register-v3", 20, 3600, 600)) {
    return error("Too many registration attempts. Try again later.", 429);
  }

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const username = cleanUsername(body.username);
  const email = cleanEmail(body.email);
  const password = String(body.password || "");
  const displayName = cleanText(body.displayName || username, 60);

  if (!validUsername(username)) {
    return error("Username must contain 3 to 24 letters, numbers or underscores");
  }
  if (!validEmail(email)) return error("Invalid email address");
  if (password.length < 10 || password.length > 128) {
    return error("Password must be between 10 and 128 characters");
  }

  const existing = await env.DB.prepare(
    "SELECT id FROM social_users WHERE username=? OR email=? LIMIT 1"
  ).bind(username, email).first();

  if (existing) return error("Username or email is already registered", 409);

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const session = await createSessionTokenAndHash();

  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO social_users(id,username,email,password_hash,display_name)
        VALUES(?,?,?,?,?)
      `).bind(id, username, email, passwordHash, displayName),

      env.DB.prepare(
        "INSERT INTO social_user_settings(user_id) VALUES(?)"
      ).bind(id),

      env.DB.prepare(`
        INSERT INTO social_sessions(id,user_id,token_hash,expires_at)
        VALUES(?,?,?,?)
      `).bind(session.id, id, session.tokenHash, session.expiresAt)
    ]);
  } catch (err) {
    if (String(err.message).toLowerCase().includes("unique")) {
      return error("Username or email is already registered", 409);
    }
    console.error("SOCIAL_REGISTER_FAILURE", err);
    return error("Could not create account. Please try again.", 500);
  }

  return json({
    success: true,
    message: "Account created successfully",
    token: session.token,
    expiresAt: session.expiresAt,
    user: {
      id,
      username,
      email,
      displayName,
      emailVerified: false
    }
  }, 201);
}

async function socialFirebaseSession(request, env) {
  if (!await checkRateLimit(env, request, "firebase-session", 20, 900, 900)) {
    return error("Too many sign-in attempts. Try again later.", 429);
  }
  const body = await readBody(request);
  if (!body || typeof body.idToken !== "string" || body.idToken.length < 100 || body.idToken.length > 10000) {
    return error("A valid Firebase sign-in token is required.", 400);
  }
  let lookup;
  try {
    const response = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + FIREBASE_WEB_API_KEY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: body.idToken })
    });
    lookup = await response.json();
    if (!response.ok) return error("Firebase authentication failed.", 401);
  } catch {
    return error("Could not verify your Firebase session. Please try again.", 503);
  }
  const identity = lookup && Array.isArray(lookup.users) ? lookup.users[0] : null;
  if (!identity || identity.disabled || identity.emailVerified !== true || !identity.localId || !validEmail(cleanEmail(identity.email || ""))) {
    return error("Please verify your email address before signing in.", 403);
  }
  const email = cleanEmail(identity.email);
  let user = await env.DB.prepare(
    "SELECT id,username,email,display_name,is_active,firebase_uid FROM social_users WHERE firebase_uid=? LIMIT 1"
  ).bind(identity.localId).first();
  if (!user) {
    user = await env.DB.prepare(
      "SELECT id,username,email,display_name,is_active,firebase_uid FROM social_users WHERE email=? LIMIT 1"
    ).bind(email).first();
    if (user && user.firebase_uid && user.firebase_uid !== identity.localId) {
      return error("This email is already linked to another sign-in identity. Contact support.", 409);
    }
    if (user) {
      await env.DB.prepare(
        "UPDATE social_users SET firebase_uid=?,email_verified=1,email_verified_at=COALESCE(email_verified_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=?"
      ).bind(identity.localId, user.id).run();
    }
  }
  if (!user) {
    const username = cleanUsername(body.username);
    const displayName = cleanText(body.displayName || username, 60);
    if (!validUsername(username)) return error("Choose a username with 3 to 24 letters, numbers or underscores.", 400);
    const conflict = await env.DB.prepare("SELECT id FROM social_users WHERE username=? LIMIT 1").bind(username).first();
    if (conflict) return error("That username is already taken. Please choose another.", 409);
    const id = crypto.randomUUID();
    const randomPassword = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const passwordHash = await hashPassword(randomPassword);
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO social_users(id,username,email,password_hash,display_name,email_verified,email_verified_at,firebase_uid)
          VALUES(?,?,?,?,?,1,CURRENT_TIMESTAMP,?)`).bind(id, username, email, passwordHash, displayName, identity.localId),
        env.DB.prepare("INSERT INTO social_user_settings(user_id) VALUES(?)").bind(id)
      ]);
    } catch (err) {
      console.error("SOCIAL_FIREBASE_USER_CREATE_FAILURE", err);
      return error("Could not finish creating your SOCIAL profile. Please try again.", 500);
    }
    user = { id, username, email, display_name: displayName, is_active: 1, firebase_uid: identity.localId };
  }
  if (!user.is_active) return error("This SOCIAL account is disabled.", 403);
  const session = await createSocialSession(env, user.id);
  return json({
    success: true,
    message: "Signed in successfully.",
    token: session.token,
    expiresAt: session.expiresAt,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.display_name || "",
      emailVerified: true
    }
  });
}

async function socialLogin(request, env) {
  if (!await checkRateLimit(env, request, "login", 10, 900, 900)) {
    return error("Too many login attempts. Try again later.", 429);
  }

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const identifier = String(
    body.identifier || body.email || body.username || ""
  ).trim().toLowerCase();

  const password = String(body.password || "");

  if (!identifier || identifier.length > 254 || !password || password.length > 128) {
    return error("Invalid username/email or password", 400);
  }

  const user = await env.DB.prepare(`
    SELECT id,username,email,password_hash,display_name,email_verified,is_active
    FROM social_users
    WHERE email=? OR username=?
    LIMIT 1
  `).bind(identifier, identifier).first();

  if (!user || !user.is_active) {
    return error("Invalid username/email or password", 401);
  }

  const result = await verifyPassword(password, user.password_hash);
  if (!result.valid) return error("Invalid username/email or password", 401);

  const session = await createSocialSession(env, user.id);

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

async function socialMe(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  delete user.sessionId;
  delete user.sessionExpiresAt;
  return json({ success: true, user });
}

async function socialLogout(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  await env.DB.prepare(
    "DELETE FROM social_sessions WHERE id=? AND user_id=?"
  ).bind(user.sessionId, user.id).run();

  return json({ success: true, message: "Logged out successfully" });
}

async function socialListSessions(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const result = await env.DB.prepare(`
    SELECT id,expires_at FROM social_sessions
    WHERE user_id=? AND expires_at>?
    ORDER BY expires_at DESC
  `).bind(user.id, new Date().toISOString()).all();

  const sessions = (result.results || []).map(row => ({
    id: row.id,
    expiresAt: row.expires_at,
    current: row.id === user.sessionId
  }));

  return json({ success: true, sessions, total: sessions.length });
}

async function socialRevokeSession(request, env, id) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const result = await env.DB.prepare(
    "DELETE FROM social_sessions WHERE id=? AND user_id=?"
  ).bind(decodeURIComponent(id), user.id).run();

  if (!result.meta || result.meta.changes === 0) {
    return error("Session not found", 404);
  }

  return json({ success: true, message: "Session revoked successfully" });
}

async function socialLogoutAll(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const result = await env.DB.prepare(
    "DELETE FROM social_sessions WHERE user_id=? AND id!=?"
  ).bind(user.id, user.sessionId).run();

  return json({
    success: true,
    message: "All other sessions have been logged out",
    revokedCount: result.meta ? result.meta.changes : 0,
    currentSessionKept: true
  });
}

async function isBlocked(env, firstId, secondId) {
  const row = await env.DB.prepare(`
    SELECT 1 FROM social_blocks
    WHERE (blocker_id=? AND blocked_id=?)
       OR (blocker_id=? AND blocked_id=?)
    LIMIT 1
  `).bind(firstId, secondId, secondId, firstId).first();

  return Boolean(row);
}

async function notify(env, userId, actorId, type, targetId, message = "") {
  if (!userId || userId === actorId) return;
  const row = await env.DB.prepare(
    "SELECT preferences_json FROM social_extended_settings WHERE user_id=?"
  ).bind(userId).first();
  let prefs = {};
  try { prefs = JSON.parse(row?.preferences_json || "{}"); } catch {}
  const t = String(type || "").toLowerCase();
  const key = /like|comment|mention|post/.test(t) ? "likesComments"
    : /follow|request/.test(t) ? "followers"
    : /message|chat/.test(t) ? "messages"
    : /group|channel|invite/.test(t) ? "groups"
    : null;
  if (key && prefs.notifications && prefs.notifications[key] === false) return;

  await env.DB.prepare(`
    INSERT INTO social_notifications(id,user_id,actor_id,type,target_id,message)
    VALUES(?,?,?,?,?,?)
  `).bind(
    crypto.randomUUID(), userId, actorId || null, type, targetId || null,
    cleanText(message, 300)
  ).run();
}

async function socialExtendedSettings(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  if (request.method === "GET") {
    const row = await env.DB.prepare(
      "SELECT preferences_json FROM social_extended_settings WHERE user_id=?"
    ).bind(user.id).first();
    let preferences = {};
    try { preferences = JSON.parse(row?.preferences_json || "{}"); } catch {}
    return json({success:true,preferences});
  }
  const body = await readBody(request);
  if (!body || !body.preferences || typeof body.preferences !== "object") return error("Invalid preferences");
  const allowed = {
    notifications: ["likesComments","followers","messages","groups"],
    chat: ["readReceipts","messagePreviews","autoDownload"],
    community: ["groupInvites","channelInvites"]
  };
  const clean = {};
  for (const [section, keys] of Object.entries(allowed)) {
    const source = body.preferences[section] || {};
    clean[section] = {};
    for (const key of keys) clean[section][key] = source[key] !== false;
  }
  await env.DB.prepare(`
    INSERT INTO social_extended_settings(user_id,preferences_json,updated_at)
    VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      preferences_json=excluded.preferences_json,updated_at=CURRENT_TIMESTAMP
  `).bind(user.id, JSON.stringify(clean)).run();
  return json({success:true,preferences:clean});
}

async function socialStorageSummary(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  const row = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM social_posts WHERE user_id=?) AS posts,
      (SELECT COUNT(*) FROM social_uploads WHERE user_id=? AND status='ready') AS files,
      (SELECT COALESCE(SUM(size),0) FROM social_uploads WHERE user_id=? AND status='ready') AS bytes,
      (SELECT COUNT(*) FROM social_stories WHERE user_id=? AND expires_at>CURRENT_TIMESTAMP) AS active_stories
  `).bind(user.id,user.id,user.id,user.id).first();
  return json({success:true,storage:{
    posts:Number(row?.posts||0),files:Number(row?.files||0),
    bytes:Number(row?.bytes||0),activeStories:Number(row?.active_stories||0)
  }});
}

async function socialCreateSupportTicket(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  const body = await readBody(request);
  if (!body) return error("Invalid request body");
  const category = cleanText(body.category,50);
  const subject = cleanText(body.subject,120);
  const message = cleanText(body.message,3000);
  if (!["account","bug","safety","other"].includes(category) || subject.length<3 || message.length<10) {
    return error("Choose a category and provide a subject and message (at least 10 characters).");
  }
  const id=crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO social_support_tickets(id,user_id,category,subject,message)
    VALUES(?,?,?,?,?)
  `).bind(id,user.id,category,subject,message).run();
  return json({success:true,ticket:{id,category,subject,status:"open"}},201);
}

async function getProfileByUsername(username, viewerId, env) {
  const profile = await env.DB.prepare(`
    SELECT id,username,display_name,bio,avatar_url,pi_username,pi_verified,created_at
    FROM social_users
    WHERE username=? AND is_active=1
    LIMIT 1
  `).bind(username).first();

  if (!profile) return null;

  const counts = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM social_follows WHERE following_id=?) AS followers,
      (SELECT COUNT(*) FROM social_follows WHERE follower_id=?) AS following,
      (SELECT COUNT(*) FROM social_posts WHERE user_id=?) AS posts,
      EXISTS(
        SELECT 1 FROM social_follows
        WHERE follower_id=? AND following_id=?
      ) AS is_following,
      EXISTS(
        SELECT 1 FROM social_follow_requests
        WHERE requester_id=? AND target_id=?
      ) AS request_pending
  `).bind(
    profile.id,
    profile.id,
    profile.id,
    viewerId || "",
    profile.id,
    viewerId || "",
    profile.id
  ).first();

  const settings = await env.DB.prepare(
    "SELECT is_private FROM social_user_settings WHERE user_id=?"
  ).bind(profile.id).first();

  const galleryResult = await env.DB.prepare(
    "SELECT id,photo_url,sort_order,created_at FROM social_profile_photos WHERE user_id=? ORDER BY sort_order ASC,created_at ASC"
  ).bind(profile.id).all();
  const gallery = (galleryResult.results || []).map(row => ({
    id: row.id,
    url: row.photo_url,
    sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at
  }));

  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.display_name || "",
    bio: profile.bio || "",
    avatarUrl: profile.avatar_url || "",
    gallery,
    piUsername: profile.pi_username || "",
    piVerified: Boolean(profile.pi_verified),
    createdAt: profile.created_at,
    isPrivate: Boolean(settings?.is_private),
    counts: {
      posts: Number(counts?.posts || 0),
      followers: Number(counts?.followers || 0),
      following: Number(counts?.following || 0)
    },
    isFollowing: Boolean(counts?.is_following),
    requestPending: Boolean(counts?.request_pending)
  };
}

async function socialGetProfile(request, env, username) {
  const viewer = await getSocialUser(request, env);
  if (!viewer) return error("Authentication required", 401);

  const profile = await getProfileByUsername(
    cleanUsername(username),
    viewer.id,
    env
  );

  if (!profile) return error("User not found", 404);

  if (profile.isPrivate && profile.id !== viewer.id && !profile.isFollowing) {
    return json({
      success: true,
      profile: {
        ...profile,
        bio: "",
        avatarUrl: profile.avatarUrl,
        counts: profile.counts,
        privateContent: true
      }
    });
  }

  return json({ success: true, profile });
}

async function socialUpdateProfile(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const displayName = cleanText(body.displayName, 60);
  const bio = cleanText(body.bio, 500);
  const avatarUrl = String(body.avatarUrl || "").trim();
  const galleryInput = Array.isArray(body.gallery) ? body.gallery : null;

  if (avatarUrl && !validHttpsUrl(avatarUrl)) {
    return error("Avatar must be a valid HTTPS URL");
  }
  if (galleryInput && galleryInput.some(url => typeof url !== "string" || !validHttpsUrl(url))) {
    return error("Every gallery photo must be a valid HTTPS URL");
  }

  await env.DB.prepare(`
    UPDATE social_users
    SET display_name=?,bio=?,avatar_url=?,updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).bind(displayName, bio, avatarUrl, user.id).run();

  if (galleryInput) {
    await env.DB.prepare("DELETE FROM social_profile_photos WHERE user_id=?").bind(user.id).run();
    for (let i=0;i<galleryInput.length;i++) {
      await env.DB.prepare(
        "INSERT INTO social_profile_photos(id,user_id,photo_url,sort_order) VALUES(?,?,?,?)"
      ).bind(crypto.randomUUID(),user.id,galleryInput[i],i).run();
    }
  }

  const profile = await getProfileByUsername(user.username, user.id, env);
  return json({ success: true, profile });
}

async function socialChangeUsername(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const username = cleanUsername(body.username);
  if (!validUsername(username)) {
    return error("Username must contain 3 to 24 letters, numbers or underscores");
  }

  const existing = await env.DB.prepare(
    "SELECT id FROM social_users WHERE username=? AND id!=?"
  ).bind(username, user.id).first();

  if (existing) return error("Username is already taken", 409);

  try {
    await env.DB.prepare(`
      UPDATE social_users
      SET username=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).bind(username, user.id).run();
  } catch {
    return error("Username is already taken", 409);
  }

  return json({ success: true, username });
}

async function socialSearch(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const url = new URL(request.url);
  const query = cleanText(url.searchParams.get("q"), 80);
  const type = url.searchParams.get("type") || "all";
  const limit = safeLimit(url.searchParams.get("limit"), 20, 40);

  if (query.length < 2) {
    return json({ success: true, users: [], posts: [], groups: [], channels: [] });
  }

  const term = `%${query.replace(/[%_]/g, "")}%`;
  const output = { users: [], posts: [], groups: [], channels: [] };

  if (type === "all" || type === "users") {
    const result = await env.DB.prepare(`
      SELECT id,username,display_name,avatar_url,pi_verified
      FROM social_users
      WHERE is_active=1 AND id!=?
        AND (username LIKE ? OR display_name LIKE ?)
        AND id NOT IN (
          SELECT blocked_id FROM social_blocks WHERE blocker_id=?
        )
      ORDER BY username LIMIT ?
    `).bind(user.id, term, term, user.id, limit).all();

    output.users = (result.results || []).map(row => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name || "",
      avatarUrl: row.avatar_url || "",
      piVerified: Boolean(row.pi_verified)
    }));
  }

  if (type === "all" || type === "posts") {
    const result = await env.DB.prepare(`
      SELECT p.id,p.content,p.media_json,p.created_at,
        u.username,u.display_name,u.avatar_url
      FROM social_posts p
      JOIN social_users u ON u.id=p.user_id
      WHERE p.visibility='public' AND p.content LIKE ?
      ORDER BY p.created_at DESC LIMIT ?
    `).bind(term, limit).all();

    output.posts = (result.results || []).map(row => ({
      id: row.id,
      content: row.content,
      media: JSON.parse(row.media_json || "[]"),
      createdAt: row.created_at,
      author: {
        username: row.username,
        displayName: row.display_name || "",
        avatarUrl: row.avatar_url || ""
      }
    }));
  }

  if (type === "all" || type === "groups") {
    const result = await env.DB.prepare(`
      SELECT c.id,c.title,c.created_at
      FROM social_conversations c
      JOIN social_conversation_members m ON m.conversation_id=c.id
      WHERE c.type='group' AND m.user_id=? AND c.title LIKE ?
      ORDER BY c.created_at DESC LIMIT ?
    `).bind(user.id, term, limit).all();

    output.groups = result.results || [];
  }

  if (type === "all" || type === "channels") {
    const result = await env.DB.prepare(`
      SELECT c.id,c.title,c.username,c.description
      FROM social_channels c
      JOIN social_channel_members m ON m.channel_id=c.id
      WHERE m.user_id=? AND (c.title LIKE ? OR c.username LIKE ?)
      ORDER BY c.created_at DESC LIMIT ?
    `).bind(user.id, term, term, limit).all();

    output.channels = result.results || [];
  }

  return json({ success: true, ...output });
}

async function validatePostMedia(env, userId, media) {
  if (media === undefined || media === null) return [];
  if (!Array.isArray(media) || media.length > MAX_POST_MEDIA) return null;

  const output = [];

  for (const item of media) {
    if (!item || typeof item !== "object") return null;

    const id = String(item.id || "");
    if (!id || id.length > 150) return null;

    const row = await env.DB.prepare(`
      SELECT id,name,mime_type,url,acl,status
      FROM social_uploads
      WHERE id=? AND user_id=?
      LIMIT 1
    `).bind(id, userId).first();

    if (!row || row.status !== "ready" || row.acl !== "public" || !row.url) {
      return null;
    }

    output.push({
      id: row.id,
      name: row.name,
      type: row.mime_type,
      url: row.url
    });
  }

  return output;
}

async function formatPost(row, viewerId, env) {
  let media = [];

  try {
    const parsed = JSON.parse(row.media_json || "[]");
    if (Array.isArray(parsed)) media = parsed;
  } catch {}

  const stats = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM social_post_likes WHERE post_id=?) AS likes,
      (SELECT COUNT(*) FROM social_comments WHERE post_id=?) AS comments,
      (SELECT COUNT(*) FROM social_post_views WHERE post_id=?) AS views,
      EXISTS(
        SELECT 1 FROM social_post_likes WHERE post_id=? AND user_id=?
      ) AS liked,
      EXISTS(
        SELECT 1 FROM social_bookmarks WHERE post_id=? AND user_id=?
      ) AS bookmarked
  `).bind(
    row.id,
    row.id,
    row.id,
    row.id,
    viewerId,
    row.id,
    viewerId
  ).first();

  const author = await env.DB.prepare(`
    SELECT username,display_name,avatar_url,pi_verified
    FROM social_users WHERE id=?
  `).bind(row.user_id).first();

  return {
    id: row.id,
    content: row.content,
    media,
    visibility: row.visibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    author: {
      username: author?.username || "",
      displayName: author?.display_name || "",
      avatarUrl: author?.avatar_url || "",
      piVerified: Boolean(author?.pi_verified)
    },
    stats: {
      likes: Number(stats?.likes || 0),
      comments: Number(stats?.comments || 0),
      views: Number(stats?.views || 0),
      liked: Boolean(stats?.liked),
      bookmarked: Boolean(stats?.bookmarked)
    },
    isOwner: row.user_id === viewerId
  };
}

async function socialCreatePost(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  if (!await checkRateLimit(env, request, "post-create", 20, 3600, 600)) {
    return error("Too many posts. Try again later.", 429);
  }

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const content = cleanText(body.content, 5000);
  if (!content && (!Array.isArray(body.media) || body.media.length === 0)) {
    return error("A post needs text or media");
  }

  const media = await validatePostMedia(env, user.id, body.media);
  if (media === null) return error("One or more media files are invalid or not ready");

  const visibility = ["public", "followers"].includes(body.visibility)
    ? body.visibility
    : "public";

  const id = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO social_posts(id,user_id,content,media_json,visibility)
    VALUES(?,?,?,?,?)
  `).bind(id, user.id, content, JSON.stringify(media), visibility).run();

  const row = await env.DB.prepare(
    "SELECT * FROM social_posts WHERE id=?"
  ).bind(id).first();

  return json({ success: true, post: await formatPost(row, user.id, env) }, 201);
}

async function socialFeed(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const url = new URL(request.url);
  const limit = safeLimit(url.searchParams.get("limit"), 30, 50);

  const result = await env.DB.prepare(`
    SELECT p.*
    FROM social_posts p
    WHERE
      p.user_id=?
      OR (
        p.visibility='public'
        AND p.user_id NOT IN (
          SELECT blocked_id FROM social_blocks WHERE blocker_id=?
        )
        AND p.user_id NOT IN (
          SELECT blocker_id FROM social_blocks WHERE blocked_id=?
        )
      )
      OR (
        p.visibility='followers'
        AND p.user_id IN (
          SELECT following_id FROM social_follows WHERE follower_id=?
        )
      )
    ORDER BY p.created_at DESC,p.id DESC
    LIMIT ?
  `).bind(user.id, user.id, user.id, user.id, limit).all();

  const posts = [];
  for (const row of result.results || []) {
    posts.push(await formatPost(row, user.id, env));
  }

  return json({ success: true, posts, total: posts.length });
}

async function socialUserPosts(request, env, username) {
  const viewer = await getSocialUser(request, env);
  if (!viewer) return error("Authentication required", 401);

  const target = await env.DB.prepare(`
    SELECT id FROM social_users WHERE username=? AND is_active=1
  `).bind(cleanUsername(username)).first();

  if (!target) return error("User not found", 404);

  const settings = await env.DB.prepare(
    "SELECT is_private FROM social_user_settings WHERE user_id=?"
  ).bind(target.id).first();

  const following = await env.DB.prepare(`
    SELECT 1 FROM social_follows WHERE follower_id=? AND following_id=?
  `).bind(viewer.id, target.id).first();

  if (target.id !== viewer.id && settings?.is_private && !following) {
    return json({ success: true, posts: [], privateContent: true, total: 0 });
  }

  const result = await env.DB.prepare(`
    SELECT * FROM social_posts
    WHERE user_id=?
      AND (visibility='public' OR user_id=? OR visibility='followers')
    ORDER BY created_at DESC LIMIT 50
  `).bind(target.id, viewer.id).all();

  const posts = [];
  for (const row of result.results || []) {
    if (row.visibility === "followers" && target.id !== viewer.id && !following) continue;
    posts.push(await formatPost(row, viewer.id, env));
  }

  return json({ success: true, posts, total: posts.length });
}

async function socialDeletePost(request, env, postId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const row = await env.DB.prepare(
    "SELECT id,user_id FROM social_posts WHERE id=?"
  ).bind(postId).first();

  if (!row) return error("Post not found", 404);
  if (row.user_id !== user.id) return error("You cannot delete this post", 403);

  const deletion = await env.DB.prepare(
    "DELETE FROM social_posts WHERE id=? AND user_id=?"
  ).bind(postId, user.id).run();

  if (!deletion.meta || deletion.meta.changes !== 1) {
    return error("Post could not be deleted", 409);
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM social_post_likes WHERE post_id=?").bind(postId),
    env.DB.prepare("DELETE FROM social_comments WHERE post_id=?").bind(postId),
    env.DB.prepare("DELETE FROM social_bookmarks WHERE post_id=?").bind(postId),
    env.DB.prepare("DELETE FROM social_post_views WHERE post_id=?").bind(postId)
  ]);

  const stillExists = await env.DB.prepare(
    "SELECT id FROM social_posts WHERE id=?"
  ).bind(postId).first();

  if (stillExists) return error("Post deletion was not confirmed", 500);

  return json({ success: true, deleted: true, id: postId });
}

async function socialLikePost(request, env, postId, shouldLike) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const post = await env.DB.prepare(
    "SELECT id,user_id FROM social_posts WHERE id=?"
  ).bind(postId).first();

  if (!post) return error("Post not found", 404);
  if (await isBlocked(env, user.id, post.user_id)) return error("Post unavailable", 404);

  if (shouldLike) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO social_post_likes(post_id,user_id) VALUES(?,?)
    `).bind(postId, user.id).run();

    await notify(env, post.user_id, user.id, "like", postId, "liked your post");
  } else {
    await env.DB.prepare(`
      DELETE FROM social_post_likes WHERE post_id=? AND user_id=?
    `).bind(postId, user.id).run();
  }

  const stats = await env.DB.prepare(
    "SELECT COUNT(*) AS likes FROM social_post_likes WHERE post_id=?"
  ).bind(postId).first();

  return json({
    success: true,
    liked: shouldLike,
    likes: Number(stats?.likes || 0)
  });
}

async function socialBookmark(request, env, postId, save) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const post = await env.DB.prepare(
    "SELECT id FROM social_posts WHERE id=?"
  ).bind(postId).first();

  if (!post) return error("Post not found", 404);

  if (save) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO social_bookmarks(user_id,post_id) VALUES(?,?)
    `).bind(user.id, postId).run();
  } else {
    await env.DB.prepare(`
      DELETE FROM social_bookmarks WHERE user_id=? AND post_id=?
    `).bind(user.id, postId).run();
  }

  return json({ success: true, bookmarked: save });
}

async function socialListBookmarks(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const result = await env.DB.prepare(`
    SELECT p.*
    FROM social_bookmarks b
    JOIN social_posts p ON p.id=b.post_id
    WHERE b.user_id=?
    ORDER BY b.created_at DESC LIMIT 50
  `).bind(user.id).all();

  const posts = [];
  for (const row of result.results || []) {
    posts.push(await formatPost(row, user.id, env));
  }

  return json({ success: true, posts, total: posts.length });
}

async function socialViewPost(request, env, postId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const post = await env.DB.prepare(
    "SELECT id FROM social_posts WHERE id=?"
  ).bind(postId).first();

  if (!post) return error("Post not found", 404);

  await env.DB.prepare(`
    INSERT OR IGNORE INTO social_post_views(post_id,user_id) VALUES(?,?)
  `).bind(postId, user.id).run();

  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM social_post_views WHERE post_id=?"
  ).bind(postId).first();

  return json({ success: true, views: Number(count?.total || 0) });
}

async function socialListComments(request, env, postId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const post = await env.DB.prepare(
    "SELECT id FROM social_posts WHERE id=?"
  ).bind(postId).first();

  if (!post) return error("Post not found", 404);

  const result = await env.DB.prepare(`
    SELECT c.id,c.content,c.created_at,u.username,u.display_name,u.avatar_url
    FROM social_comments c
    JOIN social_users u ON u.id=c.user_id
    WHERE c.post_id=?
    ORDER BY c.created_at ASC LIMIT 100
  `).bind(postId).all();

  const comments = (result.results || []).map(row => ({
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    author: {
      username: row.username,
      displayName: row.display_name || "",
      avatarUrl: row.avatar_url || ""
    }
  }));

  return json({ success: true, comments, total: comments.length });
}

async function socialCreateComment(request, env, postId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const content = cleanText(body.content, 1000);
  if (!content) return error("Comment cannot be empty");

  const post = await env.DB.prepare(
    "SELECT id,user_id FROM social_posts WHERE id=?"
  ).bind(postId).first();

  if (!post) return error("Post not found", 404);
  if (await isBlocked(env, user.id, post.user_id)) return error("Post unavailable", 404);

  const id = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO social_comments(id,post_id,user_id,content)
    VALUES(?,?,?,?)
  `).bind(id, postId, user.id, content).run();

  await notify(env, post.user_id, user.id, "comment", postId, "commented on your post");

  return json({
    success: true,
    comment: {
      id,
      content,
      createdAt: new Date().toISOString(),
      author: {
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl
      }
    }
  }, 201);
}

async function socialDeleteComment(request, env, commentId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const result = await env.DB.prepare(
    "DELETE FROM social_comments WHERE id=? AND user_id=?"
  ).bind(commentId, user.id).run();

  if (!result.meta || result.meta.changes === 0) {
    return error("Comment not found", 404);
  }

  return json({ success: true, deleted: true });
}

async function socialFollow(request, env, username, follow) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const target = await env.DB.prepare(`
    SELECT id,username FROM social_users
    WHERE username=? AND is_active=1
  `).bind(cleanUsername(username)).first();

  if (!target) return error("User not found", 404);
  if (target.id === user.id) return error("You cannot follow yourself", 400);
  if (await isBlocked(env, user.id, target.id)) return error("User unavailable", 404);

  const settings = await env.DB.prepare(
    "SELECT is_private FROM social_user_settings WHERE user_id=?"
  ).bind(target.id).first();

  if (follow && settings?.is_private) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO social_follow_requests(id,requester_id,target_id)
      VALUES(?,?,?)
    `).bind(crypto.randomUUID(), user.id, target.id).run();

    await notify(env, target.id, user.id, "follow_request", user.id, "requested to follow you");

    return json({ success: true, following: false, requestPending: true });
  }

  if (follow) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO social_follows(follower_id,following_id)
      VALUES(?,?)
    `).bind(user.id, target.id).run();

    await notify(env, target.id, user.id, "follow", user.id, "started following you");
  } else {
    await env.DB.prepare(`
      DELETE FROM social_follows
      WHERE follower_id=? AND following_id=?
    `).bind(user.id, target.id).run();

    await env.DB.prepare(`
      DELETE FROM social_follow_requests
      WHERE requester_id=? AND target_id=?
    `).bind(user.id, target.id).run();
  }

  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM social_follows WHERE following_id=?"
  ).bind(target.id).first();

  return json({
    success: true,
    following: follow,
    username: target.username,
    followers: Number(count?.total || 0)
  });
}

async function socialFollowRequests(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const result = await env.DB.prepare(`
    SELECT r.id,r.created_at,u.id AS user_id,u.username,u.display_name,u.avatar_url
    FROM social_follow_requests r
    JOIN social_users u ON u.id=r.requester_id
    WHERE r.target_id=?
    ORDER BY r.created_at DESC LIMIT 100
  `).bind(user.id).all();

  return json({
    success: true,
    requests: (result.results || []).map(row => ({
      id: row.id,
      createdAt: row.created_at,
      user: {
        id: row.user_id,
        username: row.username,
        displayName: row.display_name || "",
        avatarUrl: row.avatar_url || ""
      }
    }))
  });
}

async function socialFollowRequestAction(request, env, requestId, accept) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const row = await env.DB.prepare(`
    SELECT id,requester_id,target_id
    FROM social_follow_requests
    WHERE id=? AND target_id=?
  `).bind(requestId, user.id).first();

  if (!row) return error("Follow request not found", 404);

  if (accept) {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT OR IGNORE INTO social_follows(follower_id,following_id)
        VALUES(?,?)
      `).bind(row.requester_id, user.id),
      env.DB.prepare(
        "DELETE FROM social_follow_requests WHERE id=?"
      ).bind(requestId)
    ]);

    await notify(env, row.requester_id, user.id, "follow_accepted", user.id, "accepted your follow request");
  } else {
    await env.DB.prepare(
      "DELETE FROM social_follow_requests WHERE id=?"
    ).bind(requestId).run();
  }

  return json({ success: true, accepted: accept });
}

async function socialFollowList(request, env, username, kind) {
  const viewer = await getSocialUser(request, env);
  if (!viewer) return error("Authentication required", 401);

  const target = await env.DB.prepare(
    "SELECT id FROM social_users WHERE username=? AND is_active=1"
  ).bind(cleanUsername(username)).first();

  if (!target) return error("User not found", 404);

  const result = await env.DB.prepare(`
    SELECT u.id,u.username,u.display_name,u.avatar_url,u.pi_verified
    FROM social_follows f
    JOIN social_users u ON u.id=${
      kind === "followers" ? "f.follower_id" : "f.following_id"
    }
    WHERE f.${kind === "followers" ? "following_id" : "follower_id"}=?
    ORDER BY f.created_at DESC LIMIT 100
  `).bind(target.id).all();

  const users = (result.results || []).map(row => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name || "",
    avatarUrl: row.avatar_url || "",
    piVerified: Boolean(row.pi_verified)
  }));

  return json({ success: true, users, total: users.length });
}

async function socialPrivacy(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const current = await env.DB.prepare(
    "SELECT * FROM social_user_settings WHERE user_id=?"
  ).bind(user.id).first();

  const isPrivate = body.isPrivate === undefined
    ? Number(current?.is_private || 0)
    : (body.isPrivate ? 1 : 0);

  const allowMessages = ["everyone", "followers", "none"].includes(body.allowMessages)
    ? body.allowMessages
    : current?.allow_messages || "everyone";

  const allowComments = ["everyone", "followers", "none"].includes(body.allowComments)
    ? body.allowComments
    : current?.allow_comments || "everyone";

  const online = body.showOnlineStatus === undefined
    ? Number(current?.show_online_status ?? 1)
    : (body.showOnlineStatus ? 1 : 0);

  const activity = body.showActivityStatus === undefined
    ? Number(current?.show_activity_status ?? 1)
    : (body.showActivityStatus ? 1 : 0);

  const language = ["en", "fa"].includes(body.language)
    ? body.language
    : current?.language || "en";

  const theme = ["dark", "light", "system"].includes(body.theme)
    ? body.theme
    : current?.theme || "dark";

  await env.DB.prepare(`
    INSERT INTO social_user_settings(
      user_id,is_private,allow_messages,allow_comments,
      show_online_status,show_activity_status,language,theme,updated_at
    )
    VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      is_private=excluded.is_private,
      allow_messages=excluded.allow_messages,
      allow_comments=excluded.allow_comments,
      show_online_status=excluded.show_online_status,
      show_activity_status=excluded.show_activity_status,
      language=excluded.language,
      theme=excluded.theme,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    user.id,
    isPrivate,
    allowMessages,
    allowComments,
    online,
    activity,
    language,
    theme
  ).run();

  return json({
    success: true,
    settings: {
      isPrivate: Boolean(isPrivate),
      allowMessages,
      allowComments,
      showOnlineStatus: Boolean(online),
      showActivityStatus: Boolean(activity),
      language,
      theme
    }
  });
}

async function socialBlock(request, env, username, block) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const target = await env.DB.prepare(
    "SELECT id FROM social_users WHERE username=? AND is_active=1"
  ).bind(cleanUsername(username)).first();

  if (!target) return error("User not found", 404);
  if (target.id === user.id) return error("Invalid user", 400);

  if (block) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO social_blocks(blocker_id,blocked_id) VALUES(?,?)"
      ).bind(user.id, target.id),
      env.DB.prepare(
        "DELETE FROM social_follows WHERE follower_id=? AND following_id=?"
      ).bind(user.id, target.id),
      env.DB.prepare(
        "DELETE FROM social_follows WHERE follower_id=? AND following_id=?"
      ).bind(target.id, user.id),
      env.DB.prepare(
        "DELETE FROM social_follow_requests WHERE requester_id=? AND target_id=?"
      ).bind(user.id, target.id),
      env.DB.prepare(
        "DELETE FROM social_follow_requests WHERE requester_id=? AND target_id=?"
      ).bind(target.id, user.id)
    ]);
  } else {
    await env.DB.prepare(
      "DELETE FROM social_blocks WHERE blocker_id=? AND blocked_id=?"
    ).bind(user.id, target.id).run();
  }

  return json({ success: true, blocked: block });
}

async function socialReport(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const type = String(body.targetType || "");
  const targetId = cleanText(body.targetId, 150);
  const reason = cleanText(body.reason, 1000);

  if (!["user", "post", "comment", "message", "channel"].includes(type)) {
    return error("Invalid report type");
  }
  if (!targetId || !reason) return error("Target and reason are required");

  await env.DB.prepare(`
    INSERT INTO social_reports(id,reporter_id,target_type,target_id,reason)
    VALUES(?,?,?,?,?)
  `).bind(crypto.randomUUID(), user.id, type, targetId, reason).run();

  return json({ success: true, submitted: true }, 201);
}

async function socialNotifications(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const url = new URL(request.url);
  const limit = safeLimit(url.searchParams.get("limit"), 30, 100);

  const result = await env.DB.prepare(`
    SELECT n.id,n.type,n.target_id,n.message,n.is_read,n.created_at,
      u.username,u.display_name,u.avatar_url
    FROM social_notifications n
    LEFT JOIN social_users u ON u.id=n.actor_id
    WHERE n.user_id=?
    ORDER BY n.created_at DESC LIMIT ?
  `).bind(user.id, limit).all();

  return json({
    success: true,
    notifications: (result.results || []).map(row => ({
      id: row.id,
      type: row.type,
      targetId: row.target_id,
      message: row.message,
      isRead: Boolean(row.is_read),
      createdAt: row.created_at,
      actor: row.username ? {
        username: row.username,
        displayName: row.display_name || "",
        avatarUrl: row.avatar_url || ""
      } : null
    }))
  });
}

async function socialReadNotifications(request, env, id = null) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  if (id) {
    await env.DB.prepare(`
      UPDATE social_notifications SET is_read=1
      WHERE id=? AND user_id=?
    `).bind(id, user.id).run();
  } else {
    await env.DB.prepare(`
      UPDATE social_notifications SET is_read=1 WHERE user_id=?
    `).bind(user.id).run();
  }

  return json({ success: true, read: true });
}

async function socialStories(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const now = new Date().toISOString();
  await env.DB.prepare(
    "DELETE FROM social_stories WHERE expires_at<=?"
  ).bind(now).run();

  const result = await env.DB.prepare(`
    SELECT s.id,s.user_id,s.media_url,s.media_type,s.caption,s.created_at,s.expires_at,
      u.username,u.display_name,u.avatar_url,
      EXISTS(
        SELECT 1 FROM social_story_views v
        WHERE v.story_id=s.id AND v.user_id=?
      ) AS viewed
    FROM social_stories s
    JOIN social_users u ON u.id=s.user_id
    WHERE s.expires_at>?
      AND (
        s.user_id=?
        OR s.user_id IN (
          SELECT following_id FROM social_follows WHERE follower_id=?
        )
      )
    ORDER BY s.created_at DESC LIMIT 100
  `).bind(user.id, now, user.id, user.id).all();

  return json({
    success: true,
    stories: (result.results || []).map(row => ({
      id: row.id,
      mediaUrl: row.media_url,
      mediaType: row.media_type,
      caption: row.caption,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      viewed: Boolean(row.viewed),
      author: {
        username: row.username,
        displayName: row.display_name || "",
        avatarUrl: row.avatar_url || ""
      }
    }))
  });
}

async function socialCreateStory(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const mediaUrl = String(body.mediaUrl || "").trim();
  const mediaType = String(body.mediaType || "").toLowerCase();

  if (!validHttpsUrl(mediaUrl)) return error("Invalid media URL");
  if (!["image", "video"].includes(mediaType)) return error("Invalid story media type");

  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(`
    INSERT INTO social_stories(id,user_id,media_url,media_type,caption,expires_at)
    VALUES(?,?,?,?,?,?)
  `).bind(
    id,
    user.id,
    mediaUrl,
    mediaType,
    cleanText(body.caption, 500),
    expiresAt
  ).run();

  return json({
    success: true,
    story: { id, mediaUrl, mediaType, expiresAt }
  }, 201);
}

async function socialDeleteStory(request, env, id) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const result = await env.DB.prepare(
    "DELETE FROM social_stories WHERE id=? AND user_id=?"
  ).bind(id, user.id).run();

  if (!result.meta || result.meta.changes === 0) return error("Story not found", 404);
  return json({ success: true, deleted: true });
}

async function socialViewStory(request, env, id) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const story = await env.DB.prepare(
    "SELECT id,user_id FROM social_stories WHERE id=? AND expires_at>?"
  ).bind(id, new Date().toISOString()).first();

  if (!story) return error("Story not found", 404);

  await env.DB.prepare(`
    INSERT OR IGNORE INTO social_story_views(story_id,user_id) VALUES(?,?)
  `).bind(id, user.id).run();

  return json({ success: true, viewed: true });
}

async function socialReactStory(request, env, id) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const reaction = cleanText(body.reaction, 20);
  if (!reaction) return error("Reaction is required");

  const story = await env.DB.prepare(
    "SELECT id,user_id FROM social_stories WHERE id=? AND expires_at>?"
  ).bind(id, new Date().toISOString()).first();

  if (!story) return error("Story not found", 404);

  await env.DB.prepare(`
    INSERT INTO social_story_reactions(story_id,user_id,reaction)
    VALUES(?,?,?)
    ON CONFLICT(story_id,user_id) DO UPDATE SET reaction=excluded.reaction
  `).bind(id, user.id, reaction).run();

  await notify(env, story.user_id, user.id, "story_reaction", id, reaction);

  return json({ success: true, reaction });
}

async function socialStartConversation(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const targetUsername = cleanUsername(body.username);
  if (!targetUsername) return error("Username is required");

  const target = await env.DB.prepare(`
    SELECT id,username FROM social_users
    WHERE username=? AND is_active=1
  `).bind(targetUsername).first();

  if (!target) return error("User not found", 404);
  if (target.id === user.id) return error("Cannot message yourself", 400);
  if (await isBlocked(env, user.id, target.id)) return error("User unavailable", 404);

  const settings = await env.DB.prepare(
    "SELECT allow_messages FROM social_user_settings WHERE user_id=?"
  ).bind(target.id).first();

  if (settings?.allow_messages === "none") return error("This user does not accept messages", 403);

  if (settings?.allow_messages === "followers") {
    const follows = await env.DB.prepare(`
      SELECT 1 FROM social_follows
      WHERE follower_id=? AND following_id=?
    `).bind(user.id, target.id).first();

    if (!follows) return error("Only followers can message this user", 403);
  }

  const existing = await env.DB.prepare(`
    SELECT c.id
    FROM social_conversations c
    JOIN social_conversation_members a ON a.conversation_id=c.id
    JOIN social_conversation_members b ON b.conversation_id=c.id
    WHERE c.type='private'
      AND a.user_id=? AND b.user_id=?
    LIMIT 1
  `).bind(user.id, target.id).first();

  if (existing) return json({ success: true, conversationId: existing.id });

  const id = crypto.randomUUID();

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO social_conversations(id,type,owner_id)
      VALUES(?,'private',?)
    `).bind(id, user.id),

    env.DB.prepare(`
      INSERT INTO social_conversation_members(conversation_id,user_id,role)
      VALUES(?,?,'member'),(?,?,'member')
    `).bind(id, user.id, id, target.id)
  ]);

  return json({ success: true, conversationId: id }, 201);
}

async function socialListConversations(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const result = await env.DB.prepare(`
    SELECT c.id,c.type,c.title,c.updated_at,
      (
        SELECT m.content FROM social_messages m
        WHERE m.conversation_id=c.id AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC LIMIT 1
      ) AS last_message,
      (
        SELECT m.created_at FROM social_messages m
        WHERE m.conversation_id=c.id
        ORDER BY m.created_at DESC LIMIT 1
      ) AS last_message_at
    FROM social_conversations c
    JOIN social_conversation_members cm ON cm.conversation_id=c.id
    WHERE cm.user_id=?
    ORDER BY COALESCE(last_message_at,c.updated_at) DESC
    LIMIT 100
  `).bind(user.id).all();

  const conversations = [];

  for (const row of result.results || []) {
    const members = await env.DB.prepare(`
      SELECT u.id,u.username,u.display_name,u.avatar_url,cm.role
      FROM social_conversation_members cm
      JOIN social_users u ON u.id=cm.user_id
      WHERE cm.conversation_id=?
      LIMIT 100
    `).bind(row.id).all();

    conversations.push({
      id: row.id,
      type: row.type,
      title: row.title,
      lastMessage: row.last_message || "",
      lastMessageAt: row.last_message_at || row.updated_at,
      members: (members.results || []).map(member => ({
        id: member.id,
        username: member.username,
        displayName: member.display_name || "",
        avatarUrl: member.avatar_url || "",
        role: member.role
      }))
    });
  }

  return json({ success: true, conversations });
}

async function isConversationMember(env, conversationId, userId) {
  const row = await env.DB.prepare(`
    SELECT role FROM social_conversation_members
    WHERE conversation_id=? AND user_id=?
  `).bind(conversationId, userId).first();

  return row || null;
}

async function socialConversationMessages(request, env, conversationId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const member = await isConversationMember(env, conversationId, user.id);
  if (!member) return error("Conversation not found", 404);

  const url = new URL(request.url);
  const limit = safeLimit(url.searchParams.get("limit"), 50, 100);

  const result = await env.DB.prepare(`
    SELECT m.id,m.sender_id,m.content,m.media_json,m.reply_to,
      m.forwarded_from,m.edited_at,m.deleted_at,m.created_at,
      u.username,u.display_name,u.avatar_url
    FROM social_messages m
    JOIN social_users u ON u.id=m.sender_id
    WHERE m.conversation_id=?
    ORDER BY m.created_at DESC LIMIT ?
  `).bind(conversationId, limit).all();

  const messages = (result.results || []).reverse().map(row => ({
    id: row.id,
    senderId: row.sender_id,
    content: row.deleted_at ? "Message deleted" : row.content,
    media: row.deleted_at ? [] : JSON.parse(row.media_json || "[]"),
    replyTo: row.reply_to,
    forwardedFrom: row.forwarded_from,
    editedAt: row.edited_at,
    deleted: Boolean(row.deleted_at),
    createdAt: row.created_at,
    author: {
      username: row.username,
      displayName: row.display_name || "",
      avatarUrl: row.avatar_url || ""
    },
    isMine: row.sender_id === user.id
  }));

  await env.DB.prepare(`
    UPDATE social_conversation_members
    SET last_read_at=CURRENT_TIMESTAMP
    WHERE conversation_id=? AND user_id=?
  `).bind(conversationId, user.id).run();

  return json({ success: true, messages });
}

async function socialSendMessage(request, env, conversationId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const member = await isConversationMember(env, conversationId, user.id);
  if (!member) return error("Conversation not found", 404);

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const content = cleanText(body.content, 10000);
  const media = Array.isArray(body.media) ? body.media.slice(0, 10) : [];

  if (!content && media.length === 0) return error("Message cannot be empty");

  for (const item of media) {
    if (!item || !validHttpsUrl(item.url)) return error("Invalid message attachment");
  }

  const replyTo = body.replyTo ? cleanText(body.replyTo, 150) : null;
  if (replyTo) {
    const reply = await env.DB.prepare(`
      SELECT id FROM social_messages
      WHERE id=? AND conversation_id=?
    `).bind(replyTo, conversationId).first();

    if (!reply) return error("Reply message not found", 404);
  }

  const id = crypto.randomUUID();

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO social_messages(
        id,conversation_id,sender_id,content,media_json,reply_to
      )
      VALUES(?,?,?,?,?,?)
    `).bind(id, conversationId, user.id, content, JSON.stringify(media), replyTo),

    env.DB.prepare(`
      UPDATE social_conversations SET updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).bind(conversationId)
  ]);

  const members = await env.DB.prepare(`
    SELECT user_id FROM social_conversation_members
    WHERE conversation_id=? AND user_id!=?
  `).bind(conversationId, user.id).all();

  for (const row of members.results || []) {
    await notify(env, row.user_id, user.id, "message", conversationId, "sent you a message");
  }

  return json({
    success: true,
    message: {
      id,
      conversationId,
      senderId: user.id,
      content,
      media,
      replyTo,
      createdAt: new Date().toISOString()
    }
  }, 201);
}

async function socialEditMessage(request, env, messageId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const content = cleanText(body.content, 10000);
  if (!content) return error("Message cannot be empty");

  const result = await env.DB.prepare(`
    UPDATE social_messages
    SET content=?,edited_at=CURRENT_TIMESTAMP
    WHERE id=? AND sender_id=? AND deleted_at IS NULL
  `).bind(content, messageId, user.id).run();

  if (!result.meta || result.meta.changes === 0) {
    return error("Message not found or not editable", 404);
  }

  return json({ success: true, edited: true });
}

async function socialDeleteMessage(request, env, messageId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const result = await env.DB.prepare(`
    UPDATE social_messages
    SET content='',media_json='[]',deleted_at=CURRENT_TIMESTAMP
    WHERE id=? AND sender_id=? AND deleted_at IS NULL
  `).bind(messageId, user.id).run();

  if (!result.meta || result.meta.changes === 0) {
    return error("Message not found or not deletable", 404);
  }

  return json({ success: true, deleted: true });
}

async function socialCreateGroup(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const title = cleanText(body.title, 100);
  const usernames = Array.isArray(body.members)
    ? [...new Set(body.members.map(cleanUsername).filter(Boolean))].slice(0, 99)
    : [];

  if (!title) return error("Group name is required");

  const id = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO social_conversations(id,type,title,owner_id)
    VALUES(?,'group',?,?)
  `).bind(id, title, user.id).run();

  await env.DB.prepare(`
    INSERT INTO social_conversation_members(conversation_id,user_id,role)
    VALUES(?,?,'owner')
  `).bind(id, user.id).run();

  for (const username of usernames) {
    if (username === user.username) continue;

    const target = await env.DB.prepare(
      "SELECT id FROM social_users WHERE username=? AND is_active=1"
    ).bind(username).first();

    if (target && !(await isBlocked(env, user.id, target.id))) {
      await env.DB.prepare(`
        INSERT OR IGNORE INTO social_conversation_members(
          conversation_id,user_id,role
        ) VALUES(?,?,'member')
      `).bind(id, target.id).run();
    }
  }

  return json({ success: true, group: { id, title } }, 201);
}

async function socialGroupInvite(request, env, conversationId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const member = await isConversationMember(env, conversationId, user.id);
  if (!member || !["owner", "admin"].includes(member.role)) {
    return error("Only group admins can create invite links", 403);
  }

  const code = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));

  await env.DB.prepare(`
    INSERT INTO social_group_invites(id,conversation_id,created_by,invite_code)
    VALUES(?,?,?,?)
  `).bind(crypto.randomUUID(), conversationId, user.id, code).run();

  return json({ success: true, inviteCode: code });
}

async function socialJoinGroup(request, env, code) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const invite = await env.DB.prepare(`
    SELECT conversation_id FROM social_group_invites
    WHERE invite_code=? AND (expires_at IS NULL OR expires_at>?)
  `).bind(code, new Date().toISOString()).first();

  if (!invite) return error("Invalid or expired invite link", 404);

  await env.DB.prepare(`
    INSERT OR IGNORE INTO social_conversation_members(
      conversation_id,user_id,role
    ) VALUES(?,?,'member')
  `).bind(invite.conversation_id, user.id).run();

  return json({
    success: true,
    conversationId: invite.conversation_id,
    joined: true
  });
}

async function socialCreateChannel(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const title = cleanText(body.title, 100);
  const description = cleanText(body.description, 1000);
  const username = body.username ? cleanUsername(body.username) : null;
  const isPrivate = body.isPrivate ? 1 : 0;

  if (!title) return error("Channel name is required");
  if (username && !validUsername(username)) return error("Invalid channel username");

  const id = crypto.randomUUID();
  const inviteCode = isPrivate
    ? toBase64Url(crypto.getRandomValues(new Uint8Array(18)))
    : null;

  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO social_channels(
          id,owner_id,title,description,username,is_private,invite_code
        )
        VALUES(?,?,?,?,?,?,?)
      `).bind(id, user.id, title, description, username, isPrivate, inviteCode),

      env.DB.prepare(`
        INSERT INTO social_channel_members(channel_id,user_id,role)
        VALUES(?,?,'owner')
      `).bind(id, user.id)
    ]);
  } catch {
    return error("Channel username is already taken", 409);
  }

  return json({
    success: true,
    channel: { id, title, description, username, isPrivate: Boolean(isPrivate), inviteCode }
  }, 201);
}

async function socialListChannels(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const result = await env.DB.prepare(`
    SELECT c.id,c.title,c.description,c.username,c.is_private,c.created_at,
      m.role,
      (SELECT COUNT(*) FROM social_channel_members x WHERE x.channel_id=c.id) AS members
    FROM social_channels c
    JOIN social_channel_members m ON m.channel_id=c.id
    WHERE m.user_id=?
    ORDER BY c.created_at DESC LIMIT 100
  `).bind(user.id).all();

  return json({
    success: true,
    channels: (result.results || []).map(row => ({
      id: row.id,
      title: row.title,
      description: row.description,
      username: row.username,
      isPrivate: Boolean(row.is_private),
      role: row.role,
      members: Number(row.members),
      createdAt: row.created_at
    }))
  });
}

async function socialJoinChannel(request, env, channelId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const channel = await env.DB.prepare(
    "SELECT id,is_private,invite_code FROM social_channels WHERE id=?"
  ).bind(channelId).first();

  if (!channel) return error("Channel not found", 404);

  const body = await readBody(request) || {};
  if (channel.is_private && body.inviteCode !== channel.invite_code) {
    return error("Invalid channel invitation", 403);
  }

  await env.DB.prepare(`
    INSERT OR IGNORE INTO social_channel_members(channel_id,user_id,role)
    VALUES(?,?,'subscriber')
  `).bind(channelId, user.id).run();

  return json({ success: true, joined: true });
}

async function socialChannelPosts(request, env, channelId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const member = await env.DB.prepare(`
    SELECT role FROM social_channel_members
    WHERE channel_id=? AND user_id=?
  `).bind(channelId, user.id).first();

  if (!member) return error("Channel not found", 404);

  const result = await env.DB.prepare(`
    SELECT p.id,p.content,p.media_json,p.created_at,p.edited_at,
      u.username,u.display_name,u.avatar_url,
      EXISTS(
        SELECT 1 FROM social_channel_pins pin
        WHERE pin.channel_id=p.channel_id AND pin.post_id=p.id
      ) AS pinned
    FROM social_channel_posts p
    JOIN social_users u ON u.id=p.sender_id
    WHERE p.channel_id=?
    ORDER BY p.created_at DESC LIMIT 100
  `).bind(channelId).all();

  return json({
    success: true,
    posts: (result.results || []).map(row => ({
      id: row.id,
      content: row.content,
      media: JSON.parse(row.media_json || "[]"),
      createdAt: row.created_at,
      editedAt: row.edited_at,
      pinned: Boolean(row.pinned),
      author: {
        username: row.username,
        displayName: row.display_name || "",
        avatarUrl: row.avatar_url || ""
      }
    }))
  });
}

async function socialChannelPost(request, env, channelId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const member = await env.DB.prepare(`
    SELECT role FROM social_channel_members
    WHERE channel_id=? AND user_id=?
  `).bind(channelId, user.id).first();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return error("Only channel admins can publish", 403);
  }

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const content = cleanText(body.content, 10000);
  const media = Array.isArray(body.media) ? body.media.slice(0, 10) : [];

  if (!content && media.length === 0) return error("Post cannot be empty");

  for (const item of media) {
    if (!item || !validHttpsUrl(item.url)) return error("Invalid attachment");
  }

  const id = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO social_channel_posts(id,channel_id,sender_id,content,media_json)
    VALUES(?,?,?,?,?)
  `).bind(id, channelId, user.id, content, JSON.stringify(media)).run();

  return json({ success: true, post: { id, content, media } }, 201);
}

async function socialPinChannelPost(request, env, channelId, postId, pin) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const member = await env.DB.prepare(`
    SELECT role FROM social_channel_members
    WHERE channel_id=? AND user_id=?
  `).bind(channelId, user.id).first();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return error("Admin permission required", 403);
  }

  if (pin) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO social_channel_pins(channel_id,post_id)
      VALUES(?,?)
    `).bind(channelId, postId).run();
  } else {
    await env.DB.prepare(`
      DELETE FROM social_channel_pins
      WHERE channel_id=? AND post_id=?
    `).bind(channelId, postId).run();
  }

  return json({ success: true, pinned: pin });
}

async function socialCreateBot(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const name = cleanText(body.name, 80);
  const username = cleanUsername(body.username);
  const description = cleanText(body.description, 500);

  if (!name || !validUsername(username)) return error("Invalid bot name or username");

  const token = createSessionToken();
  const tokenHash = await sha256(token);
  const id = crypto.randomUUID();

  try {
    await env.DB.prepare(`
      INSERT INTO social_bots(id,owner_id,name,username,description,token_hash)
      VALUES(?,?,?,?,?,?)
    `).bind(id, user.id, name, username, description, tokenHash).run();
  } catch {
    return error("Bot username is already taken", 409);
  }

  return json({
    success: true,
    bot: { id, name, username, description },
    token
  }, 201);
}

async function socialListBots(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const result = await env.DB.prepare(`
    SELECT id,name,username,description,is_active,created_at
    FROM social_bots WHERE owner_id=?
    ORDER BY created_at DESC LIMIT 100
  `).bind(user.id).all();

  return json({ success: true, bots: result.results || [] });
}

async function rapidfileRequest(env, endpoint, options = {}) {
  const key = env.RAPIDFILE_API_KEY;

  if (typeof key !== "string" || key.length < 10) {
    throw new Error("Rapidfile API secret is not configured");
  }

  const response = await fetch(`${RAPIDFILE_API}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(options.headers || {})
    }
  });

  let data = {};
  try {
    data = await response.json();
  } catch {}

  if (!response.ok) {
    const err = new Error(data.message || data.error || "Rapidfile request failed");
    err.status = response.status;
    throw err;
  }

  return data;
}

function cleanUploadName(value) {
  const name = String(value || "")
    .trim()
    .replace(/[\/\\]/g, "_")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ");

  return name && name.length <= 180 ? name : null;
}

function validUploadType(type) {
  const value = String(type || "").trim().toLowerCase();

  if (!value || value.length > 120) return false;
  if (value.startsWith("image/") && value !== "image/svg+xml") return true;
  if (value.startsWith("video/") || value.startsWith("audio/")) return true;

  return [
    "application/pdf",
    "text/plain",
    "text/csv",
    "application/rtf",
    "application/zip",
    "application/x-zip-compressed",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ].includes(value);
}

function formatUpload(row) {
  return {
    id: row.id,
    name: row.name,
    size: Number(row.size),
    type: row.mime_type,
    visibility: row.acl,
    status: row.status,
    url: row.acl === "public" ? (row.url || "") : "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function socialCreateUpload(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  if (!await checkRateLimit(env, request, "upload-create", 30, 3600, 900)) {
    return error("Too many upload requests. Try again later.", 429);
  }

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const name = cleanUploadName(body.name);
  const size = Number(body.size);
  const type = String(body.type || "").trim().toLowerCase();
  const visibility = String(body.visibility || "private").toLowerCase();

  if (!name) return error("Invalid file name");
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) {
    return error("File size must be between 1 byte and 512 MB", 413);
  }
  if (!validUploadType(type)) return error("This file type is not allowed", 415);
  if (!["public", "private"].includes(visibility)) return error("Invalid file visibility");

  const fileId = crypto.randomUUID();

  try {
    const result = await rapidfileRequest(env, "/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        size,
        type,
        acl: visibility,
        customId: fileId,
        metadata: {
          userId: user.id,
          username: user.username,
          application: "MEHRAN MSH"
        }
      })
    });

    if (!result.file?.id || !result.upload?.url) {
      throw new Error("Invalid Rapidfile upload response");
    }

    await env.DB.prepare(`
      INSERT INTO social_uploads(
        id,user_id,name,size,mime_type,acl,status,url
      )
      VALUES(?,?,?,?,?,?,'uploading',?)
    `).bind(
      result.file.id,
      user.id,
      name,
      size,
      type,
      visibility,
      visibility === "public" ? (result.file.url || "") : null
    ).run();

    return json({
      success: true,
      file: {
        id: result.file.id,
        name,
        size,
        type,
        visibility,
        status: "uploading",
        url: visibility === "public" ? (result.file.url || "") : ""
      },
      upload: result.upload
    }, 201);
  } catch (err) {
    console.error("Upload creation failed:", err);
    return error("Could not create upload. Please try again.", 502);
  }
}

async function socialCompleteUpload(request, env, id) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const row = await env.DB.prepare(`
    SELECT * FROM social_uploads WHERE id=? AND user_id=?
  `).bind(id, user.id).first();

  if (!row) return error("File not found", 404);

  try {
    const result = await rapidfileRequest(
      env,
      `/files/${encodeURIComponent(id)}`,
      { method: "GET" }
    );

    const file = result.file;

    if (!file || file.id !== id) return error("File verification failed", 502);
    if (file.metadata?.userId !== user.id) {
      return error("File ownership verification failed", 403);
    }
    if (file.status !== "ready") return error("Upload is not finished yet", 409);

    await env.DB.prepare(`
      UPDATE social_uploads
      SET status='ready',url=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND user_id=?
    `).bind(
      row.acl === "public" ? (file.url || null) : null,
      id,
      user.id
    ).run();

    const updated = await env.DB.prepare(
      "SELECT * FROM social_uploads WHERE id=? AND user_id=?"
    ).bind(id, user.id).first();

    return json({ success: true, file: formatUpload(updated) });
  } catch (err) {
    console.error("Upload verification failed:", err);
    return error("Could not verify uploaded file", 502);
  }
}

async function socialListUploads(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const result = await env.DB.prepare(`
    SELECT * FROM social_uploads
    WHERE user_id=? ORDER BY created_at DESC LIMIT 100
  `).bind(user.id).all();

  const files = (result.results || []).map(formatUpload);
  return json({ success: true, files, total: files.length });
}

async function socialGetUploadUrl(request, env, id) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const row = await env.DB.prepare(`
    SELECT * FROM social_uploads WHERE id=? AND user_id=?
  `).bind(id, user.id).first();

  if (!row) return error("File not found", 404);
  if (row.status !== "ready") return error("File is not ready", 409);

  if (row.acl === "public") {
    if (!row.url) return error("Public file URL is unavailable", 404);
    return json({ success: true, url: row.url, visibility: "public" });
  }

  try {
    const result = await rapidfileRequest(
      env,
      `/files/${encodeURIComponent(id)}/signed-url`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: 3600 })
      }
    );

    if (!result.url || !validHttpsUrl(result.url)) {
      throw new Error("Signed URL missing or invalid");
    }

    return json({
      success: true,
      url: result.url,
      visibility: "private",
      expiresAt: result.expiresAt || null
    });
  } catch (err) {
    console.error("Signed URL error:", err);
    return error("Could not create private file link", 502);
  }
}

async function socialDeleteUpload(request, env, id) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const row = await env.DB.prepare(`
    SELECT id FROM social_uploads WHERE id=? AND user_id=?
  `).bind(id, user.id).first();

  if (!row) return error("File not found", 404);

  try {
    await rapidfileRequest(
      env,
      `/files/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );

    await env.DB.prepare(
      "DELETE FROM social_uploads WHERE id=? AND user_id=?"
    ).bind(id, user.id).run();

    return json({ success: true, deleted: true, id });
  } catch (err) {
    console.error("Upload deletion failed:", err);
    return error("Could not delete file from storage", 502);
  }
}

async function fetchPiUser(accessToken) {
  if (
    typeof accessToken !== "string" ||
    accessToken.length < 10 ||
    accessToken.length > 4096
  ) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(PI_ME_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) return null;

    const user = await response.json();
    if (typeof user.uid !== "string" || typeof user.username !== "string") {
      return null;
    }

    return user;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureAdminSessionTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS admin_sessions(
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
      uid TEXT NOT NULL, username TEXT NOT NULL COLLATE NOCASE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS admin_audit_log(
      id TEXT PRIMARY KEY, admin_uid TEXT NOT NULL, admin_username TEXT NOT NULL,
      action TEXT NOT NULL, target_type TEXT NOT NULL DEFAULT '',
      target_id TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  try { await env.DB.prepare("ALTER TABLE social_reports ADD COLUMN status TEXT NOT NULL DEFAULT 'open'").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE social_reports ADD COLUMN resolved_at TEXT").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE social_reports ADD COLUMN resolved_by TEXT").run(); } catch {}
}

async function writeAdminAudit(env, admin, action, targetType = "", targetId = "", details = "") {
  await env.DB.prepare(`
    INSERT INTO admin_audit_log(id,admin_uid,admin_username,action,target_type,target_id,details)
    VALUES(?,?,?,?,?,?,?)
  `).bind(crypto.randomUUID(), admin.uid, admin.username, action, targetType, String(targetId || "").slice(0,150), String(details || "").slice(0,1000)).run();
}

async function verifyAdmin(request, env) {
  const token = getBearer(request);
  if (!token || token.length < 40 || token.length > 200) return null;
  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  const session = await env.DB.prepare(`
    SELECT uid,username,expires_at FROM admin_sessions
    WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?
    LIMIT 1
  `).bind(tokenHash, now).first();
  if (!session || String(session.username).trim().toLowerCase() !== "mehranmsh") return null;
  return { uid: session.uid, username: session.username, expiresAt: session.expires_at };
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
  const faDescription = String(data.faDescription || data.fa_description || "");
  const url = String(data.url || "").trim();
  const status = normalizeStatus(data.status);

  if (
    !name ||
    name.length > 100 ||
    description.length > 3000 ||
    faDescription.length > 3000 ||
    url.length > 500 ||
    !status
  ) return null;

  if (url) {
    try {
      if (!["http:", "https:"].includes(new URL(url).protocol)) return null;
    } catch {
      return null;
    }
  }

  return {
    id: String(data.id || crypto.randomUUID()).trim(),
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

async function socialDeleteAccount(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const password = String(body.password || "");
  const row = await env.DB.prepare(
    "SELECT password_hash FROM social_users WHERE id=?"
  ).bind(user.id).first();

  if (!row || !(await verifyPassword(password, row.password_hash)).valid) {
    return error("Incorrect password", 403);
  }

  await env.DB.prepare(`
    UPDATE social_users
    SET is_active=0,updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).bind(user.id).run();

  await env.DB.prepare(
    "DELETE FROM social_sessions WHERE user_id=?"
  ).bind(user.id).run();

  return json({ success: true, deactivated: true });
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
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Vary": "Origin",
          "Cache-Control": "no-store"
        }
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      const needsDB =
        path.startsWith("/projects") ||
        path.startsWith("/social") ||
        path.startsWith("/admin/") ||
        path === "/auth";

      if (needsDB && !env.DB) {
        return error("Database binding is missing", 503);
      }

      if (path === "/health" && method === "GET") {
        let database = false;
        try {
          if (env.DB) {
            await env.DB.prepare("SELECT 1 AS test").first();
            database = true;
          }
        } catch {}

        return json({
          status: "online",
          service: "MEHRAN MSH AUTH",
          version: "5.0",
          database
        });
      }

      if (path.startsWith("/admin/session")) {
        await ensureAdminSessionTable(env);
        if (path === "/admin/session" && method === "POST") {
          if (!await checkRateLimit(env, request, "admin-session-create", 10, 3600, 1800)) {
            return error("Too many admin sign-in attempts. Try again later.", 429);
          }
          const body = await readBody(request);
          if (!body) return error("Invalid request body");
          const piUser = await fetchPiUser(body.accessToken);
          if (!piUser || piUser.username.trim().toLowerCase() !== "mehranmsh") {
            return error("Verified admin Pi account required", 403);
          }
          const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
          const tokenHash = await sha256(token);
          const now = Math.floor(Date.now() / 1000);
          const expiresAt = 4102444800;
          await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at<? OR revoked_at IS NOT NULL").bind(now).run();
          await env.DB.prepare(`
            INSERT INTO admin_sessions(id,token_hash,uid,username,created_at,expires_at)
            VALUES(?,?,?,?,?,?)
          `).bind(crypto.randomUUID(),tokenHash,piUser.uid,piUser.username,now,expiresAt).run();
          return json({success:true,token,username:piUser.username,uid:piUser.uid,expiresAt,persistent:true});
        }
        if (path === "/admin/session" && method === "GET") {
          const admin = await verifyAdmin(request, env);
          if (!admin) return error("Admin session is invalid. Sign in again.", 401);
          return json({success:true,username:admin.username,uid:admin.uid,expiresAt:admin.expiresAt});
        }
        if (path === "/admin/session" && method === "DELETE") {
          const token = getBearer(request);
          if (token) await env.DB.prepare(
            "UPDATE admin_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL"
          ).bind(Math.floor(Date.now()/1000),await sha256(token)).run();
          return json({success:true,revoked:true});
        }
        return error("Not found",404);
      }

      if (path === "/auth" && method === "POST") {
        if (!await checkRateLimit(env, request, "pi-auth", 20, 900, 900)) {
          return error("Too many Pi authentication attempts. Try again later.", 429);
        }

        const body = await readBody(request);
        if (!body) return error("Invalid request body");

        const piUser = await fetchPiUser(body.accessToken);
        if (!piUser) return error("Pi authentication failed", 401);

        return json({
          success: true,
          uid: piUser.uid,
          username: piUser.username,
          isAdmin: piUser.username.trim().toLowerCase() === "mehranmsh"
        });
      }

      if (path.startsWith("/social")) {
        await ensureSocialTables(env);

        if (path === "/social/register" && method === "POST") {
          return await socialRegister(request, env);
        }

        if (path === "/social/firebase/session" && method === "POST") {
          return await socialFirebaseSession(request, env);
        }

        if (path === "/social/login" && method === "POST") {
          return await socialLogin(request, env);
        }

        if (path === "/social/me" && method === "GET") {
          return await socialMe(request, env);
        }

        if (path === "/social/link-pi" && method === "POST") {
          const user = await getSocialUser(request, env);
          if (!user) return error("SOCIAL authentication required", 401);
          const body = await readBody(request);
          if (!body || !body.accessToken) return error("Pi access token is required");
          const piUser = await fetchPiUser(body.accessToken);
          if (!piUser || String(piUser.username || "").trim().toLowerCase() !== "mehranmsh") {
            return error("Only the verified Pi account mehranmsh can receive the Creator badge", 403);
          }
          await env.DB.prepare("UPDATE social_users SET pi_username=?,pi_verified=1,updated_at=CURRENT_TIMESTAMP WHERE id=?")
            .bind(piUser.username,user.id).run();
          return json({success:true,creatorVerified:true,creatorLabel:"Creator"});
        }

        if (path === "/social/logout" && method === "POST") {
          return await socialLogout(request, env);
        }

        if (path === "/social/sessions" && method === "GET") {
          return await socialListSessions(request, env);
        }

        if (path === "/social/logout-all" && method === "POST") {
          return await socialLogoutAll(request, env);
        }

        if (path === "/social/account" && method === "DELETE") {
          return await socialDeleteAccount(request, env);
        }

        const sessionMatch = path.match(/^\/social\/sessions\/([^/]+)$/);
        if (sessionMatch && method === "DELETE") {
          return await socialRevokeSession(request, env, sessionMatch[1]);
        }

        if (path === "/social/profile" && method === "PUT") {
          return await socialUpdateProfile(request, env);
        }

        if (path === "/social/username" && method === "PUT") {
          return await socialChangeUsername(request, env);
        }

        if (path === "/social/settings/extended" && (method === "GET" || method === "PUT")) {
          return await socialExtendedSettings(request, env);
        }
        if (path === "/social/storage" && method === "GET") {
          return await socialStorageSummary(request, env);
        }
        if (path === "/social/support" && method === "POST") {
          return await socialCreateSupportTicket(request, env);
        }

        if (path === "/social/privacy" && method === "GET") {
          const user = await getSocialUser(request, env);
          if (!user) return error("Authentication required", 401);

          const settings = await env.DB.prepare(
            "SELECT * FROM social_user_settings WHERE user_id=?"
          ).bind(user.id).first();

          return json({ success: true, settings: settings || {} });
        }

        if (path === "/social/privacy" && method === "PUT") {
          return await socialPrivacy(request, env);
        }

        if (path === "/social/search" && method === "GET") {
          return await socialSearch(request, env);
        }

        if (path === "/social/feed" && method === "GET") {
          return await socialFeed(request, env);
        }

        if (path === "/social/posts" && method === "POST") {
          return await socialCreatePost(request, env);
        }

        if (path === "/social/bookmarks" && method === "GET") {
          return await socialListBookmarks(request, env);
        }

        const profileMatch = path.match(/^\/social\/profile\/([^/]+)$/);
        if (profileMatch && method === "GET") {
          return await socialGetProfile(
            request,
            env,
            decodeURIComponent(profileMatch[1])
          );
        }

        const userPostsMatch = path.match(/^\/social\/users\/([^/]+)\/posts$/);
        if (userPostsMatch && method === "GET") {
          return await socialUserPosts(
            request,
            env,
            decodeURIComponent(userPostsMatch[1])
          );
        }

        const postLikeMatch = path.match(/^\/social\/posts\/([^/]+)\/like$/);
        if (postLikeMatch && method === "POST") {
          return await socialLikePost(
            request,
            env,
            decodeURIComponent(postLikeMatch[1]),
            true
          );
        }
        if (postLikeMatch && method === "DELETE") {
          return await socialLikePost(
            request,
            env,
            decodeURIComponent(postLikeMatch[1]),
            false
          );
        }

        const bookmarkMatch = path.match(/^\/social\/posts\/([^/]+)\/bookmark$/);
        if (bookmarkMatch && method === "POST") {
          return await socialBookmark(
            request,
            env,
            decodeURIComponent(bookmarkMatch[1]),
            true
          );
        }
        if (bookmarkMatch && method === "DELETE") {
          return await socialBookmark(
            request,
            env,
            decodeURIComponent(bookmarkMatch[1]),
            false
          );
        }

        const viewMatch = path.match(/^\/social\/posts\/([^/]+)\/view$/);
        if (viewMatch && method === "POST") {
          return await socialViewPost(request, env, decodeURIComponent(viewMatch[1]));
        }

        const postCommentsMatch = path.match(/^\/social\/posts\/([^/]+)\/comments$/);
        if (postCommentsMatch && method === "GET") {
          return await socialListComments(
            request,
            env,
            decodeURIComponent(postCommentsMatch[1])
          );
        }
        if (postCommentsMatch && method === "POST") {
          return await socialCreateComment(
            request,
            env,
            decodeURIComponent(postCommentsMatch[1])
          );
        }

        const postMatch = path.match(/^\/social\/posts\/([^/]+)$/);
        if (postMatch && method === "DELETE") {
          return await socialDeletePost(
            request,
            env,
            decodeURIComponent(postMatch[1])
          );
        }

        const commentMatch = path.match(/^\/social\/comments\/([^/]+)$/);
        if (commentMatch && method === "DELETE") {
          return await socialDeleteComment(
            request,
            env,
            decodeURIComponent(commentMatch[1])
          );
        }

        const followMatch = path.match(/^\/social\/follow\/([^/]+)$/);
        if (followMatch && method === "POST") {
          return await socialFollow(
            request,
            env,
            decodeURIComponent(followMatch[1]),
            true
          );
        }
        if (followMatch && method === "DELETE") {
          return await socialFollow(
            request,
            env,
            decodeURIComponent(followMatch[1]),
            false
          );
        }

        const followersMatch = path.match(/^\/social\/followers\/([^/]+)$/);
        if (followersMatch && method === "GET") {
          return await socialFollowList(
            request,
            env,
            decodeURIComponent(followersMatch[1]),
            "followers"
          );
        }

        const followingMatch = path.match(/^\/social\/following\/([^/]+)$/);
        if (followingMatch && method === "GET") {
          return await socialFollowList(
            request,
            env,
            decodeURIComponent(followingMatch[1]),
            "following"
          );
        }

        if (path === "/social/follow-requests" && method === "GET") {
          return await socialFollowRequests(request, env);
        }

        const followRequestMatch = path.match(
          /^\/social\/follow-requests\/([^/]+)\/(accept|reject)$/
        );
        if (followRequestMatch && method === "POST") {
          return await socialFollowRequestAction(
            request,
            env,
            decodeURIComponent(followRequestMatch[1]),
            followRequestMatch[2] === "accept"
          );
        }

        const blockMatch = path.match(/^\/social\/block\/([^/]+)$/);
        if (blockMatch && method === "POST") {
          return await socialBlock(
            request,
            env,
            decodeURIComponent(blockMatch[1]),
            true
          );
        }
        if (blockMatch && method === "DELETE") {
          return await socialBlock(
            request,
            env,
            decodeURIComponent(blockMatch[1]),
            false
          );
        }

        if (path === "/social/reports" && method === "POST") {
          return await socialReport(request, env);
        }

        if (path === "/social/notifications" && method === "GET") {
          return await socialNotifications(request, env);
        }

        if (path === "/social/notifications/read-all" && method === "POST") {
          return await socialReadNotifications(request, env);
        }

        const notificationReadMatch = path.match(
          /^\/social\/notifications\/([^/]+)\/read$/
        );
        if (notificationReadMatch && method === "POST") {
          return await socialReadNotifications(
            request,
            env,
            decodeURIComponent(notificationReadMatch[1])
          );
        }

        if (path === "/social/stories" && method === "GET") {
          return await socialStories(request, env);
        }

        if (path === "/social/stories" && method === "POST") {
          return await socialCreateStory(request, env);
        }

        const storyMatch = path.match(/^\/social\/stories\/([^/]+)$/);
        if (storyMatch && method === "DELETE") {
          return await socialDeleteStory(
            request,
            env,
            decodeURIComponent(storyMatch[1])
          );
        }

        const storyViewMatch = path.match(/^\/social\/stories\/([^/]+)\/view$/);
        if (storyViewMatch && method === "POST") {
          return await socialViewStory(
            request,
            env,
            decodeURIComponent(storyViewMatch[1])
          );
        }

        const storyReactMatch = path.match(/^\/social\/stories\/([^/]+)\/react$/);
        if (storyReactMatch && method === "POST") {
          return await socialReactStory(
            request,
            env,
            decodeURIComponent(storyReactMatch[1])
          );
        }

        if (path === "/social/conversations" && method === "GET") {
          return await socialListConversations(request, env);
        }

        if (path === "/social/conversations" && method === "POST") {
          return await socialStartConversation(request, env);
        }

        const conversationMessagesMatch = path.match(
          /^\/social\/conversations\/([^/]+)\/messages$/
        );
        if (conversationMessagesMatch && method === "GET") {
          return await socialConversationMessages(
            request,
            env,
            decodeURIComponent(conversationMessagesMatch[1])
          );
        }
        if (conversationMessagesMatch && method === "POST") {
          return await socialSendMessage(
            request,
            env,
            decodeURIComponent(conversationMessagesMatch[1])
          );
        }

        const groupInviteMatch = path.match(
          /^\/social\/groups\/([^/]+)\/invite$/
        );
        if (groupInviteMatch && method === "POST") {
          return await socialGroupInvite(
            request,
            env,
            decodeURIComponent(groupInviteMatch[1])
          );
        }

        const joinGroupMatch = path.match(/^\/social\/groups\/join\/([^/]+)$/);
        if (joinGroupMatch && method === "POST") {
          return await socialJoinGroup(
            request,
            env,
            decodeURIComponent(joinGroupMatch[1])
          );
        }

        if (path === "/social/groups" && method === "POST") {
          return await socialCreateGroup(request, env);
        }

        const messageMatch = path.match(/^\/social\/messages\/([^/]+)$/);
        if (messageMatch && method === "PUT") {
          return await socialEditMessage(
            request,
            env,
            decodeURIComponent(messageMatch[1])
          );
        }
        if (messageMatch && method === "DELETE") {
          return await socialDeleteMessage(
            request,
            env,
            decodeURIComponent(messageMatch[1])
          );
        }

        if (path === "/social/channels" && method === "GET") {
          return await socialListChannels(request, env);
        }

        if (path === "/social/channels" && method === "POST") {
          return await socialCreateChannel(request, env);
        }

        const joinChannelMatch = path.match(
          /^\/social\/channels\/([^/]+)\/join$/
        );
        if (joinChannelMatch && method === "POST") {
          return await socialJoinChannel(
            request,
            env,
            decodeURIComponent(joinChannelMatch[1])
          );
        }

        const channelPostsMatch = path.match(
          /^\/social\/channels\/([^/]+)\/posts$/
        );
        if (channelPostsMatch && method === "GET") {
          return await socialChannelPosts(
            request,
            env,
            decodeURIComponent(channelPostsMatch[1])
          );
        }
        if (channelPostsMatch && method === "POST") {
          return await socialChannelPost(
            request,
            env,
            decodeURIComponent(channelPostsMatch[1])
          );
        }

        const channelPinMatch = path.match(
          /^\/social\/channels\/([^/]+)\/posts\/([^/]+)\/pin$/
        );
        if (channelPinMatch && method === "POST") {
          return await socialPinChannelPost(
            request,
            env,
            decodeURIComponent(channelPinMatch[1]),
            decodeURIComponent(channelPinMatch[2]),
            true
          );
        }
        if (channelPinMatch && method === "DELETE") {
          return await socialPinChannelPost(
            request,
            env,
            decodeURIComponent(channelPinMatch[1]),
            decodeURIComponent(channelPinMatch[2]),
            false
          );
        }

        if (path === "/social/bots" && method === "GET") {
          return await socialListBots(request, env);
        }

        if (path === "/social/bots" && method === "POST") {
          return await socialCreateBot(request, env);
        }

        if (path === "/social/uploads/create" && method === "POST") {
          return await socialCreateUpload(request, env);
        }

        if (path === "/social/uploads" && method === "GET") {
          return await socialListUploads(request, env);
        }

        const uploadMatch = path.match(
          /^\/social\/uploads\/([^/]+)(?:\/(complete|url))?$/
        );

        if (uploadMatch) {
          const id = decodeURIComponent(uploadMatch[1]);
          const action = uploadMatch[2] || "";

          if (action === "complete" && method === "POST") {
            return await socialCompleteUpload(request, env, id);
          }

          if (action === "url" && method === "GET") {
            return await socialGetUploadUrl(request, env, id);
          }

          if (!action && method === "DELETE") {
            return await socialDeleteUpload(request, env, id);
          }
        }
      }

      if (path.startsWith("/admin/")) {
        await ensureSocialTables(env);
        await ensureAdminSessionTable(env);
      }

      if (path === "/admin/overview" && method === "GET") {
        const admin = await verifyAdmin(request, env);
        if (!admin) return error("Admin authentication required", 403);
        const queries = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) AS total FROM social_users").first(),
          env.DB.prepare("SELECT COUNT(*) AS total FROM social_users WHERE is_active=1").first(),
          env.DB.prepare("SELECT COUNT(*) AS total FROM social_users WHERE is_active=0").first(),
          env.DB.prepare("SELECT COUNT(*) AS total FROM social_posts").first(),
          env.DB.prepare("SELECT COUNT(*) AS total FROM social_reports WHERE status='open'").first(),
          env.DB.prepare("SELECT COUNT(*) AS total FROM social_reports").first(),
          env.DB.prepare("SELECT COUNT(*) AS total FROM social_sessions WHERE expires_at>?").bind(new Date().toISOString()).first(),
          env.DB.prepare("SELECT COUNT(*) AS total FROM social_users WHERE created_at>=datetime('now','-7 days')").first()
        ]);
        return json({success:true,stats:{
          users:Number(queries[0]?.total||0),activeUsers:Number(queries[1]?.total||0),
          suspendedUsers:Number(queries[2]?.total||0),posts:Number(queries[3]?.total||0),
          openReports:Number(queries[4]?.total||0),allReports:Number(queries[5]?.total||0),
          activeSessions:Number(queries[6]?.total||0),newUsers7d:Number(queries[7]?.total||0)
        }});
      }

      if (path === "/admin/reports" && method === "GET") {
        const admin = await verifyAdmin(request, env);
        if (!admin) return error("Admin authentication required", 403);
        const status = String(new URL(request.url).searchParams.get("status") || "open");
        const filter = ["open","resolved","dismissed","all"].includes(status) ? status : "open";
        const where = filter === "all" ? "" : "WHERE r.status=?";
        const result = await env.DB.prepare(`
          SELECT r.id,r.target_type,r.target_id,r.reason,r.status,r.created_at,r.resolved_at,
                 u.username AS reporter_username
          FROM social_reports r LEFT JOIN social_users u ON u.id=r.reporter_id
          ${where} ORDER BY r.created_at DESC LIMIT 100
        `).bind(...(filter === "all" ? [] : [filter])).all();
        return json({success:true,reports:(result.results||[]).map(r=>({
          id:r.id,targetType:r.target_type,targetId:r.target_id,reason:r.reason,
          status:r.status||"open",createdAt:r.created_at,resolvedAt:r.resolved_at||"",
          reporter:r.reporter_username||"Deleted account"
        }))});
      }

      const adminReportMatch = path.match(/^\/admin\/reports\/([^/]+)$/);
      if (adminReportMatch && method === "PUT") {
        const admin = await verifyAdmin(request, env);
        if (!admin) return error("Admin authentication required", 403);
        const body = await readBody(request);
        const status = String(body?.status || "");
        if (!["resolved","dismissed","open"].includes(status)) return error("Invalid report status");
        const id = decodeURIComponent(adminReportMatch[1]);
        const result = await env.DB.prepare("UPDATE social_reports SET status=?,resolved_at=?,resolved_by=? WHERE id=?")
          .bind(status,status==="open"?null:new Date().toISOString(),status==="open"?null:admin.username,id).run();
        if (!result.meta || result.meta.changes===0) return error("Report not found",404);
        await writeAdminAudit(env,admin,"report_"+status,"report",id,"Report status changed");
        return json({success:true,id,status});
      }

      if (path === "/admin/audit" && method === "GET") {
        const admin = await verifyAdmin(request, env);
        if (!admin) return error("Admin authentication required", 403);
        const result = await env.DB.prepare("SELECT id,admin_username,action,target_type,target_id,details,created_at FROM admin_audit_log ORDER BY created_at DESC LIMIT 100").all();
        return json({success:true,events:(result.results||[]).map(x=>({
          id:x.id,admin:x.admin_username,action:x.action,targetType:x.target_type,
          targetId:x.target_id,details:x.details,createdAt:x.created_at
        }))});
      }

      if (path === "/admin/security" && method === "GET") {
        const admin = await verifyAdmin(request, env);
        if (!admin) return error("Admin authentication required", 403);
        const result = await env.DB.prepare("SELECT id,uid,username,created_at,expires_at,revoked_at FROM admin_sessions ORDER BY created_at DESC LIMIT 50").all();
        return json({success:true,sessions:(result.results||[]).map(s=>({
          id:s.id,uid:s.uid,username:s.username,createdAt:s.created_at,
          expiresAt:s.expires_at,revoked:Boolean(s.revoked_at)
        }))});
      }

      const adminSecurityMatch = path.match(/^\/admin\/security\/([^/]+)$/);
      if (adminSecurityMatch && method === "DELETE") {
        const admin = await verifyAdmin(request, env);
        if (!admin) return error("Admin authentication required", 403);
        const token = getBearer(request);
        const currentHash = await sha256(token);
        const sessionId = decodeURIComponent(adminSecurityMatch[1]);
        const result = await env.DB.prepare("UPDATE admin_sessions SET revoked_at=? WHERE id=? AND token_hash!=? AND revoked_at IS NULL")
          .bind(Math.floor(Date.now()/1000),sessionId,currentHash).run();
        if (!result.meta || result.meta.changes===0) return error("Session not found or current session cannot be revoked here",404);
        await writeAdminAudit(env,admin,"admin_session_revoked","admin_session",sessionId,"Another admin session was revoked");
        return json({success:true,revoked:true});
      }

      if (path === "/admin/settings" && method === "GET") {
        const admin = await verifyAdmin(request, env);
        if (!admin) return error("Admin authentication required", 403);
        return json({success:true,settings:{
          adminIdentity:"Pi username: mehranmsh",
          authorization:"Server-verified Pi identity and revocable admin session",
          emailVerification:"Required for SOCIAL email/password accounts",
          creatorBadge:"Granted only to a SOCIAL account linked to the verified Pi account mehranmsh",
          destructiveActions:"Protected by server-side authorization"
        }});
      }

      if (path === "/admin/users" && method === "GET") {
        if (!await verifyAdmin(request, env)) {
          return error("Admin authentication required", 403);
        }

        const url = new URL(request.url);
        const query = String(url.searchParams.get("q") || "").trim().slice(0, 80);
        const status = String(url.searchParams.get("status") || "all");
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50)));
        const conditions = [];
        const values = [];

        if (query) {
          conditions.push("(username LIKE ? OR display_name LIKE ? OR email LIKE ?)");
          const term = "%" + query.replace(/[%_]/g, "") + "%";
          values.push(term, term, term);
        }
        if (status === "active") conditions.push("is_active=1");
        if (status === "suspended") conditions.push("is_active=0");

        const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
        const result = await env.DB.prepare(`
          SELECT id,username,email,display_name,pi_username,pi_verified,
                 is_active,email_verified,created_at,updated_at
          FROM social_users ${where}
          ORDER BY created_at DESC
          LIMIT ?
        `).bind(...values, limit).all();

        const count = await env.DB.prepare(`
          SELECT COUNT(*) AS total FROM social_users ${where}
        `).bind(...values).first();

        return json({
          success: true,
          users: (result.results || []).map(row => ({
            id: row.id,
            username: row.username,
            email: row.email,
            displayName: row.display_name || "",
            piUsername: row.pi_username || "",
            piVerified: Boolean(row.pi_verified),
            active: Boolean(row.is_active),
            emailVerified: Boolean(row.email_verified),
            createdAt: row.created_at,
            updatedAt: row.updated_at
          })),
          total: Number(count?.total || 0),
          limit
        });
      }

      const adminUserStatusMatch = path.match(new RegExp("^/admin/users/([^/]+)/status$"));
      if (adminUserStatusMatch && method === "PUT") {
        if (!await verifyAdmin(request, env)) {
          return error("Admin authentication required", 403);
        }
        if (!await checkRateLimit(env, request, "admin-user-status", 20, 3600, 900)) {
          return error("Too many account status changes. Try again later.", 429);
        }

        const body = await readBody(request);
        if (!body || typeof body.active !== "boolean") {
          return error("A valid active status is required");
        }

        const id = decodeURIComponent(adminUserStatusMatch[1]);
        if (!id || id.length > 100) return error("Invalid user ID");

        const target = await env.DB.prepare(
          "SELECT id,username,is_active FROM social_users WHERE id=? LIMIT 1"
        ).bind(id).first();
        if (!target) return error("User not found", 404);
        if (String(target.username).trim().toLowerCase() === "mehranmsh") {
          return error("The primary administrator account cannot be suspended", 403);
        }

        await env.DB.prepare(
          "UPDATE social_users SET is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"
        ).bind(body.active ? 1 : 0, id).run();
        await writeAdminAudit(env, await verifyAdmin(request, env), body.active ? "user_reactivated" : "user_suspended", "user", id, "Account status changed");

        return json({
          success: true,
          user: { id: target.id, username: target.username, active: body.active }
        });
      }

      if (path === "/projects" && method === "GET") {
        const result = await env.DB.prepare(`
          SELECT id,name,description,fa_description,url,status,created_at,updated_at
          FROM projects ORDER BY created_at DESC
        `).all();

        return json({
          success: true,
          projects: (result.results || []).map(formatProject)
        });
      }

      if (path === "/projects" && method === "POST") {
        const body = await readBody(request);
        if (!body) return error("Invalid request body");

        if (!await checkRateLimit(env, request, "project-write", 30, 3600, 900)) {
          return error("Too many project changes. Try again later.", 429);
        }

        if (!await verifyAdmin(request, env)) {
          return error("Admin authentication required", 403);
        }

        const project = cleanProject(body.project || body);
        if (!project || !project.id || project.id.length > 100) {
          return error("Invalid project data");
        }

        await env.DB.prepare(`
          INSERT INTO projects(id,name,description,fa_description,url,status)
          VALUES(?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            description=excluded.description,
            fa_description=excluded.fa_description,
            url=excluded.url,
            status=excluded.status,
            updated_at=CURRENT_TIMESTAMP
        `).bind(
          project.id,
          project.name,
          project.description,
          project.faDescription,
          project.url,
          project.status
        ).run();

        const saved = await env.DB.prepare(
          "SELECT * FROM projects WHERE id=?"
        ).bind(project.id).first();

        return json({ success: true, project: formatProject(saved) }, 201);
      }

      const projectMatch = path.match(/^\/projects\/([^/]+)$/);

      if (projectMatch && ["PUT", "DELETE"].includes(method)) {
        const body = await readBody(request);
        if (!body) return error("Invalid request body");

        if (!await checkRateLimit(env, request, "project-write", 30, 3600, 900)) {
          return error("Too many project changes. Try again later.", 429);
        }

        if (!await verifyAdmin(request, env)) {
          return error("Admin authentication required", 403);
        }

        const id = decodeURIComponent(projectMatch[1]);
        if (!id || id.length > 100) return error("Invalid project ID");

        if (method === "DELETE") {
          const result = await env.DB.prepare(
            "DELETE FROM projects WHERE id=?"
          ).bind(id).run();

          if (!result.meta || result.meta.changes === 0) {
            return error("Project not found", 404);
          }

          return json({ success: true, deleted: true, id });
        }

        const project = cleanProject({ ...(body.project || {}), id });
        if (!project) return error("Invalid project data");

        const result = await env.DB.prepare(`
          UPDATE projects
          SET name=?,description=?,fa_description=?,url=?,status=?,
              updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).bind(
          project.name,
          project.description,
          project.faDescription,
          project.url,
          project.status,
          id
        ).run();

        if (!result.meta || result.meta.changes === 0) {
          return error("Project not found", 404);
        }

        const saved = await env.DB.prepare(
          "SELECT * FROM projects WHERE id=?"
        ).bind(id).first();

        return json({ success: true, project: formatProject(saved) });
      }

      return error("Not found", 404);

    } catch (err) {
      console.error("MEHRAN MSH Worker error:", {
        path,
        name: err?.name || "Error",
        message: String(err?.message || err).slice(0, 500),
        stack: err?.stack || ""
      });

      return error("Internal service error", 500);
    }
  }
};
