/**
 * Unit tests for the Event trigger preview.
 *
 * Two subjects, tested at different boundaries:
 *
 *   - lib/workflow/trigger-preview/event-trigger-checks.ts is pure, so it is
 *     called directly. Its job is to reproduce every point at which the event
 *     tracker refuses a workflow without telling the user, and the first
 *     describe block pins that list so a refusal added to the tracker and not
 *     here fails a test.
 *   - lib/workflow/trigger-preview/event-trigger-preview.ts reaches the chain
 *     through rpcManager.executeWithFailover, the same boundary the workflow's
 *     own reads use. These tests mock that boundary and assert the verdict,
 *     the diagnostics and the arithmetic.
 *
 * Log fixtures are encoded with ethers rather than hand-written, so a decoded
 * argument being wrong means the decode is wrong and not the fixture.
 *
 * Run with: pnpm vitest tests/unit/event-trigger-preview.test.ts
 */

import { ethers } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const spies = vi.hoisted(() => ({
  getChainByChainId: vi.fn(),
  getRpcProvider: vi.fn(),
  logUserError: vi.fn(),
}));

vi.mock("@/lib/rpc/chain-service", () => ({
  getChainByChainId: spies.getChainByChainId,
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: spies.getRpcProvider,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { NETWORK_RPC: "network_rpc" },
  logUserError: spies.logUserError,
}));

import {
  resolveTriggerChainId,
  runEventTriggerStaticChecks,
} from "@/lib/workflow/trigger-preview/event-trigger-checks";
import {
  HIGH_VOLUME_FIRES_PER_DAY,
  MAX_PREVIEW_SAMPLES,
  runEventTriggerPreview,
  type WorkflowTriggerPreviewNode,
} from "@/lib/workflow/trigger-preview/event-trigger-preview";
import type {
  EventTriggerPreviewCode,
  EventTriggerPreviewResult,
} from "@/lib/workflow/trigger-preview/types";

const CONTRACT = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const HOLDER = "0xaa0000000000000000000000000000000000aa00";
const RECIPIENT = "0xcc0000000000000000000000000000000000cc00";
const OTHER_RECIPIENT = "0xdd0000000000000000000000000000000000dd00";

const TRANSFER_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Approval",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "spender", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
];

const TRANSFER_IFACE = new ethers.Interface(TRANSFER_ABI);

const EVM_CHAIN = {
  name: "Ethereum Mainnet",
  chainType: "evm",
  isEnabled: true,
  defaultPrimaryWss: "wss://mainnet.example/ws",
};

function eventConfig(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    triggerType: "Event",
    network: "1",
    contractAddress: CONTRACT,
    contractABI: JSON.stringify(TRANSFER_ABI),
    eventName: "Transfer",
    ...overrides,
  };
}

function triggerNodes(
  overrides: Record<string, unknown> = {}
): WorkflowTriggerPreviewNode[] {
  return [
    {
      id: "trigger-1",
      type: "trigger",
      data: { type: "trigger", config: eventConfig(overrides) },
    },
  ];
}

/** An encoded Transfer log, indistinguishable from one an RPC would return. */
function transferLog(params: {
  blockNumber: number;
  to?: string;
  value?: bigint;
  index?: number;
}): ethers.Log {
  const encoded = TRANSFER_IFACE.encodeEventLog("Transfer", [
    HOLDER,
    params.to ?? RECIPIENT,
    params.value ?? BigInt(1000),
  ]);

  return {
    address: CONTRACT,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: params.blockNumber,
    transactionHash: `0x${params.blockNumber.toString(16).padStart(64, "0")}`,
    index: params.index ?? 0,
  } as unknown as ethers.Log;
}

function approvalLog(blockNumber: number): ethers.Log {
  const encoded = TRANSFER_IFACE.encodeEventLog("Approval", [
    HOLDER,
    RECIPIENT,
    BigInt(5),
  ]);

  return {
    address: CONTRACT,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    index: 0,
  } as unknown as ethers.Log;
}

const TRANSFER_TOPIC0 = TRANSFER_IFACE.getEvent("Transfer")?.topicHash;

