/**
 * Canonical capability policy for MEHRAN INTELLIGENCE.
 * Only entries marked active are executable by the current scheduled runner.
 * Planned entries describe future gates; they do not grant permissions.
 */
const freezeCapability = (capability) => Object.freeze({
  ...capability,
  inputSchema: Object.freeze({
    type: "object",
    required: Object.freeze([...(capability.inputSchema?.required || [])]),
    properties: Object.freeze({ ...(capability.inputSchema?.properties || {}) }),
    additionalProperties: false
  })
});

export const INTELLIGENCE_CAPABILITIES = Object.freeze({
  project_status_report: freezeCapability({
    id: "project_status_report",
    status: "active",
    permissionTier: "read_only",
    executor: "scheduled_runner",
    requiresApproval: false,
    description: "Read project status and produce a private report.",
    inputSchema: {}
  }),
  social_metrics_report: freezeCapability({
    id: "social_metrics_report",
    status: "active",
    permissionTier: "read_only",
    executor: "scheduled_runner",
    requiresApproval: false,
    description: "Read aggregate SOCIAL metrics and produce a private report.",
    inputSchema: {}
  }),
  service_health_report: freezeCapability({
    id: "service_health_report",
    status: "active",
    permissionTier: "read_only",
    executor: "scheduled_runner",
    requiresApproval: false,
    description: "Read service health signals and produce a private report.",
    inputSchema: {}
  }),
  repository_quality_check: freezeCapability({
    id: "repository_quality_check",
    status: "active",
    permissionTier: "read_only",
    executor: "scheduled_runner",
    requiresApproval: false,
    description: "Inspect repository quality signals without changing files.",
    inputSchema: {}
  }),
  source_security_audit: freezeCapability({
    id: "source_security_audit",
    status: "active",
    permissionTier: "read_only",
    executor: "scheduled_runner",
    requiresApproval: false,
    description: "Perform a static, read-only source security audit.",
    inputSchema: {}
  }),
  inspect_repository: freezeCapability({
    id: "inspect_repository",
    status: "planned",
    permissionTier: "read_only",
    executor: "isolated_inspector",
    requiresApproval: false,
    description: "Inspect an allowlisted repository path and summarize relevant code.",
    inputSchema: {
      required: ["paths"],
      properties: { paths: { type: "array", maxItems: 20, itemType: "string", maxItemLength: 240 } }
    }
  }),
  run_repository_tests: freezeCapability({
    id: "run_repository_tests",
    status: "planned",
    permissionTier: "isolated_ci",
    executor: "github_actions",
    requiresApproval: true,
    description: "Run only the repository's predefined test workflow in an isolated CI job.",
    inputSchema: {
      required: ["baseSha"],
      properties: { baseSha: { type: "string", minLength: 40, maxLength: 40, pattern: "^[a-f0-9]{40}$" } }
    }
  }),
  propose_code_patch: freezeCapability({
    id: "propose_code_patch",
    status: "planned",
    permissionTier: "proposal_only",
    executor: "proposal_store",
    requiresApproval: true,
    description: "Store a bounded, reviewable patch proposal without applying it.",
    inputSchema: {
      required: ["summary", "targetPaths", "diff"],
      properties: {
        summary: { type: "string", minLength: 12, maxLength: 500 },
        targetPaths: { type: "array", maxItems: 10, itemType: "string", maxItemLength: 240 },
        diff: { type: "string", minLength: 20, maxLength: 20000 }
      }
    }
  }),
  create_pull_request: freezeCapability({
    id: "create_pull_request",
    status: "planned",
    permissionTier: "branch_scoped_write",
    executor: "github_actions",
    requiresApproval: true,
    description: "Create a review-only PR from a tested, isolated branch.",
    inputSchema: {
      required: ["branch", "title", "headSha"],
      properties: {
        branch: { type: "string", minLength: 1, maxLength: 120, pattern: "^intelligence/proposal-[a-f0-9-]{8,64}$" },
        title: { type: "string", minLength: 8, maxLength: 160 },
        headSha: { type: "string", minLength: 40, maxLength: 40, pattern: "^[a-f0-9]{40}$" }
      }
    }
  }),
  merge_pull_request: freezeCapability({
    id: "merge_pull_request",
    status: "blocked",
    permissionTier: "human_approval",
    executor: "owner_only",
    requiresApproval: true,
    description: "Merge is never performed autonomously.",
    inputSchema: {}
  }),
  deploy: freezeCapability({
    id: "deploy",
    status: "blocked",
    permissionTier: "human_approval",
    executor: "owner_only",
    requiresApproval: true,
    description: "Production deployment requires explicit owner approval.",
    inputSchema: {}
  }),
  read_secrets: freezeCapability({
    id: "read_secrets",
    status: "blocked",
    permissionTier: "forbidden",
    executor: "none",
    requiresApproval: true,
    description: "Secrets are never exposed to the agent.",
    inputSchema: {}
  }),
  wallet_operations: freezeCapability({
    id: "wallet_operations",
    status: "blocked",
    permissionTier: "forbidden",
    executor: "none",
    requiresApproval: true,
    description: "The agent cannot access wallets, keys, or move assets.",
    inputSchema: {}
  }),
  arbitrary_shell: freezeCapability({
    id: "arbitrary_shell",
    status: "blocked",
    permissionTier: "forbidden",
    executor: "none",
    requiresApproval: true,
    description: "Arbitrary shell or command execution is forbidden.",
    inputSchema: {}
  })
});

