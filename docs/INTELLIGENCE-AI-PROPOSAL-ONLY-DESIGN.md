# Intelligence AI proposal-only boundary (design, not implementation)

## Status and non-goals

This document defines a future design boundary only. It does not add an AI runtime, proposal API, database table, migration, model binding, credential, scheduler, queue, polling loop, task claimant, approval consumer, or executor.

Current staging behavior remains unchanged:
- `EXECUTION_ENABLED=false`.
- The staging Worker exports only its existing `fetch` handler.
- No agent identity, agent session, agent credential, tool bridge, proposal route, approval-consumption route, or task-execution route is present.
- Existing owner-facing write routes remain direct human actions behind the dedicated Pi-verified owner session. They are not AI permissions.
- The owner bearer token must never be passed to a model, agent, browser tool, or external service.
- No production resource, database, Worker, secret, binding, or configuration may be changed as part of this design.

## Trust boundaries

1. **AI proposal producer:** untrusted, advisory-only. It may produce a structured suggestion, but has no database binding, owner session, Pi token, production credential, GitHub write token, or direct access to memory/knowledge records.
2. **Proposal intake service (future, not implemented):** a narrow server-side boundary that validates and stores a proposal as inert data in an isolated proposal ledger. It must not write to canonical knowledge or memory tables.
3. **Owner review surface:** visible only after the existing dedicated Pi-verified owner session. It displays the exact proposal payload, provenance, requested effect, risk, and expiry. It cannot silently approve on behalf of the owner.
4. **Approval and commit service (future, not implemented):** accepts only an explicit owner action and performs a one-time, server-verified, owner-scoped transaction. It must not expose a general-purpose execution API to the AI.

No component may infer owner approval from a chat message, model output, UI state, a client-supplied boolean, or possession of a proposal ID.

## Proposal record contract

A future proposal record should be inert and append-only for its decision history. At minimum it should bind:
- a cryptographically random proposal ID;
- authenticated owner UID assigned by the server, never accepted from the model;
- proposal kind, restricted to an explicit allowlist such as `knowledge.create`, `knowledge.update`, `memory.create`, or `memory.update`;
- a strictly validated target record ID for update proposals, or an explicit create operation;
- bounded proposed content and metadata;
- provenance claims separated from server-verified provenance;
- source references and evidence references, each independently validated;
- creation and expiry timestamps assigned by the server;
- canonical payload hash calculated server-side over a deterministic serialization;
- status such as `pending`, `accepted`, `rejected`, `expired`, or `superseded`;
- decision actor, decision timestamp, and audit correlation ID.

The model must not choose owner UID, status, decision actor, verified provenance, timestamps, approval scope, or payload hash. Unknown fields and unsupported proposal kinds must be rejected. Payload size, nesting depth, string lengths, URL schemes, and reference counts must be bounded.

A proposal must never be presented as a verified system observation or uploaded document merely because the model says so. Until trusted ingestion exists, acceptable provenance remains the currently supported owner input, validated HTTPS external URL, or server-validated link to an existing owner-scoped knowledge record. The UI must distinguish model-generated text from independently verified evidence.

## Approval binding and replay resistance

A future approval must be:
- bound to the authenticated owner UID;
- bound to exactly one proposal ID and one capability;
- bound to the exact canonical proposal payload hash and target record/version;
- limited to the minimum explicit operation and scope;
- short-lived and checked against server time;
- single-use, with consumption and resulting mutation in one atomic database transaction;
- non-replayable after acceptance, rejection, expiry, revocation, payload change, or target-version change.

A generic approval for `memory.write` or `knowledge.write` is too broad. Approval must authorize one exact proposal snapshot, not a category of future operations. Any edit to the proposal invalidates the previous approval and requires a new owner review and approval.

Do not treat the existing approval assessment endpoint as an enforcement mechanism. It is assessment-only and does not consume an approval or perform a write.

## Owner acceptance transaction

When an owner explicitly accepts a proposal, the future server implementation must perform all checks and writes in one atomic transaction/batch:
1. Verify the dedicated owner session and derive owner UID from that session.
2. Load the proposal by ID and owner UID; require `pending` and not expired.
3. Recompute the canonical payload hash and compare it with the stored hash and approval snapshot hash.
4. Verify the exact capability, target ID, target version, allowed fields, and operation-specific constraints.
5. Verify a matching, unexpired, unrevoked, unused approval bound to this owner, proposal, capability, and payload hash.
6. Conditionally mark the approval consumed and proposal accepted, requiring exactly one affected row for each conditional transition.
7. Create or update the canonical knowledge/memory record with owner UID derived from the session, never from request data.
8. Insert the audit event containing the proposal ID, payload hash, capability, target, and decision correlation ID.
9. Commit all changes atomically. If any condition fails, no canonical record, approval consumption, proposal decision, or success audit may be partially committed.

