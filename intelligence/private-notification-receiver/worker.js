const SOURCE_API = "https://mehran-msh-auth.mehran79mehran.workers.dev";
const MAX_BATCH = 5;
const ALLOWED_STATUSES = new Set(["queued", "in_progress", "waiting_retry", "completed", "attention_required"]);
const STATUS_FA = {
  queued: "در صف اجرا",
  in_progress: "در حال اجرا",
  waiting_retry: "در انتظار تلاش مجدد",
  completed: "تکمیل شد",
  attention_required: "نیازمند بررسی"
};

function validUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function validateNotification(notification) {
  if (!notification || typeof notification !== "object") return { ok: false, reason: "invalid_notification" };
  if (!validUuid(notification.id) || !validUuid(notification.eventId) ||
      typeof notification.leaseToken !== "string" || notification.leaseToken.length < 20 ||
      notification.leaseToken.length > 100 || notification.channel !== "owner_private") {
    return { ok: false, reason: "invalid_delivery_envelope" };
  }
  const payload = notification.payload;
  if (!payload || typeof payload !== "object" ||
      payload.type !== "work_package_status_changed" ||
      payload.eventId !== notification.eventId ||
      !validUuid(payload.workPackageId) ||
      !ALLOWED_STATUSES.has(payload.status) ||
      !payload.counts || typeof payload.counts !== "object") {
    return { ok: false, reason: "unsupported_event" };
  }
  const fields = ["total", "completed", "blocked", "failed", "awaitingApproval", "inProgress", "queued", "retryWaiting", "blockedDependencies"];
  for (const field of fields) {
    const value = payload.counts[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      return { ok: false, reason: "invalid_event_counts" };
    }
  }
  if (!Number.isSafeInteger(payload.counts.total) || payload.counts.total < 1) {
    return { ok: false, reason: "invalid_event_counts" };
  }
  return { ok: true, payload };
}

export function formatOwnerNotification(notification) {
  const checked = validateNotification(notification);
  if (!checked.ok) throw new TypeError(checked.reason);
  const { payload } = checked;
  const counts = payload.counts;
  const status = STATUS_FA[payload.status];
  return [
    "MEHRAN INTELLIGENCE",
    "",
    "وضعیت بستهٔ کاری: " + status,
    "شناسه: " + payload.workPackageId,
    "کل کارها: " + counts.total,
    "تکمیل‌شده: " + (counts.completed || 0),
    "مسدود: " + ((counts.blocked || 0) + (counts.failed || 0) + (counts.blockedDependencies || 0)),
    "در حال اجرا: " + (counts.inProgress || 0),
    "در انتظار: " + ((counts.queued || 0) + (counts.retryWaiting || 0) + (counts.awaitingApproval || 0)),
    "زمان: " + (typeof payload.generatedAt === "string" && Number.isFinite(Date.parse(payload.generatedAt)) ? payload.generatedAt : "ثبت نشده")
  ].join("\n");
}

function requireConfig(env) {
  const token = typeof env.MEHRAN_ORCHESTRATOR_TOKEN === "string" ? env.MEHRAN_ORCHESTRATOR_TOKEN : "";
  const botToken = typeof env.TELEGRAM_BOT_TOKEN === "string" ? env.TELEGRAM_BOT_TOKEN : "";
  const chatId = typeof env.TELEGRAM_CHAT_ID === "string" ? env.TELEGRAM_CHAT_ID : "";
  if (token.length < 40 || token.length > 200) throw new Error("orchestrator_secret_missing_or_invalid");
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(botToken)) throw new Error("telegram_bot_secret_missing_or_invalid");
  if (!/^-?\d{1,20}$/.test(chatId)) throw new Error("telegram_chat_id_missing_or_invalid");
  return { token, botToken, chatId };
}

async function sourceRequest(path, config, options = {}) {
  const response = await fetch(SOURCE_API + path, {
    ...options,
    headers: {
      "Authorization": "Bearer " + config.token,
      "Accept": "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    signal: AbortSignal.timeout(15000),
    redirect: "error"
  });
  let body;
  try { body = await response.json(); } catch { throw new Error("source_api_invalid_json"); }
  if (!response.ok) throw new Error("source_api_http_" + response.status);
  return body;
}

async function sendTelegram(text, config) {
  const response = await fetch("https://api.telegram.org/bot" + config.botToken + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      chat_id: config.chatId,
      text,
      disable_web_page_preview: true
    }),
    signal: AbortSignal.timeout(15000),
    redirect: "error"
  });
  let body;
  try { body = await response.json(); } catch { throw new Error("telegram_invalid_json"); }
  if (!response.ok || body?.ok !== true) throw new Error("telegram_delivery_failed");
  return true;
}

async function acknowledge(notification, status, message, config) {
  return sourceRequest("/agent/v1/notifications/" + encodeURIComponent(notification.id), config, {
    method: "POST",
    body: JSON.stringify({
      status,
      message: String(message || "").slice(0, 200),
      leaseToken: notification.leaseToken
    })
  });
}

export async function deliverOne(env) {
  const config = requireConfig(env);
  const claim = await sourceRequest("/agent/v1/notifications/next", config);
  const notification = claim?.notification;
  if (!notification) return { claimed: false };
  const checked = validateNotification(notification);
  if (!checked.ok) {
    if (validUuid(notification.id) && typeof notification.leaseToken === "string" && notification.leaseToken.length >= 20) {
      await acknowledge(notification, "failed", checked.reason, config);
    }
    return { claimed: true, delivered: false, rejected: checked.reason };
  }
  try {
    const message = formatOwnerNotification(notification);
    await sendTelegram(message, config);
  } catch {
    await acknowledge(notification, "retry", "private_channel_delivery_failed", config);
    return { claimed: true, delivered: false, retryScheduled: true };
  }
  await acknowledge(notification, "delivered", "", config);
  return { claimed: true, delivered: true };
}

async function runBatch(env) {
  for (let index = 0; index < MAX_BATCH; index++) {
    const result = await deliverOne(env);
    if (!result.claimed) break;
  }
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runBatch(env).catch(error => {
      const code = String(error?.message || "notifier_run_failed").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
      console.error("MEHRAN_PRIVATE_NOTIFIER_FAILURE", code || "unknown");
    }));
  },
  async fetch(request) {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return new Response(JSON.stringify({ status: "online", service: "mehran-private-notification-receiver" }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
      });
    }
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
};
