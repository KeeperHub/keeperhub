import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import {
  checkDispatchAdmission,
  type DispatchRefusal,
} from "@/lib/billing/dispatch-admission";
import { enforceExecutionLimit } from "@/lib/billing/execution-guard";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { extractActionTypeNodes } from "@/lib/features";
import { enforceWorkflowFeatures } from "@/lib/features/route-guard";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { logWarn } from "@/lib/logging";
import { recordWorkflowExecutionSkipped } from "@/lib/metrics/collectors/prometheus";
import { resolveOrgSlugForCounter } from "@/lib/metrics/org-slug.server";
import { withBackstopCapture } from "@/lib/security/backstop-capture";
import {
  buildAttribution,
  type TriggerSource,
} from "@/lib/security/request-attribution";
import { hashWorkflowDefinition } from "@/lib/workflow/content-hash";

const VALID_TRIGGER_SOURCES: readonly TriggerSource[] = [
  "manual",
  "webhook",
  "scheduled",
  "schedule",
  "mcp",
  "internal",
  "block",
  "event",
];

/**
 * Resolve a caller-supplied trigger source to a known value, defaulting to
 * "internal" for unknown/absent input. Schedulers pass "schedule" | "block" |
 * "event" when pre-creating a phantom so the audit column reflects the real
 * entry point rather than the generic internal-API path.
 */
function resolveTriggerSource(value: unknown): TriggerSource {
  if (typeof value === "string") {
    const match = VALID_TRIGGER_SOURCES.find((source) => source === value);
    if (match) {
      return match;
    }
  }
  return "internal";
}

/**
 * Record a refused dispatch so its author still sees why the trigger stopped
 * firing, without writing one row per occurrence. The synthetic dispatch key
 * buckets by hour, so the unique index collapses every further refusal of the
 * same workflow for the same reason within that hour into a no-op insert. A
 * block trigger on a fast chain would otherwise write a row per block.
 *
 * Best-effort: the refusal itself is already decided, so a failed insert must
 * not turn into a failed response, which the dispatcher would read as a
 * transport error and fall through to the id-less enqueue.
 */
