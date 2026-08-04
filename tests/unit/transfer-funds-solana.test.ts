import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getChainAdapter } from "@/lib/web3/chain-adapter";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import { initializeSolanaWallet } from "@/lib/web3/wallet-helpers";
import {
  isSolanaTransferPath,
  transferFundsCore,
} from "@/plugins/web3/steps/transfer-funds-core";

vi.mock("@/lib/web3/wallet-helpers", () => ({
  initializeSolanaWallet: vi.fn(),
  getOrganizationWalletAddress: vi.fn().mockResolvedValue("evm-wallet-address"),
}));

vi.mock("@/lib/web3/chain-adapter", () => ({
  getChainAdapter: vi.fn(),
}));

vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: vi.fn(),
}));

describe("transferFundsCore - Solana early branch", () => {
  const _mockSolanaDevnetChainId = 103;
  let mockAdapter: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockAdapter = {
      getBalance: vi.fn(),
      sendTransaction: vi.fn(),
      getTransactionUrl: vi
        .fn()
        .mockResolvedValue("https://solscan.io/tx/mock-hash"),
    };

    vi.mocked(getChainAdapter).mockReturnValue(mockAdapter);
  });

  it("isSolanaTransferPath identifies Solana chain IDs correctly", () => {
    expect(isSolanaTransferPath(101)).toBe(true); // Solana Mainnet
    expect(isSolanaTransferPath(103)).toBe(true); // Solana Devnet
    expect(isSolanaTransferPath(1)).toBe(false); // EVM Ethereum
    expect(isSolanaTransferPath(8453)).toBe(false); // EVM Base
  });

  it("successfully processes a Solana transfer when inputs are valid", async () => {
    vi.mocked(resolveOrganizationContext).mockResolvedValue({
      success: true,
      organizationId: "mock-org-id",
      userId: "mock-user-id",
    } as any);

    const mockSigner = { getPublicKey: vi.fn(), signTransaction: vi.fn() };
    vi.mocked(initializeSolanaWallet).mockResolvedValue({
      signer: mockSigner,
      address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    } as any);

    mockAdapter.getBalance.mockResolvedValue(BigInt(2_000_000_000)); // 2 SOL
    mockAdapter.sendTransaction.mockResolvedValue({
      hash: "mock-tx-hash",
      gasUsed: BigInt(5000), // CU
      effectiveGasPrice: BigInt(10), // micro-lamports
    });

    const result = await transferFundsCore({
      network: "solana-devnet",
      amount: "1.5",
      recipientAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      _context: { organizationId: "mock-org-id" },
    });

    expect(result).toEqual({
      success: true,
      transactionHash: "mock-tx-hash",
      chainId: 103,
      transactionLink: "https://solscan.io/tx/mock-hash",
      gasUsed: "5000",
      gasUsedUnits: "5000",
      effectiveGasPrice: "10",
    });

    expect(mockAdapter.getBalance).toHaveBeenCalledWith(
      undefined,
      "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
    );
    expect(mockAdapter.sendTransaction).toHaveBeenCalledWith(
      undefined,
      {
        to: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        value: BigInt(1_500_000_000),
      },
      undefined,
      expect.objectContaining({ solanaSigner: mockSigner })
    );
  });

  it("fails early when recipient address is invalid", async () => {
    const result = await transferFundsCore({
      network: "solana-devnet",
      amount: "1.0",
      recipientAddress: "invalid-solana-address",
      _context: { organizationId: "mock-org-id" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid Solana recipient address");
    }
  });

  it("fails early when amount is empty or invalid", async () => {
    const resultEmpty = await transferFundsCore({
      network: "solana-devnet",
      amount: "",
      recipientAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      _context: { organizationId: "mock-org-id" },
    });

    expect(resultEmpty.success).toBe(false);
    if (!resultEmpty.success) {
      expect(resultEmpty.error).toBe("Amount is required");
    }

    const resultInvalid = await transferFundsCore({
      network: "solana-devnet",
      amount: "invalid-amount",
      recipientAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      _context: { organizationId: "mock-org-id" },
    });

    expect(resultInvalid.success).toBe(false);
    if (!resultInvalid.success) {
      expect(resultInvalid.error).toContain("Invalid SOL amount");
    }
  });

  it("returns invalid SOL amount error on negative amount input", async () => {
    const resultNegative = await transferFundsCore({
      network: "solana-devnet",
      amount: "-1",
      recipientAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      _context: { organizationId: "mock-org-id" },
    });

    expect(resultNegative.success).toBe(false);
    if (!resultNegative.success) {
      expect(resultNegative.error).toBe("Invalid SOL amount: -1");
    }
  });

  it("rejects zero SOL amount before balance check", async () => {
    const result = await transferFundsCore({
      network: "solana-devnet",
      amount: "0",
      recipientAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      _context: { organizationId: "mock-org-id" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("SOL amount must be greater than zero");
    }
    expect(mockAdapter.getBalance).not.toHaveBeenCalled();
  });

  it("fails when balance is insufficient", async () => {
    vi.mocked(resolveOrganizationContext).mockResolvedValue({
      success: true,
      organizationId: "mock-org-id",
    } as any);

    vi.mocked(initializeSolanaWallet).mockResolvedValue({
      signer: {},
      address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    } as any);

    mockAdapter.getBalance.mockResolvedValue(BigInt(500_000_000)); // 0.5 SOL

    const result = await transferFundsCore({
      network: "solana-devnet",
      amount: "1.0",
      recipientAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      _context: { organizationId: "mock-org-id" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Insufficient SOL balance");
    }
  });

  it("fails when balance covers the amount but not the transaction fee", async () => {
    vi.mocked(resolveOrganizationContext).mockResolvedValue({
      success: true,
      organizationId: "mock-org-id",
    } as any);

    vi.mocked(initializeSolanaWallet).mockResolvedValue({
      signer: {},
      address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    } as any);

    // Balance equals the transfer amount exactly, leaving nothing for the
    // 5000-lamport base fee - must be rejected at preflight.
    mockAdapter.getBalance.mockResolvedValue(BigInt(1_000_000_000));

    const result = await transferFundsCore({
      network: "solana-devnet",
      amount: "1.0",
      recipientAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      _context: { organizationId: "mock-org-id" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Insufficient SOL balance");
    }
  });
});
