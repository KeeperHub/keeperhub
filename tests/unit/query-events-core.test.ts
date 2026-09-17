import { ethers } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEventInputs } from "@/lib/abi/function-inputs";
import type { RpcProviderManager } from "@/lib/rpc/providers";

const mockQueryFilter = vi.fn();

// Hoisted: the ethers mock factory below runs while the mocked module is
// first imported (before this module's body), so the ABI it builds its real
// Interface from and the array it captures filter calls into must already
// exist. vi.hoisted callbacks run before any import is evaluated.
const { mockFilterTestAbi, mockCapturedFilterCalls } = vi.hoisted(() => {
  // Test ABI for the issue-#2489 filter tests: Transfer mixes indexed and
  // non-indexed inputs, Deposit has three indexed inputs of different
  // types, Approval has an indexed bool, Mixed has a non-indexed input
  // before its indexed one, and Lift has no inputs at all.
  const abi: {
    type: string;
    name: string;
    inputs: { name: string; type: string; indexed: boolean }[];
  }[] = [
    {
      type: "event",
      name: "Transfer",
      inputs: [
        { name: "from", type: "address", indexed: true },
        { name: "to", type: "address", indexed: true },
        { name: "value", type: "uint256", indexed: false },
      ],
    },
    {
      type: "event",
      name: "Deposit",
      inputs: [
        { name: "id", type: "bytes32", indexed: true },
        { name: "note", type: "string", indexed: true },
        { name: "amount", type: "uint256", indexed: true },
      ],
    },
    {
      type: "event",
      name: "Approval",
      inputs: [
        { name: "owner", type: "address", indexed: true },
        { name: "approved", type: "bool", indexed: true },
      ],
    },
    // Mixed puts a non-indexed input BEFORE an indexed one: the case that
    // distinguishes "positional over indexed inputs" from "positional over
    // all inputs" when the args reach ethers.
    {
      type: "event",
      name: "Mixed",
      inputs: [
        { name: "amount", type: "uint256", indexed: false },
        { name: "who", type: "address", indexed: true },
      ],
    },
    { type: "event", name: "Lift", inputs: [] },
  ];
  return {
    mockFilterTestAbi: abi,
    // Every `contract.filters[eventName](...args)` call lands here, carrying
    // the topics the real ethers Interface encoded for those args. Only the
    // provider-bound queryFilter call stays mocked; topic encoding (address
    // checksumming, uint256 zero-padding, keccak256 of indexed dynamic
    // types) runs exactly as production builds it.
    mockCapturedFilterCalls: [] as {
      eventName: string;
      args: unknown[];
      topics: (string | string[] | null)[];
    }[],
  };
});

const BLOCK_RANGE_BEYOND_HEAD_ERROR = /block range extends beyond current head/;

vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  const realIface = new actual.ethers.Interface(mockFilterTestAbi);
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: class MockContract {
        // Real ethers v6 exposes the parsed ABI here; production code reads
        // `contract.interface.getEvent(...)` instead of re-parsing the ABI.
        interface = realIface;
        filters = new Proxy(
          {},
          {
            get: (_target, eventName: string | symbol) => {
              if (typeof eventName !== "string") {
                return undefined;
              }
              // NOTE: ethers v6's getEvent returns null for unknown names
              // (it does NOT throw) -- verified against ethers 6.17.0.
              const fragment: ethers.EventFragment | null =
                realIface.getEvent(eventName);
              if (!fragment) {
                // Unknown event: no filter function, so the `?.()` in
                // resolveEventFilter yields undefined and the existing
                // "Could not create filter" error path is preserved.
                return undefined;
              }
              return (...args: unknown[]) => {
                const topics = realIface.encodeFilterTopics(fragment, args) as (
                  | string
                  | string[]
                  | null
                )[];
                mockCapturedFilterCalls.push({ eventName, args, topics });
                return { topics };
              };
            },
          }
        );
        queryFilter = mockQueryFilter;
      },
    },
  };
});

