/**
 * GET /api/cron/scan-cache-sweeper
 *
 * HARDEN-02: Scheduled cron that purges expired scan_results rows
 * (`scanned_at < NOW() - INTERVAL '1 hour'`). Authenticated via the
 * internal-service HMAC scheme; fails closed (non-scheduler callers → 401).
 *
 * Deployment: invoked by a Kubernetes CronJob every 30 minutes (the
 * `scan-cache-sweeper` job in `deploy/keeperhub-stack/{prod,staging}/values.yaml`,
 * which runs `deploy/scripts/reaper.sh` against this path). Authorized via
 * the internal-service HMAC scheme through `authenticateInternalService`.
 * No NODE_ENV bypass — endpoint fails closed when the signature does not verify.
 */

import { lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { scanResults } from "@/lib/db/schema-scan";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";

export const dynamic = "force-dynamic";

const SCAN_CACHE_RETENTION_MS = 60 * 60 * 1000; // 1 hour

type SweeperResponse = { pruned: number };

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateInternalService(request);
  if (!auth.authenticated || auth.caller !== "scheduler") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - SCAN_CACHE_RETENTION_MS);

  try {
    const pruned = await db
      .delete(scanResults)
      .where(lt(scanResults.scannedAt, cutoff))
      .returning({ id: scanResults.id });

    const body: SweeperResponse = { pruned: pruned.length };
    return Response.json(body);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Scan] cache sweeper failed",
      error,
      { endpoint: "/api/cron/scan-cache-sweeper" }
    );
    return Response.json({ error: "Sweeper failed" }, { status: 500 });
  }
}
