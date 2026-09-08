"use client";

import { Loader2, Pencil } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BILLING_API } from "@/lib/billing/constants";
import { useCachedResource } from "@/lib/hooks/use-cached-resource";
import { useOrganization } from "@/lib/hooks/use-organization";

type PaymentMethod = {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
};

type BillingDetailsResponse = {
  paymentMethod: PaymentMethod | null;
  billingEmail: string | null;
};

function formatBrand(brand: string): string {
  const map: Record<string, string> = {
    visa: "Visa",
    mastercard: "Mastercard",
    amex: "American Express",
    discover: "Discover",
    jcb: "JCB",
    diners: "Diners Club",
    unionpay: "UnionPay",
  };
  return map[brand] ?? brand.charAt(0).toUpperCase() + brand.slice(1);
}

export function BillingDetails(): React.ReactElement {
  const { organization } = useOrganization();
  const orgId = organization?.id;
  const [portalLoading, setPortalLoading] = useState(false);

  // Remembered per organization, so returning to billing shows the card on
  // file straight away and only replaces it if it has changed.
  const details = useCachedResource<BillingDetailsResponse>(
    orgId ? `billing-details:${orgId}` : null,
    async () => {
      const response = await fetch(BILLING_API.BILLING_DETAILS);
      if (!response.ok) {
        return { billingEmail: null, paymentMethod: null };
      }
      return (await response.json()) as BillingDetailsResponse;
    }
  );
  const data = details.data ?? null;
  const loading = details.loading;

  async function openPortal(): Promise<void> {
    setPortalLoading(true);
    try {
      const response = await fetch(BILLING_API.PORTAL, { method: "POST" });
      const json = (await response.json()) as { url?: string; error?: string };
      if (response.ok && json.url) {
        window.location.href = json.url;
        return;
      }
      toast.error(json.error ?? "Could not open billing portal");
    } catch {
      toast.error("Could not open billing portal");
    } finally {
      setPortalLoading(false);
    }
  }

  const paymentMethod = data?.paymentMethod ?? null;
  const billingEmail = data?.billingEmail ?? null;
  const hasPaymentMethod = paymentMethod !== null;

  return (
    <Card className="bg-sidebar">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span>Billing Details</span>
          {hasPaymentMethod && (
            <Button
              className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
              disabled={portalLoading}
              onClick={() => {
                openPortal().catch(() => undefined);
              }}
              size="sm"
              variant="ghost"
            >
              <Pencil className="size-3.5" />
              {portalLoading ? "Opening..." : "Manage payment method"}
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      {/* Card and invoice email sit side by side: stacked, each on its own
          line, they left most of a full-width card empty. */}
      <CardContent className="flex flex-wrap items-start justify-between gap-x-12 gap-y-4">
        {loading && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="size-4 animate-spin" />
            Loading...
          </div>
        )}

        {!(loading || hasPaymentMethod) && (
          <p className="text-muted-foreground text-sm">
            No card on file. Subscribe to a paid plan to add a payment method.
          </p>
        )}

        {!loading && hasPaymentMethod && (
          <div>
            <p className="text-sm">
              <span className="text-muted-foreground">
                {formatBrand(paymentMethod.brand)} ending in
              </span>{" "}
              <span className="font-medium tracking-wider">
                •••• {paymentMethod.last4}
              </span>
            </p>
            <p className="text-muted-foreground text-xs mt-1">
              Expires {String(paymentMethod.expMonth).padStart(2, "0")}/
              {String(paymentMethod.expYear).slice(-2)}
            </p>
          </div>
        )}

        {!loading && (
          <div>
            <p className="text-sm">
              <span className="text-muted-foreground">Invoice Email:</span>{" "}
              {billingEmail ? (
                <span className="font-medium">{billingEmail}</span>
              ) : (
                <span className="text-muted-foreground italic">
                  Not on file
                </span>
              )}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
