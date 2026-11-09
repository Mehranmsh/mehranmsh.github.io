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

// Conservative, account-wide reservation for this Worker's Workers AI calls.
 // Reserve half of Cloudflare's 10,000-Neuron free daily allocation for other account usage.
 // Image generation reserves 2,000 Neurons (actual published estimate is lower).
 // Reservations are never refunded after a model call because failed responses
 // may still have consumed inference resources. UTC date matches Cloudflare reset.
const SOCIAL_AI_DAILY_BUDGET_NEURONS = 5000;
async function reserveSocialWorkersAIBudget(env, reservedNeurons) {
  if (!env?.DB || !Number.isInteger(reservedNeurons) || reservedNeurons < 1) {
    throw new Error("Workers AI budget guard is unavailable.");
  }
  await ensureSocialTables(env);
  const dayKey = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(`
    INSERT INTO social_ai_daily_budget(day_key,reserved_neurons,request_count,updated_at)
    VALUES(?,?,1,CURRENT_TIMESTAMP)
    ON CONFLICT(day_key) DO UPDATE SET
      reserved_neurons=social_ai_daily_budget.reserved_neurons+excluded.reserved_neurons,
      request_count=social_ai_daily_budget.request_count+1,
      updated_at=CURRENT_TIMESTAMP
    WHERE social_ai_daily_budget.reserved_neurons+excluded.reserved_neurons<=?
    RETURNING reserved_neurons,request_count
  `).bind(dayKey, reservedNeurons, SOCIAL_AI_DAILY_BUDGET_NEURONS).first();
  return {
    allowed: !!row,
    reservedNeurons: row ? Number(row.reserved_neurons) : null,
    requestCount: row ? Number(row.request_count) : null,
    dayKey
  };
}

const socialSchemaInit = new WeakMap();

async function ensureSocialTables(env) {
  const db = env.DB;
  let pending = socialSchemaInit.get(db);
  if (!pending) {
    pending = createSocialTables(db);
    socialSchemaInit.set(db, pending);
    pending.catch(() => {
      if (socialSchemaInit.get(db) === pending) socialSchemaInit.delete(db);
    });
  }
  return pending;
}

