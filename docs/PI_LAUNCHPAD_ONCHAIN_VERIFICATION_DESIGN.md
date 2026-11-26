# Pi Launchpad On-Chain Verification Design

Status: design only. This document does not implement an RPC client, query a network, or claim that any token or pool has been verified.

## Goal

Add a separate verification layer that can independently derive launchpad and AMM facts from canonical Pi Network ledger data. Signed third-party snapshots remain useful for provenance, but must never be presented as on-chain proof.

## Non-negotiable source gate

Before implementing a network adapter, obtain and review current, authoritative Pi Network documentation for:
- the supported Mainnet network identifier and protocol version;
- official Horizon/RPC/API endpoints and their authentication/rate-limit requirements;
- ledger close/finality semantics and canonical ledger identifiers;
- asset, trustline, liquidity-pool, offer, and account data representations;
- any supported proof or archival access needed to independently validate returned records.

Do not infer an endpoint from Stellar documentation, a community indexer, a project website, or a guessed URL. A Pi-specific compatibility assumption must be documented and tested against Pi-owned documentation and a known-good Mainnet fixture.

## Verification layers

1. **Transport and endpoint identity**
   - HTTPS only; exact origin allowlist; no caller-supplied arbitrary URL.
   - Bounded timeout, response size, content type, redirects, and request count.
   - Reject private, loopback, link-local, and metadata-service destinations after DNS resolution; defend against DNS rebinding at connection time.
   - GET-only reads. No signing keys, wallet operations, transactions, or writes.

2. **Network identity and canonical ledger**
   - Confirm the response belongs to configured Pi Mainnet, not Testnet or another Stellar-family network.
   - Bind every observation to a ledger sequence/hash and close time.
   - Reject stale, future, non-canonical, or inconsistent ledger references.
   - Where the API does not expose independently verifiable proofs, label the result provider_reported, not cryptographically_proven.

3. **Asset and pool identity**
   - Resolve assets using the full network-specific asset identity, issuer/account, and code. Never identify an asset by ticker alone.
   - Resolve AMM pools by canonical pool identifier and verify both reserve assets and pool parameters.
   - Reject ticker collisions, issuer mismatches, unexpected reserve assets, and unsupported pool types.

4. **Metric derivation**
   - Derive TVL from verified reserve balances and a documented Pi-denominated conversion method.
   - Derive 24-hour volume from ledger operations/trades in a precisely defined rolling or ledger-time window. Do not substitute a provider's displayed volume without labeling it.
   - Derive LP lock status only from an explicit, verifiable lock mechanism. A pool balance or project claim is not proof of locked liquidity.
   - Derive FDV only when circulating/total supply and price methodology are independently defined; otherwise keep FDV unknown.
   - Derive holder concentration only from a complete, well-defined holder universe. Exclude issuer/pool/escrow accounts only under explicit documented rules.
   - Preserve raw units and exact rounding rules. Do not silently mix Pi, issued assets, and USD.

5. **Evidence and audit record**
   - Store source origin, network ID, ledger sequence/hash, retrieval time, raw response hash, derivation version, and all input record identifiers.
   - Separate provider_reported, independently_recomputed, and cryptographic_proof_verified statuses.
   - A raw response hash proves only that a stored byte sequence has not changed. It does not prove that the response was truthful or canonical.
   - Never upgrade trust based solely on a provider signature or a project's self-hosted endpoint.

## Fail-closed acceptance rules

- Unknown network, unknown protocol representation, missing ledger identity, incomplete records, ambiguous asset identity, unsupported pool type, or unverifiable finality => metric remains unknown.
- Conflicting providers => report the conflict; do not average values into an apparently authoritative answer.
- A source outage or rate limit => no stale value silently carried forward as current.
- Third-party signed attestations and on-chain observations remain separate evidence classes. They must not overwrite one another.

## Safe implementation sequence

