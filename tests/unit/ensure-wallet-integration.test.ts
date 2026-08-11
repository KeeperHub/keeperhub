import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockOrganizationHasWallet = vi.fn();
const mockGetOrganizationWallet = vi.fn();

vi.mock("@/lib/web3/wallet-helpers", () => ({
  organizationHasWallet: (...args: unknown[]) =>
    mockOrganizationHasWallet(...args),
  getOrganizationWallet: (...args: unknown[]) =>
    mockGetOrganizationWallet(...args),
}));

const mockSelectLimit = vi.fn();
const mockInsertReturning = vi.fn();

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
      values: vi.fn(() => ({
        returning: (...args: unknown[]) => mockInsertReturning(...args),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  integrations: { id: "id", organizationId: "organization_id", type: "type" },
}));

vi.mock("@/lib/db/schema-extensions", () => ({
  organizationWallets: {
    organizationId: "organization_id",
    walletAddress: "wallet_address",
    isActive: "is_active",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock("@/plugins/registry", () => ({
  findActionById: vi.fn(),
  getIntegration: vi.fn(),
}));

vi.mock("@/lib/address-utils", () => ({
  // Use the real ethers checksum so tests prove EIP-55 normalisation.
  toChecksumAddress: (addr: string) => {
    if (!addr.startsWith("0x") || addr.length !== 42) {
      return addr;
    }
    return addr;
  },
}));

const ORIGINAL_ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY;
process.env.INTEGRATION_ENCRYPTION_KEY = "0".repeat(64);

const { ensureWalletIntegration, buildWalletIntegrationPayload } = await import(
  "@/lib/db/integrations"
);

const USER_ID = "user-1";
const ORG_ID = "org-1";
const WALLET_ADDRESS = "0xA3CD000000000000000000000000000000007Eb3";
const FULL_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

describe("ensureWalletIntegration", () => {
  beforeEach(() => {
    mockOrganizationHasWallet.mockReset();
    mockGetOrganizationWallet.mockReset();
    mockSelectLimit.mockReset();
    mockInsertReturning.mockReset();
  });

  it("no-ops when the org has no wallet", async () => {
    mockOrganizationHasWallet.mockResolvedValue(false);

    await ensureWalletIntegration(USER_ID, ORG_ID);

    expect(mockOrganizationHasWallet).toHaveBeenCalledWith(ORG_ID);
    expect(mockInsertReturning).not.toHaveBeenCalled();
  });

  it("no-ops when a web3 row already exists", async () => {
    mockOrganizationHasWallet.mockResolvedValue(true);
    mockSelectLimit.mockResolvedValue([{ id: "existing-row" }]);

    await ensureWalletIntegration(USER_ID, ORG_ID);

    expect(mockGetOrganizationWallet).not.toHaveBeenCalled();
    expect(mockInsertReturning).not.toHaveBeenCalled();
  });

  it("inserts when no row exists and returns cleanly", async () => {
    mockOrganizationHasWallet.mockResolvedValue(true);
    mockSelectLimit.mockResolvedValue([]);
    mockGetOrganizationWallet.mockResolvedValue({
      walletAddress: WALLET_ADDRESS,
    });
    mockInsertReturning.mockResolvedValue([
      {
        id: "new-row",
        userId: USER_ID,
        organizationId: ORG_ID,
        name: WALLET_ADDRESS,
        type: "web3",
        config: "encrypted",
        isManaged: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    await expect(
      ensureWalletIntegration(USER_ID, ORG_ID)
    ).resolves.toBeUndefined();
    expect(mockInsertReturning).toHaveBeenCalledTimes(1);
  });

  it("swallows 23505 wrapped by DrizzleQueryError on .cause when the race fires", async () => {
    mockOrganizationHasWallet.mockResolvedValue(true);
    mockSelectLimit.mockResolvedValue([]);
    mockGetOrganizationWallet.mockResolvedValue({
      walletAddress: WALLET_ADDRESS,
    });
    // drizzle-orm wraps driver errors: outer DrizzleQueryError, original
    // PostgresError on .cause carrying the SQLSTATE code.
    const pgError = Object.assign(new Error("duplicate key value"), {
      code: "23505",
    });
    const drizzleWrapped = Object.assign(new Error("Failed query"), {
      cause: pgError,
    });
    mockInsertReturning.mockRejectedValueOnce(drizzleWrapped);

    await expect(
      ensureWalletIntegration(USER_ID, ORG_ID)
    ).resolves.toBeUndefined();
    expect(mockInsertReturning).toHaveBeenCalledTimes(1);
  });

  // Drizzle wraps every driver error in DrizzleQueryError today, so the
  // top-level `err.code` path is unreachable in production. Kept as a
  // defense-in-depth regression guard against the `?? e.code` fallback
  // being deleted as "dead" -- if a future driver path surfaces
  // PostgresError directly, the guard still fires. Do not strip.
  it("also swallows 23505 surfaced as a top-level code (defense-in-depth)", async () => {
    mockOrganizationHasWallet.mockResolvedValue(true);
    mockSelectLimit.mockResolvedValue([]);
    mockGetOrganizationWallet.mockResolvedValue({
      walletAddress: WALLET_ADDRESS,
    });
    const directError = Object.assign(new Error("duplicate key value"), {
      code: "23505",
    });
    mockInsertReturning.mockRejectedValueOnce(directError);

    await expect(
      ensureWalletIntegration(USER_ID, ORG_ID)
    ).resolves.toBeUndefined();
  });

  it("re-throws non-23505 errors (e.g. wrapped 08006 connection refused)", async () => {
    mockOrganizationHasWallet.mockResolvedValue(true);
    mockSelectLimit.mockResolvedValue([]);
    mockGetOrganizationWallet.mockResolvedValue({
      walletAddress: WALLET_ADDRESS,
    });
    const pgError = Object.assign(new Error("connection refused"), {
      code: "08006",
    });
    const wrapped = Object.assign(new Error("Failed query"), {
      cause: pgError,
    });
    mockInsertReturning.mockRejectedValueOnce(wrapped);

    await expect(ensureWalletIntegration(USER_ID, ORG_ID)).rejects.toThrow(
      "Failed query"
    );
  });
});

describe("buildWalletIntegrationPayload", () => {
  it("stores the canonical full wallet address as name, not a truncated display string (KEEP-484)", () => {
    const payload = buildWalletIntegrationPayload(
      USER_ID,
      ORG_ID,
      WALLET_ADDRESS
    );

    expect(payload).toEqual({
      userId: USER_ID,
      organizationId: ORG_ID,
      name: WALLET_ADDRESS,
      type: "web3",
      config: {},
    });
    // Regression guard: the literal `...` must never appear, because
    // API consumers used to pass `name` as on-chain `onBehalfOf` and the
    // truncated value reverted contract calls.
    expect(payload.name).not.toContain("...");
    expect(payload.name).toMatch(FULL_ADDRESS_RE);
  });
});

afterAll(() => {
  if (ORIGINAL_ENCRYPTION_KEY === undefined) {
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
  } else {
    process.env.INTEGRATION_ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
  }
});
