import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/web3/wallet-helpers", () => ({
  initializeSolanaWallet: vi.fn(),
  initializeWalletSigner: vi.fn(),
  getOrganizationWalletAddress: vi.fn(),
}));
vi.mock("@/lib/web3/chain-adapter", () => ({ getChainAdapter: vi.fn() }));
vi.mock("@/lib/web3/resolve-org-context", () => ({
  resolveOrganizationContext: vi.fn().mockResolvedValue({
    success: true,
    organizationId: "org-1",
    userId: "u1",
  }),
}));
vi.mock("@/lib/rpc/provider-factory", async () => {
  const { PrivateRelayUnavailableError } = await import(
    "@/lib/rpc/providers/transport-error"
  );
  return {
    isSolanaChain: () => false,
    // Stops the step at the RPC lookup, as a chain without a relay does.
    getRpcProvider: vi
      .fn()
      .mockRejectedValue(new PrivateRelayUnavailableError("no relay")),
  };
});

import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { transferFundsCore } from "@/plugins/web3/steps/transfer-funds-core";

describe("transferFundsCore - Send as", () => {
  beforeEach(() => {
    vi.mocked(getRpcProvider).mockClear();
  });

  it("sendMode alone selects the relay, and a missing relay is a user error", async () => {
    const result = await transferFundsCore({
      network: "1",
      amount: "1.0",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      sendMode: "private-relay",
      _context: { organizationId: "org-1" },
    });

    expect(vi.mocked(getRpcProvider).mock.calls[0]?.[0]).toMatchObject({
      usePrivateMempool: true,
    });
    expect(result).toMatchObject({
      success: false,
      error: "no relay",
      errorClass: "user",
    });
  });

  it("asks for the relay only where there is one for an old non-boolean flag", async () => {
    await transferFundsCore({
      network: "1",
      amount: "1.0",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      usePrivateMempool: "false" as unknown as boolean,
      _context: { organizationId: "org-1" },
    });
    expect(vi.mocked(getRpcProvider).mock.calls[0]?.[0]).toMatchObject({
      usePrivateMempool: true,
      relayOptional: true,
    });
  });

  it("refuses an unknown sendMode as a user error before any RPC", async () => {
    const result = await transferFundsCore({
      network: "1",
      amount: "1.0",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      sendMode: "PRIVATE-RELAY",
      _context: { organizationId: "org-1" },
    });
    expect(result).toMatchObject({ success: false, errorClass: "user" });
    expect(vi.mocked(getRpcProvider)).not.toHaveBeenCalled();
  });
});
