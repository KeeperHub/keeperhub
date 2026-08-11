import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stripe", () => ({
  stripe: {
    customers: { create: vi.fn(), retrieve: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    billingPortal: { sessions: { create: vi.fn() } },
    webhooks: { constructEvent: vi.fn() },
    invoiceItems: { create: vi.fn() },
    invoices: { list: vi.fn(), createPreview: vi.fn() },
    subscriptions: { retrieve: vi.fn(), update: vi.fn(), list: vi.fn() },
    prices: { retrieve: vi.fn() },
    paymentMethods: { list: vi.fn() },
  },
}));

import {
  StripeBillingProvider,
  UnknownEventTypeError,
} from "@/lib/billing/providers/stripe";
import { stripe } from "@/lib/stripe";

// biome-ignore lint/style/noNonNullAssertion: stripe is mocked above and always defined in tests
const s = stripe!;
const provider = new StripeBillingProvider();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("StripeBillingProvider", () => {
  describe("createCustomer", () => {
    it("passes correct params to stripe.customers.create", async () => {
      vi.mocked(s.customers.create).mockResolvedValue({
        id: "cus_123",
      } as Awaited<ReturnType<typeof s.customers.create>>);

      const result = await provider.createCustomer({
        email: "user@test.com",
        organizationId: "org_1",
        userId: "usr_1",
      });

      expect(s.customers.create).toHaveBeenCalledWith({
        email: "user@test.com",
        metadata: { organizationId: "org_1", userId: "usr_1" },
      });
      expect(result).toEqual({ customerId: "cus_123" });
    });
  });

  describe("createCheckoutSession", () => {
    it("builds session with correct line_items and metadata", async () => {
      vi.mocked(s.checkout.sessions.create).mockResolvedValue({
        url: "https://checkout.stripe.com/session_1",
      } as Awaited<ReturnType<typeof s.checkout.sessions.create>>);

      const result = await provider.createCheckoutSession({
        customerId: "cus_123",
        priceId: "price_pro_25k",
        organizationId: "org_1",
        successUrl: "http://localhost/billing?checkout=success",
        cancelUrl: "http://localhost/billing?checkout=canceled",
      });

      expect(s.checkout.sessions.create).toHaveBeenCalledWith({
        customer: "cus_123",
        mode: "subscription",
        line_items: [{ price: "price_pro_25k", quantity: 1 }],
        success_url: "http://localhost/billing?checkout=success",
        cancel_url: "http://localhost/billing?checkout=canceled",
        allow_promotion_codes: true,
        payment_method_collection: "always",
        metadata: { organizationId: "org_1" },
      });
      expect(result).toEqual({
        url: "https://checkout.stripe.com/session_1",
      });
    });

    it("adds trial_period_days when a trial is requested", async () => {
      vi.mocked(s.checkout.sessions.create).mockResolvedValue({
        url: "https://checkout.stripe.com/session_trial",
      } as Awaited<ReturnType<typeof s.checkout.sessions.create>>);

      await provider.createCheckoutSession({
        customerId: "cus_123",
        priceId: "price_pro_25k",
        organizationId: "org_1",
        successUrl: "http://localhost/success",
        cancelUrl: "http://localhost/cancel",
        trialPeriodDays: 14,
      });

      expect(s.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          allow_promotion_codes: true,
          subscription_data: { trial_period_days: 14 },
        })
      );
    });

    it("throws when session URL is null", async () => {
      vi.mocked(s.checkout.sessions.create).mockResolvedValue({
        url: null,
      } as Awaited<ReturnType<typeof s.checkout.sessions.create>>);

      await expect(
        provider.createCheckoutSession({
          customerId: "cus_123",
          priceId: "price_pro_25k",
          organizationId: "org_1",
          successUrl: "http://localhost/success",
          cancelUrl: "http://localhost/cancel",
        })
      ).rejects.toThrow("Stripe checkout session did not return a URL");
    });
  });

  describe("createPortalSession", () => {
    it("creates portal session with return URL", async () => {
      vi.mocked(s.billingPortal.sessions.create).mockResolvedValue({
        url: "https://billing.stripe.com/portal",
      } as Awaited<ReturnType<typeof s.billingPortal.sessions.create>>);

      const result = await provider.createPortalSession(
        "cus_123",
        "http://localhost/billing"
      );

      expect(s.billingPortal.sessions.create).toHaveBeenCalledWith({
        customer: "cus_123",
        return_url: "http://localhost/billing",
      });
      expect(result).toEqual({ url: "https://billing.stripe.com/portal" });
    });
  });

  describe("verifyWebhook", () => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    it("normalizes checkout.session.completed event", async () => {
      vi.mocked(s.webhooks.constructEvent).mockReturnValue({
        id: "evt_1",
        type: "checkout.session.completed",
        data: {
          object: {
            subscription: "sub_1",
            metadata: { organizationId: "org_1" },
          },
        },
      } as unknown as ReturnType<typeof s.webhooks.constructEvent>);

      const result = await provider.verifyWebhook("body", "sig");

      expect(s.webhooks.constructEvent).toHaveBeenCalledWith(
        "body",
        "sig",
        webhookSecret
      );
      expect(result.type).toBe("checkout.completed");
      expect(result.data.providerSubscriptionId).toBe("sub_1");
      expect(result.data.organizationId).toBe("org_1");
    });

    it("normalizes customer.subscription.updated event", async () => {
      vi.mocked(s.webhooks.constructEvent).mockReturnValue({
        id: "evt_2",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_1",
            status: "active",
            cancel_at_period_end: false,
            cancel_at: null,
            start_date: 1_704_067_200,
            items: {
              data: [
                {
                  price: { id: "price_pro" },
                  current_period_start: 1_706_659_200,
                  current_period_end: 1_706_745_600,
                },
              ],
            },
          },
        },
      } as unknown as ReturnType<typeof s.webhooks.constructEvent>);

      const result = await provider.verifyWebhook("body", "sig");

      expect(result.type).toBe("subscription.updated");
      expect(result.data.providerSubscriptionId).toBe("sub_1");
      expect(result.data.status).toBe("active");
      expect(result.data.priceId).toBe("price_pro");
    });

    it("normalizes invoice.paid event", async () => {
      vi.mocked(s.webhooks.constructEvent).mockReturnValue({
        id: "evt_3",
        type: "invoice.paid",
        data: {
          object: {
            parent: {
              subscription_details: { subscription: "sub_1" },
            },
            hosted_invoice_url: "https://invoice.stripe.com/i/123",
          },
        },
      } as unknown as ReturnType<typeof s.webhooks.constructEvent>);

      const result = await provider.verifyWebhook("body", "sig");

      expect(result.type).toBe("invoice.paid");
      expect(result.data.providerSubscriptionId).toBe("sub_1");
      expect(result.data.invoiceUrl).toBe("https://invoice.stripe.com/i/123");
    });

    it("normalizes invoice.payment_failed event", async () => {
      vi.mocked(s.webhooks.constructEvent).mockReturnValue({
        id: "evt_4",
        type: "invoice.payment_failed",
        data: {
          object: {
            parent: {
              subscription_details: { subscription: "sub_1" },
            },
            hosted_invoice_url: "https://invoice.stripe.com/i/456",
          },
        },
      } as unknown as ReturnType<typeof s.webhooks.constructEvent>);

      const result = await provider.verifyWebhook("body", "sig");

      expect(result.type).toBe("invoice.payment_failed");
    });

    it("normalizes invoice.overdue event", async () => {
      vi.mocked(s.webhooks.constructEvent).mockReturnValue({
        id: "evt_5",
        type: "invoice.overdue",
        data: {
          object: {
            parent: null,
            hosted_invoice_url: null,
          },
        },
      } as unknown as ReturnType<typeof s.webhooks.constructEvent>);

      const result = await provider.verifyWebhook("body", "sig");

      expect(result.type).toBe("invoice.overdue");
    });

    it("normalizes customer.subscription.deleted event", async () => {
      vi.mocked(s.webhooks.constructEvent).mockReturnValue({
        id: "evt_6",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_1",
            status: "canceled",
            cancel_at_period_end: false,
            cancel_at: null,
            start_date: 1_704_067_200,
            items: {
              data: [
                {
                  price: { id: "price_pro" },
                  current_period_start: 1_706_659_200,
                  current_period_end: 1_706_745_600,
                },
              ],
            },
          },
        },
      } as unknown as ReturnType<typeof s.webhooks.constructEvent>);

      const result = await provider.verifyWebhook("body", "sig");

      expect(result.type).toBe("subscription.deleted");
    });

    it("throws UnknownEventTypeError for unhandled types", async () => {
      vi.mocked(s.webhooks.constructEvent).mockReturnValue({
        id: "evt_7",
        type: "payment_intent.succeeded",
        data: { object: {} },
      } as unknown as ReturnType<typeof s.webhooks.constructEvent>);

      await expect(provider.verifyWebhook("body", "sig")).rejects.toThrow(
        UnknownEventTypeError
      );
    });
  });

  describe("cancelSubscription", () => {
    it("sets cancel_at_period_end to true", async () => {
      vi.mocked(s.subscriptions.update).mockResolvedValue({
        id: "sub_1",
        cancel_at_period_end: true,
        items: {
          data: [{ current_period_end: 1_706_745_600 }],
        },
      } as unknown as Awaited<ReturnType<typeof s.subscriptions.update>>);

      const result = await provider.cancelSubscription("sub_1");

      expect(s.subscriptions.update).toHaveBeenCalledWith("sub_1", {
        cancel_at_period_end: true,
      });
      expect(result.cancelAtPeriodEnd).toBe(true);
      expect(result.periodEnd).toEqual(new Date(1_706_745_600 * 1000));
    });
  });

  describe("listInvoices", () => {
    it("maps Stripe invoice to InvoiceItem correctly", async () => {
      vi.mocked(s.invoices.list).mockResolvedValue({
        data: [
          {
            id: "inv_1",
            created: 1_704_067_200,
            amount_paid: 4900,
            currency: "usd",
            status: "paid",
            hosted_invoice_url: "https://invoice.stripe.com/i/1",
            invoice_pdf: "https://invoice.stripe.com/pdf/1",
            lines: {
              data: [
                {
                  description: "1 x Pro 25k (at $49.00 / month)",
                  amount: 4900,
                  period: { start: 1_704_067_200, end: 1_706_745_600 },
                  parent: {
                    subscription_item_details: { proration: false },
                  },
                },
              ],
            },
          },
        ],
        has_more: false,
      } as unknown as Awaited<ReturnType<typeof s.invoices.list>>);

      const result = await provider.listInvoices({
        customerId: "cus_123",
        limit: 10,
      });

      expect(result.invoices).toHaveLength(1);
      expect(result.hasMore).toBe(false);

      const invoice = result.invoices[0];
      expect(invoice.id).toBe("inv_1");
      expect(invoice.amount).toBe(4900);
      expect(invoice.currency).toBe("usd");
      expect(invoice.status).toBe("paid");
      expect(invoice.description).toBe("Pro 25k");
      expect(invoice.invoiceUrl).toBe("https://invoice.stripe.com/i/1");
      expect(invoice.pdfUrl).toBe("https://invoice.stripe.com/pdf/1");
    });

    it("passes startingAfter for pagination", async () => {
      vi.mocked(s.invoices.list).mockResolvedValue({
        data: [],
        has_more: false,
      } as unknown as Awaited<ReturnType<typeof s.invoices.list>>);

      await provider.listInvoices({
        customerId: "cus_123",
        limit: 10,
        startingAfter: "inv_prev",
      });

      expect(s.invoices.list).toHaveBeenCalledWith(
        expect.objectContaining({
          starting_after: "inv_prev",
        })
      );
    });
  });

  describe("getSubscriptionDetails", () => {
    it("retrieves and maps subscription", async () => {
      vi.mocked(s.subscriptions.retrieve).mockResolvedValue({
        id: "sub_1",
        status: "active",
        cancel_at_period_end: false,
        start_date: 1_704_067_200,
        items: {
          data: [
            {
              price: { id: "price_pro_25k" },
              current_period_start: 1_706_659_200,
              current_period_end: 1_706_745_600,
            },
          ],
        },
      } as unknown as Awaited<ReturnType<typeof s.subscriptions.retrieve>>);

      const result = await provider.getSubscriptionDetails("sub_1");

      expect(result.priceId).toBe("price_pro_25k");
      expect(result.status).toBe("active");
      expect(result.cancelAtPeriodEnd).toBe(false);
      expect(result.periodStart).toEqual(new Date(1_706_659_200 * 1000));
      expect(result.periodEnd).toEqual(new Date(1_706_745_600 * 1000));
    });
  });

  describe("updateSubscription", () => {
    it("updates subscription with new price (same interval)", async () => {
      vi.mocked(s.subscriptions.retrieve).mockResolvedValue({
        id: "sub_1",
        items: {
          data: [
            {
              id: "si_1",
              price: { id: "price_old", recurring: { interval: "month" } },
            },
          ],
        },
      } as unknown as Awaited<ReturnType<typeof s.subscriptions.retrieve>>);
      vi.mocked(s.prices.retrieve).mockResolvedValue({
        recurring: { interval: "month" },
      } as Awaited<ReturnType<typeof s.prices.retrieve>>);
      vi.mocked(s.subscriptions.update).mockResolvedValue({
        id: "sub_1",
      } as unknown as Awaited<ReturnType<typeof s.subscriptions.update>>);

      const result = await provider.updateSubscription("sub_1", "price_new");

      expect(s.subscriptions.update).toHaveBeenCalledWith("sub_1", {
        items: [{ id: "si_1", price: "price_new" }],
        proration_behavior: "always_invoice",
        payment_behavior: "error_if_incomplete",
        cancel_at_period_end: false,
      });
      expect(result.subscriptionId).toBe("sub_1");
    });

    it("ends the trial now when endTrial is set", async () => {
      vi.mocked(s.subscriptions.retrieve).mockResolvedValue({
        id: "sub_1",
        items: {
          data: [
            {
              id: "si_1",
              price: { id: "price_old", recurring: { interval: "month" } },
            },
          ],
        },
      } as unknown as Awaited<ReturnType<typeof s.subscriptions.retrieve>>);
      vi.mocked(s.prices.retrieve).mockResolvedValue({
        recurring: { interval: "month" },
      } as Awaited<ReturnType<typeof s.prices.retrieve>>);
      vi.mocked(s.subscriptions.update).mockResolvedValue({
        id: "sub_1",
      } as unknown as Awaited<ReturnType<typeof s.subscriptions.update>>);

      await provider.updateSubscription("sub_1", "price_new", {
        endTrial: true,
      });

      expect(s.subscriptions.update).toHaveBeenCalledWith(
        "sub_1",
        expect.objectContaining({ trial_end: "now" })
      );
    });

    it("resets billing_cycle_anchor when interval changes", async () => {
      vi.mocked(s.subscriptions.retrieve).mockResolvedValue({
        id: "sub_1",
        items: {
          data: [
            {
              id: "si_1",
              price: { id: "price_old", recurring: { interval: "month" } },
            },
          ],
        },
      } as unknown as Awaited<ReturnType<typeof s.subscriptions.retrieve>>);
      vi.mocked(s.prices.retrieve).mockResolvedValue({
        recurring: { interval: "year" },
      } as Awaited<ReturnType<typeof s.prices.retrieve>>);
      vi.mocked(s.subscriptions.update).mockResolvedValue({
        id: "sub_1",
      } as unknown as Awaited<ReturnType<typeof s.subscriptions.update>>);

      await provider.updateSubscription("sub_1", "price_new");

      expect(s.subscriptions.update).toHaveBeenCalledWith(
        "sub_1",
        expect.objectContaining({
          billing_cycle_anchor: "now",
        })
      );
    });

    it("throws when no subscription item found", async () => {
      vi.mocked(s.subscriptions.retrieve).mockResolvedValue({
        id: "sub_1",
        items: { data: [] },
      } as unknown as Awaited<ReturnType<typeof s.subscriptions.retrieve>>);

      await expect(
        provider.updateSubscription("sub_1", "price_new")
      ).rejects.toThrow("No subscription item found to update");
    });

    it("propagates Stripe error when payment fails", async () => {
      vi.mocked(s.subscriptions.retrieve).mockResolvedValue({
        id: "sub_1",
        items: {
          data: [
            {
              id: "si_1",
              price: { id: "price_old", recurring: { interval: "month" } },
            },
          ],
        },
      } as unknown as Awaited<ReturnType<typeof s.subscriptions.retrieve>>);
      vi.mocked(s.prices.retrieve).mockResolvedValue({
        recurring: { interval: "month" },
      } as Awaited<ReturnType<typeof s.prices.retrieve>>);
      vi.mocked(s.subscriptions.update).mockRejectedValue(
        new Error("Your card was declined.")
      );

      await expect(
        provider.updateSubscription("sub_1", "price_new")
      ).rejects.toThrow("Your card was declined.");
    });
  });

  describe("previewProration", () => {
    it("returns proration preview for same-interval change", async () => {
      vi.mocked(s.subscriptions.retrieve).mockResolvedValue({
        id: "sub_1",
        items: {
          data: [
            {
              id: "si_1",
              price: { id: "price_old", recurring: { interval: "month" } },
            },
          ],
        },
      } as unknown as Awaited<ReturnType<typeof s.subscriptions.retrieve>>);
      vi.mocked(s.prices.retrieve).mockResolvedValue({
        recurring: { interval: "month" },
      } as Awaited<ReturnType<typeof s.prices.retrieve>>);
      vi.mocked(s.invoices.createPreview).mockResolvedValue({
        period_end: 1_706_745_600,
        subtotal: 4000,
        amount_due: 4000,
        currency: "usd",
        lines: {
          data: [
            {
              description: "Unused time on Pro 25k",
              amount: -2000,
              parent: {
                subscription_item_details: { proration: true },
              },
            },
            {
              description: "Pro 50k",
              amount: 6000,
              parent: {
                subscription_item_details: { proration: false },
              },
            },
          ],
        },
      } as unknown as Awaited<ReturnType<typeof s.invoices.createPreview>>);

      const result = await provider.previewProration("sub_1", "price_new");

      expect(result.amountDue).toBe(4000);
      expect(result.subtotal).toBe(4000);
      expect(result.appliedBalance).toBe(0);
      expect(result.currency).toBe("usd");
      expect(result.lineItems).toHaveLength(2);
      expect(result.lineItems[0].proration).toBe(true);
      expect(result.lineItems[1].proration).toBe(false);
    });

    it("computes appliedBalance from total, not subtotal, when tax is present", async () => {
      vi.mocked(s.subscriptions.retrieve).mockResolvedValue({
        id: "sub_1",
        items: {
          data: [
            {
              id: "si_1",
              price: { id: "price_old", recurring: { interval: "month" } },
            },
          ],
        },
      } as unknown as Awaited<ReturnType<typeof s.subscriptions.retrieve>>);
      vi.mocked(s.prices.retrieve).mockResolvedValue({
        recurring: { interval: "month" },
      } as Awaited<ReturnType<typeof s.prices.retrieve>>);
      vi.mocked(s.invoices.createPreview).mockResolvedValue({
        period_end: 1_706_745_600,
        subtotal: 4000,
        total: 4400,
        amount_due: 3900,
        currency: "usd",
        lines: { data: [] },
      } as unknown as Awaited<ReturnType<typeof s.invoices.createPreview>>);

      const result = await provider.previewProration("sub_1", "price_new");

      expect(result.subtotal).toBe(4000);
      expect(result.amountDue).toBe(3900);
      expect(result.appliedBalance).toBe(-500);
    });

    it("includes proration_date for same-interval changes", async () => {
      vi.mocked(s.subscriptions.retrieve).mockResolvedValue({
        id: "sub_1",
        items: {
          data: [
            {
              id: "si_1",
              price: { id: "price_old", recurring: { interval: "month" } },
            },
          ],
        },
      } as unknown as Awaited<ReturnType<typeof s.subscriptions.retrieve>>);
      vi.mocked(s.prices.retrieve).mockResolvedValue({
        recurring: { interval: "month" },
      } as Awaited<ReturnType<typeof s.prices.retrieve>>);
      vi.mocked(s.invoices.createPreview).mockResolvedValue({
        period_end: null,
        subtotal: 0,
        amount_due: 0,
        currency: "usd",
        lines: { data: [] },
      } as unknown as Awaited<ReturnType<typeof s.invoices.createPreview>>);

      await provider.previewProration("sub_1", "price_new");

      const callArgs = vi.mocked(s.invoices.createPreview).mock.calls[0][0] as
        | Record<string, unknown>
        | undefined;
      const subDetails = (callArgs as Record<string, unknown> | undefined)
        ?.subscription_details as Record<string, unknown> | undefined;
      expect(subDetails?.proration_date).toBeDefined();
    });

    it("returns negative amountDue for downgrade with excess credit", async () => {
      vi.mocked(s.subscriptions.retrieve).mockResolvedValue({
        id: "sub_1",
        items: {
          data: [
            {
              id: "si_1",
              price: { id: "price_biz", recurring: { interval: "month" } },
            },
          ],
        },
      } as unknown as Awaited<ReturnType<typeof s.subscriptions.retrieve>>);
      vi.mocked(s.prices.retrieve).mockResolvedValue({
        recurring: { interval: "month" },
      } as Awaited<ReturnType<typeof s.prices.retrieve>>);
      vi.mocked(s.invoices.createPreview).mockResolvedValue({
        period_end: 1_706_745_600,
        subtotal: -15_000,
        total: -15_000,
        amount_due: 0,
        currency: "usd",
        lines: {
          data: [
            {
              description: "Unused time on Business 250k",
              amount: -20_000,
              parent: {
                subscription_item_details: { proration: true },
              },
            },
            {
              description: "Remaining time on Pro 25k",
              amount: 5000,
              parent: {
                subscription_item_details: { proration: true },
              },
            },
          ],
        },
      } as unknown as Awaited<ReturnType<typeof s.invoices.createPreview>>);

      const result = await provider.previewProration("sub_1", "price_pro");

      expect(result.amountDue).toBe(0);
      expect(result.subtotal).toBe(-15_000);
      expect(result.appliedBalance).toBe(15_000);
      expect(result.lineItems).toHaveLength(2);
      expect(result.lineItems[0].amount).toBe(-20_000);
      expect(result.lineItems[0].proration).toBe(true);
      expect(result.lineItems[1].amount).toBe(5000);
      expect(result.lineItems[1].proration).toBe(true);
    });

    it("reflects customer balance credit in appliedBalance", async () => {
      vi.mocked(s.subscriptions.retrieve).mockResolvedValue({
        id: "sub_1",
        items: {
          data: [
            {
              id: "si_1",
              price: { id: "price_old", recurring: { interval: "month" } },
            },
          ],
        },
      } as unknown as Awaited<ReturnType<typeof s.subscriptions.retrieve>>);
      vi.mocked(s.prices.retrieve).mockResolvedValue({
        recurring: { interval: "month" },
      } as Awaited<ReturnType<typeof s.prices.retrieve>>);
      vi.mocked(s.invoices.createPreview).mockResolvedValue({
        period_end: 1_706_745_600,
        subtotal: 6000,
        total: 6000,
        amount_due: 3500,
        currency: "usd",
        lines: {
          data: [
            {
              description: "Pro 50k",
              amount: 6000,
              parent: {
                subscription_item_details: { proration: false },
              },
            },
          ],
        },
      } as unknown as Awaited<ReturnType<typeof s.invoices.createPreview>>);

      const result = await provider.previewProration("sub_1", "price_new");

      expect(result.amountDue).toBe(3500);
      expect(result.subtotal).toBe(6000);
      expect(result.appliedBalance).toBe(-2500);
    });

    it("throws when no subscription item found", async () => {
      vi.mocked(s.subscriptions.retrieve).mockResolvedValue({
        id: "sub_1",
        items: { data: [] },
      } as unknown as Awaited<ReturnType<typeof s.subscriptions.retrieve>>);

      await expect(
        provider.previewProration("sub_1", "price_new")
      ).rejects.toThrow("No subscription item found to preview");
    });

    it("omits proration_date for interval changes", async () => {
      vi.mocked(s.subscriptions.retrieve).mockResolvedValue({
        id: "sub_1",
        items: {
          data: [
            {
              id: "si_1",
              price: { id: "price_old", recurring: { interval: "month" } },
            },
          ],
        },
      } as unknown as Awaited<ReturnType<typeof s.subscriptions.retrieve>>);
      vi.mocked(s.prices.retrieve).mockResolvedValue({
        recurring: { interval: "year" },
      } as Awaited<ReturnType<typeof s.prices.retrieve>>);
      vi.mocked(s.invoices.createPreview).mockResolvedValue({
        period_end: null,
        subtotal: 0,
        amount_due: 0,
        currency: "usd",
        lines: { data: [] },
      } as unknown as Awaited<ReturnType<typeof s.invoices.createPreview>>);

      await provider.previewProration("sub_1", "price_new");

      const callArgs = vi.mocked(s.invoices.createPreview).mock.calls[0][0] as
        | Record<string, unknown>
        | undefined;
      const subDetails = (callArgs as Record<string, unknown> | undefined)
        ?.subscription_details as Record<string, unknown> | undefined;
      expect(subDetails?.proration_date).toBeUndefined();
    });
  });

  describe("createInvoiceItem", () => {
    it("passes correct params to stripe.invoiceItems.create", async () => {
      vi.mocked(s.invoiceItems.create).mockResolvedValue({
        id: "ii_123",
      } as Awaited<ReturnType<typeof s.invoiceItems.create>>);

      const result = await provider.createInvoiceItem({
        customerId: "cus_456",
        amount: 400,
        currency: "usd",
        description: "Overage: 2 blocks of 1000 executions",
        metadata: { organizationId: "org_1", period: "2025-01" },
      });

      expect(s.invoiceItems.create).toHaveBeenCalledWith({
        customer: "cus_456",
        amount: 400,
        currency: "usd",
        description: "Overage: 2 blocks of 1000 executions",
        metadata: { organizationId: "org_1", period: "2025-01" },
      });
      expect(result).toEqual({ invoiceItemId: "ii_123" });
    });

    it("passes empty metadata when none provided", async () => {
      vi.mocked(s.invoiceItems.create).mockResolvedValue({
        id: "ii_456",
      } as Awaited<ReturnType<typeof s.invoiceItems.create>>);

      await provider.createInvoiceItem({
        customerId: "cus_789",
        amount: 200,
        currency: "usd",
        description: "Overage charge",
      });

      const callArgs = vi.mocked(s.invoiceItems.create).mock
        .calls[0][0] as Record<string, unknown>;
      expect(callArgs.metadata).toBeUndefined();
    });
  });

  describe("getBillingDetails", () => {
    const customerBase = {
      id: "cus_1",
      deleted: false,
      email: "user@test.com",
      invoice_settings: { default_payment_method: null },
    };

    function makeCard(last4: string): Record<string, unknown> {
      return {
        id: `pm_${last4}`,
        type: "card",
        card: {
          brand: "visa",
          last4,
          exp_month: 12,
          exp_year: 2030,
        },
      };
    }

    type CustomerResponse = Awaited<ReturnType<typeof s.customers.retrieve>>;
    type SubsListResponse = Awaited<ReturnType<typeof s.subscriptions.list>>;
    type PMListResponse = Awaited<ReturnType<typeof s.paymentMethods.list>>;

    it("tier 1: returns the customer's default payment method", async () => {
      vi.mocked(s.customers.retrieve).mockResolvedValue({
        ...customerBase,
        invoice_settings: { default_payment_method: makeCard("1111") },
      } as unknown as CustomerResponse);

      const result = await provider.getBillingDetails("cus_1");

      expect(result).toEqual({
        paymentMethod: {
          brand: "visa",
          last4: "1111",
          expMonth: 12,
          expYear: 2030,
        },
        billingEmail: "user@test.com",
      });
      expect(s.subscriptions.list).not.toHaveBeenCalled();
      expect(s.paymentMethods.list).not.toHaveBeenCalled();
    });

    it("tier 2: returns the active subscription's default PM when customer has none", async () => {
      vi.mocked(s.customers.retrieve).mockResolvedValue(
        customerBase as unknown as CustomerResponse
      );
      vi.mocked(s.subscriptions.list).mockResolvedValueOnce({
        data: [{ default_payment_method: makeCard("2222") }],
      } as unknown as SubsListResponse);

      const result = await provider.getBillingDetails("cus_1");

      expect(result.paymentMethod?.last4).toBe("2222");
      expect(s.subscriptions.list).toHaveBeenCalledTimes(1);
      expect(s.subscriptions.list).toHaveBeenCalledWith(
        expect.objectContaining({ status: "active" })
      );
      expect(s.paymentMethods.list).not.toHaveBeenCalled();
    });

    it("tier 2 fallback: queries status=all only when the active list is empty", async () => {
      vi.mocked(s.customers.retrieve).mockResolvedValue(
        customerBase as unknown as CustomerResponse
      );
      vi.mocked(s.subscriptions.list)
        .mockResolvedValueOnce({ data: [] } as unknown as SubsListResponse)
        .mockResolvedValueOnce({
          data: [{ default_payment_method: makeCard("3333") }],
        } as unknown as SubsListResponse);

      const result = await provider.getBillingDetails("cus_1");

      expect(result.paymentMethod?.last4).toBe("3333");
      expect(s.subscriptions.list).toHaveBeenCalledTimes(2);
      expect(vi.mocked(s.subscriptions.list).mock.calls[0][0]).toMatchObject({
        status: "active",
      });
      expect(vi.mocked(s.subscriptions.list).mock.calls[1][0]).toMatchObject({
        status: "all",
      });
      expect(s.paymentMethods.list).not.toHaveBeenCalled();
    });

    it("tier 3: falls back to paymentMethods.list when no subscription has a PM", async () => {
      vi.mocked(s.customers.retrieve).mockResolvedValue(
        customerBase as unknown as CustomerResponse
      );
      vi.mocked(s.subscriptions.list).mockResolvedValue({
        data: [],
      } as unknown as SubsListResponse);
      vi.mocked(s.paymentMethods.list).mockResolvedValue({
        data: [makeCard("4444")],
      } as unknown as PMListResponse);

      const result = await provider.getBillingDetails("cus_1");

      expect(result.paymentMethod?.last4).toBe("4444");
      expect(s.paymentMethods.list).toHaveBeenCalledWith(
        expect.objectContaining({ type: "card", limit: 1 })
      );
    });

    it("returns null paymentMethod when no card is found anywhere", async () => {
      vi.mocked(s.customers.retrieve).mockResolvedValue(
        customerBase as unknown as CustomerResponse
      );
      vi.mocked(s.subscriptions.list).mockResolvedValue({
        data: [],
      } as unknown as SubsListResponse);
      vi.mocked(s.paymentMethods.list).mockResolvedValue({
        data: [],
      } as unknown as PMListResponse);

      const result = await provider.getBillingDetails("cus_1");

      expect(result).toEqual({
        paymentMethod: null,
        billingEmail: "user@test.com",
      });
    });

    it("returns both nulls for a deleted customer and skips the cascade", async () => {
      vi.mocked(s.customers.retrieve).mockResolvedValue({
        id: "cus_1",
        deleted: true,
      } as unknown as CustomerResponse);

      const result = await provider.getBillingDetails("cus_1");

      expect(result).toEqual({ paymentMethod: null, billingEmail: null });
      expect(s.subscriptions.list).not.toHaveBeenCalled();
      expect(s.paymentMethods.list).not.toHaveBeenCalled();
    });
  });
});

describe("UnknownEventTypeError", () => {
  it("has correct properties", () => {
    const error = new UnknownEventTypeError("payment_intent.created", "evt_1");
    expect(error.eventType).toBe("payment_intent.created");
    expect(error.eventId).toBe("evt_1");
    expect(error.name).toBe("UnknownEventTypeError");
    expect(error.message).toContain("payment_intent.created");
    expect(error).toBeInstanceOf(Error);
  });
});