import {
  type BatchQueryResult,
  encodeEventFilterTopics,
  expandIndexedArgsToEventPositions,
  isNearHeadBatch,
  MAX_BATCH_RETRIES,
  parseIndexedEventArgs,
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

// ---------------------------------------------------------------------------
// issue #2489 helpers
// ---------------------------------------------------------------------------

const filterTestIface = new ethers.Interface(mockFilterTestAbi);

// getEvent returns null for unknown names; the fixtures below are static and
// must exist, so fail loudly instead of threading null through the tests.
function mustGetEvent(name: string): ethers.EventFragment {
  const fragment = filterTestIface.getEvent(name);
  if (!fragment) {
    throw new Error(`test fixture missing event '${name}'`);
  }
  return fragment;
}

const ADDR_A = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const ADDR_A_CHECKSUMMED = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ADDR_B = "0x00000000000000000000000000000000a1b2c3d4"; // synthetic fixture: 32 leading zeros, skipped by scan-contract-addresses.mjs
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const UINT256_MAX =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const BYTES32_ID = `0x${"ab".repeat(32)}`;

function transferTopic0(): string {
  return mustGetEvent("Transfer").topicHash;
}

function paddedAddress(address: string): string {
  return ethers.zeroPadValue(ethers.getAddress(address), 32);
}

function lastFilterCall(): {
  eventName: string;
  args: unknown[];
  topics: (string | string[] | null)[];
} {
  const last = mockCapturedFilterCalls.at(-1);
  if (!last) {
    throw new Error("expected a filter call to have been captured");
  }
  return last;
}

// Runs one batch through queryBatchWithRetry. indexedArgs is the *parsed*
// form the step hands the core (positional over indexed inputs, null =
// wildcard); omit it to exercise the defaulted trailing param, exactly as
// the pre-#2489 7-arg call sites do.
function runBatch(
  indexedArgs: (unknown | null)[] | undefined,
  overrides: {
    eventName?: string;
    start?: number;
    end?: number;
    isTipBatch?: boolean;
    failover?: ReturnType<typeof vi.fn>;
  } = {}
): {
  promise: Promise<BatchQueryResult>;
  executeWithFailover: ReturnType<typeof vi.fn>;
} {
  const executeWithFailover =
    overrides.failover ??
    vi.fn((operation: (provider: unknown) => unknown) =>
      operation(fakeProvider())
    );
  const promise =
    indexedArgs === undefined
      ? queryBatchWithRetry(
          mockRpc(executeWithFailover),
          "0xabc",
          mockFilterTestAbi,
          overrides.eventName ?? "Transfer",
          overrides.start ?? 0,
          overrides.end ?? 100,
          overrides.isTipBatch ?? false
        )
      : queryBatchWithRetry(
          mockRpc(executeWithFailover),
          "0xabc",
          mockFilterTestAbi,
          overrides.eventName ?? "Transfer",
          overrides.start ?? 0,
          overrides.end ?? 100,
          overrides.isTipBatch ?? false,
          indexedArgs
        );
  return { promise, executeWithFailover };
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

describe("parseIndexedEventArgs", () => {
  const transfer = mustGetEvent("Transfer");
  const deposit = mustGetEvent("Deposit");
  const approval = mustGetEvent("Approval");
  const lift = mustGetEvent("Lift");

  describe("input shapes", () => {
    it("treats undefined as match-all (one null wildcard per indexed input)", () => {
      expect(parseIndexedEventArgs(transfer, undefined)).toEqual([null, null]);
    });

    it("treats null as match-all", () => {
      expect(
        parseIndexedEventArgs(transfer, null as unknown as string | undefined)
      ).toEqual([null, null]);
    });

    it("treats an empty or whitespace-only string as match-all", () => {
      expect(parseIndexedEventArgs(transfer, "")).toEqual([null, null]);
      expect(parseIndexedEventArgs(transfer, "   ")).toEqual([null, null]);
    });

    it("accepts a JSON array string", () => {
      expect(
        parseIndexedEventArgs(transfer, JSON.stringify([ADDR_A, ""]))
      ).toEqual([ADDR_A, null]);
    });

    it("accepts a raw array", () => {
      expect(parseIndexedEventArgs(transfer, [ADDR_A, null])).toEqual([
        ADDR_A,
        null,
      ]);
    });

    it("returns an empty array for an event with no indexed inputs", () => {
      expect(parseIndexedEventArgs(lift, undefined)).toEqual([]);
      expect(parseIndexedEventArgs(lift, "[]")).toEqual([]);
    });
  });

  describe("wildcards and padding", () => {
    it('maps ""/null/undefined entries to null wildcards', () => {
      expect(parseIndexedEventArgs(transfer, ["", null])).toEqual([null, null]);
      expect(parseIndexedEventArgs(transfer, [undefined, ""])).toEqual([
        null,
        null,
      ]);
    });

    it("pads a short array with null wildcards to the indexed input count", () => {
      expect(parseIndexedEventArgs(transfer, [ADDR_A])).toEqual([ADDR_A, null]);
      expect(
        parseIndexedEventArgs(deposit, JSON.stringify([BYTES32_ID]))
      ).toEqual([BYTES32_ID, null, null]);
    });

    it("keeps a full-length array as-is", () => {
      expect(
        parseIndexedEventArgs(deposit, [BYTES32_ID, "note", "42"])
      ).toEqual([BYTES32_ID, "note", "42"]);
    });

    it("does not treat a whitespace-only entry as a wildcard (strict empty-string check)", () => {
      // Only exact "" becomes null; anything else passes through to the
      // topic encoder, which rejects it for typed inputs like address.
      expect(parseIndexedEventArgs(transfer, ["   ", ""])).toEqual([
        "   ",
        null,
      ]);
    });
  });

  describe("indexed-only positional binding", () => {
    it("binds positionally over indexed inputs only; the non-indexed `value` has no position", () => {
      const result = parseIndexedEventArgs(transfer, [ADDR_A, ADDR_B]);
      expect(result).toEqual([ADDR_A, ADDR_B]);
      expect(result).toHaveLength(2); // not 3: `value` is non-indexed
    });

    it("rejects values beyond the indexed input count, even for non-indexed positions", () => {
      // A caller must not pass the non-indexed `value` slot: positions are
      // indexed-only, so a third entry is always a config error.
      expect(() =>
        parseIndexedEventArgs(transfer, [ADDR_A, ADDR_B, "999"])
      ).toThrow(
        "eventArgs has 3 value(s) but event 'Transfer' has only 2 indexed input(s)"
      );
    });

    it("rejects any values for an event with zero indexed inputs", () => {
      expect(() => parseIndexedEventArgs(lift, [ADDR_A])).toThrow(
        "eventArgs has 1 value(s) but event 'Lift' has only 0 indexed input(s)"
      );
    });
  });

  describe("coercion", () => {
    it('coerces "true"/"false" strings for indexed bool inputs', () => {
      expect(parseIndexedEventArgs(approval, [ADDR_A, "true"])).toEqual([
        ADDR_A,
        true,
      ]);
      expect(parseIndexedEventArgs(approval, [ADDR_A, "FALSE"])).toEqual([
        ADDR_A,
        false,
      ]);
      expect(
        parseIndexedEventArgs(approval, JSON.stringify([ADDR_A, " True "]))
      ).toEqual([ADDR_A, true]);
    });

    it("leaves non-string bool values and null wildcards untouched", () => {
      expect(parseIndexedEventArgs(approval, [ADDR_A, true])).toEqual([
        ADDR_A,
        true,
      ]);
      expect(parseIndexedEventArgs(approval, [ADDR_A, null])).toEqual([
        ADDR_A,
        null,
      ]);
    });

    it("passes address strings through unchanged (checksumming happens at topic encoding)", () => {
      expect(parseIndexedEventArgs(transfer, [ADDR_A, ""])).toEqual([
        ADDR_A,
        null,
      ]);
    });
  });

  describe("config errors", () => {
    it("throws on invalid JSON", () => {
      expect(() => parseIndexedEventArgs(transfer, "not-json{{")).toThrow(
        /eventArgs is not valid JSON/
      );
    });

    it.each([
      ["object", '{"from":"0xabc"}'],
      ["string", '"hello"'],
      ["number", "42"],
      ["bare null", "null"],
    ])("throws on non-array JSON (%s)", (_label, json) => {
      expect(() => parseIndexedEventArgs(transfer, json)).toThrow(
        "eventArgs must be a JSON array of argument values"
      );
    });

    it("throws on a non-string, non-array input", () => {
      expect(() =>
        parseIndexedEventArgs(transfer, 42 as unknown as string)
      ).toThrow("eventArgs must be a JSON array string or an array");
    });

    it("throws when there are more values than indexed inputs", () => {
      expect(() =>
        parseIndexedEventArgs(deposit, [BYTES32_ID, "n", "1", "extra"])
      ).toThrow(
        "eventArgs has 4 value(s) but event 'Deposit' has only 3 indexed input(s)"
      );
    });
  });
});

describe("expandIndexedArgsToEventPositions", () => {
  const transfer = mustGetEvent("Transfer");
  const approval = mustGetEvent("Approval");
  const mixed = mustGetEvent("Mixed");

  it("interleaves nulls at non-indexed positions", () => {
    // Mixed(uint256 amount, address indexed who): the address must land on
    // input position 1, not position 0.
    expect(expandIndexedArgsToEventPositions(mixed, [ADDR_A])).toEqual([
      null,
      ADDR_A,
    ]);
  });

  it("is the identity for all-indexed events", () => {
    // Approval(owner, approved) is all-indexed: nothing to interleave.
    expect(expandIndexedArgsToEventPositions(approval, [ADDR_A, true])).toEqual(
      [ADDR_A, true]
    );
  });

  it("appends a null wildcard for a trailing non-indexed input", () => {
    // Transfer(from, to, value): the non-indexed `value` gets a null slot
    // so the two addresses stay on input positions 0 and 1.
    expect(
      expandIndexedArgsToEventPositions(transfer, [ADDR_A, ADDR_B])
    ).toEqual([ADDR_A, ADDR_B, null]);
  });

  it("throws when given more args than the event has indexed inputs", () => {
    expect(() =>
      expandIndexedArgsToEventPositions(mixed, [ADDR_A, ADDR_B])
    ).toThrow(/too many arguments/);
  });

  it("pads missing indexed args with wildcards before expanding", () => {
    // parse pads to indexed-input length; the helper tolerates a short
    // array directly too.
    expect(expandIndexedArgsToEventPositions(mixed, [])).toEqual([null, null]);
  });

  it("keeps explicit null wildcards at indexed positions", () => {
    expect(expandIndexedArgsToEventPositions(mixed, [null])).toEqual([
      null,
      null,
    ]);
  });
});

describe("event arg filters (issue #2489)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockQueryFilter.mockReset();
    mockQueryFilter.mockResolvedValue([]);
    mockCapturedFilterCalls.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("empty/unset args preserve the old no-arg filter behavior", () => {
    it("a 7-arg call (indexedArgs defaulted) builds the match-all filter", async () => {
      const { promise } = runBatch(undefined);
      await vi.runAllTimersAsync();
      await promise;

      expect(mockCapturedFilterCalls).toHaveLength(1);
      // The defaulted empty array expands to a null wildcard per input;
      // ethers trims trailing null topics, so the filter encodes to exactly
      // the old no-arg topics array: [topic0].
      expect(lastFilterCall().args).toEqual([null, null, null]);
      expect(lastFilterCall().topics).toEqual([transferTopic0()]);
    });

    it("parsed empty args ([null, null]) encode identically to the no-arg call", async () => {
      const { promise } = runBatch([null, null]);
      await vi.runAllTimersAsync();
      await promise;

      expect(lastFilterCall().args).toEqual([null, null, null]);
      expect(lastFilterCall().topics).toEqual([transferTopic0()]);
    });

    it("an event with no inputs keeps a topics array of just the topic hash", async () => {
      const { promise } = runBatch([], { eventName: "Lift" });
      await vi.runAllTimersAsync();
      await promise;

      expect(lastFilterCall().topics).toEqual([mustGetEvent("Lift").topicHash]);
    });

    it("a tip batch with defaulted indexedArgs queries 'latest' with match-all topics", async () => {
      const { promise } = runBatch(undefined, {
        start: 200,
        end: 200,
        isTipBatch: true,
      });
      await vi.runAllTimersAsync();
      await promise;

      expect(mockQueryFilter).toHaveBeenCalledWith(
        expect.objectContaining({ topics: [transferTopic0()] }),
        200,
        "latest"
      );
    });
  });

  describe("indexed arg binding", () => {
    it("binds a single indexed arg to topic1 and leaves topic2 a wildcard", async () => {
      const { promise } = runBatch([ADDR_A, null]);
      await vi.runAllTimersAsync();
      await promise;

      // The trailing null wildcard is trimmed by ethers, so the encoded
      // topics carry no topic2 entry at all -- equivalent to a wildcard.
      expect(lastFilterCall().topics).toEqual([
        transferTopic0(),
        paddedAddress(ADDR_A),
      ]);
    });

    it("keeps positional alignment when only a later indexed arg is set", async () => {
      const { promise } = runBatch([null, ADDR_B]);
      await vi.runAllTimersAsync();
      await promise;

      expect(lastFilterCall().topics).toEqual([
        transferTopic0(),
        null,
        paddedAddress(ADDR_B),
      ]);
    });

    it("binds two indexed args", async () => {
      const { promise } = runBatch([ADDR_A, ADDR_B]);
      await vi.runAllTimersAsync();
      await promise;

      expect(lastFilterCall().topics).toEqual([
        transferTopic0(),
        paddedAddress(ADDR_A),
        paddedAddress(ADDR_B),
      ]);
    });

    it("never turns a non-indexed input into a topic", async () => {
      // Transfer's third input `value` is non-indexed: the topics array has
      // no fourth entry for it, however the args were supplied.
      const { promise } = runBatch([ADDR_A, ADDR_B]);
      await vi.runAllTimersAsync();
      await promise;

      expect(lastFilterCall().topics).toHaveLength(3);
    });
  });

  describe("ethers v6 topic encoding", () => {
    it("checksums a lowercase address into its topic", async () => {
      const { promise } = runBatch([ADDR_A, null]);
      await vi.runAllTimersAsync();
      await promise;

      // The padded topic uses the checksummed form, not the raw input.
      expect(lastFilterCall().topics[1]).toBe(
        paddedAddress(ADDR_A_CHECKSUMMED)
      );
      expect(lastFilterCall().topics[1]).toBe(paddedAddress(ADDR_A));
    });

    it("encodes the zero address as 32 zero bytes", async () => {
      const { promise } = runBatch([ZERO_ADDRESS, null]);
      await vi.runAllTimersAsync();
      await promise;

      expect(lastFilterCall().topics[1]).toBe(`0x${"00".repeat(32)}`);
    });

    it("encodes uint256 max as 32 0xff bytes", async () => {
      const { promise } = runBatch([BYTES32_ID, null, UINT256_MAX], {
        eventName: "Deposit",
      });
      await vi.runAllTimersAsync();
      await promise;

      expect(lastFilterCall().topics[3]).toBe(`0x${"ff".repeat(32)}`);
    });

    it("passes a bytes32 value through as its own topic", async () => {
      const { promise } = runBatch([BYTES32_ID, null, "1"], {
        eventName: "Deposit",
      });
      await vi.runAllTimersAsync();
      await promise;

      expect(lastFilterCall().topics[1]).toBe(BYTES32_ID);
    });

    it("hashes an indexed dynamic type (string) with keccak256", async () => {
      const { promise } = runBatch([null, "hello", "1"], {
        eventName: "Deposit",
      });
      await vi.runAllTimersAsync();
      await promise;

      expect(lastFilterCall().topics[2]).toBe(
        ethers.keccak256(ethers.toUtf8Bytes("hello"))
      );
    });

    it("encodes a coerced bool indexed arg as 0/1", async () => {
      // End to end through the parse seam: "true" coerces to boolean, then
      // encodes as a one-word topic.
      const parsed = parseIndexedEventArgs(mustGetEvent("Approval"), [
        ADDR_A,
        "true",
      ]);
      const { promise } = runBatch(parsed, { eventName: "Approval" });
      await vi.runAllTimersAsync();
      await promise;

      expect(lastFilterCall().topics[2]).toBe(`0x${"00".repeat(31)}01`);
    });
  });

  describe("per-batch filter application", () => {
    it("applies the filtered filter to a fixed batch", async () => {
      const { promise } = runBatch([ADDR_A, null]);
      await vi.runAllTimersAsync();
      await promise;

      expect(mockQueryFilter).toHaveBeenCalledTimes(1);
      const [filter, start, end] = mockQueryFilter.mock.calls[0] as [
        { topics: unknown[] },
        number,
        number,
      ];
      expect(start).toBe(0);
      expect(end).toBe(100);
      expect(filter.topics).toEqual([transferTopic0(), paddedAddress(ADDR_A)]);
    });

    it("applies the same filtered filter to a tip batch (literal 'latest')", async () => {
      const { promise } = runBatch([ADDR_A, ADDR_B], {
        start: 200,
        end: 200,
        isTipBatch: true,
      });
      await vi.runAllTimersAsync();
      await promise;

      expect(mockQueryFilter).toHaveBeenCalledWith(
        expect.objectContaining({
          topics: [
            transferTopic0(),
            paddedAddress(ADDR_A),
            paddedAddress(ADDR_B),
          ],
        }),
        200,
        "latest"
      );
    });

    it("fixed and tip batches query with identical topics", async () => {
      const indexedArgs: (unknown | null)[] = [null, ADDR_B];

      const fixed = runBatch(indexedArgs, {
        start: 0,
        end: 100,
        isTipBatch: false,
      });
      const fixedExpectation = expect(fixed.promise).resolves.toBeDefined();
      await vi.runAllTimersAsync();
      await fixedExpectation;
      const fixedTopics = lastFilterCall().topics;

      const tip = runBatch(indexedArgs, {
        start: 200,
        end: 200,
        isTipBatch: true,
      });
      const tipExpectation = expect(tip.promise).resolves.toBeDefined();
      await vi.runAllTimersAsync();
      await tipExpectation;
      const tipTopics = lastFilterCall().topics;

      expect(tipTopics).toEqual(fixedTopics);
      expect(tipTopics[2]).toBe(paddedAddress(ADDR_B));
    });

    it("builds a fresh identical filter for every batch of a multi-batch scan", async () => {
      for (const [start, end] of [
        [0, 1999],
        [2000, 2500],
      ] as const) {
        const { promise } = runBatch([null, ADDR_B], { start, end });
        const expectation = expect(promise).resolves.toBeDefined();
        await vi.runAllTimersAsync();
        await expectation;
      }

      expect(mockCapturedFilterCalls).toHaveLength(2);
      expect(mockCapturedFilterCalls[0]?.topics).toEqual(
        mockCapturedFilterCalls[1]?.topics
      );
      expect(mockCapturedFilterCalls[0]?.topics[2]).toBe(paddedAddress(ADDR_B));
    });
  });

  describe("filter-construction failures", () => {
    it("rejects an unknown event name (existing error path preserved)", async () => {
      const { promise, executeWithFailover } = runBatch(["0xabc"], {
        eventName: "Nope",
      });
      const expectation = expect(promise).rejects.toThrow(
        "Could not create filter for event 'Nope'"
      );
      await vi.runAllTimersAsync();
      await expectation;

      expect(mockQueryFilter).not.toHaveBeenCalled();
      expect(executeWithFailover).toHaveBeenCalledTimes(MAX_BATCH_RETRIES);
    });

    it("rejects an invalid address without hitting the provider", async () => {
      const { promise, executeWithFailover } = runBatch([
        "not-an-address",
        null,
      ]);
      const expectation = expect(promise).rejects.toThrow(/invalid address/i);
      await vi.runAllTimersAsync();
      await expectation;

      expect(mockQueryFilter).not.toHaveBeenCalled();
      expect(executeWithFailover).toHaveBeenCalledTimes(MAX_BATCH_RETRIES);
    });

    it("right-pads a short bytes32 value instead of rejecting it", async () => {
      // ethers v6 does not length-check bytes32 topic values: a short value
      // is right-padded to 32 bytes. Pinned here so the behavior is
      // documented, not assumed.
      const { promise } = runBatch(["0x1234", null, "1"], {
        eventName: "Deposit",
      });
      const expectation = expect(promise).resolves.toBeDefined();
      await vi.runAllTimersAsync();
      await expectation;

      expect(lastFilterCall().topics[1]).toBe(`0x1234${"00".repeat(30)}`);
    });

    it("rejects more indexedArgs than the event has inputs", async () => {
      const { promise, executeWithFailover } = runBatch(
        [ADDR_A, ADDR_B, "0x1234", "extra"],
        { eventName: "Transfer" } // 3 inputs; 4 args is too many
      );
      const expectation = expect(promise).rejects.toThrow(/too many arguments/);
      await vi.runAllTimersAsync();
      await expectation;

      expect(mockQueryFilter).not.toHaveBeenCalled();
      expect(executeWithFailover).toHaveBeenCalledTimes(MAX_BATCH_RETRIES);
    });

    it("binds an indexed arg when a non-indexed input precedes it", async () => {
      // Regression guard for the Mixed(uint256 amount, address indexed who)
      // positional bug (found 2026-09-16, issue #2489): the parsed args are
      // indexed-only positional, but ethers maps filter args over ALL event
      // inputs, so the batch path must interleave a null wildcard at the
      // non-indexed `amount` arg position. The null is an arg-level
      // placeholder only: ethers emits topics for indexed params alone, so
      // the encoded filter is [topic0, topic1=paddedAddress(ADDR_A)].
      const { promise } = runBatch([ADDR_A], { eventName: "Mixed" });
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result).toBeDefined();

      expect(lastFilterCall().args).toEqual([null, ADDR_A]);
      expect(lastFilterCall().topics).toEqual([
        mustGetEvent("Mixed").topicHash,
        paddedAddress(ADDR_A),
      ]);
    });
  });
});

