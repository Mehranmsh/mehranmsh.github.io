/**
 * MEHRAN MSH central module registry.
 *
 * Every present and future module integrates through this contract. Unknown
 * modules may be discovered and recorded as pending, but never receive
 * capabilities or data access until their manifest is validated and approved.
 */
const freeze = (value) => Object.freeze(value);

const MODULES = [
  {
    id: "msh_core", name: "MEHRAN MSH Core", version: "1",
    status: "active", trust: "first_party",
    dependencies: ["platform_auth", "platform_database", "platform_audit"],
    capabilities: ["health.read", "projects.read", "services.read", "diagnostics.run"],
    dataScopes: ["core:aggregate", "projects:metadata"],
    healthcheck: { kind: "worker_route", route: "/health" }
  },
  {
    id: "studio_music", name: "MEHRAN Studio / Music", version: "1",
    status: "active", trust: "first_party",
    dependencies: ["platform_auth", "platform_database", "platform_audit"],
    capabilities: ["studio.health.read", "studio.catalog.read", "studio.tests.run"],
    dataScopes: ["studio:aggregate", "music:catalog"],
    healthcheck: { kind: "repository_test", commandId: "music_studio_tests" }
  },
  {
    id: "social", name: "SOCIAL", version: "1",
    status: "active", trust: "first_party",
    dependencies: ["platform_auth", "platform_database", "platform_audit"],
    capabilities: ["social.health.read", "social.metrics.read", "social.tests.run"],
    dataScopes: ["social:aggregate"],
    healthcheck: { kind: "worker_route", route: "/health" }
  },
  {
    id: "mehran_ai", name: "MEHRAN AI", version: "1",
    status: "active", trust: "first_party",
    dependencies: ["platform_auth", "platform_audit"],
    capabilities: ["ai.health.read", "ai.quota.read", "ai.tests.run"],
    dataScopes: ["ai:service-metadata"],
    healthcheck: { kind: "worker_route", route: "/health" }
  },
  {
    id: "platform_auth", name: "Shared Authentication", version: "1",
    status: "active", trust: "platform",
    dependencies: [],
    capabilities: ["auth.health.read", "auth.audit.read"],
    dataScopes: ["auth:aggregate"],
    healthcheck: { kind: "worker_route", route: "/health" }
  },
  {
    id: "platform_database", name: "Shared Database", version: "1",
    status: "active", trust: "platform",
    dependencies: [],
    capabilities: ["database.health.read", "database.schema.inspect"],
    dataScopes: ["database:schema-metadata", "database:aggregate"],
    healthcheck: { kind: "worker_route", route: "/health" }
  },
  {
    id: "platform_audit", name: "Audit and Observability", version: "1",
    status: "active", trust: "platform",
    dependencies: [],
    capabilities: ["audit.events.write", "audit.events.read"],
    dataScopes: ["audit:operational"],
    healthcheck: { kind: "internal_contract", contractId: "audit_event_v1" }
  },
  {
    id: "future_instruments", name: "MEHRAN Instruments", version: "planned",
    status: "planned", trust: "untrusted",
    dependencies: ["platform_auth", "platform_database", "platform_audit"],
    capabilities: [], dataScopes: [],
    healthcheck: null
  },
  {
    id: "future_robotics", name: "MEHRAN Robotics", version: "planned",
    status: "planned", trust: "untrusted",
    dependencies: ["platform_auth", "platform_audit"],
    capabilities: [], dataScopes: [],
    healthcheck: null
  }
];

const FORBIDDEN_SCOPE_PARTS = /secret|credential|password|private[-_: ]?message|wallet|private[-_: ]?key|token[-_: ]?value/i;
const SAFE_CAPABILITY = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SAFE_SCOPE = /^[a-z][a-z0-9]*(?::[a-z][a-z0-9-]*)$/;

function normalizeManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, code: "invalid_manifest" };
  const { id, name, version, dependencies = [], capabilities = [], dataScopes = [], healthcheck = null } = input;
  if (typeof id !== "string" || !/^[a-z][a-z0-9_]{2,47}$/.test(id)) return { ok: false, code: "invalid_module_id" };
  if (typeof name !== "string" || name.trim().length < 2 || name.length > 80) return { ok: false, code: "invalid_module_name" };
  if (typeof version !== "string" || !/^[0-9]+(?:\.[0-9]+){0,2}$/.test(version)) return { ok: false, code: "invalid_module_version" };
  if (!Array.isArray(dependencies) || dependencies.length > 12 || dependencies.some(x => typeof x !== "string" || !/^[a-z][a-z0-9_]{2,47}$/.test(x))) return { ok: false, code: "invalid_dependencies" };
  if (!Array.isArray(capabilities) || capabilities.length > 30 || capabilities.some(x => typeof x !== "string" || !SAFE_CAPABILITY.test(x))) return { ok: false, code: "invalid_capabilities" };
  if (!Array.isArray(dataScopes) || dataScopes.length > 20 || dataScopes.some(x => typeof x !== "string" || !SAFE_SCOPE.test(x) || FORBIDDEN_SCOPE_PARTS.test(x))) return { ok: false, code: "invalid_or_forbidden_scope" };
  if (new Set(dependencies).size !== dependencies.length || new Set(capabilities).size !== capabilities.length || new Set(dataScopes).size !== dataScopes.length) return { ok: false, code: "duplicate_manifest_entry" };
  if (healthcheck !== null && (!healthcheck || typeof healthcheck !== "object" || Array.isArray(healthcheck) ||
      !["worker_route", "repository_test", "internal_contract"].includes(healthcheck.kind))) return { ok: false, code: "invalid_healthcheck" };
  return { ok: true, manifest: freeze({
    id, name: name.trim(), version, status: "pending", trust: "untrusted",
    dependencies: freeze([...dependencies]), capabilities: freeze([...capabilities]),
    dataScopes: freeze([...dataScopes]), healthcheck: healthcheck ? freeze({ ...healthcheck }) : null
  }) };
}

export function listRegisteredModules({ includePlanned = true } = {}) {
  return MODULES.filter(module => includePlanned || module.status !== "planned").map(module => ({
    ...module,
    dependencies: [...module.dependencies],
    capabilities: [...module.capabilities],
    dataScopes: [...module.dataScopes],
    healthcheck: module.healthcheck ? { ...module.healthcheck } : null
  }));
}

export function getRegisteredModule(moduleId) {
  const found = MODULES.find(module => module.id === moduleId);
  return found ? {
    ...found, dependencies: [...found.dependencies],
    capabilities: [...found.capabilities], dataScopes: [...found.dataScopes],
    healthcheck: found.healthcheck ? { ...found.healthcheck } : null
  } : null;
}

/** Discover a future module as pending only; discovery never grants access. */
export function discoverModuleManifest(input) {
  const normalized = normalizeManifest(input);
  if (!normalized.ok) return normalized;
  if (MODULES.some(module => module.id === normalized.manifest.id)) return { ok: false, code: "module_id_already_registered" };
  const knownIds = new Set(MODULES.map(module => module.id));
  const missingDependencies = normalized.manifest.dependencies.filter(id => !knownIds.has(id));
  return {
    ok: true,
    status: "pending",
    trusted: false,
    enabledCapabilities: [],
    enabledDataScopes: [],
    missingDependencies,
    manifest: normalized.manifest
  };
}

/** Resolve only capabilities already granted by an active, trusted manifest. */
export function resolveModuleCapability(moduleId, capability, { approved = false } = {}) {
  const module = MODULES.find(item => item.id === moduleId);
  if (!module) return { ok: false, code: "unknown_module" };
  if (module.status !== "active" || !["first_party", "platform"].includes(module.trust)) return { ok: false, code: "module_not_trusted" };
  if (!module.capabilities.includes(capability)) return { ok: false, code: "capability_not_granted" };
  if (capability.endsWith(".write") && !approved) return { ok: false, code: "approval_required" };
  return { ok: true, moduleId, capability, dataScopes: [...module.dataScopes] };
}

export const MODULE_REGISTRY_POLICY = freeze({
  version: 1,
  autoDiscovery: "pending_only",
  autoGrant: false,
  unknownModuleDefault: "deny",
  secretsExposed: false,
  privateUserContentExposed: false,
  productionDeployAutonomy: false,
  requireAuditForWrites: true
});
