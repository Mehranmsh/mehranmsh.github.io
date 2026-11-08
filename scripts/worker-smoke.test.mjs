import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const workerModule = await import(
  "data:text/javascript;base64," + Buffer.from(workerSource).toString("base64")
);
const worker = workerModule.default;

function mockDb() {
  return {
    prepare(sql) {
      return {
        async first() {
          if (sql.includes("SELECT 1 AS test")) return { test: 1 };
          throw new Error("Unexpected SQL in smoke test: " + sql);
        }
      };
    }
  };
}

async function request(path, { method = "GET", origin, headers = {}, body } = {}, env = {}) {
  const requestHeaders = new Headers(headers);
  if (origin) requestHeaders.set("Origin", origin);
  if (body !== undefined) requestHeaders.set("Content-Type", "application/json");
  return worker.fetch(new Request("https://worker.test" + path, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env);
}

test("health endpoint reports online and confirms the database binding", async () => {
  const response = await request("/health", {}, { DB: mockDb() });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://mehranmsh.github.io");
  const payload = await response.json();
  assert.equal(payload.status, "online");
  assert.equal(payload.database, true);
});

test("health endpoint remains diagnostic when database binding is absent", async () => {
  const response = await request("/health");
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.database, false);
});

test("foreign browser origins are rejected before route handling", async () => {
  const response = await request("/health", { origin: "https://attacker.example" });
  assert.equal(response.status, 403);
  assert.equal(await response.text(), "Forbidden");
});

test("allowed CORS preflight returns the expected methods and headers", async () => {
  const response = await request("/health", {
    method: "OPTIONS",
    origin: "https://mehranmsh.github.io"
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://mehranmsh.github.io");
  assert.match(response.headers.get("Access-Control-Allow-Methods"), /POST/);
  assert.match(response.headers.get("Access-Control-Allow-Headers"), /Authorization/);
});

test("database-backed routes fail closed when the DB binding is missing", async () => {
  for (const path of ["/projects", "/social/profile", "/admin/overview"]) {
    const response = await request(path);
    assert.equal(response.status, 503, path + " should return 503 without DB");
    const payload = await response.json();
    assert.match(payload.error, /Database binding is missing/);
  }
});

test("unknown routes return a structured 404 response", async () => {
  const response = await request("/this-route-does-not-exist");
  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.equal(payload.success, false);
});

test("admin overview rejects requests without a verified admin session", async () => {
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async run() { return { success: true, meta: { changes: 0 } }; },
        async all() { return { results: [] }; },
        async first() {
          if (sql.includes("SELECT uid,username,expires_at FROM admin_sessions")) return null;
          return { total: 0 };
        }
      };
    }
  };
  const response = await request("/admin/overview", {}, { DB: db });
  assert.equal(response.status, 403);
  const payload = await response.json();
  assert.match(payload.error, /Admin authentication required/);
});

