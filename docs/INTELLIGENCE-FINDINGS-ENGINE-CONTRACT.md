# INTELLIGENCE Findings Engine: staging contract

## Purpose

The Findings Engine records review outcomes produced while assessing MEHRAN MSH modules. It turns an assessment check and its supporting evidence into a traceable item that the owner can review and follow over time.

This contract is a design boundary only. It does not add database tables, API routes, UI controls, automated scanning, remediation, scheduling, or execution.

## Non-negotiable safety rules

- Staging only. Never bind this feature to the production Worker or production D1 database.
- Every read and future mutation must be scoped to the authenticated staging owner UID. Never accept an owner UID from the request body as authority.
- Missing, inaccessible, stale, contradictory, or insufficient evidence means `unknown` / `not_assessed`, never `pass`.
- A finding is a recorded observation, not proof that an entire module is secure or insecure.
- No automatic remediation, code changes, configuration changes, external requests, deployments, or task execution.
- Any future create/update/transition endpoint must be owner-authenticated, rate-limited, bounded, and audited atomically with its database mutation.
- Capability approvals and task/repository approvals remain separate ledgers. This feature must not consume or reinterpret either ledger.
- No secrets, access tokens, passwords, private keys, raw credentials, or unnecessary personal data may be stored in findings or evidence metadata.
- Evidence references are inert identifiers/metadata. The Worker must not fetch arbitrary URLs or dereference user-supplied paths.
- Preserve provenance and history. Corrections should be explicit transitions or superseding records, not silent rewriting of historical evidence.

## Finding record contract

A future finding record should contain:

| Field | Meaning | Constraints |
|---|---|---|
| `id` | Opaque finding identifier | Server-generated UUID |
| `owner_uid` | Authenticated owner | Derived only from verified session |
| `module_id` | Registered company module | Must match the owner-scoped module registry |
| `check_id` | Assessment check identifier | Must exist in that module's versioned blueprint |
| `blueprint_version` | Blueprint version used | Required to preserve assessment context |
| `severity` | Risk classification | `critical`, `high`, `medium`, `low`, `info`, or `unrated` |
| `status` | Review lifecycle | `open`, `accepted`, `mitigated`, `resolved`, or `false_positive` |
| `title` | Short finding title | Required, trimmed, bounded to 160 characters |
| `description` | What was observed and why it matters | Required, bounded to 4,000 characters |
| `evidence_state` | Evidence sufficiency | `missing`, `partial`, `sufficient`, or `contradictory` |
| `recommendation` | Suggested next step | Optional, bounded to 2,000 characters; advice only |
| `created_at`, `updated_at` | Server timestamps | Unix seconds; never client-authoritative |
| `created_by` | Actor provenance | Authenticated owner or explicitly named future trusted process; no autonomous process in this phase |

The record must not include a computed claim that the module is secure. Any future risk score must be separately specified, explainable, and never replace the underlying severity, evidence state, or owner review.

## Evidence reference contract

Evidence is represented as bounded metadata, not copied secret-bearing content. A future evidence reference may include:

- `id`: server-generated UUID.
- `kind`: allowlisted value such as `document`, `code_review`, `test_run`, `configuration_review`, `owner_observation`, or `other`.
- `source_ref`: opaque internal reference, bounded to 200 characters.
- `content_digest`: optional SHA-256 digest of the reviewed artifact, never a credential.
- `observed_at`: when the evidence was collected, if known.
- `note`: short explanation of what the reference supports, bounded to 500 characters.

Do not store arbitrary fetch URLs, filesystem paths, request headers, raw logs, full configuration dumps, tokens, or credentials. If a reference cannot be safely resolved by an explicitly allowlisted internal reader, retain it as an inert reference and ask the owner to inspect it manually.

Evidence sufficiency rules:

