import type { SimulateResult } from "@/lib/execute/simulate";
import { HttpStatus, type HttpStatusCode } from "@/lib/http-status";

/**
 * Map a simulation result to its API response status.
 *
 * Deterministic validation/revert failures are client-actionable and return
 * 400. Infrastructure failures return 503 and must never be interpreted as a
 * successful preflight.
 */
export function simulationHttpStatus(result: SimulateResult): HttpStatusCode {
  if (result.success) {
    return HttpStatus.OK;
  }

  if (result.failureKind === "unavailable") {
    return HttpStatus.SERVICE_UNAVAILABLE;
  }

  return HttpStatus.BAD_REQUEST;
}

/**
 * A sequence answers once for N calls, so the status reflects the worst call:
 * anything the node could not answer is 503, a call that would revert or did
 * not validate is 400, and only an all-clear sequence is 200. Same mapping as
 * the single-call path, applied to the whole.
 */
export function sequenceHttpStatus(results: SimulateResult[]): HttpStatusCode {
  if (results.some((r) => !r.success && r.failureKind === "unavailable")) {
    return HttpStatus.SERVICE_UNAVAILABLE;
  }
  if (results.some((r) => !r.success)) {
    return HttpStatus.BAD_REQUEST;
  }
  return HttpStatus.OK;
}
