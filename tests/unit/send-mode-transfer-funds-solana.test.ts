import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/web3/wallet-helpers", () => ({
  initializeSolanaWallet: vi.fn(),
  initializeWalletSigner: vi.fn(),
  getOrganizationWalletAddress: vi.fn(),
}));
vi.mock("@/lib/web3/chain-adapter", () => ({ getChainAdapter: vi.fn() }));

import { transferFundsCore } from "@/plugins/web3/steps/transfer-funds-core";

// A templated network can resolve to Solana at run time, where save could not check it.
const SOLANA = {
  network: "101",
  amount: "1.0",
  // Not a Solana address: a step that gets past Send as stops right after it.
  recipientAddress: "not-a-solana-address",
  _context: { organizationId: "org-1" },
};

describe("transferFundsCore on Solana - Send as", () => {
  it("refuses Private relay before the Solana send, as a user error", async () => {
    const result = await transferFundsCore({
      ...SOLANA,
      sendMode: "private-relay",
    });
    expect(result).toMatchObject({
      success: false,
      error:
        'This step is set to Send as: Private relay, but Solana has no private relay. Set Send as to Normal transaction (sendMode: "transaction").',
      errorClass: "user",
    });
  });

  it("refuses an unknown sendMode", async () => {
    const result = await transferFundsCore({ ...SOLANA, sendMode: "Bundle" });
    expect(result).toMatchObject({ success: false, errorClass: "user" });
    expect((result as { error: string }).error).toContain("sendMode must be");
  });

  it("refuses a bundle, which only Write Contract sends", async () => {
    const result = await transferFundsCore({ ...SOLANA, sendMode: "bundle" });
    expect(result).toMatchObject({ success: false, errorClass: "user" });
    expect((result as { error: string }).error).toContain(
      "bundles are only available on Write Contract steps"
    );
  });

  it.each([
    ["Normal", { sendMode: "transaction" }],
    [
      "the old flag alone (public where there is no relay)",
      { usePrivateMempool: true },
    ],
    [
      "Private relay with strict: false",
      { sendMode: "private-relay", strict: false },
    ],
  ])("lets %s through to the Solana send", async (_label, keys) => {
    const result = await transferFundsCore({ ...SOLANA, ...keys });
    expect(result).toMatchObject({
      success: false,
      error: "Invalid Solana recipient address: not-a-solana-address",
    });
  });
});
