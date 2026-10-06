import {
  type Abi,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  type Hex,
  parseAbiItem,
} from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import erc20AbiJson from "@/lib/contracts/abis/erc20.json";
import { getChainTokens } from "@/lib/contracts/tokens";
import { applySlippageFloor } from "@/lib/web3/slippage";
import quoterAbiJson from "@/protocols/abis/uniswap-quoter.json";
import swapRouterAbiJson from "@/protocols/abis/uniswap-swap-router.json";

vi.mock("server-only", () => ({}));

const BASE = 8453;
const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const USDC = getAddress("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
const WETH = getAddress("0x4200000000000000000000000000000000000006");
const ROUTER = getAddress("0x2626664c2603336E57B271c5C0b26F421741e481");
const QUOTER = getAddress("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a");
const POOL = getAddress("0x00000000000000000000000000000000000000a1");

const erc20Abi = erc20AbiJson as Abi;
const quoterAbi = quoterAbiJson as Abi;
const swapRouterAbi = swapRouterAbiJson as Abi;

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

type FakeLog = { address: string; topics: Hex[]; data: Hex };

function transferLog(
  token: string,
  from: string,
  to: string,
  value: bigint
): FakeLog {
  return {
    address: token,
    topics: encodeEventTopics({
      abi: [TRANSFER_EVENT],
      eventName: "Transfer",
      args: { from: getAddress(from), to: getAddress(to) },
    }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

const chain = vi.hoisted(() => ({
  balances: new Map<string, bigint>(),
  quote: BigInt(0) as bigint,
  quoteThrows: false,
  // Answers for successive quotes, taken first; `quote`/`quoteThrows` after.
  quotes: [] as Array<bigint | Error>,
  receipts: new Map<
    string,
    { logs: Array<{ address: string; topics: string[]; data: string }> }
  >(),
  receiptThrows: false,
  receiptReads: 0,
  receiptLagReads: 0,
  tokenRows: [] as Array<{
    tokenAddress: string;
    decimals: number;
    symbol: string;
    isStablecoin: boolean;
  }>,
}));

const { mockLogSystemWarn, mockExplorerFindFirst } = vi.hoisted(() => ({
  mockLogSystemWarn: vi.fn(),
  mockExplorerFindFirst: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    DATABASE: "database",
    TRANSACTION: "transaction",
    VALIDATION: "validation",
    NETWORK_RPC: "network_rpc",
  },
  logUserError: vi.fn(),
  logSystemWarn: mockLogSystemWarn,
  logSecurityEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => Promise.resolve(chain.tokenRows) }),
    }),
    query: {
      explorerConfigs: {
        findFirst: (...args: unknown[]) => mockExplorerFindFirst(...args),
      },
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  explorerConfigs: { chainId: "chainId" },
  supportedTokens: {
    chainId: "chainId",
    isStablecoin: "isStablecoin",
    tokenAddress: "tokenAddress",
    decimals: "decimals",
    symbol: "symbol",
  },
}));

vi.mock("drizzle-orm", () => ({ eq: () => ({}), and: () => ({}) }));

vi.mock("@/lib/explorer", () => ({
  getTransactionUrl: (_config: unknown, hash: string) =>
    `https://basescan.org/tx/${hash}`,
}));

vi.mock("@/lib/utils", async () =>
  (await import("../mocks/step-mocks")).utilsGetErrorMessage()
);

// loadStablecoin stays real so resolveUsdc goes through the cap's own lookup
// (over the mocked `db.select` rows above); only the cap decision is stubbed.
const mockCheckCap = vi.fn();
vi.mock("@/lib/execute/stablecoin-cap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/execute/stablecoin-cap")>()),
  checkStablecoinTransferAmount: (...args: unknown[]) => mockCheckCap(...args),
}));

// The real limit's wiring is covered in gas-top-up-daily-sum.test.ts; here it
// is a marker, so the test can see it reach the denial unchanged.
const mockDailyLimit = vi.fn((amountMicroUsd: bigint) => ({
  amountMicroUsd,
  label: "gas top-up",
}));
const mockDailyDenial = vi.fn();
vi.mock("@/lib/execute/value-ledger", () => ({
  gasTopUpDailyLimit: (amountMicroUsd: bigint) =>
    mockDailyLimit(amountMicroUsd),
  stablecoinDailyLimitDenial: (...args: unknown[]) => mockDailyDenial(...args),
}));

const mockResolveSigner = vi.fn();
vi.mock("@/lib/safe/signer-resolver", () => ({
  resolveSignerForNode: (...args: unknown[]) => mockResolveSigner(...args),
}));

const mockShouldTrySponsorship = vi.fn();
vi.mock("@/lib/web3/sponsorship-eligibility", () => ({
  shouldTrySponsorship: (...args: unknown[]) =>
    mockShouldTrySponsorship(...args),
}));

const mockCheckGasCredits = vi.fn();
const mockOraclePrice = vi.fn();
vi.mock("@/lib/billing/gas-credits", () => ({
  checkGasCredits: (...args: unknown[]) => mockCheckGasCredits(...args),
  getFreshGasTokenPriceUsd: (...args: unknown[]) => mockOraclePrice(...args),
}));

const mockCreateSponsoredClient = vi.fn();
vi.mock("@/lib/web3/sponsored-client", () => ({
  createSponsoredClient: (...args: unknown[]) =>
    mockCreateSponsoredClient(...args),
}));

const mockSponsoredSend = vi.fn();
vi.mock("@/lib/web3/sponsored-transaction-manager", () => ({
  executeSponsoredContractTransaction: (...args: unknown[]) =>
    mockSponsoredSend(...args),
}));

