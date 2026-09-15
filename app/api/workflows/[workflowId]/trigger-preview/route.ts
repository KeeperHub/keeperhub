import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { checkRateLimit } from "@/app/api/execute/_lib/rate-limit";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { getWorkflowAccess } from "@/lib/workflow/access";
import {
  MAX_LOOKBACK_BLOCKS,
  runEventTriggerPreview,
  type WorkflowTriggerPreviewNode,
} from "@/lib/workflow/trigger-preview/event-trigger-preview";

/**
 * Time budget for the chain scan. A widest-window preview is 25 sequential
 * `eth_getLogs` calls, so the scan stops at this point and reports what it
 * covered rather than holding the request open. Matches the order of the
 * preflight simulation route's own deadline.
 */
const PREVIEW_DEADLINE_MS = 20_000;

/**
 * Preview a workflow's Event trigger against recent chain history.
 *
 * Read-only and advisory: it answers whether the trigger can fire at all and
 * how often it would have fired, without signing, executing or recording
 * anything. Access and rate limiting mirror the preflight simulation route.
 */
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
    `trigger-preview:${
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

  const lookbackBlocks = await readLookbackBlocks(request);
  if (lookbackBlocks === "invalid") {
    return applyRateLimitHeaders(
      NextResponse.json(
        {
          ok: false,
          error: "INVALID_LOOKBACK_BLOCKS",
          maxLookbackBlocks: MAX_LOOKBACK_BLOCKS,
        },
        { status: 400 }
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

  const result = await runEventTriggerPreview({
    nodes: (row.nodes ?? []) as WorkflowTriggerPreviewNode[],
    userId: authContext.userId ?? undefined,
    lookbackBlocks,
    deadlineAt: Date.now() + PREVIEW_DEADLINE_MS,
  });

  return applyRateLimitHeaders(
    NextResponse.json({ ok: true, result }),
    rateLimit
  );
}

/**
 * Read the optional `lookbackBlocks` override.
 *
 * An absent or empty body is the normal case and uses the default window; a
 * present but unusable value is rejected rather than silently defaulted, so a
 * caller that meant to widen the window is told it did not.
 */
async function readLookbackBlocks(
  request: Request
): Promise<number | undefined | "invalid"> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return;
  }

  if (typeof body !== "object" || body === null) {
    return;
  }

  const raw = (body as { lookbackBlocks?: unknown }).lookbackBlocks;
  if (raw === undefined || raw === null) {
    return;
  }

  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw <= 0 ||
    raw > MAX_LOOKBACK_BLOCKS
  ) {
    return "invalid";
  }

  return raw;
}
