/**
 * Deterministic capability boundary for INTELLIGENCE.
 * This module classifies requests only. It never performs an operation.
 * Execution remains disabled in the staging Worker.
 */
export const EXECUTION_ENABLED = false;

const CAPABILITIES = Object.freeze({
  "knowledge.read": { tier: "automatic", effects: ["read"], scope: "owner_staging" },
  "memory.read": { tier: "automatic", effects: ["read"], scope: "owner_staging" },
  "task.plan": { tier: "automatic", effects: ["create_plan"], scope: "owner_staging" },
  "knowledge.create": { tier: "approval", effects: ["write"], scope: "owner_staging" },
  "memory.create": { tier: "approval", effects: ["write"], scope: "owner_staging" },
  "knowledge.review": { tier: "approval", effects: ["change_review_state"], scope: "owner_staging" },
  "memory.delete": { tier: "approval", effects: ["delete"], scope: "owner_staging" },
  "task.execute": { tier: "forbidden", effects: ["external_or_mutating"], scope: "none" },
  "production.write": { tier: "forbidden", effects: ["production_mutation"], scope: "none" },
  "credential.read": { tier: "forbidden", effects: ["secret_access"], scope: "none" },
  "permission.escalate": { tier: "forbidden", effects: ["privilege_change"], scope: "none" }
});

const deny = (reason) => ({
  decision: "deny",
  reason,
  executionEnabled: EXECUTION_ENABLED,
  capabilityKnown: false
});

/**
 * approval must be a server-verified record, never a client assertion.
 * The caller is responsible for loading it from the approval ledger.
 */
export function evaluateCapabilityRequest(request, nowMs = Date.now()) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return deny("invalid_request");
  const capability = CAPABILITIES[request.capability];
  if (!capability) return deny("unknown_capability");
  if (capability.tier === "forbidden") return { ...deny("capability_forbidden"), capabilityKnown: true };
  if (request.ownerAuthenticated !== true || request.sessionValid !== true) {
    return { ...deny("owner_session_required"), capabilityKnown: true };
  }
  if (request.scope !== capability.scope) {
    return { ...deny("scope_mismatch"), capabilityKnown: true };
  }
  if (capability.tier === "automatic") {
    return {
      decision: "eligible_for_automatic",
      reason: "allowlisted_low_risk_capability",
      executionEnabled: EXECUTION_ENABLED,
      capabilityKnown: true,
      effects: capability.effects
    };
  }
  const approval = request.approval;
  if (!approval || approval.serverVerified !== true) {
    return { decision: "approval_required", reason: "owner_approval_required", executionEnabled: EXECUTION_ENABLED, capabilityKnown: true };
  }
  if (typeof request.ownerId !== "string" || request.ownerId.length === 0 ||
      approval.ownerId !== request.ownerId || approval.capability !== request.capability ||
      approval.scope !== capability.scope || approval.revoked !== false ||
      !Number.isSafeInteger(nowMs) || !Number.isSafeInteger(approval.expiresAt) ||
      approval.expiresAt <= nowMs) {
    return { decision: "deny", reason: "approval_invalid_expired_or_out_of_scope", executionEnabled: EXECUTION_ENABLED, capabilityKnown: true };
  }
  return {
    decision: "eligible_after_owner_approval",
    reason: "valid_scoped_owner_approval",
    executionEnabled: EXECUTION_ENABLED,
    capabilityKnown: true,
    effects: capability.effects
  };
}

export function listCapabilityPolicy() {
  return Object.entries(CAPABILITIES).map(([id, value]) => ({
    id, tier: value.tier, effects: [...value.effects], scope: value.scope
  }));
}