vi.mock("@/lib/web3/sponsored-send-error", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/web3/sponsored-send-error")>();
  return {
    ...actual,
    resolveSponsoredSendError: vi.fn(actual.resolveSponsoredSendError),
  };
});

function balanceKey(token: string, owner: string): string {
  return `${token.toLowerCase()}:${owner.toLowerCase()}`;
}

const fakeProvider = {
  getTransactionReceipt: (hash: string) => {
    chain.receiptReads += 1;
    if (chain.receiptThrows) {
      return Promise.reject(new Error("receipt endpoint timed out"));
    }
    // A node a block behind answers null for a receipt that exists.
    if (chain.receiptReads <= chain.receiptLagReads) {
      return Promise.resolve(null);
    }
    return Promise.resolve(chain.receipts.get(hash) ?? null);
  },
  call: ({ to, data }: { to: string; data: Hex }): Promise<Hex> => {
    if (to.toLowerCase() === QUOTER.toLowerCase()) {
      const next = chain.quotes.shift();
      if (next instanceof Error) {
        return Promise.reject(next);
      }
      if (next === undefined && chain.quoteThrows) {
        return Promise.reject(new Error("execution reverted"));
      }
      return Promise.resolve(
        encodeFunctionResult({
          abi: quoterAbi,
          functionName: "quoteExactInputSingle",
          result: [next ?? chain.quote, BigInt(0), 0, BigInt(0)],
        })
      );
    }
    const { args } = decodeFunctionData({ abi: erc20Abi, data });
    const owner = String(args?.[0]);
    return Promise.resolve(
      encodeFunctionResult({
        abi: erc20Abi,
        functionName: "balanceOf",
        result: chain.balances.get(balanceKey(to, owner)) ?? BigInt(0),
      })
    );
  },
};

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: () =>
    Promise.resolve({
      resolveActiveRpcUrl: () => Promise.resolve("https://rpc.example.com"),
      executeWithFailover: <T>(op: (p: typeof fakeProvider) => Promise<T>) =>
        op(fakeProvider),
    }),
}));

const {
  executeGasTopUp,
  minimumOracleWethOut,
  prepareGasTopUp,
  resolveGasTopUpContracts,
  wethReceivedFromLogs,
} = await import("@/lib/execute/gas-top-up");
const { SponsoredTxPendingError, SponsoredTxRevertError } = await import(
  "@/lib/web3/turnkey-revert"
);
const { resolveSponsoredSendError } = await import(
  "@/lib/web3/sponsored-send-error"
);
const { clearExplorerConfigCache } = await import(
  "@/lib/web3/chain-adapter/explorer"
);
const { db } = await import("@/lib/db");

const ONE_WETH = BigInt("1000000000000000000");
const QUOTE = ONE_WETH / BigInt(1000);

function confirmed(hash: string) {
  return {
    success: true,
    transactionHash: hash,
    gasUsed: "100",
    gasUsedUnits: "50000",
    effectiveGasPrice: "2",
    sponsored: true,
  };
}

const SWAP_HASH = "0xswap";

/** The swap's receipt: the pool pays `received` WETH to the wallet. */
function swapPays(received: bigint, extra: FakeLog[] = []): void {
  chain.receipts.set(SWAP_HASH, {
    logs: [...extra, transferLog(WETH, POOL, WALLET, received)],
  });
}

type SendParams = { to: string; functionName: string; args: unknown[] };

const REVOKE_HASH = "0xrevoke";

function isRevoke(params: SendParams): boolean {
  return params.functionName === "approve" && params.args[1] === BigInt(0);
}

/** Confirm a non-swap send under a hash named after it. */
function confirmedSend(params: SendParams) {
  return Promise.resolve(
    confirmed(isRevoke(params) ? REVOKE_HASH : `0x${params.functionName}`)
  );
}

/** The amounts approved for the router, in send order. */
function approvedAmounts(): unknown[] {
  return mockSponsoredSend.mock.calls
    .map(([params]) => params as SendParams)
    .filter((params) => params.functionName === "approve")
    .map((params) => params.args[1]);
}

/** Confirm every send; the swap (the call to the router) pays `received`. */
function sendsSucceed(received: bigint = QUOTE): void {
  mockSponsoredSend.mockImplementation((params: SendParams) => {
    if (params.to === ROUTER) {
      swapPays(received);
      return Promise.resolve(confirmed(SWAP_HASH));
    }
    return confirmedSend(params);
  });
}

async function preparedPlan(amountUsdc = "5") {
  const prepared = await prepareGasTopUp({
    organizationId: "org-1",
    chainId: BASE,
    amountUsdc,
  });
  if (!prepared.ok) {
    throw new Error(`prepare refused: ${prepared.error}`);
  }
  return prepared.plan;
}

beforeEach(() => {
  vi.clearAllMocks();
  chain.balances = new Map([[balanceKey(USDC, WALLET), BigInt(50_000_000)]]);
  chain.quote = QUOTE;
  chain.quoteThrows = false;
  chain.quotes = [];
  chain.receipts = new Map();
  chain.receiptThrows = false;
  chain.receiptReads = 0;
  chain.receiptLagReads = 0;
  chain.tokenRows = [
    {
      tokenAddress: USDC.toLowerCase(),
      decimals: 6,
      symbol: "USDC",
      isStablecoin: true,
    },
  ];
  clearExplorerConfigCache();
  mockExplorerFindFirst.mockResolvedValue({ chainId: BASE });
  mockCheckCap.mockResolvedValue({ kind: "allowed" });
  mockDailyDenial.mockResolvedValue(null);
  mockResolveSigner.mockResolvedValue({ kind: "eoa", ownerAddress: WALLET });
  mockShouldTrySponsorship.mockReturnValue(true);
  mockCheckGasCredits.mockResolvedValue({ allowed: true, remainingCents: 1 });
  // 5 USDC for QUOTE (0.001 WETH) is exactly 5000 USD per ETH.
  mockOraclePrice.mockResolvedValue(5000);
  mockCreateSponsoredClient.mockResolvedValue({
    subOrgId: "sub-1",
    walletAddress: WALLET.toLowerCase(),
    chainId: BASE,
  });
  sendsSucceed();
});

