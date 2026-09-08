import type { ErrorCategory } from "@/lib/logging";

/**
 * System error-code registry.
 *
 * Codes have the form `PREFIX-NNNN`. They are attached only to system failures
 * (`error_type = "system"`) so that a failed run shows a short, stable, not
 * overly revealing identifier in the run logs. User-configuration failures keep
 * showing their actionable raw message and carry no code.
 *
 * Prefix scheme (component-or-kind, first-letter):
 *   E  Executor runtime      N  Network            P  Pod / infrastructure
 *   C  Common / shared       CS Cron scheduler      BS Block scheduler
 *   ES Event scheduler
 *
 * This module is the runtime source of truth. The human-readable index in
 * `specs/error-codes/system-error-codes.md` mirrors it and the drift test in
 * `__tests__/error-codes.test.ts` guards their consistency.
 *
 * Kept free of value imports from `@/lib/logging` (which pulls in Sentry and
 * metrics) so it is safe to import from client components -- only the
 * `ErrorCategory` type is referenced.
 */

export const ErrorCodePrefix = {
  EXECUTOR: "E",
  NETWORK: "N",
  POD: "P",
  COMMON: "C",
  CRON_SCHEDULER: "CS",
  BLOCK_SCHEDULER: "BS",
  EVENT_SCHEDULER: "ES",
} as const;

export type ErrorCodePrefix =
  (typeof ErrorCodePrefix)[keyof typeof ErrorCodePrefix];

export type ErrorCode =
  | "C-0001"
  | "C-0002"
  | "C-0003"
  | "C-0004"
  | "E-0001"
  | "E-0002"
  | "E-0003"
  | "E-0004"
  | "N-0001"
  | "N-0002"
  | "P-0001"
  | "P-0002"
  | "P-0003"
  | "P-0004"
  | "P-0005"
  | "CS-0001"
  | "BS-0001"
  | "ES-0001";

export type ErrorCodeEntry = {
  code: ErrorCode;
  prefix: ErrorCodePrefix;
  /** Human-readable component, for the internal index and dashboards. */
  component: string;
  /**
   * Whether the failure is expected to clear on retry. Drives the customer
   * message: retryable -> "wait and try again", otherwise "contact support".
   */
  retryable: boolean;
  /** The classifier category this code corresponds to, for cross-reference. */
  category: ErrorCategory;
  /** Short, non-revealing message shown in the run logs. */
  customerMessage: string;
};

/**
 * Default code for a system failure that does not match a more specific rule.
 * Mirrors the classifier default (workflow_engine / system).
 */
export const DEFAULT_SYSTEM_ERROR_CODE: ErrorCode = "C-0001";

