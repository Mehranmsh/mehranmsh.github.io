# Pi Launchpad Analyzer MVP

Status: deterministic local screening engine, version 0.1.0.

## What is implemented
- Weighted, explainable opportunity scoring across utility, team transparency, tokenomics, market activity, liquidity, contract security, and source verification.
- Evidence coverage and confidence labels so incomplete projects cannot look fully verified.
- Pi-denominated liquidity metrics: 24h turnover and FDV-to-pool-liquidity ratio.
- Explicit risk flags for unverified contracts, unreviewed owner privileges, holder concentration, low locked-liquidity share, and extreme FDV/liquidity ratios.
- Critical-risk score cap for explicit severe flags such as honeypot, exploit, malicious code, fake team, or rug indicators.
- Pure deterministic local code. No network calls, Workers AI, wallet access/signing, trading, or billing.
- A provenance-aware envelope validator in `scripts/pi-launchpad-data-adapter.mjs`, with bounded source/evidence counts, HTTPS-only source references, UTC timestamps, and 24-hour freshness checks.
- An evidence ledger that excludes every self-asserted trust label from scoring. The separate signature verifier does not automatically make evidence score-eligible.
- An Ed25519 attestation verifier in `scripts/pi-launchpad-attestation-verifier.mjs` that checks signed evidence payloads against an operator-provisioned trust store, including signer revocation, issuer identity, exact source-origin and evidence-field scopes, freshness, payload bounds, plain-record validation, and URL constraints. Trust anchors are not provisioned in this branch. A valid signature authenticates the signer and payload integrity only; it does not prove the claim is true, and verified attestations are not yet mapped into scoring.
- An operator-side trust-store loader in `scripts/pi-launchpad-trust-store.mjs` that validates Ed25519 key fingerprints, issuer and source/field scopes, validity windows, duplicate IDs, and revocation. It ships with no trusted keys; trust anchors must be provisioned out-of-band.\n- A fail-closed evidence-to-score gateway in `scripts/pi-launchpad-evidence-gateway.mjs` that validates the raw envelope internally rather than trusting a caller-supplied validation result. It re-verifies raw Ed25519 attestations internally against operator trust records, then requires exact matches for token ID, evidence reference, field, source URL, observation timestamp, and value. Only five allowlisted component fields can pass; `sourceVerification`, liquidity metrics, and out-of-range values cannot be injected through this gateway. Duplicate/conflicting evidence is rejected. The gateway does not claim cryptographic verification proves factual or on-chain truth.
- A curated Pi-owned documentation source registry with exact-origin matching. Registry entries are documentation-only and disabled for live ingestion.
- A deny-by-default connector policy in `scripts/pi-launchpad-connector-policy.mjs`. It defines bounded future connector requirements (256 KiB response cap, 5-second timeout, zero redirects, exact registered target, independent source approval) but performs no network activity.
- A bounded batch-screening orchestrator in `scripts/pi-launchpad-batch-screen.mjs` that summarizes up to 500 supplied analyses, deduplicates token IDs, reports malformed records, and returns ranked/excluded counts plus average evidence coverage. It is not a live discovery crawler.
- A deterministic portfolio ranker in `scripts/pi-launchpad-portfolio-ranker.mjs` that prioritizes already-analyzed candidates, excludes critical-risk/insufficient/low-coverage entries, and applies bounded risk and snapshot-event penalties. It does not fetch data or make trading decisions.
- A deterministic snapshot-diff monitor in `scripts/pi-launchpad-snapshot-monitor.mjs` that detects material changes in Pi liquidity, 24-hour volume, top-holder concentration, locked-liquidity share, and screening score. It emits structured local events only; it does not persist history, fetch data, or send notifications.

## Input contract
Pass a normalized token snapshot to `analyzeLaunchpadOpportunity`. Evidence component scores must be independently justified values from 0 to 100. Liquidity values are denominated in Pi. Missing or invalid values remain unknown and reduce evidence coverage.

## Not implemented yet
- A verified-only analyzer integration in `scripts/pi-launchpad-verified-analyzer.mjs`. It accepts the raw envelope, attestations, and operator trust records, then passes only gateway-approved component scores to the analyzer. Unsigned snapshot evidence, liquidity, holder, contract, and risk fields are intentionally discarded, so those metrics remain unknown until their own verification paths exist.\n- Live Pi Launchpad/DEX discovery and authenticated source connectors. The current adapter validates submitted envelopes only; it does not fetch sources. The gateway authenticates signed claims against operator trust anchors, but does not independently establish that the underlying claim is true.
- Contract bytecode/source retrieval and automated security simulation.
- Holder-distribution ingestion, LP lock proof verification, and team identity verification.
- Telegram signal ingestion, historical performance tracking, alerts, and UI integration.

## Safety and interpretation
This is a screening tool, not a price predictor or investment recommendation. Scores are not probabilities. Never ingest untrusted project text as executable instructions. The current adapter retains source URL, retrieval time, observation time, field reference, and claimed trust label. The gateway verifies signatures and exact payload-to-envelope binding, but it does not verify raw-data hashes, source ownership, or on-chain truth. A claimed `independently_verified` label is never sufficient by itself to make evidence score-eligible. Trading, wallet, signing, and automatic investment actions remain out of scope.
