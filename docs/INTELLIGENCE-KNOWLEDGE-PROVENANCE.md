# INTELLIGENCE knowledge provenance and evidence policy

## Purpose

Knowledge records are not interchangeable with verified facts. INTELLIGENCE must preserve where a statement came from, when it was observed, how it was assessed, and whether the owner has reviewed it. A confidence value is an assessment aid, not proof of truth.

## Implemented staging provenance fields

Each knowledge record should carry:

- `source_type`: one of `owner_input`, `uploaded_document`, `external_url`, or `system_observation`.
- `source_ref`: optional bounded reference such as a document identifier or URL. Never store access tokens, credentials, or private signed URLs here.
- `observed_at`: optional ISO-8601 timestamp describing when the source was observed, not when the row was inserted.
- `confidence_score`: integer 0-100, nullable until assessed. This is an internal assessment, not a probability guarantee.
- `verification_status`: one of `unreviewed`, `owner_verified`, or `disputed`. Only an explicit owner action may set `owner_verified`.

## Evidence and relationship rules

1. Preserve the original source text and provenance once a knowledge record is referenced by a relationship.
2. Corrected or newer information becomes a new knowledge record. Link it with an explicit `supersedes`, `supports`, or `conflicts_with` relationship; never rewrite the historical evidence in place.
3. A source URL is a locator, not evidence that the page was read or that its claims are true.
4. A document reference is not evidence that the document was parsed correctly. Record extraction or review status separately when that capability exists.
5. Do not silently convert a candidate relationship into a confirmed relationship. Confirmation remains owner-controlled.
6. Conflicting records remain visible until the owner explicitly resolves the conflict. Resolution records which knowledge item was selected; it does not erase the alternative.
7. Imported or generated claims remain `unreviewed` unless the owner explicitly verifies them.

## Deterministic knowledge evaluation endpoint

The staging Worker exposes owner-scoped, read-only `GET /intelligence/knowledge/:id/evaluation`. It also exposes `GET /intelligence/knowledge/evaluations` for a bounded batch (up to 100 records), using owner-scoped relation aggregation so a dashboard does not need one request per record. It derives a review state from stored metadata and owner-controlled relationships:

- `needs_review`: no owner verification or stronger blocking signal is present.
- `owner_verified`: explicitly verified by the owner and not archived.
- `disputed`: the owner marked the record disputed.
- `conflict_unresolved`: at least one candidate or confirmed `conflicts_with` relationship remains unresolved.
- `archived`: the record is archived and no higher-priority review state applies.

The response separately reports candidate relationships, confirmed conflicts, unresolved conflicts, confirmed supports, and confirmed supersessions. It does not calculate a composite truth score, silently resolve conflicts, or treat a confidence field as a probability. This is deterministic metadata triage only, not semantic verification or an AI fact-checker. The endpoint reads no external URLs and creates no side effects.

## Security and privacy constraints

- Every read and mutation remains scoped to the authenticated staging owner.
- Provenance fields must be bounded and validated server-side and at the database layer.
- Do not place raw source documents, secrets, access tokens, or unnecessary personal data in audit details.
- Audit provenance changes by field names and record IDs, not by copying the source content into the audit log.
- No autonomous source fetching, browsing, ingestion, or verification is enabled by this policy.
- No task execution or external side effect is authorized by a knowledge record or relationship.

## Acceptance tests

- Invalid source types and verification states are rejected.
- Confidence values outside 0-100 and non-integers are rejected.
- Source references are length-bounded and reject credential-bearing URL forms.
- Owner isolation applies to provenance reads and writes.
- Owner verification is an explicit audited transition.
- Provenance remains immutable when evidence-linked, alongside the existing content immutability guard.
- Archive and restore preserve provenance and relationship history.
- A source locator alone never changes a record to owner-verified.
- Migration tests run against the complete staging migration chain in disposable SQLite.
- Live D1 behavior is separately validated after the staging database target is confirmed.

## Staging implementation

Migration `0004_intelligence_knowledge_provenance.sql` adds the five bounded fields to the staging knowledge table. The isolated Worker accepts provenance metadata when creating a knowledge record, returns it on owner-scoped reads, and exposes explicit owner review transitions through `PUT /intelligence/knowledge/:id` actions `verify`, `dispute`, and `unverify`.

The source locator and confidence score are never treated as proof. Creation always starts with `verification_status=unreviewed`; only an authenticated owner action can change that state. The audit records the review transition and metadata category without copying source content or source URLs.

Migration 0004 is an additive, one-time ALTER TABLE migration. It is committed but has not been applied to Cloudflare D1. Apply it only after migrations 0000-0003 and only to the positively identified staging database. Live D1 and Worker behavior remain unverified.

This implementation does not enable source fetching, document ingestion, automated verification, task execution, or production deployment.
