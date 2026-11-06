"use client";

import { CheckCircle2, XCircle } from "lucide-react";
import type { TestResult } from "@/lib/notifications/failure-alerts/view-types";
import { cn } from "@/lib/utils";

/** The outcome of a Test button, with the provider's own error when it failed. */
export function TestResultLine({
  result,
}: {
  result: TestResult;
}): React.ReactElement {
  const Icon = result.delivered ? CheckCircle2 : XCircle;
  const seconds = (result.durationMs / 1000).toFixed(1);
  return (
    <output
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
        result.delivered
          ? "border-keeperhub-green/40 bg-keeperhub-green/10"
          : "border-destructive/40 bg-destructive/10"
      )}
      data-delivered={result.delivered}
      data-testid="failure-alert-test-result"
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          result.delivered ? "text-keeperhub-green-dark" : "text-destructive"
        )}
      />
      <span>
        {result.message}
        {result.delivered ? ` (${seconds} s)` : null}
        {!result.delivered &&
        result.status &&
        !result.message.includes(String(result.status))
          ? ` HTTP ${result.status}.`
          : null}
        {!result.delivered && result.classification === "transient"
          ? " This looks temporary; real alerts would be retried."
          : null}
      </span>
    </output>
  );
}
