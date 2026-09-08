import { isBillingEnabled } from "../feature-flag";
import type { BillingProvider } from "../provider";
import { StripeBillingProvider } from "./stripe";

let cachedProvider: BillingProvider | undefined;

export function getBillingProvider(): BillingProvider {
  if (!isBillingEnabled()) {
    throw new Error(
      "Billing is not enabled. Set NEXT_PUBLIC_BILLING_ENABLED=true to enable."
    );
  }
  if (!cachedProvider) {
    cachedProvider = new StripeBillingProvider();
  }
  return cachedProvider;
}
