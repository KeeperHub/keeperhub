import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockFindFirstSub = vi.fn();
const mockFindFirstOverage = vi.fn();
const mockInsertValues = vi.fn();
const mockOnConflictDoNothing = vi.fn();
const mockReturning = vi.fn();
const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn();
const mockSelectWhere = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      organizationSubscriptions: {
        findFirst: (...args: unknown[]) => mockFindFirstSub(...args),
      },
      overageBillingRecords: {
        findFirst: (...args: unknown[]) => mockFindFirstOverage(...args),
      },
    },
    execute: vi.fn(),
    insert: vi.fn(() => ({
      values: mockInsertValues,
    })),
    update: vi.fn(() => ({
      set: mockUpdateSet,
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: (...args: unknown[]) => mockSelectWhere(...args),
        })),
        where: (...args: unknown[]) => mockSelectWhere(...args),
      })),
    })),
  },
}));

vi.mock("@/lib/billing/providers", () => ({
  getBillingProvider: vi.fn(),
}));

import {
  billOverageForOrg,
  collectFinalPeriodOverage,
  collectOutstandingOverage,
} from "@/lib/billing/overage";
import type { BillingProvider } from "@/lib/billing/provider";
import { getBillingProvider } from "@/lib/billing/providers";
import { db } from "@/lib/db";

function mockExecutionCount(count: number): void {
  vi.mocked(db.execute).mockResolvedValue([{ count }] as unknown as Awaited<
    ReturnType<typeof db.execute>
  >);
}

function mockBillingProvider(overrides: Partial<BillingProvider>): void {
  vi.mocked(getBillingProvider).mockReturnValue(overrides as BillingProvider);
}

const periodStart = new Date("2025-01-01");
const periodEnd = new Date("2025-02-01");

beforeEach(() => {
  vi.clearAllMocks();

  mockInsertValues.mockReturnValue({
    onConflictDoNothing: mockOnConflictDoNothing,
  });
  mockOnConflictDoNothing.mockReturnValue({
    returning: mockReturning,
  });
  mockUpdateSet.mockReturnValue({
    where: mockUpdateWhere,
  });
  mockUpdateWhere.mockResolvedValue(undefined);
  mockSelectWhere.mockResolvedValue([]);
});

