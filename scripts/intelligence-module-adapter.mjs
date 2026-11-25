import { resolveModuleCapability, getRegisteredModule } from "./intelligence-module-registry.mjs";

const MAX_INPUT_BYTES = 4096;
const MAX_RESULT_BYTES = 8192;
const WRITE_VERBS = /(?:^|[._-])(write|create|update|delete|execute|publish|send|deploy|admin)(?:$|[._-])/;

function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeJsonSize(value, maxBytes) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && new TextEncoder().encode(serialized).byteLength <= maxBytes;
  } catch {
    return false;
  }
}

function hasForbiddenKey(value, depth = 0) {
  if (depth > 5 || value === null || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:secret|password|private.?key|recovery.?phrase|wallet.?seed|authorization|cookie|private.?message)/i.test(key)) return true;
    if (hasForbiddenKey(child, depth + 1)) return true;
  }
  return false;
}

/**
 * Build a module adapter from explicit handlers. Handlers receive only bounded
 * request data and a minimal context, never Worker env, DB bindings, or secrets.
 */
export function createModuleAdapter({ moduleId, handlers, audit } = {}) {
  const module = getRegisteredModule(moduleId);
  if (!module || module.status !== "active") throw new Error("module_not_active");
  if (!plainRecord(handlers)) throw new TypeError("handlers_must_be_plain_object");
  if (audit !== undefined && typeof audit !== "function") throw new TypeError("audit_must_be_function");

  const safeHandlers = Object.create(null);
  for (const [capability, handler] of Object.entries(handlers)) {
    if (!module.capabilities.includes(capability)) throw new Error("capability_not_granted");
    if (typeof handler !== "function") throw new TypeError("handler_must_be_function");
    safeHandlers[capability] = handler;
  }
  return Object.freeze({
    moduleId,
    version: module.version,
    capabilities: Object.freeze(Object.keys(safeHandlers)),
    handlers: Object.freeze(safeHandlers),
    audit: audit || null
  });
}

/** Dispatch only registered capabilities with bounded, non-sensitive inputs. */
export async function dispatchModuleCapability({ adapter, capability, input = {}, context = {} } = {}) {
  if (!adapter || typeof adapter !== "object" || typeof adapter.moduleId !== "string") {
    return { ok: false, code: "invalid_adapter" };
  }
  const module = getRegisteredModule(adapter.moduleId);
  if (!module || module.status !== "active") return { ok: false, code: "module_not_active" };
  if (!Object.hasOwn(adapter.handlers || {}, capability)) return { ok: false, code: "handler_not_implemented" };
  if (!plainRecord(input) || !safeJsonSize(input, MAX_INPUT_BYTES) || hasForbiddenKey(input)) {
    return { ok: false, code: "input_rejected" };
  }
  const approved = context?.approved === true;
  const permission = resolveModuleCapability(adapter.moduleId, capability, { approved });
  if (!permission.ok) return permission;

  const isWrite = WRITE_VERBS.test(capability);
  if (isWrite && (typeof context.approvalId !== "string" || context.approvalId.length < 8 || !adapter.audit)) {
    return { ok: false, code: "audited_approval_required" };
  }

  const safeContext = Object.freeze({
    requestId: typeof context.requestId === "string" ? context.requestId.slice(0, 80) : "",
    actorType: context.actorType === "owner" ? "owner" : "system",
    approved,
    approvalId: isWrite ? context.approvalId.slice(0, 80) : null,
    dataScopes: Object.freeze([...permission.dataScopes])
  });

  try {
    if (isWrite) {
      await adapter.audit(Object.freeze({
        phase: "before",
        moduleId: adapter.moduleId,
        capability,
        requestId: safeContext.requestId,
        approvalId: safeContext.approvalId
      }));
    }
    const result = await adapter.handlers[capability](Object.freeze({ ...input }), safeContext);
    if (!safeJsonSize(result, MAX_RESULT_BYTES) || hasForbiddenKey(result)) {
      return { ok: false, code: "result_rejected" };
    }
    if (isWrite) {
      await adapter.audit(Object.freeze({
        phase: "after",
        moduleId: adapter.moduleId,
        capability,
        requestId: safeContext.requestId,
        approvalId: safeContext.approvalId
      }));
    }
    return { ok: true, moduleId: adapter.moduleId, capability, result };
  } catch {
    return { ok: false, code: isWrite ? "action_failed_audit_required" : "handler_failed" };
  }
}

export const MODULE_ADAPTER_POLICY = Object.freeze({
  maxInputBytes: MAX_INPUT_BYTES,
  maxResultBytes: MAX_RESULT_BYTES,
  receivesWorkerEnvironment: false,
  receivesDatabaseBinding: false,
  receivesSecrets: false,
  requiresApprovalAndAuditForWrites: true,
  unknownCapabilityDefault: "deny"
});