1. Documentation review and source registry entry for an official Pi-owned endpoint.
2. Static fixtures captured from documented public responses, with sensitive fields removed.
3. Pure parser tests for valid, malformed, oversized, wrong-network, stale-ledger, and identity-collision cases.
4. Pure metric derivation tests using fixed ledger fixtures.
5. Independent review of derivation rules and trust model.
6. Only then consider a read-only, allowlisted live connector with strict limits and explicit operator enablement.

## Testnet RPC policy prototype (2026-11-26)

A pure policy module now defines a narrow Testnet-only request boundary:
- Exact documented endpoint: `https://rpc.testnet.minepi.com`.
- Only `getHealth` is permitted; no ledger, account, pool, transaction, or submission methods.
- Network must be explicitly `testnet`; Mainnet and endpoint substitution are rejected.
- JSON-RPC response validation checks envelope version, request ID correlation, RPC errors, and presence of a result. It does not interpret the health payload as ledger proof.
- The module does not perform HTTP requests. Transport limits are declared as policy metadata only and are not yet enforced by a network client.
- Testnet results are explicitly labeled and must never enter Mainnet scoring.

The new policy and tests are included in the isolated Launchpad CI workflow. This is a guardrail prototype, not a live RPC integration.

## Explicit exclusions

This design does not authorize live ingestion or scraping; guessed Horizon/RPC endpoints; wallet access, key handling, signing, or transactions; automatic buy/sell recommendations; claims that a signed statement proves on-chain truth; or enabling paid AI services or Cloudflare Workers AI.

The analyzer must continue to display missing on-chain evidence as unknown until the complete verification path above is implemented and independently reviewed.

## Official Pi documentation status (reviewed 2026-11-26)

- Pi Network's April 8, 2026 RPC announcement explicitly describes the released RPC server as Testnet-only and gives `https://rpc.testnet.minepi.com` as its Testnet example endpoint. It says Mainnet RPC would follow based on Testnet performance and reliability. This document therefore does not authorize treating that endpoint as Mainnet or deriving a Mainnet URL by changing the hostname.
- Pi's official developer documentation currently documents the Pi SDK and Platform API for app authentication, payments, ads, and app-related resources. These APIs are not a substitute for a public Mainnet ledger/AMM data API.
- Pi's Ecosystem Summit announcement states that Launchpad, DEX, and AMM capabilities are planned for Mainnet in Q1 2027. This is a roadmap statement, not evidence that a public Mainnet RPC or AMM data endpoint is already available.
- Until Pi publishes and documents the Mainnet data interface and its network identity/finality semantics, Mainnet-derived TVL, trade volume, pool composition, lock status, FDV, and holder concentration must remain unknown unless independently supported by another explicitly labeled evidence source.

### Current implementation decision

No live RPC adapter is being added in this increment. The documented Testnet RPC may be evaluated later in an isolated Testnet-only experiment, clearly labeled as Testnet and never allowed to feed Mainnet candidate scores. Mainnet ingestion remains blocked pending official Pi documentation and independent review.

Official references reviewed:
- Pi Network, Pi Testnet RPC Server Released (April 8, 2026): https://minepi.com/blog/rpc-server/
- Pi Developer Documentation: https://developers.minepi.com/docs/docs/build-first-app/GettingStarted
- Pi Network, Ecosystem Summit Begins (November 2026): https://minepi.com/blog/ecosystem-summit-begins/
- Pi Network, New Pi Developer Capabilities & Documentation (September 4, 2026): https://minepi.com/blog/dev-capabilities-documentation/


## Immutable Testnet observation record (2026-11-26)

