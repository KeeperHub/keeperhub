import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockClearDebtForInvoice = vi.fn().mockResolvedValue(0);
const mockClearAllDebtForOrg = vi.fn().mockResolvedValue(0);

vi.mock("@/lib/billing/execution-debt", () => ({
  clearDebtForInvoice: (...args: unknown[]) => mockClearDebtForInvoice(...args),
  clearAllDebtForOrg: (...args: unknown[]) => mockClearAllDebtForOrg(...args),
}));

const mockBillOverageForOrg = vi
  .fn()
  .mockResolvedValue({ billed: false, reason: "no overage" });

const mockCollectFinalPeriodOverage = vi
  .fn()
  .mockResolvedValue({ collected: false, reason: "no overage" });
const mockCollectOutstandingOverage = vi
  .fn()
  .mockResolvedValue({ attempted: 0, collected: 0 });

vi.mock("@/lib/billing/overage", () => ({
  billOverageForOrg: (...args: unknown[]) => mockBillOverageForOrg(...args),
  collectFinalPeriodOverage: (...args: unknown[]) =>
    mockCollectFinalPeriodOverage(...args),
  collectOutstandingOverage: (...args: unknown[]) =>
    mockCollectOutstandingOverage(...args),
}));

const mockLowerGasAllocationToPlan = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/billing/gas-credits", () => ({
  lowerGasAllocationToPlan: (...args: unknown[]) =>
    mockLowerGasAllocationToPlan(...args),
}));

const mockIncrementCounter = vi.fn();

vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: mockIncrementCounter,
    setGauge: vi.fn(),
    recordError: vi.fn(),
    recordWarning: vi.fn(),
  }),
}));

import { SUBSCRIPTION_STATUS } from "@/lib/billing/constants";
import { handleBillingEvent } from "@/lib/billing/handle-billing-event";
import type {
  BillingProvider,
  BillingWebhookEvent,
} from "@/lib/billing/provider";
import { db } from "@/lib/db";
import { MetricNames } from "@/lib/metrics/types";

const mockSet = vi.fn().mockReturnValue({ where: vi.fn() });
const mockWhere = vi.fn();
const mockOnConflictDoUpdate = vi.fn();
const mockInsertValues = vi.fn().mockReturnValue({
  onConflictDoUpdate: mockOnConflictDoUpdate,
});

vi.mocked(db.update).mockReturnValue({
  set: mockSet,
} as unknown as ReturnType<typeof db.update>);

vi.mocked(db.insert).mockReturnValue({
  values: mockInsertValues,
} as unknown as ReturnType<typeof db.insert>);

// db.select serves two query shapes in this module: subscription lookups
// (.where().limit(1)) and markOverageRecordsPaid (.where() awaited directly).
// The where() return value is therefore a Promise (resolving to overage rows)
// that ALSO carries a .limit() resolving to the subscription rows, so both
// shapes get the right data from one mock.
function setBillingSelect(
  limitRows: Record<string, unknown>[],
  whereRows: Record<string, unknown>[] = []
): void {
  const whereResult = Object.assign(Promise.resolve(whereRows), {
    limit: vi.fn().mockResolvedValue(limitRows),
  });
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(whereResult),
    }),
  } as unknown as ReturnType<typeof db.select>);
}

setBillingSelect([]);

function mockSelectReturning(
  rows: Record<string, unknown>[],
  overageRows: Record<string, unknown>[] = []
): void {
  setBillingSelect(rows, overageRows);
}

