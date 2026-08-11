import { getCustomerMessageForCode } from "@/lib/errors/error-codes";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { isErrorStatus } from "@/lib/errors/execution-status";
import type { ErrorCategory } from "@/lib/logging";

/**
 * Maps a finished workflow run's failure fields to a short, customer-readable
 * message for the run logs UI, or null when the run did not fail.
 *
 * For system failures it prefers the stable, not-overly-revealing message keyed
 * by the run's `error_code` (PREFIX-NNNN); it surfaces the raw error only for
 * user-config failures, which are actionable by the workflow author. Legacy
 * rows without a code fall back to the prior generic messages.
 *
 * Kept free of value imports from `@/lib/logging` (which pulls in Sentry and
 * metrics) so it is safe to use in client components; `@/lib/errors/error-codes`
 * is likewise client-safe (it only type-imports `ErrorCategory`).
 */
type RunErrorInput = {
  status: string;
  error: string | null;
  errorType: ExecutionErrorType | null;
  errorCategory: ErrorCategory | string | null;
  errorCode?: string | null;
};

export function getCustomerRunErrorMessage(run: RunErrorInput): string | null {
  // System failures carry status='system_error'; they are exactly the coded
  // runs whose customer message lives in the registry, so include them.
  if (!isErrorStatus(run.status)) {
    return null;
  }

  // User-config faults and external-dependency failures both surface their raw
  // message: it is actionable by the author (fix the config) or informative
  // about the upstream outage (their endpoint timed out), and reveals no
  // KeeperHub internals.
  if (
    run.errorType === ExecutionErrorType.USER ||
    run.errorType === ExecutionErrorType.EXTERNAL
  ) {
    return run.error ?? "The workflow failed. See the step details below.";
  }

  // System failure: prefer the registry message keyed by the stable code.
  const coded = getCustomerMessageForCode(run.errorCode ?? null);
  if (coded) {
    return coded;
  }

  // Legacy rows without a code keep the prior generic behaviour. The classifier
  // treats unmatched failures as system.
  if (run.errorCategory === "network_rpc") {
    return "Internal network error, please wait 5 minutes and try again.";
  }

  return "Internal error, please wait 5 minutes and try again.";
}
