import { beforeEach, describe, expect, it, vi } from "vitest";

// Where the indexed-argument filter is compiled inside queryEventsStep, not
// what it compiles to (event-arg-filter-core.test.ts covers that). A filter
// that cannot be encoded has to be rejected before an RPC provider is
// requested: encoding it after the provider is acquired still returns the
// right error, so nothing here would fail, while every run pays for a scan
// whose result was already decided.

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

const CONTRACT = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

// A non-indexed input ahead of an indexed one: the shape that separates
// "positional over the indexed inputs" from "positional over every input".
const EVENT_ABI = [
  {
    name: "Lift",
    type: "event",
    inputs: [
      { name: "amount", type: "uint256", indexed: false },
      { name: "account", type: "address", indexed: true },
    ],
  },
];

describe("queryEventsStep - indexed argument filters", () => {
  const eventInput = {
    network: "mainnet",
    contractAddress: CONTRACT,
    abi: JSON.stringify(EVENT_ABI),
    eventName: "Lift",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAddressUrl.mockResolvedValue("");
    mockGetRpcProvider.mockResolvedValue({
      executeWithFailover: () =>
        Promise.resolve({
          success: false,
          error: "Failed to resolve block range: RPC timeout",
        }),
    });
  });

  it("rejects a value it cannot encode before asking for a provider", async () => {
    const result = await queryEventsStep({
      ...eventInput,
      eventArgs: JSON.stringify({ account: "not-an-address" }),
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    // Named, because ethers' own encoder error names neither the parameter
    // nor the step and leaves the user guessing which input was wrong.
    expect(result.error).toContain("account");
    expect(mockGetRpcProvider).not.toHaveBeenCalled();
  });

  it("rejects a parameter the event does not index, before a provider", async () => {
    const result = await queryEventsStep({
      ...eventInput,
      eventArgs: JSON.stringify({ amount: "1" }),
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toContain("amount");
    expect(mockGetRpcProvider).not.toHaveBeenCalled();
  });

  it("asks for a provider once the filter compiles", async () => {
    // The control for the two above: without it they would still pass if the
    // step never reached the provider at all.
    const result = await queryEventsStep({
      ...eventInput,
      eventArgs: JSON.stringify({ account: CONTRACT }),
    });

    expect(result.success).toBe(false);
    expect(mockGetRpcProvider).toHaveBeenCalled();
  });

  it("asks for a provider when no filter is set", async () => {
    const result = await queryEventsStep(eventInput);

    expect(result.success).toBe(false);
    expect(mockGetRpcProvider).toHaveBeenCalled();
  });
});
