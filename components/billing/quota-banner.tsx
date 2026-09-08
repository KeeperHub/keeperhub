"use client";

import { AlertTriangle, X } from "lucide-react";
import Link from "next/link";
import type { QuotaStatus } from "@/lib/hooks/use-quota-status";

/**
 * Top-of-app warning that the org is at or past its monthly execution quota.
 *
 * Driven by the same lib/billing/quota-threshold signal as the quota warning
 * email, so the percentage shown here is the percentage that was mailed. Shares
 * the fixed 36px slot the announcement banner uses, and outranks it.
 */
export function QuotaBanner({
  status,
  onDismiss,
}: {
  status: QuotaStatus;
  onDismiss: () => void;
}): React.ReactElement {
  const atLimit = (status.threshold ?? 0) >= 100;

  const tone = atLimit
    ? "border-destructive/30 bg-destructive/10 text-destructive"
    : "border-yellow-500/30 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400";

  const headline = atLimit
    ? `You've used all ${status.limit.toLocaleString("en-US")} executions included in your ${status.planLabel} plan this month.`
    : `You've used ${status.usagePercent}% of your ${status.planLabel} plan's monthly executions (${status.used.toLocaleString("en-US")} of ${status.limit.toLocaleString("en-US")}).`;

  let continuity: string;
  if (status.paygEligible) {
    continuity = atLimit
      ? "Workflows keep running on pay-as-you-go within your spend caps."
      : "Past the limit, workflows keep running on pay-as-you-go within your spend caps.";
  } else if (status.overageRatePerThousand === null) {
    continuity = atLimit
      ? "Further executions are refused until the quota resets."
      : "Past the limit, executions are refused until the quota resets.";
  } else {
    continuity = `Executions past the limit are billed at $${status.overageRatePerThousand} per 1,000.`;
  }

  return (
    <output
      className={`pointer-events-auto fixed top-0 right-0 left-0 z-[55] flex h-9 items-center justify-center border-b px-12 text-sm backdrop-blur-sm ${tone}`}
      data-testid="quota-banner"
      data-threshold={status.threshold}
    >
      <p className="flex items-center gap-2 truncate">
        <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
        <span className="truncate">
          {headline} {continuity}{" "}
          <Link
            className="font-medium underline-offset-4 hover:underline"
            href={
              status.paygEligible
                ? `/settings/${status.organizationId}/billing`
                : `/settings/${status.organizationId}/plans`
            }
          >
            {status.paygEligible ? "Top up wallet" : "See plans"}
          </Link>
        </span>
      </p>
      <button
        aria-label="Dismiss quota warning"
        className="absolute right-3 shrink-0 rounded-md p-1 opacity-70 transition-opacity hover:opacity-100"
        onClick={onDismiss}
        type="button"
      >
        <X className="size-3.5" />
      </button>
    </output>
  );
}
