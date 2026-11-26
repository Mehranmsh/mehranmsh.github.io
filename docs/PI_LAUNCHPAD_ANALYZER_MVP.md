# Pi Launchpad Analyzer MVP

Status: deterministic local screening engine with separate signed-evidence gateways.

## Implemented
- Weighted, explainable scoring across utility, team transparency, tokenomics, market activity, liquidity, contract security, and source verification.
- Evidence coverage and confidence labels. Missing or invalid data remains unknown.
- Pi-denominated liquidity calculations: 24-hour turnover and FDV-to-pool-liquidity ratio.
- Explicit risk signals for unverified contract source, unreviewed owner privileges, concentrated holders, low locked-liquidity share, and extreme FDV/liquidity ratios.
- Critical-risk score cap for explicit severe indicators such as honeypot, exploit, malicious code, fake team, or rug signals.
- Provenance-aware envelope validation with bounded sources/evidence, HTTPS references, UTC timestamps, and freshness checks.
- Ed25519 attestation verification against operator-provisioned trust anchors, including issuer, source-origin and field scopes, revocation, freshness, payload bounds, and signature validation.
- Operator-side trust-store validation for Ed25519 key fingerprints, issuer/scopes, validity windows, duplicate IDs, and revocation. No trust anchors ship in this branch.
- Fail-closed component-score gateway. It validates the raw envelope, re-verifies signatures, and requires exact token, evidence reference, field, source URL, timestamp, and value matches. Only five component-score fields are allowed; sourceVerification and market metrics are excluded.
- Separate fail-closed market-metrics gateway in `scripts/pi-launchpad-metrics-gateway.mjs`. It independently verifies and maps only:
  - `liquidity.tvlPi`
  - `liquidity.volume24hPi`
  - `liquidity.lockedPercent`
  - `market.fdvPi`
  - `holders.top10Percent`
- Metric constraints: Pi-denominated amounts must be finite and nonnegative; percentage values must be finite and within 0..100. Unknown fields, score fields, mismatched payloads, duplicate evidence, and conflicting attestations fail closed.
- Verified analyzer integration passes only gateway-approved scores and metrics into the deterministic analyzer. Unsigned snapshot metrics, risk flags, contract fields, and other claims are discarded.
- Curated Pi-owned documentation source registry with exact-origin matching; entries are documentation-only and disabled for live ingestion.
- Deny-by-default connector policy describing future bounded connector requirements. No network activity is performed.
- Batch screening for up to 500 supplied analyses, duplicate handling, coverage summaries, and exclusions.
- Deterministic portfolio prioritization and snapshot-diff monitoring. Neither fetches data nor makes trading decisions.

- Bounded manual candidate intake for up to 500 operator-supplied Pi Mainnet candidate claims, with identity validation, safe HTTPS reference checks, deduplication, and explicit unverified/evidence-pending states. It does not crawl, fetch, trust, or score candidates.\n\n## Important limitations
- No live Pi Launchpad/DEX discovery or API ingestion.
- No on-chain reads, raw-data hash verification, independent source ownership checks, or proof that signed claims are factually accurate.
- Ed25519 proves signer identity relative to an operator trust anchor and payload integrity only. It does not prove on-chain truth.
- Trust anchors must be provisioned and governed out-of-band. A signed claim from a trusted key is not automatically an authoritative blockchain fact.
- Contract bytecode analysis, automated security simulation, LP-lock proof verification, holder-source validation, and team identity verification are not implemented.
- No Workers AI, external network calls, wallet access, signing transactions, trading, or billing.

## Input and interpretation
Pass normalized snapshots to `analyzeLaunchpadOpportunity`. Pi-denominated amounts must be expressed in Pi. Scores are screening signals, not probabilities, price predictions, or investment recommendations. Never treat untrusted project text as executable instructions.


## Provenance-aware evidence registry projection

The pure helper in `scripts/pi-launchpad-evidence-registry.mjs` projects validated envelope evidence into stable, immutable registry records. Each record carries:
- deterministic record ID, evidence reference, network ID, and asset identifier;
- evidence type derived from the declared source kind;
- exact source identity, URL, claimed trust label, and retrieval timestamp;
- field/value and observation timestamp;
- explicit verification state: `unverified`, `signature_verified`, or `attestation_rejected`;
- a separate `chainVerificationStatus: not_verified` and blocked scoring state.

This is an in-memory projection, not persistent storage or a live feed. A valid Ed25519 attestation upgrades only signer/payload verification. It never upgrades chain verification or factual truth, and this registry does not authorize scoring. Mainnet and Testnet labels remain separate. No network requests, wallet actions, transactions, or billing are involved.


## Proposed D1 evidence persistence schema

A separate review-only SQL proposal is provided at `scripts/sql/pi-launchpad-evidence-registry-d1-schema.sql`. It defines an append-only evidence-record table with:
- deterministic record IDs and explicit Pi Mainnet/Testnet partition labels;
- bounded evidence classes and JSON-validated provenance metadata;
- signer/payload verification states kept separate from chain verification;
- database constraints that force `chain_verification_status = not_verified` and keep scoring blocked;
- database triggers that reject updates and deletes, preserving the original evidence projection.

SQLite compatibility tests exercise these constraints locally. This is a schema proposal only: it has not been applied to Cloudflare D1, no persistence adapter or credentials are configured, and no live data is written. A future verification result must be represented as a separate append-only event or record after independent design/review, never by mutating this original evidence row.