async function createSocialTables(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS social_auth_limits(
      rate_key TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      window_started_at INTEGER NOT NULL,
      blocked_until INTEGER
    )`,

    `CREATE TABLE IF NOT EXISTS social_ai_daily_budget(
      day_key TEXT PRIMARY KEY,
      reserved_neurons INTEGER NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
      firebase_uid TEXT,
      account_type TEXT NOT NULL DEFAULT 'human',
      business_category TEXT NOT NULL DEFAULT '',
      business_website TEXT NOT NULL DEFAULT ''
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

    `CREATE INDEX IF NOT EXISTS idx_social_notifications_unread
      ON social_notifications(user_id,is_read,created_at DESC)`,

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
      type TEXT NOT NULL DEFAULT 'direct',
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

    `CREATE TABLE IF NOT EXISTS social_call_sessions(
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('audio','video','live','group_voice')),
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_social_call_active
      ON social_call_sessions(conversation_id,status,created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS social_call_participants(
      call_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      left_at TEXT,
      PRIMARY KEY(call_id,user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS social_call_signals(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id TEXT NOT NULL,
      from_user_id TEXT NOT NULL,
      to_user_id TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_social_call_signals
      ON social_call_signals(call_id,to_user_id,seq)`,

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
    )`,

    `CREATE TABLE IF NOT EXISTS social_ai_messages(
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,


    `CREATE INDEX IF NOT EXISTS idx_social_ai_messages_user
      ON social_ai_messages(user_id,created_at DESC)`
  ];

  for (const statement of statements) {
    await db.prepare(statement).run();
  }
  try { await db.prepare("ALTER TABLE social_ai_messages ADD COLUMN provider_key TEXT NOT NULL DEFAULT 'central'").run(); } catch {}
  try { await db.prepare("ALTER TABLE social_ai_messages ADD COLUMN conversation_id TEXT NOT NULL DEFAULT 'central'").run(); } catch {}
  try { await db.prepare("ALTER TABLE social_users ADD COLUMN firebase_uid TEXT").run(); } catch {}
  try { await db.prepare("ALTER TABLE social_users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'human'").run(); } catch {}
  try { await db.prepare("ALTER TABLE social_users ADD COLUMN business_category TEXT NOT NULL DEFAULT ''").run(); } catch {}
  try { await db.prepare("ALTER TABLE social_users ADD COLUMN business_website TEXT NOT NULL DEFAULT ''").run(); } catch {}
  // Upgrade older installations where social_user_settings predates theme/language columns.
  try { await db.prepare("ALTER TABLE social_user_settings ADD COLUMN language TEXT NOT NULL DEFAULT 'en'").run(); } catch {}
  try { await db.prepare("ALTER TABLE social_user_settings ADD COLUMN theme TEXT NOT NULL DEFAULT 'dark'").run(); } catch {}
  // Repair legacy chat tables. CREATE TABLE IF NOT EXISTS does not add
  // columns to tables that already existed in older deployments.
  const ensureColumn = async (table, column, definition) => {
    const info = await db.prepare("PRAGMA table_info(" + table + ")").all();
    const columns = new Set((info.results || []).map(row => row.name));
    if (!columns.has(column)) {
      try {
        await db.prepare("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition).run();
      } catch (err) {
        // Concurrent isolates may perform the same idempotent migration.
        const refreshed = await db.prepare("PRAGMA table_info(" + table + ")").all();
        if (!(refreshed.results || []).some(row => row.name === column)) throw err;
      }
    }
  };
  await ensureColumn("social_users", "last_seen_at", "TEXT");
  await ensureColumn("social_conversations", "type", "TEXT NOT NULL DEFAULT 'direct'");
  await ensureColumn("social_conversations", "title", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("social_conversations", "owner_id", "TEXT");
  await ensureColumn("social_conversations", "created_at", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("social_conversations", "updated_at", "TEXT NOT NULL DEFAULT ''");
  const conversationInfo = await db.prepare("PRAGMA table_info(social_conversations)").all();
  const conversationColumns = new Set((conversationInfo.results || []).map(row => row.name));
  if (conversationColumns.has("created_by")) {
    await db.prepare("UPDATE social_conversations SET owner_id=created_by WHERE owner_id IS NULL OR owner_id=''").run();
  } else if (conversationColumns.has("creator_id")) {
    await db.prepare("UPDATE social_conversations SET owner_id=creator_id WHERE owner_id IS NULL OR owner_id=''").run();
  }
  await ensureColumn("social_conversation_members", "role", "TEXT NOT NULL DEFAULT 'member'");
  await ensureColumn("social_conversation_members", "joined_at", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("social_conversation_members", "last_read_at", "TEXT");
  await ensureColumn("social_conversation_members", "last_read_message_rowid", "INTEGER");
  // Upgrade channel tables created by earlier SOCIAL versions.
  await ensureColumn("social_channels", "description", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("social_channels", "username", "TEXT");
  await ensureColumn("social_channels", "is_private", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("social_channels", "invite_code", "TEXT");
  await ensureColumn("social_channels", "created_at", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("social_channel_members", "role", "TEXT NOT NULL DEFAULT 'subscriber'");
  await ensureColumn("social_channel_members", "joined_at", "TEXT NOT NULL DEFAULT ''");
  // Bring legacy message tables up to the columns used by chat reads and edits.
  await ensureColumn("social_messages", "media_json", "TEXT NOT NULL DEFAULT '[]'");
  await ensureColumn("social_messages", "reply_to", "TEXT");
  await ensureColumn("social_messages", "forwarded_from", "TEXT");
  await ensureColumn("social_messages", "edited_at", "TEXT");
  await ensureColumn("social_messages", "deleted_at", "TEXT");
  await ensureColumn("social_messages", "created_at", "TEXT NOT NULL DEFAULT ''");
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_social_messages_unread ON social_messages(conversation_id,sender_id,deleted_at)").run();
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_social_users_firebase_uid ON social_users(firebase_uid)").run();
  try { await db.prepare("ALTER TABLE social_reports ADD COLUMN status TEXT NOT NULL DEFAULT 'open'").run(); } catch {}
  try { await db.prepare("ALTER TABLE social_reports ADD COLUMN resolved_at TEXT").run(); } catch {}
  try { await db.prepare("ALTER TABLE social_reports ADD COLUMN resolved_by TEXT").run(); } catch {}
}

function cleanUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeAccountType(value) {
  return ["human", "business", "ai"].includes(value) ? value : "human";
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
      u.pi_username,u.pi_verified,u.email_verified,u.created_at,u.account_type,u.business_category,u.business_website,
      s.id AS session_id,s.expires_at
    FROM social_sessions s
    JOIN social_users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.is_active=1 AND u.email_verified=1
    LIMIT 1
  `).bind(tokenHash, new Date().toISOString()).first();

  if (!row) return null;

  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name || "",
    accountType: ["human", "business", "ai"].includes(row.account_type) ? row.account_type : "human",
    businessCategory: row.business_category || "",
    businessWebsite: row.business_website || "",
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
  const requestedAccountType = body.accountType === "business" ? "business" : "human";
  let user = await env.DB.prepare(
    "SELECT id,username,email,display_name,bio,avatar_url,pi_username,pi_verified,email_verified,created_at,account_type,business_category,business_website,is_active,firebase_uid FROM social_users WHERE firebase_uid=? LIMIT 1"
  ).bind(identity.localId).first();
  if (!user) {
    user = await env.DB.prepare(
      "SELECT id,username,email,display_name,bio,avatar_url,pi_username,pi_verified,email_verified,created_at,account_type,business_category,business_website,is_active,firebase_uid FROM social_users WHERE email=? LIMIT 1"
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
        env.DB.prepare(`INSERT INTO social_users(id,username,email,password_hash,display_name,email_verified,email_verified_at,firebase_uid,account_type)
          VALUES(?,?,?,?,?,1,CURRENT_TIMESTAMP,?,?)`).bind(id, username, email, passwordHash, displayName, identity.localId, requestedAccountType),
        env.DB.prepare("INSERT INTO social_user_settings(user_id) VALUES(?)").bind(id)
      ]);
    } catch (err) {
      console.error("SOCIAL_FIREBASE_USER_CREATE_FAILURE", err);
      return error("Could not finish creating your SOCIAL profile. Please try again.", 500);
    }
    user = { id, username, email, display_name: displayName, is_active: 1, firebase_uid: identity.localId, account_type: requestedAccountType };
  }
  if (!user.is_active) return error("This SOCIAL account is disabled.", 403);
  const session = await createSocialSession(env, user.id);
  return json({
    success: true,
    message: "Signed in successfully.",
    token: session.token,
    expiresAt: session.expiresAt,
    user: {
      id: user.id, username: user.username, email: user.email,
      displayName: user.display_name || "",
      accountType: normalizeAccountType(user.account_type),
      businessCategory: user.business_category || "", businessWebsite: user.business_website || "",
      bio: user.bio || "", avatarUrl: user.avatar_url || "",
      piUsername: user.pi_username || "", piVerified: Boolean(user.pi_verified),
      emailVerified: true,
      isCreator: Boolean(user.pi_verified && String(user.pi_username || "").trim().toLowerCase() === "mehranmsh"),
      creatorLabel: Boolean(user.pi_verified && String(user.pi_username || "").trim().toLowerCase() === "mehranmsh") ? "Creator" : "",
      createdAt: user.created_at || ""
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
    SELECT id,username,email,password_hash,display_name,bio,avatar_url,pi_username,pi_verified,email_verified,created_at,account_type,business_category,business_website,is_active
    FROM social_users
    WHERE email=? OR username=?
    LIMIT 1
  `).bind(identifier, identifier).first();

  if (!user || !user.is_active) {
    return error("Invalid username/email or password", 401);
  }

  const result = await verifyPassword(password, user.password_hash);
  if (!result.valid) return error("Invalid username/email or password", 401);
  if (!user.email_verified) {
    return error("Email verification is required. Sign in through the verified email identity to finish account migration.", 403);
  }

  const session = await createSocialSession(env, user.id);

  return json({
    success: true,
    message: "Login successful",
    token: session.token,
    expiresAt: session.expiresAt,
    user: {
      id: user.id, username: user.username, email: user.email,
      displayName: user.display_name || "",
      accountType: normalizeAccountType(user.account_type),
      businessCategory: user.business_category || "", businessWebsite: user.business_website || "",
      bio: user.bio || "", avatarUrl: user.avatar_url || "",
      piUsername: user.pi_username || "", piVerified: Boolean(user.pi_verified),
      emailVerified: Boolean(user.email_verified),
      isCreator: Boolean(user.pi_verified && String(user.pi_username || "").trim().toLowerCase() === "mehranmsh"),
      creatorLabel: Boolean(user.pi_verified && String(user.pi_username || "").trim().toLowerCase() === "mehranmsh") ? "Creator" : "",
      createdAt: user.created_at || ""
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

async function canViewSocialPost(env, viewerId, post) {
  if (!post) return false;
  if (post.user_id === viewerId) return true;
  if (await isBlocked(env, viewerId, post.user_id)) return false;

  const settings = await env.DB.prepare(
    "SELECT is_private FROM social_user_settings WHERE user_id=?"
  ).bind(post.user_id).first();
  const follows = await env.DB.prepare(
    "SELECT 1 FROM social_follows WHERE follower_id=? AND following_id=? LIMIT 1"
  ).bind(viewerId, post.user_id).first();

  if (settings?.is_private && !follows) return false;
  if (post.visibility === "followers" && !follows) return false;
  return post.visibility === "public" || post.visibility === "followers";
}


async function notify(env, userId, actorId, type, targetId, message = "") {
  if (!userId || userId === actorId) return;
  const row = await env.DB.prepare(
    "SELECT preferences_json FROM social_extended_settings WHERE user_id=?"
  ).bind(userId).first();
  let prefs = {};
  try { prefs = JSON.parse(row?.preferences_json || "{}"); } catch {}
  const t = String(type || "").toLowerCase();
  const key = /like|comment|mention|post|story_reaction/.test(t) ? "likesComments"
    : /follow|request/.test(t) ? "followers"
    : /message|chat/.test(t) ? "messages"
    : /group|channel|invite/.test(t) ? "groups"
    : null;
  if (key && prefs.notifications && prefs.notifications[key] === false) return;
  if (/group.*invite|invite.*group/.test(t) && prefs.community?.groupInvites === false) return;
  if (/channel.*invite|invite.*channel/.test(t) && prefs.community?.channelInvites === false) return;

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
    let stored = {};
    try { stored = JSON.parse(row?.preferences_json || "{}"); } catch {}
    const preferences = {
      notifications: {
        likesComments: stored.notifications?.likesComments !== false,
        followers: stored.notifications?.followers !== false,
        messages: stored.notifications?.messages !== false,
        groups: stored.notifications?.groups !== false
      },
      chat: {
        readReceipts: stored.chat?.readReceipts !== false,
        messagePreviews: stored.chat?.messagePreviews !== false,
        autoDownload: stored.chat?.autoDownload !== false
      },
      community: {
        groupInvites: stored.community?.groupInvites !== false,
        channelInvites: stored.community?.channelInvites !== false
      },
      privacy: {
        profileVisibility: ["everyone","contacts","nobody"].includes(stored.privacy?.profileVisibility) ? stored.privacy.profileVisibility : "everyone",
        whoCanAddToGroups: ["everyone","contacts","nobody"].includes(stored.privacy?.whoCanAddToGroups) ? stored.privacy.whoCanAddToGroups : "everyone",
        whoCanAddToChannels: ["everyone","contacts","nobody"].includes(stored.privacy?.whoCanAddToChannels) ? stored.privacy.whoCanAddToChannels : "everyone"
      }
    };
    return json({success:true,preferences});
  }
  const body = await readBody(request);
  if (!body || !body.preferences || typeof body.preferences !== "object") return error("Invalid preferences");
  const allowed = {
    notifications: ["likesComments","followers","messages","groups"],
    chat: ["readReceipts","messagePreviews","autoDownload"],
    community: ["groupInvites","channelInvites"],
    privacy: ["profileVisibility","whoCanAddToGroups","whoCanAddToChannels"]
  };
  const clean = {};
  for (const [section, keys] of Object.entries(allowed)) {
    const source = body.preferences[section] || {};
    clean[section] = {};
    for (const key of keys) {
      if (section === "privacy") {
        const valid = key === "profileVisibility" ? ["everyone","contacts","nobody"] : ["everyone","contacts","nobody"];
        clean[section][key] = valid.includes(source[key]) ? source[key] : "everyone";
      } else clean[section][key] = source[key] !== false;
    }
  }
  const serialized = JSON.stringify(clean);
  await env.DB.prepare(`
    INSERT INTO social_extended_settings(user_id,preferences_json,updated_at)
    VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      preferences_json=excluded.preferences_json,updated_at=CURRENT_TIMESTAMP
  `).bind(user.id, serialized).run();

  // Read the row back before reporting success. This catches a write that
  // appears successful to the UI but did not persist for this account.
  const savedRow = await env.DB.prepare(
    "SELECT preferences_json,updated_at FROM social_extended_settings WHERE user_id=?"
  ).bind(user.id).first();
  if (!savedRow || savedRow.preferences_json !== serialized) {
    return error("Settings were not persisted. Please retry.", 500);
  }
  return json({success:true,preferences:clean,savedAt:savedRow.updated_at});
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
    SELECT id,username,display_name,bio,avatar_url,pi_username,pi_verified,created_at,account_type,business_category,business_website
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

  const canViewGallery = !settings?.is_private || viewerId === profile.id || Boolean(counts?.is_following);
  const galleryResult = canViewGallery
    ? await env.DB.prepare(
        "SELECT id,photo_url,sort_order,created_at FROM social_profile_photos WHERE user_id=? ORDER BY sort_order ASC,created_at ASC"
      ).bind(profile.id).all()
    : { results: [] };
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
    accountType: normalizeAccountType(profile.account_type),
    businessCategory: profile.business_category || "",
    businessWebsite: profile.business_website || "",
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
  if (profile.id !== viewer.id && await isBlocked(env, viewer.id, profile.id)) {
    return error("User not found", 404);
  }

  const prefRow = await env.DB.prepare(
    "SELECT preferences_json FROM social_extended_settings WHERE user_id=?"
  ).bind(profile.id).first();
  let prefs = {};
  try { prefs = JSON.parse(prefRow?.preferences_json || "{}"); } catch {}
  const visibility = ["everyone","contacts","nobody"].includes(prefs.privacy?.profileVisibility)
    ? prefs.privacy.profileVisibility : "everyone";
  const mutualContact = profile.id === viewer.id ? true : !!(await env.DB.prepare(`
    SELECT 1 FROM social_follows a
    JOIN social_follows b ON b.follower_id=a.following_id AND b.following_id=a.follower_id
    WHERE a.follower_id=? AND a.following_id=? LIMIT 1
  `).bind(profile.id, viewer.id).first());
  const hiddenByVisibility = profile.id !== viewer.id &&
    (visibility === "nobody" || (visibility === "contacts" && !mutualContact));
  if ((profile.isPrivate && profile.id !== viewer.id && !profile.isFollowing) || hiddenByVisibility) {
    return json({
      success: true,
      profile: {
        ...profile,
        bio: "",
        avatarUrl: visibility === "nobody" ? "" : profile.avatarUrl,
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
      SELECT id,username,display_name,avatar_url,pi_verified,account_type
      FROM social_users
      WHERE is_active=1 AND id!=?
        AND (username LIKE ? OR display_name LIKE ?)
        AND id NOT IN (
          SELECT blocked_id FROM social_blocks WHERE blocker_id=?
        )
        AND id NOT IN (
          SELECT blocker_id FROM social_blocks WHERE blocked_id=?
        )
      ORDER BY username LIMIT ?
    `).bind(user.id, term, term, user.id, user.id, limit).all();

    output.users = (result.results || []).map(row => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name || "",
      avatarUrl: row.avatar_url || "",
      accountType: normalizeAccountType(row.account_type),
      piVerified: Boolean(row.pi_verified)
    }));
  }

  if (type === "all" || type === "posts") {
    const result = await env.DB.prepare(`
      SELECT p.id,p.content,p.media_json,p.created_at,
        u.username,u.display_name,u.avatar_url,u.account_type
      FROM social_posts p
      JOIN social_users u ON u.id=p.user_id
      WHERE p.visibility='public' AND p.content LIKE ?
        AND NOT EXISTS (
          SELECT 1 FROM social_user_settings privacy
          WHERE privacy.user_id=p.user_id AND privacy.is_private=1
        )
        AND p.user_id NOT IN (
          SELECT blocked_id FROM social_blocks WHERE blocker_id=?
        )
        AND p.user_id NOT IN (
          SELECT blocker_id FROM social_blocks WHERE blocked_id=?
        )
      ORDER BY p.created_at DESC LIMIT ?
    `).bind(term, user.id, user.id, limit).all();

    output.posts = (result.results || []).map(row => ({
      id: row.id,
      content: row.content,
      media: JSON.parse(row.media_json || "[]"),
      createdAt: row.created_at,
      author: {
        username: row.username,
        displayName: row.display_name || "",
        avatarUrl: row.avatar_url || "",
        accountType: normalizeAccountType(row.account_type)
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
    SELECT username,display_name,avatar_url,pi_verified,account_type
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
      accountType: normalizeAccountType(author?.account_type),
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
        AND NOT EXISTS (
          SELECT 1 FROM social_user_settings privacy
          WHERE privacy.user_id=p.user_id AND privacy.is_private=1
        )
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
        AND p.user_id NOT IN (
          SELECT blocked_id FROM social_blocks WHERE blocker_id=?
        )
        AND p.user_id NOT IN (
          SELECT blocker_id FROM social_blocks WHERE blocked_id=?
        )
      )
    ORDER BY p.created_at DESC,p.id DESC
    LIMIT ?
  `).bind(user.id, user.id, user.id, user.id, user.id, user.id, limit).all();

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

  if (target.id !== viewer.id && (settings?.is_private && !following || await isBlocked(env, viewer.id, target.id))) {
    return json({ success: true, posts: [], privateContent: true, total: 0 });
  }

  const result = await env.DB.prepare(`
    SELECT * FROM social_posts
    WHERE user_id=?
      AND (visibility IN ('public','followers') OR user_id=?)
    ORDER BY created_at DESC LIMIT 50
  `).bind(target.id, viewer.id).all();

  const posts = [];
  for (const row of result.results || []) {
    if (await canViewSocialPost(env, viewer.id, row)) {
      posts.push(await formatPost(row, viewer.id, env));
    }
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
    "SELECT id,user_id,visibility FROM social_posts WHERE id=?"
  ).bind(postId).first();

  if (!post || !(await canViewSocialPost(env, user.id, post))) return error("Post unavailable", 404);

  if (shouldLike && user.accountType === "ai") {
    return error("AI accounts cannot create likes or artificial engagement metrics.", 403);
  }

  if (shouldLike) {
    const likeResult = await env.DB.prepare(`
      INSERT OR IGNORE INTO social_post_likes(post_id,user_id) VALUES(?,?)
    `).bind(postId, user.id).run();

    // Only a newly-created like emits a notification. Repeated requests are
    // idempotent and notification outages cannot turn a saved like into a 500.
    if (Number(likeResult?.meta?.changes || 0) > 0) {
      try {
        await notify(env, post.user_id, user.id, "like", postId, "liked your post");
      } catch (notificationError) {
        console.error("SOCIAL_LIKE_NOTIFICATION_FAILURE", String(notificationError?.message || notificationError).slice(0, 200));
      }
    }
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
    "SELECT id,user_id,visibility FROM social_posts WHERE id=?"
  ).bind(postId).first();

  if (!post) return error("Post not found", 404);
  if (save && !(await canViewSocialPost(env, user.id, post))) return error("Post unavailable", 404);

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
    if (await canViewSocialPost(env, user.id, row)) {
      posts.push(await formatPost(row, user.id, env));
    }
  }

  return json({ success: true, posts, total: posts.length });
}

async function socialViewPost(request, env, postId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const post = await env.DB.prepare(
    "SELECT id,user_id,visibility FROM social_posts WHERE id=?"
  ).bind(postId).first();

  if (!post || !(await canViewSocialPost(env, user.id, post))) return error("Post unavailable", 404);
  if (user.accountType === "ai") return error("AI accounts do not generate human view counts.", 403);

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
    "SELECT id,user_id,visibility FROM social_posts WHERE id=?"
  ).bind(postId).first();

  if (!post || !(await canViewSocialPost(env, user.id, post))) return error("Post unavailable", 404);

  const result = await env.DB.prepare(`
    SELECT c.id,c.content,c.created_at,u.username,u.display_name,u.avatar_url,u.account_type
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
      avatarUrl: row.avatar_url || "",
      accountType: normalizeAccountType(row.account_type)
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
    "SELECT id,user_id,visibility FROM social_posts WHERE id=?"
  ).bind(postId).first();

  if (!post || !(await canViewSocialPost(env, user.id, post))) return error("Post unavailable", 404);

  const ownerSettings = await env.DB.prepare(
    "SELECT allow_comments FROM social_user_settings WHERE user_id=?"
  ).bind(post.user_id).first();
  if (ownerSettings?.allow_comments === "none") {
    return error("This user does not accept comments", 403);
  }
  if (ownerSettings?.allow_comments === "followers") {
    const follows = await env.DB.prepare(
      "SELECT 1 FROM social_follows WHERE follower_id=? AND following_id=?"
    ).bind(user.id, post.user_id).first();
    if (!follows) return error("Only followers can comment on this user's posts", 403);
  }

  const id = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO social_comments(id,post_id,user_id,content)
    VALUES(?,?,?,?)
  `).bind(id, postId, user.id, content).run();

  try {
    await notify(env, post.user_id, user.id, "comment", postId, "commented on your post");
  } catch (notificationError) {
    console.error("SOCIAL_COMMENT_NOTIFICATION_FAILURE", String(notificationError?.message || notificationError).slice(0, 200));
  }

  return json({
    success: true,
    comment: {
      id,
      content,
      createdAt: new Date().toISOString(),
      author: {
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        accountType: normalizeAccountType(user.accountType)
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
  if (user.accountType === "ai" && follow) return error("AI accounts cannot create follower-count interactions.", 403);
  if (await isBlocked(env, user.id, target.id)) return error("User unavailable", 404);

  const settings = await env.DB.prepare(
    "SELECT is_private FROM social_user_settings WHERE user_id=?"
  ).bind(target.id).first();

  if (follow && settings?.is_private) {
    const requestResult = await env.DB.prepare(`
      INSERT OR IGNORE INTO social_follow_requests(id,requester_id,target_id)
      VALUES(?,?,?)
    `).bind(crypto.randomUUID(), user.id, target.id).run();

    if (Number(requestResult?.meta?.changes || 0) > 0) {
      try {
        await notify(env, target.id, user.id, "follow_request", user.id, "requested to follow you");
      } catch (notificationError) {
        console.error("SOCIAL_FOLLOW_REQUEST_NOTIFICATION_FAILURE", String(notificationError?.message || notificationError).slice(0, 200));
      }
    }

    return json({ success: true, following: false, requestPending: true });
  }

  if (follow) {
    const followResult = await env.DB.prepare(`
      INSERT OR IGNORE INTO social_follows(follower_id,following_id)
      VALUES(?,?)
    `).bind(user.id, target.id).run();

    if (Number(followResult?.meta?.changes || 0) > 0) {
      try {
        await notify(env, target.id, user.id, "follow", user.id, "started following you");
      } catch (notificationError) {
        console.error("SOCIAL_FOLLOW_NOTIFICATION_FAILURE", String(notificationError?.message || notificationError).slice(0, 200));
      }
    }
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
    SELECT r.id,r.created_at,u.id AS user_id,u.username,u.display_name,u.avatar_url,u.account_type
    FROM social_follow_requests r
    JOIN social_users u ON u.id=r.requester_id AND u.is_active=1
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
        avatarUrl: row.avatar_url || "",
        accountType: normalizeAccountType(row.account_type)
      }
    }))
  });
}

async function socialFollowRequestAction(request, env, requestId, accept) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const row = await env.DB.prepare(`
    SELECT r.id,r.requester_id,r.target_id
    FROM social_follow_requests r
    JOIN social_users requester ON requester.id=r.requester_id AND requester.is_active=1
    JOIN social_users target ON target.id=r.target_id AND target.is_active=1
    WHERE r.id=? AND r.target_id=?
  `).bind(requestId, user.id).first();

  if (!row) return error("Follow request not found", 404);
  if (await isBlocked(env, row.requester_id, user.id)) {
    await env.DB.prepare("DELETE FROM social_follow_requests WHERE id=?").bind(requestId).run();
    return error("User unavailable", 404);
  }

  if (accept) {
    const results = await env.DB.batch([
      env.DB.prepare(`
        INSERT OR IGNORE INTO social_follows(follower_id,following_id)
        SELECT ?,?
        WHERE EXISTS (SELECT 1 FROM social_users WHERE id=? AND is_active=1)
          AND EXISTS (SELECT 1 FROM social_users WHERE id=? AND is_active=1)
          AND NOT EXISTS (
            SELECT 1 FROM social_blocks
            WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)
          )
      `).bind(row.requester_id, user.id, row.requester_id, user.id, row.requester_id, user.id, user.id, row.requester_id),
      env.DB.prepare(
        "DELETE FROM social_follow_requests WHERE id=?"
      ).bind(requestId)
    ]);

    if (Number(results?.[0]?.meta?.changes || 0) > 0) {
      try {
        await notify(env, row.requester_id, user.id, "follow_accepted", user.id, "accepted your follow request");
      } catch (notificationError) {
        console.error("SOCIAL_FOLLOW_ACCEPTED_NOTIFICATION_FAILURE", String(notificationError?.message || notificationError).slice(0, 200));
      }
    }
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

  for (const key of ["isPrivate", "showOnlineStatus", "showActivityStatus"]) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") {
      return error(`${key} must be a boolean`, 400);
    }
  }

  const current = await env.DB.prepare(
    "SELECT * FROM social_user_settings WHERE user_id=?"
  ).bind(user.id).first();

  const isPrivate = body.isPrivate === undefined
    ? Number(current?.is_private || 0)
    : (body.isPrivate === true ? 1 : 0);

  const allowMessages = ["everyone", "followers", "none"].includes(body.allowMessages)
    ? body.allowMessages
    : current?.allow_messages || "everyone";

  const allowComments = ["everyone", "followers", "none"].includes(body.allowComments)
    ? body.allowComments
    : current?.allow_comments || "everyone";

  const online = body.showOnlineStatus === undefined
    ? Number(current?.show_online_status ?? 1)
    : (body.showOnlineStatus === true ? 1 : 0);

  const activity = body.showActivityStatus === undefined
    ? Number(current?.show_activity_status ?? 1)
    : (body.showActivityStatus === true ? 1 : 0);

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

  const [result, unreadRow] = await Promise.all([
    env.DB.prepare(`
      SELECT n.id,n.type,n.target_id,n.message,n.is_read,n.created_at,
        u.username,u.display_name,u.avatar_url,u.account_type
      FROM social_notifications n
      LEFT JOIN social_users u ON u.id=n.actor_id
      WHERE n.user_id=?
      ORDER BY n.created_at DESC LIMIT ?
    `).bind(user.id, limit).all(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM social_notifications WHERE user_id=? AND is_read=0")
      .bind(user.id).first()
  ]);

  return json({
    success: true,
    unreadCount: Math.max(0, Number(unreadRow?.total || 0)),
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
        avatarUrl: row.avatar_url || "",
        accountType: normalizeAccountType(row.account_type)
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

async function canViewSocialStory(env, viewerId, story) {
  if (!story) return false;
  if (story.user_id === viewerId) return true;
  if (await isBlocked(env, viewerId, story.user_id)) return false;
  const following = await env.DB.prepare(
    "SELECT 1 FROM social_follows WHERE follower_id=? AND following_id=? LIMIT 1"
  ).bind(viewerId, story.user_id).first();
  return Boolean(following);
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
      u.username,u.display_name,u.avatar_url,u.account_type,
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
      AND NOT EXISTS (
        SELECT 1 FROM social_blocks b
        WHERE (b.blocker_id=? AND b.blocked_id=s.user_id)
           OR (b.blocker_id=s.user_id AND b.blocked_id=?)
      )
    ORDER BY s.created_at DESC LIMIT 100
  `).bind(user.id, now, user.id, user.id, user.id, user.id).all();

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
        avatarUrl: row.avatar_url || "",
        accountType: normalizeAccountType(row.account_type)
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

  // Stories must reference a ready public upload owned by the publisher.
  // This prevents arbitrary external URLs and cross-account media injection.
  const upload = await env.DB.prepare(`
    SELECT id,url,mime_type,status,acl FROM social_uploads
    WHERE user_id=? AND url=? LIMIT 1
  `).bind(user.id, mediaUrl).first();
  const expectedMime = mediaType === "video" ? "video/" : "image/";
  if (!upload || upload.status !== "ready" || upload.acl !== "public" ||
      !validHttpsUrl(upload.url) || !String(upload.mime_type || "").toLowerCase().startsWith(expectedMime)) {
    return error("Story media must be a ready image or video uploaded by your account.", 400);
  }

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

  if (!story || !await canViewSocialStory(env, user.id, story)) {
    return error("Story not found", 404);
  }
  if (user.accountType === "ai") return error("AI accounts do not generate human story views.", 403);

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
  if (user.accountType === "ai") return error("AI accounts cannot create artificial story reactions.", 403);

  const story = await env.DB.prepare(
    "SELECT id,user_id FROM social_stories WHERE id=? AND expires_at>?"
  ).bind(id, new Date().toISOString()).first();

  if (!story || !await canViewSocialStory(env, user.id, story)) {
    return error("Story not found", 404);
  }

  const reactionResult = await env.DB.prepare(`
    INSERT INTO social_story_reactions(story_id,user_id,reaction)
    VALUES(?,?,?)
    ON CONFLICT(story_id,user_id) DO UPDATE SET reaction=excluded.reaction
    WHERE social_story_reactions.reaction<>excluded.reaction
  `).bind(id, user.id, reaction).run();

  if (Number(reactionResult?.meta?.changes || 0) > 0) {
    try {
      await notify(env, story.user_id, user.id, "story_reaction", id, reaction);
    } catch (notificationError) {
      console.error("SOCIAL_STORY_REACTION_NOTIFICATION_FAILURE", String(notificationError?.message || notificationError).slice(0, 200));
    }
  }

  return json({ success: true, reaction });
}


async function socialCallStart(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  const body = await readBody(request);
  if (!body) return error("Invalid request body");
  const conversationId = cleanText(body.conversationId, 150);
  const kind = ["audio","video","live","group_voice"].includes(body.kind) ? body.kind : null;
  if (!conversationId || !kind) return error("A conversation and valid call type are required");
  const member = await isConversationMember(env, conversationId, user.id);
  if (!member) return error("Conversation not found", 404);
  if (await isDirectConversationBlocked(env, conversationId, user.id)) {
    return error("Calling is unavailable for this conversation", 403);
  }
  const conversation = await env.DB.prepare(
    "SELECT id,type,title FROM social_conversations WHERE id=?"
  ).bind(conversationId).first();
  if (!conversation) return error("Conversation not found", 404);
  if (kind === "group_voice" && conversation.type !== "group") return error("Group voice chat is only available in groups");
  const active = await env.DB.prepare(
    "SELECT id,kind FROM social_call_sessions WHERE conversation_id=? AND status='active' ORDER BY created_at DESC LIMIT 1"
  ).bind(conversationId).first();
  if (active) return json({success:true,callId:active.id,kind:active.kind,alreadyActive:true});
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO social_call_sessions(id,conversation_id,host_id,kind,status) VALUES(?,?,?,?,'active')").bind(id,conversationId,user.id,kind),
    env.DB.prepare("INSERT INTO social_call_participants(call_id,user_id) VALUES(?,?)").bind(id,user.id)
  ]);
  return json({success:true,callId:id,kind,conversationId},201);
}

async function socialCallActive(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  const url = new URL(request.url);
  const conversationId = cleanText(url.searchParams.get("conversationId"),150);
  if (!conversationId || !await isConversationMember(env,conversationId,user.id)) return error("Conversation not found",404);
  if (await isDirectConversationBlocked(env, conversationId, user.id)) return error("Conversation not found",404);
  const call = await env.DB.prepare(
    "SELECT id,kind,host_id,created_at FROM social_call_sessions WHERE conversation_id=? AND status='active' ORDER BY created_at DESC LIMIT 1"
  ).bind(conversationId).first();
  if (!call) return json({success:true,call:null});
  const participants = await env.DB.prepare(`
    SELECT p.user_id,u.username,u.display_name,u.avatar_url
    FROM social_call_participants p
    JOIN social_users u ON u.id=p.user_id
    JOIN social_conversation_members cm ON cm.conversation_id=? AND cm.user_id=p.user_id
    WHERE p.call_id=? AND p.left_at IS NULL AND p.last_seen_at>=datetime('now','-25 seconds')
    ORDER BY p.joined_at
  `).bind(call.conversation_id,call.id).all();
  return json({success:true,call:{id:call.id,kind:call.kind,hostId:call.host_id,createdAt:call.created_at,participants:participants.results||[]}});
}

async function socialCallJoin(request, env, callId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required",401);
  const call = await env.DB.prepare("SELECT id,conversation_id,kind,status FROM social_call_sessions WHERE id=?").bind(callId).first();
  if (!call || call.status!=="active") return error("This call has ended",404);
  if (!await isConversationMember(env,call.conversation_id,user.id)) return error("You are not a member of this conversation",403);
  if (await isDirectConversationBlocked(env, call.conversation_id, user.id)) return error("Calling is unavailable for this conversation",403);
  const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM social_call_participants WHERE call_id=? AND left_at IS NULL AND last_seen_at>=datetime('now','-25 seconds')").bind(callId).first();
  const cap = call.kind==="live" ? 12 : 8;
  const existing = await env.DB.prepare("SELECT 1 FROM social_call_participants WHERE call_id=? AND user_id=?").bind(callId,user.id).first();
  if (!existing && Number(count?.total||0)>=cap) return error("This room is full. Maximum participants: "+cap,409);
  await env.DB.prepare(`
    INSERT INTO social_call_participants(call_id,user_id,joined_at,last_seen_at,left_at)
    VALUES(?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL)
    ON CONFLICT(call_id,user_id) DO UPDATE SET last_seen_at=CURRENT_TIMESTAMP,left_at=NULL
  `).bind(callId,user.id).run();
  return json({success:true,callId,kind:call.kind,userId:user.id});
}

async function socialCallPoll(request, env, callId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required",401);
  const call = await env.DB.prepare("SELECT id,conversation_id,host_id,kind,status,created_at FROM social_call_sessions WHERE id=?").bind(callId).first();
  if (!call || call.status!=="active") return error("This call has ended",404);
  const member = await isConversationMember(env,call.conversation_id,user.id);
  if (!member) return error("You are not allowed in this call",403);
  const participant = await env.DB.prepare("SELECT left_at FROM social_call_participants WHERE call_id=? AND user_id=?").bind(callId,user.id).first();
  if (!participant || participant.left_at) return error("Join the call first",403);
  await env.DB.prepare("UPDATE social_call_participants SET last_seen_at=CURRENT_TIMESTAMP WHERE call_id=? AND user_id=?").bind(callId,user.id).run();
  const participants = await env.DB.prepare(`
    SELECT p.user_id,u.username,u.display_name,u.avatar_url
    FROM social_call_participants p JOIN social_users u ON u.id=p.user_id
    WHERE p.call_id=? AND p.left_at IS NULL AND p.last_seen_at>=datetime('now','-25 seconds')
    ORDER BY p.joined_at
  `).bind(callId).all();
  const url = new URL(request.url);
  const after = Math.max(0,Number(url.searchParams.get("after")||0));
  const signals = await env.DB.prepare(`
    SELECT seq,from_user_id,signal_type,payload_json
    FROM social_call_signals WHERE call_id=? AND to_user_id=? AND seq>?
    ORDER BY seq LIMIT 100
  `).bind(callId,user.id,Number.isFinite(after)?after:0).all();
  const items=(signals.results||[]).map(row=>({seq:row.seq,fromUserId:row.from_user_id,type:row.signal_type,payload:JSON.parse(row.payload_json||"{}")}));
  return json({success:true,call:{id:call.id,kind:call.kind,hostId:call.host_id,status:call.status,createdAt:call.created_at},userId:user.id,participants:participants.results||[],signals:items,nextAfter:items.length?items[items.length-1].seq:after});
}

async function socialCallSignal(request, env, callId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required",401);
  const body = await readBody(request);
  if (!body) return error("Invalid request body");
  const type = ["offer","answer","candidate"].includes(body.type) ? body.type : null;
  const toUserId = cleanText(body.toUserId,150);
  if (!type || !toUserId || !body.payload || typeof body.payload!=="object" || Array.isArray(body.payload)) return error("Invalid call signal");
  if (!await checkRateLimit(env, request, "social-call-signal", 300, 60, 60)) {
    return error("Call signaling is temporarily rate limited. Please wait a moment.", 429);
  }
  const call = await env.DB.prepare("SELECT conversation_id,status FROM social_call_sessions WHERE id=?").bind(callId).first();
  if (!call || call.status!=="active") return error("Call has ended",404);
  const senderMembership = await isConversationMember(env, call.conversation_id, user.id);
  const targetMembership = await isConversationMember(env, call.conversation_id, toUserId);
  if (!senderMembership || !targetMembership) return error("Both users must remain members of this conversation",403);
  if (await isDirectConversationBlocked(env, call.conversation_id, user.id) || await isDirectConversationBlocked(env, call.conversation_id, toUserId)) {
    return error("Call signaling is unavailable for this conversation",403);
  }
  const sender = await env.DB.prepare("SELECT 1 FROM social_call_participants WHERE call_id=? AND user_id=? AND left_at IS NULL").bind(callId,user.id).first();
  const target = await env.DB.prepare("SELECT 1 FROM social_call_participants WHERE call_id=? AND user_id=? AND left_at IS NULL").bind(callId,toUserId).first();
  if (!sender || !target) return error("Both users must be in the call",403);
  const payload = JSON.stringify(body.payload);
  if (payload.length>20000) return error("Call signal is too large");
  await env.DB.prepare("INSERT INTO social_call_signals(call_id,from_user_id,to_user_id,signal_type,payload_json) VALUES(?,?,?,?,?)").bind(callId,user.id,toUserId,type,payload).run();
  return json({success:true});
}

async function socialCallLeave(request, env, callId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required",401);
  const call = await env.DB.prepare("SELECT id,host_id FROM social_call_sessions WHERE id=? AND status='active'").bind(callId).first();
  if (!call) return json({success:true,ended:true});
  await env.DB.prepare("UPDATE social_call_participants SET left_at=CURRENT_TIMESTAMP WHERE call_id=? AND user_id=?").bind(callId,user.id).run();
  if (call.host_id===user.id) {
    await env.DB.prepare("UPDATE social_call_sessions SET status='ended',ended_at=CURRENT_TIMESTAMP WHERE id=?").bind(callId).run();
  } else {
    const remaining=await env.DB.prepare("SELECT COUNT(*) AS total FROM social_call_participants WHERE call_id=? AND left_at IS NULL AND last_seen_at>=datetime('now','-25 seconds')").bind(callId).first();
    if (!Number(remaining?.total||0)) await env.DB.prepare("UPDATE social_call_sessions SET status='ended',ended_at=CURRENT_TIMESTAMP WHERE id=?").bind(callId).run();
  }
  return json({success:true,ended:call.host_id===user.id});
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
    WHERE c.type IN ('direct','private')
      AND a.user_id=? AND b.user_id=?
    LIMIT 1
  `).bind(user.id, target.id).first();

  if (existing) return json({ success: true, conversationId: existing.id });

  const id = crypto.randomUUID();
  let conversationCreated = false;
  let createStage = "conversation_insert";

  try {
    // Support both the current schema and legacy schemas where creator_id
    // or created_by is still a NOT NULL column.
    const schema = await env.DB.prepare("PRAGMA table_info(social_conversations)").all();
    const available = new Set((schema.results || []).map(column => column.name));
    const insertColumns = ["id", "type", "owner_id"];
    const insertValues = [id, "direct", user.id];
    for (const legacyOwnerColumn of ["created_by", "creator_id"]) {
      if (available.has(legacyOwnerColumn)) {
        insertColumns.push(legacyOwnerColumn);
        insertValues.push(user.id);
      }
    }
    const placeholders = insertColumns.map(() => "?").join(",");
    await env.DB.prepare(
      "INSERT INTO social_conversations(" + insertColumns.join(",") + ") VALUES(" + placeholders + ")"
    ).bind(...insertValues).run();
    conversationCreated = true;

    createStage = "first_member_insert";
    await env.DB.prepare(`
      INSERT INTO social_conversation_members(conversation_id,user_id,role,last_read_message_rowid)
      VALUES(?,?,'member',0)
    `).bind(id, user.id).run();

    createStage = "second_member_insert";
    await env.DB.prepare(`
      INSERT INTO social_conversation_members(conversation_id,user_id,role,last_read_message_rowid)
      VALUES(?,?,'member',0)
    `).bind(id, target.id).run();

    createStage = "membership_verification";
    const verified = await env.DB.prepare(`
      SELECT COUNT(*) AS member_count
      FROM social_conversation_members
      WHERE conversation_id=?
    `).bind(id).first();

    if (Number(verified?.member_count || 0) !== 2) {
      throw new Error("Conversation membership verification failed");
    }
  } catch (err) {
    const diagnostic = {
      stage: createStage,
      message: String(err?.message || err).slice(0, 300)
    };
    console.error("SOCIAL_DIRECT_CHAT_CREATE_FAILURE", diagnostic);
    if (conversationCreated) {
      try {
        await env.DB.prepare("DELETE FROM social_conversations WHERE id=?").bind(id).run();
      } catch (cleanupError) {
        console.error("SOCIAL_DIRECT_CHAT_CLEANUP_FAILURE", String(cleanupError?.message || cleanupError).slice(0, 200));
      }
    }
    // Return a non-sensitive stage code so the failing database operation can
    // be identified without exposing SQL details to ordinary users.
    return json({
      success: false,
      error: "Could not create this chat. Please try again.",
      code: "CHAT_CREATE_" + createStage.toUpperCase(),
      detail: String(err?.message || err).slice(0, 220)
    }, 500);
  }

  return json({ success: true, conversationId: id }, 201);
}

async function socialPresenceHeartbeat(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  await env.DB.prepare(
    "UPDATE social_users SET last_seen_at=CURRENT_TIMESTAMP WHERE id=? AND is_active=1"
  ).bind(user.id).run();
  return json({ success: true, updated: true });
}

async function socialListConversations(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  let stage = "preferences";
  try {
    const preferenceRow = await env.DB.prepare(
      "SELECT preferences_json FROM social_extended_settings WHERE user_id=?"
    ).bind(user.id).first();
    let conversationPrefs = {};
    try { conversationPrefs = JSON.parse(preferenceRow?.preferences_json || "{}"); } catch {}
    const showMessagePreviews = conversationPrefs.chat?.messagePreviews !== false;

    stage = "conversation_query";
    const result = await env.DB.prepare(`
      SELECT c.id,c.type,c.title,c.updated_at,cm.last_read_at,
        (SELECT m.content FROM social_messages m
         WHERE m.conversation_id=c.id AND m.deleted_at IS NULL
         ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) AS last_message,
        (SELECT m.created_at FROM social_messages m
         WHERE m.conversation_id=c.id
         ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) AS last_message_at,
        (SELECT COUNT(*) FROM social_messages unread
         WHERE unread.conversation_id=c.id
           AND unread.sender_id<>?
           AND unread.deleted_at IS NULL
           AND unread.rowid>COALESCE(cm.last_read_message_rowid,(
              SELECT MAX(read_cursor.rowid) FROM social_messages read_cursor
              WHERE read_cursor.conversation_id=c.id
                AND read_cursor.created_at<=COALESCE(NULLIF(cm.last_read_at,''),NULLIF(cm.joined_at,''),'1970-01-01 00:00:00')
            ),0)
        ) AS unread_count
      FROM social_conversations c
      JOIN social_conversation_members cm ON cm.conversation_id=c.id
      WHERE cm.user_id=?
        AND NOT (
          c.type IN ('direct','private')
          AND EXISTS (
            SELECT 1
            FROM social_conversation_members other_member
            JOIN social_blocks block_edge
              ON (block_edge.blocker_id=? AND block_edge.blocked_id=other_member.user_id)
              OR (block_edge.blocker_id=other_member.user_id AND block_edge.blocked_id=?)
            WHERE other_member.conversation_id=c.id
              AND other_member.user_id<>?
          )
        )
      ORDER BY COALESCE(last_message_at,c.updated_at) DESC
      LIMIT 100
    `).bind(user.id, user.id, user.id, user.id).all();

    const conversations = [];
    for (const row of result.results || []) {
      stage = "members_query";
      const members = await env.DB.prepare(`
        SELECT u.id,u.username,u.display_name,u.avatar_url,u.account_type,cm.role,
          cm.last_read_at,cm.last_read_message_rowid,
          readprefs.preferences_json AS read_preferences_json,
          CASE WHEN COALESCE(us.show_online_status,1)=1 THEN u.last_seen_at ELSE NULL END AS last_seen_at
        FROM social_conversation_members cm
        JOIN social_users u ON u.id=cm.user_id
        LEFT JOIN social_user_settings us ON us.user_id=u.id
        LEFT JOIN social_extended_settings readprefs ON readprefs.user_id=u.id
        WHERE cm.conversation_id=?
        LIMIT 100
      `).bind(row.id).all();

      conversations.push({
        id: row.id, type: row.type, title: row.title,
        lastMessage: showMessagePreviews ? (row.last_message || "") : "",
        lastMessageAt: row.last_message_at || row.updated_at,
        lastReadAt: row.last_read_at || null,
        unreadCount: Math.max(0, Number(row.unread_count || 0)),
        members: (members.results || []).map(member => ({
          id: member.id, username: member.username,
          displayName: member.display_name || "",
          avatarUrl: member.avatar_url || "", accountType: normalizeAccountType(member.account_type), role: member.role,
          lastSeenAt: member.last_seen_at || null,
          lastReadAt: (() => {
            let prefs = {};
            try { prefs = JSON.parse(member.read_preferences_json || "{}"); } catch {}
            return prefs.chat?.readReceipts === false ? null : (member.last_read_at || null);
          })(),
          lastReadMessageRowId: (() => {
            let prefs = {};
            try { prefs = JSON.parse(member.read_preferences_json || "{}"); } catch {}
            return prefs.chat?.readReceipts === false ? null : (member.last_read_message_rowid == null ? null : Number(member.last_read_message_rowid));
          })()
        }))
      });
    }
    return json({ success: true, conversations });
  } catch (err) {
    console.error("SOCIAL_CONVERSATIONS_LIST_FAILURE", { stage, message: String(err?.message || err) });
    return json({
      success: false,
      error: "Could not load conversations.",
      code: "CHAT_LIST_" + stage.toUpperCase(),
      detail: String(err?.message || err).slice(0, 220)
    }, 500);
  }
}

async function isConversationMember(env, conversationId, userId) {
  const row = await env.DB.prepare(`
    SELECT role FROM social_conversation_members
    WHERE conversation_id=? AND user_id=?
  `).bind(conversationId, userId).first();

  return row || null;
}

async function isDirectConversationBlocked(env, conversationId, userId) {
  const result = await env.DB.prepare(`
    SELECT c.type,cm.user_id
    FROM social_conversations c
    JOIN social_conversation_members cm ON cm.conversation_id=c.id
    WHERE c.id=? AND cm.user_id<>?
  `).bind(conversationId, userId).all();

  for (const row of result.results || []) {
    if (["direct", "private"].includes(row.type) &&
        await isBlocked(env, userId, row.user_id)) return true;
  }
  return false;
}

async function socialConversationMessages(request, env, conversationId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  const member = await isConversationMember(env, conversationId, user.id);
  if (!member) return error("Conversation not found", 404);
  if (await isDirectConversationBlocked(env, conversationId, user.id)) {
    return error("Conversation not found", 404);
  }
  const url = new URL(request.url);
  const limit = safeLimit(url.searchParams.get("limit"), 50, 100);
  const result = await env.DB.prepare(`
    SELECT m.id,m.rowid AS message_rowid,m.sender_id,m.content,m.media_json,m.reply_to,
      m.forwarded_from,m.edited_at,m.deleted_at,m.created_at,
      u.username,u.display_name,u.avatar_url,u.account_type
    FROM social_messages m
    JOIN social_users u ON u.id=m.sender_id
    WHERE m.conversation_id=?
    ORDER BY m.created_at DESC,m.rowid DESC LIMIT ?
  `).bind(conversationId, limit).all();
  const messages = [];
  for (const row of (result.results || []).reverse()) {
    let media = [];
    if (!row.deleted_at) {
      try { media = JSON.parse(row.media_json || "[]"); } catch { media = []; }
      media = await Promise.all(media.map(async item => {
        if (!item?.uploadId) return item;
        try {
          const upload = await env.DB.prepare(
            "SELECT id,name,mime_type,acl,status FROM social_uploads WHERE id=? AND user_id=? LIMIT 1"
          ).bind(item.uploadId, row.sender_id).first();
          if (!upload || upload.status !== "ready" || upload.acl !== "private") {
            return { type: item.type || upload?.mime_type || "", name: item.name || upload?.name || "Attachment", unavailable: true };
          }
          const signed = await rapidfileRequest(env, `/files/${encodeURIComponent(upload.id)}/signed-url`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expiresIn: 3600 })
          });
          if (!signed.url || !validHttpsUrl(signed.url)) throw new Error("Invalid signed media URL");
          return { url: signed.url, type: item.type || upload.mime_type, name: item.name || upload.name };
        } catch (e) {
          console.warn("Private chat attachment URL unavailable:", e?.message || e);
          return { type: item.type || "", name: item.name || "Attachment", unavailable: true };
        }
      }));
    }
    messages.push({
      id: row.id,
      messageRowId: Number(row.message_rowid),
      senderId: row.sender_id,
      content: row.deleted_at ? "Message deleted" : row.content,
      media,
      replyTo: row.reply_to,
      forwardedFrom: row.forwarded_from,
      editedAt: row.edited_at,
      deleted: Boolean(row.deleted_at),
      createdAt: row.created_at,
      author: {
        username: row.username,
        displayName: row.display_name || "",
        avatarUrl: row.avatar_url || "",
        accountType: normalizeAccountType(row.account_type)
      },
      isMine: row.sender_id === user.id
    });
  }
  // Advance only through the newest message included in this response.
  // A message arriving after the SELECT must remain unread until a later refresh.
  // The viewer's readReceipts preference controls visibility, not cursor accuracy.
  const newestDelivered = (result.results || [])[0];
  if (newestDelivered?.message_rowid != null) {
    await env.DB.prepare(`
      UPDATE social_conversation_members
      SET last_read_at=?,
          last_read_message_rowid=?
      WHERE conversation_id=? AND user_id=?
    `).bind(
      newestDelivered.created_at,
      Number(newestDelivered.message_rowid),
      conversationId,
      user.id
    ).run();
  }
  return json({ success: true, messages });
}

async function socialSendMessage(request, env, conversationId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  const member = await isConversationMember(env, conversationId, user.id);
  if (!member) return error("Conversation not found", 404);
  if (await isDirectConversationBlocked(env, conversationId, user.id)) {
    return error("Messaging is unavailable for this conversation", 403);
  }

  const directRecipient = await env.DB.prepare(`
    SELECT c.type,u.id AS user_id
    FROM social_conversations c
    JOIN social_conversation_members m ON m.conversation_id=c.id AND m.user_id!=?
    JOIN social_users u ON u.id=m.user_id AND u.is_active=1
    WHERE c.id=? AND c.type IN ('direct','private')
    LIMIT 1
  `).bind(user.id, conversationId).first();

  if (directRecipient) {
    const recipientSettings = await env.DB.prepare(
      "SELECT allow_messages FROM social_user_settings WHERE user_id=?"
    ).bind(directRecipient.user_id).first();

    if (recipientSettings?.allow_messages === "none") {
      return error("This user no longer accepts messages", 403);
    }
    if (recipientSettings?.allow_messages === "followers") {
      const follows = await env.DB.prepare(
        "SELECT 1 FROM social_follows WHERE follower_id=? AND following_id=?"
      ).bind(user.id, directRecipient.user_id).first();
      if (!follows) return error("Only followers can message this user", 403);
    }
  }

  const body = await readBody(request);
  if (!body) return error("Invalid request body");
  const content = cleanText(body.content, 10000);
  const rawMedia = Array.isArray(body.media) ? body.media.slice(0, 10) : [];
  if (!content && rawMedia.length === 0) return error("Message cannot be empty");
  const media = [];
  for (const item of rawMedia) {
    if (item?.uploadId) {
      const uploadId = String(item.uploadId).slice(0, 150);
      const upload = await env.DB.prepare(
        "SELECT id,name,mime_type,acl,status FROM social_uploads WHERE id=? AND user_id=? LIMIT 1"
      ).bind(uploadId, user.id).first();
      if (!upload || upload.status !== "ready" || upload.acl !== "private") {
        return error("Private attachment is unavailable or does not belong to your account.", 400);
      }
      media.push({
        uploadId: upload.id,
        type: cleanText(item.type || upload.mime_type, 100),
        name: cleanText(item.name || upload.name, 180)
      });
    } else if (item && validHttpsUrl(item.url)) {
      // Backward compatibility for existing public attachments.
      media.push({
        url: item.url,
        type: cleanText(item.type || "", 100),
        name: cleanText(item.name || "", 180)
      });
    } else {
      return error("Invalid message attachment");
    }
  }
  const replyTo = body.replyTo ? cleanText(body.replyTo, 150) : null;
  if (replyTo) {
    const reply = await env.DB.prepare(
      "SELECT id FROM social_messages WHERE id=? AND conversation_id=?"
    ).bind(replyTo, conversationId).first();
    if (!reply) return error("Reply message not found", 404);
  }
  const id = crypto.randomUUID();
  let sendStage = "message_schema";
  try {
    // Adapt inserts to legacy D1 table columns without weakening access checks.
    const schema = await env.DB.prepare("PRAGMA table_info(social_messages)").all();
    const columns = schema.results || [];
    const values = {
      id, conversation_id: conversationId, sender_id: user.id,
      content, message: content, body: content, text: content,
      media_json: JSON.stringify(media), reply_to: replyTo, forwarded_from: null,
      message_type: "text", type: "text", sender: user.id, user_id: user.id, chat_id: conversationId
    };
    const insertColumns = [], insertValues = [];
    for (const column of columns) {
      if (Object.prototype.hasOwnProperty.call(values, column.name)) {
        insertColumns.push(column.name); insertValues.push(values[column.name]);
      } else if (column.notnull && column.dflt_value == null && !column.pk) {
        throw new Error("Unsupported required column: " + column.name);
      }
    }
    if (!insertColumns.includes("id") || !insertColumns.includes("conversation_id") || !insertColumns.includes("sender_id")) {
      throw new Error("The message table is missing a required core column.");
    }
    sendStage = "message_insert";
    await env.DB.prepare(
      "INSERT INTO social_messages(" + insertColumns.join(",") + ") VALUES(" + insertColumns.map(() => "?").join(",") + ")"
    ).bind(...insertValues).run();
    sendStage = "conversation_update";
    await env.DB.prepare("UPDATE social_conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(conversationId).run();
    // Notification delivery is best-effort and cannot invalidate a saved message.
    try {
      const conversation = await env.DB.prepare("SELECT type FROM social_conversations WHERE id=?").bind(conversationId).first();
      const members = await env.DB.prepare("SELECT user_id FROM social_conversation_members WHERE conversation_id=? AND user_id!=?").bind(conversationId, user.id).all();
      const notificationType = conversation?.type === "group" ? "group_message" : "message";
      for (const row of members.results || []) {
        try {
          await notify(env, row.user_id, user.id, notificationType, conversationId,
            conversation?.type === "group" ? "new activity in your group" : "sent you a message");
        } catch (notificationError) {
          console.error("SOCIAL_MESSAGE_NOTIFICATION_FAILURE", String(notificationError?.message || notificationError).slice(0, 200));
        }
      }
    } catch (notificationError) {
      console.error("SOCIAL_MESSAGE_NOTIFICATION_LOOKUP_FAILURE", String(notificationError?.message || notificationError).slice(0, 200));
    }
  } catch (err) {
    console.error("SOCIAL_MESSAGE_SEND_FAILURE", { stage: sendStage, message: String(err?.message || err).slice(0, 300) });
    return json({ success: false, error: "Could not send this message.", code: "CHAT_SEND_" + sendStage.toUpperCase(), detail: String(err?.message || err).slice(0, 220) }, 500);
  }
  return json({
    success: true,
    message: { id, conversationId, senderId: user.id, content, media, replyTo, createdAt: new Date().toISOString() }
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
      AND EXISTS (
        SELECT 1 FROM social_conversation_members cm
        WHERE cm.conversation_id=social_messages.conversation_id
          AND cm.user_id=?
      )
  `).bind(content, messageId, user.id, user.id).run();

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
      AND EXISTS (
        SELECT 1 FROM social_conversation_members cm
        WHERE cm.conversation_id=social_messages.conversation_id
          AND cm.user_id=?
      )
  `).bind(messageId, user.id, user.id).run();

  if (!result.meta || result.meta.changes === 0) {
    return error("Message not found or not deletable", 404);
  }

  return json({ success: true, deleted: true });
}

async function socialTransferGroupOwnership(request, env, conversationId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  const body = await readBody(request);
  const targetUserId = String(body?.userId || "");
  if (!targetUserId || targetUserId.length > 150) return error("A valid group member is required", 400);
  if (targetUserId === user.id) return error("You already own this group", 400);
  const group = await env.DB.prepare("SELECT id,owner_id FROM social_conversations WHERE id=? AND type='group'").bind(conversationId).first();
  if (!group) return error("Group not found", 404);
  if (group.owner_id !== user.id) return error("Only the group owner can transfer ownership", 403);
  const target = await env.DB.prepare("SELECT role FROM social_conversation_members WHERE conversation_id=? AND user_id=?").bind(conversationId, targetUserId).first();
  if (!target) return error("The new owner must already be a group member", 400);
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE social_conversations SET owner_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND type='group' AND owner_id=?").bind(targetUserId, conversationId, user.id),
    env.DB.prepare("UPDATE social_conversation_members SET role='admin' WHERE conversation_id=? AND user_id=? AND EXISTS (SELECT 1 FROM social_conversations WHERE id=? AND owner_id=?)").bind(conversationId, user.id, conversationId, targetUserId),
    env.DB.prepare("UPDATE social_conversation_members SET role='owner' WHERE conversation_id=? AND user_id=? AND EXISTS (SELECT 1 FROM social_conversations WHERE id=? AND owner_id=?)").bind(conversationId, targetUserId, conversationId, targetUserId),
    env.DB.prepare("DELETE FROM social_group_invites WHERE conversation_id=?").bind(conversationId)
  ]);
  if (!Number(results?.[0]?.meta?.changes || 0) || !Number(results?.[1]?.meta?.changes || 0) || !Number(results?.[2]?.meta?.changes || 0)) {
    return error("Ownership transfer could not be completed. Refresh and try again.", 409);
  }
  return json({ success: true, transferred: true, ownerId: targetUserId });
}

async function socialLeaveGroup(request, env, conversationId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const conversation = await env.DB.prepare(
    "SELECT type,owner_id FROM social_conversations WHERE id=?"
  ).bind(conversationId).first();
  if (!conversation || conversation.type !== "group") return error("Group not found", 404);
  if (conversation.owner_id === user.id) {
    return error("The group owner must transfer ownership before leaving", 409);
  }

  const result = await env.DB.prepare(
    "DELETE FROM social_conversation_members WHERE conversation_id=? AND user_id=?"
  ).bind(conversationId, user.id).run();
  if (!Number(result.meta?.changes || 0)) return error("You are not a group member", 404);

  await env.DB.prepare(
    "DELETE FROM social_group_invites WHERE conversation_id=? AND created_by=?"
  ).bind(conversationId, user.id).run();

  return json({ success: true, left: true });
}

async function socialManageGroupMember(request, env, conversationId, targetUserId, action) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const conversation = await env.DB.prepare(
    "SELECT type FROM social_conversations WHERE id=?"
  ).bind(conversationId).first();
  if (!conversation || conversation.type !== "group") return error("Group not found", 404);
  if (targetUserId === user.id) return error("Use the leave-group action to remove yourself", 400);

  if (action === "remove") {
    const result = await env.DB.prepare(`
      DELETE FROM social_conversation_members
      WHERE conversation_id=? AND user_id=? AND role!='owner'
        AND EXISTS (
          SELECT 1 FROM social_conversation_members actor
          WHERE actor.conversation_id=? AND actor.user_id=?
            AND (actor.role='owner' OR (actor.role='admin' AND social_conversation_members.role='member'))
        )
    `).bind(conversationId, targetUserId, conversationId, user.id).run();
    if (!Number(result.meta?.changes || 0)) return error("Member not found or insufficient permissions", 403);
    // Revoke every outstanding group invite so a removed member cannot
    // re-enter through a link created by another administrator.
    await env.DB.prepare(
      "DELETE FROM social_group_invites WHERE conversation_id=?"
    ).bind(conversationId).run();
    return json({ success: true, removed: true });
  }

  if (action === "role") {
    const body = await readBody(request);
    const nextRole = body?.role;
    if (!["admin", "member"].includes(nextRole)) return error("Invalid group role");
    const result = await env.DB.prepare(`
      UPDATE social_conversation_members
      SET role=?
      WHERE conversation_id=? AND user_id=? AND role!='owner'
        AND EXISTS (
          SELECT 1 FROM social_conversation_members actor
          WHERE actor.conversation_id=? AND actor.user_id=?
            AND (actor.role='owner' OR (actor.role='admin' AND ?='member' AND social_conversation_members.role='member'))
        )
    `).bind(nextRole, conversationId, targetUserId, conversationId, user.id, nextRole).run();
    if (!Number(result.meta?.changes || 0)) return error("Member not found or insufficient permissions", 403);
    // Revoke outstanding invitations whenever an administrator role changes.
    await env.DB.prepare(
      "DELETE FROM social_group_invites WHERE conversation_id=?"
    ).bind(conversationId).run();
    return json({ success: true, role: nextRole, previousInvitesRevoked: true });
  }

  return error("Unsupported group member action", 400);
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

  // Validate every requested member before creating anything, so a rejected
  // invitation never leaves behind a half-created group.
  const targets = [];
  for (const username of usernames) {
    if (username === user.username) continue;
    const target = await env.DB.prepare(
      "SELECT id FROM social_users WHERE username=? AND is_active=1"
    ).bind(username).first();
    if (!target || await isBlocked(env, user.id, target.id)) continue;
    const prefRow = await env.DB.prepare(
      "SELECT preferences_json FROM social_extended_settings WHERE user_id=?"
    ).bind(target.id).first();
    let prefs = {};
    try { prefs = JSON.parse(prefRow?.preferences_json || "{}"); } catch {}
    const rule = ["everyone","contacts","nobody"].includes(prefs.privacy?.whoCanAddToGroups)
      ? prefs.privacy.whoCanAddToGroups : "everyone";
    if (rule === "nobody") return error("@" + username + " does not allow being added to groups", 403);
    if (rule === "contacts") {
      const mutual = await env.DB.prepare(`
        SELECT 1 FROM social_follows a
        JOIN social_follows b ON b.follower_id=a.following_id AND b.following_id=a.follower_id
        WHERE a.follower_id=? AND a.following_id=? LIMIT 1
      `).bind(target.id, user.id).first();
      if (!mutual) return error("Only mutual contacts can add @" + username + " to groups", 403);
    }
    targets.push(target);
  }

  // Do not create a shared group that forcibly places two blocked accounts
  // together. Blocking is symmetric, regardless of which participant set it.
  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      if (await isBlocked(env, targets[i].id, targets[j].id)) {
        return error("The selected members cannot be placed in the same group", 403);
      }
    }
  }

  const id = crypto.randomUUID();
  // Use individual D1 writes with compensating cleanup. This also works
  // on older D1 bindings where batch execution can fail for legacy schemas.
  try {
    await env.DB.prepare(`
      INSERT INTO social_conversations(id,type,title,owner_id)
      VALUES(?,'group',?,?)
    `).bind(id, title, user.id).run();
    await env.DB.prepare(`
      INSERT INTO social_conversation_members(conversation_id,user_id,role,last_read_message_rowid)
      VALUES(?,?,'owner',0)
    `).bind(id, user.id).run();
    for (const target of targets) {
      await env.DB.prepare(`
        INSERT OR IGNORE INTO social_conversation_members(conversation_id,user_id,role,last_read_message_rowid)
        VALUES(?,?,'member',0)
      `).bind(id, target.id).run();
    }
  } catch (err) {
    try {
      await env.DB.prepare("DELETE FROM social_conversation_members WHERE conversation_id=?").bind(id).run();
      await env.DB.prepare("DELETE FROM social_conversations WHERE id=?").bind(id).run();
    } catch (cleanupErr) {
      console.error("SOCIAL group cleanup failed:", String(cleanupErr?.message || cleanupErr).slice(0, 300));
    }
    console.error("SOCIAL group creation failed:", {
      name: err?.name || "Error",
      message: String(err?.message || err).slice(0, 500)
    });
    const detail = String(err?.message || err).slice(0, 700);
    if (user.username === "mehranmsh") {
      return json({ success: false, error: "Could not create the group. [GROUP_CREATE_FAILED]", detail }, 500);
    }
    return error("Could not create the group. Please try again. [GROUP_CREATE_FAILED]", 500);
  }

  // Notify newly added members as group invitations. The shared notifier
  // enforces both notification and community-invite preferences.
  for (const target of targets) {
    try {
      await notify(env, target.id, user.id, "group_invite", id, "added you to a group");
    } catch (notificationError) {
      console.error("SOCIAL_GROUP_INVITATION_NOTIFICATION_FAILURE", String(notificationError?.message || notificationError).slice(0, 200));
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
  const conversation = await env.DB.prepare(
    "SELECT type FROM social_conversations WHERE id=?"
  ).bind(conversationId).first();
  if (conversation?.type !== "group") return error("Group not found", 404);

  const code = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM social_group_invites WHERE conversation_id=?").bind(conversationId),
    env.DB.prepare(`
      INSERT INTO social_group_invites(id,conversation_id,created_by,invite_code)
      VALUES(?,?,?,?)
    `).bind(crypto.randomUUID(), conversationId, user.id, code)
  ]);
  if (!Number(results?.[1]?.meta?.changes || 0)) {
    return error("Could not create a new group invitation", 500);
  }
  return json({ success: true, inviteCode: code, previousInvitesRevoked: true });
}

async function socialJoinGroup(request, env, code) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const invite = await env.DB.prepare(`
    SELECT i.conversation_id,i.created_by,c.owner_id,c.type
    FROM social_group_invites i
    JOIN social_conversations c ON c.id=i.conversation_id
    WHERE i.invite_code=? AND (i.expires_at IS NULL OR i.expires_at>?)
  `).bind(code, new Date().toISOString()).first();

  if (!invite || invite.type !== "group") return error("Invalid or expired invite link", 404);
  if (await isBlocked(env, user.id, invite.owner_id) ||
      await isBlocked(env, user.id, invite.created_by)) {
    return error("Group access is unavailable", 403);
  }

  // Joining by link is still a group-join action, so check every current
  // participant rather than only the owner and the invite creator.
  const existingMembers = await env.DB.prepare(
    "SELECT user_id FROM social_conversation_members WHERE conversation_id=?"
  ).bind(invite.conversation_id).all();
  for (const existing of existingMembers.results || []) {
    if (existing.user_id !== user.id && await isBlocked(env, user.id, existing.user_id)) {
      return error("Group access is unavailable because of a block relationship", 403);
    }
  }

  await env.DB.prepare(`
    INSERT OR IGNORE INTO social_conversation_members(
      conversation_id,user_id,role,last_read_at,last_read_message_rowid
    )
    SELECT ?,?,'member',CURRENT_TIMESTAMP,
      COALESCE((SELECT MAX(rowid) FROM social_messages WHERE conversation_id=?),0)
  `).bind(invite.conversation_id, user.id, invite.conversation_id).run();

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
    await env.DB.prepare(`
      INSERT INTO social_channels(
        id,owner_id,title,description,username,is_private,invite_code
      )
      VALUES(?,?,?,?,?,?,?)
    `).bind(id, user.id, title, description, username, isPrivate, inviteCode).run();
    await env.DB.prepare(`
      INSERT INTO social_channel_members(channel_id,user_id,role)
      VALUES(?,?,'owner')
    `).bind(id, user.id).run();
  } catch (err) {
    const detail = String(err?.message || err);
    try {
      await env.DB.prepare("DELETE FROM social_channel_members WHERE channel_id=?").bind(id).run();
      await env.DB.prepare("DELETE FROM social_channels WHERE id=?").bind(id).run();
    } catch (cleanupErr) {
      console.error("SOCIAL channel cleanup failed:", String(cleanupErr?.message || cleanupErr).slice(0, 300));
    }
    console.error("SOCIAL channel creation failed:", {
      name: err?.name || "Error",
      message: detail.slice(0, 500)
    });
    if (username && /unique constraint failed:\s*social_channels\.username/i.test(detail)) {
      return error("Channel username is already taken", 409);
    }
    if (user.username === "mehranmsh") {
      return json({ success: false, error: "Could not create the channel. [CHANNEL_CREATE_FAILED]", detail: detail.slice(0, 700) }, 500);
    }
    return error("Could not create the channel. Please try again. [CHANNEL_CREATE_FAILED]", 500);
  }

  return json({
    success: true,
    channel: { id, title, description, username, isPrivate: Boolean(isPrivate), inviteCode }
  }, 201);
}

async function getAccessibleChannelMembership(env, channelId, userId) {
  const member = await env.DB.prepare(`
    SELECT m.role,c.owner_id
    FROM social_channel_members m
    JOIN social_channels c ON c.id=m.channel_id
    WHERE m.channel_id=? AND m.user_id=?
  `).bind(channelId, userId).first();
  if (!member || await isBlocked(env, userId, member.owner_id)) return null;
  return member;
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
      AND NOT EXISTS (
        SELECT 1 FROM social_blocks b
        WHERE (b.blocker_id=? AND b.blocked_id=c.owner_id)
           OR (b.blocker_id=c.owner_id AND b.blocked_id=?)
      )
    ORDER BY c.created_at DESC LIMIT 100
  `).bind(user.id, user.id, user.id).all();

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
    "SELECT id,owner_id,is_private,invite_code FROM social_channels WHERE id=?"
  ).bind(channelId).first();

  if (!channel) return error("Channel not found", 404);
  if (await isBlocked(env, user.id, channel.owner_id)) {
    return error("Channel access is unavailable", 403);
  }

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

async function socialTransferChannelOwnership(request, env, channelId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const body = await readBody(request);
  const targetUserId = cleanText(body?.userId, 150);
  if (!targetUserId || targetUserId === user.id) return error("Select another channel member");

  const channel = await env.DB.prepare(
    "SELECT owner_id FROM social_channels WHERE id=?"
  ).bind(channelId).first();
  if (!channel || channel.owner_id !== user.id) return error("Only the current owner can transfer ownership", 403);

  const target = await env.DB.prepare(
    "SELECT role FROM social_channel_members WHERE channel_id=? AND user_id=?"
  ).bind(channelId, targetUserId).first();
  if (!target) return error("The new owner must already be a channel member", 404);

  try {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE social_channels SET owner_id=?
        WHERE id=? AND owner_id=?
          AND EXISTS (
            SELECT 1 FROM social_channel_members
            WHERE channel_id=? AND user_id=?
          )
      `).bind(targetUserId, channelId, user.id, channelId, targetUserId),
      env.DB.prepare(`
        UPDATE social_channel_members SET role='subscriber'
        WHERE channel_id=? AND user_id=? AND EXISTS (
          SELECT 1 FROM social_channels WHERE id=? AND owner_id=?
        )
      `).bind(channelId, user.id, channelId, targetUserId),
      env.DB.prepare(`
        UPDATE social_channel_members SET role='owner'
        WHERE channel_id=? AND user_id=? AND EXISTS (
          SELECT 1 FROM social_channels WHERE id=? AND owner_id=?
        )
      `).bind(channelId, targetUserId, channelId, targetUserId)
    ]);
    const updated = await env.DB.prepare(
      "SELECT owner_id FROM social_channels WHERE id=?"
    ).bind(channelId).first();
    if (updated?.owner_id !== targetUserId) return error("Ownership transfer could not be completed", 409);
    return json({ success: true, transferred: true, ownerId: targetUserId });
  } catch (err) {
    console.error("Channel ownership transfer failed:", String(err?.message || err).slice(0, 300));
    return error("Could not transfer channel ownership", 500);
  }
}

