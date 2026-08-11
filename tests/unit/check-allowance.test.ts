import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    VALIDATION: "validation",
    NETWORK_RPC: "network_rpc",
  },
  logUserError: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id", userId: "userId" },
  supportedTokens: {
    id: "id",
    chainId: "chainId",
    tokenAddress: "tokenAddress",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  inArray: () => ({}),
  // KEEP-966: lib/db/schema-extensions.ts's directExecutions.receipts column
  // default (sql`'[]'::jsonb`) is evaluated at module-import time, so this
  // transitively-loaded mock needs a stand-in tagged-template function.
  sql: () => ({}),
}));

// Mock RPC resolution
const mockGetChainIdFromNetwork = vi.fn();
const mockGetRpcProvider = vi.fn();

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: (...args: unknown[]) =>
    mockGetChainIdFromNetwork(...args),
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: (...args: unknown[]) => mockGetRpcProvider(...args),
  isSolanaChain: () => false,
}));

// Mock ethers Contract methods
const mockAllowance = vi.fn();
const mockDecimals = vi.fn();
const mockSymbol = vi.fn();

vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: class MockProvider {},
      Contract: class MockContract {
        allowance = mockAllowance;
        decimals = mockDecimals;
        symbol = mockSymbol;
      },
    },
  };
});

vi.mock("@/lib/contracts/abis/erc20.json", () => ({
  default: [
    { name: "allowance", type: "function", inputs: [], outputs: [] },
    { name: "decimals", type: "function", inputs: [], outputs: [] },
    { name: "symbol", type: "function", inputs: [], outputs: [] },
  ],
}));

// Must import AFTER all mocks
import type { CheckAllowanceInput } from "@/plugins/web3/steps/check-allowance";
import { checkAllowanceStep } from "@/plugins/web3/steps/check-allowance";

const VALID_TOKEN = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const VALID_OWNER = "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0";
const VALID_SPENDER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";

type CheckAllowanceResult =
  | {
      success: true;
      allowance: string;
      allowanceRaw: string;
      symbol: string;
    }
  | { success: false; error: string };

function makeInput(
  overrides: Partial<CheckAllowanceInput>
): CheckAllowanceInput {
  return {
    network: "ethereum",
    tokenConfig: VALID_TOKEN,
    ownerAddress: VALID_OWNER,
    spenderAddress: VALID_SPENDER,
    ...overrides,
  } as CheckAllowanceInput;
}

function setupMocks(): void {
  mockGetChainIdFromNetwork.mockReturnValue(1);
  mockGetRpcProvider.mockResolvedValue({
    executeWithFailover: (fn: (provider: unknown) => unknown) =>
      fn(new (class MockProvider {})()),
  });
  mockDecimals.mockResolvedValue(BigInt(18));
  mockSymbol.mockResolvedValue("DAI");
  mockAllowance.mockResolvedValue(BigInt("1000000000000000000"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("check-allowance - validation", () => {
  it("fails when token address is invalid", async () => {
    setupMocks();
    const result = (await checkAllowanceStep(
      makeInput({ tokenConfig: "not-an-address" })
    )) as CheckAllowanceResult;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("No token selected");
    }
  });

  it("fails when owner address is invalid", async () => {
    setupMocks();
    const result = (await checkAllowanceStep(
      makeInput({ ownerAddress: "invalid" })
    )) as CheckAllowanceResult;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid owner address");
    }
  });

  it("fails when spender address is invalid", async () => {
    setupMocks();
    const result = (await checkAllowanceStep(
      makeInput({ spenderAddress: "invalid" })
    )) as CheckAllowanceResult;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid spender address");
    }
  });

  it("fails when network resolution fails", async () => {
    mockGetChainIdFromNetwork.mockImplementation(() => {
      throw new Error("Unknown network: foochain");
    });
    const result = (await checkAllowanceStep(
      makeInput({ network: "foochain" })
    )) as CheckAllowanceResult;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Unknown network");
    }
  });
});

describe("check-allowance - successful checks", () => {
  it("returns formatted allowance", async () => {
    setupMocks();
    mockAllowance.mockResolvedValue(BigInt("1000000000000000000"));

    const result = (await checkAllowanceStep(
      makeInput({})
    )) as CheckAllowanceResult;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.allowance).toBe("1.0");
      expect(result.allowanceRaw).toBe("1000000000000000000");
      expect(result.symbol).toBe("DAI");
    }
  });

  it("returns zero allowance", async () => {
    setupMocks();
    mockAllowance.mockResolvedValue(BigInt(0));

    const result = (await checkAllowanceStep(
      makeInput({})
    )) as CheckAllowanceResult;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.allowance).toBe("0.0");
      expect(result.allowanceRaw).toBe("0");
    }
  });

  it("handles 6-decimal tokens (USDC)", async () => {
    setupMocks();
    mockDecimals.mockResolvedValue(BigInt(6));
    mockSymbol.mockResolvedValue("USDC");
    mockAllowance.mockResolvedValue(BigInt("500000000"));

    const result = (await checkAllowanceStep(
      makeInput({})
    )) as CheckAllowanceResult;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.allowance).toBe("500.0");
      expect(result.allowanceRaw).toBe("500000000");
      expect(result.symbol).toBe("USDC");
    }
  });
});

describe("check-allowance - error handling", () => {
  it("fails when RPC call throws", async () => {
    setupMocks();
    mockAllowance.mockRejectedValue(new Error("RPC timeout"));

    const result = (await checkAllowanceStep(
      makeInput({})
    )) as CheckAllowanceResult;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Failed to check allowance");
      expect(result.error).toContain("RPC timeout");
    }
  });

  it("fails when RPC provider resolution fails", async () => {
    setupMocks();
    mockGetRpcProvider.mockRejectedValue(
      new Error("RPC config for chain 1 not found or not enabled")
    );

    const result = (await checkAllowanceStep(
      makeInput({})
    )) as CheckAllowanceResult;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not found or not enabled");
    }
  });
});