describe("resolveEventInputs", () => {
  const abiJson = JSON.stringify(mockFilterTestAbi);

  it("returns only the indexed inputs, in ABI order, flagged indexed", () => {
    expect(resolveEventInputs(abiJson, "Transfer")).toEqual({
      inputs: [
        { name: "from", type: "address", indexed: true },
        { name: "to", type: "address", indexed: true },
      ],
      malformed: false,
    });
  });

  it("excludes non-indexed inputs (they can never become topics)", () => {
    const { inputs } = resolveEventInputs(abiJson, "Transfer");
    expect(inputs.map((input) => input.name)).toEqual(["from", "to"]);
    expect(inputs.every((input) => input.indexed)).toBe(true);
  });

  it("returns an empty list for an event with no indexed inputs", () => {
    expect(resolveEventInputs(abiJson, "Lift")).toEqual({
      inputs: [],
      malformed: false,
    });
  });

  it("returns EMPTY (not malformed) for a missing event or missing selection", () => {
    expect(resolveEventInputs(abiJson, "Nope")).toEqual({
      inputs: [],
      malformed: false,
    });
    expect(resolveEventInputs(abiJson, "")).toEqual({
      inputs: [],
      malformed: false,
    });
    expect(resolveEventInputs("", "Transfer")).toEqual({
      inputs: [],
      malformed: false,
    });
    expect(resolveEventInputs(null, "Transfer")).toEqual({
      inputs: [],
      malformed: false,
    });
  });

  it("never throws: malformed ABIs yield malformed: true", () => {
    expect(resolveEventInputs("{not json", "Transfer")).toEqual({
      inputs: [],
      malformed: true,
    });
    expect(resolveEventInputs('{"type":"event"}', "Transfer")).toEqual({
      inputs: [],
      malformed: true,
    });
    // An indexed input without a type is still malformed ...
    expect(
      resolveEventInputs(
        JSON.stringify([
          {
            type: "event",
            name: "Bad",
            inputs: [{ name: "x", indexed: true }],
          },
        ]),
        "Bad"
      )
    ).toEqual({ inputs: [], malformed: true });
  });

  it("excludes indexed array and tuple inputs (ethers cannot encode them as topics)", () => {
    const abiJson = JSON.stringify([
      {
        type: "event",
        name: "BatchMinted",
        inputs: [
          { name: "ids", type: "uint256[]", indexed: true },
          { name: "to", type: "address", indexed: false },
          {
            name: "meta",
            type: "tuple",
            indexed: true,
            components: [{ name: "a", type: "uint256" }],
          },
          { name: "setter", type: "address", indexed: true },
        ],
      },
    ]);
    expect(resolveEventInputs(abiJson, "BatchMinted")).toEqual({
      inputs: [{ name: "setter", type: "address", indexed: true }],
      malformed: false,
    });
  });

  it("validates indexed inputs only: a malformed non-indexed input does not hide fine indexed filters", () => {
    // Some explorer ABIs emit tuples with no `components`; when such an
    // input is non-indexed it must not suppress the indexed filters.
    const abiJson = JSON.stringify([
      {
        type: "event",
        name: "Weird",
        inputs: [
          { name: "who", type: "address", indexed: true },
          { name: "data", type: "tuple", indexed: false },
        ],
      },
    ]);
    const result = resolveEventInputs(abiJson, "Weird");
    expect(result.malformed).toBe(false);
    expect(result.inputs.map((input) => input.name)).toEqual(["who"]);
  });
});

