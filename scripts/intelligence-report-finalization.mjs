export function isIntelligenceReportQuiescent(counts) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return false;
  const fields = ["inProgress", "retryWaiting", "awaitingApproval", "queued", "blockedDependencies"];
  const values = Object.fromEntries(fields.map(key => [key, Number(counts[key])]));
  if (fields.some(key => !Number.isInteger(values[key]) || values[key] < 0)) return false;
  return values.inProgress === 0 &&
    values.retryWaiting === 0 &&
    values.awaitingApproval === 0 &&
    values.queued <= values.blockedDependencies;
}
