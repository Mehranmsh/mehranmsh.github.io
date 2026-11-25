/**
 * Bounded self-verification and repair orchestration for MEHRAN INTELLIGENCE.
 *
 * The caller supplies isolated verification and an explicitly allowlisted repair
 * function. This module never executes shell commands, reads secrets, deploys,
 * or mutates production state. Repair callbacks must enforce their own scope.
 */
const MAX_ATTEMPTS = 3;

function safeSummary(value, max = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

export async function runVerificationLoop({
  verify,
  repair,
  rollback,
  maxAttempts = MAX_ATTEMPTS,
  checkpoint = async () => {}
} = {}) {
  if (typeof verify !== "function") throw new TypeError("verify must be a function");
  if (repair !== undefined && typeof repair !== "function") throw new TypeError("repair must be a function");
  if (rollback !== undefined && typeof rollback !== "function") throw new TypeError("rollback must be a function");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
    throw new RangeError("maxAttempts must be between 1 and 3");
  }

  const history = [];
  let lastVerification = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result;
    try {
      result = await verify({ attempt });
    } catch (error) {
      result = { passed: false, code: "verification_exception", summary: safeSummary(error?.message || error) };
    }
    const passed = result?.passed === true;
    const record = {
      attempt,
      passed,
      code: safeSummary(result?.code || (passed ? "verified" : "verification_failed"), 80),
      summary: safeSummary(result?.summary)
    };
    history.push(record);
    lastVerification = result;
    await checkpoint({ phase: "verified", attempt, passed, history: [...history] });

    if (passed) {
      return { status: "verified", attempts: attempt, history, verification: record };
    }
    if (attempt === maxAttempts || typeof repair !== "function") break;

    let repairResult;
    try {
      repairResult = await repair({
        attempt,
        failure: record,
        verification: result,
        // Explicitly bounded context. No credentials or unrestricted environment.
        allowed: true
      });
    } catch (error) {
      repairResult = { changed: false, safe: false, summary: safeSummary(error?.message || error) };
    }
    const repairRecord = {
      attempt,
      changed: repairResult?.changed === true,
      safe: repairResult?.safe === true,
      summary: safeSummary(repairResult?.summary)
    };
    history.push({ phase: "repair", ...repairRecord });
    await checkpoint({ phase: "repair", attempt, repair: repairRecord, history: [...history] });
    if (!repairRecord.changed || !repairRecord.safe) break;
  }

  let rollbackResult = null;
  if (typeof rollback === "function") {
    try {
      rollbackResult = await rollback({ reason: "verification_not_passed", history: [...history] });
    } catch (error) {
      rollbackResult = { restored: false, summary: safeSummary(error?.message || error) };
    }
  }
  return {
    status: rollbackResult?.restored === true ? "rolled_back" : "needs_attention",
    attempts: history.filter(item => Number.isInteger(item.attempt) && item.passed !== undefined).length,
    history,
    verification: lastVerification ? {
      passed: lastVerification.passed === true,
      code: safeSummary(lastVerification.code || "verification_failed", 80),
      summary: safeSummary(lastVerification.summary)
    } : null,
    rollback: rollbackResult ? {
      restored: rollbackResult.restored === true,
      summary: safeSummary(rollbackResult.summary)
    } : null
  };
}

export const INTELLIGENCE_VERIFICATION_MAX_ATTEMPTS = MAX_ATTEMPTS;