describe("billOverageForOrg", () => {
  it("skips when no subscription exists", async () => {
    mockFindFirstSub.mockResolvedValue(undefined);

    const result = await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(result).toEqual({ billed: false, reason: "no subscription" });
  });

  it("skips when overage is not enabled (free plan)", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "free",
      tier: null,
      status: "active",
      providerCustomerId: "cus_123",
    });

    const result = await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(result).toEqual({
      billed: false,
      reason: "overage not enabled for plan",
    });
  });

  it("skips when no provider customer ID", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: null,
    });

    const result = await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(result).toEqual({
      billed: false,
      reason: "no provider customer ID",
    });
  });

  it("skips when unlimited plan (enterprise)", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "enterprise",
      tier: null,
      status: "active",
      providerCustomerId: "cus_123",
    });

    const result = await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(result).toEqual({
      billed: false,
      reason: "overage not enabled for plan",
    });
  });

  it("skips when already billed for this period (idempotency)", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue({ id: "existing_record" });

    const result = await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(result).toEqual({
      billed: false,
      reason: "already billed for this period",
    });
  });

  it("skips when no overage (usage under limit)", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue(undefined);
    mockExecutionCount(20_000);

    const result = await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(result).toEqual({ billed: false, reason: "no overage" });
  });

  it("bills overage and creates Stripe invoice item", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue(undefined);
    mockExecutionCount(26_500);
    mockReturning.mockResolvedValue([{ id: "rec_1" }]);

    const mockCreateInvoiceItem = vi
      .fn()
      .mockResolvedValue({ invoiceItemId: "ii_123" });
    mockBillingProvider({ createInvoiceItem: mockCreateInvoiceItem });

    const result = await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(result).toEqual({
      billed: true,
      overageCount: 1500,
      totalChargeCents: 300,
    });
    expect(mockCreateInvoiceItem).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cus_123",
        amount: 300,
        currency: "usd",
      })
    );
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "billed",
        providerInvoiceItemId: "ii_123",
      })
    );
  });

  it("marks record as failed when provider throws", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue(undefined);
    mockExecutionCount(30_000);
    mockReturning.mockResolvedValue([{ id: "rec_1" }]);

    vi.mocked(getBillingProvider).mockReturnValue({
      createInvoiceItem: vi
        .fn()
        .mockRejectedValue(new Error("Stripe API error")),
    } as unknown as ReturnType<typeof getBillingProvider>);

    const result = await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(result).toEqual({
      billed: false,
      reason: "provider error: Stripe API error",
    });
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" })
    );
  });

  it("handles race condition on insert (conflict = already billed)", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue(undefined);
    mockExecutionCount(30_000);
    // onConflictDoNothing returns empty array (conflict)
    mockReturning.mockResolvedValue([]);

    const result = await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(result).toEqual({
      billed: false,
      reason: "already billed for this period",
    });
    expect(getBillingProvider).not.toHaveBeenCalled();
  });

  it("attaches the charge to the closing invoice when one is given", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue(undefined);
    mockExecutionCount(26_500);
    mockReturning.mockResolvedValue([{ id: "rec_1" }]);

    const mockCreateInvoiceItem = vi
      .fn()
      .mockResolvedValue({ invoiceItemId: "ii_123" });
    mockBillingProvider({ createInvoiceItem: mockCreateInvoiceItem });

    const result = await billOverageForOrg("org_1", periodStart, periodEnd, {
      invoiceId: "in_closing",
    });

    expect(result).toEqual({
      billed: true,
      overageCount: 1500,
      totalChargeCents: 300,
    });
    expect(mockCreateInvoiceItem).toHaveBeenCalledTimes(1);
    expect(mockCreateInvoiceItem).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: "in_closing" })
    );
  });

  it("retries unattached when the closing invoice can no longer take the item", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue(undefined);
    mockExecutionCount(26_500);
    mockReturning.mockResolvedValue([{ id: "rec_1" }]);

    const mockCreateInvoiceItem = vi
      .fn()
      .mockRejectedValueOnce(new Error("Invoice is no longer editable"))
      .mockResolvedValueOnce({ invoiceItemId: "ii_pending" });
    mockBillingProvider({
      createInvoiceItem: mockCreateInvoiceItem,
      // The provider refused the request outright, so nothing was created.
      wasRejectedWithoutCreating: vi.fn().mockReturnValue(true),
    });

    const result = await billOverageForOrg("org_1", periodStart, periodEnd, {
      invoiceId: "in_closing",
    });

    expect(result).toEqual({
      billed: true,
      overageCount: 1500,
      totalChargeCents: 300,
    });
    expect(mockCreateInvoiceItem).toHaveBeenCalledTimes(2);
    expect(mockCreateInvoiceItem).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ invoiceId: expect.anything() })
    );
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "billed",
        providerInvoiceItemId: "ii_pending",
      })
    );
  });

  it("does not retry after a transport failure, which could have created it", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue(undefined);
    mockExecutionCount(26_500);
    mockReturning.mockResolvedValue([{ id: "rec_1" }]);

    const mockCreateInvoiceItem = vi
      .fn()
      .mockRejectedValue(new Error("socket hang up"));
    mockBillingProvider({
      createInvoiceItem: mockCreateInvoiceItem,
      wasRejectedWithoutCreating: vi.fn().mockReturnValue(false),
    });

    const result = await billOverageForOrg("org_1", periodStart, periodEnd, {
      invoiceId: "in_closing",
    });

    // Exactly one attempt: a second under a different key would bill twice if
    // the first had in fact landed.
    expect(mockCreateInvoiceItem).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      billed: false,
      reason: "provider error: socket hang up",
    });
  });

  it("gives each attach mode its own idempotency key", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue(undefined);
    mockExecutionCount(26_500);
    mockReturning.mockResolvedValue([{ id: "rec_1" }]);

    const mockCreateInvoiceItem = vi
      .fn()
      .mockRejectedValueOnce(new Error("Invoice is no longer editable"))
      .mockResolvedValueOnce({ invoiceItemId: "ii_pending" });
    mockBillingProvider({
      createInvoiceItem: mockCreateInvoiceItem,
      wasRejectedWithoutCreating: vi.fn().mockReturnValue(true),
    });

    await billOverageForOrg("org_1", periodStart, periodEnd, {
      invoiceId: "in_closing",
    });

    // Replaying a key with different parameters is rejected by the provider, so
    // the attached and unattached attempts must not share one.
    const first = mockCreateInvoiceItem.mock.calls[0][0] as {
      idempotencyKey: string;
    };
    const second = mockCreateInvoiceItem.mock.calls[1][0] as {
      idempotencyKey: string;
    };
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    expect(second.idempotencyKey).toBe("overage-rec_1");
  });

  it("leaves the item unattached when no closing invoice is given", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue(undefined);
    mockExecutionCount(26_500);
    mockReturning.mockResolvedValue([{ id: "rec_1" }]);

    const mockCreateInvoiceItem = vi
      .fn()
      .mockResolvedValue({ invoiceItemId: "ii_123" });
    mockBillingProvider({ createInvoiceItem: mockCreateInvoiceItem });

    await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(mockCreateInvoiceItem).toHaveBeenCalledWith(
      expect.not.objectContaining({ invoiceId: expect.anything() })
    );
  });
});

