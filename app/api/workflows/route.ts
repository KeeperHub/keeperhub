import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
// start custom keeperhub code //
import { authenticateApiKey } from "@/keeperhub/lib/api-key-auth";
import { ErrorCategory, logSystemError } from "@/keeperhub/lib/logging";
import { getOrgContext } from "@/keeperhub/lib/middleware/org-context";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
// end keeperhub code //

export async function GET(request: Request) {
  try {
    // start custom keeperhub code //
    // Try API key authentication first
    const apiKeyAuth = await authenticateApiKey(request);
    let organizationId: string | null;
    let userId: string | null = null;

    if (apiKeyAuth.authenticated) {
      // API key authentication successful
      organizationId = apiKeyAuth.organizationId || null;
    } else {
      // Fall back to session authentication
      const session = await auth.api.getSession({
        headers: request.headers,
      });

      if (!session?.user) {
        return NextResponse.json([], { status: 200 });
      }

      userId = session.user.id;

      // Get organization context from session
      const context = await getOrgContext();
      organizationId = context.organization?.id || null;
    }

    // Optional projectId filter
    const { searchParams } = new URL(request.url);
    const projectIdFilter = searchParams.get("projectId");
    const tagIdFilter = searchParams.get("tagId");

    const conditions =
      !organizationId && userId
        ? [eq(workflows.userId, userId), eq(workflows.isAnonymous, true)]
        : [
            eq(workflows.organizationId, organizationId ?? ""),
            eq(workflows.isAnonymous, false),
          ];

    if (projectIdFilter) {
      conditions.push(eq(workflows.projectId, projectIdFilter));
    }
    if (tagIdFilter) {
      conditions.push(eq(workflows.tagId, tagIdFilter));
    }

    const userWorkflows = await db
      .select()
      .from(workflows)
      .where(and(...conditions))
      .orderBy(asc(workflows.createdAt));
    // end keeperhub code //

    const mappedWorkflows = userWorkflows.map((workflow) => ({
      ...workflow,
      createdAt: workflow.createdAt.toISOString(),
      updatedAt: workflow.updatedAt.toISOString(),
    }));

    return NextResponse.json(mappedWorkflows);
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get workflows", error, {
      endpoint: "/api/workflows",
      operation: "get",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to get workflows",
      },
      { status: 500 }
    );
  }
}