async function socialListChannelMembers(request, env, channelId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const membership = await getAccessibleChannelMembership(env, channelId, user.id);
  if (!membership) return error("Channel not found", 404);

  const result = await env.DB.prepare(`
    SELECT m.user_id,m.role,m.joined_at,u.username,u.display_name,u.avatar_url
    FROM social_channel_members m
    JOIN social_users u ON u.id=m.user_id
    WHERE m.channel_id=?
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
      m.joined_at ASC
    LIMIT 500
  `).bind(channelId).all();

  return json({
    success: true,
    members: (result.results || []).map(row => ({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      role: row.role,
      joinedAt: row.joined_at
    }))
  });
}

async function socialManageChannelMember(request, env, channelId, targetUserId, action) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  if (!targetUserId || targetUserId === user.id) return error("You cannot manage your own channel role", 400);

  const channel = await env.DB.prepare(
    "SELECT owner_id FROM social_channels WHERE id=?"
  ).bind(channelId).first();
  if (!channel) return error("Channel not found", 404);
  if (channel.owner_id !== user.id) return error("Only the channel owner can manage administrators", 403);

  const target = await env.DB.prepare(
    "SELECT role FROM social_channel_members WHERE channel_id=? AND user_id=?"
  ).bind(channelId, targetUserId).first();
  if (!target || target.role === "owner") return error("Channel member not found", 404);

  if (action === "role") {
    const body = await readBody(request);
    const role = body?.role;
    if (!["admin", "subscriber"].includes(role)) return error("Invalid channel role", 400);
    const result = await env.DB.prepare(`
      UPDATE social_channel_members SET role=?
      WHERE channel_id=? AND user_id=? AND role!='owner'
        AND EXISTS (SELECT 1 FROM social_channels WHERE id=? AND owner_id=?)
    `).bind(role, channelId, targetUserId, channelId, user.id).run();
    if (!Number(result.meta?.changes || 0)) return error("Channel member role was not changed", 409);
    return json({ success: true, role });
  }

  if (action === "remove") {
    const result = await env.DB.prepare(`
      DELETE FROM social_channel_members
      WHERE channel_id=? AND user_id=? AND role!='owner'
        AND EXISTS (SELECT 1 FROM social_channels WHERE id=? AND owner_id=?)
    `).bind(channelId, targetUserId, channelId, user.id).run();
    if (!Number(result.meta?.changes || 0)) return error("Channel member was not removed", 409);
    return json({ success: true, removed: true });
  }

  return error("Unsupported channel member action", 400);
}

