import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  capRetriesByDeclaration,
  effectiveMaxRetries,
  executeWithRetry,
  genericRetryOptions,
  type TransactionResult,
  transactionRetryOptions,
} from "@/app/api/execute/_lib/retry";

/**
 * #2498: `stepFn.maxRetries` is a declaration the workflow runtime honours and
 * the direct-execution route ignored, so a step that said it must never be
 * retried was retried whenever the caller asked and the failure text looked
 * retryable.
 */
describe("capRetriesByDeclaration", () => {
  it("turns retries off when the step declares it must never be retried", () => {
    expect(
      capRetriesByDeclaration({ maxRetries: 5, timeoutMs: 1000 }, 0)
    ).toEqual({ maxRetries: 0, timeoutMs: 1000 });
  });

  it("caps a caller who asks for more than the step allows", () => {
    expect(capRetriesByDeclaration({ maxRetries: 5 }, 2)?.maxRetries).toBe(2);
  });

  it("lets a caller ask for fewer than the step allows", () => {
    expect(capRetriesByDeclaration({ maxRetries: 1 }, 4)?.maxRetries).toBe(1);
  });

  it("applies the declaration when the caller set no count of its own", () => {
    // The route's config may carry only a timeout, in which case the default
    // would otherwise be used and the declaration would not bind at all.
    expect(capRetriesByDeclaration({ timeoutMs: 1000 }, 1)?.maxRetries).toBe(1);
    expect(capRetriesByDeclaration({ timeoutMs: 1000 }, 0)?.maxRetries).toBe(0);
  });

  it("leaves a step that declares nothing alone", () => {
    const config = { maxRetries: 3 };
    expect(capRetriesByDeclaration(config, undefined)).toBe(config);
  });

  it("does not invent retries for a caller who sent no config", () => {
    // The declaration is a ceiling, not a default: no config means no retries,
    // which is this route's behaviour for a request that did not ask for any.
    expect(capRetriesByDeclaration(undefined, 3)).toBeUndefined();
  });

  it("fails closed on a declaration that cannot be read", () => {
    // The value crosses a dynamic import unvalidated, so a JS step that writes
    // maxRetries = "0" type-checks and ships. Treating that as absent retries the
    // step whose author believed they had opted out, which is the whole defect.
    const config = { maxRetries: 3 };
    expect(capRetriesByDeclaration(config, "0")?.maxRetries).toBe(0);
    expect(capRetriesByDeclaration(config, -1)?.maxRetries).toBe(0);
    expect(capRetriesByDeclaration(config, Number.NaN)?.maxRetries).toBe(0);
    expect(capRetriesByDeclaration(config, null)?.maxRetries).toBe(0);
    expect(capRetriesByDeclaration(config, {})?.maxRetries).toBe(0);
  });

  it("floors a fractional declaration so the step's own error survives", () => {
    // `attempt` is an integer, so a ceiling of 2.5 admits the same three attempts
    // as 2 does and the count is not what flooring fixes. What it fixes is which
    // branch ends the loop: at 2.5 the `attempt >= maxRetries` guard never
    // coincides, so the loop falls through to `exhausted` and the caller is told
    // "Max retries exceeded" instead of the error the step returned.
    expect(capRetriesByDeclaration({ maxRetries: 3 }, 2.5)?.maxRetries).toBe(2);
    expect(capRetriesByDeclaration({ maxRetries: 3 }, 0.5)?.maxRetries).toBe(0);
  });

  it("treats an unbounded declaration as no cap", () => {
    // No special case is needed for this: Math.floor(Infinity) is Infinity and
    // Math.min(x, Infinity) is x, so the floor-and-min above already returns the
    // caller's own number.
    expect(
      capRetriesByDeclaration({ maxRetries: 2 }, Number.POSITIVE_INFINITY)
        ?.maxRetries
    ).toBe(2);
  });

  it("does not re-fire a fetch that hangs when the step declares none", async () => {
    // The worst version of the double charge, and the one the generic branch
    // actually produces: genericRetryOptions.getError returns undefined, so a
    // non-web3 step never retries on error text and its only trigger is the
    // timeout, while withTimeout abandons the in-flight promise without
    // cancelling it. A paid fetch that exceeds timeoutMs was re-fired while the
    // first request was still in flight.
    let calls = 0;
    const hanging = (): Promise<never> => {
      calls += 1;
      return new Promise<never>(() => {
        // never settles
      });
    };

    const capped = await executeWithRetry(
      hanging,
      capRetriesByDeclaration({ maxRetries: 3, timeoutMs: 30 }, 0),
      genericRetryOptions
    );
    expect(calls).toBe(1);
    expect(capped.outcome).toBe("timeout");

    // Control: the same hang under a declaration that allows three, four calls.
    let controlCalls = 0;
    const hangingControl = (): Promise<never> => {
      controlCalls += 1;
      return new Promise<never>(() => {
        // never settles
      });
    };
    const retried = await executeWithRetry(
      hangingControl,
      capRetriesByDeclaration({ maxRetries: 3, timeoutMs: 30 }, 3),
      genericRetryOptions
    );
    expect(controlCalls).toBe(4);
    expect(retried.outcome).toBe("timeout");
  });

  it("stops a retryable-looking failure from being retried at all", async () => {
    // The x402 shape: the payment settled, the connection reset, and the error
    // text matches the retryable list. One attempt, no second charge.
    let attempts = 0;
    const failing = (): Promise<TransactionResult> => {
      attempts += 1;
      return Promise.resolve({ success: false, error: "read ECONNRESET" });
    };
    const result = await executeWithRetry<TransactionResult>(
      failing,
      capRetriesByDeclaration({ maxRetries: 3, timeoutMs: 5000 }, 0),
      transactionRetryOptions
    );

    expect(attempts).toBe(1);
    expect(result.outcome).toBe("failed");
    expect(result.retryCount).toBe(0);
  });

  it("still retries the same failure when the step allows two", async () => {
    let attempts = 0;
    const failing = (): Promise<TransactionResult> => {
      attempts += 1;
      return Promise.resolve({ success: false, error: "read ECONNRESET" });
    };
    const result = await executeWithRetry<TransactionResult>(
      failing,
      capRetriesByDeclaration({ maxRetries: 3, timeoutMs: 5000 }, 2),
      transactionRetryOptions
    );

    expect(attempts).toBe(3);
    expect(result.retryCount).toBe(2);
    expect(result.outcome).toBe("failed");
  });
});

