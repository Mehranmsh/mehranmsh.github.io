const TRANSIENT_MESSAGE = /timeout|abort|fetch failed|network|temporarily unavailable|rate limit|429|connection reset|connection refused|socket hang up|upstream unavailable|HTTP 5[0-9]{2}/i;

/**
 * Decide whether a failed runner task may be retried by the Worker's bounded
 * exponential-backoff policy. Provider inference failures are always held so
 * a quota or provider outage cannot trigger repeated AI consumption.
 */
export function shouldRetryIntelligenceRunnerTask(error, actionType = "") {
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  if (error.safeDiagnostic?.stage === "workers_ai_inference") return false;

  const status = Number(error.status);
  if (status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599)) {
    return true;
  }

  const name = typeof error.name === "string" ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError" || name === "TypeError") {
    return true;
  }

  const message = typeof error.message === "string" ? error.message : String(error.message ?? "");
  if (actionType === "propose_code_patch" && status === 409 &&
      /already in progress|concurrently reserved/i.test(message)) {
    return true;
  }

  return TRANSIENT_MESSAGE.test(message);
}
