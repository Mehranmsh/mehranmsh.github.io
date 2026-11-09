import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const indexSource = await readFile(new URL("../index.html", import.meta.url), "utf8");
const musicStudioSource = await readFile(new URL("../music-studio.html", import.meta.url), "utf8");
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
  assert.ok(handler.includes("unread.rowid>COALESCE(cm.last_read_message_rowid"));
  assert.match(handler, /unreadCount: Math\.max\(0, Number\(row\.unread_count \|\| 0\)\)/);
  assert.match(handler, /\.bind\(user\.id, user\.id, user\.id, user\.id\)\.all\(\)/);
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
  assert.match(handler, /getAccessibleChannelMembership\(env, channelId, user\.id\)/);
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
  const end = workerSource.indexOf("\nasync function ", start + 20);
  const manage = workerSource.slice(start, end);
  assert.match(manage, /actor\.role='owner' OR \(actor\.role='admin' AND social_conversation_members\.role='member'\)/);
  assert.match(manage, /role!='owner'/);
  assert.match(manage, /Use the leave-group action to remove yourself/);
  assert.ok(workerSource.includes('groupMemberMatch && method === "PATCH"'));
  assert.ok(workerSource.includes('groupMemberMatch && method === "DELETE"'));
});


test("presence heartbeat requires authentication and updates only the authenticated active user", () => {
  assert.ok(workerSource.includes("async function socialPresenceHeartbeat(request, env)"));
  assert.ok(workerSource.includes("const user = await getSocialUser(request, env);"));
  assert.ok(workerSource.includes("UPDATE social_users SET last_seen_at=CURRENT_TIMESTAMP WHERE id=? AND is_active=1"));
  assert.ok(workerSource.includes(".bind(user.id).run();"));
  assert.ok(workerSource.includes('path === "/social/presence" && method === "POST"'));
});

test("conversation presence respects each member's online-status privacy setting", () => {
  assert.ok(workerSource.includes("show_online_status"));
  assert.ok(workerSource.includes("last_seen_at ELSE NULL"));
  assert.ok(workerSource.includes("lastSeenAt: member.last_seen_at"));
});




test("chat read cursors always advance while read-receipt visibility respects each member preference", () => {
  const start = workerSource.indexOf("async function socialConversationMessages");
  const end = workerSource.indexOf("\nasync function socialSendMessage", start);
  assert.ok(start >= 0 && end > start, "conversation messages handler must exist");
  const handler = workerSource.slice(start, end);
  assert.ok(handler.includes("SET last_read_at=?,") && handler.includes("last_read_message_rowid=?"));
  assert.doesNotMatch(handler, /if \(viewerPrefs\.chat\?\.readReceipts/);
  const listStart = workerSource.indexOf("async function socialListConversations");
  const listEnd = workerSource.indexOf("\nasync function ", listStart + 30);
  const list = workerSource.slice(listStart, listEnd);
  assert.match(list, /readprefs\.preferences_json AS read_preferences_json/);
  assert.match(list, /prefs\.chat\?\.readReceipts === false \? null/);
});


test("SOCIAL notification badge refresh is bounded, authenticated, and skips hidden or offline tabs", () => {
  assert.match(indexSource, /async function socialRefreshNotificationCount\(\)/);
  assert.match(indexSource, /if\(!socialUser\|\|!navigator\.onLine\|\|document\.hidden\|\|socialNotificationRefreshBusy\)return/);
  assert.match(indexSource, /socialRequest\("\/notifications\?limit=1"\)/);
  assert.match(indexSource, /setInterval\(socialRefreshNotificationCount,30000\)/);
  assert.match(indexSource, /socialNotificationRefreshBusy=false/);
});

test("SOCIAL reconnect recovery refreshes notification counts and only reloads the open notification view", () => {
  assert.match(indexSource, /window\.addEventListener\("online",recover\)/);
  assert.match(indexSource, /socialRefreshNotificationCount\(\)/);
  assert.match(indexSource, /\$\("social-notifications"\)\?\.classList\.contains\("active"\)\)loadNotifications\(\)/);
});


test("open SOCIAL notification feed refreshes silently without overlapping requests", () => {
  assert.match(indexSource, /let socialNotificationListBusy=false/);
  assert.match(indexSource, /async function loadNotifications\(silent=false\)/);
  assert.match(indexSource, /if\(socialNotificationListBusy\)return/);
  assert.match(indexSource, /socialNotificationListBusy=false/);
  assert.match(indexSource, /await loadNotifications\(true\)/);
  assert.match(indexSource, /if\(!silent\)\{/);
});


test("SOCIAL notifications remain recipient-scoped and respect notification preferences", () => {
  const start = workerSource.indexOf("async function socialNotifications");
  const end = workerSource.indexOf("\nasync function socialReadNotifications", start);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /WHERE n\.user_id=\?/);
  assert.match(handler, /\.bind\(user\.id, limit\)/);
  const readStart = workerSource.indexOf("async function socialReadNotifications");
  const readEnd = workerSource.indexOf("\nasync function ", readStart + 30);
  const readHandler = workerSource.slice(readStart, readEnd);
  assert.match(readHandler, /WHERE id=\? AND user_id=\?/);
  assert.match(readHandler, /WHERE user_id=\?/);
  const notifyStart = workerSource.indexOf("async function notify");
  const notifyEnd = workerSource.indexOf("\nasync function ", notifyStart + 30);
  const notifyHandler = workerSource.slice(notifyStart, notifyEnd);
  assert.match(notifyHandler, /if \(!userId \|\| userId === actorId\) return/);
  assert.match(notifyHandler, /prefs\.notifications\[key\] === false/);
});