describe("effectiveMaxRetries", () => {
  // The number the route reports back as `maxRetriesApplied`. A config that
  // survived the declaration by identity carries no number at all, and reporting
  // that as undefined would read as "no budget was in force" rather than "the
  // default the executor applies".
  it("resolves an absent maxRetries to the default the executor applies", () => {
    expect(effectiveMaxRetries({ timeoutMs: 120_000 })).toBe(3);
  });

  it("keeps a maxRetries the caller or the declaration set, including zero", () => {
    expect(effectiveMaxRetries({ maxRetries: 5, timeoutMs: 1 })).toBe(5);
    expect(effectiveMaxRetries({ maxRetries: 0, timeoutMs: 1 })).toBe(0);
  });

  it("agrees with what capRetriesByDeclaration leaves in force", () => {
    // The pair the route uses: the declaration caps the caller's ask, and the
    // reported budget is what the cap left, never the caller's original number.
    const capped = capRetriesByDeclaration(
      { maxRetries: 3, timeoutMs: 120_000 },
      0
    );
    expect(capped).toBeDefined();
    expect(effectiveMaxRetries(capped as { timeoutMs: number })).toBe(0);

    const unbounded = capRetriesByDeclaration(
      { maxRetries: 3, timeoutMs: 120_000 },
      10
    );
    expect(effectiveMaxRetries(unbounded as { timeoutMs: number })).toBe(3);
  });
});