async function socialRotateChannelInvite(request, env, channelId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const code = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const result = await env.DB.prepare(`
    UPDATE social_channels SET invite_code=?
    WHERE id=? AND owner_id=? AND is_private=1
  `).bind(code, channelId, user.id).run();

  if (!Number(result.meta?.changes || 0)) {
    const channel = await env.DB.prepare(
      "SELECT owner_id,is_private FROM social_channels WHERE id=?"
    ).bind(channelId).first();
    if (!channel) return error("Channel not found", 404);
    if (channel.owner_id !== user.id) return error("Only the channel owner can rotate invitations", 403);
    return error("Invite rotation is available only for private channels", 400);
  }

  return json({ success: true, inviteCode: code, previousInvitesRevoked: true });
}

async function socialLeaveChannel(request, env, channelId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const channel = await env.DB.prepare(
    "SELECT owner_id FROM social_channels WHERE id=?"
  ).bind(channelId).first();
  if (!channel) return error("Channel not found", 404);
  if (channel.owner_id === user.id) {
    return error("The channel owner must transfer ownership before leaving", 409);
  }

  const result = await env.DB.prepare(
    "DELETE FROM social_channel_members WHERE channel_id=? AND user_id=?"
  ).bind(channelId, user.id).run();
  if (!Number(result.meta?.changes || 0)) return error("You are not a channel member", 404);

  return json({ success: true, left: true });
}

