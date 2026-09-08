import { getAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    EXTERNAL_SERVICE: "external_service",
    TRANSACTION: "transaction",
  },
  logSystemError: vi.fn(),
}));

const mockEthSend = vi.fn();
const mockGetStatus = vi.fn();

vi.mock("@/lib/turnkey/agentic-wallet", () => ({
  getTurnkeyClientForOrg: () => ({
    apiClient: () => ({
      ethSendTransaction: (...args: unknown[]) => mockEthSend(...args),
      getSendTransactionStatus: (...args: unknown[]) => mockGetStatus(...args),
    }),
  }),
}));

vi.mock("@/lib/web3/turnkey-sponsorship-config", () => ({
  toCaip2: (chainId: number) => `eip155:${chainId}`,
}));

// turnkey-revert is intentionally NOT mocked so `instanceof` works against the
// real error classes.
import {
  SponsoredTxPendingError,
  SponsoredTxRevertError,
} from "@/lib/web3/turnkey-revert";
import { submitTurnkeySponsoredTransaction } from "@/lib/web3/turnkey-sponsored-tx";

// Tight poll options so the timeout / retry paths resolve in milliseconds.
const FAST_POLL = { timeoutMs: 40, intervalMs: 5 };

const SEPOLIA = 11_155_111;
// Generic, lowercased test address (not a real wallet); getAddress() yields its
// EIP-55 checksum, which is what Turnkey must receive.
const LOWER = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const CHECKSUMMED = getAddress(LOWER);

function baseParams() {
  return {
    subOrgId: "sub-org-test",
    walletAddress: LOWER,
    chainId: SEPOLIA,
    to: "0x000000000000000000000000000000000000dead",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("submitTurnkeySponsoredTransaction", () => {
  it("sends the EIP-55 checksummed `from` to Turnkey (not the lowercase DB value)", async () => {
    mockEthSend.mockResolvedValue({ sendTransactionStatusId: "sid-1" });
    mockGetStatus.mockResolvedValue({
      txStatus: "INCLUDED",
      eth: { txHash: "0xhash1" },
    });

    await submitTurnkeySponsoredTransaction(baseParams());

    expect(mockEthSend).toHaveBeenCalledWith(
      expect.objectContaining({ from: CHECKSUMMED, sponsor: true })
    );
    expect(CHECKSUMMED).not.toBe(LOWER);
  });

  it("returns the tx hash once Turnkey reports INCLUDED", async () => {
    mockEthSend.mockResolvedValue({ sendTransactionStatusId: "sid-2" });
    mockGetStatus.mockResolvedValue({
      txStatus: "INCLUDED",
      eth: { txHash: "0xhash2" },
    });

    const result = await submitTurnkeySponsoredTransaction(baseParams());

    expect(result).toEqual({
      txHash: "0xhash2",
      sendTransactionStatusId: "sid-2",
    });
  });

  it("throws SponsoredTxRevertError on a post-broadcast revert (FAILED + hash)", async () => {
    mockEthSend.mockResolvedValue({ sendTransactionStatusId: "sid-3" });
    mockGetStatus.mockResolvedValue({
      txStatus: "FAILED",
      txError: "execution reverted",
      eth: { txHash: "0xrevert" },
      error: { eth: { revertChain: [] } },
    });

    await expect(
      submitTurnkeySponsoredTransaction(baseParams())
    ).rejects.toBeInstanceOf(SponsoredTxRevertError);
  });

  it("returns null on a pre-broadcast failure (FAILED, no hash) so the caller falls back", async () => {
    mockEthSend.mockResolvedValue({ sendTransactionStatusId: "sid-4" });
    mockGetStatus.mockResolvedValue({ txStatus: "FAILED", eth: {} });

    const result = await submitTurnkeySponsoredTransaction(baseParams());

    expect(result).toBeNull();
  });

  it("returns null when ethSendTransaction rejects", async () => {
    mockEthSend.mockRejectedValue(
      new Error("Turnkey error 5: Could not find any resource to sign with")
    );

    const result = await submitTurnkeySponsoredTransaction(baseParams());

    expect(result).toBeNull();
  });

  it("returns the hash as soon as Turnkey assigns one, before a terminal-success status", async () => {
    mockEthSend.mockResolvedValue({ sendTransactionStatusId: "sid-5" });
    // Non-terminal status, but Turnkey already has a tx hash -> the send is
    // broadcast and we own it, so we must return it (not keep polling / re-send).
    mockGetStatus.mockResolvedValue({
      txStatus: "BROADCASTING",
      eth: { txHash: "0xbroadcasting" },
    });

    const result = await submitTurnkeySponsoredTransaction(
      baseParams(),
      FAST_POLL
    );

    expect(result).toEqual({
      txHash: "0xbroadcasting",
      sendTransactionStatusId: "sid-5",
    });
  });

  it("throws SponsoredTxPendingError when the wait elapses without a terminal status", async () => {
    mockEthSend.mockResolvedValue({ sendTransactionStatusId: "sid-6" });
    // Stuck before broadcast: accepted, but never a hash or terminal status.
    mockGetStatus.mockResolvedValue({ txStatus: "INITIALIZED", eth: {} });

    await expect(
      submitTurnkeySponsoredTransaction(baseParams(), FAST_POLL)
    ).rejects.toBeInstanceOf(SponsoredTxPendingError);
  });

  it("throws SponsoredTxPendingError after repeated status-API failures instead of returning null", async () => {
    mockEthSend.mockResolvedValue({ sendTransactionStatusId: "sid-7" });
    mockGetStatus.mockRejectedValue(new Error("Turnkey status API 503"));

    await expect(
      submitTurnkeySponsoredTransaction(baseParams(), FAST_POLL)
    ).rejects.toBeInstanceOf(SponsoredTxPendingError);
  });
});
