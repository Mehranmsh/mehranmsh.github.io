# MEHRAN INTELLIGENCE Active Task Cancellation

## Scope

This change adds cooperative cancellation for the two existing read-only agent actions:
- `repository_quality_check`
- `service_health_report`

It does not add arbitrary command execution, repository writes, deployments, merges, or access to user assets.

## Control flow

1. The agent claims one pre-authorized task through the authenticated agent queue.
2. While work runs, the agent polls the authenticated task-status endpoint.
3. The owner can cancel a running task from the private Task Hub.
4. The Worker performs a conditional database transition only when the task is still in progress, is assigned to the Intelligence service, is one of the two allowlisted read-only actions, and has an active agent claim.
5. The agent aborts its current child process or HTTP request when it sees cancellation or loss of its claim.
6. If status cannot be verified for three consecutive polls, the runner stops fail-closed.
7. A late result cannot overwrite cancellation because result submission still requires the task to be in progress.

## Limits

Cancellation is cooperative, not instantaneous. Polling occurs approximately every 2.5 seconds, and process termination depends on the operating system delivering the abort signal. Work already completed before cancellation cannot be undone. The Worker remains the source of truth for task status.

This is not a general-purpose process supervisor. It does not yet cancel Cloudflare scheduled report tasks or tasks managed manually outside the agent queue.

## Security properties

- Status polling requires the dedicated agent bearer identity.
- The status endpoint exposes only task ID, status, action type, and whether an agent claim is active.
- Owner cancellation is authenticated by the existing private admin session.
- The cancellation SQL uses a conditional state transition and clears the agent claim.
- The agent never trusts a task description as a command.
- Failure to verify task ownership stops execution instead of continuing optimistically.
