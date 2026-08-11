"use client";

import { Loader2, Pencil } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BILLING_API } from "@/lib/billing/constants";
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
  const [data, setData] = useState<BillingDetailsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);

  const fetchDetails = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const response = await fetch(BILLING_API.BILLING_DETAILS);
      if (response.ok) {
        const json = (await response.json()) as BillingDetailsResponse;
        setData(json);
      } else {
        setData({ paymentMethod: null, billingEmail: null });
      }
    } catch {
      setData({ paymentMethod: null, billingEmail: null });
    } finally {
      setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: orgId drives re-fetch on org switch
  useEffect(() => {
    fetchDetails().catch(() => undefined);
  }, [fetchDetails, orgId]);

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
              aria-label="Edit billing details"
              className="size-7 text-muted-foreground hover:text-foreground"
              disabled={portalLoading}
              onClick={() => {
                openPortal().catch(() => undefined);
              }}
              size="icon"
              variant="ghost"
            >
              <Pencil className="size-3.5" />
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
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
          <div className="border-t border-border/50 pt-3">
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
