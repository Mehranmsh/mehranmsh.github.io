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

## Explicit exclusions

This design does not authorize live ingestion or scraping; guessed Horizon/RPC endpoints; wallet access, key handling, signing, or transactions; automatic buy/sell recommendations; claims that a signed statement proves on-chain truth; or enabling paid AI services or Cloudflare Workers AI.

The analyzer must continue to display missing on-chain evidence as unknown until the complete verification path above is implemented and independently reviewed.
