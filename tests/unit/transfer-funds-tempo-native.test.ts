import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/web3/wallet-helpers", () => ({
  initializeSolanaWallet: vi.fn(),
  initializeWalletSigner: vi.fn(),
  getOrganizationWalletAddress: vi.fn(),
}));

vi.mock("@/lib/web3/chain-adapter", () => ({ getChainAdapter: vi.fn() }));

vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: vi.fn(),
}));

import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import { transferFundsCore } from "@/plugins/web3/steps/transfer-funds-core";

const RECIPIENT = "0x1111111111111111111111111111111111111111";

async function nativeTransfer(
  network: string
): ReturnType<typeof transferFundsCore> {
  return await transferFundsCore({
    network,
    amount: "1.0",
    recipientAddress: RECIPIENT,
    _context: { organizationId: "org-1" },
  });
}

describe("transferFundsCore - Tempo native transfer guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A chain other than Tempo that passes the guard fails here, giving us a
    // distinct marker to prove the guard did not fire.
    vi.mocked(resolveOrganizationContext).mockResolvedValue({
      success: false,
      error: "no org in test",
    });
  });

  it("rejects a native transfer on Tempo testnet with a clear TIP-20 message", async () => {
    const result = await nativeTransfer("42431");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Tempo has no native token");
      expect(result.error).toContain("TIP-20");
    }
    // The guard returns before org resolution runs.
    expect(resolveOrganizationContext).not.toHaveBeenCalled();
  });

  it("rejects a native transfer on Tempo mainnet too", async () => {
    const result = await nativeTransfer("4217");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Tempo has no native token");
    }
  });

  it("does not fire the guard on an EVM chain that is not Tempo", async () => {
    const result = await nativeTransfer("8453");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).not.toContain("Tempo has no native token");
      expect(result.error).toBe("no org in test");
    }
    expect(resolveOrganizationContext).toHaveBeenCalledTimes(1);
  });
});
