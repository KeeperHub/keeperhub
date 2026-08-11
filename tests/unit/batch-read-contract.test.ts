import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/metrics/instrumentation/plugin", () => ({
  withPluginMetrics: (_opts: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "validation", NETWORK_RPC: "network_rpc" },
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
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
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
}));

// Mock ethers with enough fidelity for encoding/decoding tests
const mockStaticCall = vi.fn();

vi.mock("@/lib/contracts/multicall3", () => ({
  MULTICALL3_ADDRESS: "0xcA11bde05977b3631167028862bE2a173976CA11",
  MULTICALL3_ABI: [
    {
      name: "aggregate3",
      type: "function",
      inputs: [],
      outputs: [],
    },
  ],
}));

import { ethers } from "ethers";

// Create real ethers Interface for encoding/decoding in tests
const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    name: "totalSupply",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
];

const MULTI_OUTPUT_ABI = [
  {
    name: "getReserves",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "blockTimestampLast", type: "uint32" },
    ],
  },
];

const erc20Iface = new ethers.Interface(ERC20_ABI);
const multiOutputIface = new ethers.Interface(MULTI_OUTPUT_ABI);

const VALID_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const VALID_ADDRESS_2 = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// Helper to encode a successful multicall result
function encodeSuccessResult(
  iface: ethers.Interface,
  fnName: string,
  values: unknown[]
): [boolean, string] {
  const encoded = iface.encodeFunctionResult(fnName, values);
  return [true, encoded];
}

function encodeRevertResult(): [boolean, string] {
  return [false, "0x"];
}

// Mock the Contract constructor to return our mock
vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: class MockProvider {},
      Contract: class MockContract {
        aggregate3 = { staticCall: mockStaticCall };
      },
    },
  };
});

import {
  type BatchReadContractCoreInput,
  type BatchReadContractInput,
  batchReadContractStep,
} from "@/plugins/web3/steps/batch-read-contract";

type SuccessResult = {
  success: true;
  results: { success: boolean; result: unknown; error?: string }[];
  totalCalls: number;
};

type FailureResult = {
  success: false;
  error: string;
};

type BatchResult = SuccessResult | FailureResult;

function makeInput(
  overrides: Partial<BatchReadContractCoreInput>
): BatchReadContractInput {
  return {
    inputMode: "uniform",
    ...overrides,
  } as BatchReadContractInput;
}

async function runBatch(
  overrides: Partial<BatchReadContractCoreInput>
): Promise<BatchResult> {
  return (await batchReadContractStep(makeInput(overrides))) as BatchResult;
}

async function expectSuccess(
  overrides: Partial<BatchReadContractCoreInput>
): Promise<SuccessResult> {
  const result = await runBatch(overrides);
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper called exclusively from inside test() blocks
  expect(result.success).toBe(true);
  return result as SuccessResult;
}

async function expectFailure(
  overrides: Partial<BatchReadContractCoreInput>
): Promise<FailureResult> {
  const result = await runBatch(overrides);
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper called exclusively from inside test() blocks
  expect(result.success).toBe(false);
  return result as FailureResult;
}

beforeEach(() => {
  vi.clearAllMocks();
});

function setupRpcMocks(chainId = 1): void {
  mockGetChainIdFromNetwork.mockReturnValue(chainId);
  mockGetRpcProvider.mockResolvedValue({
    executeWithFailover: (fn: (provider: unknown) => unknown) =>
      fn(new (class MockProvider {})()),
  });
}

// ─── Uniform Mode - Validation ──────────────────────────────────────────────

