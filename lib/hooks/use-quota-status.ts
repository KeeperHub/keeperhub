"use client";

import { useEffect, useState } from "react";

export type QuotaStatus = {
  organizationId: string;
  plan: string;
  planLabel: string;
  used: number;
  limit: number;
  usagePercent: number;
  /** 80 or 100 once reached, null while below every threshold. */
  threshold: number | null;
  periodStart: string;
  periodEnd: string;
  paygEligible: boolean;
  overageRatePerThousand: number | null;
};

/**
 * The active org's execution-quota status, from the same backend signal the
 * quota warning email is sent from. Returns null for anyone who is not an org
 * owner, for unlimited plans, and whenever the read fails, so callers render
 * nothing rather than a degraded banner.
 */
export function useQuotaStatus(enabled: boolean): {
  status: QuotaStatus | null;
} {
  const [status, setStatus] = useState<QuotaStatus | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }

    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const response = await fetch("/api/billing/quota-status", {
          credentials: "include",
        });
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as { status: QuotaStatus | null };
        if (!cancelled) {
          setStatus(data.status ?? null);
        }
      } catch (error) {
        console.error("[QuotaStatus] Failed to load quota status:", error);
      }
    }

    load().catch(() => undefined);

    return (): void => {
      cancelled = true;
    };
  }, [enabled]);

  return { status };
}

/**
 * Dismissal key for a quota banner. Scoped to the org, the quota month and the
 * threshold, so dismissing the 80% banner hides it for the rest of the month
 * but crossing 100% (or a new month) surfaces it again.
 */
export function quotaBannerStorageKey(status: QuotaStatus): string {
  return `kh-quota-banner:${status.organizationId}:${status.periodStart}:${status.threshold}`;
}
