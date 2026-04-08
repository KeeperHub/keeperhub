import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockCheckGasCredits = vi.fn();
const mockRecordGasUsage = vi.fn();
const mockGetEthPriceUsd = vi.fn();

vi.mock("@/lib/billing/gas-credits", () => ({
  checkGasCredits: (...args: unknown[]) => mockCheckGasCredits(...args),
  recordGasUsage: (...args: unknown[]) => mockRecordGasUsage(...args),
  getEthPriceUsd: (...args: unknown[]) => mockGetEthPriceUsd(...args),
}));

vi.mock("@/lib/billing/feature-flag", () => ({
  isBillingEnabled: vi.fn().mockReturnValue(true),
}));

const mockIsTestnetChain = vi.fn();

vi.mock("@/lib/web3/chainlink-feeds", () => ({
  isTestnetChain: (...args: unknown[]) => mockIsTestnetChain(...args),
}));

const mockIsSponsorshipSupported = vi.fn();

vi.mock("@/lib/web3/pimlico-config", () => ({
  isSponsorshipSupported: (...args: unknown[]) =>
    mockIsSponsorshipSupported(...args),
}));

const mockSendTransaction = vi.fn();
const mockCreateSponsoredClient = vi.fn();

vi.mock("@/lib/web3/sponsored-client", () => ({
  createSponsoredClient: (...args: unknown[]) =>
    mockCreateSponsoredClient(...args),
}));

const mockWaitForTransactionReceipt = vi.fn();

vi.mock("viem", () => ({
  createPublicClient: () => ({
    waitForTransactionReceipt: (...args: unknown[]) =>
      mockWaitForTransactionReceipt(...args),
  }),
  encodeFunctionData: () => "0xencoded",
  http: () => ({}),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { TRANSACTION: "transaction" },
  logSystemError: vi.fn(),
}));

const mockIncrementCounter = vi.fn();

vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: (...args: unknown[]) => mockIncrementCounter(...args),
  }),
}));

vi.mock("@/lib/metrics/types", () => ({
  MetricNames: {
    SPONSORSHIP_TRANSACTIONS_TOTAL: "sponsorship.transactions.total",
    SPONSORSHIP_GAS_USED_TOTAL: "sponsorship.gas_used.total",
    SPONSORSHIP_GAS_COST_USD_MICRO_TOTAL:
      "sponsorship.gas_cost_usd_micro.total",
  },
}));

import { isBillingEnabled } from "@/lib/billing/feature-flag";
import {
  executeSponsoredContractTransaction,
  executeSponsoredTransaction,
} from "@/lib/web3/sponsored-transaction-manager";

const baseTxParams = {
  organizationId: "org_1",
  executionId: "exec_1",
  chainId: 11_155_111,
  rpcUrl: "https://rpc.example.com",
  walletAddress: "0xwallet",
  to: "0xrecipient",
};

const baseContractParams = {
  ...baseTxParams,
  abi: [{ type: "function", name: "store", inputs: [], outputs: [] }],
  functionName: "store",
  args: [42],
};

function setupSuccessfulSponsorship(): void {
  mockIsSponsorshipSupported.mockReturnValue(true);
  mockIsTestnetChain.mockReturnValue(false);
  mockCheckGasCredits.mockResolvedValue({
    allowed: true,
    remainingCents: 500,
  });
  mockCreateSponsoredClient.mockResolvedValue({
    smartAccountClient: { sendTransaction: mockSendTransaction },
  });
  mockSendTransaction.mockResolvedValue("0xtxhash");
  mockWaitForTransactionReceipt.mockResolvedValue({
    status: "success",
    gasUsed: BigInt(21_000),
    effectiveGasPrice: BigInt(1_000_000_000),
  });
  mockGetEthPriceUsd.mockResolvedValue(2000);
  mockRecordGasUsage.mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isBillingEnabled).mockReturnValue(true);
});