test("SOCIAL blocked direct conversations are hidden from lists and message history", () => {
  const messageStart = workerSource.indexOf("async function socialConversationMessages");
  const messageEnd = workerSource.indexOf("async function socialSendMessage", messageStart + 30);
  assert.ok(messageStart >= 0 && messageEnd > messageStart);
  const messages = workerSource.slice(messageStart, messageEnd);
  assert.ok(messages.includes("isDirectConversationBlocked(env, conversationId, user.id)"));
  assert.ok(messages.includes('return error("Conversation not found", 404)'));

  const listStart = workerSource.indexOf("async function socialListConversations");
  const listEnd = workerSource.indexOf("async function ", listStart + 30);
  const list = workerSource.slice(listStart, listEnd);
  assert.ok(list.includes("c.type IN ('direct','private')"));
  assert.ok(list.includes("JOIN social_blocks block_edge"));
  assert.ok(list.includes("block_edge.blocker_id=? AND block_edge.blocked_id=other_member.user_id"));
  assert.ok(list.includes("block_edge.blocker_id=other_member.user_id AND block_edge.blocked_id=?"));
});

test("SOCIAL direct messages, group messages, and channel posts notify other members without failing the content write", () => {
  const sendStart = workerSource.indexOf("async function socialSendMessage");
  const sendEnd = workerSource.indexOf("async function socialEditMessage", sendStart);
  const send = workerSource.slice(sendStart, sendEnd);
  assert.match(send, /SELECT user_id FROM social_conversation_members WHERE conversation_id=\? AND user_id!=\?/);
  assert.match(send, /conversation\?\.type === "group" \? "group_message" : "message"/);
  assert.match(send, /await notify\(env, row\.user_id, user\.id, notificationType/);
  assert.match(send, /SOCIAL_MESSAGE_NOTIFICATION_FAILURE/);

  const channelStart = workerSource.indexOf("async function socialChannelPost");
  const channelEnd = workerSource.indexOf("async function socialEditChannelPost", channelStart);
  const channel = workerSource.slice(channelStart, channelEnd);
  assert.match(channel, /SELECT user_id FROM social_channel_members WHERE channel_id=\? AND user_id!=\?/);
  assert.match(channel, /await notify\(env, subscriber\.user_id, user\.id, "channel_post"/);
  assert.match(channel, /SOCIAL_CHANNEL_NOTIFICATION_FAILURE/);
  assert.match(channel, /new post in a channel you follow/);
});

test("SOCIAL group creation sends preference-aware invitation notifications after membership succeeds", () => {
  const start = workerSource.indexOf("async function socialCreateGroup");
  const end = workerSource.indexOf("async function socialGroupInvite", start);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /for \(const target of targets\)/);
  assert.match(handler, /await notify\(env, target\.id, user\.id, "group_invite", id, "added you to a group"\)/);
  assert.match(handler, /SOCIAL_GROUP_INVITATION_NOTIFICATION_FAILURE/);
  const notifyStart = workerSource.indexOf("async function notify");
  const notifyEnd = workerSource.indexOf("\nasync function ", notifyStart + 30);
  const notifyHandler = workerSource.slice(notifyStart, notifyEnd);
  assert.match(notifyHandler, /prefs\.community\?\.groupInvites === false/);
  assert.match(notifyHandler, /prefs\.notifications\[key\] === false/);
});

test("SOCIAL chat unread cursors are rowid-based to avoid same-second message loss", () => {
  assert.ok(workerSource.includes('ensureColumn("social_conversation_members", "last_read_message_rowid", "INTEGER")'));
  assert.ok(workerSource.includes("unread.rowid>COALESCE(cm.last_read_message_rowid"));
  assert.ok(workerSource.includes("read_cursor.created_at<=COALESCE(NULLIF(cm.last_read_at,''),NULLIF(cm.joined_at,''),"));
  assert.ok(workerSource.includes("const newestDelivered = (result.results || [])[0]"));
  assert.ok(workerSource.includes("ORDER BY m.created_at DESC,m.rowid DESC LIMIT ?"));
  assert.ok(workerSource.includes("ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1"));
});
test("SOCIAL repeated like requests do not create duplicate notifications", () => {
  const start = workerSource.indexOf("async function socialLikePost");
  const end = workerSource.indexOf("async function socialBookmark", start);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /INSERT OR IGNORE INTO social_post_likes/);
  assert.match(handler, /Number\(likeResult\?\.meta\?\.changes \|\| 0\) > 0/);
  assert.match(handler, /SOCIAL_LIKE_NOTIFICATION_FAILURE/);
});

test("SOCIAL read cursor advances only to the newest message actually delivered in the response", () => {
  const start = workerSource.indexOf("async function socialConversationMessages");
  const end = workerSource.indexOf("async function socialSendMessage", start + 30);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.ok(handler.includes("const newestDelivered = (result.results || [])[0]"));
  assert.ok(handler.includes("SET last_read_at=?,"));
  assert.ok(handler.includes("last_read_message_rowid=?"));
  assert.ok(handler.includes("Number(newestDelivered.message_rowid)"));
  assert.ok(handler.includes("if (newestDelivered?.message_rowid != null)"));
  assert.ok(!handler.includes("SELECT MAX(read_cursor.rowid)"));
});

