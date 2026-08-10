export type CreateCheckoutParams = {
  customerId: string;
  priceId: string;
  organizationId: string;
  successUrl: string;
  cancelUrl: string;
  // When set, the subscription starts with a free trial of this many days.
  trialPeriodDays?: number;
};

export type CreateCustomerParams = {
  email: string;
  organizationId: string;
  userId: string;
};

export type BillingWebhookEvent = {
  type:
    | "checkout.completed"
    | "subscription.updated"
    | "subscription.deleted"
    | "invoice.created"
    | "invoice.paid"
    | "invoice.payment_failed"
    | "invoice.overdue"
    | "invoice.payment_action_required";
  providerEventId: string;
  data: {
    providerSubscriptionId?: string;
    providerCustomerId?: string;
    invoiceId?: string;
    organizationId?: string;
    priceId?: string;
    status?: string;
    cancelAtPeriodEnd?: boolean;
    periodStart?: Date;
    periodEnd?: Date | null;
    invoiceUrl?: string;
    // Stripe's billing_reason, used to tell a cycle renewal invoice apart from
    // a one-off or proration invoice.
    billingReason?: string;
    // Metadata from Stripe used to resolve custom enterprise plans whose price
    // IDs aren't in the env-var map. Subscription metadata takes precedence.
    subscriptionMetadata?: Record<string, string>;
    priceMetadata?: Record<string, string>;
  };
};

export type InvoiceItem = {
  id: string;
  date: Date;
  amount: number;
  currency: string;
  status: "paid" | "open" | "void" | "draft" | "uncollectible";
  description: string;
  periodStart: Date;
  periodEnd: Date;
  invoiceUrl: string | null;
  pdfUrl: string | null;
};

export type ListInvoicesParams = {
  customerId: string;
  limit: number;
  startingAfter?: string;
};

export type ListInvoicesResult = {
  invoices: InvoiceItem[];
  hasMore: boolean;
};

export type SubscriptionDetails = {
  priceId: string | undefined;
  status: string;
  cancelAtPeriodEnd: boolean;
  periodStart: Date;
  periodEnd: Date | null;
  subscriptionMetadata?: Record<string, string>;
  priceMetadata?: Record<string, string>;
};

export type CreateInvoiceItemParams = {
  customerId: string;
  amount: number;
  currency: string;
  description: string;
  metadata?: Record<string, string>;
  // Attach to this specific draft invoice. Without it the item is left pending
  // and the provider only sweeps it into whichever invoice is created next.
  invoiceId?: string;
  // Makes the create safe to repeat. If the provider created the item but the
  // response never arrived, replaying the same key returns that item instead of
  // billing the customer a second time.
  idempotencyKey?: string;
};

export type CreateInvoiceItemResult = {
  invoiceItemId: string;
};

export type CollectInvoiceResult = {
  invoiceId: string;
  paid: boolean;
  // Why collection failed, for the log and the debt record. Undefined when paid.
  failureReason?: string;
};

export type ProrationPreview = {
  amountDue: number;
  subtotal: number;
  appliedBalance: number;
  currency: string;
  periodEnd: Date | null;
  lineItems: {
    description: string;
    amount: number;
    proration: boolean;
  }[];
};

export type BillingDetails = {
  paymentMethod: {
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
  } | null;
  billingEmail: string | null;
};

export interface BillingProvider {
  readonly name: string;

  createCustomer(params: CreateCustomerParams): Promise<{ customerId: string }>;

  createCheckoutSession(params: CreateCheckoutParams): Promise<{ url: string }>;

  createPortalSession(
    customerId: string,
    returnUrl: string
  ): Promise<{ url: string }>;

  getBillingDetails(customerId: string): Promise<BillingDetails>;

  verifyWebhook(body: string, signature: string): Promise<BillingWebhookEvent>;

  getSubscriptionDetails(subscriptionId: string): Promise<SubscriptionDetails>;

  listInvoices(params: ListInvoicesParams): Promise<ListInvoicesResult>;

  updateSubscription(
    subscriptionId: string,
    newPriceId: string,
    options?: { endTrial?: boolean }
  ): Promise<{ subscriptionId: string }>;

  cancelSubscription(
    subscriptionId: string
  ): Promise<{ cancelAtPeriodEnd: boolean; periodEnd: Date | null }>;

  previewProration(
    subscriptionId: string,
    newPriceId: string,
    options?: { endTrial?: boolean }
  ): Promise<ProrationPreview>;

  createInvoiceItem(
    params: CreateInvoiceItemParams
  ): Promise<CreateInvoiceItemResult>;

  getInvoiceStatus(
    invoiceId: string
  ): Promise<{ status: string; paid: boolean }>;

  getInvoiceForItem(
    invoiceItemId: string
  ): Promise<{ invoiceId: string; status: string; paid: boolean } | undefined>;

  /**
   * Open an empty draft invoice for a customer, deliberately not tied to a
   * subscription so the provider puts no plan or proration lines on it. Items
   * are attached explicitly via createInvoiceItem, so the invoice bills only
   * what the caller adds.
   *
   * `currency` must match the items that will be attached. Left to the
   * provider it defaults to the account or customer currency, and an invoice
   * cannot mix currencies, so a mismatch rejects the attach outright.
   */
  createDraftInvoice(
    customerId: string,
    currency: string
  ): Promise<{ invoiceId: string }>;

  /**
   * Finalize a draft and attempt payment. Resolves with paid: false and a
   * reason rather than throwing when the charge is declined or no payment
   * method is on file, since an uncollected invoice is a debt to record and
   * not an error to retry.
   */
  finalizeAndCollectInvoice(invoiceId: string): Promise<CollectInvoiceResult>;

  /** Discard a draft that ended up with nothing to bill. */
  deleteDraftInvoice(invoiceId: string): Promise<void>;

  /**
   * Whether a create failed because the provider refused the request, meaning
   * nothing was created and retrying with different parameters is safe.
   *
   * A transport failure is the opposite case: the item may well exist, and only
   * the response was lost. Retrying that would bill twice.
   */
  wasRejectedWithoutCreating(error: unknown): boolean;
}
