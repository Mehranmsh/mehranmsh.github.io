export function isIntelligenceReportQuiescent(counts) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return false;
  const fields = ["inProgress", "retryWaiting", "awaitingApproval", "queued", "blockedDependencies"];
  if (fields.some(key => !Number.isSafeInteger(counts[key]) || counts[key] < 0)) return false;
  return counts.inProgress === 0 &&
    counts.retryWaiting === 0 &&
    counts.awaitingApproval === 0 &&
    counts.queued <= counts.blockedDependencies;
}

// Conflicting immutable snapshots are archived side-by-side using a stable content hash.
export function buildIntelligenceReportRevisionPath(year, month, packageId, contentHash) {
  if (typeof year !== "string" || !/^[0-9]{4}$/.test(year) ||
      typeof month !== "string" || !/^(0[1-9]|1[0-2])$/.test(month) ||
      typeof packageId !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(packageId) ||
      typeof contentHash !== "string" || !/^[A-Za-z0-9_-]{16,}$/.test(contentHash)) {
    throw new Error("Invalid Intelligence report revision identity.");
  }
  return "reports/" + year + "/" + month + "/" + packageId + "-" + contentHash.slice(0,16) + ".json";
}
