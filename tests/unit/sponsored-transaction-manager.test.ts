import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockCheckGasCredits = vi.fn();
const mockRecordGasUsage = vi.fn();
const mockGetGasTokenPriceUsd = vi.fn();

vi.mock("@/lib/billing/gas-credits", () => ({
  checkGasCredits: (...args: unknown[]) => mockCheckGasCredits(...args),
  recordGasUsage: (...args: unknown[]) => mockRecordGasUsage(...args),
  getGasTokenPriceUsd: (...args: unknown[]) => mockGetGasTokenPriceUsd(...args),
}));

vi.mock("@/lib/web3/sponsorship-feature-flag", () => ({
  isGasSponsorshipEnabled: vi.fn().mockReturnValue(true),
}));

const mockIsTestnetChain = vi.fn();

vi.mock("@/lib/web3/chainlink-feeds", () => ({
  isTestnetChain: (...args: unknown[]) => mockIsTestnetChain(...args),
}));

const mockIsSponsorshipSupported = vi.fn();

vi.mock("@/lib/web3/turnkey-sponsorship-config", () => ({
  isSponsorshipSupported: (...args: unknown[]) =>
    mockIsSponsorshipSupported(...args),
}));

const mockCreateSponsoredClient = vi.fn();
vi.mock("@/lib/web3/sponsored-client", () => ({
  createSponsoredClient: (...args: unknown[]) =>
    mockCreateSponsoredClient(...args),
}));

const mockSubmitTurnkeySponsoredTransaction = vi.fn();
vi.mock("@/lib/web3/turnkey-sponsored-tx", () => ({
  submitTurnkeySponsoredTransaction: (...args: unknown[]) =>
    mockSubmitTurnkeySponsoredTransaction(...args),
}));

// Receipt reads are keyed by endpoint so a test can make one endpoint fail and
// another answer, which is the whole point of trying more than one.
const mockWaitForTransactionReceipt = vi.fn();

vi.mock("viem", () => ({
  createPublicClient: ({ transport }: { transport: { url: string } }) => ({
    waitForTransactionReceipt: (args: Record<string, unknown>) =>
      mockWaitForTransactionReceipt({ ...args, url: transport.url }),
  }),
  encodeFunctionData: () => "0xencoded",
  http: (url: string) => ({ url }),
  BaseError: class BaseError extends Error {},
}));

