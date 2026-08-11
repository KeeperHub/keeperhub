import { ethers } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

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
    query: {
      explorerConfigs: {
        findFirst: () => Promise.resolve(null),
      },
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id", userId: "userId" },
  explorerConfigs: { id: "id", chainId: "chainId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  // KEEP-966: lib/db/schema-extensions.ts's directExecutions.receipts column
  // default (sql`'[]'::jsonb`) is evaluated at module-import time, so this
  // transitively-loaded mock needs a stand-in tagged-template function.
  sql: () => ({}),
}));

vi.mock("@/lib/explorer", () => ({
  getAddressUrl: () => "https://etherscan.io/address/0x123",
}));

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

const mockContractFunction = vi.fn();
const mockStaticCall = vi.fn();

vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  function buildAbiFunction(): {
    (...args: unknown[]): unknown;
    staticCall: (...args: unknown[]) => unknown;
  } {
    const fn = (...args: unknown[]) => mockContractFunction(...args);
    fn.staticCall = (...args: unknown[]) => mockStaticCall(...args);
    return fn;
  }
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: class MockProvider {},
      Contract: class MockContract {
        constructor() {
          // biome-ignore lint/correctness/noConstructorReturn: test mock requires returning a Proxy to intercept dynamic property access
          return new Proxy(
            {},
            {
              get(_target: object, prop: string | symbol): unknown {
                // Production code now calls contract.getFunction(name) to avoid
                // BaseContract proxy collisions. Honour that surface.
                if (prop === "getFunction") {
                  return (_name: string) => buildAbiFunction();
                }
                return buildAbiFunction();
              },
            }
          );
        }
      },
    },
  };
});

import type { ReadContractCoreInput } from "@/plugins/web3/steps/read-contract-core";
import { readContractCore } from "@/plugins/web3/steps/read-contract-core";

const VALID_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

const VIEW_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
];

const PURE_ABI = [
  {
    name: "add",
    type: "function",
    stateMutability: "pure",
    inputs: [
      { name: "a", type: "uint256" },
      { name: "b", type: "uint256" },
    ],
    outputs: [{ name: "result", type: "uint256" }],
  },
];

const NONPAYABLE_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "amountIn", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
];

function makeInput(
  overrides: Partial<ReadContractCoreInput> = {}
): ReadContractCoreInput {
  return {
    contractAddress: VALID_ADDRESS,
    network: "ethereum",
    abi: JSON.stringify(VIEW_ABI),
    abiFunction: "balanceOf",
    functionArgs: JSON.stringify([VALID_ADDRESS]),
    ...overrides,
  };
}

