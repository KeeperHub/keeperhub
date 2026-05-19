import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflowSchedules, workflows } from "@/lib/db/schema";
import { authenticateInternalService } from "@/lib/internal-service-auth";

export async function GET(request: Request) {
  const auth = authenticateInternalService(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error || "Unauthorized" },
      { status: 401 }
    );
  }

  const schedules = await db
    .select({
      id: workflowSchedules.id,
      workflowId: workflowSchedules.workflowId,
      cronExpression: workflowSchedules.cronExpression,
      timezone: workflowSchedules.timezone,
      // KEEP-575: interval-mode fields. When intervalSeconds is non-null
      // the dispatcher fires on anchorAt + k * intervalSeconds instead of
      // parsing cronExpression.
      intervalSeconds: workflowSchedules.intervalSeconds,
      anchorAt: workflowSchedules.anchorAt,
    })
    .from(workflowSchedules)
    .innerJoin(workflows, eq(workflowSchedules.workflowId, workflows.id))
    .where(
      and(eq(workflowSchedules.enabled, true), eq(workflows.enabled, true))
    );

  return NextResponse.json({ schedules });
}