describe("collectFinalPeriodOverage", () => {
  function proSubWithOverage(): void {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue(undefined);
    mockExecutionCount(26_500);
    mockReturning.mockResolvedValue([{ id: "rec_1" }]);
  }

  it("raises a standalone invoice carrying only the overage and collects it", async () => {
    proSubWithOverage();
    const createDraftInvoice = vi
      .fn()
      .mockResolvedValue({ invoiceId: "in_final" });
    const finalizeAndCollectInvoice = vi
      .fn()
      .mockResolvedValue({ invoiceId: "in_final", paid: true });
    const deleteDraftInvoice = vi.fn();
    mockBillingProvider({
      createDraftInvoice,
      finalizeAndCollectInvoice,
      deleteDraftInvoice,
      createInvoiceItem: vi.fn().mockResolvedValue({ invoiceItemId: "ii_1" }),
    });

    const result = await collectFinalPeriodOverage(
      "org_1",
      periodStart,
      periodEnd,
      "cus_123"
    );

    expect(createDraftInvoice).toHaveBeenCalledWith("cus_123", "usd");
    expect(finalizeAndCollectInvoice).toHaveBeenCalledWith("in_final");
    expect(deleteDraftInvoice).not.toHaveBeenCalled();
    expect(result).toEqual({ collected: true, totalChargeCents: 300 });
  });

  it("opens the draft in the same currency as the item it will carry", async () => {
    proSubWithOverage();
    const createDraftInvoice = vi
      .fn()
      .mockResolvedValue({ invoiceId: "in_final" });
    const createInvoiceItem = vi
      .fn()
      .mockResolvedValue({ invoiceItemId: "ii_1" });
    mockBillingProvider({
      createDraftInvoice,
      createInvoiceItem,
      finalizeAndCollectInvoice: vi
        .fn()
        .mockResolvedValue({ invoiceId: "in_final", paid: true }),
      deleteDraftInvoice: vi.fn(),
    });

    await collectFinalPeriodOverage("org_1", periodStart, periodEnd, "cus_123");

    // An invoice cannot mix currencies, so a draft left on the account default
    // rejects the attach and the overage silently goes uncharged.
    const draftCurrency = createDraftInvoice.mock.calls[0][1];
    const itemCurrency = (
      createInvoiceItem.mock.calls[0][0] as { currency: string }
    ).currency;
    expect(draftCurrency).toBe(itemCurrency);
  });

  it("discards the draft when there is nothing over the limit", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue(undefined);
    mockExecutionCount(10_000);

    const deleteDraftInvoice = vi.fn();
    const finalizeAndCollectInvoice = vi.fn();
    mockBillingProvider({
      createDraftInvoice: vi.fn().mockResolvedValue({ invoiceId: "in_empty" }),
      finalizeAndCollectInvoice,
      deleteDraftInvoice,
    });

    const result = await collectFinalPeriodOverage(
      "org_1",
      periodStart,
      periodEnd,
      "cus_123"
    );

    expect(deleteDraftInvoice).toHaveBeenCalledWith("in_empty");
    expect(finalizeAndCollectInvoice).not.toHaveBeenCalled();
    expect(result).toEqual({ collected: false, reason: "no overage" });
  });

  it("reports the amount as owed when the card is declined", async () => {
    proSubWithOverage();
    mockBillingProvider({
      createDraftInvoice: vi.fn().mockResolvedValue({ invoiceId: "in_final" }),
      finalizeAndCollectInvoice: vi.fn().mockResolvedValue({
        invoiceId: "in_final",
        paid: false,
        failureReason: "card_declined",
      }),
      deleteDraftInvoice: vi.fn(),
      createInvoiceItem: vi.fn().mockResolvedValue({ invoiceItemId: "ii_1" }),
    });

    const result = await collectFinalPeriodOverage(
      "org_1",
      periodStart,
      periodEnd,
      "cus_123"
    );

    expect(result).toEqual({
      collected: false,
      reason: "card_declined",
      invoiceId: "in_final",
    });
  });
});