The Testnet policy module can now wrap a validated `getHealth` JSON-RPC response in a versioned audit observation:
- Requires an explicit, canonical UTC retrieval timestamp with millisecond precision.
- Records the exact allowlisted Testnet endpoint, method, request ID, response size, opaque result, and SHA-256 digest.
- The digest is over the UTF-8 bytes of `JSON.stringify(response)`; it is **not** a digest of the original HTTP wire bytes.
- The observation and nested result are deeply frozen and explicitly marked `eligibleForMainnetScoring: false`.
- The digest detects later changes relative to the same serialization procedure. It does not prove who supplied the response, that the response is truthful, or that it represents canonical Pi state.
- This remains a pure helper. It does not fetch RPC data, persist observations, or modify Launchpad scoring.


## Bounded Testnet observation archive (2026-11-26)

A pure archive-manifest helper now supports deterministic packaging and retrieval of already-created Testnet observations:
- Accepts only schema-v1 observations for the exact Testnet `getHealth` endpoint/method and requires `eligibleForMainnetScoring: false`.
- Enforces a maximum of 500 input records, 1 MiB per record, and 5 MiB total archive payload. These are prototype safety bounds, not retention policy.
- Computes a deterministic observation identity from network, endpoint, method, request ID, retrieval timestamp, and the existing serialized-response digest. Repeated identities are counted and omitted.
- Computes a canonical-JSON SHA-256 digest per archived record and a separate manifest digest. Verification recomputes both before retrieval.
- Canonical JSON sorts object keys, making archive digests independent of property insertion order. These hashes detect local record changes; they do not authenticate the RPC source or prove the original response was truthful.
- Retrieval is permitted only after the entire manifest passes validation and integrity checks.
- The helper is in-memory and pure: no filesystem/database persistence, network requests, RPC calls, AI quota, wallet access, signing, or scoring integration.

The archive does not recompute `serializedResponseSha256` from the stored result. That original digest covers the full normalized JSON-RPC response serialization, while the observation stores only its opaque result and metadata. The archive's own canonical record digest protects the stored observation after packaging, without overstating what can be independently reconstructed.


## Storage authorization boundary (2026-11-26)

A storage-policy prototype now prepares a future server-side persistence adapter without performing storage I/O:
- Requires an explicit policy with a named archive scope, retention period (1-3650 days), and maximum archive size (up to 5 MiB).
- Separates `archive_writer`, `archive_reader`, and `archive_admin` permissions. Only append, read, list, and verify intents are recognized; delete and overwrite actions are denied.
- Append intent requires a complete archive to pass its manifest and record integrity checks before a bounded canonical payload is produced.
- Read intent is scope-bound and does not return archive data; the eventual adapter must enforce scope again and re-verify integrity after retrieval.
- The retention value is policy metadata only. No expiry, purge, or deletion scheduler exists, and no data is actually stored.
- The principal must be resolved from a trusted server-side authenticated session. Client-supplied role claims are not an authentication source.
- No database, Cloudflare D1, filesystem, object store, encryption key, or secret is configured or accessed. Encryption-at-rest and actual access enforcement remain requirements for a future independently reviewed adapter.
- This module does not feed Launchpad scoring or change Mainnet evidence eligibility.

The implementation emits immutable write/read intents only. It is not a persistent storage implementation and must not be described as one.

## Volatile Testnet observation repository contract (2026-11-26)

A process-local in-memory repository prototype now exercises the future adapter contract:
- Accepts only append/read intent shapes scoped to the configured archive scope, and validates payload size, archive ID digest, and the complete archive manifest before insertion.
- Append is idempotent for the same archive ID and never overwrites an existing entry. Entry count and aggregate memory use are bounded.
- Reads re-check the stored payload digest and re-run full archive integrity verification before returning a deeply frozen copy.
- Wrong-scope intents, wrong operation types, malformed payloads, digest mismatches, and capacity overflow fail closed.
- The repository is volatile and process-local. It provides no durability, cross-process sharing, authentication, encryption-at-rest, retention enforcement, deletion lifecycle, or audit log. The caller must obtain intents from trusted server-side authorization; this prototype does not authenticate principals itself.
- The module performs no filesystem, database, D1, object-store, network, AI, wallet, signing, or scoring operations. Testnet observations remain ineligible for Mainnet scoring.

