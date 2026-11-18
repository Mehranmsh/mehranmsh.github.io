# MEHRAN INTELLIGENCE: Safe Code-Change Proposal Design

**Status:** Design and isolated validator prototype only. No code-writing capability is enabled.

## Objective

Allow MEHRAN INTELLIGENCE to prepare reviewable software changes while preserving owner control over repository writes, production deployment, and release decisions.

The first implementation must be a proposal workflow, not an autonomous production editor.

## Trust boundaries

1. **ChatGPT / planning layer:** translates the owner's goal into a bounded task, reviews the proposed plan and resulting diff, and explains risks. It does not receive repository write credentials.
2. **MEHRAN INTELLIGENCE / execution layer:** may inspect approved repository files and prepare a patch in an isolated workspace. It must not hold Cloudflare, Pi wallet, production, or GitHub merge credentials.
3. **GitHub:** stores the proposal on an isolated branch and presents a draft pull request for owner review.
4. **Owner:** explicitly approves task execution and separately reviews/merges the pull request. Approval to prepare a patch is not approval to merge or deploy.

## Required lifecycle

1. A task is created through the authenticated owner Task Hub.
2. Every code-change task starts as `awaiting_approval` with `requires_approval=1`. MCP-created tasks remain proposals and cannot self-approve.
3. The owner approves the specific task. The approval record must bind to the task ID, requested scope, allowed paths, and a short-lived execution window. Editing the scope invalidates the approval.
4. The runner checks out a fixed trusted base commit, creates a uniquely named isolated branch, and prepares a patch only for the approved paths.
5. The patch is validated before any GitHub write: path checks, size limits, diff checks, secret scanning, syntax checks, and relevant tests.
6. If validation passes, the runner may create or update a draft PR on the isolated branch. It must not merge, push to `main`, deploy, or change repository settings.
7. The owner reviews the diff and CI results. Merge and deployment remain separate owner-controlled actions.
8. The runner records a bounded result, commit SHA, branch, PR URL, test summary, and any blocked reason in the task record.

## Initial scope restrictions

The first code-change pilot must use a strict path allowlist, not a denylist. Start with documentation only.

Explicitly excluded until a separate security review:
- `worker.js`, authentication, authorization, sessions, and security controls
- `.github/workflows/**`, repository automation, and CI credential handling
- `wrangler*`, Cloudflare configuration, deployment configuration, and environment bindings
- secrets, tokens, credentials, key material, and files containing personal data
- dependency manifests, lockfiles, build scripts, package lifecycle scripts, and executable workflow files
- Pi wallet/payment code, financial actions, user data migrations, and production database schema changes

Reject absolute paths, parent traversal (`..`), empty path segments, ambiguous Unicode/control characters, Windows-reserved device names, trailing dots/spaces, symlinks, submodules, binary files, and any path not explicitly approved.

## Patch and execution limits

Initial conservative limits:
- Maximum 5 changed files per task
- Maximum 180 KiB total UTF-8 content
- Maximum 40 KiB per file
- Text files only
- Each entry must include explicit change status and regular-file mode metadata
- No arbitrary shell command, script, workflow, or task-payload execution
- No network access from the patch-generation sandbox except explicitly required read-only repository access
- Fixed test commands selected by trusted server-side policy, never supplied by the task description
- One active code-change task per repository at a time
- Idempotent branch naming and duplicate-PR detection
- A hard execution timeout and bounded logs/output

Any limit increase requires a reviewed policy change.

## Validator prototype boundary

`scripts/intelligence-patch-guard.mjs` is a pure validation helper. It currently enforces the documentation-only path allowlist, mandatory status/mode metadata, path ambiguity checks, size caps, NUL rejection, and a small set of common credential-pattern heuristics. Its tests are standalone Node tests.

This prototype is not a patch parser, sandbox, filesystem writer, GitHub integration, or comprehensive secret scanner. Pattern checks can miss credentials and can produce false positives. A future implementation must add a dedicated secret-scanning gate and validate the actual Git diff and repository object metadata before any write.