1. `missing`: no usable reference; outcome remains unknown.
2. `partial`: some evidence exists but does not cover the check's required evidence; outcome remains unknown.
3. `contradictory`: evidence disagrees or cannot be reconciled; require review and do not pass.
4. `sufficient`: all required evidence references are present and reviewable. This means only that evidence is available, not that the check passed.

A future check outcome, if introduced, must use a separate field with values `pass`, `fail`, or `unknown`. `pass` is prohibited unless every required evidence item is present, current enough for the check, and explicitly reviewed. An automated presence check alone cannot declare a pass.

## Lifecycle semantics

- `open`: a finding is recorded and needs review.
- `accepted`: the owner explicitly accepts the risk for now. This is not remediation and must retain an optional rationale and review date.
- `mitigated`: the owner records that a mitigation was applied, with evidence references. This is not the same as resolved.
- `resolved`: the owner records that the underlying issue is no longer present, supported by fresh evidence.
- `false_positive`: the owner records that the observation was not a valid finding, with a required rationale and supporting evidence where possible.

Allowed transitions should be explicit and validated server-side. Terminal states must not be silently reopened or rewritten; reopening should create an audited transition with a reason. Severity changes also require an audit event and rationale.

## Future API boundary

A later implementation may add owner-authenticated routes under `/intelligence/findings`:

- `GET`: list findings with bounded filters for module, severity, status, and pagination.
- `POST`: create a finding from an existing module/check pair; requires explicit owner authorization and atomic audit.
- `GET /:id`: read one owner-owned finding and its evidence references.
- `PUT /:id`: update bounded descriptive metadata only; lifecycle changes should use a dedicated transition operation.
- `POST /:id/transitions`: request an allowlisted lifecycle transition with a required rationale where applicable.

These are proposed contracts, not implemented routes. Do not expose them until a separate schema/API PR adds migration tests, owner-isolation tests, input validation tests, transition tests, and audit-atomicity tests.

## Proposed database integrity

A later migration should use separate tables for findings and evidence references, with:

- Foreign keys and indexes scoped by `owner_uid`.
- A unique or otherwise validated relationship to the module/check/blueprint version.
- CHECK constraints for every severity, status, evidence kind, and evidence state enum.
- Bounded text lengths enforced in the Worker and, where practical, in SQLite.
- Immutable server identity/provenance fields.
- No cascading deletion that silently destroys audit history.
- An audit trigger or transaction pattern that guarantees every successful mutation has its matching audit event, and that a failed audit rolls back the mutation.
- No migration application to any remote database as part of implementation PRs.

## Required tests before implementation can be considered ready

- Unauthenticated access returns 401; cross-owner reads and writes are impossible.
- Unknown module or check IDs return 404/validation errors and cannot be attached to a finding.
- Invalid enum values, oversized fields, malformed evidence, and unexpected request keys are rejected.
- Missing/partial/contradictory evidence cannot produce a passing check outcome.
- A `pass` outcome cannot be created without every required evidence reference and explicit review.
- Every successful create/update/transition has exactly one corresponding audit event.
- Audit failure rolls back the associated mutation.
- Invalid lifecycle transitions and silent terminal-state rewrites are rejected.
- Evidence references are never dereferenced as arbitrary URLs or filesystem paths.
- Static and runtime checks confirm no executor, scheduler, cron, queue consumer, production binding, or remediation side effect was added.

## Delivery sequence

1. This contract-only change documents the safety and data model.
2. A separate PR adds a disposable-SQLite migration and schema contract tests only.
3. A separate PR adds read-only owner-scoped findings APIs after the schema is reviewed.
4. A later PR may add owner-authenticated manual create and transition operations with atomic audit.
5. Any future evidence ingestion or automated assessment requires a separate threat model and explicit owner review. Automated remediation remains out of scope unless separately authorized and designed.

## Current status

Contract documented only. No schema, route, finding record, evidence ingestion, task, approval, or execution behavior is added by this document. Production resources remain untouched.