describe("batch-read-contract - uniform mode validation", () => {
  it("fails when network is missing", async () => {
    const result = await expectFailure({
      inputMode: "uniform",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
    });
    expect(result.error).toContain("Network is required");
  });

  it("fails when ABI is missing", async () => {
    const result = await expectFailure({
      inputMode: "uniform",
      network: "ethereum",
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
    });
    expect(result.error).toContain("ABI is required");
  });

  it("fails when contract address is missing", async () => {
    const result = await expectFailure({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      abiFunction: "balanceOf",
    });
    expect(result.error).toContain("Contract Address is required");
  });

  it("fails when contract address is invalid", async () => {
    const result = await expectFailure({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: "not-an-address",
      abiFunction: "balanceOf",
    });
    expect(result.error).toContain("Invalid contract address");
  });

  it("fails when function is missing", async () => {
    const result = await expectFailure({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
    });
    expect(result.error).toContain("Function is required");
  });

  it("fails when ABI is invalid JSON", async () => {
    const result = await expectFailure({
      inputMode: "uniform",
      network: "ethereum",
      abi: "not json",
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
    });
    expect(result.error).toContain("Invalid ABI JSON");
  });

  it("fails when ABI is not an array", async () => {
    const result = await expectFailure({
      inputMode: "uniform",
      network: "ethereum",
      abi: '{"not": "array"}',
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
    });
    expect(result.error).toContain("ABI must be a JSON array");
  });

  it("fails when function is not found in ABI", async () => {
    setupRpcMocks();
    const result = await expectFailure({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "nonExistentFunction",
    });
    expect(result.error).toContain("not found in ABI");
  });

  it("fails when argsList is invalid JSON", async () => {
    const result = await expectFailure({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
      argsList: "not json",
    });
    expect(result.error).toContain("Invalid Args List JSON");
  });

  it("fails when argsList is not an array", async () => {
    const result = await expectFailure({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
      argsList: '{"not": "array"}',
    });
    expect(result.error).toContain("Args List must be a JSON array");
  });

  it("fails when argsList entry is not an array", async () => {
    const result = await expectFailure({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
      argsList: '["not-an-array"]',
    });
    expect(result.error).toContain("must be an array");
  });
});

// ─── Uniform Mode - Execution ───────────────────────────────────────────────

describe("batch-read-contract - uniform mode execution", () => {
  it("executes single call with no args", async () => {
    setupRpcMocks();
    mockStaticCall.mockResolvedValueOnce([
      encodeSuccessResult(erc20Iface, "totalSupply", [
        BigInt("1000000000000000000"),
      ]),
    ]);

    const result = await expectSuccess({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "totalSupply",
    });

    expect(result.totalCalls).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(true);
  });

  it("executes multiple calls with argsList", async () => {
    setupRpcMocks();
    mockStaticCall.mockResolvedValueOnce([
      encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("100")]),
      encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("200")]),
      encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("300")]),
    ]);

    const result = await expectSuccess({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
      argsList: JSON.stringify([
        [VALID_ADDRESS],
        [VALID_ADDRESS_2],
        [VALID_ADDRESS],
      ]),
    });

    expect(result.totalCalls).toBe(3);
    expect(result.results).toHaveLength(3);
    for (const r of result.results) {
      expect(r.success).toBe(true);
    }
  });

  it("handles partial failure (one call reverts)", async () => {
    setupRpcMocks();
    mockStaticCall.mockResolvedValueOnce([
      encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("100")]),
      encodeRevertResult(),
      encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("300")]),
    ]);

    const result = await expectSuccess({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
      argsList: JSON.stringify([
        [VALID_ADDRESS],
        [VALID_ADDRESS_2],
        [VALID_ADDRESS],
      ]),
    });

    expect(result.totalCalls).toBe(3);
    expect(result.results[0].success).toBe(true);
    expect(result.results[1].success).toBe(false);
    expect(result.results[1].error).toContain("reverted");
    expect(result.results[2].success).toBe(true);
  });

  it("structures single named output", async () => {
    setupRpcMocks();
    mockStaticCall.mockResolvedValueOnce([
      encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("42")]),
    ]);

    const result = await expectSuccess({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
      argsList: JSON.stringify([[VALID_ADDRESS]]),
    });

    expect(result.results[0].result).toEqual({ balance: "42" });
  });

  it("structures multiple named outputs", async () => {
    setupRpcMocks();
    mockStaticCall.mockResolvedValueOnce([
      encodeSuccessResult(multiOutputIface, "getReserves", [
        BigInt("1000"),
        BigInt("2000"),
        1_700_000_000,
      ]),
    ]);

    const result = await expectSuccess({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(MULTI_OUTPUT_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "getReserves",
    });

    expect(result.results[0].result).toEqual({
      reserve0: "1000",
      reserve1: "2000",
      blockTimestampLast: "1700000000",
    });
  });

  it("returns single unnamed output as direct value", async () => {
    setupRpcMocks();
    mockStaticCall.mockResolvedValueOnce([
      encodeSuccessResult(erc20Iface, "totalSupply", [
        BigInt("1000000000000000000"),
      ]),
    ]);

    const result = await expectSuccess({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "totalSupply",
    });

    expect(result.results[0].result).toBe("1000000000000000000");
  });

  it("fails when RPC network resolution fails", async () => {
    mockGetChainIdFromNetwork.mockImplementation(() => {
      throw new Error("Unknown network: foochain");
    });

    const result = await expectFailure({
      inputMode: "uniform",
      network: "foochain",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
      argsList: JSON.stringify([[VALID_ADDRESS]]),
    });

    expect(result.error).toContain("Unknown network");
  });

  it("fails when RPC provider resolution fails", async () => {
    mockGetChainIdFromNetwork.mockReturnValue(99_999);
    mockGetRpcProvider.mockRejectedValue(
      new Error("RPC config for chain 99999 not found or not enabled")
    );

    const result = await expectFailure({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
      argsList: JSON.stringify([[VALID_ADDRESS]]),
    });

    expect(result.error).toContain("not found or not enabled");
  });

  it("fails when multicall RPC call throws", async () => {
    setupRpcMocks();
    mockStaticCall.mockRejectedValueOnce(new Error("RPC timeout"));

    const result = await expectFailure({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
      argsList: JSON.stringify([[VALID_ADDRESS]]),
    });

    expect(result.error).toContain("Multicall batch");
    expect(result.error).toContain("RPC timeout");
  });
});

