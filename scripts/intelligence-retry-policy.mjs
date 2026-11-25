const TRANSIENT_ERROR_PATTERN = /timeout|abort|fetch failed|network|HTTP 5[0-9]{2}|temporarily unavailable|rate limit|429|connection reset|upstream unavailable/i;

export function planIntelligenceRetry({ attempts = 0, maxAttempts = 3, error = "", now = Date.now(), baseDelaySeconds = 30, maxDelaySeconds = 3600 } = {}) {
  const used = Math.max(0, Number(attempts) || 0);
  const limit = Math.max(1, Number(maxAttempts) || 3);
  const delayBase = Math.max(1, Number(baseDelaySeconds) || 30);
  const delayCap = Math.max(delayBase, Number(maxDelaySeconds) || 3600);
  const retryableError = TRANSIENT_ERROR_PATTERN.test(String(error));
  const retryable = retryableError && used < limit;
  const delaySeconds = retryable ? Math.min(delayCap, delayBase * (2 ** Math.min(10, used))) : 0;
  const timestamp = Number(now);
  const nextAttemptAt = retryable && Number.isFinite(timestamp)
    ? new Date(timestamp + delaySeconds * 1000).toISOString()
    : null;
  return {
    retryable,
    exhausted: used >= limit,
    delaySeconds,
    nextAttemptAt,
    errorCode: retryable ? "transient_execution_error" : retryableError ? "retry_limit_reached" : "execution_blocked"
  };
}
