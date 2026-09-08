import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks must be declared before importing the file under test.

vi.mock("server-only", () => ({}));

const mockLimit = vi.fn();
const mockWhere = vi.fn(() => ({ limit: mockLimit }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => mockSelect(),
  },
}));

vi.mock("@/lib/db/schema-extensions", () => ({
  organizationWallets: {
    walletAddress: "walletAddress",
    turnkeySubOrgId: "turnkeySubOrgId",
    organizationId: "organizationId",
    isActive: "isActive",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
}));

const mockIsSponsorshipSupported = vi.fn();
vi.mock("@/lib/web3/turnkey-sponsorship-config", () => ({
  isSponsorshipSupported: (...args: unknown[]) =>
    mockIsSponsorshipSupported(...args),
}));

import { createSponsoredClient } from "@/lib/web3/sponsored-client";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createSponsoredClient", () => {
  it("returns null when the chain is not in the Turnkey allowlist", async () => {
    mockIsSponsorshipSupported.mockReturnValue(false);

    const result = await createSponsoredClient("org_1", 10);

    expect(result).toBeNull();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("returns null when the org has no active wallet", async () => {
    mockIsSponsorshipSupported.mockReturnValue(true);
    mockLimit.mockResolvedValue([]);

    const result = await createSponsoredClient("org_1", 1);

    expect(result).toBeNull();
  });

  it("returns null when the wallet row is missing the sub-org id", async () => {
    mockIsSponsorshipSupported.mockReturnValue(true);
    mockLimit.mockResolvedValue([
      {
        walletAddress: "0xabc",
        turnkeySubOrgId: null,
      },
    ]);

    const result = await createSponsoredClient("org_1", 1);

    expect(result).toBeNull();
  });

  it("returns the Turnkey identifiers when the org wallet is fully provisioned", async () => {
    mockIsSponsorshipSupported.mockReturnValue(true);
    mockLimit.mockResolvedValue([
      {
        walletAddress: "0xabc",
        turnkeySubOrgId: "suborg-123",
      },
    ]);

    const result = await createSponsoredClient("org_1", 8453);

    expect(result).toEqual({
      subOrgId: "suborg-123",
      walletAddress: "0xabc",
      chainId: 8453,
    });
  });
});