export const INTELLIGENCE_ACTION_TYPES = Object.freeze(
  Object.values(INTELLIGENCE_CAPABILITIES)
    .filter((item) => item.status === "active" && item.executor === "scheduled_runner" && item.permissionTier === "read_only")
    .map((item) => item.id)
);

export const PREAPPROVED_INTELLIGENCE_ACTION_TYPES = Object.freeze(
  Object.values(INTELLIGENCE_CAPABILITIES)
    .filter((item) => item.status === "active" && item.requiresApproval === false && item.permissionTier === "read_only")
    .map((item) => item.id)
);

export function getIntelligenceCapability(capabilityId) {
  return typeof capabilityId === "string" ? INTELLIGENCE_CAPABILITIES[capabilityId] || null : null;
}

function validateValue(value, rule) {
  if (!rule || typeof rule !== "object") return false;
  if (rule.type === "string") {
    return typeof value === "string"
      && (rule.minLength === undefined || value.length >= rule.minLength)
      && (rule.maxLength === undefined || value.length <= rule.maxLength)
      && (rule.pattern === undefined || new RegExp(rule.pattern).test(value))
      && (rule.enum === undefined || rule.enum.includes(value));
  }
  if (rule.type === "array") {
    return Array.isArray(value)
      && value.length <= (rule.maxItems ?? 100)
      && value.every((entry) => validateValue(entry, {
        type: rule.itemType || "string",
        maxLength: rule.maxItemLength
      }));
  }
  return false;
}

export function validateIntelligenceCapabilityRequest(capabilityId, input) {
  const capability = getIntelligenceCapability(capabilityId);
  if (!capability) return { ok: false, code: "unknown_capability" };
  if (capability.status !== "active" || capability.executor !== "scheduled_runner") {
    return { ok: false, code: capability.status === "blocked" ? "capability_blocked" : "capability_not_implemented" };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "invalid_input" };
  }
  const schema = capability.inputSchema;
  const keys = Object.keys(input);
  if (keys.some((key) => !Object.hasOwn(schema.properties, key))) {
    return { ok: false, code: "unknown_input_field" };
  }
  if (schema.required.some((key) => !Object.hasOwn(input, key))) {
    return { ok: false, code: "missing_required_field" };
  }
  for (const [key, value] of Object.entries(input)) {
    if (!validateValue(value, schema.properties[key])) return { ok: false, code: "invalid_input_value" };
  }
  return { ok: true, capability };
}
