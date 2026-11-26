import assert from "node:assert/strict";
import test from "node:test";
import { getPrivatePatchArtifactPath } from "./intelligence-private-patch-store.mjs";

test("builds a canonical month-partitioned path for a valid UUID v4", () => {
  assert.equal(
    getPrivatePatchArtifactPath({
      createdAt: "2026-11-26T00:00:00.000Z",
      proposalId: "123e4567-e89b-42d3-a456-426614174000"
    }),
    "patch-proposals/2026/11/123e4567-e89b-42d3-a456-426614174000.json"
  );
});

test("rejects malformed proposal identifiers and timestamps", () => {
  for (const proposalId of [
    "------------------------------------",
    "123e4567-e89b-12d3-a456-426614174000",
    "../123e4567-e89b-42d3-a456-426614174000"
  ]) {
    assert.throws(() => getPrivatePatchArtifactPath({
      createdAt: "2026-11-26T00:00:00.000Z", proposalId
    }), TypeError);
  }
  for (const createdAt of [
    "2026-11-26",
    "not-a-date",
    { toString: () => "2026-11-26T00:00:00.000Z" }
  ]) {
    assert.throws(() => getPrivatePatchArtifactPath({
      createdAt, proposalId: "123e4567-e89b-42d3-a456-426614174000"
    }), TypeError);
  }
});
