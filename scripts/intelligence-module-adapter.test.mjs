import test from "node:test";
import assert from "node:assert/strict";
import { createModuleAdapter, dispatchModuleCapability, MODULE_ADAPTER_POLICY } from "./intelligence-module-adapter.mjs";

test("adapter accepts only handlers explicitly granted by its registered module", () => {
  assert.throws(() => createModuleAdapter({
    moduleId: "social",
    handlers: { "social.private_messages.read": async () => [] }
  }), /capability_not_granted/);
  assert.throws(() => createModuleAdapter({
    moduleId: "future_robotics",
    handlers: {}
  }), /module_not_active/);
});

test("read dispatch receives only bounded input and minimal scoped context", async () => {
  let received;
  const adapter = createModuleAdapter({
    moduleId: "social",
    handlers: {
      "social.metrics.read": async (input, context) => {
        received = { input, context };
        return { users: 12 };
      }
    }
  });
  const result = await dispatchModuleCapability({
    adapter, capability: "social.metrics.read",
    input: { period: "7d" },
    context: { requestId: "req-123", actorType: "owner", secret: "must-not-pass" }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { users: 12 });
  assert.deepEqual(received.input, { period: "7d" });
  assert.deepEqual(received.context, {
    requestId: "req-123", actorType: "owner", approved: false,
    approvalId: null, dataScopes: ["social:aggregate"]
  });
});

test("dispatch rejects sensitive, oversized, and non-record inputs", async () => {
  const adapter = createModuleAdapter({
    moduleId: "social",
    handlers: { "social.metrics.read": async () => ({ users: 1 }) }
  });
  assert.equal((await dispatchModuleCapability({ adapter, capability: "social.metrics.read", input: { password: "x" } })).code, "input_rejected");
  assert.equal((await dispatchModuleCapability({ adapter, capability: "social.metrics.read", input: { payload: "x".repeat(5000) } })).code, "input_rejected");
  assert.equal((await dispatchModuleCapability({ adapter, capability: "social.metrics.read", input: [] })).code, "input_rejected");
});

test("write dispatch requires approval ID and before/after audit events", async () => {
  const events = [];
  const adapter = createModuleAdapter({
    moduleId: "platform_audit",
    handlers: { "audit.events.write": async () => ({ recorded: true }) },
    audit: async event => events.push(event.phase)
  });
  const denied = await dispatchModuleCapability({
    adapter, capability: "audit.events.write", input: {},
    context: { approved: true, approvalId: "approval-123" }
  });
  assert.equal(denied.ok, true);
  assert.deepEqual(events, ["before", "after"]);
});

test("write dispatch fails closed without an approval ID or audit handler", async () => {
  const noAudit = createModuleAdapter({
    moduleId: "platform_audit",
    handlers: { "audit.events.write": async () => ({ recorded: true }) }
  });
  const denied = await dispatchModuleCapability({
    adapter: noAudit, capability: "audit.events.write", input: {},
    context: { approved: true, approvalId: "approval-123" }
  });
  assert.equal(denied.code, "audited_approval_required");
});

test("handler failures and sensitive outputs are not leaked", async () => {
  const throwing = createModuleAdapter({
    moduleId: "social",
    handlers: { "social.metrics.read": async () => { throw new Error("database password=secret"); } }
  });
  assert.deepEqual(await dispatchModuleCapability({ adapter: throwing, capability: "social.metrics.read" }), {
    ok: false, code: "handler_failed"
  });
  const leaking = createModuleAdapter({
    moduleId: "social",
    handlers: { "social.metrics.read": async () => ({ privateMessage: "hidden" }) }
  });
  assert.equal((await dispatchModuleCapability({ adapter: leaking, capability: "social.metrics.read" })).code, "result_rejected");
});

test("adapter policy keeps environment, database, and secrets outside handlers", () => {
  assert.equal(MODULE_ADAPTER_POLICY.receivesWorkerEnvironment, false);
  assert.equal(MODULE_ADAPTER_POLICY.receivesDatabaseBinding, false);
  assert.equal(MODULE_ADAPTER_POLICY.receivesSecrets, false);
});
