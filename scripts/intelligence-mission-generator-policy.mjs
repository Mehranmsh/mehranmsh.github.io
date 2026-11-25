// Pure safety policy for the future scheduled mission generator.
// This module intentionally performs no network, database, filesystem, or source-write operations.

export const MISSION_GENERATOR_POLICY = Object.freeze({
  maxNewMissionsPerCycle: 1,
  activePackageStatuses: Object.freeze(["queued", "in_progress", "waiting_retry", "attention_required"]),
  allowedActions: Object.freeze([
    "service_health_report",
    "repository_quality_check",
    "source_security_audit",
    "inspect_repository"
  ]),
  forbiddenActions: Object.freeze([
    "source_changes",
    "patch_application",
    "branch_creation",
    "pull_request_creation",
    "merge",
    "deployment",
    "secret_access",
    "arbitrary_shell",
    "wallet_or_financial_actions",
    "account_mutations"
  ])
});

export function getMissionGeneratorDecision({ packages = [], createdThisCycle = 0 } = {}) {
  if (!Array.isArray(packages)) return { allowed: false, reason: "invalid_package_list" };
  if (!Number.isInteger(createdThisCycle) || createdThisCycle < 0) {
    return { allowed: false, reason: "invalid_cycle_count" };
  }
  if (createdThisCycle >= MISSION_GENERATOR_POLICY.maxNewMissionsPerCycle) {
    return { allowed: false, reason: "cycle_limit_reached" };
  }
  const active = packages.filter(item =>
    item && MISSION_GENERATOR_POLICY.activePackageStatuses.includes(String(item.status || "").toLowerCase())
  );
  if (active.length) {
    return {
      allowed: false,
      reason: "active_work_package_exists",
      activePackageIds: active.map(item => String(item.id || "")).filter(Boolean).slice(0, 10)
    };
  }
  return { allowed: true, reason: "clear" };
}

export function buildMissionGeneratorIdempotencyKey(date = new Date(), intervalMinutes = 15) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()) ||
      !Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 60) {
    throw new TypeError("A valid date and interval between 1 and 60 minutes are required.");
  }
  const intervalMs = intervalMinutes * 60 * 1000;
  const bucket = Math.floor(date.getTime() / intervalMs) * intervalMs;
  return "mission-generator:" + new Date(bucket).toISOString().replace(/[^0-9T]/g, "").slice(0, 13);
}
