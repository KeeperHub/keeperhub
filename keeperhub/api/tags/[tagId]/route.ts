import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { resolveOrganizationId } from "@/keeperhub/lib/middleware/auth-helpers";
import { db } from "@/lib/db";
import { tags } from "@/lib/db/schema";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ tagId: string }> }
): Promise<NextResponse> {
  try {
    const { tagId } = await context.params;

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

    if (body.color !== undefined) {
      if (!body.color) {
        return NextResponse.json(
          { error: "Color cannot be empty" },
          { status: 400 }
        );
      }
      updateData.color = body.color;
    }

    const [updated] = await db
      .update(tags)
      .set(updateData)
      .where(and(eq(tags.id, tagId), eq(tags.organizationId, organizationId)))
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Tag not found" }, { status: 404 });
    }

    return NextResponse.json({
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (error) {
    console.error("[Tags] Failed to update tag:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to update tag",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ tagId: string }> }
): Promise<NextResponse> {
  try {
    const { tagId } = await context.params;

    const authResult = await resolveOrganizationId(request);
    if ("error" in authResult) {
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status }
      );
    }

    const { organizationId } = authResult;

    const result = await db
      .delete(tags)
      .where(and(eq(tags.id, tagId), eq(tags.organizationId, organizationId)))
      .returning({ id: tags.id });

    if (result.length === 0) {
      return NextResponse.json({ error: "Tag not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Tags] Failed to delete tag:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to delete tag",
      },
      { status: 500 }
    );
  }
}