describe("executeSponsoredTransaction", () => {
  it("returns null when billing is disabled", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(false);

    const result = await executeSponsoredTransaction(baseTxParams);

    expect(result).toBeNull();
  });

  it("returns null when chain is not supported", async () => {
    mockIsSponsorshipSupported.mockReturnValue(false);

    const result = await executeSponsoredTransaction(baseTxParams);

    expect(result).toBeNull();
  });

  it("returns null when gas credits are exhausted", async () => {
    mockIsSponsorshipSupported.mockReturnValue(true);
    mockCheckGasCredits.mockResolvedValue({
      allowed: false,
      reason: "Gas credits exhausted for current billing period",
    });

    const result = await executeSponsoredTransaction(baseTxParams);

    expect(result).toBeNull();
    expect(mockCreateSponsoredClient).not.toHaveBeenCalled();
  });

  it("returns null when client creation fails", async () => {
    mockIsSponsorshipSupported.mockReturnValue(true);
    mockCheckGasCredits.mockResolvedValue({
      allowed: true,
      remainingCents: 500,
    });
    mockCreateSponsoredClient.mockResolvedValue(null);

    const result = await executeSponsoredTransaction(baseTxParams);

    expect(result).toBeNull();
  });

  it("returns result on successful sponsorship", async () => {
    setupSuccessfulSponsorship();

    const result = await executeSponsoredTransaction(baseTxParams);

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(result?.transactionHash).toBe("0xtxhash");
    expect(result?.sponsored).toBe(true);
  });

  it("returns gasUsed as raw gas units, not wei cost", async () => {
    setupSuccessfulSponsorship();

    const result = await executeSponsoredTransaction(baseTxParams);

    expect(result?.gasUsed).toBe("21000");
  });

  it("records gas usage after confirmation", async () => {
    setupSuccessfulSponsorship();

    await executeSponsoredTransaction(baseTxParams);

    expect(mockRecordGasUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_1",
        chainId: 11_155_111,
        txHash: "0xtxhash",
        gasUsed: BigInt(21_000),
        gasPrice: BigInt(1_000_000_000),
        ethPriceUsd: 2000,
      })
    );
  });

  it("returns null and logs error when sendTransaction throws", async () => {
    mockIsSponsorshipSupported.mockReturnValue(true);
    mockCheckGasCredits.mockResolvedValue({
      allowed: true,
      remainingCents: 500,
    });
    mockCreateSponsoredClient.mockResolvedValue({
      smartAccountClient: { sendTransaction: mockSendTransaction },
    });
    mockSendTransaction.mockRejectedValue(new Error("bundler rejected"));

    const result = await executeSponsoredTransaction(baseTxParams);

    expect(result).toBeNull();
  });

  it("still returns result when recordGasUsage fails", async () => {
    setupSuccessfulSponsorship();
    mockRecordGasUsage.mockRejectedValue(new Error("DB error"));

    const result = await executeSponsoredTransaction(baseTxParams);

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
  });

  it("passes rpcUrl and chainId to getEthPriceUsd", async () => {
    setupSuccessfulSponsorship();
    const mainnetParams = { ...baseTxParams, chainId: 8453 };

    await executeSponsoredTransaction(mainnetParams);

    expect(mockGetEthPriceUsd).toHaveBeenCalledWith(
      "https://rpc.example.com",
      8453
    );
  });

  it("records gas usage with zero price on testnet chains", async () => {
    setupSuccessfulSponsorship();
    mockIsTestnetChain.mockReturnValue(true);

    const result = await executeSponsoredTransaction(baseTxParams);

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(mockGetEthPriceUsd).not.toHaveBeenCalled();
    expect(mockRecordGasUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_1",
        chainId: 11_155_111,
        ethPriceUsd: 0,
      })
    );
  });

  it("still emits transaction and gas_used metrics on testnet", async () => {
    setupSuccessfulSponsorship();
    mockIsTestnetChain.mockReturnValue(true);

    await executeSponsoredTransaction(baseTxParams);

    expect(mockIncrementCounter).toHaveBeenCalledWith(
      "sponsorship.transactions.total",
      expect.objectContaining({ chain_id: "11155111" })
    );
    expect(mockIncrementCounter).toHaveBeenCalledWith(
      "sponsorship.gas_used.total",
      expect.objectContaining({ chain_id: "11155111" }),
      21_000
    );
    expect(mockIncrementCounter).not.toHaveBeenCalledWith(
      "sponsorship.gas_cost_usd_micro.total",
      expect.anything(),
      expect.anything()
    );
  });
});

describe("executeSponsoredContractTransaction", () => {
  it("returns null when credits are exhausted", async () => {
    mockIsSponsorshipSupported.mockReturnValue(true);
    mockCheckGasCredits.mockResolvedValue({
      allowed: false,
      reason: "Gas credits exhausted for current billing period",
    });

    const result =
      await executeSponsoredContractTransaction(baseContractParams);

    expect(result).toBeNull();
  });

  it("returns result on successful contract call", async () => {
    setupSuccessfulSponsorship();

    const result =
      await executeSponsoredContractTransaction(baseContractParams);

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(result?.gasUsed).toBe("21000");
  });
});