The transaction must use conditional updates or equivalent compare-and-swap checks to prevent concurrent double acceptance. A replay or stale target must fail closed with a conflict response. A failed transaction must be safe to retry only after the owner reloads current state.

## Reject, expire, and supersede

- Rejection is an owner-authenticated, append-only decision with a bounded reason and atomic audit.
- Expiry is server-derived; clients cannot extend it.
- A changed proposal becomes a new immutable snapshot or supersedes the old proposal. It never silently mutates an already reviewed payload.
- Revocation or expiry of approval prevents acceptance.
- No hard deletion of proposal/audit history is permitted through ordinary owner or AI routes.

## Forbidden capabilities

The AI proposal producer must never receive or invoke:
- production writes or production credentials;
- secrets, Pi access tokens, owner bearer tokens, or session material;
- arbitrary SQL, arbitrary URL fetch, shell/command execution, GitHub write operations, or unrestricted filesystem access;
- task execution, scheduler control, deployment, payment, asset transfer, or permission escalation;
- direct mutation of canonical memory, knowledge, findings, company state, or user accounts.

The future capability policy must explicitly deny these operations even if a client supplies a fabricated approval.

## Required tests before implementation can be considered

A future implementation requires isolated disposable-D1 runtime tests proving:
- unauthenticated and wrong-owner proposal reads/writes are rejected;
- model/client-supplied owner IDs, status, timestamps, provenance verification, and hashes are ignored or rejected;
- unknown fields, oversized bodies, malformed JSON, unsupported kinds, invalid URLs, and traversal references are rejected;
- proposal creation cannot change canonical memory or knowledge rows;
- changed payload, changed target version, wrong capability, wrong owner, expired approval, revoked approval, and replayed approval all fail closed;
- two concurrent accept attempts result in exactly one successful commit;
- acceptance creates/updates the canonical record, consumes approval, changes proposal status, and writes audit atomically;
- rejected/expired proposals cannot be accepted;
- no route, binding, credential, scheduler, queue, or worker handler enables autonomous execution;
- production configuration and production resources remain untouched.

Static tests must additionally assert that the AI-facing boundary has no owner token, DB binding, production binding, execution flag override, or direct canonical write route.


## Untrusted evidence and prompt-injection resistance

All model output, user-supplied text, external page content, uploaded content, and tool-returned text must be treated as untrusted data, never as executable instructions or authority. In particular:

- The AI proposal producer has no tools, browser, arbitrary network fetch, shell, SQL, filesystem, GitHub write, or deployment capability.
- A URL in a proposal is an inert reference until a separately authorized and reviewed ingestion service exists. Proposal intake must not fetch it, follow redirects, resolve private network addresses, or use it as a server-side fetch target.
- If trusted evidence ingestion is later introduced, it must use a dedicated allowlisted fetcher with redirect limits, DNS/IP validation on every hop, private/link-local/loopback address denial, response-size and content-type limits, timeouts, and content hashing. It must not share the proposal service's authority.
- Text extracted from evidence must be visibly separated from system instructions and model-generated summaries. Embedded instructions such as requests to reveal secrets, change policy, approve a proposal, or invoke tools are content only and must never alter permissions or workflow.
- Render proposal text and evidence as text, not trusted HTML. Do not use `innerHTML`, execute scripts, render active markup, or automatically open untrusted links.
- The owner review screen must show the exact proposed before/after values, the source references, which claims are model-generated, which facts were independently verified, and the payload hash. Truncation must be explicit; the owner must be able to inspect the full bounded payload before approval.
- A model-generated explanation, confidence score, urgency label, or claimed citation is not independent verification. The server must verify any source identity or content digest it relies on and must preserve uncertainty where verification is unavailable.


## Implementation gate

This design is not permission to implement or deploy the proposal service. Before any schema migration, new Worker route, AI provider binding, secret, or deployment is added, the owner must review the design and explicitly authorize that specific staging-only implementation step. Production changes and PR merge require separate explicit authorization. Until then, this document is the complete scope of work for the proposal-only concept.


## Immutable proposal snapshots and append-only decision events

