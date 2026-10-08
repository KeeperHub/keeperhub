import { ethers } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// queryEventsStep end to end, with only the RPC provider replaced by a fake node.

vi.mock("server-only", () => ({}));

const { mockGetAddressUrl, mockGetRpcProvider } = vi.hoisted(() => ({
  mockGetAddressUrl: vi.fn(),
  mockGetRpcProvider: vi.fn(),
}));

vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: () => ({
    getAddressUrl: (...args: unknown[]) => mockGetAddressUrl(...args),
  }),
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: (network: string) => {
    if (network === "mainnet") {
      return 1;
    }
    throw new Error(`Unsupported network: ${network}`);
  },
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: (...args: unknown[]) => mockGetRpcProvider(...args),
  isSolanaChain: () => false,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id", userId: "userId" },
  explorerConfigs: { id: "id", chainId: "chainId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  sql: () => ({}),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "validation", NETWORK_RPC: "network_rpc" },
  logUserError: vi.fn(),
}));

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

import { queryEventsStep } from "@/plugins/web3/steps/query-events";
import { TIP_SAFETY_MARGIN_BLOCKS } from "@/plugins/web3/steps/query-events-core";
import { emitted, FakeLogNode, singleNodeRpc } from "../mocks/fake-log-node";

const VAULT = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const ALICE = "0x4444444444444444444444444444444444444444";
const BOB = "0x5555555555555555555555555555555555555555";

const PAUSABLE = new ethers.Interface([
  "event Paused(address account)",
  "event Unpaused(address account)",
]);
const TOKEN_EVENTS = new ethers.Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const HEAD = 1000;

function chain(): FakeLogNode {
  return new FakeLogNode(HEAD, [
    emitted(TOKEN, TOKEN_EVENTS, "Transfer", [ALICE, BOB, BigInt(5)], 150, 4),
    emitted(VAULT, PAUSABLE, "Paused", [ALICE], 150, 1),
    emitted(TOKEN, TOKEN_EVENTS, "Transfer", [BOB, ALICE, BigInt(7)], 160, 0),
    emitted(VAULT, PAUSABLE, "Unpaused", [BOB], 990, 0),
    emitted(TOKEN, TOKEN_EVENTS, "Transfer", [ALICE, BOB, BigInt(8)], 997, 1),
    emitted(TOKEN, TOKEN_EVENTS, "Transfer", [BOB, ALICE, BigInt(6)], 998, 2),
  ]);
}

const TX_HASH = expect.stringMatching(/^0x[0-9a-f]{64}$/);

const multipleInput = {
  network: "mainnet",
  queryMode: "multiple",
  eventQueries: JSON.stringify([
    {
      contractAddress: VAULT,
      abi: PAUSABLE.formatJson(),
      eventName: "Paused",
      useManualAbi: "false",
    },
    {
      contractAddress: VAULT,
      abi: PAUSABLE.formatJson(),
      eventName: "Unpaused",
    },
    {
      contractAddress: TOKEN,
      abi: TOKEN_EVENTS.formatJson(),
      eventName: "Transfer",
      eventArgs: { from: ALICE },
    },
  ]),
  fromBlock: "100",
};

let node: FakeLogNode;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAddressUrl.mockResolvedValue("");
  node = chain();
  mockGetRpcProvider.mockResolvedValue(singleNodeRpc(node));
});

describe("queryEventsStep - single event (existing configs)", () => {
  const legacyInput = {
    network: "mainnet",
    contractAddress: TOKEN,
    abi: TOKEN_EVENTS.formatJson(),
    eventName: "Transfer",
    fromBlock: "100",
    toBlock: "999",
  };
  const transfer = (
    blockNumber: number,
    logIndex: number,
    from: string,
    to: string,
    value: string
  ) => ({
    blockNumber,
    transactionHash: TX_HASH,
    logIndex,
    args: { from, to, value },
  });
  const legacyResult = {
    success: true,
    events: [
      transfer(150, 4, ALICE, BOB, "5"),
      transfer(160, 0, BOB, ALICE, "7"),
      transfer(997, 1, ALICE, BOB, "8"),
      transfer(998, 2, BOB, ALICE, "6"),
    ],
    fromBlock: 100,
    toBlock: 999,
    eventCount: 4,
  };

  it("returns the same shape as before for a config with no query mode, with no tags added", async () => {
    expect(await queryEventsStep(legacyInput)).toEqual(legacyResult);
  });

  it("runs the single-event query for an explicit single mode and for leftovers from other actions", async () => {
    // Leftovers from batch-read-contract, and hidden eventQueries from multiple mode.
    for (const extra of [
      { queryMode: "single" },
      { inputMode: "mixed", batchSize: "100" },
      { eventQueries: multipleInput.eventQueries },
    ]) {
      expect(await queryEventsStep({ ...legacyInput, ...extra })).toEqual(
        legacyResult
      );
    }
  });
});

