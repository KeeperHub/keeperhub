import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  createTurnkeyWallet,
  fetchOrCreateSolanaWalletAddress,
} from "@/lib/turnkey/turnkey-operations";

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
  let mockApiClient: typeof mockApiClientInstance;
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
    process.env.SOLANA_WALLET_PROVISIONING_ENABLED = "true";

    mockApiClient = mockApiClientInstance;
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
    mockApiClient.createSubOrganization.mockRejectedValueOnce(
      new Error("Multi-account creation failed")
    );

    mockApiClient.getSubOrgIds.mockResolvedValue({ organizationIds: [] });

    mockApiClient.createSubOrganization.mockResolvedValueOnce({
      subOrganizationId: "mock-sub-org-id",
      wallet: {
        walletId: "mock-wallet-id",
        addresses: ["evm-address-1"],
      },
    });

    mockApiClient.getWalletAccounts
      .mockResolvedValueOnce({
        accounts: [
          {
            address: "evm-address-1",
            addressFormat: "ADDRESS_FORMAT_ETHEREUM",
          },
        ],
      })
      .mockResolvedValueOnce({
        accounts: [
          {
            address: "evm-address-1",
            addressFormat: "ADDRESS_FORMAT_ETHEREUM",
          },
          {
            address: "sol-address-fallback",
            addressFormat: "ADDRESS_FORMAT_SOLANA",
          },
        ],
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
    mockApiClient.createSubOrganization.mockRejectedValueOnce(
      new Error("Network timeout after sub-org created")
    );

    mockApiClient.getSubOrgIds.mockResolvedValue({
      organizationIds: ["existing-sub-org-id"],
    });
    mockApiClient.getWallets.mockResolvedValue({
      wallets: [{ walletId: "existing-wallet-id" }],
    });

    mockApiClient.getWalletAccounts
      .mockResolvedValueOnce({
        accounts: [
          {
            address: "evm-address-recovered",
            addressFormat: "ADDRESS_FORMAT_ETHEREUM",
          },
        ],
      })
      .mockResolvedValueOnce({
        accounts: [
          {
            address: "evm-address-recovered",
            addressFormat: "ADDRESS_FORMAT_ETHEREUM",
          },
          {
            address: "sol-address-recovered",
            addressFormat: "ADDRESS_FORMAT_SOLANA",
          },
        ],
      })
      .mockResolvedValueOnce({
        accounts: [
          {
            address: "evm-address-recovered",
            addressFormat: "ADDRESS_FORMAT_ETHEREUM",
          },
          {
            address: "sol-address-recovered",
            addressFormat: "ADDRESS_FORMAT_SOLANA",
          },
        ],
      });

    mockApiClient.createWalletAccounts.mockResolvedValue({
      addresses: ["sol-address-recovered"],
    });

    const result = await createTurnkeyWallet("test@keeperhub.com", "test-org");

    expect(result).toEqual({
      subOrgId: "existing-sub-org-id",
      walletId: "existing-wallet-id",
      privateKeyId: "",
      walletAddress: "evm-address-recovered",
      solanaAddress: "sol-address-recovered",
    });

    expect(mockApiClient.createSubOrganization).toHaveBeenCalledTimes(1);
    expect(logSystemError).toHaveBeenCalledWith(
      ErrorCategory.EXTERNAL_SERVICE,
      expect.stringContaining("Reconciled existing sub-org by name"),
      undefined,
      expect.any(Object)
    );
  });

  it("reuses an existing Solana account on reconcile without createWalletAccounts", async () => {
    mockApiClient.createSubOrganization.mockRejectedValueOnce(
      new Error("Network timeout after sub-org created")
    );

    mockApiClient.getSubOrgIds.mockResolvedValue({
      organizationIds: ["existing-sub-org-id"],
    });
    mockApiClient.getWallets.mockResolvedValue({
      wallets: [{ walletId: "existing-wallet-id" }],
    });

    mockApiClient.getWalletAccounts.mockResolvedValue({
      accounts: [
        {
          address: "evm-address-recovered",
          addressFormat: "ADDRESS_FORMAT_ETHEREUM",
        },
        {
          address: "sol-address-existing",
          addressFormat: "ADDRESS_FORMAT_SOLANA",
        },
      ],
    });

    const result = await createTurnkeyWallet("test@keeperhub.com", "test-org");

    expect(result.solanaAddress).toBe("sol-address-existing");
    expect(mockApiClient.createWalletAccounts).not.toHaveBeenCalled();
  });

  it("provisions EVM-only and no Solana account when the gate is disabled", async () => {
    delete process.env.SOLANA_WALLET_PROVISIONING_ENABLED;

    mockApiClient.createSubOrganization.mockResolvedValue({
      subOrganizationId: "mock-sub-org-id",
      wallet: {
        walletId: "mock-wallet-id",
        addresses: ["evm-address-1"],
      },
    });
    mockApiClient.getWalletAccounts.mockResolvedValue({
      accounts: [
        {
          address: "evm-address-1",
          addressFormat: "ADDRESS_FORMAT_ETHEREUM",
        },
      ],
    });

    const result = await createTurnkeyWallet("test@keeperhub.com", "test-org");

    expect(result.solanaAddress).toBeNull();
    const request = mockApiClient.createSubOrganization.mock.calls[0][0];
    expect(request.wallet.accounts).toHaveLength(1);
    expect(request.wallet.accounts[0].addressFormat).toBe(
      "ADDRESS_FORMAT_ETHEREUM"
    );
    expect(mockApiClient.createWalletAccounts).not.toHaveBeenCalled();
  });
});