async function recordRefusedDispatch(params: {
  request: Request;
  workflowId: string;
  organizationId: string;
  userId: string;
  source: TriggerSource;
  refusal: DispatchRefusal;
}): Promise<void> {
  const now = new Date();
  const hourBucket = now.toISOString().slice(0, 13);
  const dispatchKey = `refused:${params.workflowId}:${params.refusal.reason}:${hourBucket}`;

  try {
    await db
      .insert(workflowExecutions)
      .values({
        workflowId: params.workflowId,
        organizationId: params.organizationId,
        userId: params.userId,
        // Refused before it started, so it is neither a failure nor billable.
        // Matches what the executor writes when it refuses the same run.
        status: "skipped",
        billable: false,
        input: {},
        dispatchKey,
        error: params.refusal.message,
        errorCategory: "billing",
        errorType: "user",
        startedAt: now,
        completedAt: now,
        ...buildAttribution({ request: params.request, source: params.source }),
      })
      .onConflictDoNothing({ target: workflowExecutions.dispatchKey });

    // Counted per refusal, not per row, so the hour bucketing above does not
    // hide the real volume from the metric.
    recordWorkflowExecutionSkipped({
      orgSlug: await resolveOrgSlugForCounter(params.workflowId),
      reason: params.refusal.reason,
    });
  } catch (error) {
    logWarn("[Admission] Failed to record refused dispatch", {
      workflowId: params.workflowId,
      reason: params.refusal.reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const auth = await authenticateInternalService(request, rawBody);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
    );
  }

  const body = JSON.parse(rawBody);
  const { workflowId, userId, input, status, triggerSource, dispatchKey } =
    body;

  // Optional dispatch-idempotency key. When two dispatcher replicas
  // overlap (failover / rolling restart) or a catch-up window re-runs an
  // occurrence, both compute the same key; the unique index turns the second
  // insert into a no-op so only one phantom row (and one SQS message) exists.
  const dispatchKeyValue: string | null =
    typeof dispatchKey === "string" && dispatchKey.length > 0
      ? dispatchKey
      : null;

  // A phantom row represents an expected-but-unstarted trigger that the
  // scheduler/event-tracker pre-creates; the executor later upgrades it to
  // running. Any other status keeps the existing direct-execution behaviour of
  // creating a row already marked running.
  const isPhantom = status === "phantom";

  if (!workflowId) {
    return NextResponse.json(
      { error: "workflowId is required" },
      { status: 400 }
    );
  }

  const workflow = await db.query.workflows.findFirst({
    where: eq(workflows.id, workflowId),
    columns: {
      organizationId: true,
      deletedAt: true,
      nodes: true,
      edges: true,
      userId: true,
    },
  });

  // KEEP-440: never create an execution for a soft-deleted workflow.
  if (!workflow || workflow.deletedAt) {
    return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  }

  // KEEP-693: the cron scheduler does not know the workflow owner, so userId is
  // optional in the request and falls back to the workflow's owner. The
  // workflow's userId FK is non-null, so ownerId is always resolved here.
  const ownerId: string = userId ?? workflow.userId;

  const source = resolveTriggerSource(triggerSource);

  // A phantom is created by a dispatcher on every occurrence of its trigger, so
  // admission runs here rather than one hop later on the executor: a refused
  // occurrence then costs an hour-bucketed row at most, instead of a row plus an
  // SQS message plus an executor round-trip every time. The refusal is reported
  // as a 200 so it can never be read as a transport failure, which the
  // dispatchers deliberately fall through to the id-less enqueue.
  if (isPhantom) {
    const refusal = await checkDispatchAdmission({
      organizationId: workflow.organizationId,
      nodes: workflow.nodes as unknown[],
    });
    if (refusal) {
      await recordRefusedDispatch({
        request,
        workflowId,
        organizationId: workflow.organizationId,
        userId: ownerId,
        source,
        refusal,
      });
      return NextResponse.json(
        { refused: true, reason: refusal.reason, error: refusal.message },
        { status: 200 }
      );
    }
  } else {
    const featureGuard = await enforceWorkflowFeatures(
      extractActionTypeNodes(workflow.nodes as unknown[]),
      workflow.organizationId
    );
    if (featureGuard.blocked) {
      return featureGuard.response;
    }

    const executionGuard = await enforceExecutionLimit(workflow.organizationId);
    if (executionGuard.blocked) {
      return executionGuard.response;
    }
  }

  const attribution = buildAttribution({ request, source });

  const inserted = await withBackstopCapture(
    { workflowId, userId: ownerId, source },
    () =>
      db
        .insert(workflowExecutions)
        .values({
          workflowId,
          organizationId: workflow.organizationId,
          userId: ownerId,
          status: isPhantom ? "phantom" : "running",
          // KEEP-693: a phantom has not run yet, so it must not count toward the
          // org's billable executions -- the executor flips it to billable when
          // it upgrades the row to running. Non-phantom (direct) rows stay
          // billable as before.
          billable: !isPhantom,
          input: input || {},
          dispatchKey: dispatchKeyValue,
          ...attribution,
          // Tie the run to the workflow version that fired it. For phantoms the
          // executor restamps this with the definition it actually loads at run
          // time; this value links the row even if that restamp never lands.
          executedWorkflowHash: hashWorkflowDefinition(
            workflow.nodes,
            workflow.edges
          ),
        })
        // No-op if another dispatcher already created a row for this dispatch
        // key. NULL keys never conflict (Postgres treats them as distinct).
        .onConflictDoNothing({ target: workflowExecutions.dispatchKey })
        .returning({ id: workflowExecutions.id })
  );

  const created = inserted[0];
  if (created) {
    return NextResponse.json(
      { executionId: created.id, alreadyExisted: false },
      { status: 201 }
    );
  }

  // Conflict: a row already exists for this dispatch key. Return its id and
  // flag it so the caller skips the duplicate SQS send. Only reachable with a
  // non-null key, so the lookup is well-defined.
  const [existing] = await db
    .select({ id: workflowExecutions.id })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.dispatchKey, dispatchKeyValue as string))
    .limit(1);

  if (existing) {
    return NextResponse.json(
      { executionId: existing.id, alreadyExisted: true },
      { status: 200 }
    );
  }

  // Conflict reported but the row is gone (deleted between insert and lookup).
  // Fail loudly rather than silently dropping the trigger.
  return NextResponse.json(
    { error: "Failed to create execution" },
    { status: 500 }
  );
}