test("SOCIAL read receipts use message sequence cursors to avoid same-second false Seen states", () => {
  assert.ok(workerSource.includes("cm.last_read_at,cm.last_read_message_rowid"));
  assert.ok(workerSource.includes("m.rowid AS message_rowid"));
  assert.ok(workerSource.includes("messageRowId: Number(row.message_rowid)"));
  assert.ok(workerSource.includes("lastReadMessageRowId:"));
  assert.ok(indexSource.includes("member.lastReadMessageRowId"));
  assert.ok(indexSource.includes("readSequence>=messageSequence"));
  assert.ok(indexSource.includes("member.lastReadMessageRowId??null"));
});

test("SOCIAL repeated follow and private follow-request calls do not duplicate notifications", () => {
  const start = workerSource.indexOf("async function socialFollow");
  const end = workerSource.indexOf("async function ", start + 30);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.ok(handler.includes("Number(requestResult?.meta?.changes || 0) > 0"));
  assert.ok(handler.includes("Number(followResult?.meta?.changes || 0) > 0"));
  assert.ok(handler.includes("SOCIAL_FOLLOW_REQUEST_NOTIFICATION_FAILURE"));
  assert.ok(handler.includes("SOCIAL_FOLLOW_NOTIFICATION_FAILURE"));
});

test("SOCIAL new conversation members receive a read cursor at their join boundary", () => {
  assert.ok(workerSource.includes("INSERT INTO social_conversation_members(conversation_id,user_id,role,last_read_message_rowid)"));
  assert.ok(workerSource.includes("VALUES(?,?,'member',0)"));
  const groupStart = workerSource.indexOf("async function socialCreateGroup");
  const groupEnd = workerSource.indexOf("async function socialGroupInvite", groupStart);
  const group = workerSource.slice(groupStart, groupEnd);
  assert.ok(group.includes("VALUES(?,?,'owner',0)"));
  assert.ok(group.includes("VALUES(?,?,'member',0)"));
  const joinStart = workerSource.indexOf("async function socialJoinGroup");
  const joinEnd = workerSource.indexOf("async function ", joinStart + 30);
  const join = workerSource.slice(joinStart, joinEnd);
  assert.ok(join.includes("last_read_at,last_read_message_rowid"));
  assert.ok(join.includes("SELECT MAX(rowid) FROM social_messages WHERE conversation_id=?"));
  assert.ok(join.includes("COALESCE("));
});

test("SOCIAL repeated story reactions do not generate duplicate notifications", () => {
  assert.ok(workerSource.includes("async function socialReactStory"));
  assert.ok(workerSource.includes("WHERE social_story_reactions.reaction<>excluded.reaction"));
  assert.ok(workerSource.includes("Number(reactionResult?.meta?.changes || 0) > 0"));
  assert.ok(workerSource.includes("SOCIAL_STORY_REACTION_NOTIFICATION_FAILURE"));
});

test("SOCIAL unread counters have indexes for recipient and conversation lookups", () => {
  assert.ok(workerSource.includes("idx_social_notifications_unread"));
  assert.ok(workerSource.includes("ON social_notifications(user_id,is_read,created_at DESC)"));
  assert.ok(workerSource.includes("idx_social_messages_unread"));
  assert.ok(workerSource.includes("ON social_messages(conversation_id,sender_id,deleted_at)"));
});

test("SOCIAL comment and follow approval writes survive notification delivery failures", () => {
  assert.ok(workerSource.includes("SOCIAL_COMMENT_NOTIFICATION_FAILURE"));
  assert.ok(workerSource.includes("SOCIAL_FOLLOW_ACCEPTED_NOTIFICATION_FAILURE"));
  const commentStart = workerSource.indexOf("async function socialCreateComment");
  const commentEnd = workerSource.indexOf("async function ", commentStart + 30);
  assert.ok(commentStart >= 0 && commentEnd > commentStart);
  assert.ok(workerSource.slice(commentStart, commentEnd).includes("try {"));
  const acceptStart = workerSource.indexOf("async function socialFollowRequestAction");
  assert.ok(acceptStart >= 0);
  assert.ok(workerSource.includes('await notify(env, row.requester_id, user.id, "follow_accepted"'));
});

test("SOCIAL uploads enforce per-user ownership and verify storage metadata before completion", () => {
  const completeStart = workerSource.indexOf("async function socialCompleteUpload");
  const completeEnd = workerSource.indexOf("async function socialListUploads", completeStart);
  assert.ok(completeStart >= 0 && completeEnd > completeStart);
  const complete = workerSource.slice(completeStart, completeEnd);
  assert.match(complete, /SELECT \* FROM social_uploads WHERE id=\? AND user_id=\?/);
  assert.match(complete, /file\.metadata\?\.userId !== user\.id/);
  assert.match(complete, /file\.status !== "ready"/);
  assert.match(complete, /row\.acl === "public" \? \(file\.url \|\| null\) : null/);

  const getStart = workerSource.indexOf("async function socialGetUploadUrl");
  const getEnd = workerSource.indexOf("async function socialDeleteUpload", getStart);
  assert.ok(getStart >= 0 && getEnd > getStart);
  const getUrl = workerSource.slice(getStart, getEnd);
  assert.match(getUrl, /SELECT \* FROM social_uploads WHERE id=\? AND user_id=\?/);
  assert.match(getUrl, /if \(row\.status !== "ready"\)/);
  assert.match(getUrl, /expiresIn: 3600/);
  assert.match(getUrl, /validHttpsUrl\(result\.url\)/);

  const deleteStart = workerSource.indexOf("async function socialDeleteUpload");
  const deleteEnd = workerSource.indexOf("async function fetchPiUser", deleteStart);
  const remove = workerSource.slice(deleteStart, deleteEnd);
  assert.match(remove, /SELECT id FROM social_uploads WHERE id=\? AND user_id=\?/);
  assert.match(remove, /DELETE FROM social_uploads WHERE id=\? AND user_id=\?/);
});

