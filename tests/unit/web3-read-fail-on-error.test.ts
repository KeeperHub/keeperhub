import { beforeEach, describe, expect, it, vi } from "vitest";

// The web3 read steps' shared "Fail workflow on error" toggle: when off, a
// failed on-chain read hands the next node a soft error instead of failing the
// run, mirroring HTTP Request's failOnError. Config problems always hard-fail.

vi.mock("server-only", () => ({}));

const { mockGetBalance, mockGetAddressUrl, mockGetRpcProvider } = vi.hoisted(
  () => ({
    mockGetBalance: vi.fn(),
    mockGetAddressUrl: vi.fn(),
    mockGetRpcProvider: vi.fn(),
  })
);

vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: () => ({
    getBalance: (...args: unknown[]) => mockGetBalance(...args),
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

import { checkBalanceStep } from "@/plugins/web3/steps/check-balance";
import { queryEventsStep } from "@/plugins/web3/steps/query-events";
import { applyReadFailOnError } from "@/plugins/web3/steps/read-fail-on-error-core";

const VALID_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const RPC_URL = "https://eth-mainnet.g.alchemy.com/v2/secret-key";

describe("applyReadFailOnError", () => {
  type Probe =
    | { success: true; data: unknown; error?: string }
    | { success: false; destinationError?: true; error: string };
  const soft = { data: null };
  const failure: Probe = { success: false, error: "boom" };

  it("leaves the failure alone when the toggle is at its default", () => {
    expect(applyReadFailOnError<Probe>(failure, undefined, soft)).toBe(failure);
    expect(applyReadFailOnError<Probe>(failure, true, soft)).toBe(failure);
    expect(applyReadFailOnError<Probe>(failure, "true", soft)).toBe(failure);
  });

  it("softens for both the boolean and the string the editor persists", () => {
    expect(applyReadFailOnError<Probe>(failure, false, soft)).toEqual({
      data: null,
      success: true,
      error: "boom",
    });
    expect(applyReadFailOnError<Probe>(failure, "false", soft)).toEqual({
      data: null,
      success: true,
      error: "boom",
    });
  });

  it("never softens a destination failure, whatever the toggle says", () => {
    // Mirrors HTTP Request refusing to soften an unusable URL: a null-data
    // success would hide a node that can never work.
    const unreachable: Probe = {
      success: false,
      destinationError: true,
      error: "Invalid contract address",
    };

    expect(applyReadFailOnError<Probe>(unreachable, false, soft)).toBe(
      unreachable
    );
  });

  it("leaves a success untouched", () => {
    const ok: Probe = { success: true, data: 1 };

    expect(applyReadFailOnError<Probe>(ok, false, soft)).toBe(ok);
  });

  it("redacts provider URLs, which nothing downstream would redact", () => {
    const withUrl: Probe = { success: false, error: `RPC failed: ${RPC_URL}` };
    const result = applyReadFailOnError<Probe>(withUrl, false, soft) as {
      error: string;
    };

    expect(result.error).not.toContain("alchemy.com");
    expect(result.error).not.toContain("secret-key");
  });
});

describe("checkBalanceStep - failOnError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAddressUrl.mockResolvedValue("https://etherscan.io/address/0x123");
    mockGetRpcProvider.mockResolvedValue({});
  });

  it("hard-fails a failed read by default", async () => {
    mockGetBalance.mockRejectedValue(new Error(`connection lost ${RPC_URL}`));

    const result = await checkBalanceStep({
      network: "mainnet",
      address: VALID_ADDRESS,
    });

    expect(result.success).toBe(false);
  });

  it("softens a failed read when the toggle is off", async () => {
    mockGetBalance.mockRejectedValue(new Error("connection lost"));

    const result = await checkBalanceStep({
      network: "mainnet",
      address: VALID_ADDRESS,
      failOnError: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    // Null, not "0": a read that never completed must not report a balance a
    // downstream Condition would compare against.
    expect(result.balance).toBeNull();
    expect(result.balanceWei).toBeNull();
    expect(result.address).toBe(VALID_ADDRESS);
    expect(result.error).toContain("Failed to check balance");
  });

  it("redacts the provider URL in the softened error", async () => {
    mockGetBalance.mockRejectedValue(new Error(`connection lost ${RPC_URL}`));

    const result = await checkBalanceStep({
      network: "mainnet",
      address: VALID_ADDRESS,
      failOnError: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.error).not.toContain("alchemy.com");
    expect(result.error).not.toContain("secret-key");
  });

  it("still hard-fails an invalid address when the toggle is off", async () => {
    const result = await checkBalanceStep({
      network: "mainnet",
      address: "not-an-address",
      failOnError: false,
    });

    expect(result.success).toBe(false);
    expect(mockGetBalance).not.toHaveBeenCalled();
  });

  it("still hard-fails an unknown network when the toggle is off", async () => {
    const result = await checkBalanceStep({
      network: "not-a-chain",
      address: VALID_ADDRESS,
      failOnError: false,
    });

    expect(result.success).toBe(false);
  });

  it("still hard-fails an unresolved RPC config when the toggle is off", async () => {
    mockGetRpcProvider.mockRejectedValue(new Error("No RPC configured"));

    const result = await checkBalanceStep({
      network: "mainnet",
      address: VALID_ADDRESS,
      failOnError: false,
    });

    expect(result.success).toBe(false);
    expect(mockGetBalance).not.toHaveBeenCalled();
  });
});

const EVENT_ABI = [
  {
    name: "Lift",
    type: "event",
    inputs: [{ name: "account", type: "address", indexed: true }],
  },
];

describe("queryEventsStep - failOnError", () => {
  const eventInput = {
    network: "mainnet",
    contractAddress: VALID_ADDRESS,
    abi: JSON.stringify(EVENT_ABI),
    eventName: "Lift",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAddressUrl.mockResolvedValue("");
    // resolveBlockRange runs inside executeWithFailover and returns its own
    // result object, so a failed range read surfaces as this value.
    mockGetRpcProvider.mockResolvedValue({
      executeWithFailover: () =>
        Promise.resolve({
          success: false,
          error: "Failed to resolve block range: RPC timeout",
        }),
    });
  });

  it("softens a failed block-range read when the toggle is off", async () => {
    const result = await queryEventsStep({ ...eventInput, failOnError: false });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    // Null, not []: a query that never ran must not look like "no events".
    expect(result.events).toBeNull();
    expect(result.eventCount).toBeNull();
    expect(result.error).toContain("RPC timeout");
  });

  it("hard-fails the same read by default", async () => {
    const result = await queryEventsStep(eventInput);

    expect(result.success).toBe(false);
  });

  it("softens an event missing from the ABI, which is payload not destination", async () => {
    const result = await queryEventsStep({
      ...eventInput,
      eventName: "NotAnEvent",
      failOnError: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.events).toBeNull();
    expect(result.error).toContain("NotAnEvent");
  });

  it("still hard-fails an invalid contract address when the toggle is off", async () => {
    const result = await queryEventsStep({
      ...eventInput,
      contractAddress: "not-an-address",
      failOnError: false,
    });

    expect(result.success).toBe(false);
  });
});