describe("collectOutstandingOverage", () => {
  it("retries an invoice the org left unpaid", async () => {
    mockSelectWhere.mockResolvedValue([
      { id: "rec_1", providerInvoiceItemId: "ii_1", providerInvoiceId: null },
    ]);
    const finalizeAndCollectInvoice = vi
      .fn()
      .mockResolvedValue({ invoiceId: "in_1", paid: true });
    const provider = {
      getInvoiceForItem: vi
        .fn()
        .mockResolvedValue({ invoiceId: "in_1", status: "open", paid: false }),
      finalizeAndCollectInvoice,
    } as unknown as BillingProvider;

    const result = await collectOutstandingOverage("org_1", provider);

    expect(finalizeAndCollectInvoice).toHaveBeenCalledWith("in_1");
    expect(result).toEqual({ attempted: 1, collected: 1 });
  });

  it("stamps the invoice and does not recharge one already paid", async () => {
    mockSelectWhere.mockResolvedValue([
      { id: "rec_1", providerInvoiceItemId: "ii_1", providerInvoiceId: null },
    ]);
    const finalizeAndCollectInvoice = vi.fn();
    const provider = {
      getInvoiceForItem: vi
        .fn()
        .mockResolvedValue({ invoiceId: "in_1", status: "paid", paid: true }),
      finalizeAndCollectInvoice,
    } as unknown as BillingProvider;

    const result = await collectOutstandingOverage("org_1", provider);

    expect(finalizeAndCollectInvoice).not.toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith({ providerInvoiceId: "in_1" });
    expect(result).toEqual({ attempted: 0, collected: 0 });
  });

  it("keeps going when one record cannot be settled", async () => {
    mockSelectWhere.mockResolvedValue([
      { id: "rec_1", providerInvoiceItemId: "ii_bad", providerInvoiceId: null },
      {
        id: "rec_2",
        providerInvoiceItemId: "ii_good",
        providerInvoiceId: null,
      },
    ]);
    const provider = {
      getInvoiceForItem: vi.fn((itemId: string) =>
        itemId === "ii_bad"
          ? Promise.reject(new Error("Stripe unavailable"))
          : Promise.resolve({
              invoiceId: "in_2",
              status: "open",
              paid: false,
            })
      ),
      finalizeAndCollectInvoice: vi
        .fn()
        .mockResolvedValue({ invoiceId: "in_2", paid: true }),
    } as unknown as BillingProvider;

    const result = await collectOutstandingOverage("org_1", provider);

    expect(result).toEqual({ attempted: 1, collected: 1 });
  });

  it("skips a draft invoice rather than finalizing it early", async () => {
    mockSelectWhere.mockResolvedValue([
      { id: "rec_1", providerInvoiceItemId: "ii_1", providerInvoiceId: null },
    ]);
    const finalizeAndCollectInvoice = vi.fn();
    const provider = {
      getInvoiceForItem: vi
        .fn()
        .mockResolvedValue({ invoiceId: "in_1", status: "draft", paid: false }),
      finalizeAndCollectInvoice,
    } as unknown as BillingProvider;

    const result = await collectOutstandingOverage("org_1", provider);

    expect(finalizeAndCollectInvoice).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: 0, collected: 0 });
  });

  it("settles a record the debt scan already stamped", async () => {
    mockSelectWhere.mockResolvedValue([
      { id: "rec_1", providerInvoiceItemId: "ii_1", providerInvoiceId: "in_9" },
    ]);
    const getInvoiceForItem = vi.fn();
    const finalizeAndCollectInvoice = vi
      .fn()
      .mockResolvedValue({ invoiceId: "in_9", paid: true });
    const provider = {
      getInvoiceStatus: vi
        .fn()
        .mockResolvedValue({ status: "open", paid: false }),
      getInvoiceForItem,
      finalizeAndCollectInvoice,
    } as unknown as BillingProvider;

    const result = await collectOutstandingOverage("org_1", provider);

    // Resolved straight from the stamped id, not traced back through the item.
    expect(getInvoiceForItem).not.toHaveBeenCalled();
    expect(finalizeAndCollectInvoice).toHaveBeenCalledWith("in_9");
    expect(result).toEqual({ attempted: 1, collected: 1 });
  });

  it("does nothing when the org owes nothing", async () => {
    mockSelectWhere.mockResolvedValue([]);
    const provider = {
      getInvoiceForItem: vi.fn(),
      finalizeAndCollectInvoice: vi.fn(),
    } as unknown as BillingProvider;

    const result = await collectOutstandingOverage("org_1", provider);

    expect(provider.getInvoiceForItem).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: 0, collected: 0 });
  });
});
