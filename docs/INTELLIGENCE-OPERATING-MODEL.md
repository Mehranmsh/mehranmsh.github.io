# MEHRAN INTELLIGENCE operating model

## Purpose

MEHRAN INTELLIGENCE is the private coordination and decision-support layer for MEHRAN MSH. It organizes company knowledge, turns owner-approved goals into bounded plans, tracks project state, and prepares recommendations for the owner. It is not an autonomous company operator and does not gain authority over wallets, Pi assets, production systems, user accounts, or external services.

## Operating principles

1. **Owner authority:** the owner is the final authority for priorities, approvals, access, and irreversible actions.
2. **Evidence before confidence:** every material knowledge item records its origin and observation context. A confidence score is an assessment label, never proof.
3. **Separate facts, hypotheses, and decisions:** do not merge an unverified claim into an established fact or treat a recommendation as an approval.
4. **Least privilege:** each module receives only the minimum data and actions needed for its assigned work.
5. **Staging before production:** new workflows are tested with isolated data and credentials. Production changes require a separate review and explicit authorization.
6. **Human-readable audit:** sensitive changes record who initiated them, what changed, when, and the outcome. Secrets and raw access tokens must never enter logs or knowledge records.
7. **Fail closed:** missing identity, unclear scope, expired approval, failed validation, or unavailable dependencies stop the operation.

## Core record types

| Record | Purpose | Required safeguards |
|---|---|---|
| Knowledge | A source-backed statement, document note, or observation | Owner scope, provenance, review status, archive lifecycle |
| Relationship | A typed link between knowledge items, including supports or conflicts | Same-owner endpoints, explicit candidate/confirmed/dismissed/resolved status |
| Project | A company initiative with an owner-approved objective and bounded scope | Named owner, status, milestones, dependencies |
| Task plan | A proposed unit of work with inputs, expected output, and acceptance criteria | Queued by default, no execution authority |
| Approval | A time-limited authorization for one exact action and scope | Explicit owner action, expiry, revocation, audit |
| Decision | An owner decision with rationale and linked evidence | Decision-maker, timestamp, scope, supersession history |
| Audit event | A record of a sensitive state transition | Append-only intent, minimal metadata, no secrets |

## Knowledge lifecycle

1. Capture an owner input, uploaded document reference, external URL, or system observation.
2. Normalize the item without changing its meaning. Preserve the original source reference where safe.
3. Mark it **unreviewed** until the owner or an explicitly authorized review process assesses it.
4. Link supporting, contradicting, or contextual records as candidate relationships.
5. Review provenance, age, conflicts, and missing context. The review queue is a prioritization aid, not a truth engine.
6. The owner may verify, dispute, or leave the item unreviewed.
7. Archive outdated material rather than silently deleting its history. Corrections should create a new record linked to the earlier item.

## Task planning lifecycle

draft -> queued -> owner_approved -> executing -> completed

Alternative terminal or pause states: rejected, cancelled, blocked, failed.

The current staging implementation supports planning and queue visibility only. It does **not** implement the executor, scheduler, agent polling, or the executing transition. Those states are future design vocabulary, not active capabilities.

Before any future execution capability is considered, a task must define:
- one responsible module and one accountable owner;
- a narrow, machine-checkable scope and explicit exclusions;
- required inputs and their access classification;
- expected output and measurable acceptance criteria;
- maximum runtime, resource limits, and a stop condition;
- whether the action is reversible;
- the exact approval required, its expiry, and a revocation path.

No approval may be inferred from silence, a queued task, a previous unrelated approval, or a general request to continue development.

## Approval model

Approvals must be specific to an action, target, and bounded parameter set. They expire quickly and can be revoked. Approval to develop or test code is not approval to deploy, migrate a database, modify production, spend funds, publish content, message users, or move Pi assets. Each of those requires its own explicit authorization and preflight review.

## Module boundaries

