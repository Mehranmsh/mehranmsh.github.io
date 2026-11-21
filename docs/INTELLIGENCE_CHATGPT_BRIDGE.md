# MEHRAN INTELLIGENCE ↔ ChatGPT Bridge

Status: architecture proposal only. This document does not claim that a live two-way connection is enabled.

## Objective

Make MEHRAN INTELLIGENCE the company's execution director and ChatGPT its planning and review partner, while the owner remains the final authority for sensitive decisions.

The owner should be able to submit one request, leave the chat, and later review completed work without manually relaying every message between systems.

## Command structure

1. Owner: sole owner and final approver for sensitive or irreversible actions.
2. ChatGPT: interprets the owner's request, decomposes it into tasks, defines acceptance checks, and reviews returned evidence.
3. MEHRAN INTELLIGENCE: execution director. It assigns work, coordinates modules, tracks dependencies, retries safe failures, and returns structured results.
4. Company modules: Dashboard, Admin, User Center, Projects, Services, SOCIAL, Mehran Music, STUDIO, Mehran AI, Mehran Instruments, SECURITY, GOVERNANCE, LOGISTICS, CUSTOMER EXPERIENCE, LABS, DATA, ROBOT OPERATIONS, and Mehran Robotics.

INTELLIGENCE may coordinate work but must not override owner approval or grant itself new privileges.

## Private message protocol

Use a Cloudflare Worker relay backed by D1. Do not use GitHub Issues, public repository files, or public logs for private task content.

Each message should have:
- version, message_id, conversation_id, created_at, expires_at
- sender_role and recipient_role
- task_id and correlation_id
- message_type: task, progress, result, error, approval_request, or acknowledgement
- encrypted_payload
- signature and replay-protection nonce

Encrypt payloads end-to-end with recipient public keys (authenticated public-key encryption such as libsodium sealed boxes plus a signature scheme). Keep private keys outside the repository and outside D1. Rotate keys and support revocation. Encrypt sensitive result payloads too, not only outgoing tasks.

The relay should store ciphertext and minimal routing metadata only. Never log plaintext, credentials, personal data, or full prompts. Apply strict size limits, expiry, per-identity rate limits, idempotency, audit events, and dead-letter handling.

## Required private API contract

- POST /bridge/v1/messages: authenticated sender submits an encrypted message.
- GET /bridge/v1/messages/next: authenticated recipient claims the next message.
- POST /bridge/v1/messages/:id/ack: recipient acknowledges receipt.
- POST /bridge/v1/messages/:id/result: recipient submits an encrypted result or progress event.
- GET /bridge/v1/conversations/:id/events: authenticated party retrieves encrypted events after a cursor.
- POST /bridge/v1/approvals/:id/decision: owner-only approval or rejection.

All routes must use separate bridge identities, scoped permissions, short-lived credentials, request signing, replay protection, and owner-controlled revocation. The ChatGPT bridge identity must not be an admin session and must not be able to deploy code, alter security settings, access user private data, or approve its own proposals.

## Execution and approval policy

- Read-only reports may run automatically when explicitly allowlisted.
- Routine reversible work may run only within owner-defined scope and budgets.
- Deployments, security changes, account actions, payments, data deletion, permission changes, and external publication require explicit owner approval.
- INTELLIGENCE must return evidence: task ID, status, module, actions taken, changed files or records, test results, and remaining risks.
- ChatGPT reviews evidence and may send follow-up tasks, but cannot silently promote an approval-required task.

## Critical integration prerequisite

A secure relay alone does not connect this ChatGPT session to the relay. The current GitHub connector can access GitHub, but this session has no configured private HTTP tool for authenticated POST/GET calls to the Cloudflare Worker. The existing public GitHub Issues intake is limited to public-safe, allowlisted reports and is not a private two-way channel.

Before enabling the live bridge, provide a supported private tool/connector that exposes only the scoped bridge API to ChatGPT. If that capability is unavailable on the current account, do not fake connectivity or fall back to plaintext public issues. Keep the relay disabled until the prerequisite is met.

## Delivery phases

1. Inspect current Worker routes, D1 schema, cron, and MCP authentication; preserve existing functionality.
2. Add the relay schema and API behind a feature flag, disabled by default.
3. Add key registration/rotation and message signing/encryption tests.
4. Add a scoped ChatGPT bridge connector with read/write only to bridge endpoints.
5. Run a non-sensitive end-to-end test: ChatGPT task -> INTELLIGENCE acknowledgement -> execution -> encrypted result -> ChatGPT review.
6. Expand to company-wide tasks only after security review and owner approval.

## Acceptance criteria

- No private task or result appears in public GitHub, browser-visible source, or plaintext logs.
- Both directions are encrypted and authenticated.
- Replay, duplicate delivery, expired messages, revoked identities, and oversized payloads are rejected.
- Owner approval gates all sensitive actions.
- A full round trip is demonstrated with a harmless test task and verifiable evidence.
- Existing Pi Sign-In, SOCIAL, and current Worker routes continue to pass regression tests.
