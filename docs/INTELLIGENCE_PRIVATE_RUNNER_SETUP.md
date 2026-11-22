# MEHRAN INTELLIGENCE private runner setup

This runner is deliberately limited to two read-only actions:
- `service_health_report`: reads the Worker health endpoint and verifies the D1 binding.
- `repository_quality_check`: reads public metadata and the latest commit for the fixed MEHRAN MSH repository.

The Worker scheduler continues to process `project_status_report` and `social_metrics_report`. The external runner and the Worker scheduler use disjoint action allowlists so they cannot race to claim the same task.

## Required secret

Before enabling the runner after its code is reviewed and merged, create one high-entropy random secret of at least 40 characters (64 random bytes encoded as hex is suitable). Store the exact same value in both locations:

1. Cloudflare Dashboard → Workers & Pages → `mehran-msh-auth` → Settings → Variables and Secrets → add it as an encrypted Secret named `MEHRAN_AGENT_TOKEN`.
2. GitHub repository → Settings → Secrets and variables → Actions → New repository secret named `MEHRAN_AGENT_TOKEN`.

Do not put the value in source code, Issues, pull requests, workflow logs, or ChatGPT messages. Do not reuse `MEHRAN_MCP_TOKEN` or any Pi credential.

The runner polls every five minutes and claims at most five eligible tasks per run. It accepts only tasks assigned to `mehran_intelligence` or `shared`, with `requires_approval=0`, and only the two action types listed above. Claims expire after 15 minutes. Results can be submitted only while the task is still in the active claim lease.

## Operational boundary

This is not a general-purpose code execution agent. It cannot run shell commands supplied by a task, edit repository files, deploy Workers, access Pi wallets, move funds, change secrets, or read private SOCIAL user records. Any broader executor requires a separate design and owner review.

The scheduled workflow becomes active on the default branch after merge. A successful GitHub Actions run proves the runner workflow executed; a task is considered complete only when the authenticated result endpoint records `status=completed` in D1.
