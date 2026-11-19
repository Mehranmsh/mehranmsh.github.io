/**
 * Strict parser for owner-issued approval lifetimes.
 * Missing values use the documented default; supplied values must be JSON numbers.
 */
export function parseApprovalLifetime(value) {
  if (value === undefined) return { valid: true, seconds: 600 };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 60 || value > 3600) {
    return { valid: false, seconds: null };
  }
  return { valid: true, seconds: value };
}
