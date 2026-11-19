import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCapabilityRequest, EXECUTION_ENABLED, listCapabilityPolicy } from "../intelligence-capability-policy.mjs";

const base = { ownerId: "owner-1", ownerAuthenticated: true, sessionValid: true, scope: "owner_staging" };

test("execution is hard-disabled even when a capability is eligible", () => {
  const result = evaluateCapabilityRequest({ ...base, capability: "knowledge.read" });
  assert.equal(result.decision, "eligible_for_automatic");
  assert.equal(result.executionEnabled, false);
  assert.equal(EXECUTION_ENABLED, false);
});

test("unknown capabilities fail closed", () => {
  assert.equal(evaluateCapabilityRequest({ ...base, capability: "shell.run" }).decision, "deny");
});

test("forbidden capabilities cannot be approved into existence", () => {
  const result = evaluateCapabilityRequest({ ...base, capability: "production.write", approval: { serverVerified: true, ownerId: "owner-1", capability: "production.write", scope: "owner_staging", expiresAt: Date.now()+60000 } });
  assert.equal(result.reason, "capability_forbidden");
});

test("automatic read and planning capabilities require authenticated owner staging session", () => {
  assert.equal(evaluateCapabilityRequest({ ...base, ownerAuthenticated: false, capability: "memory.read" }).reason, "owner_session_required");
  assert.equal(evaluateCapabilityRequest({ ...base, scope: "production", capability: "task.plan" }).reason, "scope_mismatch");
});

test("mutations require a server-verified owner approval", () => {
  const request = { ...base, capability: "memory.delete" };
  assert.equal(evaluateCapabilityRequest(request).decision, "approval_required");
  assert.equal(evaluateCapabilityRequest({ ...request, approval: { serverVerified: false } }).decision, "approval_required");
});

test("approval must match owner, capability, scope and expiry", () => {
  const request = { ...base, capability: "memory.delete" };
  const good = { serverVerified: true, ownerId: "owner-1", capability: "memory.delete", scope: "owner_staging", status: "issued", expiresAt: 2000, revoked: false, revokedAt: null, consumedAt: null, consumedBy: null };
  assert.equal(evaluateCapabilityRequest({ ...request, approval: good }, 1000).decision, "eligible_after_owner_approval");
  assert.equal(evaluateCapabilityRequest({ ...request, approval: { ...good, ownerId: "other" } }, 1000).decision, "deny");
  assert.equal(evaluateCapabilityRequest({ ...request, approval: { ...good, expiresAt: 1000 } }, 1000).reason, "approval_invalid_expired_or_out_of_scope");
  assert.equal(evaluateCapabilityRequest({ ...request, approval: { ...good, revoked: true } }, 1000).decision, "deny");
});

test("approval metadata must be explicit safe integers and an explicit active state", () => {
  const request = { ...base, capability: "memory.delete" };
  const good = { serverVerified: true, ownerId: "owner-1", capability: "memory.delete", scope: "owner_staging", status: "issued", expiresAt: 2000, revoked: false, revokedAt: null, consumedAt: null, consumedBy: null };
  assert.equal(evaluateCapabilityRequest({ ...request, approval: { ...good, revoked: undefined } }, 1000).decision, "deny");
  assert.equal(evaluateCapabilityRequest({ ...request, approval: { ...good, expiresAt: 2000.5 } }, 1000).decision, "deny");
  assert.equal(evaluateCapabilityRequest({ ...request, approval: { ...good, expiresAt: Number.MAX_SAFE_INTEGER + 1 } }, 1000).decision, "deny");
  assert.equal(evaluateCapabilityRequest({ ...request, approval: good }, Number.NaN).decision, "deny");
  assert.equal(evaluateCapabilityRequest({ ...request, approval: good }, 1000.5).decision, "deny");
  assert.equal(evaluateCapabilityRequest({ ...request, ownerId: "", approval: good }, 1000).decision, "deny");
});

test("policy inventory keeps execution and privilege escalation forbidden", () => {
  const items = Object.fromEntries(listCapabilityPolicy().map(item => [item.id, item]));
  assert.equal(items["task.execute"].tier, "forbidden");
  assert.equal(items["credential.read"].tier, "forbidden");
  assert.equal(items["permission.escalate"].tier, "forbidden");
});

test("approval must still be issued and have no terminal ledger metadata", () => {
  const request = { ...base, capability: "memory.delete" };
  const good = { serverVerified: true, ownerId: "owner-1", capability: "memory.delete", scope: "owner_staging", status: "issued", expiresAt: 2000, revoked: false, revokedAt: null, consumedAt: null, consumedBy: null };
  for (const approval of [
    { ...good, status: "revoked" },
    { ...good, status: "expired" },
    { ...good, status: "consumed" },
    { ...good, status: undefined },
    { ...good, revokedAt: 1500 },
    { ...good, consumedAt: 1500, consumedBy: "executor" },
    { ...good, consumedBy: "executor" }
  ]) {
    assert.equal(evaluateCapabilityRequest({ ...request, approval }, 1000).decision, "deny");
  }
  assert.equal(evaluateCapabilityRequest({ ...request, approval: good }, 1000).decision, "eligible_after_owner_approval");
});