- **INTELLIGENCE:** knowledge organization, planning, dependency mapping, decision briefs, and status reporting.
- **SECURITY:** identity, access policy, threat review, secret handling, incident response, and authorization enforcement.
- **GOVERNANCE:** policy ownership, approval rules, decision records, and audit review.
- **DATA:** schemas, retention, data quality, lineage, and controlled exports.
- **LOGISTICS:** operational workflows and supply-chain coordination within approved scopes.
- **CUSTOMER EXPERIENCE:** support workflows and service quality; no unsolicited contact without authorization.
- **LABS:** experiments and prototypes isolated from production.
- **ROBOT OPERATIONS:** future robotics fleet and device coordination behind separate safety interlocks.
- **Business modules (SOCIAL, MUSIC, AI, INSTRUMENTS, ROBOTICS):** own their domain workflows and expose only documented, permissioned interfaces.

INTELLIGENCE may coordinate and recommend across modules. It must not bypass a module's security boundary or directly inherit that module's credentials.

## Staging readiness gates

A live staging pilot is blocked until all of the following are true:

- The D1 database ID is verified against the exact database name mehran-msh-intelligence-staging.
- The staging Wrangler config contains that verified ID and no production binding.
- Migrations are reviewed and applied in order only to the isolated staging database.
- A staging-only owner UID secret is provisioned without reusing production secrets.
- The Worker is deployed only after separate explicit owner authorization.
- Live tests cover Pi identity verification, session expiry/revocation, owner isolation, audit atomicity, rate limits, knowledge provenance, relationship operations, and approval issue/revoke/expiry.
- A rollback and data-reset procedure is documented and tested against disposable staging data.

Passing repository CI is necessary but does not satisfy these live gates.

## Delivery roadmap

### Stage A: safe foundation
- Complete isolated staging configuration and live identity/session validation.
- Validate the schema and audit behavior against staging D1.
- Keep task execution disabled.

### Stage B: useful owner workspace
- Improve knowledge capture, search, review, archive, and relationship workflows.
- Add project records, milestones, dependency links, and owner decision records.
- Produce concise project briefs and blocked-work reports from stored data.

### Stage C: controlled module coordination
- Define versioned interfaces and per-module permission scopes.
- Add read-only status aggregation before any cross-module writes.
- Require owner approval for every cross-module mutation.

### Stage D: separately reviewed automation
- Only after a dedicated threat model, sandbox, permission system, kill switch, resource limits, and audit review.
- Start with reversible, low-risk actions in staging.
- Keep financial, identity, security, production, public communication, and physical-robot actions owner-gated.

## Current implementation boundary

The current isolated staging Worker provides Pi owner verification, short-lived hashed sessions, session revocation, owner-scoped knowledge and relationships, deterministic review prioritization, private memory, approval records, audit writes, and task planning. It does not perform external source retrieval, semantic fact-checking, autonomous truth selection, AI reasoning, code execution, scheduling, production operations, or Pi asset transactions. Those capabilities must not be represented in the UI as available until implemented and separately validated.


## Legacy agent artifacts and actual production execution status

The repository contains a legacy `scripts/intelligence-agent.mjs` file on the default `main` branch. A similarly named scheduled workflow, `.github/workflows/intelligence-agent.yml`, is present on the development branch used by this PR, but was not present in the inspected default-branch tree. The default-branch `wrangler.jsonc` also contains no scheduled trigger declaration.

The production `worker.js` on `main` has two separate execution boundaries:
- Every `/agent/v1/` API path is explicitly rejected with HTTP 410 ("Production Intelligence Agent execution is disabled.") before the legacy endpoint implementation.
- The Worker's `scheduled()` handler immediately returns before reaching its older task-processing code. That older code is unreachable while the unconditional return remains.

The scheduled handler therefore does not currently process tasks in the inspected source. Even if a Cloudflare dashboard trigger exists outside the repository configuration, the current handler returns without doing work. The legacy script still contains calls to the disabled API, and the development-branch workflow is not evidence of an active default-branch schedule.

**Verified conclusion:** source code on `main` explicitly disables both the legacy agent API and the scheduled task executor. This is a source-code/configuration inspection, not a live Cloudflare dashboard, deployed-version, secret, or runtime audit. Do not infer deployed state solely from the repository.

Do not remove the HTTP 410 guard, remove the early return in `scheduled()`, move/enable the development workflow on `main`, configure agent credentials, or restore legacy execution code as part of staging work. Any such activation requires a separate threat review, explicit owner authorization, and narrowly scoped action policy. The isolated staging Worker remains executor-free.
