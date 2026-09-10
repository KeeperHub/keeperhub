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

describe("read-contract-core - failOnError", () => {
  const RPC_FAILURE = new Error(
    "could not detect network (https://eth-mainnet.g.alchemy.com/v2/secret-key)"
  );

  it("hard-fails a read failure by default", async () => {
    setupRpcMocks();
    mockContractFunction.mockRejectedValueOnce(RPC_FAILURE);

    const result = await readContractCore(makeInput());

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.errorClass).toBe("user");
  });

  it("softens a read failure into a success when failOnError is false", async () => {
    setupRpcMocks();
    mockContractFunction.mockRejectedValueOnce(RPC_FAILURE);

    const result = await readContractCore(makeInput({ failOnError: false }));

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.result).toBeNull();
    expect(result.error).toContain("Contract call failed");
  });

  it("accepts the string 'false' the visual editor persists", async () => {
    setupRpcMocks();
    mockContractFunction.mockRejectedValueOnce(RPC_FAILURE);

    const result = await readContractCore(
      makeInput({ failOnError: "false" as unknown as boolean })
    );

    expect(result.success).toBe(true);
  });

  it("redacts provider URLs in the softened error", async () => {
    setupRpcMocks();
    mockContractFunction.mockRejectedValueOnce(RPC_FAILURE);

    const result = await readContractCore(makeInput({ failOnError: false }));

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.error).not.toContain("alchemy.com");
    expect(result.error).not.toContain("secret-key");
  });

  it("softens a revert the same way", async () => {
    setupRpcMocks();
    mockContractFunction.mockRejectedValueOnce(
      new Error("execution reverted: Vat/not-authorized")
    );

    const result = await readContractCore(makeInput({ failOnError: false }));

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.error).toContain("Vat/not-authorized");
  });

  it("softens a function missing from the ABI, like HTTP Request softens a 400", async () => {
    setupRpcMocks();

    const result = await readContractCore(
      makeInput({ abiFunction: "notInAbi", failOnError: false })
    );

    // The ABI, the function name and the args are the payload, not the
    // destination. HTTP Request hard-fails only an unusable URL; a request the
    // far side rejects softens. This is the read-side equivalent, and it is
    // what makes a For Each survive one item the contract will not accept.
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.result).toBeNull();
    expect(result.error).toContain("not found in ABI");
  });

  it("still hard-fails an invalid contract address when failOnError is false", async () => {
    setupRpcMocks();

    const result = await readContractCore(
      makeInput({ contractAddress: "not-an-address", failOnError: false })
    );

    // The address is the destination: with nowhere to call, a null-data
    // success would let a permanently broken node run unnoticed.
    expect(result.success).toBe(false);
  });

  it("still hard-fails an unresolvable network when failOnError is false", async () => {
    mockGetChainIdFromNetwork.mockImplementation(() => {
      throw new Error("Unsupported network");
    });

    const result = await readContractCore(
      makeInput({ network: "not-a-chain", failOnError: false })
    );

    expect(result.success).toBe(false);
  });

  it("still hard-fails an unresolved RPC config when failOnError is false", async () => {
    mockGetChainIdFromNetwork.mockReturnValue(1);
    mockGetRpcProvider.mockRejectedValueOnce(new Error("No RPC configured"));

    const result = await readContractCore(makeInput({ failOnError: false }));

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.errorClass).toBe("system");
  });
});

describe("ABI fragment validation before RPC failover", () => {
  it("N3 classifies a components-less legacy tuple as USER before provider creation", async () => {
    vi.clearAllMocks();
    const result = await readContractCore({
      contractAddress: VALID_ADDRESS,
      network: "ethereum",
      abi: JSON.stringify([
        {
          type: "function",
          name: "broken",
          inputs: [{ name: "p", type: "tuple" }],
        },
        { type: "function", name: "broken", inputs: [] },
      ]),
      abiFunction: "broken(tuple)",
      _context: { organizationId: "org-test" },
    });
    expect(result).toMatchObject({ success: false, errorClass: "user" });
    if (!result.success) {
      expect(result.error).toContain("Invalid ABI function");
    }
    expect(mockGetRpcProvider).not.toHaveBeenCalled();
    expect(mockContractFunction).not.toHaveBeenCalled();
  });
});

