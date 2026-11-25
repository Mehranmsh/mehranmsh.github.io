# MEHRAN INTELLIGENCE Cognitive Architecture

Status: design baseline for owner review. This document distinguishes verified foundations from proposed capabilities. It does not claim that the complete cognitive system is implemented or active.

## 1. Product objective

MEHRAN INTELLIGENCE is the private, owner-directed cognitive and execution system for MEHRAN MSH. It is not a public chatbot, a status dashboard, or merely a report generator. Its long-term job is to understand goals, preserve project continuity, reason over evidence, plan and coordinate bounded work across MSH modules, verify outcomes, learn from approved experience, and return a reliable synthesis.

The system should grow by adding independently testable capabilities, not by granting one model unrestricted access.

## 2. Verified current foundations

The current source already contains useful building blocks:

- D1 tables `intelligence_memory_items` and `intelligence_chat_turns`, created by `ensureIntelligenceMemoryTables` in `worker.js`.
- Owner-scoped memory rows with a stable `memory_key`, category, content, importance, source, and timestamps. Baseline owner memory is seeded by `seedIntelligenceOwnerMemory`.
- Chat history is stored by `appendIntelligenceChatTurn` and bounded to the latest 100 turns per owner/session.
- The mission planner loads up to 12 durable memory rows, clips each content item, and passes them into a model-backed planning request. This is a small retrieval policy, not semantic search or a complete memory system.
- `scripts/intelligence-routine-planner.mjs` provides deterministic routing for recognized routine tasks and intentionally avoids inference for simple checks.
- Work packages, dependency-aware task eligibility, claims, leases, checkpoints, retries, result validation, private reporting, and bounded repository inspection are present in the current implementation branch.
- `scripts/intelligence-verification-loop.mjs` provides a bounded verify/repair/checkpoint loop with at most three attempts. It is a primitive for controlled verification, not recursive self-modification or general autonomous learning.
- The multi-provider AI router and quota controls exist for the currently wired planning and semantic-analysis paths. They do not mean every module or every task is model-enabled.

Important limitations:

- The current memory model is a compact key/value store plus bounded chat transcript history. It lacks first-class episodic, semantic, procedural, and decision records; provenance graph; confidence and contradiction tracking; lifecycle/retention controls; and owner-facing correction/deletion workflows.
- Planner context currently uses a fixed small memory selection. It is not a general retrieval, ranking, or context-budget subsystem.
- The planner produces a bounded work package from one model request. It is not yet a persistent multi-step reasoning loop with explicit plan revisions, observations, delegated specialist agents, and independent synthesis.
- The task runtime is a foundation for orchestration, but specialist agents and cross-agent review are not yet a complete operational system.
- A declared module or capability is not proof of a working adapter, live health probe, or permission to access module data.

## 3. Target architecture

### A. Cognitive Core

The Cognitive Core should be a sequence of explicit, inspectable stages:

1. **Intent and constraint extraction**: convert the owner request into a goal, success conditions, scope, exclusions, risk class, deadline/priority, and approval requirements.
2. **Context assembly**: retrieve only relevant owner-confirmed memory, project state, previous task outcomes, module manifests, and current evidence. Attach provenance to every retrieved fact.
3. **Reasoning and hypothesis formation**: identify unknowns, competing explanations, assumptions, dependencies, and confidence. Separate facts from hypotheses.
4. **Planning**: create a typed task DAG with stable IDs, prerequisites, executor requirements, budgets, timeout/retry policy, and acceptance tests.
5. **Execution observation**: consume structured executor events and artifacts. Treat tool output and repository text as untrusted data, never as policy.
6. **Plan revision**: revise only tasks still inside the owner's authorized scope. A material scope/risk/permission change pauses for approval.
7. **Independent verification**: evaluate outputs against acceptance criteria using deterministic checks wherever possible; use a separate reviewer for high-impact reasoning.
8. **Synthesis and learning proposal**: produce an evidence-linked result, record approved lessons, and propose improvements without self-granting capabilities.

Each stage should produce a versioned JSON object with schema validation, correlation IDs, bounded size, timestamps, and traceable evidence references. Model-generated text must never be passed directly to privileged executors.

### B. Persistent Memory

Use distinct memory classes, not one undifferentiated text bucket:

| Memory class | Purpose | Example |
|---|---|---|
| Episodic | What happened in a mission or execution | task, result, retries, decision, evidence |
| Semantic | Stable facts about MSH and its modules | module purpose, integration contracts |
| Procedural | Approved ways to perform recurring work | tested runbook, fixed workflow |
| Decision | Owner decisions, constraints, superseded choices | Pi-only platform constraint |
| Working | Short-lived context for an active mission | current plan, open questions |
| Evaluation | Test outcomes and known failure patterns | regression benchmark result |