type FakeProviderOptions = {
  head?: number;
  code?: string;
  /** Called per getLogs; receives the filter so topic-filtered and probe reads can differ. */
  getLogs?: (filter: {
    topics: (string | null)[];
    fromBlock: number;
    toBlock: number;
  }) => ethers.Log[];
  /** Seconds per block used to synthesise block timestamps. Null omits the block. */
  secondsPerBlock?: number | null;
};

const getLogsCalls: { fromBlock: number; toBlock: number; topics: unknown }[] =
  [];

function installProvider(options: FakeProviderOptions = {}): void {
  const head = options.head ?? 10_000;
  const secondsPerBlock =
    options.secondsPerBlock === undefined ? 12 : options.secondsPerBlock;

  const provider = {
    getBlockNumber: () => Promise.resolve(head),
    getCode: () => Promise.resolve(options.code ?? "0x60006000"),
    getLogs: (filter: {
      topics: (string | null)[];
      fromBlock: number;
      toBlock: number;
    }) => {
      getLogsCalls.push({
        fromBlock: filter.fromBlock,
        toBlock: filter.toBlock,
        topics: filter.topics,
      });
      const produced = options.getLogs ? options.getLogs(filter) : [];
      // A real endpoint only returns logs inside the requested range, so the
      // fixture is filtered the same way. Without this a multi-chunk scan
      // would see every fixture log once per chunk.
      return Promise.resolve(
        produced.filter(
          (log) =>
            log.blockNumber >= filter.fromBlock &&
            log.blockNumber <= filter.toBlock
        )
      );
    },
    getBlock: (blockNumber: number) =>
      Promise.resolve(
        secondsPerBlock === null
          ? null
          : { timestamp: blockNumber * secondsPerBlock }
      ),
  };

  spies.getRpcProvider.mockResolvedValue({
    executeWithFailover: (fn: (p: unknown) => unknown) => fn(provider),
  });
}

function codesOf(result: EventTriggerPreviewResult): EventTriggerPreviewCode[] {
  return result.findings.map((entry) => entry.code);
}

beforeEach(() => {
  vi.clearAllMocks();
  getLogsCalls.length = 0;
  spies.getChainByChainId.mockResolvedValue(EVM_CHAIN);
});

