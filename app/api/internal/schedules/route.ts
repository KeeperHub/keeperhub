import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { organization, workflowSchedules, workflows } from "@/lib/db/schema";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { workflowExecutableConditions } from "@/lib/workflow/executable";

export async function GET(request: Request) {
  const auth = await authenticateInternalService(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
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
    .innerJoin(organization, eq(workflows.organizationId, organization.id))
    .where(
      and(eq(workflowSchedules.enabled, true), workflowExecutableConditions())
    );

  return NextResponse.json({ schedules });
}
