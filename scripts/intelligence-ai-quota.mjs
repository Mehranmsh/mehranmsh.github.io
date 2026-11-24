export function nextWorkersAIDailyResetAt(attemptedAt) {
  const timestamp = typeof attemptedAt === "number" ? attemptedAt : Date.parse(attemptedAt);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

export function isWorkersAIDailyQuotaCircuitOpen(attemptedAt, now = Date.now()) {
  const resetAt = nextWorkersAIDailyResetAt(attemptedAt);
  return resetAt !== null && Number.isFinite(now) && now < resetAt;
}
