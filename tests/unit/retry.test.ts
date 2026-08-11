import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  executeWithRetry,
  genericRetryOptions,
  type TransactionResult,
  transactionRetryOptions,
} from "@/app/api/execute/_lib/retry";

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

    it("retries on retryable error and eventually succeeds", async () => {
      let attempt = 0;
      const result = await executeWithRetry<TransactionResult>(
        () => {
          attempt++;
          if (attempt < 3) {
            return Promise.resolve({
              success: false as const,
              error: "nonce has already been used",
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

    it("passes gas bump overrides on retries", async () => {
      const overridesSeen: unknown[] = [];
      let attempt = 0;

      await executeWithRetry<TransactionResult>(
        (overrides) => {
          overridesSeen.push(overrides);
          attempt++;
          if (attempt < 3) {
            return Promise.resolve({
              success: false as const,
              error: "transaction underpriced",
            });
          }
          return Promise.resolve({
            success: true as const,
            transactionHash: "0x",
          });
        },
        { maxRetries: 3, gasBumpPercent: 20 },
        transactionRetryOptions
      );

      expect(overridesSeen[0]).toEqual({});
      expect(overridesSeen[1]).toHaveProperty("gasBumpMultiplier");
      const bump1 = (overridesSeen[1] as { gasBumpMultiplier: number })
        .gasBumpMultiplier;
      expect(bump1).toBeCloseTo(1.2, 5);
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
