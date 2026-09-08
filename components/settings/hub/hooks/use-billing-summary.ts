"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { BILLING_API } from "@/lib/billing/constants";
import {
  type BillingSummary,
  billingSummaryCacheKey,
  fetchBillingSummary,
} from "@/lib/billing/summary";
import { useSettingsContext } from "../settings-context";
import { useCachedSection } from "./use-cached-section";

export type { BillingSummary } from "@/lib/billing/summary";

export type BillingSummaryState = {
  summary: BillingSummary | null;
  loading: boolean;
  openingPortal: boolean;
  openPortal: () => Promise<void>;
};

export function useBillingSummary(): BillingSummaryState {
  const { organizationId } = useSettingsContext();
  const [openingPortal, setOpeningPortal] = useState(false);

  const section = useCachedSection<BillingSummary | null>(
    billingSummaryCacheKey(organizationId),
    fetchBillingSummary
  );
  const summary = section.data ?? null;
  const loading = section.loading;

  const openPortal = useCallback(async (): Promise<void> => {
    setOpeningPortal(true);
    try {
      // Come back to the page the portal was opened from, not the old
      // standalone billing route.
      const res = await fetch(BILLING_API.PORTAL, {
        body: JSON.stringify({
          returnPath: window.location.pathname + window.location.search,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      toast.error(data.error ?? "Could not open the billing portal");
    } catch {
      toast.error("Could not open the billing portal");
    } finally {
      setOpeningPortal(false);
    }
  }, []);

  return { loading, openPortal, openingPortal, summary };
}
