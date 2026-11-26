const TRANSIENT_ERROR_PATTERN = /timeout|abort|fetch failed|network|HTTP 5[0-9]{2}|temporarily unavailable|rate limit|429|connection reset|upstream unavailable/i;

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

export function planIntelligenceRetry({
  attempts = 0,
  maxAttempts = 3,
  error = "",
  now = Date.now(),
  baseDelaySeconds = 30,
  maxDelaySeconds = 3600
} = {}) {
  const used = boundedInteger(attempts, 0, 0, 1000000);
  const limit = boundedInteger(maxAttempts, 3, 1, 100);
  const delayBase = boundedInteger(baseDelaySeconds, 30, 1, 86400);
  const delayCap = boundedInteger(maxDelaySeconds, 3600, delayBase, 604800);
  let errorText = "";
  try {
    errorText = typeof error === "string" ? error : String(error ?? "");
  } catch {
    errorText = "";
  }
  const retryableError = TRANSIENT_ERROR_PATTERN.test(errorText);
  const retryable = retryableError && used < limit;
  const exponent = Math.min(20, Math.max(0, used - 1));
  const delaySeconds = retryable
    ? Math.min(delayCap, delayBase * (2 ** exponent))
    : 0;

  const timestamp = Number(now);
  const candidateTime = timestamp + delaySeconds * 1000;
  const validDate = retryable && Number.isFinite(timestamp) &&
    Number.isFinite(candidateTime) && Number.isFinite(new Date(candidateTime).getTime());
  const nextAttemptAt = validDate ? new Date(candidateTime).toISOString() : null;

  return {
    retryable,
    exhausted: used >= limit,
    delaySeconds,
    nextAttemptAt,
    errorCode: retryable ? "transient_execution_error" : retryableError ? "retry_limit_reached" : "execution_blocked"
  };
}
