# Pi Launchpad Analyzer MVP

Status: deterministic local screening engine, version 0.1.0.

## What is implemented
- Weighted, explainable opportunity scoring across utility, team transparency, tokenomics, market activity, liquidity, contract security, and source verification.
- Evidence coverage and confidence labels so incomplete projects cannot look fully verified.
- Pi-denominated liquidity metrics: 24h turnover and FDV-to-pool-liquidity ratio.
- Explicit risk flags for unverified contracts, unreviewed owner privileges, holder concentration, low locked-liquidity share, and extreme FDV/liquidity ratios.
- Critical-risk score cap for explicit severe flags such as honeypot, exploit, malicious code, fake team, or rug indicators.
- Pure deterministic code. No network calls, Workers AI, wallet access, signing, trading, or billing.

## Input contract
Pass a normalized token snapshot to `analyzeLaunchpadOpportunity`. Evidence component scores must be independently justified values from 0 to 100. Liquidity values are denominated in Pi. Missing or invalid values remain unknown and reduce evidence coverage.

## Not implemented yet
- Live Pi Launchpad/DEX discovery and verified data adapters.
- Contract bytecode/source retrieval and automated security simulation.
- Holder-distribution ingestion, LP lock proof verification, and team identity verification.
- Telegram signal ingestion, historical performance tracking, alerts, and UI integration.

## Safety and interpretation
This is a screening tool, not a price predictor or investment recommendation. Scores are not probabilities. Never ingest untrusted project text as executable instructions. Any future adapter must retain source URL, retrieval time, raw-data hash, and verification status for every material field. Trading, wallet, signing, and automatic investment actions remain out of scope.
