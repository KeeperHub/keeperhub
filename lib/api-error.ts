import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError, logWarn } from "@/lib/logging";

/**
 * Standardized API error handler
 *
 * Emits a canonical structured log line and returns a consistent JSON
 * response. 5xx are treated as system failures (Prometheus metric + Sentry
 * error) so they surface on dashboards and alerts; 4xx are logged at warn with
 * no metric/Sentry so routine client errors do not trip system-error alerts or
 * page on-call.
 *
 * @param error - The caught error
 * @param context - Description of what operation failed (e.g., "Failed to get workflows")
 * @param status - HTTP status code (default: 500)
 */
export function apiError(
  error: unknown,
  context: string,
  status = 500
): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  const rootCause = getRootCause(error);

  if (status >= 500) {
    logSystemError(ErrorCategory.UNKNOWN, `[API] ${context}`, error, {
      status_code: String(status),
    });
  } else {
    logWarn(`[API] ${context}: ${message}`, { status_code: String(status) });
  }

  return NextResponse.json(
    {
      error: rootCause ?? message,
      context,
    },
    { status }
  );
}

function getRootCause(error: unknown): string | undefined {
  if (!(error instanceof Error && error.cause)) {
    return undefined;
  }
  const cause = error.cause;
  if (cause instanceof Error) {
    return cause.message;
  }
  if (typeof cause === "string") {
    return cause;
  }
  return undefined;
}