// ─── Uniform Mode - Batch Size ──────────────────────────────────────────────

describe("batch-read-contract - batch size", () => {
  it("splits calls into multiple batches", async () => {
    setupRpcMocks();

    // 3 calls with batchSize=2 -> 2 batches (2 + 1)
    mockStaticCall
      .mockResolvedValueOnce([
        encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("100")]),
        encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("200")]),
      ])
      .mockResolvedValueOnce([
        encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("300")]),
      ]);

    const result = await expectSuccess({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
      argsList: JSON.stringify([
        [VALID_ADDRESS],
        [VALID_ADDRESS_2],
        [VALID_ADDRESS],
      ]),
      batchSize: "2",
    });

    expect(result.totalCalls).toBe(3);
    expect(mockStaticCall).toHaveBeenCalledTimes(2);
  });

  it("treats invalid batchSize as default", async () => {
    setupRpcMocks();
    mockStaticCall.mockResolvedValueOnce([
      encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("100")]),
    ]);

    const result = await expectSuccess({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
      argsList: JSON.stringify([[VALID_ADDRESS]]),
      batchSize: "not-a-number",
    });

    expect(result.totalCalls).toBe(1);
  });

  it("clamps batchSize to maximum 500", async () => {
    setupRpcMocks();
    mockStaticCall.mockResolvedValueOnce([
      encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("100")]),
    ]);

    const result = await expectSuccess({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
      argsList: JSON.stringify([[VALID_ADDRESS]]),
      batchSize: "99999",
    });

    // Should succeed (clamped to 500, single batch for 1 call)
    expect(result.totalCalls).toBe(1);
    expect(mockStaticCall).toHaveBeenCalledTimes(1);
  });

  it("clamps negative batchSize to 1", async () => {
    setupRpcMocks();
    // batchSize clamped to 1 means 2 calls = 2 batches
    mockStaticCall
      .mockResolvedValueOnce([
        encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("100")]),
      ])
      .mockResolvedValueOnce([
        encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("200")]),
      ]);

    const result = await expectSuccess({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
      argsList: JSON.stringify([[VALID_ADDRESS], [VALID_ADDRESS_2]]),
      batchSize: "-5",
    });

    expect(result.totalCalls).toBe(2);
    expect(mockStaticCall).toHaveBeenCalledTimes(2);
  });

  it("clamps batchSize to minimum 1", async () => {
    setupRpcMocks();
    mockStaticCall.mockResolvedValueOnce([
      encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("100")]),
    ]);

    const result = await expectSuccess({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
      argsList: JSON.stringify([[VALID_ADDRESS]]),
      batchSize: "0",
    });

    expect(result.totalCalls).toBe(1);
  });
});

