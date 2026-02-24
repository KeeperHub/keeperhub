import { count, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { authenticateApiKey } from "@/keeperhub/lib/api-key-auth";
import { resolveCreatorContext } from "@/keeperhub/lib/middleware/auth-helpers";
import { getOrgContext } from "@/keeperhub/lib/middleware/org-context";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { tags, workflows } from "@/lib/db/schema";

export async function GET(request: Request): Promise<NextResponse> {
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

    const orgTags = await db
      .select({
        id: tags.id,
        name: tags.name,
        color: tags.color,
        organizationId: tags.organizationId,
        userId: tags.userId,
        createdAt: tags.createdAt,
        updatedAt: tags.updatedAt,
        workflowCount: count(workflows.id),
      })
      .from(tags)
      .leftJoin(workflows, eq(workflows.tagId, tags.id))
      .where(eq(tags.organizationId, organizationId))
      .groupBy(tags.id)
      .orderBy(tags.name);

    const response = orgTags.map((t) => ({
      ...t,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    }));

    return NextResponse.json(response);
  } catch (error) {
    console.error("[Tags] Failed to list tags:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to list tags",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
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

    if (!body.color) {
      return NextResponse.json({ error: "Color is required" }, { status: 400 });
    }

    const [newTag] = await db
      .insert(tags)
      .values({
        name,
        color: body.color,
        organizationId,
        userId: creatorUserId,
      })
      .returning();

    return NextResponse.json(
      {
        ...newTag,
        workflowCount: 0,
        createdAt: newTag.createdAt.toISOString(),
        updatedAt: newTag.updatedAt.toISOString(),
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[Tags] Failed to create tag:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to create tag",
      },
      { status: 500 }
    );
  }
}
