import test from "node:test";
import assert from "node:assert/strict";
import {
  PI_LAUNCHPAD_SOURCE_REGISTRY,
  getPiLaunchpadSource,
  matchPiLaunchpadSourceReference
} from "./pi-launchpad-source-registry.mjs";

test("registry contains only explicitly documented Pi-owned reference sources", () => {
  assert.ok(PI_LAUNCHPAD_SOURCE_REGISTRY.length >= 4);
  for (const source of PI_LAUNCHPAD_SOURCE_REGISTRY) {
    assert.equal(source.enabledForLiveIngestion, false);
    assert.equal(source.status, "documentation_only");
    assert.match(source.origin, /^https:\/\//);
    assert.ok(Object.isFrozen(source));
    assert.ok(Object.isFrozen(source.supportedClaims));
  }
});

test("known official source reference matches exact curated origin and path", () => {
  const result = matchPiLaunchpadSourceReference(
    "pi_official_launchpad_design",
    "https://minepi.com/blog/pi-launchpad/"
  );
  assert.equal(result.matched, true);
  assert.equal(result.liveIngestionAllowed, false);
});

test("rejects lookalike domains, alternate paths, and arbitrary URLs", () => {
  assert.equal(matchPiLaunchpadSourceReference(
    "pi_official_launchpad_design",
    "https://minepi.com.attacker.example/blog/pi-launchpad/"
  ).matched, false);
  assert.equal(matchPiLaunchpadSourceReference(
    "pi_official_launchpad_design",
    "https://minepi.com/other-page"
  ).matched, false);
  assert.equal(matchPiLaunchpadSourceReference("unknown", "https://minepi.com/").matched, false);
});

test("registry metadata cannot be interpreted as permission for live ingestion", () => {
  for (const source of PI_LAUNCHPAD_SOURCE_REGISTRY) {
    const result = matchPiLaunchpadSourceReference(source.id, source.origin);
    assert.equal(result.liveIngestionAllowed, false);
  }
  assert.equal(getPiLaunchpadSource("not-real"), null);
});