## Credential design

- Never expose a GitHub write token to an LLM, prompt, task payload, or Worker AI binding.
- Keep read-only inspection credentials separate from write credentials.
- If draft-PR creation is later enabled, use a dedicated GitHub App installation token with the narrowest repository and permission scope that supports branch contents writes and pull-request creation.
- Do not grant Contents write on the default branch through workflow permissions. Protect `main` with branch rules and required checks.
- Do not grant Actions administration, repository administration, secrets access, deployments, or merge permission to the runner.
- Prefer a short-lived token minted only after the owner-approved task is claimed. Never persist it in D1 or task results.
- Keep Cloudflare and Pi secrets outside the GitHub runner's environment.

## Validation gates

A patch is blocked if any of these checks fail:
- Approval is missing, expired, revoked, or no longer matches the task scope.
- The base commit differs from the approved base without explicit re-approval.
- A changed path is outside the allowlist or violates path safety checks.
- The patch exceeds file, byte, or runtime limits.
- Secret scanning detects a credential-like value.
- A required test or static check fails.
- The branch or PR already exists in an unexpected state.
- The runner cannot prove which exact files and commit it changed.

A blocked task must not attempt a broader alternative or silently relax a gate.

## Audit and cancellation

Record task ID, approving owner, approval timestamp, approved scope, base SHA, resulting SHA, branch, PR URL, validation outcomes, and timestamps. Do not store secrets or full sensitive file contents in audit logs.

Cancellation must be checked before patch generation, before GitHub writes, and before reporting completion. Cancellation prevents further work; it does not silently delete or rewrite an existing PR.

## Explicit non-goals for the first pilot

- No automatic merge
- No production deployment
- No direct push to `main`
- No autonomous changes to authentication, security, payments, wallets, or user data
- No arbitrary terminal access or user-supplied shell commands
- No autonomous modification of its own permissions, allowlists, or approval policy
- No use of the SOCIAL-reserved Cloudflare AI budget for Intelligence

## Rollout stages

**Stage 0 - Current:** read-only health and repository quality tasks only.

**Stage 1 - Proposal design:** this document and threat-model review. No write credentials or execution changes.

**Stage 2 - Patch artifact only:** owner-approved patch generated in an isolated workspace and returned as a diff artifact. No GitHub write token.

**Stage 3 - Draft PR:** after a separate owner-approved security change, create a draft PR on a dedicated branch using a short-lived, narrowly scoped GitHub App token. No merge or deploy capability.

**Stage 4 - Broader scope:** expand path allowlists only after reviewing real pilot results and adding tests for every new permission boundary.

## Current implementation boundary

This document and validator do not enable code changes. The current runner remains limited to the existing allowlisted read-only repository quality and service health tasks. Any implementation of Stages 2 or 3 requires a separate reviewed change and explicit owner approval.


## Current Task Hub approval guardrails

The stacked approval-guardrails change in PR #5 adds these controls to the existing task workflow:

- MCP-created tasks are always inserted as `awaiting_approval` with `requires_approval=1`. The MCP schema cannot set an approval flag.
- MCP task updates reject any task that is still awaiting approval or has `requires_approval=1`, including manual proposals with no `action_type`. The model cannot approve its own pending proposal through the update tool.
- Owner approval and cancellation of pending or automated tasks use conditional SQL updates bound to the previously observed status and approval flag. The Worker checks D1's affected-row count and returns a conflict if another state transition won the race.
- The agent claim route continues to require `requires_approval=0`, an eligible queue status, an allowed assignee, and a fixed read-only action type.

These controls close the current self-approval and stale-transition gaps. They do **not** yet implement a separate immutable approval ledger with a one-time approval ID, scope digest, expiry, revocation record, and atomic consumption. The pure patch-envelope validator can reject a trusted approval object marked revoked or consumed, but it does not create or consume that record. A future code-change executor must not be enabled until that control-plane ledger exists and is independently tested.