async function socialChannelPosts(request, env, channelId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const member = await getAccessibleChannelMembership(env, channelId, user.id);

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

  const member = await getAccessibleChannelMembership(env, channelId, user.id);

  if (!member || !["owner", "admin"].includes(member.role)) {
    return error("Only channel admins can publish", 403);
  }

  const body = await readBody(request);
  if (!body) return error("Invalid request body");

  const content = cleanText(body.content, 10000);
  const rawMedia = Array.isArray(body.media) ? body.media.slice(0, 10) : [];
  if (!content && rawMedia.length === 0) return error("Post cannot be empty");

  const media = [];
  for (const item of rawMedia) {
    if (item?.uploadId) {
      const uploadId = String(item.uploadId).slice(0, 150);
      const upload = await env.DB.prepare(
        "SELECT id,name,mime_type,acl,status,url FROM social_uploads WHERE id=? AND user_id=? LIMIT 1"
      ).bind(uploadId, user.id).first();
      if (!upload || upload.status !== "ready" || upload.acl !== "public" ||
          !upload.url || !validHttpsUrl(upload.url)) {
        return error("Channel media must be a ready public upload owned by your account.", 400);
      }
      media.push({
        url: upload.url,
        type: cleanText(item.type || upload.mime_type, 100),
        name: cleanText(item.name || upload.name, 180)
      });
    } else if (item && validHttpsUrl(item.url)) {
      // Backward compatibility for previously supported externally hosted media.
      media.push({
        url: item.url,
        type: cleanText(item.type || "", 100),
        name: cleanText(item.name || "", 180)
      });
    } else {
      return error("Invalid attachment");
    }
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO social_channel_posts(id,channel_id,sender_id,content,media_json)
    VALUES(?,?,?,?,?)
  `).bind(id, channelId, user.id, content, JSON.stringify(media)).run();

  // Channel announcements notify subscribers, while respecting each user's
  // group/channel notification preference. Delivery must never undo a post.
  try {
    const subscribers = await env.DB.prepare(
      "SELECT user_id FROM social_channel_members WHERE channel_id=? AND user_id!=?"
    ).bind(channelId, user.id).all();
    for (const subscriber of subscribers.results || []) {
      try {
        await notify(env, subscriber.user_id, user.id, "channel_post", channelId, "new post in a channel you follow");
      } catch (notificationError) {
        console.error("SOCIAL_CHANNEL_NOTIFICATION_FAILURE", String(notificationError?.message || notificationError).slice(0, 200));
      }
    }
  } catch (notificationError) {
    console.error("SOCIAL_CHANNEL_NOTIFICATION_LOOKUP_FAILURE", String(notificationError?.message || notificationError).slice(0, 200));
  }

  return json({ success: true, post: { id, content, media } }, 201);
}


async function socialEditChannelPost(request, env, channelId, postId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  const member = await getAccessibleChannelMembership(env, channelId, user.id);
  if (!member || !["owner", "admin"].includes(member.role)) return error("Admin permission required", 403);
  const body = await readBody(request);
  if (!body || typeof body.content !== "string") return error("Invalid request body");
  const content = cleanText(body.content, 10000);
  const post = await env.DB.prepare("SELECT id,media_json FROM social_channel_posts WHERE id=? AND channel_id=?").bind(postId, channelId).first();
  if (!post) return error("Channel post not found", 404);
  let media = [];
  try { media = JSON.parse(post.media_json || "[]"); } catch { return error("Post media data is invalid", 500); }
  if (!content && (!Array.isArray(media) || media.length === 0)) return error("Post cannot be empty");
  await env.DB.prepare("UPDATE social_channel_posts SET content=?,edited_at=CURRENT_TIMESTAMP WHERE id=? AND channel_id=?").bind(content, postId, channelId).run();
  return json({ success: true, post: { id: postId, content, editedAt: new Date().toISOString() } });
}

async function socialDeleteChannelPost(request, env, channelId, postId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  const member = await getAccessibleChannelMembership(env, channelId, user.id);
  if (!member || !["owner", "admin"].includes(member.role)) return error("Admin permission required", 403);
  const post = await env.DB.prepare("SELECT id FROM social_channel_posts WHERE id=? AND channel_id=?").bind(postId, channelId).first();
  if (!post) return error("Channel post not found", 404);
  // Delete only database references. Uploaded media files are intentionally retained.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM social_channel_pins WHERE channel_id=? AND post_id=?").bind(channelId, postId),
    env.DB.prepare("DELETE FROM social_channel_posts WHERE id=? AND channel_id=?").bind(postId, channelId)
  ]);
  return json({ success: true, deleted: true });
}

async function socialPinChannelPost(request, env, channelId, postId, pin) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);

  const member = await getAccessibleChannelMembership(env, channelId, user.id);

  if (!member || !["owner", "admin"].includes(member.role)) {
    return error("Admin permission required", 403);
  }

  if (pin) {
    const post = await env.DB.prepare(
      "SELECT id FROM social_channel_posts WHERE id=? AND channel_id=?"
    ).bind(postId, channelId).first();
    if (!post) return error("Channel post not found", 404);
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
  if (!await checkRateLimit(env, request, "social-bot-create", 10, 3600, 1800)) {
    return error("Too many bot registrations. Try again later.", 429);
  }
  const ownedBots = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM social_bots WHERE owner_id=?"
  ).bind(user.id).first();
  if (Number(ownedBots?.total || 0) >= 25) return error("Each account can register up to 25 bots.", 429);

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

async function socialRotateBotToken(request, env, botId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  if (!await checkRateLimit(env, request, "social-bot-rotate", 20, 3600, 1800)) {
    return error("Too many bot token rotations. Try again later.", 429);
  }
  const token = createSessionToken();
  const tokenHash = await sha256(token);
  const result = await env.DB.prepare(
    "UPDATE social_bots SET token_hash=? WHERE id=? AND owner_id=? AND is_active=1"
  ).bind(tokenHash, botId, user.id).run();
  if (!Number(result?.meta?.changes || 0)) return error("Active bot not found", 404);
  return json({ success: true, token, rotated: true });
}

async function socialDeleteBot(request, env, botId) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  const result = await env.DB.prepare(
    "DELETE FROM social_bots WHERE id=? AND owner_id=?"
  ).bind(botId, user.id).run();
  if (!Number(result?.meta?.changes || 0)) return error("Bot not found", 404);
  return json({ success: true, deleted: true });
}

const SOCIAL_AI_PROVIDERS = {
  openai: { label: "OpenAI", model: "gpt-4.1-mini" },
  gemini: { label: "Gemini", model: "gemini-2.5-flash" },
  groq: { label: "Groq", model: "llama-3.3-70b-versatile" },
  cloudflare: { label: "Cloudflare AI", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }
};

function socialAIProviderReady(key, env) {
  // Paid third-party providers are deliberately disabled to prevent surprise charges.
  return key === "cloudflare" && !!(env.AI && typeof env.AI.run === "function");
}

function socialAIProviderList(env) {
  return Object.entries(SOCIAL_AI_PROVIDERS).map(([key, item]) => ({
    key, name: item.label,
    model: cleanText(env["SOCIAL_AI_MODEL_" + key.toUpperCase()], 120) || item.model,
    configured: socialAIProviderReady(key, env),
    vision: key === "cloudflare" && !!(env.AI && typeof env.AI.run === "function")
  }));
}
function socialAIImageModelSupported(provider, model) {
  return provider === "cloudflare" && model === "@cf/meta/llama-3.2-11b-vision-instruct";
}
function socialBytesToBase64(bytes) {
  let binary = "";
  for (let i=0;i<bytes.length;i+=0x8000) binary += String.fromCharCode(...bytes.subarray(i,i+0x8000));
  return btoa(binary);
}
async function socialResolveAssistantImages(env,userId,attachments) {
  if(!Array.isArray(attachments)||attachments.length>5) throw new Error("Attach up to 5 images.");
  const images=[];
  for(const item of attachments){
    const id=String(item?.id||"");
    if(!id||id.length>150) throw new Error("Invalid image attachment.");
    const row=await env.DB.prepare("SELECT id,name,size,mime_type,acl,status FROM social_uploads WHERE id=? AND user_id=? LIMIT 1").bind(id,userId).first();
    if(!row||row.status!=="ready"||row.acl!=="private") throw new Error("An attached image is unavailable or not private.");
    if(!["image/jpeg","image/png","image/webp","image/gif"].includes(row.mime_type)||Number(row.size)>20*1024*1024) throw new Error("Use JPG, PNG, WEBP or GIF images up to 20 MB.");
    const signed=await rapidfileRequest(env,`/files/${encodeURIComponent(id)}/signed-url`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({expiresIn:300})});
    if(!signed.url||!validHttpsUrl(signed.url)) throw new Error("Could not securely access an attached image.");
    const response=await fetch(signed.url);
    if(!response.ok) throw new Error("Could not read an attached image.");
    const mime=(response.headers.get("content-type")||row.mime_type).split(";")[0].toLowerCase();
    if(!["image/jpeg","image/png","image/webp","image/gif"].includes(mime)) throw new Error("Unsupported image type.");
    const buffer=await response.arrayBuffer();
    if(!buffer.byteLength||buffer.byteLength>20*1024*1024) throw new Error("Image is empty or exceeds 20 MB.");
    images.push({name:row.name,mime,data:socialBytesToBase64(new Uint8Array(buffer))});
  }
  return images;
}

async function socialEnsureCloudflareVisionLicense(env, model) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS social_ai_model_licenses(
      model TEXT PRIMARY KEY,
      accepted_at TEXT NOT NULL
    )
  `).run();
  const accepted = await env.DB.prepare(
    "SELECT model FROM social_ai_model_licenses WHERE model=? LIMIT 1"
  ).bind(model).first();
  if (accepted) return;

  // Cloudflare may signal successful first-time license acceptance using
  // error code 5016 and a confirmation message. Treat only that exact
  // confirmation as success; propagate all unrelated failures.
  try {
    const budget = await reserveSocialWorkersAIBudget(env, 500);
    if (!budget.allowed) throw new Error("Daily free Workers AI budget is reserved for today.");
    const result = await env.AI.run(model, { prompt: "agree" });
    const resultText = JSON.stringify(result || {});
    const resultErrors = Array.isArray(result?.errors) ? result.errors : [];
    const hasUnexpectedError = resultErrors.some(item => Number(item?.code) !== 5016);
    if (hasUnexpectedError) throw new Error("Cloudflare Vision license acceptance failed.");
    if (resultErrors.length && !resultErrors.some(item => Number(item?.code) === 5016)) {
      throw new Error("Cloudflare Vision license acceptance failed.");
    }
    if (/5016/.test(resultText) && !/thank you for agreeing to this model's terms/i.test(resultText)) {
      throw new Error("Cloudflare Vision license acceptance failed.");
    }
  } catch (e) {
    const message = String(e?.message || e || "");
    const isAcceptanceConfirmation =
      /5016/.test(message) &&
      /thank you for agreeing to this model's terms|you may now use the model/i.test(message);
    if (!isAcceptanceConfirmation) throw e;
  }

  await env.DB.prepare(
    "INSERT OR IGNORE INTO social_ai_model_licenses(model,accepted_at) VALUES(?,?)"
  ).bind(model, new Date().toISOString()).run();
}