function setupRpcMocks(): void {
  mockGetChainIdFromNetwork.mockReturnValue(1);
  mockGetRpcProvider.mockResolvedValue({
    executeWithFailover: (fn: (provider: unknown) => unknown) =>
      fn(new (class MockProvider {})()),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("read-contract-core - staticCall for non-view functions", () => {
  it("calls function directly for view stateMutability", async () => {
    setupRpcMocks();
    mockContractFunction.mockResolvedValueOnce(BigInt("1000"));

    const result = await readContractCore(makeInput());

    expect(result.success).toBe(true);
    expect(mockContractFunction).toHaveBeenCalledOnce();
    expect(mockStaticCall).not.toHaveBeenCalled();
  });

  it("calls function directly for pure stateMutability", async () => {
    setupRpcMocks();
    mockContractFunction.mockResolvedValueOnce(BigInt("42"));

    const result = await readContractCore(
      makeInput({
        abi: JSON.stringify(PURE_ABI),
        abiFunction: "add",
        functionArgs: JSON.stringify(["10", "32"]),
      })
    );

    expect(result.success).toBe(true);
    expect(mockContractFunction).toHaveBeenCalledOnce();
    expect(mockStaticCall).not.toHaveBeenCalled();
  });

  it("uses staticCall for nonpayable stateMutability", async () => {
    setupRpcMocks();
    mockStaticCall.mockResolvedValueOnce(BigInt("500000"));

    const result = await readContractCore(
      makeInput({
        abi: JSON.stringify(NONPAYABLE_ABI),
        abiFunction: "quoteExactInputSingle",
        functionArgs: JSON.stringify([
          VALID_ADDRESS,
          VALID_ADDRESS,
          "3000",
          "1000000",
          "0",
        ]),
      })
    );

    expect(result.success).toBe(true);
    expect(mockStaticCall).toHaveBeenCalledOnce();
    expect(mockContractFunction).not.toHaveBeenCalled();
  });

  it("uses staticCall for payable stateMutability", async () => {
    setupRpcMocks();

    const payableAbi = [
      {
        name: "deposit",
        type: "function",
        stateMutability: "payable",
        inputs: [],
        outputs: [{ name: "shares", type: "uint256" }],
      },
    ];

    mockStaticCall.mockResolvedValueOnce(BigInt("100"));

    const result = await readContractCore(
      makeInput({
        abi: JSON.stringify(payableAbi),
        abiFunction: "deposit",
        functionArgs: undefined,
      })
    );

    expect(result.success).toBe(true);
    expect(mockStaticCall).toHaveBeenCalledOnce();
    expect(mockContractFunction).not.toHaveBeenCalled();
  });

  it("returns structured output from staticCall result", async () => {
    setupRpcMocks();
    mockStaticCall.mockResolvedValueOnce(BigInt("999"));

    const result = await readContractCore(
      makeInput({
        abi: JSON.stringify(NONPAYABLE_ABI),
        abiFunction: "quoteExactInputSingle",
        functionArgs: JSON.stringify([
          VALID_ADDRESS,
          VALID_ADDRESS,
          "3000",
          "1000000",
          "0",
        ]),
      })
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({ amountOut: "999" });
    }
  });
});

describe("read-contract-core - tuple output decoding", () => {
  // Aave V3 Pool.getReserveData(address) returns a single ReserveData tuple.
  // The first sub-field is itself a nested tuple (ReserveConfigurationMap).
  // ethers v6 auto-unwraps the outer single-output Result, so we already
  // hold the 15 tuple components -- the post-processing must NOT unwrap
  // again or it discards 14 fields (KEEP-390).
  const AAVE_GET_RESERVE_DATA_ABI = [
    {
      name: "getReserveData",
      type: "function",
      stateMutability: "view",
      inputs: [{ name: "asset", type: "address" }],
      outputs: [
        {
          name: "",
          type: "tuple",
          components: [
            {
              name: "configuration",
              type: "tuple",
              components: [{ name: "data", type: "uint256" }],
            },
            { name: "liquidityIndex", type: "uint128" },
            { name: "currentLiquidityRate", type: "uint128" },
            { name: "variableBorrowIndex", type: "uint128" },
            { name: "currentVariableBorrowRate", type: "uint128" },
            { name: "currentStableBorrowRate", type: "uint128" },
            { name: "lastUpdateTimestamp", type: "uint40" },
            { name: "id", type: "uint16" },
            { name: "aTokenAddress", type: "address" },
            { name: "stableDebtTokenAddress", type: "address" },
            { name: "variableDebtTokenAddress", type: "address" },
            { name: "interestRateStrategyAddress", type: "address" },
            { name: "accruedToTreasury", type: "uint128" },
            { name: "unbacked", type: "uint128" },
            { name: "isolationModeTotalDebt", type: "uint128" },
          ],
        },
      ],
    },
  ];

  // Shape returned by ethers v6 Contract.getReserveData(...) -- the outer
  // single-output Result is auto-unwrapped, so we get the 15-element tuple
  // directly. The first element (configuration) is itself an inner tuple.
  const RESERVE_DATA_TUPLE = [
    [BigInt("12345")], // configuration: { data }
    BigInt("1000000000000000000000000000"), // liquidityIndex
    BigInt("10000000000000000000000000"), // currentLiquidityRate
    BigInt("1000000000000000000000000000"), // variableBorrowIndex
    BigInt("20000000000000000000000000"), // currentVariableBorrowRate
    BigInt("0"), // currentStableBorrowRate
    BigInt("1700000000"), // lastUpdateTimestamp
    BigInt("3"), // id
    "0x1111111111111111111111111111111111111111", // aTokenAddress
    "0x2222222222222222222222222222222222222222", // stableDebtTokenAddress
    "0x3333333333333333333333333333333333333333", // variableDebtTokenAddress
    "0x4444444444444444444444444444444444444444", // interestRateStrategyAddress
    BigInt("500"), // accruedToTreasury
    BigInt("0"), // unbacked
    BigInt("0"), // isolationModeTotalDebt
  ];

  it("names all 15 tuple components for Aave V3 getReserveData", async () => {
    setupRpcMocks();
    mockContractFunction.mockResolvedValueOnce(RESERVE_DATA_TUPLE);

    const result = await readContractCore({
      contractAddress: VALID_ADDRESS,
      network: "ethereum",
      abi: JSON.stringify(AAVE_GET_RESERVE_DATA_ABI),
      abiFunction: "getReserveData",
      functionArgs: JSON.stringify([VALID_ADDRESS]),
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    // The unnamed single tuple is structured into an object keyed by its ABI
    // component names; downstream steps read result.liquidityIndex instead of
    // reverse-engineering positional indices. No component is dropped.
    expect(result.result).toEqual({
      configuration: { data: "12345" },
      liquidityIndex: "1000000000000000000000000000",
      currentLiquidityRate: "10000000000000000000000000",
      variableBorrowIndex: "1000000000000000000000000000",
      currentVariableBorrowRate: "20000000000000000000000000",
      currentStableBorrowRate: "0",
      lastUpdateTimestamp: "1700000000",
      id: "3",
      aTokenAddress: "0x1111111111111111111111111111111111111111",
      stableDebtTokenAddress: "0x2222222222222222222222222222222222222222",
      variableDebtTokenAddress: "0x3333333333333333333333333333333333333333",
      interestRateStrategyAddress: "0x4444444444444444444444444444444444444444",
      accruedToTreasury: "500",
      unbacked: "0",
      isolationModeTotalDebt: "0",
    });
  });

  it("structures a genuine ethers v6 Result (encode -> decode -> serialize)", async () => {
    setupRpcMocks();

    // Build a real auto-unwrapped ethers Result the way the chain adapter
    // would, so the JSON.stringify round-trip in production is exercised
    // rather than a hand-built plain array.
    const iface = new ethers.Interface(AAVE_GET_RESERVE_DATA_ABI);
    const encoded = iface.encodeFunctionResult("getReserveData", [
      [
        [BigInt(12_345)],
        BigInt("1000000000000000000000000000"),
        BigInt(0),
        BigInt(0),
        BigInt(0),
        BigInt(0),
        BigInt(0),
        BigInt(3),
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333",
        "0x4444444444444444444444444444444444444444",
        BigInt(0),
        BigInt(0),
        BigInt(0),
      ],
    ]);
    const decoded = iface.decodeFunctionResult("getReserveData", encoded);
    // Contract methods auto-unwrap a single output to its Result.
    mockContractFunction.mockResolvedValueOnce(decoded[0]);

    const result = await readContractCore({
      contractAddress: VALID_ADDRESS,
      network: "ethereum",
      abi: JSON.stringify(AAVE_GET_RESERVE_DATA_ABI),
      abiFunction: "getReserveData",
      functionArgs: JSON.stringify([VALID_ADDRESS]),
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    const reserve = result.result as Record<string, unknown>;
    expect(reserve.configuration).toEqual({ data: "12345" });
    expect(reserve.liquidityIndex).toBe("1000000000000000000000000000");
    expect(reserve.id).toBe("3");
    expect(reserve.aTokenAddress).toBe(
      "0x1111111111111111111111111111111111111111"
    );
    expect(reserve.isolationModeTotalDebt).toBe("0");
  });
});

describe("read-contract-core - missing abiFunction (KEEP-371)", () => {
  it("returns a descriptive error when abiFunction is missing", async () => {
    const result = await readContractCore({
      contractAddress: VALID_ADDRESS,
      network: "ethereum",
      abi: JSON.stringify(VIEW_ABI),
      abiFunction: "",
      functionArgs: JSON.stringify([VALID_ADDRESS]),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("abiFunction");
    }
  });

  it("does not crash with TypeError when abiFunction is undefined", async () => {
    // Regression: before the fix, `findAbiFunction(parsedAbi, undefined)`
    // threw `Cannot read properties of undefined (reading 'indexOf')`.
    const result = await readContractCore({
      contractAddress: VALID_ADDRESS,
      network: "ethereum",
      abi: JSON.stringify(VIEW_ABI),
      abiFunction: undefined as unknown as string,
      functionArgs: JSON.stringify([VALID_ADDRESS]),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).not.toContain("indexOf");
    }
  });
});
