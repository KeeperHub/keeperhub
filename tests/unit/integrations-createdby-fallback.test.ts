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
  organizationWallets: {
    organizationId: "organization_id",
    walletAddress: "wallet_address",
    isActive: "is_active",
  },
}));

// Condition builders return inspectable tags so each query's WHERE can be
// asserted structurally without a real database.
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ op: "and", conditions }),
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  isNotNull: (col: unknown) => ({ op: "isNotNull", col }),
  inArray: (col: unknown, val: unknown) => ({ op: "inArray", col, val }),
}));

const mockSelectWhere = vi.fn();
const mockUpdateWhere = vi.fn();
const mockDeleteWhere = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: (arg: unknown) => {
            mockSelectWhere(arg);
            return {
              limit: () => Promise.resolve([]),
              orderBy: () => Promise.resolve([]),
            };
          },
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: (arg: unknown) => {
          mockUpdateWhere(arg);
          return { returning: () => Promise.resolve([]) };
        },
      })),
    })),
    delete: vi.fn(() => ({
      where: (arg: unknown) => {
        mockDeleteWhere(arg);
        return { returning: () => Promise.resolve([]) };
      },
    })),
  },
}));

const ORIGINAL_ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY;
process.env.INTEGRATION_ENCRYPTION_KEY = "0".repeat(64);

const {
  deleteIntegration,
  getIntegration,
  getIntegrations,
  updateIntegration,
} = await import("@/lib/db/integrations");

const INTEGRATION_ID = "i-1";
const USER_ID = "user-1";
const ORG_ID = "org-1";

type ConditionTag = {
  op: string;
  col?: unknown;
  val?: unknown;
  conditions?: ConditionTag[];
};

function whereConditions(capturedArg: unknown): ConditionTag[] {
  const tag = capturedArg as ConditionTag;
  return tag.conditions ?? [];
}

function hasEqCol(conditions: ConditionTag[], col: string): boolean {
  return conditions.some((c) => c.op === "eq" && c.col === col);
}

function hasEqValue(
  conditions: ConditionTag[],
  col: string,
  val: unknown
): boolean {
  return conditions.some(
    (c) => c.op === "eq" && c.col === col && c.val === val
  );
}

function hasIsNull(conditions: ConditionTag[], col: string): boolean {
  return conditions.some((c) => c.op === "isNull" && c.col === col);
}

describe("integrations createdBy fallback org scoping (F-002)", () => {
  beforeEach(() => {
    mockSelectWhere.mockReset();
    mockUpdateWhere.mockReset();
    mockDeleteWhere.mockReset();
  });

  it("getIntegration with no org constrains the createdBy fallback to org-less rows", async () => {
    await getIntegration(INTEGRATION_ID, USER_ID, null);

    const conditions = whereConditions(mockSelectWhere.mock.calls[0]?.[0]);

    expect(hasEqValue(conditions, "id", INTEGRATION_ID)).toBe(true);
    expect(hasEqValue(conditions, "created_by", USER_ID)).toBe(true);
    expect(hasIsNull(conditions, "organization_id")).toBe(true);
    expect(hasEqCol(conditions, "organization_id")).toBe(false);
  });

  it("getIntegration with an org scopes by organizationId, not createdBy", async () => {
    await getIntegration(INTEGRATION_ID, USER_ID, ORG_ID);

    const conditions = whereConditions(mockSelectWhere.mock.calls[0]?.[0]);

    expect(hasEqValue(conditions, "organization_id", ORG_ID)).toBe(true);
    expect(hasEqCol(conditions, "created_by")).toBe(false);
    expect(hasIsNull(conditions, "organization_id")).toBe(false);
  });

  it("updateIntegration with no org constrains the createdBy fallback to org-less rows", async () => {
    await updateIntegration(INTEGRATION_ID, USER_ID, { name: "renamed" }, null);

    const conditions = whereConditions(mockUpdateWhere.mock.calls[0]?.[0]);

    expect(hasEqValue(conditions, "created_by", USER_ID)).toBe(true);
    expect(hasIsNull(conditions, "organization_id")).toBe(true);
    expect(hasEqCol(conditions, "organization_id")).toBe(false);
  });

  it("updateIntegration with an org scopes by organizationId, not createdBy", async () => {
    await updateIntegration(
      INTEGRATION_ID,
      USER_ID,
      { name: "renamed" },
      ORG_ID
    );

    const conditions = whereConditions(mockUpdateWhere.mock.calls[0]?.[0]);

    expect(hasEqValue(conditions, "organization_id", ORG_ID)).toBe(true);
    expect(hasEqCol(conditions, "created_by")).toBe(false);
    expect(hasIsNull(conditions, "organization_id")).toBe(false);
  });

  it("deleteIntegration with no org constrains the createdBy fallback to org-less rows", async () => {
    await deleteIntegration(INTEGRATION_ID, USER_ID, null);

    const conditions = whereConditions(mockDeleteWhere.mock.calls[0]?.[0]);

    expect(hasEqValue(conditions, "created_by", USER_ID)).toBe(true);
    expect(hasIsNull(conditions, "organization_id")).toBe(true);
    expect(hasEqCol(conditions, "organization_id")).toBe(false);
  });

  it("deleteIntegration with an org scopes by organizationId, not createdBy", async () => {
    await deleteIntegration(INTEGRATION_ID, USER_ID, ORG_ID);

    const conditions = whereConditions(mockDeleteWhere.mock.calls[0]?.[0]);

    expect(hasEqValue(conditions, "organization_id", ORG_ID)).toBe(true);
    expect(hasEqCol(conditions, "created_by")).toBe(false);
    expect(hasIsNull(conditions, "organization_id")).toBe(false);
  });

  it("getIntegrations with no org lists only org-less rows the user created", async () => {
    await getIntegrations(USER_ID, undefined, null);

    const conditions = whereConditions(mockSelectWhere.mock.calls[0]?.[0]);

    expect(hasEqValue(conditions, "created_by", USER_ID)).toBe(true);
    expect(hasIsNull(conditions, "organization_id")).toBe(true);
    expect(hasEqCol(conditions, "organization_id")).toBe(false);
  });

  it("getIntegrations with an org scopes by organizationId, not createdBy", async () => {
    await getIntegrations(USER_ID, undefined, ORG_ID);

    const conditions = whereConditions(mockSelectWhere.mock.calls[0]?.[0]);

    expect(hasEqValue(conditions, "organization_id", ORG_ID)).toBe(true);
    expect(hasEqCol(conditions, "created_by")).toBe(false);
    expect(hasIsNull(conditions, "organization_id")).toBe(false);
  });
});

afterAll(() => {
  if (ORIGINAL_ENCRYPTION_KEY === undefined) {
    process.env.INTEGRATION_ENCRYPTION_KEY = undefined;
  } else {
    process.env.INTEGRATION_ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
  }
});
