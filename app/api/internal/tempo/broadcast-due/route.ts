/**
 * Internal cron endpoint: broadcast Tempo held payments whose scheduled time has
 * arrived, expire lapsed ones, and reconcile already-broadcast ones. Driven by a
 * K8s CronJob (and the local-dev poller) via deploy/scripts/reaper.sh, signed as
 * the `scheduler` internal caller. Not reachable from a session or the public
 * API; the HMAC gate is the only entry.
 */
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { processDueHeldPayments } from "@/lib/tempo/broadcast-due";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateInternalService(request);
  if (!auth.authenticated) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  if (auth.caller !== "scheduler") {
    return Response.json(
      { error: "This endpoint is only callable by the scheduler." },
      { status: 403 }
    );
  }

  try {
    const result = await processDueHeldPayments();
    return Response.json(result);
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      "[Tempo Held] broadcast-due sweep failed",
      error,
      {
        endpoint: "/api/internal/tempo/broadcast-due",
        operation: "broadcast_due",
      }
    );
    return Response.json(
      { error: "broadcast-due sweep failed" },
      { status: 500 }
    );
  }
}
