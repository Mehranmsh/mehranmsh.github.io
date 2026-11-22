import test from "node:test";
import assert from "node:assert/strict";
import { validateNotification, formatOwnerNotification, deliverOne } from "./worker.js";

const sample = {
  id: "11111111-1111-4111-8111-111111111111",
  eventId: "22222222-2222-4222-8222-222222222222",
  channel: "owner_private",
  leaseToken: "abcdefghijklmnopqrstuvwx123456",
  payload: {
    eventId: "22222222-2222-4222-8222-222222222222",
    type: "work_package_status_changed",
    workPackageId: "33333333-3333-4333-8333-333333333333",
    status: "attention_required",
    counts: { total: 4, completed: 2, blocked: 1, failed: 0, awaitingApproval: 0, inProgress: 0, queued: 1, retryWaiting: 0, blockedDependencies: 0 },
    generatedAt: "2026-11-22T18:00:00.000Z"
  }
};

test("accepts the private work-package status event envelope", () => {
  assert.equal(validateNotification(sample).ok, true);
});

test("rejects wrong channel, event type, mismatched event ID, and unsafe counters", () => {
  assert.equal(validateNotification({ ...sample, channel: "public" }).ok, false);
  assert.equal(validateNotification({ ...sample, payload: { ...sample.payload, type: "arbitrary_text" } }).ok, false);
  assert.equal(validateNotification({ ...sample, payload: { ...sample.payload, eventId: "44444444-4444-4444-8444-444444444444" } }).ok, false);
  assert.equal(validateNotification({ ...sample, payload: { ...sample.payload, counts: { ...sample.payload.counts, total: -1 } } }).ok, false);
});

test("formats a bounded Persian owner notification without forwarding arbitrary payload text", () => {
  const text = formatOwnerNotification(sample);
  assert.match(text, /نیازمند بررسی/);
  assert.match(text, /کل کارها: 4/);
  assert.doesNotMatch(text, /arbitrary_text/);
  assert.throws(() => formatOwnerNotification({ ...sample, payload: { ...sample.payload, status: "admin_action" } }));
});


const testEnv = {
  MEHRAN_ORCHESTRATOR_TOKEN: "x".repeat(64),
  TELEGRAM_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyzABCDEFGH1234567890",
  TELEGRAM_CHAT_ID: "123456789"
};

test("delivers a validated notification and acknowledges the exact lease", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/agent/v1/notifications/next")) {
      return new Response(JSON.stringify({ success: true, notification: sample }), { status: 200 });
    }
    if (String(url).includes("api.telegram.org/")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
    }
    if (String(url).endsWith("/agent/v1/notifications/" + sample.id)) {
      return new Response(JSON.stringify({ success: true, status: "delivered" }), { status: 200 });
    }
    throw new Error("unexpected_url");
  };
  try {
    const result = await deliverOne(testEnv);
    assert.deepEqual(result, { claimed: true, delivered: true });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].options.headers.Authorization, "Bearer " + testEnv.MEHRAN_ORCHESTRATOR_TOKEN);
    assert.equal(calls[1].options.method, "POST");
    assert.equal(JSON.parse(calls[1].options.body).chat_id, testEnv.TELEGRAM_CHAT_ID);
    assert.equal(JSON.parse(calls[2].options.body).status, "delivered");
    assert.equal(JSON.parse(calls[2].options.body).leaseToken, sample.leaseToken);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("schedules a bounded retry when Telegram rejects delivery", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/agent/v1/notifications/next")) {
      return new Response(JSON.stringify({ success: true, notification: sample }), { status: 200 });
    }
    if (String(url).includes("api.telegram.org/")) {
      return new Response(JSON.stringify({ ok: false, description: "temporary failure" }), { status: 429 });
    }
    if (String(url).endsWith("/agent/v1/notifications/" + sample.id)) {
      return new Response(JSON.stringify({ success: true, status: "retry_wait" }), { status: 200 });
    }
    throw new Error("unexpected_url");
  };
  try {
    const result = await deliverOne(testEnv);
    assert.deepEqual(result, { claimed: true, delivered: false, retryScheduled: true });
    assert.equal(calls.length, 3);
    assert.equal(JSON.parse(calls[2].options.body).status, "retry");
    assert.equal(JSON.parse(calls[2].options.body).leaseToken, sample.leaseToken);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
