/**
 * Settles direct executions stuck in `unconfirmed`: a transaction was
 * broadcast, but the chain had not answered by the time the request had to.
 * Re-reads each receipt and moves the row to completed or failed once the
 * outcome is known.
 *
 * Deployment: invoked by an external scheduler (Kubernetes CronJob), on the
 * order of every minute. Authorized via `Authorization: Bearer $CRON_SECRET`,
 * mirroring the other cron routes. Fails closed when CRON_SECRET is unset.
 */

import { reconcileUnconfirmedExecutions } from "@/lib/execute/reconcile-executions";
import { ErrorCategory, logSystemError } from "@/lib/logging";

export const dynamic = "force-dynamic";

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return false;
  }
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const summary = await reconcileUnconfirmedExecutions();
    return Response.json(summary);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to reconcile unconfirmed executions",
      error,
      { endpoint: "/api/cron/execution-reconciler" }
    );
    return Response.json({ error: "reconcile failed" }, { status: 500 });
  }
}
