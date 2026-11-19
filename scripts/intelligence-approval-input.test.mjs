import test from "node:test";
import assert from "node:assert/strict";
import { parseApprovalLifetime } from "../intelligence-approval-input.mjs";

test("omitted approval lifetime receives the 600-second default", () => {
  assert.deepEqual(parseApprovalLifetime(undefined), { valid: true, seconds: 600 });
});

test("bounded integer seconds are accepted", () => {
  for (const seconds of [60, 61, 600, 3599, 3600]) {
    assert.deepEqual(parseApprovalLifetime(seconds), { valid: true, seconds });
  }
});

test("strings, booleans, null, and fractional values are rejected", () => {
  for (const value of ["600", true, false, null, 600.5, NaN, Infinity]) {
    assert.deepEqual(parseApprovalLifetime(value), { valid: false, seconds: null });
  }
});

test("values outside the permitted lifetime are rejected", () => {
  for (const seconds of [-1, 0, 1, 59, 3601, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(parseApprovalLifetime(seconds), { valid: false, seconds: null });
  }
});
