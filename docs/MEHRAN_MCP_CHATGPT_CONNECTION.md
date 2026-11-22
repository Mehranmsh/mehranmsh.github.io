# MEHRAN INTELLIGENCE: ChatGPT MCP connection guide

## Current integration status

MEHRAN MSH exposes an authenticated remote MCP endpoint:

`https://mehran-msh-auth.mehran79mehran.workers.dev/mcp`

The Worker implements MCP JSON-RPC methods including `initialize`, `ping`, `tools/list`, and `tools/call`. The dedicated bridge identity is authenticated with the Cloudflare Worker secret `MEHRAN_MCP_TOKEN` using an HTTP Bearer token. Do not put that token in source code, GitHub issues, task descriptions, screenshots, or ChatGPT messages.

This is a remote tool connection, not a continuously running background conversation. ChatGPT calls the tools when they are selected and invoked in a conversation.

## ChatGPT account availability

OpenAI's current custom MCP connection documentation states:

- Custom MCP connections are available on ChatGPT web for supported Business and Enterprise/Edu workspaces, subject to workspace permissions.
- Pro users can connect custom MCP servers with read/fetch permissions.
- Full MCP support, including write-capable actions, is limited to Business and Enterprise/Edu.
- Free accounts are not listed as supported for custom MCP server connections.

Therefore, on a Free account the custom connection cannot currently be completed from ChatGPT. Do not attempt to work around this by exposing credentials in public GitHub issues or by weakening Worker authentication.

Official references:
- https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- https://help.openai.com/en/articles/6825453-chatgpt-release-notes

## Connection procedure when the account supports it

Use ChatGPT on the web, not the Android app:

1. Open ChatGPT Settings or the workspace Plugins/Apps area.
2. Choose the option to add a custom MCP server/plugin, if available for the account.
3. Name it `MEHRAN INTELLIGENCE`.
4. Set the remote HTTPS MCP endpoint to the URL above.
5. Select Bearer token authentication and enter the existing `MEHRAN_MCP_TOKEN` privately in the connection's authentication field.
6. Review the discovered tools and their permissions before creating/enabling the connection.
7. Start a new conversation, select the MEHRAN INTELLIGENCE app, and test read-only tools first.

Never paste the bearer token into the conversation itself. If the UI does not offer custom MCP server creation or Bearer authentication, stop; do not publish a token or switch to a public issue-based relay.

## Tool and approval boundaries

The bridge identity is intentionally more restricted than the owner admin session:

- Read company project status, aggregate SOCIAL metrics, service health, and management summaries.
- List collaboration tasks.
- Propose a collaboration task. Bridge-created tasks must require owner approval.
- It cannot approve or cancel tasks, write execution results, deploy code, alter user accounts, access wallets, move funds, or change secrets.
- The private execution runner remains limited to its explicit read-only report allowlist.

An owner must approve a proposal in MEHRAN MSH before an eligible action can be released to the execution service. A task proposal is not proof that the task ran.

## Validation checklist

After connecting on a supported account:

- MCP initialization succeeds.
- The tool list is discovered.
- A read-only project/status request returns structured data.
- Creating a task proposal results in `awaiting_approval`.
- The bridge identity cannot change the task status or submit a result.
- The owner approval flow remains the only release path.

Do not describe the integration as connected until these checks have been completed against the live Worker.