// ─── Mixed Mode - Validation ────────────────────────────────────────────────

describe("batch-read-contract - mixed mode validation", () => {
  it("fails when calls JSON is missing", async () => {
    const result = await expectFailure({ inputMode: "mixed" });
    expect(result.error).toContain("Calls JSON is required");
  });

  it("fails when calls JSON is empty string", async () => {
    const result = await expectFailure({ inputMode: "mixed", calls: "" });
    expect(result.error).toContain("Calls JSON is required");
  });

  it("fails when calls JSON is invalid", async () => {
    const result = await expectFailure({
      inputMode: "mixed",
      calls: "not json",
    });
    expect(result.error).toContain("Invalid Calls JSON");
  });

  it("fails when calls JSON is not an array", async () => {
    const result = await expectFailure({
      inputMode: "mixed",
      calls: '{"not": "array"}',
    });
    expect(result.error).toContain("Calls must be a JSON array");
  });

  it("fails when call object is not an object", async () => {
    const result = await expectFailure({
      inputMode: "mixed",
      calls: '["string-not-object"]',
    });
    expect(result.error).toContain("must be an object");
  });

  it("fails when call is missing network", async () => {
    const result = await expectFailure({
      inputMode: "mixed",
      calls: JSON.stringify([
        {
          contractAddress: VALID_ADDRESS,
          abiFunction: "balanceOf",
          abi: JSON.stringify(ERC20_ABI),
          args: [],
        },
      ]),
    });
    expect(result.error).toContain("missing network");
  });

  it("fails when call is missing contractAddress", async () => {
    const result = await expectFailure({
      inputMode: "mixed",
      calls: JSON.stringify([
        {
          network: "ethereum",
          abiFunction: "balanceOf",
          abi: JSON.stringify(ERC20_ABI),
          args: [],
        },
      ]),
    });
    expect(result.error).toContain("missing contractAddress");
  });

  it("fails when call has invalid address", async () => {
    const result = await expectFailure({
      inputMode: "mixed",
      calls: JSON.stringify([
        {
          network: "ethereum",
          contractAddress: "0xinvalid",
          abiFunction: "balanceOf",
          abi: JSON.stringify(ERC20_ABI),
          args: [],
        },
      ]),
    });
    expect(result.error).toContain("invalid address");
  });

  it("fails when call is missing abiFunction", async () => {
    const result = await expectFailure({
      inputMode: "mixed",
      calls: JSON.stringify([
        {
          network: "ethereum",
          contractAddress: VALID_ADDRESS,
          abi: JSON.stringify(ERC20_ABI),
          args: [],
        },
      ]),
    });
    expect(result.error).toContain("missing abiFunction");
  });

  it("fails when call is missing abi", async () => {
    const result = await expectFailure({
      inputMode: "mixed",
      calls: JSON.stringify([
        {
          network: "ethereum",
          contractAddress: VALID_ADDRESS,
          abiFunction: "balanceOf",
          args: [],
        },
      ]),
    });
    expect(result.error).toContain("missing abi");
  });

  it("fails when call ABI has function not found", async () => {
    setupRpcMocks();
    const result = await expectFailure({
      inputMode: "mixed",
      calls: JSON.stringify([
        {
          network: "ethereum",
          contractAddress: VALID_ADDRESS,
          abiFunction: "nonExistent",
          abi: JSON.stringify(ERC20_ABI),
          args: [],
        },
      ]),
    });
    expect(result.error).toContain("not found in ABI");
  });

  it("reports correct index for validation errors", async () => {
    const result = await expectFailure({
      inputMode: "mixed",
      calls: JSON.stringify([
        {
          network: "ethereum",
          contractAddress: VALID_ADDRESS,
          abiFunction: "balanceOf",
          abi: JSON.stringify(ERC20_ABI),
          args: [VALID_ADDRESS],
        },
        {
          network: "ethereum",
          contractAddress: "0xinvalid",
          abiFunction: "balanceOf",
          abi: JSON.stringify(ERC20_ABI),
          args: [],
        },
      ]),
    });
    expect(result.error).toContain("index 1");
    expect(result.error).toContain("invalid address");
  });
});