async function socialAIRequest(provider, model, messages, env, images = []) {
  if (provider !== "cloudflare") {
    throw new Error("Paid external AI providers are disabled. Only the capped Cloudflare free allowance is available.");
  }
  const system = "You are an assistant inside SOCIAL, an international social network. Be helpful, safe, clear and concise. Reply in the user's language. Never claim actions you did not perform. Never request passwords, private keys, API keys or wallet recovery phrases.";
  const userMessages = messages.filter(m => m.role === "user" || m.role === "assistant");
  if(images.length&&!socialAIImageModelSupported(provider,model)) throw new Error("Image analysis requires a compatible vision model.");
  if (provider === "cloudflare") {
    if (images.length && model === "@cf/meta/llama-3.2-11b-vision-instruct") {
      await socialEnsureCloudflareVisionLicense(env, model);
    }
    const cloudflareInput = { messages: [{ role: "system", content: system }, ...userMessages], max_tokens: 900 };
    if (images.length) {
      if (images.length !== 1) throw new Error("Free Cloudflare Vision currently accepts one image per message.");
      cloudflareInput.image = `data:${images[0].mime};base64,${images[0].data}`;
    }
    const budget = await reserveSocialWorkersAIBudget(env, 1500);
    if (!budget.allowed) throw new Error("Daily free Workers AI budget is reserved for today.");
    const result = await env.AI.run(model, cloudflareInput);
    const answer = result?.response || result?.result?.response || "";
    if (typeof answer !== "string" || !answer.trim()) throw new Error("Cloudflare AI returned an empty reply.");
    return answer.trim();
  }
  let url, key, payload;
  if (provider === "gemini") {
    key = env.GEMINI_API_KEY;
    url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key);
    const contents = userMessages.map((m,index) => ({ role:m.role==="assistant"?"model":"user", parts:[{text:m.content},...(m.role==="user"&&index===userMessages.length-1?images.map(image=>({inlineData:{mimeType:image.mime,data:image.data}})):[])] }));
    payload = { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { maxOutputTokens: 900 } };
  } else {
    key = provider === "openai" ? env.OPENAI_API_KEY : env.GROQ_API_KEY;
    url = provider === "openai" ? "https://api.openai.com/v1/chat/completions" : "https://api.groq.com/openai/v1/chat/completions";
    const apiMessages=[{role:"system",content:system},...userMessages];
    if(images.length){const last=apiMessages[apiMessages.length-1];last.content=[{type:"text",text:last.content},...images.map(image=>({type:"image_url",image_url:{url:`data:${image.mime};base64,${image.data}`}}))];}
    payload = { model, messages: apiMessages, max_tokens: 900 };
  }
  const headers = { "Content-Type": "application/json" };
  if (provider !== "gemini") headers.Authorization = "Bearer " + key;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.message || "AI provider returned an error.";
    throw new Error(response.status === 429 ? "Provider quota or rate limit reached." : response.status === 401 || response.status === 403 ? "Provider authentication failed." : String(message).slice(0, 220));
  }
  const answer = provider === "gemini"
    ? (data.candidates || []).flatMap(c => c.content?.parts || []).map(p => p.text || "").join("\n").trim()
    : (data.choices || []).map(c => c.message?.content || "").join("\n").trim();
  if (!answer) throw new Error("AI provider returned an empty reply.");
  return answer;
}