test("SOCIAL channel content and membership are hidden across block relationships", () => {
  assert.match(workerSource, /async function getAccessibleChannelMembership\(env, channelId, userId\)/);
  assert.match(workerSource, /if \(!member \|\| await isBlocked\(env, userId, member\.owner_id\)\) return null/);
  const listStart = workerSource.indexOf("async function socialListChannels");
  const listEnd = workerSource.indexOf("async function socialCreateChannel", listStart);
  const list = workerSource.slice(listStart, listEnd);
  assert.match(list, /NOT EXISTS \([\s\S]*social_blocks[\s\S]*b\.blocker_id=c\.owner_id/);
  for (const name of ["socialListChannelMembers", "socialChannelPosts", "socialChannelPost"]) {
    const start = workerSource.indexOf("async function " + name);
    assert.ok(start >= 0, name + " should exist");
    const end = workerSource.indexOf("async function ", start + 1);
    assert.match(workerSource.slice(start, end), /getAccessibleChannelMembership\(env, channelId, user\.id\)/, name + " must enforce block privacy");
  }
});


test("SOCIAL group creation rejects blocked relationships between invited members", () => {
  const start = workerSource.indexOf("async function socialCreateGroup");
  const end = workerSource.indexOf("async function socialGroupInvite", start);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /for \(let i = 0; i < targets\.length; i\+\+\)/);
  assert.match(handler, /for \(let j = i \+ 1; j < targets\.length; j\+\+\)/);
  assert.match(handler, /isBlocked\(env, targets\[i\]\.id, targets\[j\]\.id\)/);
  assert.match(handler, /cannot be placed in the same group/);
});

test("SOCIAL group invite joins check block relationships with every existing participant", () => {
  const start = workerSource.indexOf("async function socialJoinGroup");
  const end = workerSource.indexOf("async function socialCreateChannel", start);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /SELECT user_id FROM social_conversation_members WHERE conversation_id=\?/);
  assert.match(handler, /for \(const existing of existingMembers\.results \|\| \[\]\)/);
  assert.match(handler, /isBlocked\(env, user\.id, existing\.user_id\)/);
  assert.match(handler, /Group access is unavailable because of a block relationship/);
});


test("SOCIAL story visibility respects block relationships in both directions", () => {
  assert.match(workerSource, /async function canViewSocialStory\(env, viewerId, story\)/);
  const listStart = workerSource.indexOf("async function socialStories");
  const listEnd = workerSource.indexOf("async function socialCreateStory", listStart);
  const list = workerSource.slice(listStart, listEnd);
  assert.match(list, /NOT EXISTS \([\s\S]*social_blocks[\s\S]*b\.blocker_id=s\.user_id AND b\.blocked_id=\?/);
  for (const name of ["socialViewStory", "socialReactStory"]) {
    const start = workerSource.indexOf("async function " + name);
    const end = workerSource.indexOf("async function ", start + 1);
    assert.ok(start >= 0 && end > start);
    assert.match(workerSource.slice(start, end), /canViewSocialStory\(env, user\.id, story\)/, name + " must enforce story visibility");
  }
});

test("SOCIAL stories can only publish ready public media uploaded by the story owner", () => {
  const start = workerSource.indexOf("async function socialCreateStory");
  const end = workerSource.indexOf("async function socialDeleteStory", start);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /WHERE user_id=\? AND url=\? LIMIT 1/);
  assert.match(handler, /upload\.status !== "ready"/);
  assert.match(handler, /upload\.acl !== "public"/);
  assert.match(handler, /startsWith\(expectedMime\)/);
});


test("MEHRAN MUSIC STUDIO is linked from Services as an independent workspace", () => {
  assert.match(indexSource, /href="music-studio\.html"/);
  assert.match(indexSource, /MEHRAN MUSIC STUDIO/);
  assert.match(musicStudioSource, /<title>MEHRAN MUSIC STUDIO<\/title>/);
  assert.match(musicStudioSource, /Independent creative workspace/);
});

