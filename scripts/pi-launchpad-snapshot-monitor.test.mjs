import test from "node:test";
import assert from "node:assert/strict";
import { comparePiLaunchpadSnapshots } from "./pi-launchpad-snapshot-monitor.mjs";

const snap = (observedAt, metrics = {}) => ({
  tokenId: "pi-token-42", observedAt,
  metrics: { tvlPi: 10000, volume24hPi: 2000, top10Percent: 40, lockedPercent: 80, score: 75, ...metrics }
});

test("detects material liquidity, volume, holder, lock, and score deterioration", () => {
  const result = comparePiLaunchpadSnapshots(
    snap("2026-11-26T10:00:00Z"),
    snap("2026-11-26T11:00:00Z", { tvlPi: 7000, volume24hPi: 800, top10Percent: 55, lockedPercent: 60, score: 60 })
  );
  assert.equal(result.accepted, true);
  assert.deepEqual(result.events.map((e) => e.code), [
    "liquidity_drop", "volume_drop", "holder_concentration_increased",
    "locked_liquidity_decreased", "screening_score_decreased"
  ]);
  assert.equal(result.events[0].severity, "high");
});

test("missing metrics remain unknown and do not create false alerts", () => {
  const result = comparePiLaunchpadSnapshots(
    snap("2026-11-26T10:00:00Z", { tvlPi: null }),
    snap("2026-11-26T11:00:00Z", { tvlPi: null })
  );
  assert.equal(result.accepted, true);
  assert.equal(result.changes.tvlPi.percent, null);
  assert.equal(result.events.some((e) => e.metric === "tvlPi"), false);
});

test("rejects malformed snapshots, token mismatch, and non-increasing timestamps", () => {
  assert.equal(comparePiLaunchpadSnapshots({}, snap("2026-11-26T11:00:00Z")).code, "invalid_snapshot");
  const other = snap("2026-11-26T11:00:00Z"); other.tokenId = "different";
  assert.equal(comparePiLaunchpadSnapshots(snap("2026-11-26T10:00:00Z"), other).code, "token_mismatch");
  assert.equal(comparePiLaunchpadSnapshots(snap("2026-11-26T11:00:00Z"), snap("2026-11-26T11:00:00Z")).code, "non_increasing_observation_time");
});

test("rejects out-of-range percentages and excessive observation gaps", () => {
  assert.equal(comparePiLaunchpadSnapshots(snap("2026-11-26T10:00:00Z"), snap("2026-11-26T11:00:00Z", { lockedPercent: 101 })).code, "invalid_snapshot");
  assert.equal(comparePiLaunchpadSnapshots(snap("2026-11-20T10:00:00Z"), snap("2026-11-26T11:00:00Z")).code, "observation_gap_too_large");
});

test("zero baselines do not produce infinite percentage changes", () => {
  const result = comparePiLaunchpadSnapshots(
    snap("2026-11-26T10:00:00Z", { tvlPi: 0 }),
    snap("2026-11-26T11:00:00Z", { tvlPi: 100 })
  );
  assert.equal(result.changes.tvlPi.percent, null);
});