async function socialGenerateAssistantImage(request, env) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let currentStage = "request_received";
  const logStage = (stage, extra = {}) => {
    currentStage = stage;
    console.info("SOCIAL_IMAGE_GENERATION", JSON.stringify({ requestId, stage, elapsedMs: Date.now() - startedAt, ...extra }));
  };
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  if (!env.AI || typeof env.AI.run !== "function") return error("Free image generation is not available on this Worker.", 503);
  if (!await checkRateLimit(env, request, "social-ai-image-generation", 3, 600, 600)) {
    return error("Image generation limit reached. Please wait before trying again.", 429);
  }
  const body = await readBody(request);
  if (!body) return error("Invalid request body");
  const prompt = cleanText(body.prompt, 1800);
  if (!prompt) return error("Write an image prompt first.");
  const hasReference = !!body.reference;
  let model = hasReference ? "@cf/black-forest-labs/flux-2-klein-9b" : "@cf/black-forest-labs/flux-1-schnell";
  try {
    let result, mimeType;
    if (hasReference) {
      logStage("reference_resolution_started");
      let refs, referenceTimeoutId;
      try {
        refs = await Promise.race([
          socialResolveAssistantImages(env, user.id, [body.reference]),
          new Promise((_, reject) => {
            referenceTimeoutId = setTimeout(() => {
              const timeoutError = new Error("Private reference photo processing exceeded 30 seconds.");
              timeoutError.code = "SOCIAL_IMAGE_REFERENCE_TIMEOUT";
              reject(timeoutError);
            }, 30000);
          })
        ]);
      } finally {
        if (referenceTimeoutId) clearTimeout(referenceTimeoutId);
      }
      logStage("reference_resolution_finished", { found: refs.length });
      if (!refs.length) return error("Reference photo is unavailable.", 400);
      const reference = refs[0];
      const binary = atob(reference.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const form = new FormData();
      form.append("prompt",
        "IMAGE EDITING TASK. The person in input_image_0 is the exact person who must appear in the result. Treat the reference as identity ground truth, not loose inspiration. Preserve the same individual and reproduce their actual face: same facial geometry, head shape, forehead, hairline, eyebrows, eye shape and spacing, nose bridge and tip, nostrils, lips, philtrum, cheeks, jawline, chin, ears, skin tone, age and all distinctive asymmetries. Do not beautify, idealize, stylize, reshape, smooth, age, de-age, or substitute another face. Do not create a lookalike. Keep the face natural and photorealistic. Make only the requested changes to pose, expression, clothing, hairstyle, lighting, camera angle and background; if a requested change conflicts with identity preservation, preserve the face. Keep the person clearly recognizable as the same person in the reference. User creative instruction: " + prompt
      );
      form.append("input_image_0", new Blob([bytes], { type: reference.mime }), reference.name || "reference.jpg");
      form.append("guidance", "3.5");
      form.append("width", "1024");
      form.append("height", "1024");
      const multipartRequest = new Request("https://social-image-generation.invalid/", { method: "POST", body: form });
      const budget = await reserveSocialWorkersAIBudget(env, 2000);
      if (!budget.allowed) {
        return json({ success: false, error: "Today's free image-generation allowance has been reached. It will reset at 00:00 UTC.", code: "SOCIAL_AI_DAILY_FREE_LIMIT", requestId, stage: currentStage }, 429);
      }
      logStage("model_started", { model, hasReference: true, referenceBytes: bytes.length, reservedNeurons: budget.reservedNeurons });
      const timeoutMs = 120000;
      let timeoutId;
      try {
        result = await Promise.race([
          env.AI.run(model, {
            multipart: {
              body: multipartRequest.body,
              contentType: multipartRequest.headers.get("content-type")
            }
          }),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              const timeoutError = new Error("Image generation exceeded the 120-second time limit.");
              timeoutError.code = "SOCIAL_IMAGE_GENERATION_TIMEOUT";
              reject(timeoutError);
            }, timeoutMs);
          })
        ]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
      logStage("model_finished", { model });
      mimeType = "image/png";
    } else {
      const budget = await reserveSocialWorkersAIBudget(env, 2000);
      if (!budget.allowed) {
        return json({ success: false, error: "Today's free image-generation allowance has been reached. It will reset at 00:00 UTC.", code: "SOCIAL_AI_DAILY_FREE_LIMIT", requestId, stage: currentStage }, 429);
      }
      logStage("model_started", { model, hasReference: false, reservedNeurons: budget.reservedNeurons });
      const timeoutMs = 120000;
      let timeoutId;
      try {
        result = await Promise.race([
          env.AI.run(model, { prompt, steps: 4 }),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              const timeoutError = new Error("Image generation exceeded the 120-second time limit.");
              timeoutError.code = "SOCIAL_IMAGE_GENERATION_TIMEOUT";
              reject(timeoutError);
            }, timeoutMs);
          })
        ]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
      logStage("model_finished", { model });
      mimeType = "image/jpeg";
    }
    const image = result?.image;
    if (typeof image !== "string" || !image.length) {
      console.error("SOCIAL_IMAGE_GENERATION_BAD_RESPONSE", JSON.stringify({ requestId, model, elapsedMs: Date.now() - startedAt, resultKeys: Object.keys(result || {}) }));
      return json({ success: false, error: "The image model returned an unsupported response. Please try again.", code: "SOCIAL_IMAGE_GENERATION_BAD_RESPONSE", requestId, stage: currentStage, elapsedMs: Date.now() - startedAt }, 502);
    }
    logStage("completed", { model, outputChars: image.length });
    return json({ success: true, model, image, mimeType, requestId });
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    if (/Daily free Workers AI budget is reserved/.test(String(e?.message || ""))) {
      console.warn("SOCIAL_AI_DAILY_BUDGET_BLOCKED", JSON.stringify({ requestId, elapsedMs }));
      return json({ success: false, error: "The free AI allowance is temporarily unavailable. No image request was sent. Please try again after the daily reset.", code: "SOCIAL_AI_DAILY_FREE_LIMIT", requestId, stage: currentStage, elapsedMs }, 429);
    }
    if (e?.code === "SOCIAL_IMAGE_REFERENCE_TIMEOUT") {
      console.error("SOCIAL_IMAGE_REFERENCE_TIMEOUT", JSON.stringify({ requestId, elapsedMs }));
      return json({ success: false, error: "Preparing your private reference photo took longer than 30 seconds. Please try again.", code: "SOCIAL_IMAGE_REFERENCE_TIMEOUT", requestId, stage: currentStage, elapsedMs }, 504);
    }
    if (e?.code === "SOCIAL_IMAGE_GENERATION_TIMEOUT") {
      console.error("SOCIAL_IMAGE_GENERATION_TIMEOUT", JSON.stringify({ requestId, model, elapsedMs }));
      return json({ success: false, error: "Image generation took longer than 120 seconds and was stopped waiting for a response. Please try again later.", code: "SOCIAL_IMAGE_GENERATION_TIMEOUT", requestId, stage: currentStage, elapsedMs }, 504);
    }
    console.error("SOCIAL_IMAGE_GENERATION_FAILED", JSON.stringify({ requestId, model, elapsedMs, message: String(e?.message || e || "Image generation failed").slice(0, 220) }));
    const message = String(e?.message || e || "Image generation failed").slice(0, 220);
    return json({ success: false, error: message, code: "SOCIAL_IMAGE_GENERATION_FAILED", requestId, stage: currentStage, elapsedMs }, 502);
  }
}
async function socialAssistantStatus(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  const providers = socialAIProviderList(env);
  return json({ success: true, enabled: providers.some(p => p.configured), providers, centralMode: "auto", multiProvider: providers.filter(p => p.configured).length > 1 });
}

async function socialAssistantHistory(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  const url = new URL(request.url);
  const provider = cleanText(url.searchParams.get("provider") || "central", 32);
  const conversationId = provider === "central" ? "central" : provider;
  const result = await env.DB.prepare(
    "SELECT id,role,content,created_at,provider_key FROM social_ai_messages WHERE user_id=? AND conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT 40"
  ).bind(user.id, conversationId).all();
  return json({ success: true, provider, messages: (result.results || []).reverse() });
}

