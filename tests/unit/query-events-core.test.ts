import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcProviderManager } from "@/lib/rpc/providers";

const mockQueryFilter = vi.fn();

const BLOCK_RANGE_BEYOND_HEAD_ERROR = /block range extends beyond current head/;

vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: class MockContract {
        filters = { Lift: () => ({ topics: [] }) };
        queryFilter = mockQueryFilter;
      },
    },
  };
});

import {
  isNearHeadBatch,
  MAX_BATCH_RETRIES,
  queryBatchWithRetry,
  TIP_SAFETY_MARGIN_BLOCKS,
} from "@/plugins/web3/steps/query-events-core";

function mockRpc(
  executeWithFailover: ReturnType<typeof vi.fn>
): RpcProviderManager {
  return { executeWithFailover } as unknown as RpcProviderManager;
}

function fakeProvider(): Record<string, never> {
  return {};
}

describe("queryBatchWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockQueryFilter.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns on the first attempt without retrying (non-tip batch)", async () => {
    const events = [{ blockNumber: 1 }];
    mockQueryFilter.mockResolvedValue(events);
    const executeWithFailover = vi.fn((operation) => operation(fakeProvider()));

    const promise = queryBatchWithRetry(
      mockRpc(executeWithFailover),
      "0xabc",
      [],
      "Lift",
      0,
      100,
      false
    );
    const expectation = expect(promise).resolves.toEqual({
      events,
      actualEnd: 100,
    });
    await vi.runAllTimersAsync();
    await expectation;

    expect(mockQueryFilter).toHaveBeenCalledWith(expect.anything(), 0, 100);
    expect(executeWithFailover).toHaveBeenCalledTimes(1);
  });

  it("retries a transiently failing batch and returns once an attempt succeeds", async () => {
    const events = [{ blockNumber: 2 }];
    const executeWithFailover = vi
      .fn()
      .mockRejectedValueOnce(new Error("RPC failed: Timeout after 30000ms"))
      .mockRejectedValueOnce(new Error("RPC failed: Timeout after 30000ms"))
      .mockResolvedValueOnce({ events, actualEnd: 100 });

    const promise = queryBatchWithRetry(
      mockRpc(executeWithFailover),
      "0xabc",
      [],
      "Lift",
      0,
      100,
      false
    );
    const expectation = expect(promise).resolves.toEqual({
      events,
      actualEnd: 100,
    });
    await vi.runAllTimersAsync();
    await expectation;

    expect(executeWithFailover).toHaveBeenCalledTimes(3);
  });

  it("gives up and throws after MAX_BATCH_RETRIES failed attempts", async () => {
    const lastError = new Error("RPC failed: Timeout after 30000ms");
    const executeWithFailover = vi.fn().mockRejectedValue(lastError);

    const promise = queryBatchWithRetry(
      mockRpc(executeWithFailover),
      "0xabc",
      [],
      "Lift",
      0,
      100,
      false
    );
    const expectation = expect(promise).rejects.toBe(lastError);
    await vi.runAllTimersAsync();
    await expectation;

    expect(executeWithFailover).toHaveBeenCalledTimes(MAX_BATCH_RETRIES);
  });

  it("queries a tip batch against the literal 'latest' tag and derives actualEnd from the highest returned event", async () => {
    const events = [
      { blockNumber: 201 },
      { blockNumber: 205 },
      { blockNumber: 199 },
    ];
    mockQueryFilter.mockResolvedValue(events);
    const executeWithFailover = vi.fn((operation) => operation(fakeProvider()));

    const promise = queryBatchWithRetry(
      mockRpc(executeWithFailover),
      "0xabc",
      [],
      "Lift",
      200,
      200,
      true
    );
    const expectation = expect(promise).resolves.toEqual({
      events,
      actualEnd: 205,
    });
    await vi.runAllTimersAsync();
    await expectation;

    // The literal "latest" tag, not a previously-resolved number, is what
    // makes this immune to the fast-replica/slow-replica race: whichever
    // node answers resolves "latest" against its own head. actualEnd must
    // come from the events this exact call returned (max, not last), not a
    // separate getBlockNumber() call that could hit a different replica.
    expect(mockQueryFilter).toHaveBeenCalledWith(
      expect.anything(),
      200,
      "latest"
    );
    expect(executeWithFailover).toHaveBeenCalledTimes(1);
  });

  it("reports no forward progress when a tip batch's latest query returns no events", async () => {
    // With nothing returned, there is no value this call can vouch for as
    // actually scanned -- reporting start - 1 means a future run re-checks
    // the same window instead of risking a skipped range.
    const events: unknown[] = [];
    mockQueryFilter.mockResolvedValue(events);
    const executeWithFailover = vi.fn((operation) => operation(fakeProvider()));

    const promise = queryBatchWithRetry(
      mockRpc(executeWithFailover),
      "0xabc",
      [],
      "Lift",
      100,
      200,
      true
    );
    const expectation = expect(promise).resolves.toEqual({
      events,
      actualEnd: 99,
    });
    await vi.runAllTimersAsync();
    await expectation;

    expect(mockQueryFilter).toHaveBeenCalledWith(
      expect.anything(),
      100,
      "latest"
    );
  });
});

