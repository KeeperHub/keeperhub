import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { toJsonSafe } from "@/lib/utils/json-safe";
import {
  formatStoredBytes,
  MAX_STORED_OUTPUT_BYTES,
  TRUNCATED_PREVIEW_CHARS,
  type TruncatedOutputMarker,
} from "@/lib/workflow/output-limits";

export type BoundedStoredOutput =
  | { value: unknown; oversize: null }
  | { value: TruncatedOutputMarker; oversize: number };

/**
 * Prepare a value for a JSONB column: JSON-safe as before, unless its
 * serialised form exceeds the stored-output limit, in which case the marker
 * takes its place and `oversize` carries the real size in bytes.
 */
export function boundStoredOutput(
  value: unknown,
  maxBytes: number = MAX_STORED_OUTPUT_BYTES
): BoundedStoredOutput {
  const safe = toJsonSafe(value);
  if (safe === null || safe === undefined) {
    return { value: safe, oversize: null };
  }
  const text = JSON.stringify(safe);
  if (text === undefined) {
    return { value: safe, oversize: null };
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) {
    return { value: safe, oversize: null };
  }
  return {
    value: {
      _truncated: true,
      originalSize: bytes,
      preview: text.slice(0, TRUNCATED_PREVIEW_CHARS),
    },
    oversize: bytes,
  };
}

/** The stored size of a step result when it is over the limit, else null. */
export function storedOutputOverflow(
  value: unknown,
  maxBytes: number = MAX_STORED_OUTPUT_BYTES
): number | null {
  return boundStoredOutput(value, maxBytes).oversize;
}

export const STEP_OUTPUT_TOO_LARGE_CODE = "STEP_OUTPUT_TOO_LARGE";

export function oversizeStoredOutputMessage(
  bytes: number,
  maxBytes: number = MAX_STORED_OUTPUT_BYTES
): string {
  return `Step output of ${formatStoredBytes(bytes)} exceeds the ${formatStoredBytes(maxBytes)} limit for stored step output. Reduce what the step returns (filter, page or narrow the request) so the result can be stored and passed to the next step.`;
}

/**
 * The failed result a step wrapper substitutes for one too large to store.
 * Same shape every action step uses for a failure, so the executor, the run
 * error and the logs treat it like any other step error.
 *
 * It is a user error: the fix is in the workflow (return less from the
 * step), not in the platform. The message matches no classifier rule, so
 * without the tag the run would land as system_error, page as a platform
 * fault, and show the customer a generic "internal error" in place of the
 * actionable text.
 */
export function oversizeStepResult(bytes: number): {
  success: false;
  error: string;
  code: string;
  errorClass: ExecutionErrorType;
} {
  return {
    success: false,
    error: oversizeStoredOutputMessage(bytes),
    code: STEP_OUTPUT_TOO_LARGE_CODE,
    errorClass: ExecutionErrorType.USER,
  };
}
