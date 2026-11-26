import test from "node:test";
import assert from "node:assert/strict";
import { PI_CONNECTOR_POLICY, createPiConnectorPlan } from "./pi-launchpad-connector-policy.mjs";
import { getPiLaunchpadSource } from "./pi-launchpad-source-registry.mjs";

test("connector policy is bounded and denies redirects and arbitrary targets", () => {
  assert.equal(PI_CONNECTOR_POLICY.maxResponseBytes, 256 * 1024);
  assert.equal(PI_CONNECTOR_POLICY.timeoutMs, 5000);
  assert.equal(PI_CONNECTOR_POLICY.maxRedirects, 0);
  assert.equal(PI_CONNECTOR_POLICY.rejectUserSuppliedTargets, true);
});

test("documentation-only Pi references cannot be promoted into live connectors", () => {
  const source = getPiLaunchpadSource("pi_official_launchpad_design");
  assert.equal(createPiConnectorPlan(source, source.origin).allowed, false);
  assert.equal(createPiConnectorPlan(source, source.origin).code, "source_not_live_approved");
});

test("even a proposed live source must pass exact target and independent approval gates", () => {
  const approved = {
    origin: "https://api.example.org/v1/pools",
    status: "live_approved",
    enabledForLiveIngestion: true,
    independentApproval: true,
    connectorId: "reviewed-pool-api"
  };
  assert.equal(createPiConnectorPlan(approved, approved.origin).allowed, true);
  assert.equal(createPiConnectorPlan(approved, "https://api.example.org.attacker.test/v1/pools").code, "target_not_exactly_registered");
  assert.equal(createPiConnectorPlan(approved, "https://api.example.org/v1/pools?url=http://127.0.0.1").code, "target_not_exactly_registered");
  assert.equal(createPiConnectorPlan(approved, approved.origin, { userSuppliedTarget: true }).code, "user_supplied_target_forbidden");
});

test("live approval without independent approval or connector identity remains denied", () => {
  const source = {
    origin: "https://api.example.org/v1/pools",
    status: "live_approved",
    enabledForLiveIngestion: true,
    independentApproval: false,
    connectorId: "reviewed-pool-api"
  };
  assert.equal(createPiConnectorPlan(source, source.origin).code, "source_not_live_approved");
  source.independentApproval = true;
  source.connectorId = "";
  assert.equal(createPiConnectorPlan(source, source.origin).code, "source_not_live_approved");
});