describe("event trigger static checks", () => {
  /**
   * The event tracker refuses a registration at each of these points and only
   * logs it inside its own pod. If a refusal is added there, this list is
   * where the preview has to learn about it.
   */
  const TRACKER_REFUSAL_CODES: EventTriggerPreviewCode[] = [
    "NETWORK_MISSING",
    "NETWORK_INVALID",
    "CHAIN_UNKNOWN",
    "CHAIN_HAS_NO_WEBSOCKET",
    "CONTRACT_ADDRESS_MISSING",
    "EVENT_NAME_MISSING",
    "ABI_MISSING",
    "ABI_NOT_JSON",
    "ABI_NOT_ARRAY",
    "ABI_HAS_NO_EVENTS",
    "EVENT_NOT_IN_ABI",
  ];

  function checkWith(overrides: Record<string, unknown>) {
    return runEventTriggerStaticChecks({
      config: eventConfig(overrides),
      chainId: 1,
      chain: EVM_CHAIN,
    });
  }

  it("produces a target when the configuration is complete", () => {
    const result = checkWith({});

    expect(result.findings).toEqual([]);
    expect(result.target).not.toBeNull();
    expect(result.target?.eventName).toBe("Transfer");
    expect(result.target?.topic0).toBe(TRANSFER_TOPIC0);
  });

  it("covers every refusal the event tracker makes silently", () => {
    const produced = new Set<EventTriggerPreviewCode>();

    for (const overrides of [
      { network: "" },
      { network: "not-a-chain" },
      { contractAddress: "" },
      { eventName: "" },
      { contractABI: "" },
      { contractABI: "{not json" },
      { contractABI: JSON.stringify({ type: "event" }) },
      { contractABI: JSON.stringify([{ type: "function", name: "x" }]) },
      { eventName: "Nonexistent" },
    ]) {
      const network = resolveTriggerChainId(eventConfig(overrides));
      if ("finding" in network) {
        produced.add(network.finding.code);
        continue;
      }
      for (const entry of checkWith(overrides).findings) {
        produced.add(entry.code);
      }
    }

    for (const entry of runEventTriggerStaticChecks({
      config: eventConfig(),
      chainId: 1,
      chain: null,
    }).findings) {
      produced.add(entry.code);
    }

    for (const entry of runEventTriggerStaticChecks({
      config: eventConfig(),
      chainId: 1,
      chain: { ...EVM_CHAIN, defaultPrimaryWss: null },
    }).findings) {
      produced.add(entry.code);
    }

    for (const code of TRACKER_REFUSAL_CODES) {
      expect(produced.has(code), `missing coverage for ${code}`).toBe(true);
    }
  });

  it("rejects an invalid contract address", () => {
    const result = checkWith({ contractAddress: "0x1234" });

    expect(result.target).toBeNull();
    expect(result.findings[0].code).toBe("CONTRACT_ADDRESS_INVALID");
    expect(result.findings[0].fieldKey).toBe("contractAddress");
  });

  it("rejects a template reference, which a trigger can never resolve", () => {
    const result = checkWith({
      contractAddress: "{{@node1:Read.contractAddress}}",
    });

    expect(result.target).toBeNull();
    expect(result.findings[0].code).toBe("CONFIG_HAS_TEMPLATE");
  });

  it("names the available events when the selected one is absent", () => {
    const result = checkWith({ eventName: "Nonexistent" });

    expect(result.findings[0].code).toBe("EVENT_NOT_IN_ABI");
    expect(result.findings[0].message).toContain("Transfer");
    expect(result.findings[0].message).toContain("Approval");
  });

  it("refuses an overloaded event name the listener could not resolve", () => {
    const overloaded = [
      TRANSFER_ABI[0],
      {
        type: "event",
        name: "Transfer",
        inputs: [{ name: "from", type: "address", indexed: true }],
        anonymous: false,
      },
    ];

    const result = checkWith({ contractABI: JSON.stringify(overloaded) });

    expect(result.target).toBeNull();
    expect(result.findings[0].code).toBe("EVENT_NAME_AMBIGUOUS");
  });

  it("refuses a chain with no WebSocket endpoint", () => {
    const result = runEventTriggerStaticChecks({
      config: eventConfig(),
      chainId: 1,
      chain: { ...EVM_CHAIN, defaultPrimaryWss: "https://not-a-socket" },
    });

    expect(result.target).toBeNull();
    expect(result.findings[0].code).toBe("CHAIN_HAS_NO_WEBSOCKET");
  });

  it("refuses a non-EVM chain", () => {
    const result = runEventTriggerStaticChecks({
      config: eventConfig(),
      chainId: 101,
      chain: { ...EVM_CHAIN, chainType: "solana" },
    });

    expect(result.findings[0].code).toBe("CHAIN_NOT_EVM");
  });

  it("skips an unparseable fragment without failing the whole ABI", () => {
    const withJunk = [{ type: "event" }, TRANSFER_ABI[0]];

    const result = checkWith({ contractABI: JSON.stringify(withJunk) });

    expect(result.target?.eventName).toBe("Transfer");
  });
});

describe("runEventTriggerPreview: workflow shape", () => {
  it("reports a workflow with no trigger node", async () => {
    const result = await runEventTriggerPreview({ nodes: [] });

    expect(result.verdict).toBe("will-never-fire");
    expect(codesOf(result)).toEqual(["TRIGGER_NODE_MISSING"]);
    expect(result.scan).toBeNull();
  });

  it("declines a non-Event trigger without claiming it is broken", async () => {
    const result = await runEventTriggerPreview({
      nodes: [
        {
          id: "t",
          type: "trigger",
          data: { type: "trigger", config: { triggerType: "Schedule" } },
        },
      ],
    });

    expect(result.verdict).toBe("unknown");
    expect(codesOf(result)).toEqual(["TRIGGER_TYPE_NOT_EVENT"]);
    expect(result.summary).toContain("Schedule");
  });

  it("never reaches the chain when a static check blocks", async () => {
    const result = await runEventTriggerPreview({
      nodes: triggerNodes({ contractABI: "{not json" }),
    });

    expect(result.verdict).toBe("will-never-fire");
    expect(codesOf(result)).toContain("ABI_NOT_JSON");
    expect(spies.getRpcProvider).not.toHaveBeenCalled();
  });
});

