import { and, eq, isNotNull, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  organization,
  pythTriggerCheckpoints,
  workflows,
} from "@/lib/db/schema";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { logWarn } from "@/lib/logging";
import { isPythPriceTriggerEnabled } from "@/lib/pyth/feature-flag";
import {
  observePythPrice,
  type PythObservationRequest,
} from "@/lib/pyth/observe-price";
import { parsePythPriceUpdate } from "@/lib/pyth/price-trigger";
import { findPythConfig, hashPythConfig } from "@/lib/pyth/trigger-config";

import { workflowExecutableConditions } from "@/lib/workflow/executable";

const identity = {
  workflowId: z.string().min(1).max(128),
  configHash: z.string().regex(/^[a-f0-9]{64}$/),
  sessionId: z.string().uuid(),
};
const commandSchema = z.discriminatedUnion("action", [
  z.object({
    ...identity,
    action: z.literal("observe"),
    update: z.unknown(),
    rebaseline: z.boolean().optional(),
  }),
  z.object({ ...identity, action: z.literal("pending") }),
  z.object({
    ...identity,
    action: z.literal("ack"),
    executionId: z.string().min(1).max(128),
  }),
]);

async function authenticate(
  request: Request,
  body = ""
): Promise<NextResponse | null> {
  const auth = await authenticateInternalService(request, body);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  return auth.caller === "events"
    ? null
    : NextResponse.json({ error: "Events service required" }, { status: 403 });
}

// Any trigger node carrying a Pyth config. A superset of what registers:
// findPythConfig still narrows each match to the workflow's first trigger node.
const PYTH_TRIGGER_NODE = JSON.stringify([
  { data: { type: "trigger", config: { triggerType: "Pyth Price" } } },
]);

export async function GET(request: Request): Promise<NextResponse> {
  const denied = await authenticate(request);
  if (denied) {
    return denied;
  }
  const enabled = isPythPriceTriggerEnabled();
  // The recovery sweep asks only for workflows with a dispatch awaiting
  // enqueue, so an idle sweep costs one read instead of a transaction per
  // registered workflow.
  if (new URL(request.url).searchParams.get("view") === "pending") {
    if (!enabled) {
      return NextResponse.json({ pending: [] });
    }
    const rows = await db
      .select({ workflowId: pythTriggerCheckpoints.workflowId })
      .from(pythTriggerCheckpoints)
      .where(isNotNull(pythTriggerCheckpoints.pending));
    return NextResponse.json({ pending: rows.map((row) => row.workflowId) });
  }
  // `enabled` lets the event worker report a PYTH_API_KEY set on only one of
  // the two services, which otherwise fails silently in either direction.
  if (!enabled) {
    return NextResponse.json({ enabled: false, workflows: [] });
  }
  const active = await db
    .select({ id: workflows.id, nodes: workflows.nodes })
    .from(workflows)
    .innerJoin(organization, eq(organization.id, workflows.organizationId))
    .where(
      and(
        workflowExecutableConditions(),
        sql`${workflows.nodes} @> ${PYTH_TRIGGER_NODE}::jsonb`
      )
    );
  const registrations: {
    workflowId: string;
    feedId: string;
    configHash: string;
  }[] = [];
  for (const workflow of active) {
    try {
      const config = findPythConfig(workflow.nodes);
      if (config) {
        registrations.push({
          workflowId: workflow.id,
          feedId: config.feedId,
          configHash: hashPythConfig(config),
        });
      }
    } catch {
      logWarn("Invalid Pyth trigger configuration", {
        workflowId: workflow.id,
      });
    }
  }
  return NextResponse.json({ enabled: true, workflows: registrations });
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  if (rawBody.length > 16_384) {
    return NextResponse.json({ error: "Request too large" }, { status: 413 });
  }
  const denied = await authenticate(request, rawBody);
  if (denied) {
    return denied;
  }
  if (!isPythPriceTriggerEnabled()) {
    return NextResponse.json(
      { error: "Pyth Price triggers are disabled" },
      { status: 503 }
    );
  }
  let command: PythObservationRequest;
  try {
    const parsed = commandSchema.parse(JSON.parse(rawBody));
    command =
      parsed.action === "observe"
        ? { ...parsed, update: parsePythPriceUpdate(parsed.update) }
        : parsed;
  } catch {
    return NextResponse.json(
      { error: "Invalid Pyth observation" },
      { status: 400 }
    );
  }
  const result = await observePythPrice(command, request);
  return NextResponse.json(result);
}
