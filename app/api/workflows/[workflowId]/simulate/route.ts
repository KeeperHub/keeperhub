import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { checkRateLimit } from "@/app/api/execute/_lib/rate-limit";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { getWorkflowAccess } from "@/lib/workflow/access";
import {
  runWorkflowSimulation,
  type WorkflowSimulationEdge,
  WorkflowSimulationDeadlineError,
  type WorkflowSimulationNode,
  type WorkflowSimulationResult,
} from "@/lib/workflow/run-simulation";

const MAX_SIMULATION_NODES = 50;
const SIMULATION_DEADLINE_MS = 15_000;

export async function POST(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
): Promise<NextResponse> {
  const { workflowId } = await context.params;

  const authContext = await getDualAuthContext(request, { required: true });
  if ("error" in authContext) {
    return NextResponse.json(
      { ok: false, error: authContext.error },
      { status: authContext.status }
    );
  }

  const rateLimit = checkRateLimit(
    `workflow-simulation:${
      authContext.apiKeyId ??
      authContext.userId ??
      authContext.organizationId ??
      "unknown"
    }`
  );
  if (!rateLimit.allowed) {
    return applyRateLimitHeaders(
      NextResponse.json(
        { ok: false, error: "RATE_LIMIT_EXCEEDED" },
        { status: 429 }
      ),
      rateLimit
    );
  }

  const rows = await db
    .select()
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .limit(1);

  if (rows.length === 0) {
    return applyRateLimitHeaders(
      NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 }),
      rateLimit
    );
  }

  const row = rows[0];

  const access = await getWorkflowAccess(row, {
    userId: authContext.userId,
    organizationId: authContext.organizationId,
    authMethod: authContext.authMethod,
  });

  if (access.isDeleted) {
    return applyRateLimitHeaders(
      NextResponse.json({ ok: false, error: "GONE" }, { status: 410 }),
      rateLimit
    );
  }

  if (!access.hasFullAccess) {
    return applyRateLimitHeaders(
      NextResponse.json({ ok: false, error: "FORBIDDEN" }, { status: 403 }),
      rateLimit
    );
  }

  const nodes = (row.nodes ?? []) as WorkflowSimulationNode[];
  if (nodes.length > MAX_SIMULATION_NODES) {
    return applyRateLimitHeaders(
      NextResponse.json(
        {
          ok: false,
          error: "SIMULATION_NODE_LIMIT_EXCEEDED",
          maxNodeCount: MAX_SIMULATION_NODES,
        },
        { status: 413 }
      ),
      rateLimit
    );
  }

  try {
    const result = await runWorkflowSimulation({
      organizationId: row.organizationId,
      nodes,
      edges: (row.edges ?? []) as WorkflowSimulationEdge[],
      deadlineAt: Date.now() + SIMULATION_DEADLINE_MS,
    });

    return applyRateLimitHeaders(
      NextResponse.json({
        ok: true,
        result: formatResult(result),
      }),
      rateLimit
    );
  } catch (error) {
    const errorCode =
      error instanceof WorkflowSimulationDeadlineError
        ? "SIMULATION_TIMEOUT"
        : "SIMULATION_UNAVAILABLE";

    return applyRateLimitHeaders(
      NextResponse.json({ ok: false, error: errorCode }, { status: 503 }),
      rateLimit
    );
  }
}

/**
 * Keep the route response compact: an empty warning array is omitted rather
 * than returned as an empty array.
 */
function formatResult(
  result: WorkflowSimulationResult
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    simulatedNodeCount: result.simulatedNodeCount,
    skippedNodeCount: result.skippedNodeCount,
  };

  if (result.warnings.length > 0) {
    out.warnings = result.warnings;
  }

  return out;
}
