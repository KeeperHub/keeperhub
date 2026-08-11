/**
 * Branch-aware final-success computation, extracted so unit tests can import
 * it without pulling the full executor module (which imports the plugin
 * registry and step-registry chain).
 */

import type { ExecutionErrorType } from "@/lib/errors/execution-error-type";

export type ExecutionResult = {
  success: boolean;
  data?: unknown;
  error?: string;
  /**
   * Authoritative error classification declared by the failing step (e.g. a
   * third-party dependency failure). Threaded to the run finalizer so it wins
   * over the message-string classifier.
   */
  errorClass?: ExecutionErrorType;
};

/**
 * A workflow succeeds iff every node in `results` succeeded OR was on a
 * not-taken condition branch (skipped).
 *
 * Extracted for post-drain re-evaluation (KEEP-395 Bug 2 hardening): drained
 * orphan-node failures land in `results` while drain awaits them; calling this
 * once after drain is the authoritative answer.
 */
export function computeFinalSuccess(
  results: Record<string, ExecutionResult>,
  skippedTargets: ReadonlySet<string>
): boolean {
  for (const [nodeId, r] of Object.entries(results)) {
    if (!(r.success || skippedTargets.has(nodeId))) {
      return false;
    }
  }
  return true;
}