describe("turnkey-operations - fetchOrCreateSolanaWalletAddress", () => {
  const SOLANA_ACCOUNT = {
    address: "sol-address",
    addressFormat: "ADDRESS_FORMAT_SOLANA",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClientInstance.getWalletAccounts.mockReset();
    mockApiClientInstance.createWalletAccounts.mockReset();
  });

  it("returns an existing account without creating one", async () => {
    mockApiClientInstance.getWalletAccounts.mockResolvedValue({
      accounts: [SOLANA_ACCOUNT],
    });

    const address = await fetchOrCreateSolanaWalletAddress(
      mockApiClientInstance as never,
      "sub-org",
      "wallet"
    );

    expect(address).toBe("sol-address");
    expect(mockApiClientInstance.createWalletAccounts).not.toHaveBeenCalled();
  });

  it("recovers when a concurrent caller created the account first", async () => {
    // Nothing serialises provisioning, so the loser of the race sees an empty
    // read, then a create that fails because the account already exists. The
    // derivation path is fixed, so the winner's address is the same one this
    // caller would have produced - failing here would fail a step that has a
    // perfectly usable address.
    mockApiClientInstance.getWalletAccounts
      .mockResolvedValueOnce({ accounts: [] })
      .mockResolvedValueOnce({ accounts: [SOLANA_ACCOUNT] });
    mockApiClientInstance.createWalletAccounts.mockRejectedValue(
      new Error("wallet account already exists at path m/44'/501'/0'/0'")
    );

    const address = await fetchOrCreateSolanaWalletAddress(
      mockApiClientInstance as never,
      "sub-org",
      "wallet"
    );

    expect(address).toBe("sol-address");
  });

  it("surfaces the create failure when no account exists afterwards", async () => {
    mockApiClientInstance.getWalletAccounts.mockResolvedValue({ accounts: [] });
    mockApiClientInstance.createWalletAccounts.mockRejectedValue(
      new Error("turnkey rejected the request")
    );

    await expect(
      fetchOrCreateSolanaWalletAddress(
        mockApiClientInstance as never,
        "sub-org",
        "wallet"
      )
    ).rejects.toThrow("turnkey rejected the request");
  });

  it("throws when create succeeds but no account comes back", async () => {
    mockApiClientInstance.getWalletAccounts.mockResolvedValue({ accounts: [] });
    mockApiClientInstance.createWalletAccounts.mockResolvedValue({});

    await expect(
      fetchOrCreateSolanaWalletAddress(
        mockApiClientInstance as never,
        "sub-org",
        "wallet"
      )
    ).rejects.toThrow("No Solana address available");
  });
});