describe("minimumOracleWethOut", () => {
  it("prices USDC at 1 USD against the oracle, less 2%", () => {
    // 5 USDC at 5000 USD per ETH is 0.001 ETH; 2% off is 0.00098.
    expect(minimumOracleWethOut(BigInt(5_000_000), 6, 5000)).toBe(
      BigInt("980000000000000")
    );
    expect(minimumOracleWethOut(BigInt(5_000_000), 6, 5000, 0)).toBe(QUOTE);
  });

  it("handles an 18-decimal token and a fractional price", () => {
    expect(minimumOracleWethOut(ONE_WETH, 18, 2500.5, 0)).toBe(
      (ONE_WETH * BigInt(100_000_000)) / BigInt(250_050_000_000)
    );
  });
});

describe("wethReceivedFromLogs", () => {
  it("sums WETH transfers to the wallet and ignores everything else", () => {
    const logs = [
      // USDC leaving the wallet for the pool.
      transferLog(USDC, WALLET, POOL, BigInt(5_000_000)),
      // WETH moving somewhere other than the wallet.
      transferLog(WETH, POOL, ROUTER, BigInt(999)),
      // Another token paying the wallet.
      transferLog(USDC, POOL, WALLET, BigInt(7)),
      transferLog(WETH, POOL, WALLET, BigInt(1000)),
      transferLog(WETH, ROUTER, WALLET, BigInt(24)),
    ];

    expect(wethReceivedFromLogs(logs, WETH, WALLET)).toBe(BigInt(1024));
  });

  it("ignores a non-Transfer WETH event", () => {
    const deposit = {
      ...transferLog(WETH, POOL, WALLET, BigInt(1000)),
      topics: [
        "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c",
        `0x000000000000000000000000${WALLET.slice(2).toLowerCase()}`,
      ] as Hex[],
    };

    expect(wethReceivedFromLogs([deposit], WETH, WALLET)).toBe(BigInt(0));
  });
});

describe("resolveGasTopUpContracts", () => {
  it("reads router, quoter and WETH from the protocol registry", () => {
    expect(resolveGasTopUpContracts(BASE)).toEqual({
      router: ROUTER,
      quoter: QUOTER,
      weth: WETH,
      fee: 500,
    });
  });

  it("resolves every supported chain", () => {
    for (const chainId of [1, 8453, 42_161, 11_155_111] as const) {
      expect(resolveGasTopUpContracts(chainId), String(chainId)).not.toBeNull();
      expect(
        getChainTokens(chainId).some((token) => token.symbol === "USDC"),
        `canonical USDC on ${chainId}`
      ).toBe(true);
    }
  });
});