Proposed records should include: `id`, `owner_uid`, `memory_type`, `namespace/module_id`, `subject_key`, `content`, `source_type`, `source_ref`, `source_hash`, `confidence`, `importance`, `created_at`, `observed_at`, `valid_from`, `valid_until`, `supersedes_id`, `status`, and `retention_class`.

Design rules:

- Preserve provenance: every fact points to an owner statement, approved decision, task event, or verified source artifact.
- Distinguish owner-confirmed facts from model inferences and external observations.
- Never silently overwrite conflicting decisions. Mark old records superseded and retain a minimal audit trail.
- Retrieve by owner, module, type, recency, importance, confidence, and relevance; enforce a strict context token/character budget.
- Store compact summaries separately from source artifacts. Do not copy private SOCIAL messages, individual user records, credentials, wallet information, or unrelated personal data into project memory.
- Provide owner-controlled inspect, correct, supersede, export, and delete operations. Deletion must cover derived summaries and retrieval indexes, subject to a transparent audit policy.
- Apply retention and expiry to working memory and raw transcripts. Do not make all chat history permanent by default.
- Any external AI provider receives only the minimum redacted context needed for that inference, subject to the configured provider allowlist and budget.

### C. Autonomous Orchestrator

The orchestrator should be a durable state machine over a directed acyclic graph (DAG):

`goal -> plan -> queued tasks -> claimed tasks -> observations -> verification -> completed/blocked/awaiting_approval`

Required behaviors:

- Stable goal, package, task, attempt, and correlation IDs.
- Dependency validation and topological scheduling.
- Per-capability concurrency limits and fair scheduling.
- Atomic claims with lease expiry and fencing tokens.
- Idempotency keys for every operation that may be retried.
- Checkpoints after meaningful transitions, not just at task completion.
- Bounded exponential backoff for transient errors; deterministic errors stop quickly.
- Dead-letter and operator-review paths for repeated failures.
- Independent acceptance verification before a task or package becomes completed.
- Continue independent tasks when one branch is blocked.
- Persist the final evidence bundle and a concise owner report.
- Resume after Worker/runner restarts without duplicating side effects.

The model proposes task graphs. A deterministic policy engine validates them. Only the validated graph enters the queue.

### D. Specialist agents

Use narrow specialists, each with a fixed role, context schema, and capability set:

- **Architect**: module boundaries, dependency maps, design trade-offs.
- **Builder**: prepares bounded code/test proposals within a path allowlist.
- **Security reviewer**: checks threat models, data scopes, authorization, and policy compliance.
- **Test engineer**: chooses only registered test suites and interprets machine-readable results.
- **Module specialist**: understands one module's contracts and receives only its approved aggregate/project context.
- **Synthesizer**: reconciles evidence and reviewer disagreements into the final report.

No specialist receives the union of all permissions. Cross-review should compare claims and evidence, not merely ask two models the same question. The synthesizer cannot override a deterministic failure or an owner approval gate.

### E. Evaluation and controlled improvement

Maintain a versioned benchmark suite covering:

- Correct extraction of owner intent and constraints.
- Correct use of existing memory without stale decisions.
- Detection of contradictory or unsupported claims.
- Valid dependency graphs and executor/capability selection.
- Security refusal tests for secrets, private SOCIAL data, wallet actions, and unauthorized deployment.
- Recovery tests for duplicate delivery, lease expiry, transient failure, and restart.
- Module-specific integration and regression checks.
- Cost, latency, quota consumption, and context-size limits.

A proposed improvement must pass deterministic tests, semantic evaluation, security review, and regression checks on an isolated branch. Promotion to production remains owner-controlled. No model may rewrite its own policy, add capabilities, change secrets, or deploy itself.

## 4. Module integration contract

All module work goes through the central capability gateway and registry. Each adapter declares its module ID, capability ID, data scope, input/output schema, risk tier, executor, and audit event. Default is deny.

| Module | Initial permitted intelligence scope | Explicit exclusions |
|---|---|---|
| MSH Core | project/service metadata and aggregate diagnostics | secrets, owner credentials, unrestricted admin actions |
| SOCIAL | aggregate counts and service health | private messages, private profiles, individual user records |
| Music / Studio | catalog metadata and explicit project-transfer status | browser localStorage/IndexedDB inspection without user action |
| MEHRAN AI | provider presence, aggregate quota, registered test status | secret values, unrestricted inference, unbudgeted calls |
| Instruments | future catalog/order metadata only after adapter review | purchases, payments, supplier commitments |
| Robotics | future simulator/telemetry summaries after safety review | physical actuation, safety-critical control, autonomous real-world movement |