This is a contract-test prototype only. It is not production storage and must not be connected to user-facing or live ingestion paths.

## Testnet archive authenticated-encryption boundary (2026-11-26)

A pure AES-256-GCM envelope helper now encrypts and decrypts already-verified Testnet archive manifests:
- Requires a caller-supplied 32-byte key, a bounded key ID, and an explicit archive scope. The module never generates, stores, logs, or returns key material.
- Uses a fresh 96-bit random nonce for each encryption and a 128-bit authentication tag. Schema version, algorithm, archive scope, archive digest, and key ID are authenticated as additional authenticated data.
- Decryption requires an explicitly supplied key and matching key ID; optional caller scope must match. Authentication failure, altered ciphertext/tag/metadata, malformed encoding, or digest mismatch fails closed without returning partial plaintext.
- Decrypted content must pass the complete Testnet archive verifier and match its canonical serialization and archive digest.
- The helper performs no filesystem, database, D1, KMS, secret-manager, network, AI, wallet, signing, or scoring operations.

Critical limitations:
- This is an encryption primitive and envelope contract, not encryption-at-rest integration. No key custody, secure key retrieval, rotation schedule, revocation, backup, access-control enforcement, or audit logging is implemented.
- A production adapter must obtain keys from a reviewed server-side KMS/secret-management design, enforce key ID to key mapping, isolate scopes/tenants, rotate keys safely, and never accept key bytes from clients.
- The supplied test keys are fixtures only. Do not reuse them outside tests.
- Testnet observations remain explicitly ineligible for Mainnet scoring.


## Testnet archive keyring and rotation contract (2026-11-26)

Two pure helpers now define a safer application-side key lifecycle boundary:
- The keyring accepts a bounded set of explicitly injected 32-byte key records, rejects duplicate IDs and malformed records, and requires an available, non-revoked active key.
- Encryption uses only the explicitly selected active key. Historical non-revoked keys may be resolved for decryption; unknown and revoked keys fail closed.
- Key material is copied when accepted and when returned by the resolver. The helpers do not generate, persist, log, or retrieve secrets. Production callers must inject keys only from trusted server-side secret management and must never accept client-provided key bytes.
- The rotation helper decrypts and fully verifies the source archive, encrypts it under the active key with a fresh nonce, then decrypts and verifies the destination envelope before returning it. The archive identity must remain unchanged.
- Rotation returns a new envelope in memory only. It does not overwrite or persist the old envelope, perform atomic replacement, revoke old keys, schedule rotation, or create backups. A separately reviewed persistence adapter must manage safe replacement and retention.
- Test fixtures are not production keys. No D1, KMS, secret manager, filesystem, network, Workers AI, wallet, signing, or Launchpad scoring integration is introduced.
- All observations remain Testnet-only and explicitly ineligible for Mainnet scoring.


## Compare-and-swap archive replacement intent (2026-11-26)

A pure replacement-intent helper now defines the preconditions for safely installing a rotated archive envelope:
- Verifies both source and replacement envelopes by decrypting them with explicitly resolved, non-revoked keys and checking the complete archive integrity.
- Requires the same archive identity and scope, a different key ID, and an exact expected SHA-256 digest of the currently stored source envelope serialization.
- Emits a bounded compare-and-swap intent containing the expected current digest and the verified replacement envelope digest. A stale expected digest fails closed.
- Performs no storage read, write, transaction, or persistence. It does not make replacement atomic by itself.
- A future storage adapter must atomically compare the stored digest and replace the envelope in one transaction, leaving the original unchanged on conflict or failure. It must re-verify the replacement after reading it back.
- No D1, filesystem, KMS, secret manager, network, Workers AI, wallet, signing, or scoring integration is introduced. Testnet observations remain ineligible for Mainnet scoring.


