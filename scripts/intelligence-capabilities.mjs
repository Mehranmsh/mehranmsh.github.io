/**
 * Canonical capability policy for MEHRAN INTELLIGENCE.
 * Executor metadata mirrors the real Worker and GitHub Actions claim paths.
 * Planned entries describe future gates; they do not grant permissions.
 */
function cloneAndFreezeSchemaValue(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreezeSchemaValue));
  }
  if (value && typeof value === "object") {
    const copy = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneAndFreezeSchemaValue(entry)])
    );
    return Object.freeze(copy);
  }
  return value;
}

const freezeCapability = (capability) => Object.freeze({
  ...capability,
  executors: Object.freeze([...(capability.executors || [])]),
  inputSchema: cloneAndFreezeSchemaValue({
    type: "object",
    required: [...(capability.inputSchema?.required || [])],
    properties: { ...(capability.inputSchema?.properties || {}) },
    additionalProperties: false
  })
});

export const INTELLIGENCE_CAPABILITIES = Object.freeze({
  project_status_report: freezeCapability({
    id: "project_status_report",
    status: "active",
    permissionTier: "read_only",
    executors: ["cloudflare_worker_scheduler"],
    requiresApproval: false,
    description: "Read project status and produce a private report through the Cloudflare Worker scheduler.",
    inputSchema: {}
  }),
  social_metrics_report: freezeCapability({
    id: "social_metrics_report",
    status: "active",
    permissionTier: "read_only",
    executors: ["cloudflare_worker_scheduler"],
    requiresApproval: false,
    description: "Read aggregate SOCIAL metrics and produce a private report through the Cloudflare Worker scheduler.",
    inputSchema: {}
  }),
  service_health_report: freezeCapability({
    id: "service_health_report",
    status: "active",
    permissionTier: "read_only",
    executors: ["cloudflare_worker_scheduler", "github_actions_runner"],
    requiresApproval: false,
    description: "Read service health signals through the Worker scheduler or the GitHub Actions package runner.",
    inputSchema: {}
  }),
  repository_quality_check: freezeCapability({
    id: "repository_quality_check",
    status: "active",
    permissionTier: "read_only",
    executors: ["cloudflare_worker_scheduler", "github_actions_runner"],
    requiresApproval: false,
    description: "Inspect fixed-repository metadata without changing files, through the Worker scheduler or GitHub Actions package runner.",
    inputSchema: {}
  }),
  source_security_audit: freezeCapability({
    id: "source_security_audit",
    status: "active",
    permissionTier: "read_only",
    executors: ["github_actions_runner"],
    requiresApproval: false,
    description: "Perform a static, read-only source security audit through the GitHub Actions package runner.",
    inputSchema: {}
  }),
  inspect_repository: freezeCapability({
    id: "inspect_repository",
    status: "active",
    permissionTier: "read_only",
    executors: ["github_actions_runner"],
    requiresApproval: false,
    autonomous: true,
    description: "Inventory exact allowlisted source files from one immutable commit without executing repository content or writing files.",
    inputSchema: {
      required: ["paths"],
      properties: {
        paths: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          itemType: "string",
          maxItemLength: 240,
          uniqueItems: true,
          itemEnum: [
            "worker.js",
            "scripts/intelligence-agent.mjs",
            "scripts/intelligence-capabilities.mjs",
            "scripts/intelligence-capabilities.test.mjs",
            ".github/workflows/mehran-intelligence-runner.yml",
            "docs/INTELLIGENCE_EXECUTION_PROTOCOL.md"
          ]
        }
      }
    }
  }),
  run_repository_tests: freezeCapability({
    id: "run_repository_tests",
    status: "active",
    permissionTier: "isolated_ci",
    executors: ["github_actions_runner"],
    requiresApproval: false,
    autonomous: true,
    description: "Run only the repository's predefined test workflow in isolated CI; pre-authorized within the fixed workflow and repository scope.",
    inputSchema: {
      required: ["baseSha"],
      properties: { baseSha: { type: "string", minLength: 40, maxLength: 40, pattern: "^[a-f0-9]{40}$" } }
    }
  }),
  propose_code_patch: freezeCapability({
    id: "propose_code_patch",
    status: "active",
    permissionTier: "proposal_only",
    executors: ["github_actions_runner"],
    requiresApproval: false,
    autonomous: true,
    description: "Generate and store one bounded append-only regression-test proposal in private storage; never apply it or create a branch or pull request.",
    inputSchema: {
      required: ["objective"],
      properties: {
        objective: { type: "string", minLength: 12, maxLength: 800 }
      }
    }
  }),
  create_pull_request: freezeCapability({
    id: "create_pull_request",
    status: "active",
    permissionTier: "branch_scoped_write",
    executionMode: "verified_proposal_outbox",
    executors: ["github_actions_runner"],
    requiresApproval: false,
    autonomous: true,
    description: "Create a draft review PR only from a verified private proposal after append-only validation and isolated tests; never merge or deploy.",
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
    executors: [],
    requiresApproval: true,
    description: "Merge is never performed autonomously.",
    inputSchema: {}
  }),
  deploy: freezeCapability({
    id: "deploy",
    status: "blocked",
    permissionTier: "human_approval",
    executors: [],
    requiresApproval: true,
    description: "Production deployment requires explicit owner approval.",
    inputSchema: {}
  }),
  read_secrets: freezeCapability({
    id: "read_secrets",
    status: "blocked",
    permissionTier: "forbidden",
    executors: [],
    requiresApproval: true,
    description: "Secrets are never exposed to the agent.",
    inputSchema: {}
  }),
  wallet_operations: freezeCapability({
    id: "wallet_operations",
    status: "blocked",
    permissionTier: "forbidden",
    executors: [],
    requiresApproval: true,
    description: "The agent cannot access wallets, keys, or move assets.",
    inputSchema: {}
  }),
  arbitrary_shell: freezeCapability({
    id: "arbitrary_shell",
    status: "blocked",
    permissionTier: "forbidden",
    executors: [],
    requiresApproval: true,
    description: "Arbitrary shell or command execution is forbidden.",
    inputSchema: {}
  })
});

