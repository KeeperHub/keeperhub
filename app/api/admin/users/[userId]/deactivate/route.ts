import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { organizationApiKeys, sessions, users } from "@/lib/db/schema";
import { sendAccountDeactivatedEmail } from "@/lib/email";
import { authenticateKhAdmin } from "@/lib/kh-admin-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

// The body is optional; callers (raita-bot auto-block, on-call tooling) may
// POST nothing at all. notifyUser defaults to true so a deactivated user is
// told their account was disabled and how to reach us.
async function parseNotifyUser(request: Request): Promise<boolean> {
  try {
    const body = (await request.json()) as { notifyUser?: unknown };
    return body?.notifyUser !== false;
  } catch {
    return true;
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ userId: string }> }
): Promise<NextResponse> {
  const auth = authenticateKhAdmin(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const { userId } = await context.params;
  const notifyUser = await parseNotifyUser(request);

  try {
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          deactivatedAt: users.deactivatedAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (!existing) {
        return { conflict: "not_found" as const };
      }
      if (existing.deactivatedAt) {
        return { conflict: "already_deactivated" as const };
      }

      await tx
        .update(users)
        .set({ deactivatedAt: now, updatedAt: now })
        .where(eq(users.id, userId));

      // Invalidate all active sessions immediately.
      await tx.delete(sessions).where(eq(sessions.userId, userId));

      // Revoke any org API keys this user created.
      await tx
        .update(organizationApiKeys)
        .set({ revokedAt: now })
        .where(
          and(
            eq(organizationApiKeys.createdBy, userId),
            isNull(organizationApiKeys.revokedAt)
          )
        );

      // DB triggers that fire automatically on users.deactivated_at update:
      //   cascade_user_deactivation (0085): deletes api_keys, mcp tokens, device codes
      //   cascade_org_deactivation_on_owner (0099): deactivates orgs where user
      //     was the sole active owner

      return {
        userId,
        name: existing.name,
        email: existing.email,
        deactivatedAt: now,
      };
    });

    if ("conflict" in result) {
      if (result.conflict === "not_found") {
        return NextResponse.json({ error: "User not found" }, { status: 404 });
      }
      return NextResponse.json(
        { error: "User is already deactivated" },
        { status: 409 }
      );
    }

    // Best-effort notification, fired after the transaction commits. A failed
    // send must not fail the deactivation -- the account is already disabled.
    if (notifyUser && result.email) {
      try {
        await sendAccountDeactivatedEmail({
          email: result.email,
          name: result.name,
        });
      } catch (emailError) {
        logSystemError(
          ErrorCategory.EXTERNAL_SERVICE,
          "[Admin] Failed to send deactivation email",
          emailError,
          { userId }
        );
      }
    }

    await recordAuditEvent({
      actor: {
        userId: null,
        organizationId: null,
        authMethod: "kh-admin",
        actorLabel: "KeeperHub admin",
      },
      action: "account.deactivated",
      resourceType: "user",
      resourceId: result.userId,
      after: { deactivatedAt: result.deactivatedAt.toISOString() },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({
      userId: result.userId,
      deactivatedAt: result.deactivatedAt,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Admin] Failed to deactivate user",
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