describe("prepareGasTopUp", () => {
  it("refuses an unsupported chain", async () => {
    const result = await prepareGasTopUp({
      organizationId: "org-1",
      chainId: 10,
      amountUsdc: "5",
    });
    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED_CHAIN" });
  });

  it("refuses when USDC is not in the stablecoin registry for the chain", async () => {
    chain.tokenRows = [];
    const result = await prepareGasTopUp({
      organizationId: "org-1",
      chainId: BASE,
      amountUsdc: "5",
    });
    expect(result).toMatchObject({ ok: false, code: "USDC_NOT_CONFIGURED" });
  });

  it("ignores a stablecoin row labelled USDC at a non-canonical address", async () => {
    chain.tokenRows = [
      {
        tokenAddress: "0x00000000000000000000000000000000000000c1",
        decimals: 18,
        symbol: "USDC",
        isStablecoin: true,
      },
      {
        tokenAddress: USDC.toLowerCase(),
        decimals: 6,
        symbol: "USDC",
        isStablecoin: true,
      },
    ];

    const plan = await preparedPlan("5");

    expect(plan.usdc).toEqual({ address: USDC, decimals: 6 });
    expect(plan.amountIn).toBe(BigInt(5_000_000));
  });

  it("refuses when only a non-canonical USDC row is registered", async () => {
    chain.tokenRows = [
      {
        tokenAddress: "0x00000000000000000000000000000000000000c1",
        decimals: 6,
        symbol: "USDC",
        isStablecoin: true,
      },
    ];
    const result = await prepareGasTopUp({
      organizationId: "org-1",
      chainId: BASE,
      amountUsdc: "5",
    });
    expect(result).toMatchObject({ ok: false, code: "USDC_NOT_CONFIGURED" });
    expect(mockCheckCap).not.toHaveBeenCalled();
  });

  it("refuses when the canonical USDC row is not flagged as a stablecoin", async () => {
    chain.tokenRows = [
      {
        tokenAddress: USDC.toLowerCase(),
        decimals: 6,
        symbol: "USDC",
        isStablecoin: false,
      },
    ];
    const result = await prepareGasTopUp({
      organizationId: "org-1",
      chainId: BASE,
      amountUsdc: "5",
    });
    expect(result).toMatchObject({ ok: false, code: "USDC_NOT_CONFIGURED" });
    expect(mockCheckCap).not.toHaveBeenCalled();
  });

  it("checks the full amount against the per-call stablecoin cap", async () => {
    mockCheckCap.mockResolvedValue({
      kind: "denied",
      error:
        "Stablecoin transfer of 250 USDC exceeds the 100 USD per-transaction limit",
    });
    const result = await prepareGasTopUp({
      organizationId: "org-1",
      chainId: BASE,
      amountUsdc: "250",
    });
    expect(result).toMatchObject({
      ok: false,
      code: "STABLECOIN_CAP_EXCEEDED",
      field: "amountUsdc",
    });
    expect(mockCheckCap).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: BASE,
        tokenAddress: USDC,
        amount: "250",
      })
    );
    expect(mockCreateSponsoredClient).not.toHaveBeenCalled();
    expect(mockDailyDenial).not.toHaveBeenCalled();
  });

  it("refuses a spent daily budget before the signer, credit and Turnkey work", async () => {
    const denial =
      "Daily gas top-up limit exceeded: 198 USD used today, 5 USD requested, limit 200 USD";
    mockDailyDenial.mockResolvedValue(denial);

    const result = await prepareGasTopUp({
      organizationId: "org-1",
      chainId: BASE,
      amountUsdc: "5",
    });

    expect(result).toEqual({
      ok: false,
      code: "DAILY_LIMIT_EXCEEDED",
      error: denial,
      field: "amountUsdc",
    });
    expect(mockDailyLimit).toHaveBeenCalledWith(BigInt(5_000_000));
    expect(mockDailyDenial).toHaveBeenCalledWith(
      db,
      "org-1",
      mockDailyLimit.mock.results[0]?.value
    );
    expect(mockResolveSigner).not.toHaveBeenCalled();
    expect(mockCheckGasCredits).not.toHaveBeenCalled();
    expect(mockCreateSponsoredClient).not.toHaveBeenCalled();
  });

  it("checks the daily budget with the same amount the plan carries", async () => {
    const plan = await preparedPlan("2.5");

    expect(mockDailyLimit).toHaveBeenCalledOnce();
    expect(mockDailyLimit).toHaveBeenCalledWith(plan.amountMicroUsd);
    expect(mockCreateSponsoredClient).toHaveBeenCalledOnce();
  });

  it("pins the signer to the EOA", async () => {
    await preparedPlan();
    expect(mockResolveSigner).toHaveBeenCalledWith(
      expect.objectContaining({ web3Connection: "eoa" })
    );
  });

  it("fails closed when sponsorship is not available on the chain", async () => {
    mockShouldTrySponsorship.mockReturnValue(false);
    const result = await prepareGasTopUp({
      organizationId: "org-1",
      chainId: BASE,
      amountUsdc: "5",
    });
    expect(result).toMatchObject({
      ok: false,
      code: "SPONSORSHIP_UNAVAILABLE",
    });
  });

  it("fails closed when gas credits are exhausted", async () => {
    mockCheckGasCredits.mockResolvedValue({
      allowed: false,
      reason: "cap reached",
    });
    const result = await prepareGasTopUp({
      organizationId: "org-1",
      chainId: BASE,
      amountUsdc: "5",
    });
    expect(result).toMatchObject({
      ok: false,
      code: "SPONSORSHIP_UNAVAILABLE",
    });
  });

  it("fails closed when there is no Turnkey wallet to sponsor", async () => {
    mockCreateSponsoredClient.mockResolvedValue(null);
    const result = await prepareGasTopUp({
      organizationId: "org-1",
      chainId: BASE,
      amountUsdc: "5",
    });
    expect(result).toMatchObject({
      ok: false,
      code: "SPONSORSHIP_UNAVAILABLE",
    });
  });

  it("uses the sponsored wallet as the plan wallet, in base units", async () => {
    const plan = await preparedPlan("2.5");
    expect(plan.wallet).toBe(WALLET);
    expect(plan.amountIn).toBe(BigInt(2_500_000));
    expect(plan.amountMicroUsd).toBe(BigInt(2_500_000));
  });

  it("derives the cap amount from the token row's decimals, not a fixed 6", async () => {
    chain.tokenRows = [
      {
        tokenAddress: USDC.toLowerCase(),
        decimals: 18,
        symbol: "USDC",
        isStablecoin: true,
      },
    ];

    const plan = await preparedPlan("5");

    expect(plan.amountIn).toBe(BigInt(5) * BigInt(10) ** BigInt(18));
    expect(plan.amountMicroUsd).toBe(BigInt(5_000_000));
  });

  it("rounds the cap amount up so a sub-micro-USD remainder is never dropped", async () => {
    chain.tokenRows = [
      {
        tokenAddress: USDC.toLowerCase(),
        decimals: 18,
        symbol: "USDC",
        isStablecoin: true,
      },
    ];

    const plan = await preparedPlan("0.0000005");

    expect(plan.amountIn).toBe(BigInt(500_000_000_000));
    expect(plan.amountMicroUsd).toBe(BigInt(1));
  });
});

