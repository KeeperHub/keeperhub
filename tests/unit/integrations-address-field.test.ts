import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/web3/wallet-helpers", () => ({
  organizationHasWallet: vi.fn(),
  getOrganizationWallet: vi.fn(),
}));

vi.mock("@/plugins/registry", () => ({
  findActionById: vi.fn(),
  getIntegration: vi.fn(),
}));

vi.mock("@/lib/address-utils", () => ({
  toChecksumAddress: (addr: string) => addr,
}));

vi.mock("@/lib/db/schema", () => ({
  integrations: {
    id: "id",
    userId: "user_id",
    organizationId: "organization_id",
    name: "name",
    type: "type",
    config: "config",
    isManaged: "is_managed",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
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

const mockJoinWhere = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: (...args: unknown[]) => ({
            orderBy: () => mockJoinWhere(...args),
          }),
        })),
      })),
    })),
  },
}));

const ORIGINAL_ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY;
process.env.INTEGRATION_ENCRYPTION_KEY = "0".repeat(64);

const { getIntegrations } = await import("@/lib/db/integrations");

const USER_ID = "user-1";
const ORG_ID = "org-1";
const WALLET_ADDRESS = "0xA3CD000000000000000000000000000000007Eb3";
const FULL_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// `decryptConfig` swallows any decrypt/parse error and returns `{}`, so we
// can pass any non-empty string here. This keeps the test free of crypto
// machinery and avoids re-importing the SUT for its `encrypt` helper.
const EMPTY_CONFIG_PLACEHOLDER = "not-real-ciphertext";

describe("getIntegrations address field (KEEP-484)", () => {
  beforeEach(() => {
    mockJoinWhere.mockReset();
  });

  it("returns checksummed wallet address for web3 rows", async () => {
    mockJoinWhere.mockResolvedValueOnce([
      {
        id: "i-1",
        userId: USER_ID,
        organizationId: ORG_ID,
        name: WALLET_ADDRESS,
        type: "web3",
        config: EMPTY_CONFIG_PLACEHOLDER,
        isManaged: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        walletAddress: WALLET_ADDRESS,
      },
    ]);

    const result = await getIntegrations(USER_ID, undefined, ORG_ID);

    expect(result).toHaveLength(1);
    expect(result[0].address).toBe(WALLET_ADDRESS);
    expect(result[0].address).not.toContain("...");
    expect(result[0].address).toMatch(FULL_ADDRESS_RE);
    expect(result[0].name).toBe(WALLET_ADDRESS);
    expect(result[0].name).not.toContain("...");
  });

  it("returns null address for non-web3 integrations", async () => {
    mockJoinWhere.mockResolvedValueOnce([
      {
        id: "i-2",
        userId: USER_ID,
        organizationId: ORG_ID,
        name: "My Discord",
        type: "discord",
        config: EMPTY_CONFIG_PLACEHOLDER,
        isManaged: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        walletAddress: null,
      },
    ]);

    const result = await getIntegrations(USER_ID, undefined, ORG_ID);

    expect(result[0].address).toBeNull();
  });

  it("returns null address for web3 rows with no active wallet", async () => {
    mockJoinWhere.mockResolvedValueOnce([
      {
        id: "i-3",
        userId: USER_ID,
        organizationId: ORG_ID,
        name: "orphan-web3",
        type: "web3",
        config: EMPTY_CONFIG_PLACEHOLDER,
        isManaged: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        walletAddress: null,
      },
    ]);

    const result = await getIntegrations(USER_ID, undefined, ORG_ID);

    expect(result[0].address).toBeNull();
  });
});

afterAll(() => {
  if (ORIGINAL_ENCRYPTION_KEY === undefined) {
    process.env.INTEGRATION_ENCRYPTION_KEY = undefined;
  } else {
    process.env.INTEGRATION_ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
  }
});
