/**
 * Scope regression tests for getIntegrations (the connection picker's list
 * query). A session with no active organization must NOT see other orgs'
 * connections: the personal fallback has to be constrained to integrations the
 * user created that are not org-scoped (organizationId IS NULL). Results must
 * also be deterministically ordered so the picker's "first" connection is
 * stable across requests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => {
  const orderBy = vi.fn(() => Promise.resolve([]));
  const where = vi.fn(() => ({ orderBy }));
  const leftJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ leftJoin }));
  const select = vi.fn(() => ({ from }));
  const eq = vi.fn((col: unknown, val: unknown) => ({ op: "eq", col, val }));
  const isNull = vi.fn((col: unknown) => ({ op: "isNull", col }));
  const and = vi.fn((...conditions: unknown[]) => ({ op: "and", conditions }));
  return { orderBy, where, leftJoin, from, select, eq, isNull, and };
});

vi.mock("drizzle-orm", () => ({ eq: h.eq, and: h.and, isNull: h.isNull }));

vi.mock("@/lib/db", () => ({ db: { select: h.select } }));

vi.mock("@/lib/db/schema", () => ({
  integrations: {
    id: "id",
    createdBy: "created_by",
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
  // Distinct token from integrations.organizationId so the leftJoin's
  // eq(walletOrgId, integrationOrgId) cannot be confused with the WHERE clause.
  organizationWallets: {
    organizationId: "wallet_organization_id",
    walletAddress: "wallet_address",
    isActive: "is_active",
  },
}));

// Module-load-time imports unrelated to getIntegrations.
vi.mock("@/lib/integrations/authorization", () => ({
  filterUnauthorizedIntegrationIds: vi.fn(),
}));
vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWallet: vi.fn(),
  organizationHasWallet: vi.fn(),
}));
vi.mock("@/plugins/registry", () => ({
  findActionById: vi.fn(),
  getIntegration: vi.fn(),
}));
vi.mock("@/lib/address-utils", () => ({
  toChecksumAddress: (addr: string) => addr,
}));

describe("getIntegrations scope", () => {
  beforeEach(() => {
    h.eq.mockClear();
    h.isNull.mockClear();
    h.and.mockClear();
    h.orderBy.mockClear();
  });

  it("constrains the no-org fallback to personal (organizationId IS NULL) rows", async () => {
    const { getIntegrations } = await import("@/lib/db/integrations");

    await getIntegrations("user_1", undefined, null);

    // Personal fallback: createdBy = user AND organizationId IS NULL.
    expect(h.eq).toHaveBeenCalledWith("created_by", "user_1");
    expect(h.isNull).toHaveBeenCalledWith("organization_id");
    // Must NOT scope by an org equality in the no-org path (the join uses the
    // distinct wallet_organization_id token, so this only matches a WHERE eq).
    expect(h.eq).not.toHaveBeenCalledWith("organization_id", expect.anything());
    expect(h.orderBy).toHaveBeenCalled();
  });

  it("scopes by org and never falls back to createdBy when an org is active", async () => {
    const { getIntegrations } = await import("@/lib/db/integrations");

    await getIntegrations("user_1", undefined, "org_1");

    expect(h.eq).toHaveBeenCalledWith("organization_id", "org_1");
    expect(h.eq).not.toHaveBeenCalledWith("created_by", "user_1");
    expect(h.isNull).not.toHaveBeenCalled();
    expect(h.orderBy).toHaveBeenCalled();
  });
});