async function socialAssistantChat(request, env) {
  const user = await getSocialUser(request, env);
  if (!user) return error("Authentication required", 401);
  if (!await checkRateLimit(env, request, "social-ai-chat", 30, 60, 120)) return error("Too many messages. Please wait a moment.", 429);
  const body = await readBody(request);
  if (!body) return error("Invalid request body");
  const content = cleanText(body.content, 4000);
  const attachmentItems = Array.isArray(body.attachments) ? body.attachments : [];
  if (!content && !attachmentItems.length) return error("Write a message or attach an image.");
  if (attachmentItems.length > 5) return error("Attach up to 5 images.");
  const requestedProvider = cleanText(body.provider || "central", 32).toLowerCase();
  if (requestedProvider !== "central" && !SOCIAL_AI_PROVIDERS[requestedProvider]) return error("Unknown AI provider.");
  const preferred = cleanText(env.SOCIAL_AI_DEFAULT_PROVIDER, 32).toLowerCase();
  const order = [preferred, "openai", "gemini", "groq", "cloudflare"].filter((v, i, a) => SOCIAL_AI_PROVIDERS[v] && a.indexOf(v) === i);
  let images=[];
  if(attachmentItems.length){try{images=await socialResolveAssistantImages(env,user.id,attachmentItems);}catch(e){return error(e.message||"Could not process image attachments.",400);}}
  const candidates = requestedProvider === "central"
    ? order.filter(key => socialAIProviderReady(key, env) && (!images.length || ["openai","gemini"].includes(key) || (key === "cloudflare" && images.length === 1)))
    : (socialAIProviderReady(requestedProvider, env) && (!images.length || ["openai","gemini"].includes(requestedProvider) || (requestedProvider === "cloudflare" && images.length === 1)) ? [requestedProvider] : []);
  if (!candidates.length) return error(images.length
    ? "Free image analysis currently supports one image per message through Cloudflare Vision."
    : "This AI provider is disabled or not configured on the server.", 503);
  const conversationId = requestedProvider === "central" ? "central" : requestedProvider;
  const recent = await env.DB.prepare(
    "SELECT role,content FROM social_ai_messages WHERE user_id=? AND conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT 19"
  ).bind(user.id, conversationId).all();
  const input = (recent.results || []).reverse().map(row => ({ role: row.role, content: row.content }));
  const storedContent=(content||"Please analyze the attached image(s).")+(attachmentItems.length?"\\n[Attached image(s): "+attachmentItems.map(x=>cleanText(x.name||"image",120)).join(", ")+"]":"");
  input.push({ role: "user", content: storedContent });
  let answer, provider, model, lastError;
  for (const candidate of candidates) {
    const candidateModel = images.length && candidate === "cloudflare"
      ? "@cf/meta/llama-3.2-11b-vision-instruct"
      : (cleanText(body.model, 120) || cleanText(env["SOCIAL_AI_MODEL_" + candidate.toUpperCase()], 120) || SOCIAL_AI_PROVIDERS[candidate].model);
    try {
      if(images.length&&!socialAIImageModelSupported(candidate,candidateModel)) throw new Error("The configured model does not support image analysis.");
      answer = await socialAIRequest(candidate, candidateModel, input, env, images);
      provider = candidate;
      model = candidateModel;
      break;
    } catch (e) {
      lastError = e;
      if (requestedProvider !== "central") break;
    }
  }
  if (!answer) return error((lastError?.message || "No configured AI provider could complete the request.").slice(0, 240), 502);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO social_ai_messages(id,user_id,role,content,provider_key,conversation_id) VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(), user.id, "user", content, provider, conversationId),
    env.DB.prepare("INSERT INTO social_ai_messages(id,user_id,role,content,provider_key,conversation_id) VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(), user.id, "assistant", answer, provider, conversationId)
  ]);
  return json({ success: true, provider, model, reply: answer });
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
    "application/msword",
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
  if (!await checkRateLimit(env, request, "account-delete", 3, 3600, 3600)) {
    return error("Too many account deletion attempts. Try again later.", 429);
  }

  const body = await readBody(request);
  if (!body) return error("Invalid request body");
  const password = typeof body.password === "string" ? body.password : "";
  const row = await env.DB.prepare(
    "SELECT id,password_hash,firebase_uid,email FROM social_users WHERE id=? AND is_active=1"
  ).bind(user.id).first();
  if (!row) return error("Account is not active", 404);

  let verified = false;
  let providerIdToken = null;
  if (password && password.length <= 128 && row.firebase_uid && row.email) {
    try {
      const response = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + FIREBASE_WEB_API_KEY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: row.email, password, returnSecureToken: true })
      });
      const loginIdentity = response.ok ? await response.json() : null;
      if (loginIdentity && loginIdentity.localId === row.firebase_uid && typeof loginIdentity.idToken === "string") {
        const lookupResponse = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + FIREBASE_WEB_API_KEY, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken: loginIdentity.idToken })
        });
        const lookup = lookupResponse.ok ? await lookupResponse.json() : null;
        const identity = lookup && Array.isArray(lookup.users) ? lookup.users[0] : null;
        verified = Boolean(identity && identity.localId === row.firebase_uid &&
          identity.emailVerified === true &&
          cleanEmail(identity.email || "") === cleanEmail(row.email || ""));
        if (verified) providerIdToken = loginIdentity.idToken;
      }
    } catch {}
  } else if (password && password.length <= 128) {
    try { verified = (await verifyPassword(password, row.password_hash)).valid; } catch {}
  }
  if (!verified) return error("Incorrect password. Verify your current sign-in password before deleting your account.", 403);

  // Remove owned objects from the external media provider first. If storage refuses,
  // keep the account and database records intact so the owner can retry.
  const uploads = await env.DB.prepare(
    "SELECT id FROM social_uploads WHERE user_id=? ORDER BY created_at ASC LIMIT 500"
  ).bind(user.id).all();
  const uploadRows = uploads.results || [];
  if (uploadRows.length >= 500) {
    return error("This account has too many stored files for one safe deletion pass. Contact support for assisted removal.", 409);
  }
  for (const upload of uploadRows) {
    try {
      await rapidfileRequest(env, `/files/${encodeURIComponent(upload.id)}`, { method: "DELETE" });
    } catch (err) {
      if (Number(err?.status) !== 404) {
        console.error("Account media deletion failed:", String(err?.message || err).slice(0, 250));
        return error("Could not remove all account media from storage. No account data was deleted; please retry later.", 502);
      }
    }
  }

  const uid = user.id;
  const statements = [
    // Transfer ownership to an existing active member before removing the owner.
    env.DB.prepare(`UPDATE social_conversations
      SET owner_id=(SELECT cm.user_id FROM social_conversation_members cm
        JOIN social_users u ON u.id=cm.user_id
        WHERE cm.conversation_id=social_conversations.id AND cm.user_id!=? AND u.is_active=1
        ORDER BY CASE cm.role WHEN 'admin' THEN 0 ELSE 1 END,cm.joined_at ASC LIMIT 1),
      updated_at=CURRENT_TIMESTAMP
      WHERE owner_id=? AND EXISTS (SELECT 1 FROM social_conversation_members cm
        JOIN social_users u ON u.id=cm.user_id
        WHERE cm.conversation_id=social_conversations.id AND cm.user_id!=? AND u.is_active=1)`).bind(uid,uid,uid),
    env.DB.prepare(`UPDATE social_conversation_members SET role='owner'
      WHERE EXISTS (SELECT 1 FROM social_conversations c
        WHERE c.id=social_conversation_members.conversation_id
        AND c.type='group' AND c.owner_id=social_conversation_members.user_id)`),
    env.DB.prepare(`UPDATE social_channels
      SET owner_id=(SELECT cm.user_id FROM social_channel_members cm
        JOIN social_users u ON u.id=cm.user_id
        WHERE cm.channel_id=social_channels.id AND cm.user_id!=? AND u.is_active=1
        ORDER BY CASE cm.role WHEN 'admin' THEN 0 ELSE 1 END,cm.joined_at ASC LIMIT 1)
      WHERE owner_id=? AND EXISTS (SELECT 1 FROM social_channel_members cm
        JOIN social_users u ON u.id=cm.user_id
        WHERE cm.channel_id=social_channels.id AND cm.user_id!=? AND u.is_active=1)`).bind(uid,uid,uid),
    env.DB.prepare(`UPDATE social_channel_members SET role='owner'
      WHERE EXISTS (SELECT 1 FROM social_channels c
        WHERE c.id=social_channel_members.channel_id
        AND c.owner_id=social_channel_members.user_id)`),

    // Remove orphaned groups/channels that have no eligible successor.
    env.DB.prepare("DELETE FROM social_group_invites WHERE conversation_id IN (SELECT id FROM social_conversations WHERE owner_id=? AND type='group')").bind(uid),
    env.DB.prepare("DELETE FROM social_call_signals WHERE call_id IN (SELECT id FROM social_call_sessions WHERE conversation_id IN (SELECT id FROM social_conversations WHERE owner_id=? AND type='group'))").bind(uid),
    env.DB.prepare("DELETE FROM social_call_participants WHERE call_id IN (SELECT id FROM social_call_sessions WHERE conversation_id IN (SELECT id FROM social_conversations WHERE owner_id=? AND type='group'))").bind(uid),
    env.DB.prepare("DELETE FROM social_call_sessions WHERE conversation_id IN (SELECT id FROM social_conversations WHERE owner_id=? AND type='group')").bind(uid),
    env.DB.prepare("DELETE FROM social_message_reactions WHERE message_id IN (SELECT id FROM social_messages WHERE conversation_id IN (SELECT id FROM social_conversations WHERE owner_id=? AND type='group'))").bind(uid),
    env.DB.prepare("DELETE FROM social_messages WHERE conversation_id IN (SELECT id FROM social_conversations WHERE owner_id=? AND type='group')").bind(uid),
    env.DB.prepare("DELETE FROM social_conversation_members WHERE conversation_id IN (SELECT id FROM social_conversations WHERE owner_id=? AND type='group')").bind(uid),
    env.DB.prepare("DELETE FROM social_conversations WHERE owner_id=? AND type='group'").bind(uid),
    env.DB.prepare("DELETE FROM social_call_signals WHERE call_id IN (SELECT id FROM social_call_sessions WHERE conversation_id IN (SELECT id FROM social_conversations WHERE owner_id=? AND type IN ('direct','private')))").bind(uid),
    env.DB.prepare("DELETE FROM social_call_participants WHERE call_id IN (SELECT id FROM social_call_sessions WHERE conversation_id IN (SELECT id FROM social_conversations WHERE owner_id=? AND type IN ('direct','private')))").bind(uid),
    env.DB.prepare("DELETE FROM social_call_sessions WHERE conversation_id IN (SELECT id FROM social_conversations WHERE owner_id=? AND type IN ('direct','private'))").bind(uid),
    env.DB.prepare("DELETE FROM social_message_reactions WHERE message_id IN (SELECT id FROM social_messages WHERE conversation_id IN (SELECT id FROM social_conversations WHERE owner_id=? AND type IN ('direct','private')))").bind(uid),
    env.DB.prepare("DELETE FROM social_messages WHERE conversation_id IN (SELECT id FROM social_conversations WHERE owner_id=? AND type IN ('direct','private'))").bind(uid),
    env.DB.prepare("DELETE FROM social_conversation_members WHERE conversation_id IN (SELECT id FROM social_conversations WHERE owner_id=? AND type IN ('direct','private'))").bind(uid),
    env.DB.prepare("DELETE FROM social_conversations WHERE owner_id=? AND type IN ('direct','private')").bind(uid),
    env.DB.prepare("DELETE FROM social_channel_pins WHERE channel_id IN (SELECT id FROM social_channels WHERE owner_id=?)").bind(uid),
    env.DB.prepare("DELETE FROM social_channel_posts WHERE channel_id IN (SELECT id FROM social_channels WHERE owner_id=?)").bind(uid),
    env.DB.prepare("DELETE FROM social_channel_members WHERE channel_id IN (SELECT id FROM social_channels WHERE owner_id=?)").bind(uid),
    env.DB.prepare("DELETE FROM social_channels WHERE owner_id=?").bind(uid),

    // Remove the account's content and every engagement attached to it.
    env.DB.prepare("DELETE FROM social_post_likes WHERE user_id=? OR post_id IN (SELECT id FROM social_posts WHERE user_id=?)").bind(uid,uid),
    env.DB.prepare("DELETE FROM social_comments WHERE user_id=? OR post_id IN (SELECT id FROM social_posts WHERE user_id=?)").bind(uid,uid),
    env.DB.prepare("DELETE FROM social_bookmarks WHERE user_id=? OR post_id IN (SELECT id FROM social_posts WHERE user_id=?)").bind(uid,uid),
    env.DB.prepare("DELETE FROM social_post_views WHERE user_id=? OR post_id IN (SELECT id FROM social_posts WHERE user_id=?)").bind(uid,uid),
    env.DB.prepare("DELETE FROM social_posts WHERE user_id=?").bind(uid),
    env.DB.prepare("DELETE FROM social_story_views WHERE user_id=? OR story_id IN (SELECT id FROM social_stories WHERE user_id=?)").bind(uid,uid),
    env.DB.prepare("DELETE FROM social_story_reactions WHERE user_id=? OR story_id IN (SELECT id FROM social_stories WHERE user_id=?)").bind(uid,uid),
    env.DB.prepare("DELETE FROM social_stories WHERE user_id=?").bind(uid),
    env.DB.prepare("DELETE FROM social_profile_photos WHERE user_id=?").bind(uid),
    env.DB.prepare("DELETE FROM social_follows WHERE follower_id=? OR following_id=?").bind(uid,uid),
    env.DB.prepare("DELETE FROM social_follow_requests WHERE requester_id=? OR target_id=?").bind(uid,uid),
    env.DB.prepare("DELETE FROM social_blocks WHERE blocker_id=? OR blocked_id=?").bind(uid,uid),
    env.DB.prepare("DELETE FROM social_notifications WHERE user_id=? OR actor_id=?").bind(uid,uid),
    env.DB.prepare("DELETE FROM social_reports WHERE reporter_id=? OR (target_type='user' AND target_id=?)").bind(uid,uid),

    // Remove messages and reactions authored by this account; preserve other members' messages.
    env.DB.prepare("DELETE FROM social_message_reactions WHERE user_id=? OR message_id IN (SELECT id FROM social_messages WHERE sender_id=?)").bind(uid,uid),
    env.DB.prepare("DELETE FROM social_messages WHERE sender_id=?").bind(uid),
    env.DB.prepare("DELETE FROM social_call_signals WHERE from_user_id=? OR to_user_id=?").bind(uid,uid),
    env.DB.prepare("DELETE FROM social_call_participants WHERE user_id=?").bind(uid),
    env.DB.prepare("DELETE FROM social_call_signals WHERE call_id IN (SELECT id FROM social_call_sessions WHERE host_id=?)").bind(uid),
    env.DB.prepare("DELETE FROM social_call_participants WHERE call_id IN (SELECT id FROM social_call_sessions WHERE host_id=?)").bind(uid),
    env.DB.prepare("DELETE FROM social_call_sessions WHERE host_id=?").bind(uid),
    env.DB.prepare("DELETE FROM social_group_invites WHERE created_by=?").bind(uid),
    env.DB.prepare("DELETE FROM social_conversation_members WHERE user_id=?").bind(uid),
    env.DB.prepare("DELETE FROM social_conversations WHERE owner_id=?").bind(uid),

    // Remove authored channel posts, bots, private AI history and support data.
    env.DB.prepare("DELETE FROM social_channel_pins WHERE post_id IN (SELECT id FROM social_channel_posts WHERE sender_id=?)").bind(uid),
    env.DB.prepare("DELETE FROM social_channel_posts WHERE sender_id=?").bind(uid),
    env.DB.prepare("DELETE FROM social_channel_members WHERE user_id=?").bind(uid),
    env.DB.prepare("DELETE FROM social_bots WHERE owner_id=?").bind(uid),
    env.DB.prepare("DELETE FROM social_ai_messages WHERE user_id=?").bind(uid),
    env.DB.prepare("DELETE FROM social_support_tickets WHERE user_id=?").bind(uid),
    env.DB.prepare("DELETE FROM social_user_settings WHERE user_id=?").bind(uid),
    env.DB.prepare("DELETE FROM social_extended_settings WHERE user_id=?").bind(uid),
    env.DB.prepare("DELETE FROM social_sessions WHERE user_id=?").bind(uid),
    env.DB.prepare("DELETE FROM social_uploads WHERE user_id=?").bind(uid),
    env.DB.prepare("DELETE FROM social_users WHERE id=?").bind(uid)
  ];

  try {
    await env.DB.batch(statements);
  } catch (err) {
    console.error("SOCIAL_ACCOUNT_DELETE_FAILURE", String(err?.message || err).slice(0, 400));
    return error("Account data cleanup could not be completed. Contact support before retrying.", 500);
  }

  let providerIdentityDeleted = null;
  if (providerIdToken && row.firebase_uid) {
    try {
      const providerResponse = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:delete?key=" + FIREBASE_WEB_API_KEY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: providerIdToken })
      });
      providerIdentityDeleted = providerResponse.ok;
      if (!providerIdentityDeleted) {
        const detail = await providerResponse.text().catch(() => "");
        console.error("SOCIAL_FIREBASE_IDENTITY_DELETE_FAILURE", detail.slice(0, 300));
      }
    } catch (err) {
      providerIdentityDeleted = false;
      console.error("SOCIAL_FIREBASE_IDENTITY_DELETE_FAILURE", String(err?.message || err).slice(0, 300));
    }
  }
  return json({ success: true, deleted: true, removedFiles: uploadRows.length, ownershipTransferred: true, providerIdentityDeleted });
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
          return error("Legacy password registration is disabled. Create and verify your email identity first.", 410);
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

        if (path === "/social/presence" && method === "POST") {
          return await socialPresenceHeartbeat(request, env);
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

        if (path === "/social/calls" && method === "POST") {
          return await socialCallStart(request, env);
        }
        if (path === "/social/calls/active" && method === "GET") {
          return await socialCallActive(request, env);
        }
        const callRouteMatch = path.match(/^\/social\/calls\/([^/]+)\/(join|poll|signal|leave)$/);
        if (callRouteMatch) {
          const callId = decodeURIComponent(callRouteMatch[1]);
          const action = callRouteMatch[2];
          if (action === "join" && method === "POST") return await socialCallJoin(request, env, callId);
          if (action === "poll" && method === "GET") return await socialCallPoll(request, env, callId);
          if (action === "signal" && method === "POST") return await socialCallSignal(request, env, callId);
          if (action === "leave" && method === "POST") return await socialCallLeave(request, env, callId);
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

        const transferGroupMatch = path.match(/^\/social\/groups\/([^/]+)\/transfer-ownership$/);
        if (transferGroupMatch && method === "POST") {
          return await socialTransferGroupOwnership(request, env, decodeURIComponent(transferGroupMatch[1]));
        }

        const groupLeaveMatch = path.match(/^\/social\/groups\/([^/]+)\/leave$/);
        if (groupLeaveMatch && method === "POST") {
          return await socialLeaveGroup(request, env, decodeURIComponent(groupLeaveMatch[1]));
        }

        const groupMemberMatch = path.match(/^\/social\/groups\/([^/]+)\/members\/([^/]+)$/);
        if (groupMemberMatch && method === "DELETE") {
          return await socialManageGroupMember(request, env, decodeURIComponent(groupMemberMatch[1]), decodeURIComponent(groupMemberMatch[2]), "remove");
        }
        if (groupMemberMatch && method === "PATCH") {
          return await socialManageGroupMember(request, env, decodeURIComponent(groupMemberMatch[1]), decodeURIComponent(groupMemberMatch[2]), "role");
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

        const transferChannelMatch = path.match(
          /^\/social\/channels\/([^/]+)\/transfer-ownership$/
        );
        if (transferChannelMatch && method === "POST") {
          return await socialTransferChannelOwnership(
            request,
            env,
            decodeURIComponent(transferChannelMatch[1])
          );
        }

        const channelMembersMatch = path.match(
          /^\/social\/channels\/([^/]+)\/members$/
        );
        if (channelMembersMatch && method === "GET") {
          return await socialListChannelMembers(request, env, decodeURIComponent(channelMembersMatch[1]));
        }

        const channelMemberMatch = path.match(
          /^\/social\/channels\/([^/]+)\/members\/([^/]+)\/(role|remove)$/
        );
        if (channelMemberMatch && channelMemberMatch[3] === "role" && method === "PATCH") {
          return await socialManageChannelMember(request, env, decodeURIComponent(channelMemberMatch[1]), decodeURIComponent(channelMemberMatch[2]), "role");
        }
        if (channelMemberMatch && channelMemberMatch[3] === "remove" && method === "DELETE") {
          return await socialManageChannelMember(request, env, decodeURIComponent(channelMemberMatch[1]), decodeURIComponent(channelMemberMatch[2]), "remove");
        }

        const rotateChannelInviteMatch = path.match(
          /^\/social\/channels\/([^/]+)\/invite\/rotate$/
        );
        if (rotateChannelInviteMatch && method === "POST") {
          return await socialRotateChannelInvite(request, env, decodeURIComponent(rotateChannelInviteMatch[1]));
        }

        const leaveChannelMatch = path.match(
          /^\/social\/channels\/([^/]+)\/leave$/
        );
        if (leaveChannelMatch && method === "POST") {
          return await socialLeaveChannel(
            request,
            env,
            decodeURIComponent(leaveChannelMatch[1])
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

        const channelPostItemMatch = path.match(
          /^\/social\/channels\/([^/]+)\/posts\/([^/]+)$/
        );
        if (channelPostItemMatch && method === "PUT") {
          return await socialEditChannelPost(request, env, decodeURIComponent(channelPostItemMatch[1]), decodeURIComponent(channelPostItemMatch[2]));
        }
        if (channelPostItemMatch && method === "DELETE") {
          return await socialDeleteChannelPost(request, env, decodeURIComponent(channelPostItemMatch[1]), decodeURIComponent(channelPostItemMatch[2]));
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

        if (path === "/social/assistant/image/generate" && method === "POST") return await socialGenerateAssistantImage(request, env);
        if (path === "/social/assistant/status" && method === "GET") return await socialAssistantStatus(request, env);
        if (path === "/social/assistant/history" && method === "GET") return await socialAssistantHistory(request, env);
        if (path === "/social/assistant/chat" && method === "POST") return await socialAssistantChat(request, env);

        if (path === "/social/bots" && method === "GET") {
          return await socialListBots(request, env);
        }

        if (path === "/social/bots" && method === "POST") {
          return await socialCreateBot(request, env);
        }

        const botMatch = path.match(/^\/social\/bots\/([^/]+)(?:\/(rotate-token))?$/);
        if (botMatch) {
          const botId = decodeURIComponent(botMatch[1]);
          if (botMatch[2] === "rotate-token" && method === "POST") return await socialRotateBotToken(request, env, botId);
          if (!botMatch[2] && method === "DELETE") return await socialDeleteBot(request, env, botId);
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
          SELECT id,username,email,display_name,pi_username,pi_verified,account_type,
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
            accountType: normalizeAccountType(row.account_type),
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

      const adminUserAccountTypeMatch = path.match(new RegExp("^/admin/users/([^/]+)/account-type$"));
      if (adminUserAccountTypeMatch && method === "PUT") {
        const admin = await verifyAdmin(request, env);
        if (!admin) return error("Admin authentication required", 403);
        if (!await checkRateLimit(env, request, "admin-user-account-type", 10, 3600, 900)) {
          return error("Too many account type changes. Try again later.", 429);
        }

        const body = await readBody(request);
        if (!body || !["human", "business", "ai"].includes(body.accountType)) {
          return error("Account type must be human, business or ai.");
        }
        const id = decodeURIComponent(adminUserAccountTypeMatch[1]);
        if (!id || id.length > 100) return error("Invalid user ID");

        const target = await env.DB.prepare(
          "SELECT id,username,account_type FROM social_users WHERE id=? LIMIT 1"
        ).bind(id).first();
        if (!target) return error("User not found", 404);
        if (String(target.username).trim().toLowerCase() === "mehranmsh" && body.accountType !== "human") {
          return error("The primary administrator identity must remain a human account.", 403);
        }

        if (body.accountType === "ai") {
          await env.DB.batch([
            env.DB.prepare("UPDATE social_users SET account_type=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind("ai", id),
            env.DB.prepare("DELETE FROM social_post_likes WHERE user_id=?").bind(id),
            env.DB.prepare("DELETE FROM social_follows WHERE follower_id=?").bind(id),
            env.DB.prepare("DELETE FROM social_follow_requests WHERE requester_id=?").bind(id),
            env.DB.prepare("DELETE FROM social_post_views WHERE user_id=?").bind(id),
            env.DB.prepare("DELETE FROM social_story_views WHERE user_id=?").bind(id),
            env.DB.prepare("DELETE FROM social_story_reactions WHERE user_id=?").bind(id),
            env.DB.prepare("DELETE FROM social_notifications WHERE actor_id=? AND type IN ('like','follow','follow_request','story_reaction')").bind(id)
          ]);
        } else {
          await env.DB.prepare(
            "UPDATE social_users SET account_type=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"
          ).bind(body.accountType, id).run();
        }
        await writeAdminAudit(env, admin, "account_type_changed", "user", id, "Account type changed to " + body.accountType);

        return json({
          success: true,
          user: { id: target.id, username: target.username, accountType: body.accountType }
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
