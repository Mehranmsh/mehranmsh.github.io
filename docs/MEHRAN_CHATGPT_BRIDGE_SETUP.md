# MEHRAN ChatGPT Bridge: final owner setup

This bridge provides a public-safe health report and an owner-gated fixed task proposal. It does not enable autonomous execution or private two-way messaging.

## 1. Configure the same private token in both services

Generate a random token of 40–200 characters using a password manager. Do not paste it into chat, an issue, a commit, or a source file.

**Cloudflare Worker**
1. Open the Cloudflare dashboard.
2. Open Workers & Pages → `mehran-msh-auth` → Settings → Variables and Secrets.
3. Add a Secret named `MEHRAN_MCP_TOKEN` with the generated token as its value.
4. Save/deploy the Worker configuration.

**GitHub repository**
1. Open repository Settings → Secrets and variables → Actions.
2. Create a repository secret named `MEHRAN_MCP_TOKEN`.
3. Set its value to exactly the same token.
4. Do not create a plain Actions variable. It must be a Secret.

## 2. Merge the reviewed bridge PR

Review and merge PR #137 only after confirming the workflow and setup instructions. The workflow is not active on `main` until merged.

## 3. Run the health check

After merge, open a new GitHub issue using the template **MEHRAN Bridge Health Check**. It contains the required marker and asks only for the read-only health report.

Expected result: GitHub Actions runs and adds a comment titled **MEHRAN INTELLIGENCE bridge result**. It reports only whether the Worker, D1 binding, AI binding, and MCP route are configured. It does not expose private company records or user data.

## Troubleshooting

- **Secret missing/invalid:** check that both secrets exist and match; never reveal either value.
- **HTTP 401:** Cloudflare Worker secret is missing, mismatched, or not deployed.
- **HTTP 429:** MCP rate limit was reached; wait before retrying.
- **Workflow does not start:** confirm PR #137 is merged to `main`, then create a *new* issue from the template.
- **No comment:** open the failed Actions run and inspect the error message. Do not paste secret values into an issue or chat.

## Scope and safety

This first bridge proves a controlled ChatGPT-to-MCP request and returns a public-safe report through GitHub. It is not a private, continuous ChatGPT ↔ INTELLIGENCE conversation, does not run general tasks, and does not bypass owner approval. A separate supported private connector is still required for that broader goal.

## 4. Owner-gated fixed task proposal

The workflow also supports one fixed, non-sensitive task proposal using the marker
`<!-- MEHRAN-CHATGPT-BRIDGE:TASK-PROPOSAL:v1 -->`. This path runs only when the
issue author association is `OWNER`. It submits a predefined proposal to
`create_collaboration_task`; it does not copy arbitrary issue text into MCP.

The MCP bridge identity forces this proposal into `awaiting_approval`. The
workflow verifies that status and comments only the task ID and approval state.
It does not execute the task, deploy code, or change security settings.

Do not use public issues for private prompts, project records, user data, credentials,
or task results. This fixed proposal is a safe hand-off signal, not a private
two-way messaging channel.