test("security guardrails keep request bodies bounded and CORS restricted", () => {
  assert.match(workerSource, /const MAX_BODY_BYTES = 100000;/);
  assert.match(workerSource, /origin !== ALLOWED_ORIGIN/);
  assert.match(workerSource, /Access-Control-Allow-Origin": ALLOWED_ORIGIN/);
});

test("password hashing parameters remain explicit and compatible with the deployed history", () => {
  assert.match(workerSource, /const PBKDF2_ITERATIONS = 100000;/);
  assert.match(workerSource, /crypto\.getRandomValues\(new Uint8Array\(16\)\)/);
  assert.match(workerSource, /hash: "SHA-256"/);
  assert.match(workerSource, /expected\.length !== 32/);
  assert.match(workerSource, /iterations !== PBKDF2_ITERATIONS/);
});

test("Workers AI requests have a fail-closed daily reservation ceiling", () => {
  assert.match(workerSource, /const SOCIAL_AI_DAILY_BUDGET_NEURONS = 5000;/);
  assert.match(workerSource, /if \(!env\?\.DB \|\| !Number\.isInteger\(reservedNeurons\) \|\| reservedNeurons < 1\)/);
  assert.match(workerSource, /WHERE social_ai_daily_budget\.reserved_neurons\+excluded\.reserved_neurons<=\?/);
  assert.match(workerSource, /if \(!budget\.allowed\) throw new Error\("Daily free Workers AI budget is reserved for today\."/);
});


test("social feed excludes private-account public posts and blocked relationships", () => {
  const start = workerSource.indexOf("async function socialFeed");
  const end = workerSource.indexOf("async function socialUserPosts", start);
  assert.ok(start >= 0 && end > start, "socialFeed implementation must exist");
  const feed = workerSource.slice(start, end);
  assert.match(feed, /NOT EXISTS\s*\(\s*SELECT 1 FROM social_user_settings privacy\s*WHERE privacy\.user_id=p\.user_id AND privacy\.is_private=1/);
  assert.match(feed, /p\.visibility='followers'[\s\S]*?social_follows WHERE follower_id=\?/);
  assert.equal((feed.match(/SELECT blocked_id FROM social_blocks WHERE blocker_id=\?/g) || []).length, 2);
  assert.equal((feed.match(/SELECT blocker_id FROM social_blocks WHERE blocked_id=\?/g) || []).length, 2);
  assert.match(feed, /\.bind\(user\.id, user\.id, user\.id, user\.id, user\.id, user\.id, limit\)/);
});


test("SOCIAL post interactions enforce the same visibility policy", () => {
  assert.match(workerSource, /async function canViewSocialPost\(env, viewerId, post\)/);
  const helperStart = workerSource.indexOf("async function canViewSocialPost");
  const helperEnd = workerSource.indexOf("\n}\n", helperStart) + 3;
  const helper = workerSource.slice(helperStart, helperEnd);
  assert.match(helper, /await isBlocked\(env, viewerId, post\.user_id\)/);
  assert.match(helper, /settings\?\.is_private && !follows/);
  assert.match(helper, /post\.visibility === "followers" && !follows/);
  for (const name of ["socialLikePost", "socialBookmark", "socialViewPost", "socialListComments", "socialCreateComment"]) {
    const start = workerSource.indexOf("async function " + name);
    const end = workerSource.indexOf("\nasync function ", start + 20);
    assert.ok(start >= 0 && end > start, name + " must exist");
    assert.match(workerSource.slice(start, end), /canViewSocialPost/);
  }
  const searchStart = workerSource.indexOf("async function socialSearch");
  const searchEnd = workerSource.indexOf("\nasync function ", searchStart + 20);
  const search = workerSource.slice(searchStart, searchEnd);
  assert.match(search, /privacy\.is_private=1/);
  assert.equal((search.match(/SELECT blocker_id FROM social_blocks WHERE blocked_id=\?/g) || []).length, 2);
});


test("private SOCIAL profile gallery and posts respect privacy and blocks", () => {
  const profileStart = workerSource.indexOf("async function getProfileByUsername");
  const profileEnd = workerSource.indexOf("\nasync function ", profileStart + 20);
  const profile = workerSource.slice(profileStart, profileEnd);
  assert.match(profile, /const canViewGallery = !settings\?\.is_private \|\| viewerId === profile\.id \|\| Boolean\(counts\?\.is_following\)/);
  assert.match(profile, /canViewGallery\s*\?\s*await env\.DB\.prepare/);

  const postsStart = workerSource.indexOf("async function socialUserPosts");
  const postsEnd = workerSource.indexOf("\nasync function ", postsStart + 20);
  const posts = workerSource.slice(postsStart, postsEnd);
  assert.match(posts, /await isBlocked\(env, viewer\.id, target\.id\)/);
  assert.match(posts, /canViewSocialPost\(env, viewer\.id, row\)/);
  assert.match(posts, /settings\?\.is_private && !following/);
});


test("blocked SOCIAL profiles are not returned to either side", () => {
  const start = workerSource.indexOf("async function socialGetProfile");
  const end = workerSource.indexOf("\nasync function ", start + 20);
  const profile = workerSource.slice(start, end);
  assert.match(profile, /profile\.id !== viewer\.id && await isBlocked\(env, viewer\.id, profile\.id\)/);
  assert.match(profile, /return error\("User not found", 404\)/);
});


test("message edit and delete require current conversation membership", () => {
  const editStart = workerSource.indexOf("async function socialEditMessage");
  const editEnd = workerSource.indexOf("\nasync function ", editStart + 20);
  const edit = workerSource.slice(editStart, editEnd);
  assert.match(edit, /EXISTS\s*\(\s*SELECT 1 FROM social_conversation_members cm/);
  assert.match(edit, /cm\.conversation_id=social_messages\.conversation_id/);
  assert.match(edit, /cm\.user_id=\?/);
  assert.match(edit, /\.bind\(content, messageId, user\.id, user\.id\)/);

  const deleteStart = workerSource.indexOf("async function socialDeleteMessage");
  const deleteEnd = workerSource.indexOf("\nasync function ", deleteStart + 20);
  const remove = workerSource.slice(deleteStart, deleteEnd);
  assert.match(remove, /EXISTS\s*\(\s*SELECT 1 FROM social_conversation_members cm/);
  assert.match(remove, /cm\.conversation_id=social_messages\.conversation_id/);
  assert.match(remove, /cm\.user_id=\?/);
  assert.match(remove, /\.bind\(messageId, user\.id, user\.id\)/);
});


test("group and channel joins enforce owner block relationships", () => {
  const channelStart = workerSource.indexOf("async function socialJoinChannel");
  const channelEnd = workerSource.indexOf("\nasync function ", channelStart + 20);
  const channel = workerSource.slice(channelStart, channelEnd);
  assert.match(channel, /SELECT id,owner_id,is_private,invite_code FROM social_channels/);
  assert.match(channel, /isBlocked\(env, user\.id, channel\.owner_id\)/);

  const groupStart = workerSource.indexOf("async function socialJoinGroup");
  const groupEnd = workerSource.indexOf("\nasync function ", groupStart + 20);
  const group = workerSource.slice(groupStart, groupEnd);
  assert.match(group, /JOIN social_conversations c ON c\.id=i\.conversation_id/);
  assert.match(group, /invite\.type !== "group"/);
  assert.match(group, /isBlocked\(env, user\.id, invite\.owner_id\)/);
  assert.match(group, /isBlocked\(env, user\.id, invite\.created_by\)/);
});


test("conversation list exposes per-member unread counts without counting own or deleted messages", () => {
  const start = workerSource.indexOf("async function socialListConversations");
  const end = workerSource.indexOf("\nasync function ", start + 20);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /unread\.sender_id<>\?/);
  assert.match(handler, /unread\.deleted_at IS NULL/);
  assert.match(handler, /unread\.created_at>COALESCE/);
  assert.match(handler, /unreadCount: Math\.max\(0, Number\(row\.unread_count \|\| 0\)\)/);
  assert.match(handler, /\.bind\(user\.id, user\.id\)\.all\(\)/);
});

test("notification API returns the complete unread total independently of page limit", () => {
  const start = workerSource.indexOf("async function socialNotifications");
  const end = workerSource.indexOf("\nasync function ", start + 20);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /SELECT COUNT\(\*\) AS total FROM social_notifications WHERE user_id=\? AND is_read=0/);
  assert.match(handler, /unreadCount: Math\.max\(0, Number\(unreadRow\?\.total \|\| 0\)\)/);
});

test("direct message sending stops when either participant blocks the other", () => {
  const helperStart = workerSource.indexOf("async function isDirectConversationBlocked");
  const helperEnd = workerSource.indexOf("\nasync function ", helperStart + 20);
  const helper = workerSource.slice(helperStart, helperEnd);
  assert.match(helper, /c\.type,cm\.user_id/);
  assert.match(helper, /\["direct", "private"\]/);
  assert.match(helper, /isBlocked\(env, userId, row\.user_id\)/);

  const sendStart = workerSource.indexOf("async function socialSendMessage");
  const sendEnd = workerSource.indexOf("\nasync function ", sendStart + 20);
  const send = workerSource.slice(sendStart, sendEnd);
  assert.match(send, /isDirectConversationBlocked\(env, conversationId, user\.id\)/);
  assert.match(send, /Messaging is unavailable for this conversation/);
});


test("group invite creation is restricted to actual group conversations", () => {
  const start = workerSource.indexOf("async function socialGroupInvite");
  const end = workerSource.indexOf("\nasync function ", start + 20);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /SELECT type FROM social_conversations WHERE id=\?/);
  assert.match(handler, /conversation\?\.type !== "group"/);
  assert.match(handler, /DELETE FROM social_group_invites WHERE conversation_id=\?/);
  assert.match(handler, /previousInvitesRevoked: true/);
  const manageStart = workerSource.indexOf("async function socialManageGroupMember");
  const manageEnd = workerSource.indexOf("\nasync function ", manageStart + 20);
  const manage = workerSource.slice(manageStart, manageEnd);
  assert.match(manage, /DELETE FROM social_group_invites WHERE conversation_id=\?/);
});

test("channel pins can only reference posts belonging to that channel", () => {
  const start = workerSource.indexOf("async function socialPinChannelPost");
  const end = workerSource.indexOf("\nasync function ", start + 20);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /SELECT id FROM social_channel_posts WHERE id=\? AND channel_id=\?/);
  assert.match(handler, /Channel post not found/);
});


test("group leave and member management enforce owner and admin hierarchy", () => {
  const leaveStart = workerSource.indexOf("async function socialLeaveGroup");
  const leaveEnd = workerSource.indexOf("\nasync function ", leaveStart + 20);
  const leave = workerSource.slice(leaveStart, leaveEnd);
  assert.match(leave, /conversation\.owner_id === user\.id/);
  assert.match(leave, /transfer ownership before leaving/);
  assert.match(leave, /DELETE FROM social_conversation_members WHERE conversation_id=\? AND user_id=\?/);

  const manageStart = workerSource.indexOf("async function socialManageGroupMember");
  const manageEnd = workerSource.indexOf("\nasync function ", manageStart + 20);
  const manage = workerSource.slice(manageStart, manageEnd);
  assert.match(manage, /role!='owner'/);
  assert.match(manage, /actor\.role='owner' OR \(actor\.role='admin' AND social_conversation_members\.role='member'\)/);
  assert.match(manage, /\["admin", "member"\]/);
  assert.match(manage, /Use the leave-group action to remove yourself/);
});

test("group ownership transfer is owner-only and restricted to existing members", () => {
  assert.ok(workerSource.includes("async function socialTransferGroupOwnership"));
  assert.ok(workerSource.includes("group.owner_id !== user.id"));
  assert.ok(workerSource.includes("Only the group owner can transfer ownership"));
  assert.ok(workerSource.includes("The new owner must already be a group member"));
  assert.ok(workerSource.includes("UPDATE social_conversations SET owner_id=?"));
  assert.ok(workerSource.includes("SET role='admin'"));
  assert.ok(workerSource.includes("SET role='owner'"));
  assert.ok(workerSource.includes("transferGroupMatch"));
  assert.ok(workerSource.includes("/transfer-ownership"));
  const transferStart = workerSource.indexOf("async function socialTransferGroupOwnership");
  const transferEnd = workerSource.indexOf("\nasync function ", transferStart + 20);
  const transfer = workerSource.slice(transferStart, transferEnd);
  assert.match(transfer, /DELETE FROM social_group_invites WHERE conversation_id=\?/);
  const manageStart = workerSource.indexOf("async function socialManageGroupMember");
  const manageEnd = workerSource.indexOf("\nasync function ", manageStart + 20);
  const manage = workerSource.slice(manageStart, manageEnd);
  assert.match(manage, /DELETE FROM social_group_invites WHERE conversation_id=\?/);
  assert.match(manage, /previousInvitesRevoked: true/);
});

test("group member management routes expose only leave, remove, and role updates", () => {
  assert.ok(workerSource.includes("groupLeaveMatch = path.match"));
  assert.ok(workerSource.includes("groupMemberMatch = path.match"));
});



test("channel leave requires membership and prevents owner orphaning", () => {
  const start = workerSource.indexOf("async function socialLeaveChannel");
  const end = workerSource.indexOf("\nasync function ", start + 20);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /SELECT owner_id FROM social_channels WHERE id=\?/);
  assert.match(handler, /channel\.owner_id === user\.id/);
  assert.match(handler, /transfer ownership before leaving/);
  assert.match(handler, /DELETE FROM social_channel_members WHERE channel_id=\? AND user_id=\?/);
  assert.match(handler, /You are not a channel member/);
  assert.ok(workerSource.includes("leaveChannelMatch = path.match"));
});



