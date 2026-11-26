import test from "node:test";
import assert from "node:assert/strict";
import { validateLaunchpadDataEnvelope, buildLaunchpadEvidenceLedger } from "./pi-launchpad-data-adapter.mjs";

const NOW = Date.parse("2026-11-26T12:00:00Z");
const validEnvelope = () => ({
  schemaVersion: 1,
  tokenId: "pi-token-42",
  observedAt: "2026-11-26T11:30:00Z",
  sources: [{
    sourceId: "dex-indexer-a",
    kind: "dex_indexer",
    url: "https://data.example.org/pools/pi-token-42",
    trustLevel: "independently_verified",
    retrievedAt: "2026-11-26T11:31:00Z",
    evidence: [
      { field: "liquidity.tvlPi", value: 25000, trustLevel: "independently_verified", observedAt: "2026-11-26T11:30:00Z", reference: "pool:abc" },
      { field: "teamTransparency", value: 90, trustLevel: "publisher_claim", observedAt: "2026-11-26T11:30:00Z", reference: "project:team-page" }
    ]
  }]
});

test("accepts bounded provenance envelope without claiming source truth", () => {
  const result = validateLaunchpadDataEnvelope(validEnvelope(), { now: NOW });
  assert.equal(result.accepted, true);
  assert.equal(result.evidenceCount, 2);
  assert.match(result.trustNotice, /require independent verification/);
});

test("rejects stale snapshot and stale individual evidence", () => {
  const stale = validEnvelope();
  stale.observedAt = "2026-11-24T11:30:00Z";
  assert.equal(validateLaunchpadDataEnvelope(stale, { now: NOW }).code, "stale_observation");
  const staleItem = validEnvelope();
  staleItem.sources[0].evidence[0].observedAt = "2026-11-24T11:30:00Z";
  assert.equal(validateLaunchpadDataEnvelope(staleItem, { now: NOW }).code, "stale_evidence");
});

test("rejects unsafe URL schemes, credentials, ports, and duplicate source IDs", () => {
  const unsafe = validEnvelope();
  unsafe.sources[0].url = "http://data.example.org/feed";
  assert.equal(validateLaunchpadDataEnvelope(unsafe, { now: NOW }).code, "invalid_source_record");
  const duplicate = validEnvelope();
  duplicate.sources.push({ ...duplicate.sources[0] });
  assert.equal(validateLaunchpadDataEnvelope(duplicate, { now: NOW }).code, "invalid_source_record");
});

test("rejects future timestamps and unsupported source trust labels", () => {
  const future = validEnvelope();
  future.observedAt = "2026-11-27T12:00:00Z";
  assert.equal(validateLaunchpadDataEnvelope(future, { now: NOW }).code, "future_observation");
  const trust = validEnvelope();
  trust.sources[0].trustLevel = "trusted";
  assert.equal(validateLaunchpadDataEnvelope(trust, { now: NOW }).code, "invalid_source_record");
});

test("ledger excludes all self-asserted trust labels from scoring", () => {
  const result = validateLaunchpadDataEnvelope(validEnvelope(), { now: NOW });
  const ledger = buildLaunchpadEvidenceLedger(result);
  assert.equal(ledger[0].usableForScoring, false);
  assert.equal(ledger[1].usableForScoring, false);
  assert.match(ledger[0].scoringNote, /attestation verifier/);
});

test("rejects missing provenance, object-valued evidence, and overlarge batches", () => {
  const missing = validEnvelope();
  delete missing.sources[0].evidence[0].reference;
  assert.equal(validateLaunchpadDataEnvelope(missing, { now: NOW }).code, "invalid_evidence_item");
  const objectValue = validEnvelope();
  objectValue.sources[0].evidence[0].value = { forged: true };
  assert.equal(validateLaunchpadDataEnvelope(objectValue, { now: NOW }).code, "invalid_evidence_item");
  const large = validEnvelope();
  large.sources[0].evidence = Array.from({ length: 81 }, (_, i) => ({
    field: "field-" + i, value: i, trustLevel: "unverified",
    observedAt: "2026-11-26T11:30:00Z", reference: "ref-" + i
  }));
  assert.equal(validateLaunchpadDataEnvelope(large, { now: NOW }).code, "evidence_limit");
});

test("rejects inherited-property envelope, source, and evidence records", () => {
  const inheritedEnvelope = Object.assign(Object.create({ schemaVersion: 1 }), {
    tokenId: "pi-token-42", observedAt: "2026-11-26T11:30:00Z", sources: []
  });
  assert.equal(validateLaunchpadDataEnvelope(inheritedEnvelope, { now: NOW }).code, "invalid_envelope");
  const inheritedSource = Object.assign(Object.create({ sourceId: "spoofed" }), {
    kind: "dex_indexer", url: "https://data.example.org/pool",
    trustLevel: "publisher_claim", retrievedAt: "2026-11-26T11:31:00Z", evidence: []
  });
  const badSource = validEnvelope();
  badSource.sources = [inheritedSource];
  assert.equal(validateLaunchpadDataEnvelope(badSource, { now: NOW }).code, "invalid_source_record");
  const inheritedEvidence = Object.assign(Object.create({ field: "utility" }), {
    value: 50, trustLevel: "publisher_claim", observedAt: "2026-11-26T11:30:00Z", reference: "ref"
  });
  const badEvidence = validEnvelope();
  badEvidence.sources[0].evidence = [inheritedEvidence];
  assert.equal(validateLaunchpadDataEnvelope(badEvidence, { now: NOW }).code, "invalid_evidence_item");
});