## Archive replacement crash-recovery journal contract (2026-11-26)

A pure, bounded replacement-journal state machine now specifies crash recovery for a future atomic storage adapter:
- Creates hash-linked immutable records for a replacement's prepared and terminal states (committed or aborted).
- The record chain binds archive scope, archive identity, source envelope digest, replacement envelope digest, sequence number, and previous-record digest.
- The verifier rejects broken hashes, reordered records, illegal transitions, mismatched archive identities, and invalid observed digests.
- Recovery classification is conservative: if storage still has the source digest, a compare-and-swap retry may be considered; if it has the replacement digest, the adapter may record completion; any third digest requires manual reconciliation and must not be overwritten automatically.
- The helper is pure and in-memory. It does not write a journal, make a database transaction, guarantee durability, or provide rollback. A production adapter must atomically persist the prepared record, perform the compare-and-swap, and persist the terminal record with crash-safe transaction semantics.
- Hash chaining provides local tamper evidence only, not signer authenticity or protection against an attacker who can rewrite the entire journal. Testnet observations remain ineligible for Mainnet scoring.


## Server-restart recovery authorization gate (2026-11-26)

A read-only recovery gate now sits above the replacement journal:
- Requires a server-resolved authenticated principal with the archive_admin role, an accepted server-side keyring, an exact archive scope, the full journal, and the currently observed envelope.
- Revalidates the journal hash chain and legal prepared state before considering recovery.
- Decrypts and verifies the observed envelope with the key selected by its key ID, then checks that its archive identity matches the journal.
- If the source digest is still present, it emits a recommendation to rebuild a fresh compare-and-swap intent after fresh authorization.
- If the replacement digest is present, it emits a recommendation to persist a terminal commit record only after read-back verification.
- If a different but valid envelope is present, it requires manual reconciliation. Invalid, unauthenticated, wrong-scope, or undecryptable inputs fail closed.
- This is a pure decision helper, not authentication middleware or a persistence transaction. The production adapter must derive principal and keyring from trusted server-side systems, reauthorize at write time, and atomically persist the journal and compare-and-swap result. No rollback, overwrite, deletion, database access, AI, wallet, or Mainnet scoring is performed.


## Injected atomic replacement transaction contract (2026-11-26)

A transaction-orchestration contract now describes the exact sequence a future durable adapter must execute:
1. Re-authorize the authenticated server-side archive administrator inside the transaction and bind the operation to one archive scope and archive ID.
2. Read the current envelope and journal within that same transaction; reject missing/wrong-scope envelopes or an existing replacement journal.
3. Recompute the current envelope serialization digest and require an exact match with the replacement intent's expected source digest.
4. Append the immutable `prepared` journal record.
5. Perform compare-and-swap replacement against the exact source digest. A conflict throws and must roll back the prepared record.
6. Read the replacement back inside the same transaction and verify its exact envelope digest.
7. Append the linked `committed` journal record and re-read/verify the complete two-record journal before allowing commit.

The orchestration module accepts only an injected provider that declares atomic-transaction support and supplies the required transaction-scoped methods. Any failed authorization, source mismatch, CAS conflict, failed read-back, or invalid final journal throws so the provider must roll back all writes. It does not silently retry, overwrite, roll back manually, or purge the previous envelope.

**Important boundary:** a capability flag is not proof that an adapter is truly atomic. The concrete adapter must be independently tested against its database's transaction semantics, including concurrent writers, process termination, commit failures, and rollback behavior. If the storage backend cannot guarantee all-or-nothing execution across the envelope and journal writes, it must not be used for this protocol.

This increment adds no Cloudflare D1 binding, database credentials, persistence, KMS integration, network access, Workers AI usage, wallet access, signing, or Mainnet scoring. The included tests use an in-memory transaction-provider simulation to verify orchestration order and rollback expectations; they do not establish production durability. Testnet archives remain ineligible for Mainnet scoring.