test("channel media upload IDs must belong to the publishing admin and be ready public files", () => {
  const start = workerSource.indexOf("async function socialChannelPost(");
  const end = workerSource.indexOf("\nasync function ", start + 20);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /SELECT id,name,mime_type,acl,status,url FROM social_uploads WHERE id=\? AND user_id=\? LIMIT 1/);
  assert.match(handler, /upload\.status !== "ready"/);
  assert.match(handler, /upload\.acl !== "public"/);
  assert.match(handler, /!upload\.url \|\| !validHttpsUrl\(upload\.url\)/);
  assert.match(handler, /Channel media must be a ready public upload owned by your account/);
});



test("channel ownership transfer is owner-only and restricted to existing members", () => {
  const start = workerSource.indexOf("async function socialTransferChannelOwnership(");
  const end = workerSource.indexOf("\nasync function ", start + 30);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /channel\.owner_id !== user\.id/);
  assert.match(handler, /SELECT role FROM social_channel_members WHERE channel_id=\? AND user_id=\?/);
  assert.match(handler, /The new owner must already be a channel member/);
  assert.match(handler, /UPDATE social_channels SET owner_id=\?/);
  assert.match(handler, /UPDATE social_channel_members SET role='subscriber'/);
  assert.match(handler, /UPDATE social_channel_members SET role='owner'/);
  assert.match(handler, /await env\.DB\.batch\(/);
  assert.ok(workerSource.includes("transferChannelMatch = path.match"));
});