describe("queryEventsStep - multiple events", () => {
  it("returns one tagged list in block order across contracts and events", async () => {
    const result = await queryEventsStep(multipleInput);

    // BOB's transfers fail the from = ALICE filter; block 997 is past the end.
    expect(result).toEqual({
      success: true,
      events: [
        {
          contractAddress: VAULT,
          eventName: "Paused",
          blockNumber: 150,
          transactionHash: TX_HASH,
          logIndex: 1,
          args: { account: ALICE },
        },
        {
          contractAddress: TOKEN,
          eventName: "Transfer",
          blockNumber: 150,
          transactionHash: TX_HASH,
          logIndex: 4,
          args: { from: ALICE, to: BOB, value: "5" },
        },
        {
          contractAddress: VAULT,
          eventName: "Unpaused",
          blockNumber: 990,
          transactionHash: TX_HASH,
          logIndex: 0,
          args: { account: BOB },
        },
      ],
      fromBlock: 100,
      toBlock: HEAD - TIP_SAFETY_MARGIN_BLOCKS,
      eventCount: 3,
    });
  });

  it("ends a latest range short of the head and queries every batch at a fixed block", async () => {
    const result = await queryEventsStep(multipleInput);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    const end = HEAD - TIP_SAFETY_MARGIN_BLOCKS;
    expect(result.fromBlock).toBe(100);
    expect(result.toBlock).toBe(end);
    // One call for the vault's two events, one for the filtered transfers.
    expect(node.getLogsCalls).toHaveLength(2);
    for (const call of node.getLogsCalls) {
      expect(call.toBlock).toBe(ethers.toQuantity(end));
    }
  });

  it("measures the lookback back from the end it reports", async () => {
    const result = await queryEventsStep({
      ...multipleInput,
      fromBlock: undefined,
      blockCount: "50",
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.toBlock).toBe(HEAD - TIP_SAFETY_MARGIN_BLOCKS);
    expect(result.fromBlock).toBe(HEAD - TIP_SAFETY_MARGIN_BLOCKS - 50);
  });

  it("keeps an explicit To Block as given", async () => {
    const result = await queryEventsStep({ ...multipleInput, toBlock: "999" });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.toBlock).toBe(999);
    expect(result.events?.map((event) => event.blockNumber)).toEqual([
      150, 150, 990, 997,
    ]);
  });

  it("rejects an invalid entry, naming it, before asking for a provider", async () => {
    const entries = JSON.parse(multipleInput.eventQueries) as Record<
      string,
      unknown
    >[];
    entries[2] = { ...entries[2], eventArgs: { value: "1" } };

    const result = await queryEventsStep({
      ...multipleInput,
      eventQueries: JSON.stringify(entries),
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toContain("Event 3 (Transfer)");
    expect(result.error).toContain("'value'");
    expect(mockGetRpcProvider).not.toHaveBeenCalled();
  });
});

describe("queryEventsStep - multiple events and failOnError", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    node.getLogsError = new Error("RPC timeout");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails the run on an RPC failure by default", async () => {
    const promise = queryEventsStep(multipleInput);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toContain("Event query failed: RPC timeout");
  });

  it("softens the same failure into null data when the toggle is off", async () => {
    const promise = queryEventsStep({ ...multipleInput, failOnError: false });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({
      success: true,
      events: null,
      fromBlock: null,
      toBlock: null,
      eventCount: null,
      error: expect.stringContaining("RPC timeout"),
    });
  });

  it("never softens an entry with no usable contract address", async () => {
    const result = await queryEventsStep({
      ...multipleInput,
      eventQueries: JSON.stringify([
        {
          contractAddress: "0x1234",
          abi: PAUSABLE.formatJson(),
          eventName: "Paused",
        },
      ]),
      failOnError: false,
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toContain("Event 1 has an invalid contract address");
  });
});