function createMockProvider(
  overrides: Partial<BillingProvider> = {}
): BillingProvider {
  return {
    name: "test",
    createCustomer: vi.fn(),
    createCheckoutSession: vi.fn(),
    createPortalSession: vi.fn(),
    getBillingDetails: vi
      .fn()
      .mockResolvedValue({ paymentMethod: null, billingEmail: null }),
    verifyWebhook: vi.fn(),
    getSubscriptionDetails: vi.fn().mockResolvedValue({
      priceId: process.env.STRIPE_PRICE_PRO_25K_MONTHLY,
      status: SUBSCRIPTION_STATUS.ACTIVE,
      cancelAtPeriodEnd: false,
      periodStart: new Date("2025-01-01"),
      periodEnd: new Date("2025-02-01"),
    }),
    listInvoices: vi.fn(),
    updateSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    cancelSubscriptionNow: vi.fn().mockResolvedValue(undefined),
    hasPaidInvoice: vi.fn().mockResolvedValue(true),
    previewProration: vi.fn(),
    createInvoiceItem: vi.fn(),
    getInvoiceStatus: vi.fn().mockResolvedValue({ status: "paid", paid: true }),
    getInvoiceForItem: vi.fn().mockResolvedValue(undefined),
    createDraftInvoice: vi.fn().mockResolvedValue({ invoiceId: "in_draft" }),
    finalizeAndCollectInvoice: vi
      .fn()
      .mockResolvedValue({ invoiceId: "in_draft", paid: true }),
    deleteDraftInvoice: vi.fn().mockResolvedValue(undefined),
    wasRejectedWithoutCreating: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

function makeEvent(
  type: BillingWebhookEvent["type"],
  data: BillingWebhookEvent["data"]
): BillingWebhookEvent {
  return { type, providerEventId: `evt_${type}`, data };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSet.mockReturnValue({ where: mockWhere });
  mockInsertValues.mockReturnValue({
    onConflictDoUpdate: mockOnConflictDoUpdate,
  });
  mockBillOverageForOrg.mockResolvedValue({
    billed: false,
    reason: "no overage",
  });
  mockCollectFinalPeriodOverage.mockResolvedValue({
    collected: false,
    reason: "no overage",
  });
  mockCollectOutstandingOverage.mockResolvedValue({
    attempted: 0,
    collected: 0,
  });
  mockLowerGasAllocationToPlan.mockResolvedValue(undefined);
});

describe("handleBillingEvent", () => {
  describe("checkout.completed", () => {
    it("updates subscription with resolved plan and tier", async () => {
      const provider = createMockProvider();
      const event = makeEvent("checkout.completed", {
        organizationId: "org_1",
        providerSubscriptionId: "sub_1",
      });

      await handleBillingEvent(event, provider);

      expect(provider.getSubscriptionDetails).toHaveBeenCalledWith("sub_1");
      expect(db.insert).toHaveBeenCalled();
      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org_1",
          providerSubscriptionId: "sub_1",
          plan: "pro",
          tier: "25k",
          status: SUBSCRIPTION_STATUS.ACTIVE,
        })
      );
      expect(mockOnConflictDoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          set: expect.objectContaining({
            providerSubscriptionId: "sub_1",
            plan: "pro",
            tier: "25k",
            status: SUBSCRIPTION_STATUS.ACTIVE,
          }),
        })
      );
    });

    it("persists trialing status and stamps trialStartedAt for a trial", async () => {
      const provider = createMockProvider({
        getSubscriptionDetails: vi.fn().mockResolvedValue({
          priceId: process.env.STRIPE_PRICE_PRO_25K_MONTHLY,
          status: SUBSCRIPTION_STATUS.TRIALING,
          cancelAtPeriodEnd: false,
          periodStart: new Date("2025-01-01"),
          periodEnd: new Date("2025-01-15"),
        }),
      });
      const event = makeEvent("checkout.completed", {
        organizationId: "org_1",
        providerSubscriptionId: "sub_trial",
      });

      await handleBillingEvent(event, provider);

      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org_1",
          plan: "pro",
          status: SUBSCRIPTION_STATUS.TRIALING,
          trialStartedAt: expect.any(Date),
        })
      );
      expect(mockOnConflictDoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          set: expect.objectContaining({
            status: SUBSCRIPTION_STATUS.TRIALING,
            trialStartedAt: expect.any(Date),
          }),
        })
      );
    });

    it("settles overage the org left unpaid when it subscribes again", async () => {
      const provider = createMockProvider();

      await handleBillingEvent(
        makeEvent("checkout.completed", {
          organizationId: "org_1",
          providerSubscriptionId: "sub_1",
        }),
        provider
      );

      expect(mockCollectOutstandingOverage).toHaveBeenCalledWith(
        "org_1",
        provider
      );
    });

    it("still subscribes when settling the old balance fails", async () => {
      mockCollectOutstandingOverage.mockRejectedValue(new Error("Stripe down"));

      await handleBillingEvent(
        makeEvent("checkout.completed", {
          organizationId: "org_1",
          providerSubscriptionId: "sub_1",
        }),
        createMockProvider()
      );

      expect(db.insert).toHaveBeenCalled();
    });

    it("skips when organizationId is missing", async () => {
      const provider = createMockProvider();
      const event = makeEvent("checkout.completed", {
        providerSubscriptionId: "sub_1",
      });

      await handleBillingEvent(event, provider);

      expect(provider.getSubscriptionDetails).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("skips when providerSubscriptionId is missing", async () => {
      const provider = createMockProvider();
      const event = makeEvent("checkout.completed", {
        organizationId: "org_1",
      });

      await handleBillingEvent(event, provider);

      expect(provider.getSubscriptionDetails).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("returns early when priceId cannot be resolved", async () => {
      const provider = createMockProvider({
        getSubscriptionDetails: vi.fn().mockResolvedValue({
          priceId: "price_unknown_xyz",
          status: SUBSCRIPTION_STATUS.ACTIVE,
          cancelAtPeriodEnd: false,
          periodStart: new Date("2025-01-01"),
          periodEnd: new Date("2025-02-01"),
        }),
      });
      const event = makeEvent("checkout.completed", {
        organizationId: "org_1",
        providerSubscriptionId: "sub_1",
      });

      await handleBillingEvent(event, provider);

      expect(provider.getSubscriptionDetails).toHaveBeenCalledWith("sub_1");
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe("invoice.created", () => {
    const closedPeriod = {
      organizationId: "org_1",
      providerSubscriptionId: "sub_1",
      providerPriceId: process.env.STRIPE_PRICE_PRO_25K_MONTHLY,
      plan: "pro",
      tier: "25k",
      status: SUBSCRIPTION_STATUS.ACTIVE,
      cancelAtPeriodEnd: false,
      currentPeriodStart: new Date("2025-01-01"),
      currentPeriodEnd: new Date("2025-02-01"),
    };

    it("bills the closed period onto the invoice that closes it", async () => {
      mockSelectReturning([closedPeriod]);

      const event = makeEvent("invoice.created", {
        providerSubscriptionId: "sub_1",
        invoiceId: "in_closing",
        billingReason: "subscription_cycle",
      });

      await handleBillingEvent(event, createMockProvider());

      expect(mockBillOverageForOrg).toHaveBeenCalledWith(
        "org_1",
        new Date("2025-01-01"),
        new Date("2025-02-01"),
        { invoiceId: "in_closing" }
      );
    });

    it("ignores invoices that do not close a cycle", async () => {
      mockSelectReturning([closedPeriod]);

      const event = makeEvent("invoice.created", {
        providerSubscriptionId: "sub_1",
        invoiceId: "in_oneoff",
        billingReason: "subscription_update",
      });

      await handleBillingEvent(event, createMockProvider());

      expect(mockBillOverageForOrg).not.toHaveBeenCalled();
    });

    it("skips when the subscription row already advanced past the closed period", async () => {
      mockSelectReturning([
        {
          ...closedPeriod,
          currentPeriodStart: new Date("2099-01-01"),
          currentPeriodEnd: new Date("2099-02-01"),
        },
      ]);

      const event = makeEvent("invoice.created", {
        providerSubscriptionId: "sub_1",
        invoiceId: "in_closing",
        billingReason: "subscription_cycle",
      });

      await handleBillingEvent(event, createMockProvider());

      expect(mockBillOverageForOrg).not.toHaveBeenCalled();
    });

    it("does not throw when billing the closing invoice fails", async () => {
      mockSelectReturning([closedPeriod]);
      mockBillOverageForOrg.mockRejectedValue(new Error("Stripe down"));

      const event = makeEvent("invoice.created", {
        providerSubscriptionId: "sub_1",
        invoiceId: "in_closing",
        billingReason: "subscription_cycle",
      });

      await expect(
        handleBillingEvent(event, createMockProvider())
      ).resolves.toBeUndefined();
    });
  });

  describe("subscription.updated", () => {
    it("updates plan when price changes", async () => {
      mockSelectReturning([
        {
          providerSubscriptionId: "sub_1",
          providerPriceId: process.env.STRIPE_PRICE_PRO_25K_MONTHLY,
          plan: "pro",
          tier: "25k",
          status: SUBSCRIPTION_STATUS.ACTIVE,
          cancelAtPeriodEnd: false,
          currentPeriodStart: new Date("2025-01-01"),
          currentPeriodEnd: new Date("2025-02-01"),
        },
      ]);

      const provider = createMockProvider();
      const event = makeEvent("subscription.updated", {
        providerSubscriptionId: "sub_1",
        priceId: process.env.STRIPE_PRICE_PRO_50K_MONTHLY,
        status: SUBSCRIPTION_STATUS.ACTIVE,
        cancelAtPeriodEnd: false,
        periodStart: new Date("2025-01-01"),
        periodEnd: new Date("2025-02-01"),
      });

      await handleBillingEvent(event, provider);

      expect(db.update).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          plan: "pro",
          tier: "50k",
          providerPriceId: process.env.STRIPE_PRICE_PRO_50K_MONTHLY,
        })
      );
    });

    it("emits a conversion metric on trialing -> active", async () => {
      mockSelectReturning([
        {
          organizationId: "org_1",
          providerSubscriptionId: "sub_1",
          providerPriceId: process.env.STRIPE_PRICE_PRO_25K_MONTHLY,
          plan: "pro",
          tier: "25k",
          status: SUBSCRIPTION_STATUS.TRIALING,
          cancelAtPeriodEnd: false,
          currentPeriodStart: new Date("2025-01-01"),
          currentPeriodEnd: new Date("2025-01-15"),
        },
      ]);

      const provider = createMockProvider();
      const event = makeEvent("subscription.updated", {
        providerSubscriptionId: "sub_1",
        priceId: process.env.STRIPE_PRICE_PRO_25K_MONTHLY,
        status: SUBSCRIPTION_STATUS.ACTIVE,
        cancelAtPeriodEnd: false,
        periodStart: new Date("2025-01-15"),
        periodEnd: new Date("2025-02-15"),
      });

      await handleBillingEvent(event, provider);

      expect(mockIncrementCounter).toHaveBeenCalledWith(
        MetricNames.BILLING_TRIAL_CONVERTED,
        expect.objectContaining({ plan: "pro", tier: "25k" })
      );
    });

    it("does not emit a conversion metric when already active", async () => {
      mockSelectReturning([
        {
          organizationId: "org_1",
          providerSubscriptionId: "sub_1",
          providerPriceId: process.env.STRIPE_PRICE_PRO_25K_MONTHLY,
          plan: "pro",
          tier: "25k",
          status: SUBSCRIPTION_STATUS.ACTIVE,
          cancelAtPeriodEnd: false,
          currentPeriodStart: new Date("2025-01-01"),
          currentPeriodEnd: new Date("2025-02-01"),
        },
      ]);

      const provider = createMockProvider();
      const event = makeEvent("subscription.updated", {
        providerSubscriptionId: "sub_1",
        priceId: process.env.STRIPE_PRICE_PRO_25K_MONTHLY,
        status: SUBSCRIPTION_STATUS.ACTIVE,
        cancelAtPeriodEnd: false,
        periodStart: new Date("2025-01-01"),
        periodEnd: new Date("2025-02-01"),
      });

      await handleBillingEvent(event, provider);

      expect(mockIncrementCounter).not.toHaveBeenCalledWith(
        MetricNames.BILLING_TRIAL_CONVERTED,
        expect.anything()
      );
    });

    it("preserves plan on cancel-at-period-end (same priceId)", async () => {
      mockSelectReturning([
        {
          providerSubscriptionId: "sub_1",
          providerPriceId: process.env.STRIPE_PRICE_PRO_25K_MONTHLY,
          plan: "pro",
          tier: "25k",
          status: SUBSCRIPTION_STATUS.ACTIVE,
          cancelAtPeriodEnd: false,
          currentPeriodStart: new Date("2025-01-01"),
          currentPeriodEnd: new Date("2025-02-01"),
        },
      ]);

      const provider = createMockProvider();
      const event = makeEvent("subscription.updated", {
        providerSubscriptionId: "sub_1",
        priceId: process.env.STRIPE_PRICE_PRO_25K_MONTHLY,
        status: SUBSCRIPTION_STATUS.ACTIVE,
        cancelAtPeriodEnd: true,
      });

      await handleBillingEvent(event, provider);

      expect(db.update).toHaveBeenCalled();
      const setArg = mockSet.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.plan).toBeUndefined();
      expect(setArg.tier).toBeUndefined();
      expect(setArg.cancelAtPeriodEnd).toBe(true);
    });

    it("skips when no matching subscription row found", async () => {
      mockSelectReturning([]);

      const provider = createMockProvider();
      const event = makeEvent("subscription.updated", {
        providerSubscriptionId: "sub_unknown",
        status: SUBSCRIPTION_STATUS.ACTIVE,
      });

      await handleBillingEvent(event, provider);

      expect(db.update).not.toHaveBeenCalled();
    });

    it("skips when providerSubscriptionId is missing", async () => {
      const provider = createMockProvider();
      const event = makeEvent("subscription.updated", {});

      await handleBillingEvent(event, provider);

      expect(db.select).not.toHaveBeenCalled();
    });

    it("bills overage before updating subscription on period rollover", async () => {
      const oldStart = new Date("2025-01-01");
      const oldEnd = new Date("2025-02-01");
      const newStart = new Date("2025-02-01");
      const newEnd = new Date("2025-03-01");

      mockSelectReturning([
        {
          providerSubscriptionId: "sub_1",
          organizationId: "org_1",
          providerPriceId: process.env.STRIPE_PRICE_PRO_25K_MONTHLY,
          plan: "pro",
          tier: "25k",
          status: SUBSCRIPTION_STATUS.ACTIVE,
          cancelAtPeriodEnd: false,
          currentPeriodStart: oldStart,
          currentPeriodEnd: oldEnd,
        },
      ]);

      const provider = createMockProvider();
      const event = makeEvent("subscription.updated", {
        providerSubscriptionId: "sub_1",
        priceId: process.env.STRIPE_PRICE_PRO_25K_MONTHLY,
        status: SUBSCRIPTION_STATUS.ACTIVE,
        cancelAtPeriodEnd: false,
        periodStart: newStart,
        periodEnd: newEnd,
      });

      await handleBillingEvent(event, provider);

      expect(mockBillOverageForOrg).toHaveBeenCalledWith(
        "org_1",
        oldStart,
        oldEnd
      );
      expect(db.update).toHaveBeenCalled();
    });

    it("still updates subscription when overage billing fails", async () => {
      const oldStart = new Date("2025-01-01");
      const oldEnd = new Date("2025-02-01");
      const newStart = new Date("2025-02-01");
      const newEnd = new Date("2025-03-01");

      mockSelectReturning([
        {
          providerSubscriptionId: "sub_1",
          organizationId: "org_1",
          providerPriceId: process.env.STRIPE_PRICE_PRO_25K_MONTHLY,
          plan: "pro",
          tier: "25k",
          status: SUBSCRIPTION_STATUS.ACTIVE,
          cancelAtPeriodEnd: false,
          currentPeriodStart: oldStart,
          currentPeriodEnd: oldEnd,
        },
      ]);

      mockBillOverageForOrg.mockRejectedValue(new Error("Stripe error"));

      const provider = createMockProvider();
      const event = makeEvent("subscription.updated", {
        providerSubscriptionId: "sub_1",
        priceId: process.env.STRIPE_PRICE_PRO_25K_MONTHLY,
        status: SUBSCRIPTION_STATUS.ACTIVE,
        cancelAtPeriodEnd: false,
        periodStart: newStart,
        periodEnd: newEnd,
      });

      await handleBillingEvent(event, provider);

      expect(mockBillOverageForOrg).toHaveBeenCalled();
      expect(db.update).toHaveBeenCalled();
    });

    it("skips overage billing when period has not rolled", async () => {
      const sameStart = new Date("2025-01-01");
      const sameEnd = new Date("2025-02-01");

      mockSelectReturning([
        {
          providerSubscriptionId: "sub_1",
          organizationId: "org_1",
          providerPriceId: process.env.STRIPE_PRICE_PRO_25K_MONTHLY,
          plan: "pro",
          tier: "25k",
          status: SUBSCRIPTION_STATUS.ACTIVE,
          cancelAtPeriodEnd: false,
          currentPeriodStart: sameStart,
          currentPeriodEnd: sameEnd,
        },
      ]);

      const provider = createMockProvider();
      const event = makeEvent("subscription.updated", {
        providerSubscriptionId: "sub_1",
        priceId: process.env.STRIPE_PRICE_PRO_25K_MONTHLY,
        status: SUBSCRIPTION_STATUS.ACTIVE,
        cancelAtPeriodEnd: false,
        periodStart: sameStart,
        periodEnd: sameEnd,
      });

      await handleBillingEvent(event, provider);

      expect(mockBillOverageForOrg).not.toHaveBeenCalled();
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe("subscription.deleted", () => {
    // The provider ends a subscription early when its payment retries run out.
    // Keeping the plan to the period end handed an unpaid org the paid plan.
    it("resets to free when the provider ends it before the period end", async () => {
      const futureDate = new Date(Date.now() + 86_400_000 * 30);
      mockSelectReturning([
        {
          providerSubscriptionId: "sub_1",
          currentPeriodEnd: futureDate,
          plan: "pro",
        },
      ]);

      await handleBillingEvent(
        makeEvent("subscription.deleted", {
          providerSubscriptionId: "sub_1",
          periodEnd: futureDate,
        }),
        createMockProvider()
      );

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          plan: "free",
          tier: null,
          status: SUBSCRIPTION_STATUS.CANCELED,
          cancelAtPeriodEnd: false,
        })
      );
    });

    it("resets to free when period has ended", async () => {
      const pastDate = new Date(Date.now() - 86_400_000);
      mockSelectReturning([
        {
          providerSubscriptionId: "sub_1",
          currentPeriodEnd: pastDate,
          plan: "pro",
        },
      ]);

      const provider = createMockProvider();
      const event = makeEvent("subscription.deleted", {
        providerSubscriptionId: "sub_1",
      });

      await handleBillingEvent(event, provider);

      expect(db.update).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          plan: "free",
          tier: null,
          status: SUBSCRIPTION_STATUS.CANCELED,
        })
      );
    });

    // Clearing the ids left no record that the org ever held this
    // subscription, so a churned trial fell outside the trials query.
    it("keeps the provider ids on the churned row", async () => {
      const pastDate = new Date(Date.now() - 86_400_000);
      mockSelectReturning([
        {
          providerSubscriptionId: "sub_1",
          providerPriceId: "price_1",
          currentPeriodEnd: pastDate,
          plan: "pro",
        },
      ]);

      const provider = createMockProvider();
      const event = makeEvent("subscription.deleted", {
        providerSubscriptionId: "sub_1",
      });

      await handleBillingEvent(event, provider);

      const setArg = mockSet.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg).not.toHaveProperty("providerSubscriptionId");
      expect(setArg).not.toHaveProperty("providerPriceId");
    });

    it("keeps debt when resetting to free", async () => {
      const pastDate = new Date(Date.now() - 86_400_000);
      mockSelectReturning([
        {
          providerSubscriptionId: "sub_1",
          organizationId: "org_1",
          currentPeriodEnd: pastDate,
          plan: "pro",
        },
      ]);

      const provider = createMockProvider();
      const event = makeEvent("subscription.deleted", {
        providerSubscriptionId: "sub_1",
      });

      await handleBillingEvent(event, provider);

      expect(mockClearAllDebtForOrg).not.toHaveBeenCalled();
    });

    it("cuts the period's gas credit to free", async () => {
      const periodStart = new Date("2026-09-29T16:37:46Z");
      mockSelectReturning([
        {
          providerSubscriptionId: "sub_1",
          organizationId: "org_1",
          currentPeriodStart: periodStart,
          currentPeriodEnd: new Date(Date.now() + 86_400_000 * 20),
          plan: "pro",
          planOverrides: null,
        },
      ]);

      await handleBillingEvent(
        makeEvent("subscription.deleted", { providerSubscriptionId: "sub_1" }),
        createMockProvider()
      );

      expect(mockLowerGasAllocationToPlan).toHaveBeenCalledWith(
        "org_1",
        periodStart,
        "free",
        null
      );
    });

    it("bills the final period before the row drops to free", async () => {
      const pastDate = new Date(Date.now() - 86_400_000);
      const row = {
        providerSubscriptionId: "sub_1",
        organizationId: "org_1",
        providerCustomerId: "cus_1",
        currentPeriodStart: new Date("2025-01-01"),
        currentPeriodEnd: pastDate,
        plan: "pro",
      };
      mockSelectReturning([row]);

      await handleBillingEvent(
        makeEvent("subscription.deleted", { providerSubscriptionId: "sub_1" }),
        createMockProvider()
      );

      expect(mockCollectFinalPeriodOverage).toHaveBeenCalledWith(
        "org_1",
        row.currentPeriodStart,
        pastDate,
        "cus_1"
      );
      // Order matters: billing reads the plan off the row, and a free row bills
      // nothing.
      const billOrder =
        mockCollectFinalPeriodOverage.mock.invocationCallOrder[0];
      const resetOrder = mockSet.mock.invocationCallOrder[0];
      expect(billOrder).toBeLessThan(resetOrder);
    });

    it("bills the usage so far when the provider ends it early", async () => {
      const futureDate = new Date(Date.now() + 86_400_000 * 30);
      const row = {
        providerSubscriptionId: "sub_1",
        organizationId: "org_1",
        providerCustomerId: "cus_1",
        currentPeriodStart: new Date("2025-01-01"),
        currentPeriodEnd: futureDate,
        plan: "pro",
      };
      mockSelectReturning([row]);

      await handleBillingEvent(
        makeEvent("subscription.deleted", { providerSubscriptionId: "sub_1" }),
        createMockProvider()
      );

      expect(mockCollectFinalPeriodOverage).toHaveBeenCalledWith(
        "org_1",
        row.currentPeriodStart,
        futureDate,
        "cus_1"
      );
    });

    it("still downgrades when the final charge fails", async () => {
      const pastDate = new Date(Date.now() - 86_400_000);
      mockSelectReturning([
        {
          providerSubscriptionId: "sub_1",
          organizationId: "org_1",
          providerCustomerId: "cus_1",
          currentPeriodStart: new Date("2025-01-01"),
          currentPeriodEnd: pastDate,
          plan: "pro",
        },
      ]);
      mockCollectFinalPeriodOverage.mockRejectedValue(new Error("Stripe down"));

      await handleBillingEvent(
        makeEvent("subscription.deleted", { providerSubscriptionId: "sub_1" }),
        createMockProvider()
      );

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ plan: "free" })
      );
    });

    it("skips billing when the org has no customer on file", async () => {
      const pastDate = new Date(Date.now() - 86_400_000);
      mockSelectReturning([
        {
          providerSubscriptionId: "sub_1",
          organizationId: "org_1",
          providerCustomerId: null,
          currentPeriodStart: new Date("2025-01-01"),
          currentPeriodEnd: pastDate,
          plan: "pro",
        },
      ]);

      await handleBillingEvent(
        makeEvent("subscription.deleted", { providerSubscriptionId: "sub_1" }),
        createMockProvider()
      );

      expect(mockCollectFinalPeriodOverage).not.toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ plan: "free" })
      );
    });

    it("skips when providerSubscriptionId is missing", async () => {
      const provider = createMockProvider();
      const event = makeEvent("subscription.deleted", {});

      await handleBillingEvent(event, provider);

      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe("invoice.paid", () => {
    // A paid invoice proves an invoice was paid, not that the
    // subscription is active. The provider is the authority for the status.
    function providerReporting(status: string): BillingProvider {
      return createMockProvider({
        getSubscriptionDetails: vi.fn().mockResolvedValue({
          priceId: process.env.STRIPE_PRICE_PRO_25K_MONTHLY,
          status,
          cancelAtPeriodEnd: false,
          periodStart: new Date("2025-01-01"),
          periodEnd: new Date("2025-02-01"),
        }),
      });
    }

    it("takes the status from the provider and clears billing alerts", async () => {
      const provider = providerReporting(SUBSCRIPTION_STATUS.ACTIVE);
      const event = makeEvent("invoice.paid", {
        providerSubscriptionId: "sub_1",
        invoiceId: "inv_1",
      });

      await handleBillingEvent(event, provider);

      expect(provider.getSubscriptionDetails).toHaveBeenCalledWith("sub_1");
      expect(db.update).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: SUBSCRIPTION_STATUS.ACTIVE,
          billingAlert: null,
          billingAlertUrl: null,
        })
      );
    });

    // The $0 invoice the provider issues at trial start is paid immediately.
    // Before the fix that event overwrote SUBSCRIPTION_STATUS.TRIALING with SUBSCRIPTION_STATUS.ACTIVE.
    it("leaves a trialing subscription trialing", async () => {
      mockSelectReturning([
        {
          organizationId: "org_1",
          providerSubscriptionId: "sub_1",
          plan: "pro",
          tier: "25k",
          status: SUBSCRIPTION_STATUS.TRIALING,
        },
      ]);

      const provider = providerReporting(SUBSCRIPTION_STATUS.TRIALING);
      const event = makeEvent("invoice.paid", {
        providerSubscriptionId: "sub_1",
        invoiceId: "inv_trial_zero",
      });

      await handleBillingEvent(event, provider);

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ status: SUBSCRIPTION_STATUS.TRIALING })
      );
      expect(mockIncrementCounter).not.toHaveBeenCalledWith(
        MetricNames.BILLING_TRIAL_CONVERTED,
        expect.anything()
      );
    });

    it("restores a past_due subscription once its invoice is paid", async () => {
      mockSelectReturning([
        {
          organizationId: "org_1",
          providerSubscriptionId: "sub_1",
          plan: "pro",
          tier: "25k",
          status: SUBSCRIPTION_STATUS.PAST_DUE,
        },
      ]);

      const provider = providerReporting(SUBSCRIPTION_STATUS.ACTIVE);
      const event = makeEvent("invoice.paid", {
        providerSubscriptionId: "sub_1",
        invoiceId: "inv_retry",
      });

      await handleBillingEvent(event, provider);

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ status: SUBSCRIPTION_STATUS.ACTIVE })
      );
    });

    it("restores the subscribed plan once a dropped subscription is paid", async () => {
      mockSelectReturning([
        {
          organizationId: "org_1",
          providerSubscriptionId: "sub_1",
          providerPriceId: process.env.STRIPE_PRICE_PRO_25K_MONTHLY,
          plan: "free",
          tier: null,
          status: SUBSCRIPTION_STATUS.PAST_DUE,
        },
      ]);

      await handleBillingEvent(
        makeEvent("invoice.paid", {
          providerSubscriptionId: "sub_1",
          invoiceId: "inv_retry",
        }),
        providerReporting(SUBSCRIPTION_STATUS.ACTIVE)
      );

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: SUBSCRIPTION_STATUS.ACTIVE,
          plan: "pro",
          tier: "25k",
        })
      );
    });

    it("does not restore a plan on a subscription that is not active", async () => {
      mockSelectReturning([
        {
          organizationId: "org_1",
          providerSubscriptionId: "sub_1",
          plan: "free",
          tier: null,
          status: SUBSCRIPTION_STATUS.CANCELED,
        },
      ]);

      await handleBillingEvent(
        makeEvent("invoice.paid", {
          providerSubscriptionId: "sub_1",
          invoiceId: "inv_late",
        }),
        providerReporting(SUBSCRIPTION_STATUS.CANCELED)
      );

      const setArg = mockSet.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg).not.toHaveProperty("plan");
    });

    it("counts the conversion when it lands the trialing -> active move", async () => {
      mockSelectReturning([
        {
          organizationId: "org_1",
          providerSubscriptionId: "sub_1",
          plan: "pro",
          tier: "25k",
          status: SUBSCRIPTION_STATUS.TRIALING,
        },
      ]);

      const provider = providerReporting(SUBSCRIPTION_STATUS.ACTIVE);
      const event = makeEvent("invoice.paid", {
        providerSubscriptionId: "sub_1",
        invoiceId: "inv_first_charge",
      });

      await handleBillingEvent(event, provider);

      expect(mockIncrementCounter).toHaveBeenCalledWith(
        MetricNames.BILLING_TRIAL_CONVERTED,
        { plan: "pro", tier: "25k" }
      );
    });

    it("leaves the stored status alone when the provider cannot be read", async () => {
      mockSelectReturning([
        {
          organizationId: "org_1",
          providerSubscriptionId: "sub_1",
          plan: "pro",
          status: SUBSCRIPTION_STATUS.TRIALING,
        },
      ]);

      const provider = createMockProvider({
        getSubscriptionDetails: vi
          .fn()
          .mockRejectedValue(new Error("provider unreachable")),
      });
      const event = makeEvent("invoice.paid", {
        providerSubscriptionId: "sub_1",
        invoiceId: "inv_1",
      });

      await handleBillingEvent(event, provider);

      const setArg = mockSet.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg).not.toHaveProperty("status");
      expect(setArg).toMatchObject({
        billingAlert: null,
        billingAlertUrl: null,
      });
    });

    it("clears debt when invoiceId is present", async () => {
      const provider = createMockProvider();
      const event = makeEvent("invoice.paid", {
        providerSubscriptionId: "sub_1",
        invoiceId: "inv_123",
      });

      await handleBillingEvent(event, provider);

      expect(mockClearDebtForInvoice).toHaveBeenCalledWith("inv_123");
    });

    it("handles invoice without subscriptionId via customer ID fallback", async () => {
      mockSelectReturning([
        {
          organizationId: "org_1",
          providerCustomerId: "cus_123",
          providerSubscriptionId: null,
        },
      ]);

      const provider = createMockProvider();
      const event = makeEvent("invoice.paid", {
        invoiceId: "inv_standalone",
        providerCustomerId: "cus_123",
      });

      await handleBillingEvent(event, provider);

      expect(mockClearDebtForInvoice).toHaveBeenCalledWith("inv_standalone");
      expect(db.update).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          billingAlert: null,
          billingAlertUrl: null,
        })
      );
    });

    it("does not clear debt when no invoiceId", async () => {
      const provider = createMockProvider();
      const event = makeEvent("invoice.paid", {
        providerSubscriptionId: "sub_1",
      });

      await handleBillingEvent(event, provider);

      expect(mockClearDebtForInvoice).not.toHaveBeenCalled();
    });
  });

  describe("invoice.paid -- overage attribution (F-023 / KEEP-748)", () => {
    function stampCount(invoiceId: string): number {
      return mockSet.mock.calls.filter(
        ([arg]) =>
          (arg as Record<string, unknown>)?.providerInvoiceId === invoiceId
      ).length;
    }

    it("attributes ONLY records whose item belongs to the paid invoice", async () => {
      mockSelectReturning(
        [{ organizationId: "org_1", providerSubscriptionId: "sub_1" }],
        [
          { id: "ov_match", providerInvoiceItemId: "item_match" },
          { id: "ov_other", providerInvoiceItemId: "item_other" },
        ]
      );

      const provider = createMockProvider({
        getInvoiceForItem: vi.fn((itemId: string) =>
          Promise.resolve(
            itemId === "item_match"
              ? { invoiceId: "inv_paid", status: "paid", paid: true }
              : { invoiceId: "inv_unrelated", status: "open", paid: false }
          )
        ),
      });
      const event = makeEvent("invoice.paid", {
        providerSubscriptionId: "sub_1",
        invoiceId: "inv_paid",
      });

      await handleBillingEvent(event, provider);

      expect(provider.getInvoiceForItem).toHaveBeenCalledWith("item_match");
      expect(provider.getInvoiceForItem).toHaveBeenCalledWith("item_other");
      // Only the matching record is stamped with the paid invoice; the record
      // whose item lives on a different invoice is left untouched (the F-023
      // laundering the old broad UPDATE allowed).
      expect(stampCount("inv_paid")).toBe(1);
    });

    it("never attributes a record that has no invoice-item link", async () => {
      mockSelectReturning(
        [{ organizationId: "org_1", providerSubscriptionId: "sub_1" }],
        [{ id: "ov_noitem", providerInvoiceItemId: null }]
      );

      const provider = createMockProvider();
      const event = makeEvent("invoice.paid", {
        providerSubscriptionId: "sub_1",
        invoiceId: "inv_paid",
      });

      await handleBillingEvent(event, provider);

      expect(provider.getInvoiceForItem).not.toHaveBeenCalled();
      expect(stampCount("inv_paid")).toBe(0);
    });
  });

  describe("invoice.payment_failed", () => {
    it("sets past_due status and payment_failed alert", async () => {
      const provider = createMockProvider();
      const event = makeEvent("invoice.payment_failed", {
        providerSubscriptionId: "sub_1",
        invoiceUrl: "https://invoice.stripe.com/i/123",
      });

      await handleBillingEvent(event, provider);

      expect(db.update).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: SUBSCRIPTION_STATUS.PAST_DUE,
          billingAlert: "payment_failed",
          billingAlertUrl: "https://invoice.stripe.com/i/123",
        })
      );
    });

    it("drops a never-paid subscription to free", async () => {
      mockSelectReturning([
        {
          organizationId: "org_1",
          providerSubscriptionId: "sub_1",
          plan: "business",
          tier: null,
          status: SUBSCRIPTION_STATUS.TRIALING,
        },
      ]);
      const provider = createMockProvider({
        hasPaidInvoice: vi.fn().mockResolvedValue(false),
      });

      await handleBillingEvent(
        makeEvent("invoice.payment_failed", {
          providerSubscriptionId: "sub_1",
        }),
        provider
      );

      expect(provider.hasPaidInvoice).toHaveBeenCalledWith("sub_1");
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          plan: "free",
          tier: null,
          status: SUBSCRIPTION_STATUS.PAST_DUE,
          billingAlert: "payment_failed",
        })
      );
    });

    it("cuts the period's gas credit to free before the plan write", async () => {
      const periodStart = new Date("2026-09-29T16:37:46Z");
      mockSelectReturning([
        {
          organizationId: "org_1",
          providerSubscriptionId: "sub_1",
          plan: "pro",
          tier: "25k",
          status: SUBSCRIPTION_STATUS.TRIALING,
          currentPeriodStart: periodStart,
          planOverrides: null,
        },
      ]);

      await handleBillingEvent(
        makeEvent("invoice.payment_failed", {
          providerSubscriptionId: "sub_1",
        }),
        createMockProvider({
          hasPaidInvoice: vi.fn().mockResolvedValue(false),
        })
      );

      expect(mockLowerGasAllocationToPlan).toHaveBeenCalledWith(
        "org_1",
        periodStart,
        "free",
        null
      );
      expect(
        mockLowerGasAllocationToPlan.mock.invocationCallOrder[0]
      ).toBeLessThan(mockSet.mock.invocationCallOrder[0]);
    });

    it("leaves the plan in place when the gas credit cut fails, so the event retries", async () => {
      mockSelectReturning([
        {
          organizationId: "org_1",
          providerSubscriptionId: "sub_1",
          plan: "pro",
          status: SUBSCRIPTION_STATUS.TRIALING,
          currentPeriodStart: new Date("2026-09-29T16:37:46Z"),
        },
      ]);
      mockLowerGasAllocationToPlan.mockRejectedValue(new Error("db down"));

      await expect(
        handleBillingEvent(
          makeEvent("invoice.payment_failed", {
            providerSubscriptionId: "sub_1",
          }),
          createMockProvider({
            hasPaidInvoice: vi.fn().mockResolvedValue(false),
          })
        )
      ).rejects.toThrow("db down");
      expect(mockSet).not.toHaveBeenCalled();
    });

    it("keeps the plan of a customer that has paid before", async () => {
      mockSelectReturning([
        {
          organizationId: "org_1",
          providerSubscriptionId: "sub_1",
          plan: "pro",
          tier: "25k",
          status: SUBSCRIPTION_STATUS.ACTIVE,
        },
      ]);

      await handleBillingEvent(
        makeEvent("invoice.payment_failed", {
          providerSubscriptionId: "sub_1",
        }),
        createMockProvider()
      );

      const setArg = mockSet.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg).not.toHaveProperty("plan");
      expect(setArg).toMatchObject({ status: SUBSCRIPTION_STATUS.PAST_DUE });
      expect(mockLowerGasAllocationToPlan).not.toHaveBeenCalled();
    });

    it("keeps the plan when the invoice history cannot be read", async () => {
      mockSelectReturning([
        {
          organizationId: "org_1",
          providerSubscriptionId: "sub_1",
          plan: "pro",
          status: SUBSCRIPTION_STATUS.TRIALING,
        },
      ]);
      const provider = createMockProvider({
        hasPaidInvoice: vi.fn().mockRejectedValue(new Error("provider down")),
      });

      await handleBillingEvent(
        makeEvent("invoice.payment_failed", {
          providerSubscriptionId: "sub_1",
        }),
        provider
      );

      const setArg = mockSet.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg).not.toHaveProperty("plan");
    });

    it("does not reopen a canceled subscription as past_due", async () => {
      mockSelectReturning([
        {
          organizationId: "org_1",
          providerSubscriptionId: "sub_1",
          plan: "free",
          status: SUBSCRIPTION_STATUS.CANCELED,
        },
      ]);
      const provider = createMockProvider();

      await handleBillingEvent(
        makeEvent("invoice.payment_failed", {
          providerSubscriptionId: "sub_1",
        }),
        provider
      );

      const setArg = mockSet.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg).not.toHaveProperty("status");
      expect(provider.hasPaidInvoice).not.toHaveBeenCalled();
    });

    it("skips when providerSubscriptionId is missing", async () => {
      const provider = createMockProvider();
      const event = makeEvent("invoice.payment_failed", {});

      await handleBillingEvent(event, provider);

      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe("invoice.overdue", () => {
    it("sets overdue alert", async () => {
      const provider = createMockProvider();
      const event = makeEvent("invoice.overdue", {
        providerSubscriptionId: "sub_1",
        invoiceUrl: "https://invoice.stripe.com/i/456",
      });

      await handleBillingEvent(event, provider);

      expect(db.update).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          billingAlert: "overdue",
          billingAlertUrl: "https://invoice.stripe.com/i/456",
        })
      );
    });
  });

  describe("invoice.payment_action_required", () => {
    it("sets payment_action_required alert", async () => {
      const provider = createMockProvider();
      const event = makeEvent("invoice.payment_action_required", {
        providerSubscriptionId: "sub_1",
        invoiceUrl: "https://invoice.stripe.com/i/789",
      });

      await handleBillingEvent(event, provider);

      expect(db.update).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          billingAlert: "payment_action_required",
          billingAlertUrl: "https://invoice.stripe.com/i/789",
        })
      );
    });
  });
});
