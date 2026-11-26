import test from "node:test";
import assert from "node:assert/strict";
import {
  preparePiLaunchpadCandidateIntake,
  PI_LAUNCHPAD_CANDIDATE_INTAKE_MAX
} from "./pi-launchpad-candidate-intake.mjs";

test("accepts a minimal manual candidate but keeps network and evidence unverified", () => {
  const result = preparePiLaunchpadCandidateIntake([{ tokenId: "asset:issuer:ABC", name: "Example" }]);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.candidates[0].claimedNetworkId, "pi-mainnet");
  assert.equal(result.candidates[0].networkVerification, "unverified");
  assert.equal(result.candidates[0].scoringStatus, "blocked_pending_verified_evidence");
});

test("normalizes safe HTTPS references and removes duplicate URLs", () => {
  const result = preparePiLaunchpadCandidateIntake([{
    tokenId: "asset-1", name: "Example",
    references: ["https://example.org/project", "https://example.org/project"]
  }]);
  assert.deepEqual(result.candidates[0].references, ["https://example.org/project"]);
});

test("rejects HTTP, credentials, fragments, localhost, local and IP references", () => {
  const refs = [
    "http://example.org", "https://user:pass@example.org/a",
    "https://example.org/a#fragment", "https://localhost/a",
    "https://node.local/a", "https://127.0.0.1/a", "javascript:alert(1)"
  ];
  for (const reference of refs) {
    const result = preparePiLaunchpadCandidateIntake([{
      tokenId: "asset-" + refs.indexOf(reference), name: "Example", references: [reference]
    }]);
    assert.equal(result.candidateCount, 0, reference);
    assert.equal(result.rejected[0].reason, "unsafe_or_invalid_reference");
  }
});

test("rejects missing identities and malformed records", () => {
  const result = preparePiLaunchpadCandidateIntake([null, {}, { tokenId: "x" }, { name: "x" }]);
  assert.equal(result.candidateCount, 0);
  assert.equal(result.rejected.length, 4);
});

test("deduplicates token IDs without silently replacing the first valid record", () => {
  const result = preparePiLaunchpadCandidateIntake([
    { tokenId: "same", name: "First" }, { tokenId: "same", name: "Second" }
  ]);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.candidates[0].name, "First");
  assert.equal(result.rejected[0].reason, "duplicate_token_id");
});

test("an invalid row does not reserve a token ID against a later valid row", () => {
  const result = preparePiLaunchpadCandidateIntake([
    { tokenId: "same", name: "Invalid", symbol: "S".repeat(25) },
    { tokenId: "same", name: "Valid", symbol: "OK" }
  ]);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.candidates[0].name, "Valid");
  assert.equal(result.rejectedCount, 1);
  assert.equal(result.rejected[0].reason, "invalid_symbol");
});

test("rejects Testnet and other network claims from the Mainnet intake", () => {
  const result = preparePiLaunchpadCandidateIntake([
    { tokenId: "test", name: "Test", claimedNetworkId: "pi-testnet" }
  ]);
  assert.equal(result.candidateCount, 0);
  assert.equal(result.rejected[0].reason, "unsupported_network_claim");
});

test("rejects overlong fields, invalid symbols and excessive references", () => {
  const result = preparePiLaunchpadCandidateIntake([
    { tokenId: "x".repeat(181), name: "Example" },
    { tokenId: "y", name: "Example", symbol: "S".repeat(25) },
    { tokenId: "z", name: "Example", references: Array(11).fill("https://example.org") }
  ]);
  assert.deepEqual(result.rejected.map(x => x.reason), [
    "missing_or_invalid_token_id", "invalid_symbol", "invalid_reference_list"
  ]);
});

test("enforces the hard batch limit", () => {
  const result = preparePiLaunchpadCandidateIntake(
    Array(PI_LAUNCHPAD_CANDIDATE_INTAKE_MAX + 1).fill({ tokenId: "x", name: "Example" })
  );
  assert.equal(result.accepted, false);
  assert.equal(result.code, "candidate_limit_exceeded");
});
