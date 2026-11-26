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
