import type { ethers } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { pollReceipt } from "@/lib/web3/receipt-wait";

const RECEIPT = { hash: "0xabc" } as unknown as ethers.TransactionReceipt;
const never = (): Promise<ethers.TransactionReceipt | null> =>
  new Promise(() => undefined);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pollReceipt", () => {
  it("returns the receipt once a read finds it, after failed and empty reads", async () => {
    const read = vi
      .fn<() => Promise<ethers.TransactionReceipt | null>>()
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValueOnce(null)
      .mockResolvedValue(RECEIPT);

    const polled = pollReceipt(read, { timeoutMs: 60_000, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(2000);

    await expect(polled).resolves.toEqual({ receipt: RECEIPT });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("keeps the last read error when the deadline passes", async () => {
    const read = vi.fn().mockRejectedValue(new Error("endpoint down"));

    const polled = pollReceipt(read, { timeoutMs: 10_000, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(10_000);

    const outcome = await polled;
    expect(outcome.receipt).toBeNull();
    expect(outcome).toMatchObject({
      lastReadError: new Error("endpoint down"),
    });
  });

  it("cuts a hung read at the per-read cap and keeps polling", async () => {
    const read = vi
      .fn<() => Promise<ethers.TransactionReceipt | null>>()
      .mockImplementationOnce(never)
      .mockResolvedValue(RECEIPT);

    const polled = pollReceipt(read, {
      timeoutMs: 600_000,
      intervalMs: 2000,
      readTimeoutMs: 30_000,
    });
    await vi.advanceTimersByTimeAsync(32_000);

    await expect(polled).resolves.toEqual({ receipt: RECEIPT });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("never lets a hung read run past the deadline", async () => {
    let settled = false;
    const polled = pollReceipt(never, {
      timeoutMs: 600_000,
      intervalMs: 2000,
    }).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(600_000);

    expect(settled).toBe(true);
    // A read cut at the deadline is no answer, not a read error.
    await expect(polled).resolves.toEqual({
      receipt: null,
      lastReadError: undefined,
    });
  });

  it("counts a read cut by the per-read cap as a read error", async () => {
    const polled = pollReceipt(never, {
      timeoutMs: 10_000,
      intervalMs: 2000,
      readTimeoutMs: 3000,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    const outcome = await polled;
    expect(outcome.receipt).toBeNull();
    expect(
      String((outcome as { lastReadError: unknown }).lastReadError)
    ).toContain("timed out after 3000 ms");
  });

  it("does not sleep past the deadline", async () => {
    let settledAt: number | undefined;
    const read = vi.fn().mockResolvedValue(null);
    const started = Date.now();
    const polled = pollReceipt(read, {
      timeoutMs: 10_000,
      intervalMs: 3000,
    }).finally(() => {
      settledAt = Date.now() - started;
    });

    await vi.advanceTimersByTimeAsync(12_000);
    await polled;

    // Reads at 0, 3 s, 6 s and 9 s; another 3 s sleep would end past 10 s.
    expect(read).toHaveBeenCalledTimes(4);
    expect(settledAt).toBe(9000);
  });
});