test("channel administration is owner-only and cannot alter the owner", () => {
  const start = workerSource.indexOf("async function socialManageChannelMember");
  const end = workerSource.indexOf("\nasync function ", start + 30);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /channel\.owner_id !== user\.id/);
  assert.match(handler, /Only the channel owner can manage administrators/);
  assert.match(handler, /target\.role === "owner"/);
  assert.match(handler, /\["admin", "subscriber"\]/);
  assert.match(handler, /role!='owner'/);
  assert.match(handler, /DELETE FROM social_channel_members/);
  assert.ok(workerSource.includes("channelMemberMatch = path.match"));
});

test("private channel invite rotation revokes the previous code and is owner-only", () => {
  const start = workerSource.indexOf("async function socialRotateChannelInvite");
  const end = workerSource.indexOf("\nasync function ", start + 30);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /UPDATE social_channels SET invite_code=\?/);
  assert.match(handler, /owner_id=\? AND is_private=1/);
  assert.match(handler, /previousInvitesRevoked: true/);
  assert.match(handler, /Invite rotation is available only for private channels/);
  assert.ok(workerSource.includes("rotateChannelInviteMatch = path.match"));
});


test("channel member directory is visible only to current channel members", () => {
  const start = workerSource.indexOf("async function socialListChannelMembers");
  const end = workerSource.indexOf("\nasync function ", start + 30);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /SELECT role FROM social_channel_members WHERE channel_id=\? AND user_id=\?/);
  assert.match(handler, /if \(!membership\) return error\("Channel not found", 404\)/);
  assert.match(handler, /JOIN social_users u ON u\.id=m\.user_id/);
  assert.match(handler, /LIMIT 500/);
  assert.ok(workerSource.includes("channelMembersMatch = path.match"));
});