describe("executeGasTopUp", () => {
  it("approves exactly amountIn, swaps to the wallet with the quoted floor, and unwraps what arrived", async () => {
    const plan = await preparedPlan("5");

    const before = Math.floor(Date.now() / 1000);
    const result = await executeGasTopUp({ plan, executionId: "exec-1" });
    const after = Math.floor(Date.now() / 1000);

    expect(result.success).toBe(true);
    expect(mockSponsoredSend).toHaveBeenCalledTimes(3);

    const [approve, swap, unwrap] = mockSponsoredSend.mock.calls.map(
      (call) => call[0]
    );
    expect(approve).toMatchObject({
      executionId: "exec-1",
      to: USDC,
      functionName: "approve",
      args: [ROUTER, BigInt(5_000_000)],
    });
    expect(swap).toMatchObject({ to: ROUTER, functionName: "multicall" });
    const [deadline, calls] = swap.args as [bigint, Hex[]];
    expect(deadline).toBeGreaterThanOrEqual(BigInt(before + 180));
    expect(deadline).toBeLessThanOrEqual(BigInt(after + 180));
    expect(calls).toHaveLength(1);
    const inner = decodeFunctionData({
      abi: swapRouterAbi,
      data: calls[0] as Hex,
    });
    expect(inner).toEqual({
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: USDC,
          tokenOut: WETH,
          fee: 500,
          recipient: WALLET,
          amountIn: BigInt(5_000_000),
          amountOutMinimum: applySlippageFloor(QUOTE),
          sqrtPriceLimitX96: BigInt(0),
        },
      ],
    });
    expect(unwrap).toMatchObject({
      to: WETH,
      functionName: "withdraw",
      args: [QUOTE],
    });

    expect(result.steps.map((step) => [step.name, step.status])).toEqual([
      ["approve", "confirmed"],
      ["swap", "confirmed"],
      ["unwrap", "confirmed"],
    ]);
    expect(result).toMatchObject({
      usdcSpent: "5",
      ethReceived: "0.001",
      swapLanded: true,
      sponsored: true,
      gasUsedWei: "300",
      finalTransactionHash: "0xwithdraw",
      finalTransactionLink: "https://basescan.org/tx/0xwithdraw",
      quotedWethOut: QUOTE.toString(),
      amountOutMinimum: applySlippageFloor(QUOTE).toString(),
    });
  });

  it("keeps a confirmed top-up confirmed when the explorer lookup throws", async () => {
    mockExplorerFindFirst.mockRejectedValue(new Error("db down"));
    const plan = await preparedPlan();

    const result = await executeGasTopUp({ plan, executionId: "exec-1" });

    expect(result.success).toBe(true);
    expect(result.steps.map((step) => [step.name, step.status])).toEqual([
      ["approve", "confirmed"],
      ["swap", "confirmed"],
      ["unwrap", "confirmed"],
    ]);
    expect(result.finalTransactionHash).toBe("0xwithdraw");
    expect(result.finalTransactionLink).toBeUndefined();
    expect(mockLogSystemWarn).toHaveBeenCalledWith(
      "database",
      expect.stringContaining("Could not build the explorer link"),
      expect.any(Error),
      expect.objectContaining({ chain_id: String(BASE) })
    );
  });

  it("unwraps only the WETH the swap delivered, not WETH already held", async () => {
    chain.balances.set(balanceKey(WETH, WALLET), ONE_WETH);
    const plan = await preparedPlan();

    await executeGasTopUp({ plan, executionId: "exec-1" });

    const unwrap = mockSponsoredSend.mock.calls[2]?.[0];
    expect(unwrap.args).toEqual([QUOTE]);
  });

  it("unwraps an output above the quote exactly, not just the floor", async () => {
    const better = QUOTE + BigInt(12_345);
    sendsSucceed(better);
    const plan = await preparedPlan();

    const result = await executeGasTopUp({ plan, executionId: "exec-1" });

    expect(mockSponsoredSend.mock.calls[2]?.[0].args).toEqual([better]);
    expect(result.warning).toBeUndefined();
    expect(mockLogSystemWarn).not.toHaveBeenCalled();
  });

  it("sets the swap floor from a quote taken after the approve, not the pre-flight one", async () => {
    const fresh = QUOTE * BigInt(2);
    chain.quotes = [QUOTE, fresh];
    sendsSucceed(fresh);
    const plan = await preparedPlan();

    const result = await executeGasTopUp({ plan, executionId: "exec-1" });

    const swap = mockSponsoredSend.mock.calls[1]?.[0];
    const [, calls] = swap.args as [bigint, Hex[]];
    const inner = decodeFunctionData({ abi: swapRouterAbi, data: calls[0] });
    expect(inner.args?.[0]).toMatchObject({
      amountOutMinimum: applySlippageFloor(fresh),
    });
    expect(result).toMatchObject({
      success: true,
      quotedWethOut: fresh.toString(),
      amountOutMinimum: applySlippageFloor(fresh).toString(),
    });
  });

  it.each([
    [
      "fails",
      new Error("quoter unavailable"),
      "Re-quote before the swap failed",
    ],
    ["returns zero", BigInt(0), "returned no WETH"],
  ])(
    "does not send the swap when the re-quote %s",
    async (_label, answer, message) => {
      chain.quotes = [QUOTE, answer];
      const plan = await preparedPlan();

      const result = await executeGasTopUp({ plan, executionId: "exec-1" });

      expect(mockSponsoredSend).toHaveBeenCalledTimes(2);
      expect(approvedAmounts()).toEqual([BigInt(5_000_000), BigInt(0)]);
      expect(mockSponsoredSend.mock.calls[1]?.[0]).toMatchObject({
        to: USDC,
        functionName: "approve",
        args: [ROUTER, BigInt(0)],
      });
      expect(result.steps.map((step) => [step.name, step.status])).toEqual([
        ["approve", "confirmed"],
        ["swap", "failed"],
        ["unwrap", "skipped"],
      ]);
      expect(result).toMatchObject({
        success: false,
        usdcSpent: "0",
        swapLanded: false,
        approvalRevoked: true,
        revokeTransactionHash: REVOKE_HASH,
        revokeTransactionLink: `https://basescan.org/tx/${REVOKE_HASH}`,
        failure: { step: "swap", broadcastAttempted: false },
      });
      expect(result.failure?.transactionHash).toBeUndefined();
      expect(result.gasUsedWei).toBe("200");
      expect(result.error).toContain(message);
      expect(result.error).toContain("no USDC was spent");
      expect(result.error).toContain("the approval was set back to zero");
    }
  );

  it("refuses before sending anything when the quote is more than 2% worse than the oracle", async () => {
    chain.quote = (QUOTE * BigInt(97)) / BigInt(100);
    const plan = await preparedPlan();

    const result = await executeGasTopUp({ plan, executionId: "exec-1" });

    expect(mockSponsoredSend).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      usdcSpent: "0",
      failure: { step: "preflight", broadcastAttempted: false },
    });
    expect(result.error).toContain("more than 2% worse than the Chainlink");
    expect(mockOraclePrice).toHaveBeenCalledWith(
      "https://rpc.example.com",
      BASE
    );
  });

  it("does not send the swap when the re-quote is more than 2% worse than the oracle", async () => {
    chain.quotes = [QUOTE, (QUOTE * BigInt(97)) / BigInt(100)];
    const plan = await preparedPlan();

    const result = await executeGasTopUp({ plan, executionId: "exec-1" });

    expect(mockSponsoredSend).toHaveBeenCalledTimes(2);
    expect(approvedAmounts()).toEqual([BigInt(5_000_000), BigInt(0)]);
    expect(result.approvalRevoked).toBe(true);
    expect(result.steps).toMatchObject([
      { name: "approve", status: "confirmed" },
      { name: "swap", status: "failed" },
      { name: "unwrap", status: "skipped" },
    ]);
    expect(result.steps[1]?.transactionHash).toBeUndefined();
    expect(result).toMatchObject({
      success: false,
      usdcSpent: "0",
      swapLanded: false,
      failure: { step: "swap", broadcastAttempted: false },
    });
    expect(result.error).toContain("more than 2% worse than the Chainlink");
  });

  it("refuses before sending anything when no fresh oracle price is available", async () => {
    mockOraclePrice.mockRejectedValue(new Error("Chainlink price stale"));
    const plan = await preparedPlan();

    const result = await executeGasTopUp({ plan, executionId: "exec-1" });

    expect(mockSponsoredSend).not.toHaveBeenCalled();
    expect(result.failure).toMatchObject({ step: "preflight" });
    expect(result.error).toContain("No fresh Chainlink ETH/USD price");
    expect(result.error).toContain("Chainlink price stale");
  });

  it.each([
    ["better than the oracle", (QUOTE * BigInt(110)) / BigInt(100)],
    ["within 2% of the oracle", (QUOTE * BigInt(99)) / BigInt(100)],
  ])("swaps when the quote is %s", async (_label, quote) => {
    chain.quote = quote;
    sendsSucceed(quote);
    const plan = await preparedPlan();

    const result = await executeGasTopUp({ plan, executionId: "exec-1" });

    expect(result.success).toBe(true);
    expect(mockSponsoredSend).toHaveBeenCalledTimes(3);
    expect(mockOraclePrice).toHaveBeenCalledTimes(2);
  });

  it("skips the oracle check on a testnet", async () => {
    chain.quote = QUOTE / BigInt(2);
    sendsSucceed(QUOTE / BigInt(2));
    const plan = { ...(await preparedPlan()), chainId: 11_155_111 as const };

    const result = await executeGasTopUp({ plan, executionId: "exec-1" });

    expect(result.success).toBe(true);
    expect(mockOraclePrice).not.toHaveBeenCalled();
  });

  it("retries a receipt a lagging node reports missing and unwraps it exactly", async () => {
    const better = QUOTE + BigInt(777);
    sendsSucceed(better);
    chain.receiptLagReads = 2;
    const plan = await preparedPlan();

    const result = await executeGasTopUp({
      plan,
      executionId: "exec-1",
      receiptRead: { delayMs: 0 },
    });

    expect(chain.receiptReads).toBe(3);
    expect(mockSponsoredSend.mock.calls[2]?.[0].args).toEqual([better]);
    expect(result.warning).toBeUndefined();
    expect(mockLogSystemWarn).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the receipt read keeps failing",
      5,
      () => {
        chain.receiptThrows = true;
      },
    ],
    [
      "every read reports the receipt missing",
      5,
      () => {
        chain.receiptLagReads = Number.POSITIVE_INFINITY;
      },
    ],
    [
      "the receipt carries no WETH transfer to the wallet",
      1,
      () => {
        mockSponsoredSend.mockImplementation(
          (params: { to: string; functionName: string }) => {
            if (params.to === ROUTER) {
              chain.receipts.set(SWAP_HASH, {
                logs: [transferLog(USDC, WALLET, POOL, BigInt(5_000_000))],
              });
              return Promise.resolve(confirmed(SWAP_HASH));
            }
            return Promise.resolve(confirmed(`0x${params.functionName}`));
          }
        );
      },
    ],
  ])(
    "unwraps the floor, warns and logs when %s",
    async (_label, reads, arrange) => {
      arrange();
      const plan = await preparedPlan();

      const result = await executeGasTopUp({
        plan,
        executionId: "exec-1",
        receiptRead: { delayMs: 0 },
      });

      // A mined receipt is final; only a missing or failed read is retried.
      expect(chain.receiptReads).toBe(reads);
      const floor = applySlippageFloor(QUOTE);
      expect(mockSponsoredSend.mock.calls[2]?.[0].args).toEqual([floor]);
      expect(result.success).toBe(true);
      expect(result.warning).toContain("guaranteed minimum");
      expect(result.warning).toContain("wrapped/unwrap");
      expect(mockLogSystemWarn).toHaveBeenCalledWith(
        "network_rpc",
        expect.stringContaining("Could not read the swap's WETH output"),
        expect.any(Error),
        expect.objectContaining({
          execution_id: "exec-1",
          transaction_hash: SWAP_HASH,
        })
      );
    }
  );

  it("refuses before sending anything when the quote is zero", async () => {
    chain.quote = BigInt(0);
    const plan = await preparedPlan();

    const result = await executeGasTopUp({ plan, executionId: "exec-1" });

    expect(result.success).toBe(false);
    expect(result.broadcastAttempted).toBe(false);
    expect(result.failure).toMatchObject({
      step: "preflight",
      broadcastAttempted: false,
    });
    expect(mockSponsoredSend).not.toHaveBeenCalled();
  });

  it("refuses before sending anything when the quote fails", async () => {
    chain.quoteThrows = true;
    const plan = await preparedPlan();

    const result = await executeGasTopUp({ plan, executionId: "exec-1" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Quote failed");
    expect(mockSponsoredSend).not.toHaveBeenCalled();
  });

  it("refuses before sending anything when the wallet holds too little USDC", async () => {
    chain.balances.set(balanceKey(USDC, WALLET), BigInt(1_000_000));
    const plan = await preparedPlan("5");

    const result = await executeGasTopUp({ plan, executionId: "exec-1" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Insufficient USDC");
    expect(mockSponsoredSend).not.toHaveBeenCalled();
  });

  it("fails closed with no fallback when sponsorship declines the approve", async () => {
    mockSponsoredSend.mockResolvedValue(null);
    const plan = await preparedPlan();

    const result = await executeGasTopUp({ plan, executionId: "exec-1" });

    expect(mockSponsoredSend).toHaveBeenCalledOnce();
    expect(result.success).toBe(false);
    expect(result.failure).toMatchObject({
      step: "approve",
      broadcastAttempted: false,
    });
    expect(result.steps.map((step) => step.status)).toEqual([
      "failed",
      "skipped",
      "skipped",
    ]);
    expect(result.usdcSpent).toBe("0");
    expect(result.approvalRevoked).toBeUndefined();
  });

  it("reports a reverted swap after a confirmed approve with no USDC spent", async () => {
    mockSponsoredSend.mockImplementation((params: SendParams) => {
      if (params.to === ROUTER) {
        return Promise.reject(
          new SponsoredTxRevertError({
            message: "Too little received",
            txHash: "0xswapfail",
            sendTransactionStatusId: "st-1",
            revertChain: [],
          })
        );
      }
      return confirmedSend(params);
    });
    const plan = await preparedPlan();

    const result = await executeGasTopUp({ plan, executionId: "exec-1" });

    expect(result.success).toBe(false);
    expect(result.swapLanded).toBe(false);
    expect(result.swapPending).toBeUndefined();
    expect(result.usdcSpent).toBe("0");
    expect(approvedAmounts()).toEqual([BigInt(5_000_000), BigInt(0)]);
    expect(result).toMatchObject({
      approvalRevoked: true,
      revokeTransactionHash: REVOKE_HASH,
    });
    expect(result.error).toContain("the approval was set back to zero");
    expect(result.error).toContain("Too little received");
    // The approve and the revoke; the reverted swap's fee is not counted.
    expect(result.gasUsedWei).toBe("200");
    expect(result.steps).toMatchObject([
      { name: "approve", status: "confirmed", transactionHash: "0xapprove" },
      {
        name: "swap",
        status: "failed",
        transactionHash: "0xswapfail",
        transactionLink: "https://basescan.org/tx/0xswapfail",
      },
      { name: "unwrap", status: "skipped" },
    ]);
    expect(result.failure).toMatchObject({
      step: "swap",
      transactionHash: "0xswapfail",
      transactionLink: "https://basescan.org/tx/0xswapfail",
      broadcastAttempted: true,
    });
  });

  it.each([
    ["is declined", () => Promise.resolve(null), undefined],
    [
      "reverts",
      () =>
        Promise.reject(
          new SponsoredTxRevertError({
            message: "approve reverted",
            txHash: "0xrevokefail",
            sendTransactionStatusId: "st-2",
            revertChain: [],
          })
        ),
      "0xrevokefail",
    ],
  ])(
    "reports the exact-amount approval as remaining when setting it back to zero %s",
    async (_label, revokeAnswer, revokeHash) => {
      mockSponsoredSend.mockImplementation((params: SendParams) => {
        if (params.to === ROUTER) {
          return Promise.reject(
            new SponsoredTxRevertError({
              message: "Too little received",
              txHash: "0xswapfail",
              sendTransactionStatusId: "st-1",
              revertChain: [],
            })
          );
        }
        return isRevoke(params) ? revokeAnswer() : confirmedSend(params);
      });
      const plan = await preparedPlan();

      const result = await executeGasTopUp({ plan, executionId: "exec-1" });

      expect(approvedAmounts()).toEqual([BigInt(5_000_000), BigInt(0)]);
      expect(result.success).toBe(false);
      expect(result.usdcSpent).toBe("0");
      expect(result.approvalRevoked).toBe(false);
      expect(result.revokeTransactionHash).toBe(revokeHash);
      expect(result.gasUsedWei).toBe("100");
      expect(result.error).toContain(
        "an approval for exactly the requested amount remains"
      );
      expect(result.error).toContain(
        "setting it back to zero did not complete"
      );
      expect(result.error).toContain("Too little received");
      expect(result.failure).toMatchObject({
        step: "swap",
        transactionHash: "0xswapfail",
        broadcastAttempted: true,
      });
      expect(mockLogSystemWarn).toHaveBeenCalledWith(
        "transaction",
        expect.stringContaining("Could not set the approval back to zero"),
        expect.any(Error),
        expect.objectContaining({ execution_id: "exec-1" })
      );
    }
  );

  it("does not claim the USDC is unspent while a broadcast swap is unconfirmed", async () => {
    mockSponsoredSend.mockImplementation(
      (params: { to: string; functionName: string }) => {
        if (params.to === ROUTER) {
          return Promise.reject(
            new SponsoredTxPendingError({
              message: "timed out",
              txHash: "0xswappending",
            })
          );
        }
        return Promise.resolve(confirmed(`0x${params.functionName}`));
      }
    );
    const plan = await preparedPlan();

    const result = await executeGasTopUp({ plan, executionId: "exec-1" });

    expect(result.usdcSpent).toBeUndefined();
    expect(result.swapLanded).toBe(false);
    expect(result.swapPending).toBe(true);
    expect(result.error).toContain("may or may not have been spent");
    expect(mockSponsoredSend).toHaveBeenCalledTimes(2);
    expect(approvedAmounts()).toEqual([BigInt(5_000_000)]);
    expect(result.approvalRevoked).toBeUndefined();
  });

  it("does not mark the swap pending when only the approve is unconfirmed", async () => {
    mockSponsoredSend.mockImplementation(
      (params: { to: string; functionName: string }) => {
        if (params.functionName === "approve") {
          return Promise.reject(
            new SponsoredTxPendingError({
              message: "timed out",
              txHash: "0xapprovepending",
            })
          );
        }
        return Promise.resolve(confirmed(`0x${params.functionName}`));
      }
    );
    const plan = await preparedPlan();

    const result = await executeGasTopUp({ plan, executionId: "exec-1" });

    expect(result.success).toBe(false);
    expect(result.usdcSpent).toBe("0");
    expect(result.swapLanded).toBe(false);
    expect(result.swapPending).toBeUndefined();
    expect(result.steps.map((step) => [step.name, step.status])).toEqual([
      ["approve", "failed"],
      ["swap", "skipped"],
      ["unwrap", "skipped"],
    ]);
    expect(result.failure).toMatchObject({
      step: "approve",
      transactionHash: "0xapprovepending",
      broadcastAttempted: true,
    });
    expect(mockSponsoredSend).toHaveBeenCalledOnce();
    expect(result.approvalRevoked).toBeUndefined();
  });

  it.each([
    {
      label: "reverted",
      error: () =>
        new SponsoredTxRevertError({
          message: "Too little received",
          txHash: "0xswapfail",
          sendTransactionStatusId: "st-1",
          revertChain: [],
        }),
      hash: "0xswapfail",
      pending: false,
    },
    {
      label: "unconfirmed",
      error: () =>
        new SponsoredTxPendingError({
          message: "timed out",
          txHash: "0xswappending",
        }),
      hash: "0xswappending",
      pending: true,
    },
  ])(
    "still reports a $label swap as broadcast if the classifier answers fallback",
    async ({ error, hash, pending }) => {
      vi.mocked(resolveSponsoredSendError).mockReturnValueOnce({
        fallback: true,
      });
      mockSponsoredSend.mockImplementation((params: SendParams) =>
        params.to === ROUTER ? Promise.reject(error()) : confirmedSend(params)
      );
      const plan = await preparedPlan();

      const result = await executeGasTopUp({ plan, executionId: "exec-1" });

      expect(resolveSponsoredSendError).toHaveBeenCalledOnce();
      expect(result.success).toBe(false);
      expect(result.error).not.toContain("before broadcast");
      expect(result.failure).toMatchObject({
        step: "swap",
        transactionHash: hash,
        transactionLink: `https://basescan.org/tx/${hash}`,
        broadcastAttempted: true,
      });
      if (pending) {
        expect(result.swapPending).toBe(true);
        expect(result.failure?.errorClass).toBe("system");
        expect(approvedAmounts()).toEqual([BigInt(5_000_000)]);
        expect(result.approvalRevoked).toBeUndefined();
      } else {
        expect(result.swapPending).toBeUndefined();
        expect(result.failure?.errorClass).toBeUndefined();
        expect(approvedAmounts()).toEqual([BigInt(5_000_000), BigInt(0)]);
        expect(result.approvalRevoked).toBe(true);
      }
    }
  );

  it("reports a send that throws outside Turnkey's broadcast errors as never broadcast", async () => {
    mockSponsoredSend.mockRejectedValue(new Error("signer unavailable"));
    const plan = await preparedPlan();

    const result = await executeGasTopUp({ plan, executionId: "exec-1" });

    expect(mockSponsoredSend).toHaveBeenCalledOnce();
    expect(resolveSponsoredSendError).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.usdcSpent).toBe("0");
    expect(result.error).toContain(
      "Sponsored send failed before broadcast: signer unavailable"
    );
    expect(result.failure).toMatchObject({
      step: "approve",
      broadcastAttempted: false,
    });
    expect(result.failure?.transactionHash).toBeUndefined();
  });

  it("reports WETH left unwrapped when the unwrap fails after the swap landed", async () => {
    mockSponsoredSend.mockImplementation(
      (params: { to: string; functionName: string }) => {
        if (params.to === ROUTER) {
          swapPays(QUOTE);
          return Promise.resolve(confirmed(SWAP_HASH));
        }
        if (params.functionName === "withdraw") {
          return Promise.resolve(null);
        }
        return Promise.resolve(confirmed(`0x${params.functionName}`));
      }
    );
    const plan = await preparedPlan("5");

    const result = await executeGasTopUp({ plan, executionId: "exec-1" });

    expect(result.success).toBe(false);
    expect(result.swapLanded).toBe(true);
    expect(result.usdcSpent).toBe("5");
    expect(result.wethReceived).toBe("0.001");
    expect(result.ethReceived).toBeUndefined();
    expect(result.error).toContain("WETH is left unwrapped");
    expect(result.steps.map((step) => [step.name, step.status])).toEqual([
      ["approve", "confirmed"],
      ["swap", "confirmed"],
      ["unwrap", "failed"],
    ]);
    expect(result.failure).toMatchObject({
      step: "unwrap",
      broadcastAttempted: false,
    });
  });
});
