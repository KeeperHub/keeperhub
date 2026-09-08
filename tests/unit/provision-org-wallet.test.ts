import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockCreateTurnkeyWallet = vi.fn();
vi.mock("@/lib/turnkey/turnkey-client", () => ({
  createTurnkeyWallet: (...args: unknown[]) => mockCreateTurnkeyWallet(...args),
}));

const mockSelectLimit = vi.fn();
const mockInsertValues = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: (...args: unknown[]) => mockSelectLimit(...args),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: (...args: unknown[]) => mockInsertValues(...args),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  organizationWallets: {
    organizationId: "organization_id",
    isActive: "is_active",
  },
}));

vi.mock("@/lib/address-utils", () => ({
  normalizeAddressForStorage: (address: string) => address,
}));

const mockCreateIntegration = vi.fn();
vi.mock("@/lib/db/integrations", () => ({
  createIntegration: (...args: unknown[]) => mockCreateIntegration(...args),
  buildWalletIntegrationPayload: (
    userId: string,
    organizationId: string,
    walletAddress: string
  ) => ({ userId, organizationId, walletAddress }),
}));

const mockRecordWalletInAddressBook = vi.fn();
vi.mock("@/lib/address-book/record-wallet", () => ({
  recordWalletInAddressBook: (...args: unknown[]) =>
    mockRecordWalletInAddressBook(...args),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { EXTERNAL_SERVICE: "EXTERNAL_SERVICE" },
  logSystemError: vi.fn(),
}));

import { provisionOrganizationWallet } from "@/lib/turnkey/provision-org-wallet";

const INPUT = {
  userId: "user-1",
  organizationId: "org-12345678",
  email: "user@example.com",
};

const TURNKEY_RESULT = {
  subOrgId: "tk-sub-org",
  walletId: "tk-wallet",
  privateKeyId: "",
  walletAddress: "0x00000000000000000000000000000000000000aa",
  solanaAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

function existingRow(): Record<string, unknown> {
  return {
    id: "wallet-existing",
    walletAddress: "0x00000000000000000000000000000000000000bb",
    solanaAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    turnkeyWalletId: "tk-wallet-existing",
    turnkeySubOrgId: "tk-sub-org-existing",
    isActive: true,
  };
}

function uniqueViolation(): Error {
  const err = new Error("duplicate key value violates unique constraint");
  (err as Error & { cause: unknown }).cause = { code: "23505" };
  return err;
}

describe("provisionOrganizationWallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectLimit.mockReset();
    mockInsertValues.mockReset();
  });

  it("is a no-op when an active wallet already exists", async () => {
    mockSelectLimit.mockResolvedValueOnce([existingRow()]);

    const result = await provisionOrganizationWallet(INPUT);

    expect(result.created).toBe(false);
    expect(result.walletAddress).toBe(existingRow().walletAddress);
    expect(mockCreateTurnkeyWallet).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("creates the wallet, integration, and address-book entry on the happy path", async () => {
    mockSelectLimit.mockResolvedValueOnce([]);
    mockCreateTurnkeyWallet.mockResolvedValueOnce(TURNKEY_RESULT);
    mockInsertValues.mockResolvedValueOnce(undefined);

    const result = await provisionOrganizationWallet(INPUT);

    expect(result).toEqual({
      created: true,
      walletAddress: TURNKEY_RESULT.walletAddress,
      solanaAddress: TURNKEY_RESULT.solanaAddress,
      walletId: TURNKEY_RESULT.walletId,
      subOrgId: TURNKEY_RESULT.subOrgId,
    });
    expect(mockCreateTurnkeyWallet).toHaveBeenCalledWith(
      INPUT.email,
      `org-${INPUT.organizationId.slice(0, 8)}`
    );
    expect(mockCreateIntegration).toHaveBeenCalledTimes(1);
    expect(mockRecordWalletInAddressBook).toHaveBeenCalledTimes(1);
  });

  it("treats a unique-constraint race as already provisioned", async () => {
    mockSelectLimit
      .mockResolvedValueOnce([]) // initial check: no wallet
      .mockResolvedValueOnce([existingRow()]); // re-read after the race
    mockCreateTurnkeyWallet.mockResolvedValueOnce(TURNKEY_RESULT);
    mockInsertValues.mockRejectedValueOnce(uniqueViolation());

    const result = await provisionOrganizationWallet(INPUT);

    expect(result.created).toBe(false);
    expect(result.walletAddress).toBe(existingRow().walletAddress);
    // We lost the race, so we must not write the integration/address book.
    expect(mockCreateIntegration).not.toHaveBeenCalled();
    expect(mockRecordWalletInAddressBook).not.toHaveBeenCalled();
  });

  it("rethrows a non-unique insert error", async () => {
    mockSelectLimit.mockResolvedValueOnce([]);
    mockCreateTurnkeyWallet.mockResolvedValueOnce(TURNKEY_RESULT);
    mockInsertValues.mockRejectedValueOnce(new Error("connection reset"));

    await expect(provisionOrganizationWallet(INPUT)).rejects.toThrow(
      "connection reset"
    );
  });
});