const mockResolveRpcConfig = vi.fn();
vi.mock("@/lib/rpc/config-service", () => ({
  resolveRpcConfig: (...args: unknown[]) => mockResolveRpcConfig(...args),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { TRANSACTION: "transaction", NETWORK_RPC: "network_rpc" },
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

import {
  executeSponsoredContractTransaction,
  executeSponsoredTransaction,
} from "@/lib/web3/sponsored-transaction-manager";
import { isGasSponsorshipEnabled } from "@/lib/web3/sponsorship-feature-flag";
import {
  isSponsoredTxPendingError,
  isSponsoredTxRevertError,
  type SponsoredTxPendingError,
} from "@/lib/web3/turnkey-revert";

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

// One rotation, no waiting: the receipt wait budget is wall-clock, so a test
// that expects it to give up would otherwise sit through the full five minutes.
const SINGLE_ROTATION = { budgetMs: 0, perEndpointMs: 50, roundDelayMs: 0 };

const blockedRpcUrls: [string, string][] = [
  ["loopback hostname", "http://localhost:8548"],
  ["loopback IP literal", "http://127.0.0.1:8548"],
  ["RFC1918 private range", "http://10.0.0.5:8545"],
  ["IPv6 loopback", "http://[::1]:8548"],
  ["IPv6 unique-local range", "http://[fc00::1]:8548"],
];

function setupSuccessfulSponsorship(): void {
  mockIsSponsorshipSupported.mockReturnValue(true);
  mockIsTestnetChain.mockReturnValue(false);
  mockCheckGasCredits.mockResolvedValue({
    allowed: true,
    remainingCents: 500,
  });
  mockCreateSponsoredClient.mockResolvedValue({
    subOrgId: "suborg-123",
    walletAddress: "0xwallet",
    chainId: 11_155_111,
  });
  mockSubmitTurnkeySponsoredTransaction.mockResolvedValue({
    txHash: "0xtxhash",
    sendTransactionStatusId: "status-1",
  });
  mockWaitForTransactionReceipt.mockResolvedValue({
    status: "success",
    gasUsed: BigInt(21_000),
    effectiveGasPrice: BigInt(1_000_000_000),
  });
  mockGetGasTokenPriceUsd.mockResolvedValue(2000);
  mockRecordGasUsage.mockResolvedValue(undefined);
  mockResolveRpcConfig.mockResolvedValue({
    chainId: 11_155_111,
    chainName: "sepolia",
    primaryRpcUrl: "https://rpc.example.com",
    fallbackRpcUrl: "https://fallback.example.com",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isGasSponsorshipEnabled).mockReturnValue(true);
});

describe("executeSponsoredTransaction", () => {
  it("returns null when gas sponsorship is disabled", async () => {
    vi.mocked(isGasSponsorshipEnabled).mockReturnValue(false);

    const result = await executeSponsoredTransaction(baseTxParams);

    expect(result).toBeNull();
    expect(mockCheckGasCredits).not.toHaveBeenCalled();
    expect(mockCreateSponsoredClient).not.toHaveBeenCalled();
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

  it("returns null when client preflight fails (non-Turnkey wallet)", async () => {
    mockIsSponsorshipSupported.mockReturnValue(true);
    mockCheckGasCredits.mockResolvedValue({
      allowed: true,
      remainingCents: 500,
    });
    mockCreateSponsoredClient.mockResolvedValue(null);

    const result = await executeSponsoredTransaction(baseTxParams);

    expect(result).toBeNull();
    expect(mockSubmitTurnkeySponsoredTransaction).not.toHaveBeenCalled();
  });

  it("returns null when Turnkey rejects the activity", async () => {
    setupSuccessfulSponsorship();
    mockSubmitTurnkeySponsoredTransaction.mockResolvedValue(null);

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

  it("forwards value and data to the Turnkey wrapper", async () => {
    setupSuccessfulSponsorship();

    await executeSponsoredTransaction({
      ...baseTxParams,
      value: BigInt(1234),
      data: "0xdead",
    });

    expect(mockSubmitTurnkeySponsoredTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        subOrgId: "suborg-123",
        walletAddress: "0xwallet",
        chainId: 11_155_111,
        to: "0xrecipient",
        value: BigInt(1234),
        data: "0xdead",
      })
    );
  });

  it("still returns result when recordGasUsage fails", async () => {
    setupSuccessfulSponsorship();
    mockRecordGasUsage.mockRejectedValue(new Error("DB error"));

    const result = await executeSponsoredTransaction(baseTxParams);

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
  });

  it("passes rpcUrl and chainId to getGasTokenPriceUsd", async () => {
    setupSuccessfulSponsorship();
    const mainnetParams = { ...baseTxParams, chainId: 8453 };

    await executeSponsoredTransaction(mainnetParams);

    expect(mockGetGasTokenPriceUsd).toHaveBeenCalledWith(
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
    expect(mockGetGasTokenPriceUsd).not.toHaveBeenCalled();
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

  it.each(blockedRpcUrls)(
    "returns null without attempting sponsorship for a %s rpcUrl",
    async (_label, rpcUrl) => {
      setupSuccessfulSponsorship();

      const result = await executeSponsoredTransaction({
        ...baseTxParams,
        rpcUrl,
      });

      expect(result).toBeNull();
      expect(mockIsSponsorshipSupported).not.toHaveBeenCalled();
      expect(mockCheckGasCredits).not.toHaveBeenCalled();
      expect(mockCreateSponsoredClient).not.toHaveBeenCalled();
      expect(mockSubmitTurnkeySponsoredTransaction).not.toHaveBeenCalled();
    }
  );

  it("still attempts sponsorship for a public rpcUrl", async () => {
    setupSuccessfulSponsorship();

    const result = await executeSponsoredTransaction(baseTxParams);

    expect(result).not.toBeNull();
    expect(mockCreateSponsoredClient).toHaveBeenCalled();
  });
});

/**
 * Callers read `null` as "nothing was broadcast, safe to sign and send
 * directly" and a throw as "stop". Once Turnkey has handed back a hash there is
 * already a transaction from the user's wallet on the network, so returning
 * null -- or throwing anything the caller cannot recognise as terminal -- makes
 * one authorized action land twice. These tests pin the boundary.
 */
describe("failures after the sponsored transaction is broadcast", () => {
  it("raises a pending error carrying the hash when no endpoint can read the receipt", async () => {
    setupSuccessfulSponsorship();
    mockWaitForTransactionReceipt.mockRejectedValue(new Error("HTTP 429"));

    const error = await executeSponsoredTransaction(
      baseTxParams,
      SINGLE_ROTATION
    ).catch((e: unknown) => e);

    expect(isSponsoredTxPendingError(error)).toBe(true);
    expect((error as SponsoredTxPendingError).txHash).toBe("0xtxhash");
  });

  it("does not resolve to null when the receipt read fails", async () => {
    setupSuccessfulSponsorship();
    mockWaitForTransactionReceipt.mockRejectedValue(new Error("HTTP 429"));

    const result = await executeSponsoredTransaction(
      baseTxParams,
      SINGLE_ROTATION
    ).then(
      () => "resolved",
      () => "threw"
    );

    expect(result).toBe("threw");
  });

  it("reads the receipt from the fallback endpoint when the broadcast endpoint fails", async () => {
    setupSuccessfulSponsorship();
    mockWaitForTransactionReceipt.mockImplementation(
      ({ url }: { url: string }) => {
        if (url === "https://fallback.example.com") {
          return Promise.resolve({
            status: "success",
            gasUsed: BigInt(21_000),
            effectiveGasPrice: BigInt(1_000_000_000),
          });
        }
        return Promise.reject(new Error("HTTP 503"));
      }
    );

    const result = await executeSponsoredTransaction(baseTxParams);

    expect(result?.success).toBe(true);
    expect(result?.transactionHash).toBe("0xtxhash");
  });

  it("converts an untyped post-receipt failure into a pending error rather than letting it look pre-broadcast", async () => {
    setupSuccessfulSponsorship();
    // Mainnet, so the price lookup runs; it sits after the receipt, meaning the
    // transaction is already mined by the time it throws.
    mockGetGasTokenPriceUsd.mockRejectedValue(new Error("price feed down"));

    const error = await executeSponsoredTransaction(
      { ...baseTxParams, chainId: 8453 },
      SINGLE_ROTATION
    ).catch((e: unknown) => e);

    expect(isSponsoredTxPendingError(error)).toBe(true);
    expect((error as SponsoredTxPendingError).txHash).toBe("0xtxhash");
  });

  it("still surfaces an on-chain revert as a revert, not as pending", async () => {
    setupSuccessfulSponsorship();
    mockWaitForTransactionReceipt.mockResolvedValue({
      status: "reverted",
      blockNumber: BigInt(100),
      gasUsed: BigInt(21_000),
      effectiveGasPrice: BigInt(1_000_000_000),
    });

    const error = await executeSponsoredTransaction(baseTxParams).catch(
      (e: unknown) => e
    );

    expect(isSponsoredTxRevertError(error)).toBe(true);
    expect(isSponsoredTxPendingError(error)).toBe(false);
  });

  it("a pre-broadcast rejection still resolves to null so direct signing can proceed", async () => {
    setupSuccessfulSponsorship();
    mockSubmitTurnkeySponsoredTransaction.mockResolvedValue(null);

    const result = await executeSponsoredTransaction(baseTxParams);

    expect(result).toBeNull();
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

  it("encodes call data and forwards it to the Turnkey wrapper", async () => {
    setupSuccessfulSponsorship();

    await executeSponsoredContractTransaction(baseContractParams);

    expect(mockSubmitTurnkeySponsoredTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        subOrgId: "suborg-123",
        to: "0xrecipient",
        data: "0xencoded",
      })
    );
  });

  it.each(blockedRpcUrls)(
    "returns null without attempting sponsorship for a %s rpcUrl",
    async (_label, rpcUrl) => {
      setupSuccessfulSponsorship();

      const result = await executeSponsoredContractTransaction({
        ...baseContractParams,
        rpcUrl,
      });

      expect(result).toBeNull();
      expect(mockIsSponsorshipSupported).not.toHaveBeenCalled();
      expect(mockCheckGasCredits).not.toHaveBeenCalled();
      expect(mockCreateSponsoredClient).not.toHaveBeenCalled();
      expect(mockSubmitTurnkeySponsoredTransaction).not.toHaveBeenCalled();
    }
  );
});