describe("executeWithRetry", () => {
  describe("with transactionRetryOptions (web3)", () => {
    it("returns success on first attempt when step succeeds", async () => {
      const result = await executeWithRetry<TransactionResult>(
        () =>
          Promise.resolve({
            success: true as const,
            transactionHash: "0xabc",
          }),
        { maxRetries: 3 },
        transactionRetryOptions
      );

      expect(result.outcome).toBe("success");
      expect(result.retryCount).toBe(0);
      if (result.outcome === "success" && result.result.success) {
        expect(result.result.transactionHash).toBe("0xabc");
      }
    });

    it("retries on a connection-level error and eventually succeeds", async () => {
      let attempt = 0;
      const result = await executeWithRetry<TransactionResult>(
        () => {
          attempt++;
          if (attempt < 3) {
            return Promise.resolve({
              success: false as const,
              error: "connect ECONNRESET 10.0.0.1:443",
            });
          }
          return Promise.resolve({
            success: true as const,
            transactionHash: "0xretried",
          });
        },
        { maxRetries: 5 },
        transactionRetryOptions
      );

      expect(result.outcome).toBe("success");
      expect(result.retryCount).toBe(2);
    });

    it.each([
      "nonce has already been used",
      "already known",
      "replacement fee too low",
      "transaction underpriced",
    ])(
      "does not retry post-broadcast error %s, which would send a second transaction",
      async (error) => {
        let calls = 0;
        const result = await executeWithRetry<TransactionResult>(
          () => {
            calls++;
            return Promise.resolve({ success: false as const, error });
          },
          { maxRetries: 3 },
          transactionRetryOptions
        );

        expect(calls).toBe(1);
        expect(result.outcome).toBe("failed");
        expect(result.retryCount).toBe(0);
      }
    );

    it("does not retry a hash-carrying failure whose error reads as a timeout", async () => {
      let calls = 0;
      const result = await executeWithRetry<TransactionResult>(
        () => {
          calls++;
          return Promise.resolve({
            success: false as const,
            error:
              "Transaction sent but receipt could not be read (timeout (code=TIMEOUT))",
            transactionHash: "0xbroadcast",
            chainId: 11_155_111,
          });
        },
        { maxRetries: 3 },
        transactionRetryOptions
      );

      expect(calls).toBe(1);
      expect(result.outcome).toBe("failed");
      expect(result.retryCount).toBe(0);
      if (result.outcome === "failed" && !result.result.success) {
        expect(result.result.transactionHash).toBe("0xbroadcast");
      }
    });

    it("returns failed on non-retryable error", async () => {
      const result = await executeWithRetry<TransactionResult>(
        () =>
          Promise.resolve({
            success: false as const,
            error: "execution reverted",
          }),
        { maxRetries: 3 },
        transactionRetryOptions
      );

      expect(result.outcome).toBe("failed");
      expect(result.retryCount).toBe(0);
      if (result.outcome === "failed") {
        expect(result.result.success).toBe(false);
      }
    });

    it("returns timeout when all attempts time out", async () => {
      const result = await executeWithRetry<TransactionResult>(
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentionally never-resolving promise for timeout test
        () => new Promise(() => {}),
        { maxRetries: 1, timeoutMs: 10 },
        transactionRetryOptions
      );

      expect(result.outcome).toBe("timeout");
      expect(result.retryCount).toBe(1);
      if (result.outcome === "timeout") {
        expect(result.error).toContain("Timed out");
      }
    });
  });

  describe("with genericRetryOptions (non-web3)", () => {
    it("treats any non-throwing return as success", async () => {
      const result = await executeWithRetry<unknown>(
        () => Promise.resolve({ data: "hello", statusCode: 200 }),
        { maxRetries: 3 },
        genericRetryOptions
      );

      expect(result.outcome).toBe("success");
      expect(result.retryCount).toBe(0);
      if (result.outcome === "success") {
        expect(result.result).toEqual({ data: "hello", statusCode: 200 });
      }
    });

    it("does not retry on non-throwing return even without success field", async () => {
      let callCount = 0;
      const result = await executeWithRetry<unknown>(
        () => {
          callCount++;
          return Promise.resolve({ error: "some error" });
        },
        { maxRetries: 3 },
        genericRetryOptions
      );

      expect(result.outcome).toBe("success");
      expect(callCount).toBe(1);
      expect(result.retryCount).toBe(0);
    });

    it("returns timeout when step hangs", async () => {
      const result = await executeWithRetry<unknown>(
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentionally never-resolving promise for timeout test
        () => new Promise(() => {}),
        { maxRetries: 0, timeoutMs: 10 },
        genericRetryOptions
      );

      expect(result.outcome).toBe("timeout");
    });
  });
});