describe("cross-replica head divergence (regression coverage)", () => {
  // A pooled RPC endpoint load-balances each call independently: a fast
  // replica and a slower, not-yet-synced replica can each end up serving
  // one of two calls that a caller assumes are consistent with each other.
  const FAST_REPLICA_HEAD = 205;
  const SLOW_REPLICA_SYNCED_HEAD = 203;

  beforeEach(() => {
    vi.useFakeTimers();
    mockQueryFilter.mockReset();
    mockQueryFilter.mockImplementation(
      (_filter: unknown, _start: number, end: number | string) => {
        if (end === "latest") {
          // Whichever replica serves this call resolves "latest" against
          // its own head, so it can never ask itself for a range beyond
          // what it has.
          return Promise.resolve([{ blockNumber: SLOW_REPLICA_SYNCED_HEAD }]);
        }
        if (typeof end === "number" && end > SLOW_REPLICA_SYNCED_HEAD) {
          return Promise.reject(
            new Error(
              "could not coalesce error: -32602 block range extends beyond current head"
            )
          );
        }
        return Promise.resolve([{ blockNumber: end }]);
      }
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("regression: a fixed toBlock (isTipBatch: false) resolved from one replica gets rejected by a slower replica serving the eth_getLogs call", async () => {
    const executeWithFailover = vi.fn((operation) => operation(fakeProvider()));

    const promise = queryBatchWithRetry(
      mockRpc(executeWithFailover),
      "0xabc",
      [],
      "Lift",
      200,
      FAST_REPLICA_HEAD, // resolved by an earlier, separate call that hit the fast replica
      false // fixed toBlock -- see fetchFixedBatch in query-events-core.ts
    );
    const expectation = expect(promise).rejects.toThrow(
      BLOCK_RANGE_BEYOND_HEAD_ERROR
    );
    await vi.runAllTimersAsync();
    await expectation;

    expect(executeWithFailover).toHaveBeenCalledTimes(MAX_BATCH_RETRIES);
  });

  it("the tip batch (isTipBatch: true), queried against the literal 'latest' tag, survives the same lagging replica that just rejected the fixed-toBlock query above", async () => {
    const executeWithFailover = vi.fn((operation) => operation(fakeProvider()));

    const promise = queryBatchWithRetry(
      mockRpc(executeWithFailover),
      "0xabc",
      [],
      "Lift",
      200,
      200, // ignored for a tip batch
      true
    );
    const expectation = expect(promise).resolves.toEqual({
      events: [{ blockNumber: SLOW_REPLICA_SYNCED_HEAD }],
      actualEnd: SLOW_REPLICA_SYNCED_HEAD,
    });
    await vi.runAllTimersAsync();
    await expectation;

    expect(mockQueryFilter).toHaveBeenCalledWith(
      expect.anything(),
      200,
      "latest"
    );
    expect(executeWithFailover).toHaveBeenCalledTimes(1);
  });
});

describe("isNearHeadBatch", () => {
  it("treats the batch landing exactly on toBlock as a tip batch", () => {
    expect(isNearHeadBatch(4999, 4999, true)).toBe(true);
  });

  it("treats a batch ending within the safety margin of toBlock as a tip batch, not just the exact final one", () => {
    // Reproduces a small remainder over the batch size: fromBlock=1000,
    // toBlock=5001 (batchSize=2000) produces batches [1000,2999],
    // [3000,4999], [5000,5001] -- the second batch ends only 2 blocks
    // before toBlock, close enough to race a lagging replica the same way
    // the exact tip batch does.
    const batchEnd = 4999;
    const toBlock = 5001;
    expect(toBlock - batchEnd).toBeLessThan(TIP_SAFETY_MARGIN_BLOCKS);
    expect(isNearHeadBatch(batchEnd, toBlock, true)).toBe(true);
  });

  it("does not treat a batch well short of toBlock as a tip batch", () => {
    expect(isNearHeadBatch(2999, 5001, true)).toBe(false);
  });

  it("never treats any batch as a tip batch when toBlock was explicitly provided by the user", () => {
    expect(isNearHeadBatch(5001, 5001, false)).toBe(false);
  });
});
