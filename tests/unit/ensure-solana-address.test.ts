import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockFetchOrCreate = vi.fn();
const mockGetApiClient = vi.fn();

vi.mock("@/lib/turnkey/turnkey-operations", () => ({
  fetchOrCreateSolanaWalletAddress: (...args: unknown[]) =>
    mockFetchOrCreate(...args),
  getTurnkeyApiClient: () => mockGetApiClient(),
}));

const mockUpdate = vi.fn();
const mockSet = vi.fn(() => ({ where: mockUpdate }));
vi.mock("@/lib/db", () => ({
  db: {
    update: vi.fn(() => ({ set: mockSet })),
  },
}));

import type { OrganizationWallet } from "@/lib/db/schema";
import { ensureOrganizationSolanaAddress } from "@/lib/turnkey/ensure-solana-address";

const baseWallet: OrganizationWallet = {
  id: "wallet_1",
  organizationId: "org_1",
  userId: "user_1",
  email: "test@example.com",
  walletAddress: "0xabc",
  solanaAddress: null,
  turnkeySubOrgId: "sub_org_1",
  turnkeyWalletId: "wallet_turnkey_1",
  turnkeyPrivateKeyId: "",
  isActive: true,
  createdAt: new Date(),
};

describe("ensureOrganizationSolanaAddress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SOLANA_WALLET_PROVISIONING_ENABLED = "true";
    mockGetApiClient.mockReturnValue({ mocked: true });
    mockUpdate.mockResolvedValue(undefined);
  });

  it("returns an existing address without calling Turnkey", async () => {
    const wallet = {
      ...baseWallet,
      solanaAddress: "ExistingSolAddress1111111111111111111111111",
    };

    const result = await ensureOrganizationSolanaAddress(wallet);

    expect(result).toBe("ExistingSolAddress1111111111111111111111111");
    expect(mockFetchOrCreate).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("creates, persists, and returns a Solana address when missing", async () => {
    mockFetchOrCreate.mockResolvedValue(
      "NewSolAddress1111111111111111111111111111"
    );

    const result = await ensureOrganizationSolanaAddress(baseWallet);

    expect(result).toBe("NewSolAddress1111111111111111111111111111");
    expect(mockFetchOrCreate).toHaveBeenCalledWith(
      { mocked: true },
      "sub_org_1",
      "wallet_turnkey_1"
    );
    expect(mockSet).toHaveBeenCalledWith({
      solanaAddress: "NewSolAddress1111111111111111111111111111",
    });
    expect(mockUpdate).toHaveBeenCalledOnce();
  });

  it("throws when provisioning is disabled", async () => {
    delete process.env.SOLANA_WALLET_PROVISIONING_ENABLED;

    await expect(ensureOrganizationSolanaAddress(baseWallet)).rejects.toThrow(
      /SOLANA_WALLET_PROVISIONING_ENABLED/
    );
    expect(mockFetchOrCreate).not.toHaveBeenCalled();
  });

  it("throws when Turnkey IDs are missing", async () => {
    await expect(
      ensureOrganizationSolanaAddress({
        ...baseWallet,
        turnkeySubOrgId: null,
      })
    ).rejects.toThrow(/missing sub-organization or wallet ID/);
  });
});