// ─── Mixed Mode - Execution ────────────────────────────────────────────────

describe("batch-read-contract - mixed mode execution", () => {
  it("executes single mixed call", async () => {
    setupRpcMocks();
    mockStaticCall.mockResolvedValueOnce([
      encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("42")]),
    ]);

    const result = await expectSuccess({
      inputMode: "mixed",
      calls: JSON.stringify([
        {
          network: "ethereum",
          contractAddress: VALID_ADDRESS,
          abiFunction: "balanceOf",
          abi: JSON.stringify(ERC20_ABI),
          args: [VALID_ADDRESS],
        },
      ]),
    });

    expect(result.totalCalls).toBe(1);
    expect(result.results[0].success).toBe(true);
    expect(result.results[0].result).toEqual({ balance: "42" });
  });

  it("executes multiple mixed calls on same network", async () => {
    setupRpcMocks();
    mockStaticCall.mockResolvedValueOnce([
      encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("100")]),
      encodeSuccessResult(erc20Iface, "totalSupply", [BigInt("1000000")]),
    ]);

    const result = await expectSuccess({
      inputMode: "mixed",
      calls: JSON.stringify([
        {
          network: "ethereum",
          contractAddress: VALID_ADDRESS,
          abiFunction: "balanceOf",
          abi: JSON.stringify(ERC20_ABI),
          args: [VALID_ADDRESS],
        },
        {
          network: "ethereum",
          contractAddress: VALID_ADDRESS_2,
          abiFunction: "totalSupply",
          abi: JSON.stringify(ERC20_ABI),
          args: [],
        },
      ]),
    });

    expect(result.totalCalls).toBe(2);
    expect(result.results[0].result).toEqual({ balance: "100" });
    expect(result.results[1].result).toBe("1000000");
  });

  it("groups calls by network and merges results in original order", async () => {
    // Call 0: ethereum, Call 1: polygon, Call 2: ethereum
    // Should group: ethereum=[0,2], polygon=[1]
    // Results should come back in original order [0,1,2]

    mockGetChainIdFromNetwork.mockImplementation((network: string) => {
      if (network === "ethereum") {
        return 1;
      }
      if (network === "polygon") {
        return 137;
      }
      throw new Error(`Unknown network: ${network}`);
    });
    mockGetRpcProvider.mockResolvedValue({
      executeWithFailover: (fn: (provider: unknown) => unknown) =>
        fn(new (class MockProvider {})()),
    });

    // Ethereum batch (calls 0 and 2)
    mockStaticCall.mockResolvedValueOnce([
      encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("100")]),
      encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("300")]),
    ]);
    // Polygon batch (call 1)
    mockStaticCall.mockResolvedValueOnce([
      encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("200")]),
    ]);

    const result = await expectSuccess({
      inputMode: "mixed",
      calls: JSON.stringify([
        {
          network: "ethereum",
          contractAddress: VALID_ADDRESS,
          abiFunction: "balanceOf",
          abi: JSON.stringify(ERC20_ABI),
          args: [VALID_ADDRESS],
        },
        {
          network: "polygon",
          contractAddress: VALID_ADDRESS,
          abiFunction: "balanceOf",
          abi: JSON.stringify(ERC20_ABI),
          args: [VALID_ADDRESS_2],
        },
        {
          network: "ethereum",
          contractAddress: VALID_ADDRESS_2,
          abiFunction: "balanceOf",
          abi: JSON.stringify(ERC20_ABI),
          args: [VALID_ADDRESS],
        },
      ]),
    });

    expect(result.totalCalls).toBe(3);
    // Verify results are in original call order, not grouped order
    expect(result.results[0].result).toEqual({ balance: "100" });
    expect(result.results[1].result).toEqual({ balance: "200" });
    expect(result.results[2].result).toEqual({ balance: "300" });
  });

  it("handles partial failure in mixed mode", async () => {
    setupRpcMocks();
    mockStaticCall.mockResolvedValueOnce([
      encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("100")]),
      encodeRevertResult(),
    ]);

    const result = await expectSuccess({
      inputMode: "mixed",
      calls: JSON.stringify([
        {
          network: "ethereum",
          contractAddress: VALID_ADDRESS,
          abiFunction: "balanceOf",
          abi: JSON.stringify(ERC20_ABI),
          args: [VALID_ADDRESS],
        },
        {
          network: "ethereum",
          contractAddress: VALID_ADDRESS_2,
          abiFunction: "balanceOf",
          abi: JSON.stringify(ERC20_ABI),
          args: [VALID_ADDRESS],
        },
      ]),
    });

    expect(result.results[0].success).toBe(true);
    expect(result.results[1].success).toBe(false);
    expect(result.results[1].error).toContain("reverted");
  });

  it("treats missing args as empty array", async () => {
    setupRpcMocks();
    mockStaticCall.mockResolvedValueOnce([
      encodeSuccessResult(erc20Iface, "totalSupply", [BigInt("999")]),
    ]);

    const result = await expectSuccess({
      inputMode: "mixed",
      calls: JSON.stringify([
        {
          network: "ethereum",
          contractAddress: VALID_ADDRESS,
          abiFunction: "totalSupply",
          abi: JSON.stringify(ERC20_ABI),
          // args intentionally omitted
        },
      ]),
    });

    expect(result.results[0].success).toBe(true);
  });
});

