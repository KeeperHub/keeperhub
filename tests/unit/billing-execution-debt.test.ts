import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockSelectFromWhere = vi.fn();
const mockInsertValues = vi.fn();
const mockInsertOnConflict = vi.fn();
const mockInsertReturning = vi.fn();
const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn();
const mockUpdateReturning = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: mockSelectFromWhere,
        })),
        where: mockSelectFromWhere,
      })),
    })),
    insert: vi.fn(() => ({
      values: mockInsertValues,
    })),
    update: vi.fn(() => ({
      set: mockUpdateSet,
    })),
  },
}));

vi.mock("@/lib/billing/providers", () => ({
  getBillingProvider: vi.fn(),
}));

import {
  clearAllDebtForOrg,
  clearDebtForInvoice,
  getActiveDebtExecutions,
  scanAndCreateDebt,
} from "@/lib/billing/execution-debt";
import type { BillingProvider } from "@/lib/billing/provider";
import { getBillingProvider } from "@/lib/billing/providers";
import { db } from "@/lib/db";

function mockProvider(overrides: Partial<BillingProvider>): void {
  vi.mocked(getBillingProvider).mockReturnValue(overrides as BillingProvider);
}

beforeEach(() => {
  vi.clearAllMocks();

  mockInsertReturning.mockResolvedValue([{ id: "debt_1" }]);
  mockInsertOnConflict.mockReturnValue({
    returning: mockInsertReturning,
  });
  mockInsertValues.mockReturnValue({
    onConflictDoNothing: mockInsertOnConflict,
  });
  mockUpdateSet.mockReturnValue({
    where: mockUpdateWhere,
  });
  mockUpdateWhere.mockReturnValue({
    returning: mockUpdateReturning,
  });
  mockUpdateReturning.mockResolvedValue([]);
});

describe("scanAndCreateDebt", () => {
  it("creates debt for 15-day-old unpaid overage", async () => {
    mockSelectFromWhere.mockResolvedValue([
      {
        id: "ovr_1",
        organizationId: "org_1",
        overageCount: 5000,
        providerInvoiceItemId: "ii_123",
        providerInvoiceId: null,
      },
    ]);

    mockProvider({
      getInvoiceForItem: vi.fn().mockResolvedValue({
        invoiceId: "inv_123",
        status: "open",
        paid: false,
      }),
    });

    // Mock the update for storing invoiceId on overage record
    mockUpdateSet.mockReturnValue({
      where: mockUpdateWhere,
    });
    mockUpdateWhere.mockReturnValue({
      returning: mockUpdateReturning,
    });

    const result = await scanAndCreateDebt();

    expect(result).toEqual({ scanned: 1, created: 1, skipped: 0 });
    expect(db.insert).toHaveBeenCalled();
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_1",
        overageRecordId: "ovr_1",
        providerInvoiceId: "inv_123",
        debtExecutions: 5000,
        status: "active",
      })
    );
  });

  it("skips records that already have debt (idempotent)", async () => {
    // Left join returns no rows when debt already exists (filtered by isNull)
    mockSelectFromWhere.mockResolvedValue([]);

    mockProvider({});

    const result = await scanAndCreateDebt();

    expect(result).toEqual({ scanned: 0, created: 0, skipped: 0 });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("skips paid invoices", async () => {
    mockSelectFromWhere.mockResolvedValue([
      {
        id: "ovr_1",
        organizationId: "org_1",
        overageCount: 3000,
        providerInvoiceItemId: "ii_123",
        providerInvoiceId: "inv_123",
      },
    ]);

    mockProvider({
      getInvoiceStatus: vi.fn().mockResolvedValue({
        status: "paid",
        paid: true,
      }),
    });

    const result = await scanAndCreateDebt();

    expect(result).toEqual({ scanned: 1, created: 0, skipped: 1 });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("skips records where invoice not finalized yet", async () => {
    mockSelectFromWhere.mockResolvedValue([
      {
        id: "ovr_1",
        organizationId: "org_1",
        overageCount: 3000,
        providerInvoiceItemId: "ii_123",
        providerInvoiceId: null,
      },
    ]);

    mockProvider({
      getInvoiceForItem: vi.fn().mockResolvedValue(undefined),
    });

    const result = await scanAndCreateDebt();

    expect(result).toEqual({ scanned: 1, created: 0, skipped: 1 });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("skips records without providerInvoiceItemId", async () => {
    mockSelectFromWhere.mockResolvedValue([
      {
        id: "ovr_1",
        organizationId: "org_1",
        overageCount: 3000,
        providerInvoiceItemId: null,
        providerInvoiceId: null,
      },
    ]);

    mockProvider({});

    const result = await scanAndCreateDebt();

    expect(result).toEqual({ scanned: 1, created: 0, skipped: 1 });
  });

  it("stores invoice ID on overage record when discovered", async () => {
    mockSelectFromWhere.mockResolvedValue([
      {
        id: "ovr_1",
        organizationId: "org_1",
        overageCount: 2000,
        providerInvoiceItemId: "ii_123",
        providerInvoiceId: null,
      },
    ]);

    mockProvider({
      getInvoiceForItem: vi.fn().mockResolvedValue({
        invoiceId: "inv_456",
        status: "open",
        paid: false,
      }),
    });

    await scanAndCreateDebt();

    // First update call stores the invoice ID on the overage record
    expect(db.update).toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ providerInvoiceId: "inv_456" })
    );
  });
});

describe("clearDebtForInvoice", () => {
  it("marks matching debt as cleared", async () => {
    mockUpdateReturning.mockResolvedValue([{ id: "debt_1" }, { id: "debt_2" }]);

    const count = await clearDebtForInvoice("inv_123");

    expect(count).toBe(2);
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "cleared",
      })
    );
  });

  it("returns 0 for unknown invoice ID", async () => {
    mockUpdateReturning.mockResolvedValue([]);

    const count = await clearDebtForInvoice("inv_unknown");

    expect(count).toBe(0);
  });
});

describe("clearAllDebtForOrg", () => {
  it("clears all active debt for an organization", async () => {
    mockUpdateReturning.mockResolvedValue([{ id: "debt_1" }]);

    const count = await clearAllDebtForOrg("org_1");

    expect(count).toBe(1);
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "cleared",
      })
    );
  });
});

describe("getActiveDebtExecutions", () => {
  it("returns sum of active debt executions", async () => {
    mockSelectFromWhere.mockResolvedValue([{ total: 8000 }]);

    const total = await getActiveDebtExecutions("org_1");

    expect(total).toBe(8000);
  });

  it("returns 0 when no debt exists", async () => {
    mockSelectFromWhere.mockResolvedValue([{ total: 0 }]);

    const total = await getActiveDebtExecutions("org_1");

    expect(total).toBe(0);
  });

  it("returns 0 when query returns empty", async () => {
    mockSelectFromWhere.mockResolvedValue([]);

    const total = await getActiveDebtExecutions("org_1");

    expect(total).toBe(0);
  });
});
