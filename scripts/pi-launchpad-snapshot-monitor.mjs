/**
 * Deterministic snapshot-diff monitor for Pi Launchpad candidates.
 * It compares already-vetted snapshots only; it does not fetch data or send alerts.
 */
export const PI_LAUNCHPAD_MONITOR_VERSION = "0.1.0";
const METRICS = Object.freeze(["tvlPi", "volume24hPi", "top10Percent", "lockedPercent", "score"]);
const finite = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const timestamp = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v) && Number.isFinite(Date.parse(v));

function normalize(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
      typeof snapshot.tokenId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(snapshot.tokenId) ||
      !timestamp(snapshot.observedAt) || !snapshot.metrics || typeof snapshot.metrics !== "object" ||
      Array.isArray(snapshot.metrics)) return null;
  const metrics = {};
  for (const key of METRICS) {
    const value = snapshot.metrics[key];
    if (value === undefined || value === null) metrics[key] = null;
    else if (finite(value) && ((key !== "top10Percent" && key !== "lockedPercent") || value <= 100)) metrics[key] = value;
    else return null;
  }
  return { tokenId: snapshot.tokenId, observedAt: snapshot.observedAt, metrics };
}

function pctChange(before, after) {
  if (before === null || after === null || before === 0) return null;
  return ((after - before) / before) * 100;
}

export function comparePiLaunchpadSnapshots(previousInput, currentInput, options = {}) {
  const previous = normalize(previousInput);
  const current = normalize(currentInput);
  if (!previous || !current) return Object.freeze({ accepted: false, code: "invalid_snapshot", events: [] });
  if (previous.tokenId !== current.tokenId) return Object.freeze({ accepted: false, code: "token_mismatch", events: [] });
  const beforeTime = Date.parse(previous.observedAt);
  const afterTime = Date.parse(current.observedAt);
  if (afterTime <= beforeTime) return Object.freeze({ accepted: false, code: "non_increasing_observation_time", events: [] });
  const maxGapMs = Number.isInteger(options.maxGapMs) && options.maxGapMs > 0 ? Math.min(options.maxGapMs, 7 * 86400000) : 86400000;
  if (afterTime - beforeTime > maxGapMs) return Object.freeze({ accepted: false, code: "observation_gap_too_large", events: [] });

  const changes = {};
  for (const key of METRICS) {
    const before = previous.metrics[key], after = current.metrics[key];
    changes[key] = Object.freeze({
      before, after,
      absolute: before === null || after === null ? null : after - before,
      percent: pctChange(before, after)
    });
  }
  const events = [];
  const liquidityDrop = changes.tvlPi.percent;
  if (liquidityDrop !== null && liquidityDrop <= -20) events.push({ code: "liquidity_drop", severity: liquidityDrop <= -50 ? "critical" : "high", metric: "tvlPi", changePercent: liquidityDrop });
  const volumeDrop = changes.volume24hPi.percent;
  if (volumeDrop !== null && volumeDrop <= -50) events.push({ code: "volume_drop", severity: volumeDrop <= -80 ? "high" : "medium", metric: "volume24hPi", changePercent: volumeDrop });
  const holderRise = changes.top10Percent.absolute;
  if (holderRise !== null && holderRise >= 10) events.push({ code: "holder_concentration_increased", severity: holderRise >= 20 ? "high" : "medium", metric: "top10Percent", changePoints: holderRise });
  const lockDrop = changes.lockedPercent.absolute;
  if (lockDrop !== null && lockDrop <= -10) events.push({ code: "locked_liquidity_decreased", severity: lockDrop <= -25 ? "high" : "medium", metric: "lockedPercent", changePoints: lockDrop });
  const scoreDrop = changes.score.absolute;
  if (scoreDrop !== null && scoreDrop <= -10) events.push({ code: "screening_score_decreased", severity: scoreDrop <= -20 ? "high" : "medium", metric: "score", changePoints: scoreDrop });

  return Object.freeze({
    accepted: true,
    monitorVersion: PI_LAUNCHPAD_MONITOR_VERSION,
    tokenId: current.tokenId,
    previousObservedAt: previous.observedAt,
    currentObservedAt: current.observedAt,
    changes: Object.freeze(changes),
    events: Object.freeze(events.map((event) => Object.freeze(event))),
    notice: "Snapshot comparison only. Events are monitoring signals, not proof of manipulation, fraud, or future price movement."
  });
}