// ─── Input Mode Routing ─────────────────────────────────────────────────────

describe("batch-read-contract - input mode routing", () => {
  it("defaults to uniform mode when inputMode is not set", async () => {
    // Should require network (uniform mode validation)
    const result = await expectFailure({
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
    });
    expect(result.error).toContain("Network is required");
  });

  it("defaults to uniform mode when inputMode is empty string", async () => {
    const result = await expectFailure({
      inputMode: "",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
    });
    expect(result.error).toContain("Network is required");
  });

  it("uses mixed mode when inputMode is 'mixed'", async () => {
    const result = await expectFailure({ inputMode: "mixed" });
    expect(result.error).toContain("Calls JSON is required");
  });
});

// ─── Mixed Mode - Batch Splitting ────────────────────────────────────────────

describe("batch-read-contract - mixed mode batch splitting", () => {
  it("splits same-network calls into batches in mixed mode", async () => {
    setupRpcMocks();

    // 3 calls on same network, batchSize=1 -> 3 batches
    mockStaticCall
      .mockResolvedValueOnce([
        encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("100")]),
      ])
      .mockResolvedValueOnce([
        encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("200")]),
      ])
      .mockResolvedValueOnce([
        encodeSuccessResult(erc20Iface, "balanceOf", [BigInt("300")]),
      ]);

    const result = await expectSuccess({
      inputMode: "mixed",
      batchSize: "1",
      calls: JSON.stringify([
        {
          network: "ethereum",
          contractAddress: VALID_ADDRESS,
          abiFunction: "balanceOf",
          abi: JSON.stringify(ERC20_ABI),
          args: [VALID_ADDRESS],
        },
        {
          network: "ethereum",
          contractAddress: VALID_ADDRESS,
          abiFunction: "balanceOf",
          abi: JSON.stringify(ERC20_ABI),
          args: [VALID_ADDRESS_2],
        },
        {
          network: "ethereum",
          contractAddress: VALID_ADDRESS_2,
          abiFunction: "balanceOf",
          abi: JSON.stringify(ERC20_ABI),
          args: [VALID_ADDRESS],
        },
      ]),
    });

    expect(result.totalCalls).toBe(3);
    expect(mockStaticCall).toHaveBeenCalledTimes(3);
    expect(result.results[0].result).toEqual({ balance: "100" });
    expect(result.results[1].result).toEqual({ balance: "200" });
    expect(result.results[2].result).toEqual({ balance: "300" });
  });
});

