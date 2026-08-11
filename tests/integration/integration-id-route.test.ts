/**
 * Integration Tests for GET /api/integrations/[integrationId]
 *
 * Tests the wallet address enrichment for web3 integrations (KEEP-197).
 * Verifies:
 * - Web3 integrations include full checksummed walletAddress
 * - Non-web3 integrations omit walletAddress
 * - Missing wallet row returns 200 without walletAddress (no 500)
 * - Truncated name field preserved for backward compatibility
 * - 404 when integration not found
 *
 * Run with: pnpm vitest tests/integration/integration-id-route.test.ts
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetIntegration,
  mockStripDatabaseSecrets,
  mockToChecksumAddress,
  mockWalletResult,
} = vi.hoisted(() => ({
  mockGetIntegration: vi.fn(),
  mockStripDatabaseSecrets: vi.fn((config: Record<string, unknown>) => config),
  mockToChecksumAddress: vi.fn(
    (addr: string) => `0xChecksummed_${addr.slice(2)}`
  ),
  mockWalletResult: { current: [] as unknown[] },
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db/integrations", () => ({
  getIntegration: mockGetIntegration,
  stripDatabaseSecrets: mockStripDatabaseSecrets,
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: vi.fn(() =>
    Promise.resolve({ userId: "user-1", organizationId: "org-1" })
  ),
}));

vi.mock("@/lib/address-utils", () => ({
  toChecksumAddress: mockToChecksumAddress,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(mockWalletResult.current)),
        })),
      })),
    })),
  },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

import { GET } from "@/app/api/integrations/[integrationId]/route";

const mockWeb3Integration = {
  id: "int-1",
  userId: "user-1",
  name: "0x6F10...f3D9",
  type: "web3",
  config: {},
  isManaged: false,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const mockDatabaseIntegration = {
  id: "int-2",
  userId: "user-1",
  name: "My Postgres",
  type: "database",
  config: {},
  isManaged: false,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const mockWalletRow = {
  walletAddress: "0x6f1079a15eaf5e2fbb3a29d3c9e6e24e11a6f3d9",
};

function createRequest(path: string): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"));
}

describe("GET /api/integrations/[integrationId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWalletResult.current = [];
  });

  it("returns walletAddress for web3 integration", async () => {
    mockGetIntegration.mockResolvedValue(mockWeb3Integration);
    mockWalletResult.current = [mockWalletRow];

    const response = await GET(createRequest("/api/integrations/int-1"), {
      params: Promise.resolve({ integrationId: "int-1" }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.walletAddress).toBeDefined();
    expect(data.walletAddress).toContain("0xChecksummed_");
    expect(data.name).toBe("0x6F10...f3D9");
  });

  it("omits walletAddress for non-web3 integration", async () => {
    mockGetIntegration.mockResolvedValue(mockDatabaseIntegration);

    const response = await GET(createRequest("/api/integrations/int-2"), {
      params: Promise.resolve({ integrationId: "int-2" }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.walletAddress).toBeUndefined();
    expect(data.name).toBe("My Postgres");
  });

  it("omits walletAddress when wallet row not found", async () => {
    mockGetIntegration.mockResolvedValue(mockWeb3Integration);
    mockWalletResult.current = [];

    const response = await GET(createRequest("/api/integrations/int-1"), {
      params: Promise.resolve({ integrationId: "int-1" }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.walletAddress).toBeUndefined();
  });

  it("returns 404 when integration not found", async () => {
    mockGetIntegration.mockResolvedValue(null);

    const response = await GET(createRequest("/api/integrations/int-999"), {
      params: Promise.resolve({ integrationId: "int-999" }),
    });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe("Integration not found");
  });

  it("walletAddress is checksummed from lowercase storage form", async () => {
    mockGetIntegration.mockResolvedValue(mockWeb3Integration);
    mockWalletResult.current = [mockWalletRow];

    const response = await GET(createRequest("/api/integrations/int-1"), {
      params: Promise.resolve({ integrationId: "int-1" }),
    });
    const data = await response.json();

    expect(mockToChecksumAddress).toHaveBeenCalledWith(
      "0x6f1079a15eaf5e2fbb3a29d3c9e6e24e11a6f3d9"
    );
    expect(data.walletAddress).toBe(
      "0xChecksummed_6f1079a15eaf5e2fbb3a29d3c9e6e24e11a6f3d9"
    );
  });
});
