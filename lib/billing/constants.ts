export const BILLING_API = {
  SUBSCRIPTION: "/api/billing/subscription",
  PORTAL: "/api/billing/portal",
  INVOICES: "/api/billing/invoices",
  PREVIEW_PRORATION: "/api/billing/preview-proration",
  CHECKOUT: "/api/billing/checkout",
  CANCEL: "/api/billing/cancel",
  USAGE_SUGGESTION: "/api/billing/usage-suggestion",
  BILLING_DETAILS: "/api/billing/billing-details",
  GAS_SPONSORSHIP: "/api/billing/gas-sponsorship",
  PAYG: "/api/billing/payg",
} as const;

export const BILLING_ALERTS = {
  PAYMENT_ACTION_REQUIRED: "payment_action_required",
  OVERDUE: "overdue",
  PAYMENT_FAILED: "payment_failed",
} as const;

/** Values of organization_subscriptions.status, mirrored from the provider. */
export const SUBSCRIPTION_STATUS = {
  ACTIVE: "active",
  TRIALING: "trialing",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
  UNPAID: "unpaid",
  PAUSED: "paused",
  INCOMPLETE: "incomplete",
  INCOMPLETE_EXPIRED: "incomplete_expired",
} as const;

export type SubscriptionStatus =
  (typeof SUBSCRIPTION_STATUS)[keyof typeof SUBSCRIPTION_STATUS];

export const PAID_PLANS = new Set<string>(["pro", "business", "enterprise"]);
export const VALID_INTERVALS = new Set<string>(["monthly", "yearly"]);

export const SUPPORT_LABELS: Record<string, string> = {
  community: "Community",
  "email-48h": "Email (48h)",
  "dedicated-12h": "Dedicated (12h)",
  "dedicated-1h": "Dedicated (1h)",
};

export const SUPPORT_RANK: Record<string, number> = {
  community: 0,
  "email-48h": 1,
  "dedicated-12h": 2,
  "dedicated-1h": 3,
};

export const CONTACT_EMAIL =
  process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? "sales@keeperhub.io";
