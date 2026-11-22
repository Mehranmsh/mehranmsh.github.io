# MEHRAN INTELLIGENCE Error Watchdog

Status: implementation prepared on branch; it becomes active only after merge to the default branch.

## What it monitors

- Every five minutes, calls the existing MCP `get_service_health` tool.
- Requires the Worker to report available and the D1, Workers AI, and MCP bindings to be present.
- Watches completed GitHub Actions workflows and creates an alert when an automation run fails.
- Creates one open service-health alert and updates it on repeated failures instead of opening a new issue every five minutes.
- Closes the service-health alert after a later successful health check and records recovery.

## Alert delivery

Alerts are created as GitHub Issues in the MEHRAN repository. GitHub notification delivery depends on the owner's GitHub notification settings. This is an early alert channel, not a guaranteed push notification to this ChatGPT conversation.

## Required configuration

- The repository secret `MEHRAN_MCP_TOKEN` must already be configured.
- The existing MCP endpoint is used; no new credential is introduced.
- The workflow requires `issues: write`, `actions: read`, and `contents: read` only.

## Security boundaries

- Never include prompts, private task payloads, user records, access tokens, or secrets in alert issues.
- Workflow-failure alerts contain only workflow metadata and a link to the run.
- Health checks verify the current MCP health tool's reported Worker/binding state. They do not prove database query health, external-provider reachability, end-to-end task execution, or the security of the full network.
- This watchdog does not claim to implement the private ChatGPT ↔ INTELLIGENCE relay or a general task orchestrator.

## Activation and verification

After merge to the default branch:
1. Open Actions and run **MEHRAN INTELLIGENCE Error Watchdog** once with `workflow_dispatch`.
2. Confirm the run succeeds and that no alert is created during healthy operation.
3. Use a controlled non-production failure test before relying on alert delivery.
4. Confirm GitHub notifications are enabled for repository issues.

Do not deliberately break production services to test this workflow.