test("MEHRAN MUSIC STUDIO drafts stay local and generation is fail-closed before engine setup", () => {
  assert.match(musicStudioSource, /mehran_music_studio_drafts_v1/);
  assert.match(musicStudioSource, /localStorage\.setItem\(KEY,JSON\.stringify\(projects\)\)/);
  assert.match(musicStudioSource, /GENERATION ENGINE NOT CONNECTED/);
  assert.match(musicStudioSource, /Audio generation is not active yet/);
  assert.doesNotMatch(musicStudioSource, /fetch\s*\(/);
  assert.match(musicStudioSource, /No external model is called/);
});

test("MEHRAN MUSIC STUDIO supports new projects without overwriting the previously edited draft", () => {
  assert.match(musicStudioSource, /function newProject\(\)/);
  assert.match(musicStudioSource, /delete \$\("saveProject"\)\.dataset\.edit/);
  assert.match(musicStudioSource, /if\(nav\.dataset\.view==="create"\)newProject\(\)/);
  assert.match(musicStudioSource, /if\(go\.dataset\.go==="create"\)newProject\(\)/);
});

test("SOCIAL AI account identity is preserved and can only be assigned by the Pi admin", () => {
  assert.match(workerSource, /function normalizeAccountType\(value\)/);
  assert.match(workerSource, /\["human", "business", "ai"\]\.includes\(value\) \? value : "human"/);
  assert.match(workerSource, /accountType: normalizeAccountType\(user\.account_type\)/);
  assert.match(workerSource, /accountType: normalizeAccountType\(profile\.account_type\)/);
  assert.match(workerSource, /accountType: normalizeAccountType\(row\.account_type\)/);
  const start = workerSource.indexOf("const adminUserAccountTypeMatch");
  const end = workerSource.indexOf("const adminUserStatusMatch", start);
  assert.ok(start >= 0 && end > start, "admin account type route must exist");
  const route = workerSource.slice(start, end);
  assert.match(route, /verifyAdmin\(request, env\)/);
  assert.match(route, /\["human", "business", "ai"\]\.includes\(body\.accountType\)/);
  assert.match(route, /primary administrator identity must remain a human account/);
  assert.match(route, /writeAdminAudit\(env, admin, "account_type_changed"/);
  assert.match(workerSource, /const requestedAccountType = body\.accountType === "business" \? "business" : "human"/);
  assert.match(indexSource, /accountType==="ai"\?"🤖 AI account"/);
});

test("SOCIAL legacy registration cannot bypass verified email identity", () => {
  assert.match(workerSource, /path === "\/social\/register" && method === "POST"[\s\S]*?Legacy password registration is disabled[\s\S]*?410/);
  const sessionStart = workerSource.indexOf("async function getSocialUser");
  const sessionEnd = workerSource.indexOf("async function createSocialSession", sessionStart);
  const sessionLookup = workerSource.slice(sessionStart, sessionEnd);
  assert.match(sessionLookup, /u\.is_active=1 AND u\.email_verified=1/);
  const loginStart = workerSource.indexOf("async function socialLogin");
  const loginEnd = workerSource.indexOf("async function socialMe", loginStart);
  const login = workerSource.slice(loginStart, loginEnd);
  assert.match(login, /if \(!user\.email_verified\)/);
  assert.match(login, /Email verification is required/);
  assert.match(login, /verified email identity/);
});

test("SOCIAL AI never falls back to paid external providers", () => {
  const readyStart = workerSource.indexOf("function socialAIProviderReady");
  const readyEnd = workerSource.indexOf("\nfunction socialAIProviderList", readyStart);
  const ready = workerSource.slice(readyStart, readyEnd);
  assert.match(ready, /return key === "cloudflare"/);
  assert.doesNotMatch(ready, /OPENAI_API_KEY|GEMINI_API_KEY|GROQ_API_KEY/);
  const requestStart = workerSource.indexOf("function socialAIRequest");
  const requestEnd = workerSource.indexOf("\nasync function ", requestStart);
  const request = workerSource.slice(requestStart, requestEnd);
  assert.match(request, /provider !== "cloudflare"/);
  assert.match(request, /Paid external AI providers are disabled/);
  assert.match(workerSource, /const SOCIAL_AI_DAILY_BUDGET_NEURONS = 5000/);
  assert.match(workerSource, /Only the capped Cloudflare free allowance is available/);
  assert.match(workerSource, /Free image analysis currently supports one image per message/);
});

test("SOCIAL admin UI can manage Human, Business and AI identity types", () => {
  assert.match(workerSource, /SELECT id,username,email,display_name,pi_username,pi_verified,account_type/);
  assert.match(workerSource, /accountType: normalizeAccountType\(row\.account_type\)/);
  assert.match(indexSource, /data-account-type=/);
  assert.match(indexSource, /option value="human"/);
  assert.match(indexSource, /option value="business"/);
  assert.match(indexSource, /option value="ai"/);
  assert.match(indexSource, /\/account-type/);
  assert.match(indexSource, /Human · protected/);
});

test("SOCIAL marks AI and Business identities in feed, stories, notifications and chat data", () => {
  assert.match(workerSource, /accountType: normalizeAccountType\(author\?\.account_type\)/);
  assert.match(workerSource, /u\.username,u\.display_name,u\.avatar_url,u\.account_type\s+FROM social_messages/);
  assert.match(workerSource, /accountType: normalizeAccountType\(row\.account_type\)\s+\},\s+isMine/);
  assert.match(workerSource, /u\.username,u\.display_name,u\.avatar_url,u\.account_type\s+FROM social_notifications/);
  assert.match(workerSource, /u\.username,u\.display_name,u\.avatar_url,u\.account_type,\s+EXISTS/);
  assert.match(workerSource, /accountType: normalizeAccountType\(member\.account_type\)/);
  assert.match(workerSource, /accountType: normalizeAccountType\(row\.account_type\)/);
  assert.match(indexSource, /function socialAccountTypeLabel/);
  assert.match(indexSource, /socialAccountTypeLabel\(post\.accountType\)/);
  assert.match(indexSource, /socialAccountTypeLabel\(m\.author\?\.accountType\)/);
  assert.match(indexSource, /socialAccountTypeLabel\(s\.author\?\.accountType\)/);
  assert.match(indexSource, /socialAccountTypeLabel\(item\.actor\?\.accountType\)/);
});

test("SOCIAL AI accounts cannot inflate likes, follows or view/reaction counts", () => {
  const followStart = workerSource.indexOf("async function socialFollow(");
  const followEnd = workerSource.indexOf("\nasync function ", followStart + 20);
  assert.match(workerSource.slice(followStart, followEnd), /user\.accountType === "ai" && follow/);
  const likeStart = workerSource.indexOf("async function socialLikePost");
  const likeEnd = workerSource.indexOf("\nasync function ", likeStart + 20);
  assert.match(workerSource.slice(likeStart, likeEnd), /shouldLike && user\.accountType === "ai"/);
  const viewStart = workerSource.indexOf("async function socialViewPost");
  const viewEnd = workerSource.indexOf("\nasync function ", viewStart + 20);
  assert.match(workerSource.slice(viewStart, viewEnd), /user\.accountType === "ai"/);
  const storyReactStart = workerSource.indexOf("async function socialReactStory");
  const storyReactEnd = workerSource.indexOf("\nasync function ", storyReactStart + 20);
  assert.match(workerSource.slice(storyReactStart, storyReactEnd), /user\.accountType === "ai"/);
  const storyViewStart = workerSource.indexOf("async function socialViewStory");
  const storyViewEnd = workerSource.indexOf("\nasync function ", storyViewStart + 20);
  assert.match(workerSource.slice(storyViewStart, storyViewEnd), /user\.accountType === "ai"/);
  const adminStart = workerSource.indexOf("const adminUserAccountTypeMatch");
  const adminEnd = workerSource.indexOf("const adminUserStatusMatch", adminStart);
  const adminRoute = workerSource.slice(adminStart, adminEnd);
  for (const table of ["social_post_likes", "social_follows", "social_follow_requests", "social_post_views", "social_story_views", "social_story_reactions"]) {
    assert.ok(adminRoute.includes("DELETE FROM " + table), "AI conversion must clean " + table);
  }
});

test("SOCIAL public profile visibly labels verified AI and Business account types", () => {
  assert.match(workerSource, /accountType: normalizeAccountType\(profile\.account_type\)/);
  assert.match(indexSource, /socialAccountTypeLabel\(p\.accountType\)/);
  assert.match(indexSource, /profile-name-line/);
});

test("SOCIAL comments preserve and display the author's verified account type", () => {
  const listStart = workerSource.indexOf("async function socialListComments");
  const listEnd = workerSource.indexOf("\nasync function ", listStart + 20);
  const listRoute = workerSource.slice(listStart, listEnd);
  assert.match(listRoute, /u\.avatar_url,u\.account_type/);
  assert.match(listRoute, /accountType: normalizeAccountType\(row\.account_type\)/);
  const createStart = workerSource.indexOf("async function socialCreateComment");
  const createEnd = workerSource.indexOf("\nasync function ", createStart + 20);
  assert.match(workerSource.slice(createStart, createEnd), /accountType: normalizeAccountType\(user\.accountType\)/);
  assert.match(indexSource, /socialAccountTypeLabel\(c\.accountType\|\|c\.author\?\.accountType\)/);
  assert.match(indexSource, /accountType:c\.author\?\.accountType\|\|"human"/);
});

test("SOCIAL follow requests expose account type and acceptance revalidates privacy and active accounts", () => {
  const listStart = workerSource.indexOf("async function socialFollowRequests");
  const listEnd = workerSource.indexOf("async function ", listStart + 30);
  assert.ok(listStart >= 0 && listEnd > listStart);
  const list = workerSource.slice(listStart, listEnd);
  assert.match(list, /u\.account_type/);
  assert.match(list, /accountType: normalizeAccountType\(row\.account_type\)/);
  assert.match(list, /u\.is_active=1/);

  const actionStart = workerSource.indexOf("async function socialFollowRequestAction");
  const actionEnd = workerSource.indexOf("async function ", actionStart + 30);
  const action = workerSource.slice(actionStart, actionEnd);
  assert.match(action, /requester\.is_active=1/);
  assert.match(action, /target\.is_active=1/);
  assert.match(action, /await isBlocked\(env, row\.requester_id, user\.id\)/);
  assert.match(action, /NOT EXISTS \([\s\S]*FROM social_blocks/);
  assert.match(action, /results\?\.\[0\]\?\.meta\?\.changes/);
  assert.match(indexSource, /socialAccountTypeLabel\(r\.user\.accountType\)/);
});

test("SOCIAL privacy settings reject non-boolean visibility flags instead of coercing strings", () => {
  const start = workerSource.indexOf("async function socialPrivacy");
  const end = workerSource.indexOf("async function ", start + 30);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /\["isPrivate", "showOnlineStatus", "showActivityStatus"\]/);
  assert.match(handler, /typeof body\[key\] !== "boolean"/);
  assert.match(handler, /body\.isPrivate === true \? 1 : 0/);
  assert.match(handler, /body\.showOnlineStatus === true \? 1 : 0/);
  assert.match(handler, /body\.showActivityStatus === true \? 1 : 0/);
});

test("SOCIAL existing direct chats recheck the recipient's current message privacy before sending", () => {
  const start = workerSource.indexOf("async function socialSendMessage");
  const end = workerSource.indexOf("async function ", start + 30);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /directRecipient = await env\.DB\.prepare/);
  assert.match(handler, /c\.type IN \('direct','private'\)/);
  assert.match(handler, /recipientSettings\?\.allow_messages === "none"/);
  assert.match(handler, /recipientSettings\?\.allow_messages === "followers"/);
  assert.match(handler, /follower_id=\? AND following_id=\?/);
  assert.ok(handler.indexOf("recipientSettings") < handler.indexOf("const body = await readBody(request)"));
});



