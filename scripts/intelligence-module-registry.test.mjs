import test from "node:test";
import assert from "node:assert/strict";
import {
  listRegisteredModules, getRegisteredModule, discoverModuleManifest,
  resolveModuleCapability, MODULE_REGISTRY_POLICY
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
