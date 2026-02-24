import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { resolveOrganizationId } from "@/keeperhub/lib/middleware/auth-helpers";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await context.params;

    const authResult = await resolveOrganizationId(request);
    if ("error" in authResult) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status }
      );
    }

    const { organizationId } = authResult;

    const body = await request.json().catch(() => ({}));

    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (body.name !== undefined) {
      const name = body.name?.trim();
      if (!name) {
        return NextResponse.json(
          { error: "Name cannot be empty" },
          { status: 400 }
        );
      }
      updateData.name = name;
    }

    if (body.description !== undefined) {
      updateData.description = body.description?.trim() || null;
    }

    if (body.color !== undefined) {
      updateData.color = body.color || null;
    }

    const [updated] = await db
      .update(projects)
      .set(updateData)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId)
        )
      )
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    return NextResponse.json({
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (error) {
    console.error("[Projects] Failed to update project:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to update project",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await context.params;

    const authResult = await resolveOrganizationId(request);
    if ("error" in authResult) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status }
      );
    }

    const { organizationId } = authResult;

    const result = await db
      .delete(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId)
        )
      )
      .returning({ id: projects.id });

    if (result.length === 0) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Projects] Failed to delete project:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to delete project",
      },
      { status: 500 }
    );
  }
}
