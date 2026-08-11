import { HttpStatus } from "@/lib/http-status";
import "server-only";

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { directExecutions } from "@/lib/db/schema";
import { SCOPE_MCP_READ } from "@/lib/mcp/oauth-scopes";
import { requireScope } from "@/lib/middleware/require-scope";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { validateApiKey } from "../../_lib/auth";
import { checkRateLimit } from "../../_lib/rate-limit";
import type { ExecutionStatusResponse } from "../../_lib/types";

// Seconds a client should wait before polling status again while the execution
// is still in flight. Terminal executions return 0 to tell clients to stop.
const POLL_INTERVAL_HINT_SECONDS = 2;
const TERMINAL_STATUSES = new Set(["completed", "failed"]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ executionId: string }> }
): Promise<NextResponse> {
  const apiKeyCtx = await validateApiKey(request);
  if ("error" in apiKeyCtx) {
    return NextResponse.json(
      { error: apiKeyCtx.error },
      { status: apiKeyCtx.status }
    );
  }

  const scopeError = requireScope(apiKeyCtx.scope, SCOPE_MCP_READ);
  if (scopeError) {
    return scopeError;
  }

  const rateLimit = checkRateLimit(apiKeyCtx.apiKeyId);
  if (!rateLimit.allowed) {
    return applyRateLimitHeaders(
      NextResponse.json(
        { error: "Rate limit exceeded" },
        { status: HttpStatus.TOO_MANY_REQUESTS }
      ),
      rateLimit
    );
  }

  const { executionId } = await params;

  const executions = await db
    .select()
    .from(directExecutions)
    .where(
      and(
        eq(directExecutions.id, executionId),
        eq(directExecutions.organizationId, apiKeyCtx.organizationId)
      )
    )
    .limit(1);

  const execution = executions[0];

  if (!execution) {
    // The request already consumed a rate-limit slot, so advertise its state.
    return applyRateLimitHeaders(
      NextResponse.json(
        { error: "Execution not found" },
        { status: HttpStatus.NOT_FOUND }
      ),
      rateLimit
    );
  }

  const output = execution.output as Record<string, unknown> | null;

  const response: ExecutionStatusResponse = {
    executionId: execution.id,
    status: execution.status as ExecutionStatusResponse["status"],
    type: execution.type,
    transactionHash: execution.transactionHash,
    transactionLink: (output?.transactionLink as string) ?? null,
    sponsored: Boolean(output?.sponsored),
    receipts: execution.receipts,
    result: output ?? null,
    error: execution.error,
    gasUsedWei: execution.gasUsedWei,
    gasPriceWei: execution.gasPriceWei,
    estimatedCostUsd: execution.estimatedCostUsd,
    retryCount: execution.retryCount,
    network: execution.network,
    createdAt: execution.createdAt.toISOString(),
    completedAt: execution.completedAt?.toISOString() ?? null,
  };

  const pollIntervalHint = TERMINAL_STATUSES.has(response.status)
    ? 0
    : POLL_INTERVAL_HINT_SECONDS;

  return applyRateLimitHeaders(NextResponse.json(response), rateLimit, {
    pollIntervalHint,
  });
}
