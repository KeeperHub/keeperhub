/**
 * issue #2489: optional indexed event-argument filters, step-level coverage.
 *
 * Exercises queryEventsStep end to end with every external boundary mocked:
 * no network, no DB. Asserts the `eventArgs` config value reaches each
 * batch's filter (via the real ethers Interface topic encoding), that bad
 * values fail eagerly with `{ success: false, error: "Invalid event
 * argument filters: ..." }` before any RPC, and that the output shape is
 * unchanged.
 */

import { ethers } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Server-only guard module loads "server-only"; stub it for vitest.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () => {
  const { stepHandlerPassthrough } = await import("../mocks/step-mocks");
  return stepHandlerPassthrough();
});

const { mockGetRpcProvider } = vi.hoisted(() => ({
  mockGetRpcProvider: vi.fn(),
}));

vi.mock("@/lib/rpc/provider-factory", async () => {
  // validate-chain-address imports isSolanaChain from this path; re-export
  // the real dependency-free implementation so evmOnlyGuard works.
  const { isSolanaChain } = await import("@/lib/rpc/solana-chains");
  return {
    isSolanaChain,
    getRpcProvider: (...args: unknown[]) => mockGetRpcProvider(...args),
  };
});

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: () => 1,
}));

vi.mock("@/lib/workflow/executor/helpers", () => ({
  getRpcPreferenceUserId: () => Promise.resolve("user-1"),
}));

vi.mock("@/lib/web3/explorer-link", () => ({
  resolveExplorerLink: () => Promise.resolve(null),
}));

const mockQueryFilter = vi.fn();

// Hoisted: the ethers mock factory below runs while the mocked module is
// first imported (before this module's body), so the ABI it builds its real
// Interface from and the array it captures filter calls into must already
// exist. vi.hoisted callbacks run before any import is evaluated.
const { mockStepTestAbi, mockStepCapturedFilterCalls } = vi.hoisted(() => {
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
  ];
  return {
    mockStepTestAbi: abi,
    mockStepCapturedFilterCalls: [] as {
      eventName: string;
      args: unknown[];
      topics: (string | string[] | null)[];
    }[],
  };
});

vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  const realIface = new actual.ethers.Interface(mockStepTestAbi);
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
                return undefined;
              }
              return (...args: unknown[]) => {
                const topics = realIface.encodeFilterTopics(fragment, args) as (
                  | string
                  | string[]
                  | null
                )[];
                mockStepCapturedFilterCalls.push({ eventName, args, topics });
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
  type QueryEventsInput,
  queryEventsStep,
} from "@/plugins/web3/steps/query-events";

const CONTRACT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ADDR_A = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const ADDR_A_CHECKSUMMED = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ADDR_B = "0x00000000000000000000000000000000a1b2c3d4"; // synthetic fixture: 32 leading zeros, skipped by scan-contract-addresses.mjs
const TX_HASH = `0x${"11".repeat(32)}`;

const stepTestIface = new ethers.Interface(mockStepTestAbi);

function mustGetStepEvent(name: string): ethers.EventFragment {
  const fragment = stepTestIface.getEvent(name);
  if (!fragment) {
    throw new Error(`test fixture missing event '${name}'`);
  }
  return fragment;
}

function transferTopic0(): string {
  return mustGetStepEvent("Transfer").topicHash;
}

function paddedAddress(address: string): string {
  return ethers.zeroPadValue(ethers.getAddress(address), 32);
}

function baseInput(
  overrides: Partial<QueryEventsInput> = {}
): QueryEventsInput {
  return {
    network: "ethereum",
    contractAddress: CONTRACT_ADDRESS,
    abi: JSON.stringify(mockStepTestAbi),
    eventName: "Transfer",
    fromBlock: "100",
    toBlock: "200",
    eventArgs: JSON.stringify([ADDR_A, ""]),
    ...overrides,
  };
}

// The step keeps only `instanceof ethers.EventLog` results. Build fakes on
// the real prototype so the check passes without a provider; defineProperties
// shadows any prototype accessors.
function fakeEventLog(args: unknown[]): ethers.EventLog {
  const log = Object.create(ethers.EventLog.prototype) as ethers.EventLog;
  Object.defineProperties(log, {
    blockNumber: { value: 150, enumerable: true },
    transactionHash: { value: TX_HASH, enumerable: true },
    index: { value: 0, enumerable: true },
    args: { value: args, enumerable: true },
  });
  return log;
}

