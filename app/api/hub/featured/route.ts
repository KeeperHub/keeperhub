import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";

type FeaturedFields = {
  featured?: boolean;
  featuredOrder?: number | null;
  featuredProtocol?: string | null;
  featuredProtocolOrder?: number | null;
};

const ALLOWED_FEATURED_FIELDS: (keyof FeaturedFields)[] = [
  "featured",
  "featuredOrder",
  "featuredProtocol",
  "featuredProtocolOrder",
];

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const auth = await authenticateInternalService(request, rawBody);
    if (!auth.authenticated || auth.caller !== "hub") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = JSON.parse(rawBody);
    const { workflowId, ...fields } = body;

    if (!workflowId || typeof workflowId !== "string") {
      return NextResponse.json(
        { error: "workflowId is required" },
        { status: 400 }
      );
    }

    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const updateData: FeaturedFields = {};

    const isProtocolFeatured =
      "featuredProtocol" in fields && fields.featuredProtocol;
    if (fields.featured === undefined && !isProtocolFeatured) {
      updateData.featured = true;
    }

    for (const field of ALLOWED_FEATURED_FIELDS) {
      if (field in fields) {
        updateData[field] = fields[field];
      }
    }

    const [updated] = await db
      .update(workflows)
      .set(updateData)
      .where(eq(workflows.id, workflowId))
      .returning({
        id: workflows.id,
        name: workflows.name,
        featured: workflows.featured,
        featuredOrder: workflows.featuredOrder,
        featuredProtocol: workflows.featuredProtocol,
        featuredProtocolOrder: workflows.featuredProtocolOrder,
      });

    return NextResponse.json({
      success: true,
      workflow: updated,
    });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "[Hub Featured] Error", error, {
      endpoint: "/api/hub/featured",
      operation: "update",
    });
    return NextResponse.json(
      { error: "Failed to update featured workflow" },
      { status: 500 }
    );
  }
}
