import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { authenticateKhAdmin } from "@/lib/kh-admin-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

export async function POST(
  request: Request,
  context: { params: Promise<{ userId: string }> }
): Promise<NextResponse> {
  const auth = authenticateKhAdmin(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const { userId } = await context.params;

  try {
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: users.id, deactivatedAt: users.deactivatedAt })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (!existing) {
        return { conflict: "not_found" as const };
      }
      if (!existing.deactivatedAt) {
        return { conflict: "not_deactivated" as const };
      }

      await tx
        .update(users)
        .set({ deactivatedAt: null, updatedAt: now })
        .where(eq(users.id, userId));

      return { userId, activatedAt: now };
    });

    if ("conflict" in result) {
      if (result.conflict === "not_found") {
        return NextResponse.json({ error: "User not found" }, { status: 404 });
      }
      return NextResponse.json(
        { error: "User is not deactivated" },
        { status: 409 }
      );
    }

    await recordAuditEvent({
      actor: {
        userId: null,
        organizationId: null,
        authMethod: "kh-admin",
        actorLabel: "KeeperHub admin",
      },
      action: "account.reactivated",
      resourceType: "user",
      resourceId: result.userId,
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json(result);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Admin] Failed to activate user",
      error,
      {
        userId,
      }
    );
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