describe("encodeEventFilterTopics", () => {
  const iface = new ethers.Interface(mockFilterTestAbi);
  const transfer = iface.getEvent("Transfer");
  if (!transfer) {
    throw new Error("test ABI is missing the Transfer event");
  }

  it("encodes topics identically to a direct encodeFilterTopics call", () => {
    const indexedArgs = [ADDR_A, null];
    expect(encodeEventFilterTopics(iface, transfer, indexedArgs)).toEqual(
      iface.encodeFilterTopics(transfer, [ADDR_A, null, null])
    );
  });

  it("names the parameter and type when a value fails to encode", () => {
    expect(() =>
      encodeEventFilterTopics(iface, transfer, ["not-an-address", ""])
    ).toThrow(/^'from' \(address\): .*invalid address/i);
  });

  it("attributes the failure to the right parameter, not just the first", () => {
    expect(() =>
      encodeEventFilterTopics(iface, transfer, [ADDR_A, "not-an-address"])
    ).toThrow(/^'to' \(address\): .*invalid address/i);
  });

  it("skips wildcard positions and encodes nothing for an empty filter", () => {
    expect(encodeEventFilterTopics(iface, transfer, [null, null])).toEqual(
      iface.encodeFilterTopics(transfer, [null, null, null])
    );
    expect(encodeEventFilterTopics(iface, transfer, [])).toEqual(
      iface.encodeFilterTopics(transfer, [null, null, null])
    );
  });
});