test("channel post edits and deletion require admin membership and stay scoped to the channel", () => {
  const editStart = workerSource.indexOf("async function socialEditChannelPost");
  const editEnd = workerSource.indexOf("\nasync function ", editStart + 30);
  const edit = workerSource.slice(editStart, editEnd);
  assert.match(edit, /!\["owner", "admin"\]\.includes\(member\.role\)/);
  assert.match(edit, /WHERE id=\? AND channel_id=\?/);
  assert.match(edit, /edited_at=CURRENT_TIMESTAMP/);
  assert.match(edit, /UPDATE social_channel_posts SET content=/);

  const deleteStart = workerSource.indexOf("async function socialDeleteChannelPost");
  const deleteEnd = workerSource.indexOf("\nasync function ", deleteStart + 30);
  const remove = workerSource.slice(deleteStart, deleteEnd);
  assert.match(remove, /!\["owner", "admin"\]\.includes\(member\.role\)/);
  assert.match(remove, /DELETE FROM social_channel_pins WHERE channel_id=\? AND post_id=\?/);
  assert.match(remove, /DELETE FROM social_channel_posts WHERE id=\? AND channel_id=\?/);
  assert.match(remove, /Uploaded media files are intentionally retained/);
  assert.ok(workerSource.includes("channelPostItemMatch = path.match"));
});


