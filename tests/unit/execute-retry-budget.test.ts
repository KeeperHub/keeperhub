import { describe, expect, it, vi } from "vitest";

// The module chain reaches server-only helpers via lib/idempotency.
vi.mock("server-only", () => ({}));

import { DEFAULT_MAX_RETRIES } from "@/app/api/execute/_lib/retry";
import { validateRetryConfig } from "@/app/api/execute/_lib/retry-budget";
import { PROCESSING_TTL_MS } from "@/lib/idempotency";

/**
 * The budget keeps a direct-execution request's worst case inside the
 * idempotency processing lock it reserved. The route also re-stamps that lock
 * with a heartbeat, but the heartbeat is fire-and-forget, so the budget is the
 * invariant that holds without depending on it. It only holds if the number
 * of attempts it validates is the number the executor will actually run.
 */
describe("direct-execution retry budget", () => {
  it("sizes an omitted maxRetries at the executor's default, not at zero", () => {
    // The reported case: this passed validation as a single 600s attempt
    // while resolveConfig would run four of them.
    const result = validateRetryConfig({ timeoutMs: 600_000 });

    expect(DEFAULT_MAX_RETRIES).toBe(3);
    expect((DEFAULT_MAX_RETRIES + 1) * 600_000).toBeGreaterThan(
      PROCESSING_TTL_MS
    );
    expect(result.valid).toBe(false);
  });

  it("explains the rejection in terms the caller did not set", () => {
    // The only newly rejected shape omits maxRetries, so a message quoting
    // "timeoutMs x (maxRetries + 1)" reads as 600000 x 1 and contradicts the
    // refusal. It has to state the count the executor will run and where it
    // came from.
    const result = validateRetryConfig({ timeoutMs: 600_000 });
    if (result.valid) {
      throw new Error("expected a rejection");
    }
    expect(result.error).toContain(
      `maxRetries was not set, so it defaults to ${DEFAULT_MAX_RETRIES}`
    );
    expect(result.error).toContain(`up to ${DEFAULT_MAX_RETRIES + 1} attempts`);
  });

  it("points at the safe fix, not the dangerous one", () => {
    // Lowering timeoutMs to keep four attempts is the obvious fix and the
    // wrong one for a write: a timed-out attempt can still broadcast while
    // the next signs, putting two transactions on chain. maxRetries: 0 keeps
    // the long timeout and is still accepted.
    const result = validateRetryConfig({ timeoutMs: 600_000 });
    if (result.valid) {
      throw new Error("expected a rejection");
    }
    expect(result.error).toContain("set retry.maxRetries to 0");
    // Checked before the action is resolved, so the reason has to hold for a
    // step that sends no transaction as well as for a write.
    expect(result.error).toContain(
      "a timed-out attempt is abandoned, not cancelled, and can still complete"
    );
    expect(result.error).not.toContain("broadcast");
    expect(
      validateRetryConfig({ maxRetries: 0, timeoutMs: 600_000 }).valid
    ).toBe(true);
  });

  it("names a maxRetries the caller did set, rather than a default", () => {
    const result = validateRetryConfig({ maxRetries: 10, timeoutMs: 600_000 });
    if (result.valid) {
      throw new Error("expected a rejection");
    }
    expect(result.error).toContain("maxRetries is 10");
    expect(result.error).not.toContain("was not set");
  });

  it("still accepts a request whose real worst case fits", () => {
    const perAttempt = Math.floor(
      PROCESSING_TTL_MS / (DEFAULT_MAX_RETRIES + 1)
    );
    expect(validateRetryConfig({ timeoutMs: perAttempt }).valid).toBe(true);
  });

  it("accepts an empty retry object at the executor's defaults", () => {
    // Pinned as a literal rather than derived from the same formula the
    // implementation uses: raise DEFAULT_TIMEOUT_MS enough and every request
    // sending `retry: {}` would start failing, and a derived expectation
    // would stay green through it.
    expect(validateRetryConfig({}).valid).toBe(true);
  });

  it("keeps rejecting the shapes it already rejected", () => {
    expect(validateRetryConfig({ maxRetries: -1 }).valid).toBe(false);
    expect(validateRetryConfig({ maxRetries: 11 }).valid).toBe(false);
    expect(validateRetryConfig({ timeoutMs: 999 }).valid).toBe(false);
    expect(validateRetryConfig({ timeoutMs: 600_001 }).valid).toBe(false);
    expect(validateRetryConfig({ maxRetries: "3" }).valid).toBe(false);
  });

  it("still refuses a retry that is not an object", () => {
    // The guard the move out of the route could have dropped silently.
    for (const raw of [null, [], "x", 3, undefined]) {
      expect(validateRetryConfig(raw).valid, JSON.stringify(raw)).toBe(false);
    }
  });
});
