import { count, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { authenticateApiKey } from "@/keeperhub/lib/api-key-auth";
import { resolveCreatorContext } from "@/keeperhub/lib/middleware/auth-helpers";
import { getOrgContext } from "@/keeperhub/lib/middleware/org-context";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, workflows } from "@/lib/db/schema";

const DEFAULT_COLORS = [
  "#4A90D9",
  "#7B61FF",
  "#E06C75",
  "#98C379",
  "#E5C07B",
  "#56B6C2",
  "#C678DD",
  "#D19A66",
];

export async function GET(request: Request) {
  try {
    const apiKeyAuth = await authenticateApiKey(request);
    let organizationId: string | null;

    if (apiKeyAuth.authenticated) {
      organizationId = apiKeyAuth.organizationId || null;
    } else {
      const session = await auth.api.getSession({
        headers: request.headers,
      });

      if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const context = await getOrgContext();
      organizationId = context.organization?.id || null;
    }

    if (!organizationId) {
      return NextResponse.json(
        { error: "No active organization" },
        { status: 400 }
      );
    }

    const orgProjects = await db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        color: projects.color,
        organizationId: projects.organizationId,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
        workflowCount: count(workflows.id),
      })
      .from(projects)
      .leftJoin(workflows, eq(workflows.projectId, projects.id))
      .where(eq(projects.organizationId, organizationId))
      .groupBy(projects.id)
      .orderBy(projects.name);

    const response = orgProjects.map((p) => ({
      ...p,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    }));

    return NextResponse.json(response);
  } catch (error) {
    console.error("[Projects] Failed to list projects:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to list projects",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const resolved = await resolveCreatorContext(request);
    if ("error" in resolved) {
      return NextResponse.json(
        { error: resolved.error },
        { status: resolved.status }
      );
    }
    const { organizationId, userId: creatorUserId } = resolved;

    const body = await request.json().catch(() => ({}));
    const name = body.name?.trim();

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const existingCount = await db
      .select({ value: count() })
      .from(projects)
      .where(eq(projects.organizationId, organizationId));

    const colorIndex = (existingCount[0]?.value ?? 0) % DEFAULT_COLORS.length;
    const color = body.color || DEFAULT_COLORS[colorIndex];

    const [newProject] = await db
      .insert(projects)
      .values({
        name,
        description: body.description?.trim() || null,
        color,
        organizationId,
        userId: creatorUserId,
      })
      .returning();

    return NextResponse.json(
      {
        ...newProject,
        workflowCount: 0,
        createdAt: newProject.createdAt.toISOString(),
        updatedAt: newProject.updatedAt.toISOString(),
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[Projects] Failed to create project:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create project",
      },
      { status: 500 }
    );
  }
}