function queriedTopics(): (string | string[] | null)[][] {
  return mockQueryFilter.mock.calls.map(
    (call) => (call[0] as { topics: (string | string[] | null)[] }).topics
  );
}

describe("queryEventsStep with event arg filters (issue #2489)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetRpcProvider.mockReset();
    mockGetRpcProvider.mockImplementation(() =>
      Promise.resolve({
        // Explicit fromBlock/toBlock never touches the provider (see
        // block-range-helpers), so a bare object suffices.
        executeWithFailover: (operation: (provider: unknown) => unknown) =>
          operation({}),
      })
    );
    mockQueryFilter.mockReset();
    mockQueryFilter.mockResolvedValue([]);
    mockStepCapturedFilterCalls.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("filters the batch and keeps the output shape unchanged", async () => {
    mockQueryFilter.mockResolvedValue([
      fakeEventLog([ADDR_A_CHECKSUMMED, ADDR_B, BigInt(123)]),
    ]);

    const result = await queryEventsStep(baseInput());

    expect(result).toEqual({
      success: true,
      events: [
        {
          blockNumber: 150,
          transactionHash: TX_HASH,
          logIndex: 0,
          args: { from: ADDR_A_CHECKSUMMED, to: ADDR_B, value: "123" },
        },
      ],
      fromBlock: 100,
      toBlock: 200,
      eventCount: 1,
    });

    // The batch queried with the indexed arg as topic1; the trailing null
    // wildcard for the empty `to` is trimmed by ethers (verified against
    // ethers 6.17.0), so no topic2 entry is encoded at all.
    expect(mockQueryFilter).toHaveBeenCalledTimes(1);
    const [filter, start, end] = mockQueryFilter.mock.calls[0] as [
      { topics: unknown[] },
      number,
      number,
    ];
    expect(start).toBe(100);
    expect(end).toBe(200);
    expect(filter.topics).toEqual([transferTopic0(), paddedAddress(ADDR_A)]);

    // The step parsed eventArgs once into indexed-positional args before the
    // batch built its filter from them.
    expect(mockStepCapturedFilterCalls).toHaveLength(1);
    expect(mockStepCapturedFilterCalls[0]?.args).toEqual([ADDR_A, null, null]);
  });

  it("accepts eventArgs as a raw array, not just a JSON string", async () => {
    mockQueryFilter.mockResolvedValue([]);

    const result = await queryEventsStep(
      baseInput({ eventArgs: [ADDR_A, ""] })
    );

    expect(result).toEqual({
      success: true,
      events: [],
      fromBlock: 100,
      toBlock: 200,
      eventCount: 0,
    });
    expect(queriedTopics()[0]).toEqual([
      transferTopic0(),
      paddedAddress(ADDR_A),
    ]);
  });

  it("omits eventArgs to run the old unfiltered query", async () => {
    mockQueryFilter.mockResolvedValue([]);

    const result = await queryEventsStep(baseInput({ eventArgs: undefined }));

    expect(result).toEqual({
      success: true,
      events: [],
      fromBlock: 100,
      toBlock: 200,
      eventCount: 0,
    });

    // Unset filters parse to one null wildcard per indexed input, which
    // encodes exactly like the old no-arg filter call: just the topic hash.
    expect(queriedTopics()[0]).toEqual([transferTopic0()]);
    expect(mockStepCapturedFilterCalls[0]?.args).toEqual([null, null, null]);
  });

  it("applies the identical filter to every batch of a multi-batch scan", async () => {
    mockQueryFilter.mockResolvedValue([]);

    // DEFAULT_BATCH_SIZE is 2000: [0,1999] then [2000,2500], both fixed
    // batches (an explicit toBlock is never a tip batch).
    const result = await queryEventsStep(
      baseInput({ fromBlock: "0", toBlock: "2500" })
    );

    expect(result).toMatchObject({
      success: true,
      fromBlock: 0,
      toBlock: 2500,
      eventCount: 0,
    });

    expect(mockQueryFilter).toHaveBeenCalledTimes(2);
    const [topics0, topics1] = queriedTopics();
    expect(topics0).toEqual(topics1);
    expect(topics0).toEqual([transferTopic0(), paddedAddress(ADDR_A)]);
    expect(mockQueryFilter.mock.calls[0]?.slice(1)).toEqual([0, 1999]);
    expect(mockQueryFilter.mock.calls[1]?.slice(1)).toEqual([2000, 2500]);
  });

  describe("eager eventArgs validation", () => {
    it("rejects invalid eventArgs JSON before any RPC", async () => {
      const result = await queryEventsStep(
        baseInput({ eventArgs: "not-json{{" })
      );

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining(
          "Invalid event argument filters: eventArgs is not valid JSON"
        ),
      });
      expect(mockGetRpcProvider).not.toHaveBeenCalled();
      expect(mockQueryFilter).not.toHaveBeenCalled();
    });

    it("rejects a malformed address before any RPC, naming the parameter", async () => {
      const result = await queryEventsStep(
        baseInput({ eventArgs: JSON.stringify(["not-an-address", ""]) })
      );

      expect(result).toMatchObject({ success: false });
      expect((result as { error?: string }).error ?? "").toMatch(
        /^Invalid event argument filters: 'from' \(address\): .*invalid address/i
      );
      expect(mockGetRpcProvider).not.toHaveBeenCalled();
      expect(mockQueryFilter).not.toHaveBeenCalled();
    });

    it("rejects more values than indexed inputs before any RPC", async () => {
      const result = await queryEventsStep(
        baseInput({ eventArgs: JSON.stringify([ADDR_A, ADDR_B, "999"]) })
      );

      expect(result).toEqual({
        success: false,
        error:
          "Invalid event argument filters: eventArgs has 3 value(s) but event 'Transfer' has only 2 indexed input(s)",
      });
      expect(mockGetRpcProvider).not.toHaveBeenCalled();
      expect(mockQueryFilter).not.toHaveBeenCalled();
    });

    it("rejects a non-array eventArgs JSON value before any RPC", async () => {
      const result = await queryEventsStep(
        baseInput({ eventArgs: '{"from":"0xabc"}' })
      );

      expect(result).toEqual({
        success: false,
        error:
          "Invalid event argument filters: eventArgs must be a JSON array of argument values",
      });
      expect(mockGetRpcProvider).not.toHaveBeenCalled();
      expect(mockQueryFilter).not.toHaveBeenCalled();
    });
  });

  it("rejects an unknown event name before touching the provider", async () => {
    const result = await queryEventsStep(
      baseInput({ eventName: "Nope", eventArgs: undefined })
    );

    expect(result).toEqual({
      success: false,
      error: "Event 'Nope' not found in ABI",
    });
    expect(mockGetRpcProvider).not.toHaveBeenCalled();
    expect(mockQueryFilter).not.toHaveBeenCalled();
  });

  it("keeps the fromBlock > toBlock short-circuit unchanged", async () => {
    const result = await queryEventsStep(
      baseInput({ fromBlock: "300", toBlock: "200" })
    );

    expect(result).toEqual({
      success: true,
      events: [],
      fromBlock: 300,
      toBlock: 200,
      eventCount: 0,
    });
    expect(mockQueryFilter).not.toHaveBeenCalled();
  });

  it("softens a failed filtered query when failOnError is false", async () => {
    mockQueryFilter.mockRejectedValue(
      new Error("RPC failed: Timeout after 30000ms")
    );

    const promise = queryEventsStep(baseInput({ failOnError: false }));
    const expectation = expect(promise).resolves.toEqual({
      success: true,
      events: null,
      fromBlock: null,
      toBlock: null,
      eventCount: null,
      error: expect.stringContaining("Event query failed"),
    });
    await vi.runAllTimersAsync();
    await expectation;

    // The filter was still constructed and applied to the attempted batch.
    expect(mockStepCapturedFilterCalls[0]?.args).toEqual([ADDR_A, null, null]);
  });

  it("accepts a filter for an event whose non-indexed input comes first", async () => {
    // Regression guard for the Mixed(uint256 amount, address indexed who)
    // positional bug (found 2026-09-16, issue #2489): the step's eager
    // encodeFilterTopics check expands indexed-only args to full event
    // positions first, so the address lands on `who` instead of the
    // non-indexed `amount`. The null is arg-level only: ethers emits topics
    // for indexed params alone, hence [topic0, topic1=paddedAddress].
    const result = await queryEventsStep(
      baseInput({
        eventName: "Mixed",
        eventArgs: JSON.stringify([ADDR_A]),
      })
    );

    expect(result).toMatchObject({ success: true });
    expect(queriedTopics()[0]).toEqual([
      mustGetStepEvent("Mixed").topicHash,
      paddedAddress(ADDR_A),
    ]);
  });
});
