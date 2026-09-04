/**
 * Settles executions stuck in `unconfirmed`: a transaction was broadcast, but
 * the chain had not answered by the time the request had to. Covers both
 * direct executions and workflow runs. Re-reads each receipt and moves the row
 * to completed or failed once the outcome is known, or to failed once a
 * transaction has been absent from every endpoint for long enough that it can
 * only have been dropped.
 *
 * Deployment: invoked by the `execution-reconciler` Kubernetes CronJob (the
 * job of that name in `deploy/keeperhub-stack/{prod,staging}/values.yaml`,
 * which runs `deploy/scripts/reaper.sh` against this path) every two minutes.
 * Authorized via the internal-service HMAC scheme (`X-KH-Caller`,
 * `X-KH-Timestamp`, `X-KH-Signature` signed with
 * `INTERNAL_SERVICE_HMAC_SECRET`) through `authenticateInternalService`, the
 * same mechanism the reaper CronJob uses. Fails closed when the signature does
 * not verify; there is no NODE_ENV bypass.
 */

import { reconcileUnconfirmedExecutions } from "@/lib/execute/reconcile-executions";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateInternalService(request);
  if (!auth.authenticated) {
    return Response.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
    );
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
