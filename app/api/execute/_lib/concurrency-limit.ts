import "server-only";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { HttpStatus } from "@/lib/http-status";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import {
  type ConcurrencyLimitResult,
  checkConcurrencyLimit as checkConcurrencyLimitCore,
  checkDirectExecutionConcurrency as checkDirectExecutionConcurrencyCore,
} from "@/lib/workflow/concurrency";

export type { ConcurrencyLimitResult } from "@/lib/workflow/concurrency";

const RETRY_AFTER_SECONDS = 30;

/**
 * Route-side concurrency check, bound to the app db. Shares its implementation
 * with the executor via lib/workflow/concurrency so both enforce the same cap.
 */
export function checkConcurrencyLimit(): Promise<ConcurrencyLimitResult> {
  return checkConcurrencyLimitCore(db);
}

/**
 * Back-pressure for the direct execution write routes, bound to the app db.
 * Counts the org's in-flight direct executions (not workflow executions).
 */
export function checkDirectExecutionConcurrency(
  organizationId: string
): Promise<ConcurrencyLimitResult> {
  return checkDirectExecutionConcurrencyCore(db, organizationId);
}

/**
 * Enforce direct-execution back-pressure at the top of a write route. Returns a
 * 429 response (with Retry-After) when the org's in-flight cap is hit, or null
 * to proceed. Mirrors the workflow routes' concurrency 429 shape.
 */
export async function enforceDirectExecutionConcurrency(
  organizationId: string
): Promise<NextResponse | null> {
  const check = await checkDirectExecutionConcurrency(organizationId);
  if (check.allowed) {
    return null;
  }

  return applyRateLimitHeaders(
    NextResponse.json(
      {
        error: "Too many concurrent executions",
        running: check.running,
        limit: check.limit,
      },
      { status: HttpStatus.TOO_MANY_REQUESTS }
    ),
    {
      limit: check.limit,
      remaining: 0,
      reset: Math.ceil(Date.now() / 1000) + RETRY_AFTER_SECONDS,
      retryAfter: RETRY_AFTER_SECONDS,
    }
  );
}