test("SOCIAL direct-call discovery, joining and signaling enforce current block relationships", () => {
  const section = (name, next) => {
    const start = workerSource.indexOf("async function " + name);
    const end = workerSource.indexOf("\nasync function " + next, start);
    assert.ok(start >= 0 && end > start, name + " handler must exist");
    return workerSource.slice(start, end);
  };
  assert.ok(section("socialCallStart", "socialCallActive").includes("isDirectConversationBlocked(env, conversationId, user.id)"));
  assert.ok(section("socialCallActive", "socialCallJoin").includes("isDirectConversationBlocked(env, conversationId, user.id)"));
  assert.ok(section("socialCallJoin", "socialCallSignal").includes("isDirectConversationBlocked(env, call.conversation_id, user.id)"));
  const signal = section("socialCallSignal", "socialCallLeave");
  assert.ok(signal.includes("isDirectConversationBlocked(env, call.conversation_id, user.id)"));
  assert.ok(signal.includes("isDirectConversationBlocked(env, call.conversation_id, toUserId)"));
});


test("SOCIAL call signaling rejects users removed from the conversation", () => {
  const start = workerSource.indexOf("async function socialCallSignal");
  const end = workerSource.indexOf("\nasync function socialCallLeave", start);
  assert.ok(start >= 0 && end > start, "socialCallSignal handler must exist");
  const handler = workerSource.slice(start, end);
  assert.match(handler, /isConversationMember\(env, call\.conversation_id, user\.id\)/);
  assert.match(handler, /isConversationMember\(env, call\.conversation_id, toUserId\)/);
  assert.match(handler, /if \(!senderMembership \|\| !targetMembership\)/);
  assert.match(handler, /social-call-signal/);
  assert.match(handler, /300, 60, 60/);
  assert.match(handler, /Array\.isArray\(body\.payload\)/);
});