export const ERROR_CODES: Record<ErrorCode, ErrorCodeEntry> = {
  "C-0001": {
    code: "C-0001",
    prefix: "C",
    component: "Common",
    retryable: true,
    category: "workflow_engine",
    customerMessage:
      "Internal error (C-0001). Please wait a few minutes and try again.",
  },
  "C-0002": {
    code: "C-0002",
    prefix: "C",
    component: "Common",
    retryable: true,
    category: "database",
    customerMessage:
      "Internal error (C-0002). Please wait a few minutes and try again.",
  },
  "C-0003": {
    code: "C-0003",
    prefix: "C",
    component: "Common",
    retryable: false,
    category: "infrastructure",
    customerMessage:
      "Internal error (C-0003). Our team has been notified; please contact support if it persists.",
  },
  "C-0004": {
    code: "C-0004",
    prefix: "C",
    component: "Common",
    retryable: false,
    category: "auth",
    customerMessage:
      "Internal error (C-0004). Our team has been notified; please contact support if it persists.",
  },
  "E-0001": {
    code: "E-0001",
    prefix: "E",
    component: "Executor",
    retryable: true,
    category: "workflow_engine",
    customerMessage: "The run timed out (E-0001). Please try again.",
  },
  "E-0002": {
    code: "E-0002",
    prefix: "E",
    component: "Executor",
    retryable: true,
    category: "workflow_engine",
    customerMessage: "A step failed repeatedly (E-0002). Please try again.",
  },
  "E-0003": {
    code: "E-0003",
    prefix: "E",
    component: "Executor",
    retryable: true,
    category: "workflow_engine",
    customerMessage:
      "Internal error (E-0003). Please wait a few minutes and try again.",
  },
  "E-0004": {
    code: "E-0004",
    prefix: "E",
    component: "Executor",
    retryable: true,
    category: "infrastructure",
    customerMessage:
      "The run could not be processed (E-0004). Please wait a few minutes and try again.",
  },
  "N-0001": {
    code: "N-0001",
    prefix: "N",
    component: "Network",
    retryable: true,
    category: "network_rpc",
    customerMessage:
      "A network provider was unavailable (N-0001). Please try again shortly.",
  },
  "N-0002": {
    code: "N-0002",
    prefix: "N",
    component: "Network",
    retryable: true,
    category: "network_rpc",
    customerMessage:
      "Internal network error (N-0002). Please wait a few minutes and try again.",
  },
  "P-0001": {
    code: "P-0001",
    prefix: "P",
    component: "Pod",
    retryable: true,
    // "could not be started" (pod never ran) is an infrastructure failure, like
    // its P-000x siblings and like every writer of this code (reaper, executions
    // route). Was previously miscategorized workflow_engine, which conflicted
    // with the errorCategory column the reaper/executions writers persist.
    category: "infrastructure",
    customerMessage: "The run could not be started (P-0001). Please try again.",
  },
  "P-0002": {
    code: "P-0002",
    prefix: "P",
    component: "Pod",
    retryable: true,
    category: "infrastructure",
    customerMessage: "The run could not be started (P-0002). Please try again.",
  },
  "P-0003": {
    code: "P-0003",
    prefix: "P",
    component: "Pod",
    retryable: true,
    category: "infrastructure",
    customerMessage: "The run stopped unexpectedly (P-0003). Please try again.",
  },
  "P-0004": {
    code: "P-0004",
    prefix: "P",
    component: "Pod",
    retryable: true,
    category: "infrastructure",
    customerMessage: "The run could not be started (P-0004). Please try again.",
  },
  "P-0005": {
    code: "P-0005",
    prefix: "P",
    component: "Pod",
    retryable: true,
    category: "infrastructure",
    customerMessage: "The run could not be started (P-0005). Please try again.",
  },
  "CS-0001": {
    code: "CS-0001",
    prefix: "CS",
    component: "Cron scheduler",
    retryable: true,
    category: "workflow_engine",
    customerMessage:
      "The scheduled run could not be started (CS-0001). It will retry automatically.",
  },
  "BS-0001": {
    code: "BS-0001",
    prefix: "BS",
    component: "Block scheduler",
    retryable: true,
    category: "workflow_engine",
    customerMessage:
      "The run could not be started (BS-0001). It will retry automatically.",
  },
  "ES-0001": {
    code: "ES-0001",
    prefix: "ES",
    component: "Event scheduler",
    retryable: true,
    category: "workflow_engine",
    customerMessage:
      "The run could not be started (ES-0001). It will retry automatically.",
  },
};

/** Type guard: is `value` a known error code? */
export function isErrorCode(
  value: string | null | undefined
): value is ErrorCode {
  return value != null && value in ERROR_CODES;
}

/** Look up a registry entry, or null when the code is unknown/absent. */
export function getErrorCodeEntry(
  code: string | null | undefined
): ErrorCodeEntry | null {
  return isErrorCode(code) ? ERROR_CODES[code] : null;
}

/**
 * Customer-facing message for a code, or null when the code is unknown/absent.
 * Callers fall back to a generic system message when this returns null.
 */
export function getCustomerMessageForCode(
  code: string | null | undefined
): string | null {
  return getErrorCodeEntry(code)?.customerMessage ?? null;
}
