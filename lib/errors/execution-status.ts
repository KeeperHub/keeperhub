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

/**
 * Every status a row in `workflow_executions` can carry. Declared here rather
 * than inline on the column so the API, the client and the executor all name
 * the same set, and so adding a status shows up as a type error everywhere it
 * has to be handled.
 *
 * `skipped` is a run the platform refused before it started: over the plan's
 * execution limit, a gated action, or an unpaid pay-as-you-go charge. It is
 * terminal, never billable, and not a failure, so it belongs outside both the
 * error count and the success-rate denominator.
 */
export const WORKFLOW_EXECUTION_STATUSES = [
  "pending",
  "running",
  "unconfirmed",
  "success",
  "error",
  "skipped",
  "cancelled",
  "phantom",
  "system_error",
] as const;

export type WorkflowExecutionStatus =
  (typeof WORKFLOW_EXECUTION_STATUSES)[number];

/**
 * Status of a single node inside a run, as stored on
 * `workflow_execution_logs.status`. Deliberately narrower than
 * WorkflowExecutionStatus: a node is dispatched only once the run itself was
 * admitted, so no node ever carries a run-level outcome such as `skipped`.
 */
export const NODE_EXECUTION_STATUSES = [
  "pending",
  "running",
  "success",
  "error",
  "cancelled",
] as const;

export type NodeExecutionStatus = (typeof NODE_EXECUTION_STATUSES)[number];

/** Map an error_type to the execution status that should be persisted. */
export function statusForErrorType(
  errorType: ExecutionErrorType | null | undefined
): ErrorStatus {
  return errorType === ExecutionErrorType.SYSTEM ? "system_error" : "error";
}