test("SOCIAL call polling enforces current membership and block state", () => {
  const start = workerSource.indexOf("async function socialCallPoll");
  const end = workerSource.indexOf("\nasync function socialCallSignal", start);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /isConversationMember\(env,call\.conversation_id,user\.id\)/);
  assert.match(handler, /isDirectConversationBlocked\(env, call\.conversation_id, user\.id\)/);
  assert.match(handler, /JOIN social_conversation_members cm ON cm\.conversation_id=\? AND cm\.user_id=p\.user_id/);
  assert.match(handler, /\.bind\(call\.conversation_id,callId\)\.all\(\)/);
  assert.match(handler, /social-call-poll/);
  assert.match(handler, /100, 60, 60/);
  assert.match(handler, /Number\.isSafeInteger\(rawAfter\)/);
});

test("SOCIAL call creation and joining have abuse limits", () => {
  const start = workerSource.indexOf("async function socialCallStart");
  const active = workerSource.indexOf("async function socialCallActive", start);
  const join = workerSource.indexOf("async function socialCallJoin");
  const poll = workerSource.indexOf("async function socialCallPoll", join);
  assert.ok(start >= 0 && active > start && join >= 0 && poll > join);
  assert.match(workerSource.slice(start, active), /social-call-start/);
  assert.match(workerSource.slice(start, active), /5, 600, 600/);
  assert.match(workerSource.slice(join, poll), /social-call-join/);
  assert.match(workerSource.slice(join, poll), /20, 60, 60/);
});

test("SOCIAL active call participant lists exclude users removed from the conversation", () => {
  const start = workerSource.indexOf("async function socialCallActive");
  const end = workerSource.indexOf("\nasync function socialCallJoin", start);
  assert.ok(start >= 0 && end > start);
  const handler = workerSource.slice(start, end);
  assert.match(handler, /JOIN social_conversation_members cm ON cm\.conversation_id=\? AND cm\.user_id=p\.user_id/);
  assert.match(handler, /\.bind\(call\.conversation_id,call\.id\)\.all\(\)/);
});

test("SOCIAL bot owners can rotate active credentials and delete only their own bots", () => {
  const rotateStart = workerSource.indexOf("async function socialRotateBotToken");
  const deleteStart = workerSource.indexOf("async function socialDeleteBot");
  const listStart = workerSource.indexOf("async function socialListBots");
  const aiStart = workerSource.indexOf("const SOCIAL_AI_PROVIDERS");
  assert.ok(rotateStart > listStart && deleteStart > rotateStart && aiStart > deleteStart);
  const rotate = workerSource.slice(rotateStart, deleteStart);
  const remove = workerSource.slice(deleteStart, aiStart);
  const createStart = workerSource.indexOf("async function socialCreateBot");
  const createEnd = workerSource.indexOf("\nasync function socialListBots", createStart);
  const create = workerSource.slice(createStart, createEnd);
  assert.match(create, /social-bot-create/);
  assert.match(create, /SELECT COUNT\(\*\) AS total FROM social_bots WHERE owner_id=\?/);
  assert.match(create, /ownedBots\?\.total \|\| 0\) >= 25/);
  assert.match(rotate, /social-bot-rotate/);
  assert.match(rotate, /UPDATE social_bots SET token_hash=\? WHERE id=\? AND owner_id=\? AND is_active=1/);
  assert.match(rotate, /return json\(\{ success: true, token, rotated: true \}\)/);
  assert.match(remove, /DELETE FROM social_bots WHERE id=\? AND owner_id=\?/);
  assert.match(remove, /return json\(\{ success: true, deleted: true \}\)/);
  assert.match(workerSource, /rotate-token/);
  const listFnStart = workerSource.indexOf("async function socialListBots");
  const listEnd = workerSource.indexOf("\nasync function socialRotateBotToken", listFnStart);
  const list = workerSource.slice(listFnStart, listEnd);
  assert.match(list, /SELECT id,name,username,description,is_active,created_at/);
  assert.match(list, /FROM social_bots WHERE owner_id=\?/);
  assert.doesNotMatch(list, /token_hash/);
});

