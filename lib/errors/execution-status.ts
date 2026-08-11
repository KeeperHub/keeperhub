import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

/**
 * Execution status values that represent a failed run. `error` is a user-,
 * workflow-, or external-dependency-caused failure; `system_error` is a
 * platform/infrastructure failure (`error_type = "system"`): SQS/dispatch
 * problems, lost messages, reaped timeouts. Splitting them gives operators a
 * status they can see and filter on, separate from user-actionable errors.
 * External-dependency failures (`error_type = "external"`) map to plain `error`
 * because KeeperHub itself is healthy.
 *
 * Kept dependency-free so it is safe to import from client components and from
 * the executor/scheduler processes alike.
 */
export const ERROR_STATUSES = ["error", "system_error"] as const;

export type ErrorStatus = (typeof ERROR_STATUSES)[number];

/** True when an execution status is one of the two failure statuses. */
export function isErrorStatus(status: string): status is ErrorStatus {
  return (ERROR_STATUSES as readonly string[]).includes(status);
}

/** Map an error_type to the execution status that should be persisted. */
export function statusForErrorType(
  errorType: ExecutionErrorType | null | undefined
): ErrorStatus {
  return errorType === ExecutionErrorType.SYSTEM ? "system_error" : "error";
}