"Append-only" applies to the proposal's reviewed content and its decision history, not to an in-place mutable blob that overwrites prior decisions:

- The proposal payload is immutable after intake. A changed payload is a new proposal snapshot with a new ID and server-computed hash; the earlier snapshot remains readable and may receive a superseded decision event.
- Keep decision history in a separate append-only event ledger. Each event has a server-generated event ID, owner UID derived from the authenticated session, proposal ID, event type, server timestamp, and bounded decision metadata. Ordinary application routes must not update or delete prior events.
- A current-status field may exist as a transactionally maintained projection for efficient filtering, but it is not the source of truth. It may only advance through a strict state machine using conditional updates from the expected prior state. The event insert and projection update must commit atomically.
- Valid transitions are explicit and terminal states cannot be reopened: pending to accepted, rejected, expired, or superseded. Reconsideration creates a new proposal snapshot rather than resetting a terminal record.
- Audit/event ordering must use server-assigned timestamps plus a unique monotonic sequence or stable event ID for deterministic ordering; client timestamps are display-only metadata and never determine expiry or ordering.
- A proposal's owner UID, payload, payload hash, creation/expiry timestamps, provenance verification state, and event actor are server-owned fields. Unknown or client-supplied authority fields are rejected, not copied into storage.
- On acceptance, the immutable proposal snapshot, approval snapshot, target version, and event transition are checked within the same transaction. A unique constraint or equivalent conditional write must ensure only one accepted event exists for a proposal and approval.

This separation prevents an apparently append-only history from being undermined by mutable proposal payloads or editable decision rows.




## D1 transaction and conditional-write requirements

The future implementation must not confuse a transactional batch with proof that every conditional mutation succeeded. A D1 batch can keep statements atomic, but an `UPDATE` that matches zero rows is still a successful SQL statement unless the database explicitly turns that failed precondition into an error.

- Define the acceptance operation as one database-enforced transaction. Every precondition (pending proposal, unused approval, matching owner, payload hash, capability, target version, and unexpired timestamps) must be checked as part of the transaction, not only in Worker JavaScript before the write.
- Use database constraints, guarded statements, and/or triggers that abort the transaction when any required compare-and-swap transition does not affect exactly one row. Do not rely on checking `meta.changes` after a D1 batch has already committed; a post-commit check cannot roll back a partial logical acceptance.
- Canonical record creation/update, approval consumption, proposal state projection, append-only decision event, and audit event must either all commit or all roll back. A failed guard must produce no partial effects.
- Enforce uniqueness in the schema for one terminal acceptance per proposal snapshot and one consumption per approval. Application-level pre-checks alone are race-prone.
- The implementation must document the exact D1/SQLite transaction primitive and prove its rollback behavior with disposable-D1 runtime tests, including a deliberately failing final statement after earlier writes have been attempted.
- Concurrency tests must use genuinely overlapping requests against the same disposable database, not sequential calls presented as a concurrency test. Assert exactly one accepted event, one consumed approval, and one canonical mutation.
- If the selected D1 primitive cannot express a reliable all-or-nothing guarded operation, do not implement acceptance on that primitive. Keep proposals review-only until a safe transaction design is demonstrated.

## Canonical payload encoding

The phrase "canonical payload hash" must identify one byte-level representation, otherwise two services can hash semantically similar but byte-different objects or disagree about ambiguous input.

- Use RFC 8785 JSON Canonicalization Scheme (JCS) for the bounded, validated proposal payload, then encode the canonical JSON as UTF-8 and calculate SHA-256 on the server.
- Reject duplicate object member names during raw JSON parsing. A normal `JSON.parse` result is insufficient for this check because duplicate names may already have been collapsed.
- Reject non-JSON values, non-finite numbers, invalid Unicode/lone surrogates, unsupported numeric precision, and values outside explicitly documented field bounds before canonicalization.
- Define the exact hash envelope and version, for example a domain-separated prefix containing the proposal schema version before the canonical payload bytes. Store the canonicalization version with the immutable proposal snapshot so future implementations cannot silently change hash semantics.
- Never hash client-provided canonical JSON or accept a client-supplied digest as authoritative. The server reconstructs the allowed payload from validated fields, canonicalizes it, and computes the digest itself.
- Tests must include reordered object keys, Unicode edge cases, duplicate keys, numeric boundary cases, and changed canonicalization versions. Equivalent valid objects must produce identical bytes and hashes; ambiguous or invalid inputs must be rejected.
