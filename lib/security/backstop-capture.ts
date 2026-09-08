/**
 * Detection signal for backstop trigger rejects on the executions table.
 *
 * Migration 0082 installed `block_executions_for_inactive_workflows`, a
 * Postgres trigger that raises ERRCODE 42501 ("insufficient_privilege") on
 * INSERT into `workflow_executions` when the owning user is deactivated or
 * the workflow is soft-deleted. A trigger reject means an app-layer guard
 * has been bypassed (bug or attack), so it's the kind of event that should
 * page an on-call, not get buried as a generic 500.
 *
 * Detection keys off ERRCODE 42501 alone. The earlier draft also gated on
 * a message-substring match against the trigger's RAISE text, which made
 * the capture silently break if the trigger message was ever reworded.
 * 42501 ("insufficient_privilege") is rare enough on a `workflow_executions`
 * INSERT path that the false-positive risk is acceptable.
 *
 * Scope: this wrapper is for `workflow_executions` insert sites only. The
 * sessions backstop installed in migration 0090 uses a dedicated custom
 * SQLSTATE 'KH001' and fires inside better-auth's session create flow,
 * which we don't directly wrap here -- if/when we add Sentry coverage for
 * that path it would live in `lib/auth.ts` around the better-auth call,
 * not in this helper.
 *
 * The wrapper catches the rejection, emits a structured Sentry event with
 * enough context to triage (which workflow, which user, which entry path),
 * then re-throws so callers preserve their existing error responses. The
 * capture is best-effort -- a Sentry transport failure never blocks the
 * rethrow.
 */

import { logSecurityEvent } from "@/lib/logging";
import type { TriggerSource } from "./request-attribution";

const PG_RAISE_INSUFFICIENT_PRIVILEGE = "42501";
const MAX_CAUSE_DEPTH = 5;

type PgError = { code?: unknown };

function isBackstopRejection(err: unknown): boolean {
  // Drizzle (and the underlying postgres driver) wrap the raised
  // PostgresError before it reaches this catch, so the 42501 SQLSTATE sits
  // on a nested `cause` rather than the top-level error -- a bare
  // `err.code` check misses every real reject and the backstop never fires.
  // Walk the cause chain (bounded), mirroring isKh001SessionBackstop in
  // session-backstop.ts.
  let current: unknown = err;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current && typeof current === "object";
    depth++
  ) {
    if ((current as PgError).code === PG_RAISE_INSUFFICIENT_PRIVILEGE) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export type BackstopRejectContext = {
  workflowId: string;
  userId: string;
  source: TriggerSource;
};

/**
 * Wraps an execution INSERT with backstop-reject detection. If the INSERT
 * raises the ERRCODE 42501 backstop trigger, emit a structured Sentry event
 * before re-throwing. All other errors propagate unchanged.
 */
export async function withBackstopCapture<T>(
  context: BackstopRejectContext,
  insert: () => Promise<T>
): Promise<T> {
  try {
    return await insert();
  } catch (err) {
    if (isBackstopRejection(err)) {
      // Best-effort dual emit (Sentry + structured stdout); logSecurityEvent
      // self-guards both transports so a failure never shadows the original
      // backstop exception that downstream callers depend on.
      logSecurityEvent(
        "backstop_execution_blocked",
        {
          workflowId: context.workflowId,
          userId: context.userId,
          source: context.source,
        },
        {
          tags: {
            security: "backstop_execution_blocked",
            source: context.source,
          },
          user: { id: context.userId },
          extra: { workflowId: context.workflowId, source: context.source },
        }
      );
    }
    throw err;
  }
}
