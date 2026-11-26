export const INTELLIGENCE_QUEUE_LANES = Object.freeze(["owner", "shared", "quarantine"]);

function cleanUid(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Resolve a task's lane without trusting the legacy assigned_to label.
 * Explicit owner lane requires a verified task owner matching its package owner.
 * Legacy rows are quarantined until ownership is established.
 */
export function resolveIntelligenceTaskLane(task, packageOwnerUid = null) {
  if (!task || typeof task !== "object") return "quarantine";
  const lane = task.queue_lane;
  const taskOwner = cleanUid(task.owner_uid);
  const packageOwner = cleanUid(packageOwnerUid);

  if (lane === "owner") {
    return taskOwner && packageOwner && taskOwner === packageOwner ? "owner" : "quarantine";
  }
  if (lane === "shared") {
    return !taskOwner && !packageOwner ? "shared" : "quarantine";
  }
  return "quarantine";
}

/**
 * Check lane eligibility. Owner checks are always bound to the authenticated
 * owner UID; a symbolic assigned_to value is never proof of ownership.
 */
export function canClaimIntelligenceTask(task, {
  lane,
  ownerUid = null,
  packageOwnerUid = null
} = {}) {
  if (!["owner", "shared"].includes(lane)) return false;
  const resolved = resolveIntelligenceTaskLane(task, packageOwnerUid);
  if (resolved !== lane) return false;
  if (lane === "owner") {
    const expected = cleanUid(ownerUid);
    return !!expected && cleanUid(task.owner_uid) === expected;
  }
  return true;
}