// ─── Array-Type Outputs ─────────────────────────────────────────────────────

describe("batch-read-contract - array-type outputs", () => {
  const ARRAY_OUTPUT_ABI = [
    {
      name: "getHolders",
      type: "function",
      stateMutability: "view",
      inputs: [],
      outputs: [{ name: "holders", type: "address[]" }],
    },
  ];

  it("preserves array output without unwrapping single-output arrays", async () => {
    setupRpcMocks();

    const arrayIface = new ethers.Interface(ARRAY_OUTPUT_ABI);
    mockStaticCall.mockResolvedValueOnce([
      encodeSuccessResult(arrayIface, "getHolders", [
        [VALID_ADDRESS, VALID_ADDRESS_2],
      ]),
    ]);

    const result = await expectSuccess({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ARRAY_OUTPUT_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "getHolders",
    });

    // Single array-type output is named under its ABI name and exposed as the
    // flat address list (no spurious extra wrapping).
    const resultValue = result.results[0].result as { holders: string[] };
    expect(resultValue).toHaveProperty("holders");
    expect(Array.isArray(resultValue.holders)).toBe(true);
    expect(resultValue.holders).toHaveLength(2);
    expect(resultValue.holders[0]).toBe(VALID_ADDRESS);
  });
});

// ─── Revert Reason Decoding ──────────────────────────────────────────────────

describe("batch-read-contract - revert reason decoding", () => {
  it("decodes Error(string) revert reason", async () => {
    setupRpcMocks();

    // Encode Error(string) revert data: selector 0x08c379a0 + abi-encoded string
    const errorData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["string"],
      ["Insufficient balance"]
    );
    const revertData = `0x08c379a0${errorData.slice(2)}`;

    mockStaticCall.mockResolvedValueOnce([[false, revertData]]);

    const result = await expectSuccess({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
      argsList: JSON.stringify([[VALID_ADDRESS]]),
    });

    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain("Insufficient balance");
  });

  it("falls back to generic message for undecodable revert data", async () => {
    setupRpcMocks();

    mockStaticCall.mockResolvedValueOnce([[false, "0xdeadbeef"]]);

    const result = await expectSuccess({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
      argsList: JSON.stringify([[VALID_ADDRESS]]),
    });

    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain("reverted");
  });
});

// ─── Total Call Limit ────────────────────────────────────────────────────────

describe("batch-read-contract - total call limit", () => {
  it("rejects when uniform mode exceeds max total calls", async () => {
    // Build argsList with 5001 entries
    const argsList = Array.from({ length: 5001 }, () => [VALID_ADDRESS]);

    const result = await expectFailure({
      inputMode: "uniform",
      network: "ethereum",
      abi: JSON.stringify(ERC20_ABI),
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
      argsList: JSON.stringify(argsList),
    });

    expect(result.error).toContain("Too many calls");
    expect(result.error).toContain("5001");
  });

  it("rejects when mixed mode exceeds max total calls", async () => {
    const calls = Array.from({ length: 5001 }, () => ({
      network: "ethereum",
      contractAddress: VALID_ADDRESS,
      abiFunction: "balanceOf",
      abi: JSON.stringify(ERC20_ABI),
      args: [VALID_ADDRESS],
    }));

    const result = await expectFailure({
      inputMode: "mixed",
      calls: JSON.stringify(calls),
    });

    expect(result.error).toContain("Too many calls");
    expect(result.error).toContain("5001");
  });
});
