export function isIntelligenceReportQuiescent(counts) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return false;
  const fields = ["inProgress", "retryWaiting", "awaitingApproval", "queued", "blockedDependencies"];
  if (fields.some(key => !Number.isSafeInteger(counts[key]) || counts[key] < 0)) return false;
  return counts.inProgress === 0 &&
    counts.retryWaiting === 0 &&
    counts.awaitingApproval === 0 &&
    counts.queued <= counts.blockedDependencies;
}
