# MEHRAN INTELLIGENCE knowledge retrieval

## Current retrieval method

The current knowledge store uses bounded lexical relevance ranking over the authenticated owner's entries and system-seeded company entries. Persian and English text is normalized with Unicode NFKC, Arabic yeh/kaf variants are normalized, and terms are ranked with stronger weight for title matches than body matches. High-importance entries receive a small ranking boost.

The main chat context receives at most 12 relevant ranked entries. A separate read-only knowledge search tool can return up to 12 relevant entries. The model can also call the read-only `search_organizational_knowledge` tool for up to 12 relevant entries. Content is bounded before it enters the model context.

## Security properties

- Retrieval is limited to the verified owner UID plus immutable system-seeded entries.
- Search is read-only and does not alter knowledge, tasks, approvals, accounts or external systems.
- Retrieved text is untrusted reference data. It cannot grant permissions or override system instructions.
- The main chat and targeted knowledge-search tool use strict no-fallback retrieval: when no relevant entry matches, they return an empty result rather than injecting unrelated high-priority notes. The ranking helper retains an optional bounded fallback mode for explicitly chosen internal callers, but the current chat path does not use it.
- This is lexical retrieval, not semantic/vector search. Do not describe it as embeddings, autonomous learning or verified reasoning.

## Conflict and freshness handling

Retrieved entries retain their source and `updatedAt` provenance. The current conflict-preservation safeguard recognizes competing entries only when their normalized category and title are identical; it retains a competing record in the bounded result set so the assistant can surface both versions and timestamps. It does not yet reliably detect semantic conflicts whose titles or categories differ. For conflicts it can identify, the assistant must not silently select the newest or highest-importance item. A current explicit owner instruction or independently verified company data may resolve the conflict; otherwise the assistant must ask the owner to confirm. Old or undated entries are potentially stale and must be described with that limitation. If targeted retrieval returns no relevant evidence, the assistant must say the information was not found instead of guessing. Archived entries are excluded from retrieval.

## Future evaluation

Before adding embeddings, external model providers or broader tools, measure retrieval precision and recall on owner-approved Persian and English evaluation questions. Include tests for conflicting/stale entries, prompt injection, missing knowledge and owner isolation. Any future vector index must remain inside the approved Pi Network company architecture and must not become an execution authority.

## Knowledge relationships (implemented in validation branch; not production-deployed)

The relationship layer does not rely on title similarity, recency, importance, or an LLM guess as proof that two statements contradict each other. It stores explicit, owner-scoped metadata between two existing knowledge IDs.

Implemented in the validation branch:

1. A dedicated `0002_intelligence_knowledge_relationships.sql` migration and matching Worker bootstrap schema define `conflicts_with`, `supersedes`, and `supports` relations.
2. INTELLIGENCE can propose a relationship with evidence. The record is stored as `candidate`, authored by `intelligence`, and remains unconfirmed. It does not alter knowledge content, retrieval priority, archive state, permissions, or execution authority.
3. The owner can list relationships and explicitly confirm, dismiss, or resolve an actionable candidate/confirmed record. Resolution must select one of the two linked knowledge records.
4. Both original knowledge records remain stored. The proposal author remains recorded after owner review; confirmation/resolution timestamps record the review lifecycle.
5. Chat context includes owner-scoped candidate, confirmed, and resolved relationship metadata. Candidate relations must be labelled as unconfirmed; only owner-confirmed relations or owner-selected resolutions can settle the relationship.
6. Database constraints and triggers reject self-links, duplicate links, invalid relation/status values, cross-owner links, system-seed links, and new links to archived/missing knowledge. Reads and mutations are scoped to the authenticated owner.

Validation limits:

- The new migration lifecycle tests run against disposable SQLite, not Cloudflare D1.
- Worker smoke tests validate parser, source contracts and helper behavior; they do not prove live D1 trigger behavior or live AI model behavior.
- The relationship UI has not yet been built. The current owner API is available for the private admin interface to consume.
- No production D1 migration, Cloudflare deployment, merge, or executor activation has occurred. Apply the migration only to a dedicated staging D1 database after the owner creates and verifies that isolated environment.