describe("runEventTriggerPreview: chain scan", () => {
  it("counts matches and estimates a daily rate", async () => {
    installProvider({
      head: 10_000,
      getLogs: (filter) =>
        filter.topics.length > 0
          ? [
              transferLog({ blockNumber: 9000 }),
              transferLog({ blockNumber: 9500 }),
            ]
          : [],
    });

    const result = await runEventTriggerPreview({ nodes: triggerNodes() });

    expect(result.verdict).toBe("ok");
    expect(result.matchCount).toBe(2);
    expect(result.filteredOutCount).toBe(0);
    expect(result.scan).toEqual({
      fromBlock: 5000,
      toBlock: 10_000,
      blocksScanned: 5001,
      spanSeconds: 60_000,
    });
    // 2 matches over 60000s -> 2 * 86400 / 60000 = 2.88
    expect(result.estimatedFiresPerDay).toBe(2.9);
  });

  it("decodes event arguments, newest match first", async () => {
    installProvider({
      getLogs: (filter) =>
        filter.topics.length > 0
          ? [
              transferLog({ blockNumber: 9000, value: BigInt(1) }),
              transferLog({ blockNumber: 9900, value: BigInt(7) }),
            ]
          : [],
    });

    const result = await runEventTriggerPreview({ nodes: triggerNodes() });

    expect(result.samples).toHaveLength(2);
    expect(result.samples[0].blockNumber).toBe(9900);
    expect(result.samples[0].args.value).toBe("7");
    expect((result.samples[0].args.to as string).toLowerCase()).toBe(
      RECIPIENT.toLowerCase()
    );
  });

  it("renders a nested bigint argument as JSON-safe data", async () => {
    // A uint256[] decodes to a Result of bigints. Converting only top-level
    // values leaves those in place, and the route's JSON.stringify then throws
    // "Do not know how to serialize a BigInt" and turns a preview into a 500.
    const arrayAbi = [
      {
        type: "event",
        name: "Batch",
        inputs: [
          { name: "who", type: "address", indexed: true },
          { name: "amounts", type: "uint256[]", indexed: false },
        ],
        anonymous: false,
      },
    ];
    const arrayIface = new ethers.Interface(arrayAbi);
    const encoded = arrayIface.encodeEventLog("Batch", [
      HOLDER,
      [BigInt(1), BigInt(2)],
    ]);
    const log = {
      address: CONTRACT,
      topics: encoded.topics,
      data: encoded.data,
      blockNumber: 9000,
      transactionHash: `0x${"9".padStart(64, "0")}`,
      index: 0,
    } as unknown as ethers.Log;

    installProvider({
      getLogs: (filter) => (filter.topics.length > 0 ? [log] : []),
    });

    const result = await runEventTriggerPreview({
      nodes: triggerNodes({
        contractABI: JSON.stringify(arrayAbi),
        eventName: "Batch",
      }),
    });

    expect(result.matchCount).toBe(1);
    expect(result.samples[0].args.amounts).toEqual(["1", "2"]);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("stops the empty-window probe at the first log it finds", async () => {
    installProvider({
      head: 10_000,
      // Nothing matches topic0; the unfiltered probe finds a log in its first
      // chunk and must not keep reading the rest of the window.
      getLogs: (filter) =>
        filter.topics.length > 0 ? [] : [approvalLog(5001)],
    });

    const result = await runEventTriggerPreview({
      nodes: triggerNodes(),
      lookbackBlocks: 5000,
    });

    expect(codesOf(result)).toContain("NO_MATCHES_CONTRACT_ACTIVE");

    const probeCalls = getLogsCalls.filter(
      (call) => (call.topics as unknown[]).length === 0
    );
    expect(probeCalls).toHaveLength(1);
  });

  it("bounds the number of samples returned", async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      transferLog({ blockNumber: 9000 + i, index: i })
    );
    installProvider({
      getLogs: (filter) => (filter.topics.length > 0 ? many : []),
    });

    const result = await runEventTriggerPreview({ nodes: triggerNodes() });

    expect(result.matchCount).toBe(20);
    expect(result.samples).toHaveLength(MAX_PREVIEW_SAMPLES);
  });

  it("calls out an address that holds no contract code", async () => {
    installProvider({ code: "0x" });

    const result = await runEventTriggerPreview({ nodes: triggerNodes() });

    expect(result.verdict).toBe("will-never-fire");
    expect(codesOf(result)).toEqual(["CONTRACT_HAS_NO_CODE"]);
    expect(result.scan).toBeNull();
  });

  it("distinguishes a quiet event on a live contract from a dead one", async () => {
    installProvider({
      getLogs: (filter) =>
        filter.topics.length > 0 ? [] : [approvalLog(9100)],
    });

    const result = await runEventTriggerPreview({ nodes: triggerNodes() });

    expect(result.verdict).toBe("no-recent-matches");
    expect(codesOf(result)).toContain("NO_MATCHES_CONTRACT_ACTIVE");
  });

  it("reports a contract that emitted nothing at all", async () => {
    installProvider({ getLogs: () => [] });

    const result = await runEventTriggerPreview({ nodes: triggerNodes() });

    expect(result.verdict).toBe("no-recent-matches");
    expect(codesOf(result)).toContain("NO_MATCHES_CONTRACT_SILENT");
  });

  it("reports when a recipient filter excluded every emitted event", async () => {
    installProvider({
      getLogs: (filter) =>
        filter.topics.length > 0
          ? [transferLog({ blockNumber: 9000, to: OTHER_RECIPIENT })]
          : [],
    });

    const result = await runEventTriggerPreview({
      nodes: triggerNodes({ recipientAddress: RECIPIENT }),
    });

    expect(result.matchCount).toBe(0);
    expect(result.filteredOutCount).toBe(1);
    expect(codesOf(result)).toContain("FILTERS_EXCLUDED_EVERY_MATCH");
    // The contract was demonstrably emitting, so the silent-contract probe
    // must not also fire.
    expect(codesOf(result)).not.toContain("NO_MATCHES_CONTRACT_SILENT");
  });

  it("keeps a match that satisfies the recipient filter", async () => {
    installProvider({
      getLogs: (filter) =>
        filter.topics.length > 0
          ? [
              transferLog({ blockNumber: 9000, to: RECIPIENT }),
              transferLog({ blockNumber: 9001, to: OTHER_RECIPIENT }),
            ]
          : [],
    });

    const result = await runEventTriggerPreview({
      nodes: triggerNodes({ recipientAddress: RECIPIENT }),
    });

    expect(result.matchCount).toBe(1);
    expect(result.filteredOutCount).toBe(1);
    expect(result.verdict).toBe("ok");
  });

  it("ignores a log that decodes to a different event in the same ABI", async () => {
    installProvider({
      getLogs: (filter) =>
        filter.topics.length > 0
          ? [approvalLog(9000), transferLog({ blockNumber: 9001 })]
          : [],
    });

    const result = await runEventTriggerPreview({ nodes: triggerNodes() });

    expect(result.matchCount).toBe(1);
    expect(result.samples[0].blockNumber).toBe(9001);
  });

  it("flags a trigger whose rate would be a cost problem", async () => {
    // 5 blocks apart at 12s each is 48 seconds of span; 100 matches over that
    // window extrapolates far past the high-volume line.
    installProvider({
      head: 1000,
      getLogs: (filter) =>
        filter.topics.length > 0
          ? Array.from({ length: 100 }, (_, i) =>
              transferLog({ blockNumber: 996 + (i % 5), index: i })
            )
          : [],
    });

    const result = await runEventTriggerPreview({
      nodes: triggerNodes(),
      lookbackBlocks: 4,
    });

    expect(result.matchCount).toBe(100);
    expect(result.estimatedFiresPerDay).toBeGreaterThan(
      HIGH_VOLUME_FIRES_PER_DAY
    );
    expect(result.verdict).toBe("high-volume");
    expect(codesOf(result)).toContain("HIGH_VOLUME");
  });

  it("stops scanning past the log ceiling and measures the rate over what it read", async () => {
    // 6000 logs in the first 2000-block chunk, which is past MAX_LOGS_SCANNED.
    const flood = Array.from({ length: 6000 }, (_, i) =>
      transferLog({ blockNumber: 5000 + (i % 2000), index: i })
    );
    installProvider({
      head: 10_000,
      getLogs: (filter) => (filter.topics.length > 0 ? flood : []),
    });

    const result = await runEventTriggerPreview({
      nodes: triggerNodes(),
      lookbackBlocks: 5000,
    });

    expect(result.verdict).toBe("high-volume");
    expect(codesOf(result)).toContain("HIGH_VOLUME");
    // Only the first chunk was read, so the window reported is the window
    // actually scanned rather than the one requested.
    expect(result.scan?.toBlock).toBe(6999);
    expect(result.scan?.fromBlock).toBe(5000);
  });

  it("splits a wide window into bounded getLogs calls", async () => {
    installProvider({ head: 10_000, getLogs: () => [] });

    await runEventTriggerPreview({
      nodes: triggerNodes(),
      lookbackBlocks: 5000,
    });

    const topicCalls = getLogsCalls.filter(
      (call) => (call.topics as unknown[]).length > 0
    );

    expect(topicCalls).toHaveLength(3);
    expect(topicCalls[0]).toMatchObject({ fromBlock: 5000, toBlock: 6999 });
    expect(topicCalls[1]).toMatchObject({ fromBlock: 7000, toBlock: 8999 });
    expect(topicCalls[2]).toMatchObject({ fromBlock: 9000, toBlock: 10_000 });
  });

  it("stops at the deadline and says so without claiming high volume", async () => {
    installProvider({
      head: 10_000,
      getLogs: (filter) =>
        filter.topics.length > 0 ? [transferLog({ blockNumber: 5500 })] : [],
    });

    // Already expired: the first chunk still runs, the rest do not.
    const result = await runEventTriggerPreview({
      nodes: triggerNodes(),
      lookbackBlocks: 5000,
      deadlineAt: Date.now() - 1,
    });

    const topicCalls = getLogsCalls.filter(
      (call) => (call.topics as unknown[]).length > 0
    );
    expect(topicCalls).toHaveLength(1);

    expect(codesOf(result)).toContain("SCAN_TRUNCATED");
    // A slow scan is not a busy trigger.
    expect(codesOf(result)).not.toContain("HIGH_VOLUME");
    expect(result.verdict).toBe("ok");
    expect(result.matchCount).toBe(1);
    // Counts are reported over the blocks actually covered.
    expect(result.scan?.toBlock).toBe(6999);
  });

  it("clamps a lookback beyond the ceiling instead of rejecting it", async () => {
    installProvider({ head: 1_000_000, getLogs: () => [] });

    await runEventTriggerPreview({
      nodes: triggerNodes(),
      lookbackBlocks: Number.MAX_SAFE_INTEGER,
    });

    const first = getLogsCalls[0];
    expect(first.fromBlock).toBe(950_000);
  });

  it("still reports matches when block timestamps are unreadable", async () => {
    installProvider({
      secondsPerBlock: null,
      getLogs: (filter) =>
        filter.topics.length > 0 ? [transferLog({ blockNumber: 9000 })] : [],
    });

    const result = await runEventTriggerPreview({ nodes: triggerNodes() });

    expect(result.verdict).toBe("ok");
    expect(result.matchCount).toBe(1);
    expect(result.scan?.spanSeconds).toBeNull();
    expect(result.estimatedFiresPerDay).toBeNull();
  });

  it("degrades to unknown when the chain cannot be reached", async () => {
    spies.getRpcProvider.mockRejectedValue(new Error("all endpoints failed"));

    const result = await runEventTriggerPreview({ nodes: triggerNodes() });

    expect(result.verdict).toBe("unknown");
    expect(codesOf(result)).toEqual(["SCAN_UNAVAILABLE"]);
    expect(result.matchCount).toBeNull();
    expect(spies.logUserError).toHaveBeenCalled();
  });

  it("degrades to unknown when a getLogs call fails mid-scan", async () => {
    spies.getRpcProvider.mockResolvedValue({
      executeWithFailover: (fn: (p: unknown) => unknown) =>
        fn({
          getBlockNumber: () => Promise.resolve(10_000),
          getCode: () => Promise.resolve("0x60006000"),
          getLogs: () => Promise.reject(new Error("range too wide")),
          getBlock: () => Promise.resolve({ timestamp: 1 }),
        }),
    });

    const result = await runEventTriggerPreview({ nodes: triggerNodes() });

    expect(result.verdict).toBe("unknown");
    expect(codesOf(result)).toEqual(["SCAN_UNAVAILABLE"]);
  });
});
