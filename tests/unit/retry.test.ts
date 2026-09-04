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