The registry is descriptive until the adapter is implemented, tested, and granted an explicit capability. A module's presence in the registry never grants data access.

## 5. Security and governance plane

- Separate owner identity, orchestrator identity, runner identity, and module adapter identities.
- Capability tokens are short-lived, scoped to one task, one module, one executor, and one operation.
- Model context and tool output are untrusted. Prompt injection cannot alter the capability registry or approval policy.
- Enforce schema validation, payload limits, rate limits, budget reservations, replay protection, audit logs, and revocation.
- Keep secrets outside prompts, source, D1 task payloads, artifacts, and ordinary logs.
- Never expose wallet keys/assets or perform financial operations.
- Never read private SOCIAL messages or export individual user data for general project reasoning.
- Require exact owner approval for merges, deployments, security-policy changes, credential changes, data deletion/export, payments, permission changes, and physical robotics actions.
- Approval is bound to exact diff/action, target, risk summary, and expiry. A changed diff invalidates approval.
- Use feature flags for new memory writers, model paths, and autonomous capabilities. Default them off until acceptance tests pass.

## 6. Delivery roadmap

### Phase 0: Establish the baseline
- Inventory existing memory tables, planner, task state machine, adapters, quota router, and report path.
- Add architecture and threat-model documentation.
- Add tests that distinguish implemented, declared-only, and absent features.

Exit criteria: a reproducible capability matrix and passing baseline regression suite.

### Phase 1: Memory v2
- Add typed, provenance-bearing memory records and decision supersession.
- Add deterministic retrieval and context budgeting.
- Add owner-only inspect/correct/delete endpoints with audit and retention behavior.
- Migrate current key/value memories without losing owner-confirmed constraints; preserve existing reads until parity is proven.

Exit criteria: migration tests, tenant-isolation tests, provenance coverage, stale-decision tests, deletion tests, and zero regressions in current planner behavior.

### Phase 2: Cognitive Core v1
- Extract intent, constraints, assumptions, and acceptance criteria into a strict schema.
- Build evidence-aware context assembly from Memory v2 and registered module adapters.
- Generate typed plans with confidence, unknowns, risk, budget, and dependencies.
- Validate every plan deterministically before queue insertion.

Exit criteria: benchmark suite demonstrates correct schemas, no capability escalation, evidence references for factual claims, and predictable quota limits.

### Phase 3: Orchestrator v2
- Strengthen DAG scheduling, concurrency, leases, fencing, checkpoint recovery, and package finalization.
- Add event-driven resumption and durable consolidated reports.
- Add task-level cancellation and owner-visible approval requests.

Exit criteria: injected duplicate, crash, lease-expiry, retry, and blocked-dependency tests pass without duplicate side effects.

### Phase 4: Specialist agents and cross-review
- Add role-scoped specialist prompts and capability manifests.
- Add independent security and acceptance reviewers.
- Add disagreement resolution and evidence-linked synthesis.

Exit criteria: cross-review catches seeded defects and cannot bypass executor policy.

### Phase 5: Controlled learning and module expansion
- Store verified lessons as proposed memory updates; owner-confirm or deterministic policy approves their class.
- Run periodic regression/evaluation tasks within a strict AI budget.
- Add module adapters one at a time, beginning with read-only metadata.

Exit criteria: measurable benchmark improvement without increased policy violations, data exposure, or uncontrolled cost.

## 7. Immediate engineering priorities

1. Add tests around current memory retrieval and ownership isolation before changing its schema.
2. Define the Memory v2 record and migration contract without touching production D1.
3. Extract a pure, deterministic context-ranking/budget helper and test recency, importance, source trust, supersession, and token/character ceilings.
4. Define typed Cognitive Core schemas for intent, evidence, plan, observation, and synthesis.
5. Connect the schemas to the existing task queue only after validation and regression tests.
6. Keep semantic analysis and all other inference paths explicitly budgeted; routine checks must remain deterministic and free of model calls.

## 8. Non-goals

This architecture does not promise human-level general intelligence, unrestricted self-modification, unlimited free inference, automatic production deployment, or autonomous control of financial assets or physical robots. "Superintelligence" is the product ambition; implementation progress is measured by verified capabilities, reliability, and safe autonomy.
