import test from "node:test";
import assert from "node:assert/strict";
import {
  listRegisteredModules, getRegisteredModule, discoverModuleManifest,
  resolveModuleCapability, MODULE_REGISTRY_POLICY, validateModuleRegistry,
  getModuleIntegrationPlan, buildModuleHealthReport
} from "./intelligence-module-registry.mjs";

test("registry includes core and current modules plus shared platform services", () => {
  const ids = listRegisteredModules().map(item => item.id);
  for (const id of ["msh_core", "studio_music", "social", "mehran_ai", "platform_auth", "platform_database", "platform_audit"]) {
    assert.ok(ids.includes(id), id + " must be registered");
  }
});

test("planned future modules are visible but have no capabilities", () => {
  for (const id of ["future_instruments", "future_robotics"]) {
    const module = getRegisteredModule(id);
    assert.equal(module.status, "planned");
    assert.equal(module.capabilities.length, 0);
    assert.equal(module.dataScopes.length, 0);
    assert.equal(resolveModuleCapability(id, "anything").ok, false);
  }
});

test("trusted active modules resolve only explicitly granted capabilities", () => {
  assert.equal(resolveModuleCapability("social", "social.metrics.read").ok, true);
  assert.deepEqual(resolveModuleCapability("social", "social.metrics.read").dataScopes, ["social:aggregate"]);
  assert.deepEqual(resolveModuleCapability("social", "social.private_messages.read"), { ok: false, code: "capability_not_granted" });
  assert.deepEqual(resolveModuleCapability("missing_module", "health.read"), { ok: false, code: "unknown_module" });
});

test("new modules are discovered pending and receive no access by default", () => {
  const result = discoverModuleManifest({
    id: "new_service", name: "New Service", version: "1.0",
    dependencies: ["platform_auth"], capabilities: ["service.health.read"],
    dataScopes: ["service:aggregate"], healthcheck: { kind: "internal_contract" }
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "pending");
  assert.equal(result.trusted, false);
  assert.deepEqual(result.enabledCapabilities, []);
  assert.deepEqual(result.enabledDataScopes, []);
});

test("manifest validation rejects secret and private content scopes", () => {
  for (const scope of ["service:secrets", "social:private-messages", "auth:passwords", "wallet:keys"]) {
    const result = discoverModuleManifest({
      id: "blocked_service", name: "Blocked Service", version: "1",
      capabilities: ["service.health.read"], dataScopes: [scope]
    });
    assert.equal(result.ok, false, scope);
  }
});

test("manifest validation rejects duplicate, malformed and excessive inputs", () => {
  const base = { id: "new_service", name: "New Service", version: "1", capabilities: [], dataScopes: [] };
  assert.equal(discoverModuleManifest({ ...base, dependencies: ["platform_auth", "platform_auth"] }).code, "duplicate_manifest_entry");
  assert.equal(discoverModuleManifest({ ...base, capabilities: ["*"] }).code, "invalid_capabilities");
  assert.equal(discoverModuleManifest({ ...base, version: "../latest" }).code, "invalid_module_version");
  assert.equal(discoverModuleManifest({ ...base, id: "bad" }).code, "invalid_module_id");
});

test("write-like capabilities require an explicit approval flag", () => {
  assert.equal(resolveModuleCapability("platform_audit", "audit.events.write").code, "approval_required");
  assert.equal(resolveModuleCapability("platform_audit", "audit.events.write", { approved: true }).ok, true);
});

test("registry policy keeps discovery, secrets and production deployment gated", () => {
  assert.equal(MODULE_REGISTRY_POLICY.autoGrant, false);
  assert.equal(MODULE_REGISTRY_POLICY.unknownModuleDefault, "deny");
  assert.equal(MODULE_REGISTRY_POLICY.secretsExposed, false);
  assert.equal(MODULE_REGISTRY_POLICY.productionDeployAutonomy, false);
});

test("registry integrity validates dependencies and the module graph", () => {
  const result = validateModuleRegistry();
  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 0);
  assert.ok(result.moduleCount >= 9);
});

test("integration plan orders shared infrastructure before dependent modules", () => {
  const plan = getModuleIntegrationPlan("social");
  assert.equal(plan.ok, true);
  assert.ok(plan.order.indexOf("platform_auth") < plan.order.indexOf("social"));
  assert.ok(plan.order.indexOf("platform_database") < plan.order.indexOf("social"));
  assert.ok(plan.order.indexOf("platform_audit") < plan.order.indexOf("social"));
  assert.deepEqual(getModuleIntegrationPlan("future_robotics"), { ok: false, code: "module_not_active", order: [] });
  assert.deepEqual(getModuleIntegrationPlan("not_registered"), { ok: false, code: "unknown_module", order: [] });
});

test("module health report marks dependent modules degraded when a dependency is unhealthy", () => {
  const report = buildModuleHealthReport({
    platform_database: { status: "unhealthy", checkedAt: "2026-11-25T12:00:00Z" },
    social: { status: "healthy" }
  });
  const database = report.modules.find(item => item.id === "platform_database");
  const social = report.modules.find(item => item.id === "social");
  assert.equal(database.status, "unhealthy");
  assert.equal(social.status, "degraded");
  assert.ok(social.dependencyFailures.includes("platform_database"));
  assert.equal(report.ok, false);
});

test("health report never promotes planned modules to active or healthy", () => {
  const report = buildModuleHealthReport({
    future_instruments: { status: "healthy" },
    future_robotics: { status: "healthy" }
  });
  assert.equal(report.modules.find(item => item.id === "future_instruments").status, "planned");
  assert.equal(report.modules.find(item => item.id === "future_robotics").status, "planned");
});

test("dangerous capability verbs require approval, not only a write suffix", () => {
  assert.equal(resolveModuleCapability("msh_core", "diagnostics.run").ok, true);
  assert.equal(resolveModuleCapability("platform_audit", "audit.events.write").code, "approval_required");
});