// A read with no caller is a read as address(0), which is itself a specific
// address: OptimismPortal2 reveals a failing withdrawal target only to
// address(1), and a toll-gated Chronicle feed reads only for an authed caller.
// These cover the value reaching the chain on both branches of the isView
// ternary, and every blank shape leaving the call exactly as it was (#2399).
describe("read-contract-core - caller address (#2399)", () => {
  const CALLER = "0x2c9F694183A4240B6431771F6c714a8106179dF5";
  const NO_ARG_ABI = [
    {
      name: "totalSupply",
      type: "function",
      stateMutability: "view",
      inputs: [],
      outputs: [{ name: "supply", type: "uint256" }],
    },
  ];

  it("passes the caller to a view call as trailing overrides", async () => {
    setupRpcMocks();
    mockContractFunction.mockResolvedValueOnce(BigInt("1000"));

    const result = await readContractCore(makeInput({ callerAddress: CALLER }));

    expect(result.success).toBe(true);
    const call = mockContractFunction.mock.calls[0];
    expect(call).toHaveLength(2);
    expect(call[1]).toEqual({ from: CALLER });
  });

  it("passes the caller on the staticCall branch too", async () => {
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
        callerAddress: CALLER,
      })
    );

    expect(result.success).toBe(true);
    const call = mockStaticCall.mock.calls[0];
    expect(call).toHaveLength(6);
    expect(call[5]).toEqual({ from: CALLER });
  });

  it("passes the caller as the only argument to a no-argument function", async () => {
    setupRpcMocks();
    mockContractFunction.mockResolvedValueOnce(BigInt(7));

    const result = await readContractCore(
      makeInput({
        abi: JSON.stringify(NO_ARG_ABI),
        abiFunction: "totalSupply",
        functionArgs: "",
        callerAddress: CALLER,
      })
    );

    expect(result.success).toBe(true);
    expect(mockContractFunction).toHaveBeenCalledWith({ from: CALLER });
  });

  it("does not fold the caller into the decoded ABI arguments", async () => {
    setupRpcMocks();
    mockContractFunction.mockResolvedValueOnce(BigInt("1000"));

    await readContractCore(makeInput({ callerAddress: CALLER }));

    expect(mockContractFunction.mock.calls[0][0]).toBe(VALID_ADDRESS);
  });

  it("accepts an all-lowercase caller and forwards it unchanged", async () => {
    setupRpcMocks();
    mockContractFunction.mockResolvedValueOnce(BigInt("1000"));

    const result = await readContractCore(
      makeInput({ callerAddress: CALLER.toLowerCase() })
    );

    expect(result.success).toBe(true);
    expect(mockContractFunction.mock.calls[0][1]).toEqual({
      from: CALLER.toLowerCase(),
    });
  });

  it("calls the contract exactly as before when no caller is given", async () => {
    setupRpcMocks();
    mockContractFunction.mockResolvedValueOnce(BigInt("1000"));

    const result = await readContractCore(makeInput());

    expect(result.success).toBe(true);
    expect(mockContractFunction.mock.calls[0]).toEqual([VALID_ADDRESS]);
  });

  it("treats an empty string caller as no caller, as before", async () => {
    setupRpcMocks();
    mockContractFunction.mockResolvedValueOnce(BigInt("1000"));

    const result = await readContractCore(makeInput({ callerAddress: "" }));

    expect(result.success).toBe(true);
    expect(mockContractFunction.mock.calls[0]).toEqual([VALID_ADDRESS]);
  });

  // A caller fed by {{PreviousNode.address}} that renders to blank must be a
  // field left empty, not a hard error.
  it("treats a whitespace-only caller as no caller", async () => {
    setupRpcMocks();
    mockContractFunction.mockResolvedValueOnce(BigInt("1000"));

    const result = await readContractCore(makeInput({ callerAddress: "   " }));

    expect(result.success).toBe(true);
    expect(mockContractFunction.mock.calls[0]).toEqual([VALID_ADDRESS]);
  });

  it("refuses a malformed caller without calling the chain", async () => {
    setupRpcMocks();

    const result = await readContractCore(
      makeInput({ callerAddress: "not-an-address" })
    );

    expect(result).toMatchObject({ success: false, errorClass: "user" });
    if (!result.success) {
      expect(result.error).toContain("Invalid caller address");
    }
    expect(mockContractFunction).not.toHaveBeenCalled();
    expect(mockStaticCall).not.toHaveBeenCalled();
  });

  it("refuses a mixed-case caller whose checksum does not hold", async () => {
    setupRpcMocks();

    const result = await readContractCore(
      makeInput({ callerAddress: "0x2C9f694183A4240B6431771F6c714a8106179dF5" })
    );

    expect(result).toMatchObject({ success: false, errorClass: "user" });
    expect(mockContractFunction).not.toHaveBeenCalled();
  });

  // The caller is payload, like the arguments, not a destination: failOnError
  // softens it the way it softens an unparseable argument list rather than
  // hard-failing it the way it hard-fails an invalid contract address.
  it("softens a malformed caller when failOnError is false", async () => {
    setupRpcMocks();

    const result = await readContractCore(
      makeInput({ callerAddress: "not-an-address", failOnError: false })
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toBeNull();
      expect(result.error).toContain("Invalid caller address");
    }
    expect(mockContractFunction).not.toHaveBeenCalled();
  });
});
