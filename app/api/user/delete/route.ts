import { and, count, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  organizationApiKeys,
  sessions,
  users,
  walletAddress,
} from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { STEP_UP_ACTIONS } from "@/lib/mfa/step-up-policy";
import { authorizeAction } from "@/lib/middleware/authorize-action";
import {
  buildActor,
  buildAuditMetadata,
  newCorrelationId,
  type RecordAuditEventArgs,
  recordAuditEvent,
  recordAuditEvents,
} from "@/lib/security/audit-log";

/**
 * POST /api/user/delete
 * Deactivates the user account (soft delete)
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as {
      confirmation?: string;
      code?: string;
      emailOtp?: string;
      signature?: string;
    };
    const { confirmation, code, emailOtp, signature } = body;

    if (confirmation !== "DEACTIVATE") {
      return NextResponse.json(
        { error: "Please type DEACTIVATE to confirm" },
        { status: 400 }
      );
    }

    const userId = session.user.id;

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    if (user.isAnonymous) {
      return NextResponse.json(
        { error: "Anonymous users cannot deactivate accounts" },
        { status: 403 }
      );
    }

    if (user.deactivatedAt) {
      return NextResponse.json(
        { error: "Account is already deactivated" },
        { status: 400 }
      );
    }

    const authorized = await authorizeAction({
      session,
      action: STEP_UP_ACTIONS.accountDeactivate,
      roleFloor: "none",
      body: { code, emailOtp, signature },
      headers: request.headers,
    });
    if (!authorized.ok) {
      return authorized.response;
    }

    // Run the deactivation writes in one transaction so a partial failure
    // never leaves the user marked deactivated while their sessions or
    // API keys remain valid. authenticateApiKey gates on
    // users.deactivatedAt as defence-in-depth, but Better Auth's session
    // path does not, so without this transaction a session-delete failure
    // after the users row update would leave the account reachable via
    // session cookie until expiry.
    // One id for the whole deactivation cascade so every effect below reads
    // back as a single unit via ?correlationId=. actorLabel snapshots the
    // email so the trail stays attributable even after this user row is purged.
    const correlationId = newCorrelationId();
    const actor = buildActor(
      { userId, organizationId: null, authMethod: "session", apiKeyId: null },
      { actorLabel: session.user.email }
    );
    const metadata = buildAuditMetadata(request);

    const now = new Date();
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ deactivatedAt: now, updatedAt: now })
          .where(eq(users.id, userId));

        const revokedSessions = await tx
          .delete(sessions)
          .where(eq(sessions.userId, userId))
          .returning({ id: sessions.id });

        // Soft-revoke any organization API keys this user issued. Without
        // this, a kh_ key with createdBy = userId would survive deactivation
        // and remain usable until manually revoked.
        const revokedKeys = await tx
          .update(organizationApiKeys)
          .set({ revokedAt: now })
          .where(
            and(
              eq(organizationApiKeys.createdBy, userId),
              isNull(organizationApiKeys.revokedAt)
            )
          )
          .returning({
            id: organizationApiKeys.id,
            organizationId: organizationApiKeys.organizationId,
          });

        // Count wallet addresses without removing them: deactivation is a
        // soft delete so the user row stays and the FK cascade does not fire.
        // The addresses are deliberately retained so the identity remains
        // reserved and cannot be re-registered. The audit event records the
        // count so auditors have a complete picture of the account state.
        const [walletCount] = await tx
          .select({ count: count() })
          .from(walletAddress)
          .where(eq(walletAddress.userId, userId));

        // Record the cascade atomically with the writes that produced it: a
        // root event plus one row per affected resource, all sharing the
        // correlation id. Passing `tx` makes a failed audit write roll the
        // whole deactivation back, so the trail can never disagree with reality.
        // This is deliberately stricter than the other audited routes (api-key,
        // totp, billing), which record post-action with the global db and
        // swallow audit failures: a deletion cascade is the one case where the
        // trail must be guaranteed consistent with what was actually deleted.
        const events: RecordAuditEventArgs[] = [
          {
            actor,
            action: "account.deactivated",
            resourceType: "user",
            resourceId: userId,
            correlationId,
            metadata: {
              ...metadata,
              sessionsRevoked: revokedSessions.length,
              apiKeysRevoked: revokedKeys.length,
              walletAddressesRetained: walletCount?.count ?? 0,
            },
          },
          {
            actor,
            action: "session.revoked",
            resourceType: "session",
            resourceId: userId,
            correlationId,
            metadata: { count: revokedSessions.length },
          },
          // Org-scope each key event so the owning org's admins can read the
          // revocation in their audit trail; the org-null root above stays a
          // user-level action.
          ...revokedKeys.map((key) => ({
            actor: { ...actor, organizationId: key.organizationId },
            action: "org_api_key.revoked",
            resourceType: "api_key",
            resourceId: key.id,
            correlationId,
          })),
        ];
        await recordAuditEvents(events, tx);
      });
    } catch (cascadeError) {
      // The cascade rolled back. Record a durable failure marker out-of-band
      // (default global db, best-effort) so the attempt still leaves a trace,
      // then rethrow to the handler below for the 500 response.
      await recordAuditEvent({
        actor,
        action: "account.deactivated",
        resourceType: "user",
        resourceId: userId,
        correlationId,
        outcome: "failed",
        metadata: {
          ...metadata,
          error:
            cascadeError instanceof Error
              ? cascadeError.message
              : String(cascadeError),
        },
      });
      throw cascadeError;
    }

    return NextResponse.json({
      success: true,
      message: "Account deactivated successfully",
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.AUTH,
      "[User Delete] Failed to deactivate account:",
      error,
      {
        endpoint: "/api/user/delete",
        status_code: "500",
      }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to deactivate account",
      },
      { status: 500 }
    );
  }
}