test("group member management enforces owner and admin hierarchy", () => {
  const start = workerSource.indexOf("async function socialManageGroupMember");
  const end = workerSource.indexOf("\\nasync function ", start + 20);
  const manage = workerSource.slice(start, end);
  assert.match(manage, /actor\.role='owner' OR \(actor\.role='admin' AND social_conversation_members\.role='member'\)/);
  assert.match(manage, /role!='owner'/);
  assert.match(manage, /Use the leave-group action to remove yourself/);
  assert.ok(workerSource.includes('groupMemberMatch && method === "PATCH"'));
  assert.ok(workerSource.includes('groupMemberMatch && method === "DELETE"'));
});


test("presence heartbeat requires authentication and updates only the authenticated active user", () => {
  const start = workerSource.indexOf("async function socialPresenceHeartbeat");
  const end = workerSource.indexOf("\\nasync function ", start + 30);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /getSocialUser\\(request, env\\)/);
  assert.match(handler, /UPDATE social_users SET last_seen_at=CURRENT_TIMESTAMP WHERE id=\\? AND is_active=1/);
  assert.match(handler, /bind\\(user\\.id\\)/);
  assert.ok(workerSource.includes('path === "/social/presence" && method === "POST"'));
});

test("conversation presence respects each member's online-status privacy setting", () => {
  const start = workerSource.indexOf("async function socialListConversations");
  const end = workerSource.indexOf("\\nasync function ", start + 30);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /LEFT JOIN social_user_settings us ON us\\.user_id=cm\\.user_id/);
  assert.match(handler, /COALESCE\\(us\\.show_online_status,1\\)=1 THEN u\\.last_seen_at ELSE NULL/);
  assert.match(handler, /lastSeenAt: member\\.last_seen_at \\|\\| null/);
});
