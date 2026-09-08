import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { member, organization } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rows = await db
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        logo: organization.logo,
        createdAt: organization.createdAt,
        metadata: organization.metadata,
        role: member.role,
      })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(
        and(
          eq(member.userId, session.user.id),
          isNull(organization.deactivatedAt)
        )
      );

    return NextResponse.json(rows, { status: 200 });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to list organizations",
      error,
      { endpoint: "/api/organizations", operation: "get" }
    );
    return NextResponse.json(
      { error: "Failed to list organizations" },
      { status: 500 }
    );
  }
}
