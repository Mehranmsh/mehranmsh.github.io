# MEHRAN INTELLIGENCE private runner setup

This runner is deliberately limited to two read-only actions:
- `service_health_report`: reads the Worker health endpoint and verifies the D1 binding.
- `repository_quality_check`: reads public metadata and the latest commit for the fixed MEHRAN MSH repository.

The Worker scheduler processes the legacy `project_status_report` and `social_metrics_report` tasks and also executes dependency-ready work-package tasks of the two read-only action types above. It claims at most five tasks per scheduled run. The optional external agent API can also claim the same package action types; both claim paths use a conditional status update so only one executor can win a task claim.

## Required secrets

The Worker uses separate credentials for agent authentication, owner orchestration, private report storage, and GitHub Actions dispatch. Do not reuse the private-reports repository token for dispatching the runner in the main repository.

### Runner dispatch credential

Create a dedicated fine-grained GitHub personal access token (or GitHub App installation token) restricted to `Mehranmsh/mehranmsh.github.io`, with **Actions: write** repository permission. Store it only as an encrypted Cloudflare Worker Secret named `MEHRAN_RUNNER_GITHUB_TOKEN` in `mehran-msh-auth` → Settings → Variables and Secrets. This token is used only to dispatch `.github/workflows/mehran-intelligence-runner.yml` on `main`. Do not add it to GitHub Actions secrets, source code, Issues, pull requests, workflow logs, or ChatGPT messages. Keep `MEHRAN_REPORTS_GITHUB_TOKEN` separate and limited to the private reports repository. If the dispatch token is missing or lacks permission, the five-minute scheduled runner continues to operate; only immediate dispatch is unavailable.


Before enabling the runner after its code is reviewed and merged, create one high-entropy random secret of at least 40 characters (64 random bytes encoded as hex is suitable). Store the exact same value in both locations:

1. Cloudflare Dashboard → Workers & Pages → `mehran-msh-auth` → Settings → Variables and Secrets → add it as an encrypted Secret named `MEHRAN_AGENT_TOKEN`.
2. GitHub repository → Settings → Secrets and variables → Actions → New repository secret named `MEHRAN_AGENT_TOKEN`.

Do not put the value in source code, Issues, pull requests, workflow logs, or ChatGPT messages. Do not reuse `MEHRAN_MCP_TOKEN` or any Pi credential.

The Worker scheduler runs every five minutes and claims at most five eligible tasks per run. It accepts only tasks assigned to `mehran_intelligence` or `shared`, with `requires_approval=0`, and only the allowlisted read-only action types. Work-package idempotency keys are bound to a request fingerprint, so reusing a key with a different payload is rejected; duplicate dependency edges and oversized scope objects are also rejected. Package tasks are eligible only after all dependencies are completed. Transient network failures receive bounded exponential retry; deterministic failures become blocked. Expired package claims are recovered by the scheduler after 15 minutes, with retries bounded by each task's attempt limit. Package status snapshots are refreshed after scheduler execution and remain retrievable from the owner-only package report route. Checkpoints and results can be submitted only while a task is in the active claim lease.

## Owner orchestration identity

Package creation and package-report retrieval are owner-only routes. They use a separate high-entropy Cloudflare encrypted Secret named `MEHRAN_ORCHESTRATOR_TOKEN`. Do not store this token in the agent runner, GitHub Actions, source code, Issues, pull requests, workflow logs, or ChatGPT messages. The agent runner must receive only `MEHRAN_AGENT_TOKEN`, which cannot create or read work packages.

The orchestrator secret is not configured by this code change. The intended owner-facing route is direct authenticated MCP access to the source Worker; a separate ChatGPT-to-Worker relay is not a protocol requirement. The current ChatGPT session is not connected merely because these Worker tools exist: the MCP app must be installed and authenticated in an eligible ChatGPT workspace, and the required owner secret must be provisioned in Cloudflare. Until those conditions are met and tested, package intake from this chat is not live. Do not substitute the agent token or send private task payloads through public GitHub Issues.

## Direct private MCP work-package intake

The MCP endpoint can expose two additional tools to the dedicated ChatGPT bridge:
- `create_intelligence_work_package`: creates a durable package with stable idempotency, explicit dependencies, and only the fixed read-only actions `service_health_report` and `repository_quality_check`.
- `get_intelligence_work_package`: retrieves the package state and bounded task results.

These tools are exposed only when both conditions hold:
1. The request authenticates with the dedicated `MEHRAN_MCP_TOKEN` bridge identity.
2. The owner has separately provisioned a valid `MEHRAN_ORCHESTRATOR_TOKEN` encrypted Secret in Cloudflare.

The orchestrator token is only checked inside the Worker as an owner opt-in. It is never returned to ChatGPT, included in MCP responses, or stored in GitHub. The bridge cannot use the token to approve tasks, access notification acknowledgements, run arbitrary commands, write repository files, or deploy. Package intake remains limited to the two read-only report actions until a separate capability review expands the allowlist.

This is the intended private ChatGPT-to-MCP intake route. It does not make the current ChatGPT session connected automatically: the MCP app must be installed and authenticated in an eligible ChatGPT workspace. If the tools are not exposed, verify both encrypted secrets and refresh the MCP app's tool list after deployment.

## Operational boundary

This is not a general-purpose code execution agent. It cannot run shell commands supplied by a task, edit repository files, deploy Workers, access Pi wallets, move funds, change secrets, or read private SOCIAL user records. Any broader executor requires a separate design and owner review.

The scheduled workflow becomes active on the default branch after merge. A successful GitHub Actions run proves the runner workflow executed; a task is considered complete only when the authenticated result endpoint records `status=completed` in D1.


## Private notification outbox

Work-package status transitions enqueue a minimal event for the `owner_private` channel. The package status update, audit event, and outbox insertion are committed atomically. An owner-orchestrator authenticated receiver can inspect queue counts and recent terminal failures through `GET /agent/v1/notifications/status`, poll `GET /agent/v1/notifications/next`, receive a five-minute delivery lease, and acknowledge with `POST /agent/v1/notifications/{id}` using `delivered`, `retry`, or `failed`, and the exact `leaseToken` returned by that claim. Acknowledgements without the current lease token are rejected, so delayed acknowledgements from an expired delivery cannot complete a newer claim. Retry attempts are bounded and expired delivery leases return to the pending queue. Delivery is at-least-once, not exactly-once: the receiver must deduplicate side effects using the stable `eventId`.

This implements a private, authenticated delivery handoff contract, not a configured notification provider. A separate notification receiver is optional and is not required for the core MCP intake or for ChatGPT to retrieve a package report when the MCP connection is available. No Telegram, email, push, or automatic ChatGPT-session delivery is active. The credential must never be placed in a public workflow, repository, issue, or agent token store.
