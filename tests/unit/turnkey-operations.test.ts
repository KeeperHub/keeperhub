import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { Turnkey } from "@turnkey/sdk-server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { createTurnkeyWallet } from "@/lib/turnkey/turnkey-operations";

const mockApiClientInstance = {
  createSubOrganization: vi.fn(),
  getWalletAccounts: vi.fn(),
  createWalletAccounts: vi.fn(),
  getSubOrgIds: vi.fn(),
  getWallets: vi.fn(),
};

vi.mock("@turnkey/sdk-server", () => {
  class MockTurnkey {
    apiClient() {
      return mockApiClientInstance;
    }
  }
  return {
    Turnkey: MockTurnkey,
  };
});

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    EXTERNAL_SERVICE: "EXTERNAL_SERVICE",
  },
  logSystemError: vi.fn(),
}));

describe("turnkey-operations - createTurnkeyWallet", () => {
  let mockApiClient: any;
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClientInstance.createSubOrganization.mockReset();
    mockApiClientInstance.getWalletAccounts.mockReset();
    mockApiClientInstance.createWalletAccounts.mockReset();
    mockApiClientInstance.getSubOrgIds.mockReset();
    mockApiClientInstance.getWallets.mockReset();

    process.env.TURNKEY_API_PUBLIC_KEY = "mock-public-key";
    process.env.TURNKEY_API_PRIVATE_KEY = "mock-private-key";
    process.env.TURNKEY_ORGANIZATION_ID = "mock-org-id";

    const turnkeyInstance = new Turnkey({} as any);
    mockApiClient = turnkeyInstance.apiClient();
  });

  it("successfully extracts EVM and Solana addresses when multi-account succeeds", async () => {
    mockApiClient.createSubOrganization.mockResolvedValue({
      subOrganizationId: "mock-sub-org-id",
      wallet: {
        walletId: "mock-wallet-id",
        addresses: ["evm-address-1", "sol-address-1"],
      },
    });

    mockApiClient.getWalletAccounts.mockResolvedValue({
      accounts: [
        {
          address: "evm-address-1",
          addressFormat: "ADDRESS_FORMAT_ETHEREUM",
        },
        {
          address: "sol-address-1",
          addressFormat: "ADDRESS_FORMAT_SOLANA",
        },
      ],
    });

    const result = await createTurnkeyWallet("test@keeperhub.com", "test-org");

    expect(result).toEqual({
      subOrgId: "mock-sub-org-id",
      walletId: "mock-wallet-id",
      privateKeyId: "",
      walletAddress: "evm-address-1",
      solanaAddress: "sol-address-1",
    });

    expect(mockApiClient.createSubOrganization).toHaveBeenCalled();
    expect(mockApiClient.getWalletAccounts).toHaveBeenCalledWith({
      organizationId: "mock-sub-org-id",
      walletId: "mock-wallet-id",
    });
  });

  it("falls back to EVM-only creation when multi-account throws and no existing sub-org found", async () => {
    // Force first attempt to throw
    mockApiClient.createSubOrganization.mockRejectedValueOnce(
      new Error("Multi-account creation failed")
    );

    // B5: getSubOrgIds returns no match — proceed with new sub-org creation
    mockApiClient.getSubOrgIds.mockResolvedValue({ organizationIds: [] });

    // Fallback EVM-only sub-org creation succeeds
    mockApiClient.createSubOrganization.mockResolvedValueOnce({
      subOrganizationId: "mock-sub-org-id",
      wallet: {
        walletId: "mock-wallet-id",
        addresses: ["evm-address-1"],
      },
    });

    mockApiClient.createWalletAccounts.mockResolvedValue({
      addresses: ["sol-address-fallback"],
    });

    const result = await createTurnkeyWallet("test@keeperhub.com", "test-org");

    expect(result).toEqual({
      subOrgId: "mock-sub-org-id",
      walletId: "mock-wallet-id",
      privateKeyId: "",
      walletAddress: "evm-address-1",
      solanaAddress: "sol-address-fallback",
    });

    expect(mockApiClient.createSubOrganization).toHaveBeenCalledTimes(2);
    expect(mockApiClient.getSubOrgIds).toHaveBeenCalledWith({
      organizationId: "mock-org-id",
      filterType: "NAME",
      filterValue: "keeperhub-test-org",
    });
    expect(mockApiClient.createWalletAccounts).toHaveBeenCalledWith({
      organizationId: "mock-sub-org-id",
      walletId: "mock-wallet-id",
      accounts: [
        {
          curve: "CURVE_ED25519",
          pathFormat: "PATH_FORMAT_BIP32",
          path: "m/44'/501'/0'/0'",
          addressFormat: "ADDRESS_FORMAT_SOLANA",
        },
      ],
    });
    expect(logSystemError).toHaveBeenCalledWith(
      ErrorCategory.EXTERNAL_SERVICE,
      expect.stringContaining("Two-account sub-org creation failed"),
      expect.any(Error),
      expect.any(Object)
    );
  });

  it("reconciles existing sub-org by name when primary partially succeeded server-side (B5)", async () => {
    // Primary throws before subOrgId is captured locally
    mockApiClient.createSubOrganization.mockRejectedValueOnce(
      new Error("Network timeout after sub-org created")
    );

    // B5: getSubOrgIds finds an existing sub-org with our name
    mockApiClient.getSubOrgIds.mockResolvedValue({
      organizationIds: ["existing-sub-org-id"],
    });
    mockApiClient.getWallets.mockResolvedValue({
      wallets: [{ walletId: "existing-wallet-id" }],
    });

    // Adding Solana account to the recovered sub-org
    mockApiClient.createWalletAccounts.mockResolvedValue({
      addresses: ["sol-address-recovered"],
    });

    // getWalletAccounts for EVM address lookup on the reconciled sub-org
    mockApiClient.getWalletAccounts.mockResolvedValue({
      accounts: [
        {
          address: "evm-address-recovered",
          addressFormat: "ADDRESS_FORMAT_ETHEREUM",
        },
      ],
    });

    const result = await createTurnkeyWallet("test@keeperhub.com", "test-org");

    expect(result).toEqual({
      subOrgId: "existing-sub-org-id",
      walletId: "existing-wallet-id",
      privateKeyId: "",
      walletAddress: "evm-address-recovered",
      solanaAddress: "sol-address-recovered",
    });

    // Must NOT have created a new sub-org after reconciliation
    expect(mockApiClient.createSubOrganization).toHaveBeenCalledTimes(1);
    expect(mockApiClient.getSubOrgIds).toHaveBeenCalledWith({
      organizationId: "mock-org-id",
      filterType: "NAME",
      filterValue: "keeperhub-test-org",
    });
    expect(logSystemError).toHaveBeenCalledWith(
      ErrorCategory.EXTERNAL_SERVICE,
      expect.stringContaining("Reconciled existing sub-org by name"),
      undefined,
      expect.any(Object)
    );
  });
});
