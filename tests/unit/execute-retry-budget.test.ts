import { describe, expect, it, vi } from "vitest";

// The module chain reaches server-only helpers via lib/idempotency.
vi.mock("server-only", () => ({}));

import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
} from "@/app/api/execute/_lib/retry";
import { validateRetryConfig } from "@/app/api/execute/_lib/retry-budget";
import { PROCESSING_TTL_MS } from "@/lib/idempotency";

/**
 * The budget exists so a single direct-execution request cannot outlive the
 * idempotency processing lock it reserved and have a reclaimer take the slot
 * while it is still running. That only holds if the number of attempts it
 * validates is the number the executor will actually run.
 */
describe("direct-execution retry budget", () => {
  it("sizes an omitted maxRetries at the executor's default, not at zero", () => {
    // The reported case: this passed validation as a single 600s attempt
    // while resolveConfig would run four of them - 2.4M ms against a lock
    // that does not last that long.
    const result = validateRetryConfig({ timeoutMs: 600_000 });

    expect(DEFAULT_MAX_RETRIES).toBe(3);
    expect((DEFAULT_MAX_RETRIES + 1) * 600_000).toBeGreaterThan(
      PROCESSING_TTL_MS
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("retry budget");
    }
  });

  it("still accepts a request whose real worst case fits", () => {
    const perAttempt = Math.floor(
      PROCESSING_TTL_MS / (DEFAULT_MAX_RETRIES + 1)
    );
    expect(validateRetryConfig({ timeoutMs: perAttempt }).valid).toBe(true);
  });

  it("uses the stated maxRetries when the request supplies one", () => {
    // An explicit 0 means one attempt, so a timeout the default would have
    // rejected is admissible here. This is what separates the fix from
    // simply tightening the ceiling for everyone.
    expect(
      validateRetryConfig({ maxRetries: 0, timeoutMs: 600_000 }).valid
    ).toBe(true);
    expect(
      validateRetryConfig({ maxRetries: 10, timeoutMs: 600_000 }).valid
    ).toBe(false);
  });

  it("defaults the per-attempt timeout the same way", () => {
    // Neither field given: the worst case is the executor's own defaults.
    const result = validateRetryConfig({});
    const worstCase = (DEFAULT_MAX_RETRIES + 1) * DEFAULT_TIMEOUT_MS;
    expect(result.valid).toBe(worstCase <= PROCESSING_TTL_MS);
  });

  it("keeps rejecting the shapes it already rejected", () => {
    expect(validateRetryConfig({ maxRetries: -1 }).valid).toBe(false);
    expect(validateRetryConfig({ maxRetries: 11 }).valid).toBe(false);
    expect(validateRetryConfig({ timeoutMs: 999 }).valid).toBe(false);
    expect(validateRetryConfig({ timeoutMs: 600_001 }).valid).toBe(false);
    expect(validateRetryConfig({ maxRetries: "3" }).valid).toBe(false);
  });
});