test("SOCIAL account deletion reauthenticates, removes external media and cleans account-owned data", () => {
  const start = workerSource.indexOf("async function socialDeleteAccount");
  const end = workerSource.indexOf("\n}\n\nexport default", start);
  const handler = workerSource.slice(start, end);
  assert.ok(start >= 0 && end > start, "socialDeleteAccount implementation must exist");
  for (const marker of [
    "identitytoolkit.googleapis.com/v1/accounts:signInWithPassword",
    "identitytoolkit.googleapis.com/v1/accounts:lookup",
    "identity.localId === row.firebase_uid",
    "rapidfileRequest(env, `/files/",
    "DELETE FROM social_uploads WHERE user_id=?",
    "DELETE FROM social_posts WHERE user_id=?",
    "DELETE FROM social_stories WHERE user_id=?",
    "DELETE FROM social_sessions WHERE user_id=?",
    "DELETE FROM social_users WHERE id=?",
    "Could not remove all account media from storage",
    "ownershipTransferred: true",
    "identitytoolkit.googleapis.com/v1/accounts:delete",
    "providerIdentityDeleted"
  ]) assert.ok(handler.includes(marker), "Missing account deletion safeguard: " + marker);
  assert.doesNotMatch(handler, /deactivated: true/);
});

test("SOCIAL deletion transfers owned communities only to active existing members", () => {
  const start = workerSource.indexOf("async function socialDeleteAccount");
  const end = workerSource.indexOf("\n}\n\nexport default", start);
  const handler = workerSource.slice(start, end);
  assert.ok(handler.includes("JOIN social_users u ON u.id=cm.user_id") && handler.includes("u.is_active=1"));
  assert.ok(handler.includes("UPDATE social_conversation_members SET role='owner'") && handler.includes("c.owner_id=social_conversation_members.user_id"));
  assert.ok(handler.includes("UPDATE social_channel_members SET role='owner'") && handler.includes("c.owner_id=social_channel_members.user_id"));
});


test("authenticated SOCIAL rate limits are account-scoped while pre-auth limits remain IP-scoped", () => {
  const helperStart = workerSource.indexOf("async function checkRateLimit");
  const helperEnd = workerSource.indexOf("\\n}", helperStart);
  const helper = workerSource.slice(helperStart, helperEnd);
  assert.ok(helper.includes("account:${accountId}"));
  assert.ok(helper.includes("ip:${ip}"));
  assert.ok(helper.includes("accountId = null"));
  for (const [fn, scope] of [
    ["socialCallStart", "social-call-start"],
    ["socialCallJoin", "social-call-join"],
    ["socialCallPoll", "social-call-poll"],
    ["socialCallSignal", "social-call-signal"],
    ["socialAssistantChat", "social-ai-chat"],
    ["socialDeleteAccount", "account-delete"]
  ]) {
    const start = workerSource.indexOf("async function " + fn);
    assert.ok(start >= 0, fn + " must exist");
    const next = workerSource.indexOf("\\nasync function ", start + 1);
    const body = workerSource.slice(start, next > start ? next : undefined);
    assert.ok(body.includes(scope), fn + " must retain its rate-limit scope");
    assert.ok(body.includes("user.id"), fn + " must pass the authenticated account ID");
  }
  const registerStart = workerSource.indexOf("async function socialRegister");
  const registerEnd = workerSource.indexOf("async function socialFirebaseSession", registerStart);
  assert.ok(workerSource.slice(registerStart, registerEnd).includes(
    'checkRateLimit(env, request, "register-v3", 20, 3600, 600)'
  ), "pre-auth registration must remain IP-scoped");
});


test("SOCIAL call leave requires active participation and is rate limited", () => {
  const start = workerSource.indexOf("async function socialCallLeave");
  const end = workerSource.indexOf("\nasync function socialStartConversation", start);
  const handler = workerSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(handler.includes('"social-call-leave", 30, 60, 60, user.id'));
  assert.ok(handler.includes("SELECT left_at FROM social_call_participants WHERE call_id=? AND user_id=?"));
  assert.ok(handler.includes("if (!participant || participant.left_at)"));
  assert.ok(handler.indexOf("if (!participant || participant.left_at)") < handler.indexOf("UPDATE social_call_participants"));
});


test("SOCIAL active-call status polling is account rate limited", () => {
  const start = workerSource.indexOf("async function socialCallActive");
  const end = workerSource.indexOf("\nasync function socialCallJoin", start);
  const handler = workerSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(handler.includes('"social-call-active", 60, 60, 60, user.id'));
  assert.ok(handler.includes("Call status checks are temporarily rate limited"));
});