export const INTELLIGENCE_ACTION_TYPES = Object.freeze(
  Object.values(INTELLIGENCE_CAPABILITIES)
    .filter((item) => item.status === "active" && ["read_only", "isolated_ci", "proposal_only"].includes(item.permissionTier) && item.executors.length > 0)
    .map((item) => item.id)
);

export const PREAPPROVED_INTELLIGENCE_ACTION_TYPES = Object.freeze(
  Object.values(INTELLIGENCE_CAPABILITIES)
    .filter((item) => item.status === "active" && item.requiresApproval === false && ["read_only", "isolated_ci", "proposal_only"].includes(item.permissionTier))
    .map((item) => item.id)
);

export function getIntelligenceCapability(capabilityId) {
  return typeof capabilityId === "string" && Object.hasOwn(INTELLIGENCE_CAPABILITIES, capabilityId)
    ? INTELLIGENCE_CAPABILITIES[capabilityId]
    : null;
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
      && value.length >= (rule.minItems ?? 0)
      && (!rule.uniqueItems || new Set(value).size === value.length)
      && value.every((entry) => validateValue(entry, {
        type: rule.itemType || "string",
        maxLength: rule.maxItemLength,
        enum: rule.itemEnum
      }));
  }
  return false;
}

export function validateIntelligenceCapabilityRequest(capabilityId, input) {
  const capability = getIntelligenceCapability(capabilityId);
  if (!capability) return { ok: false, code: "unknown_capability" };
  const supportedPermissionTier = ["read_only", "isolated_ci", "proposal_only"].includes(capability.permissionTier)
    || (capabilityId === "create_pull_request" && capability.permissionTier === "branch_scoped_write");
  if (capability.status !== "active" || !supportedPermissionTier || capability.executors.length === 0) {
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
