import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiKeys } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { STEP_UP_ACTIONS } from "@/lib/mfa/step-up-policy";
import { authorizeAction } from "@/lib/middleware/authorize-action";
import { notifyApiKeyChange } from "@/lib/security/api-key-notification";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

// DELETE - Delete an API key
export async function DELETE(
  request: Request,
  context: { params: Promise<{ keyId: string }> }
) {
  try {
    const { keyId } = await context.params;
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      code?: string;
      emailOtp?: string;
      signature?: string;
    };
    const authorized = await authorizeAction({
      session,
      action: STEP_UP_ACTIONS.apiKeyManage,
      roleFloor: "none",
      body,
      headers: request.headers,
    });
    if (!authorized.ok) {
      return authorized.response;
    }

    // Delete the key (only if it belongs to the user)
    const [deleted] = await db
      .delete(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, session.user.id)))
      .returning({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
      });

    if (!deleted) {
      return NextResponse.json({ error: "API key not found" }, { status: 404 });
    }

    // Out-of-band alert symmetric with creation: the owner learns a bypass
    // credential was revoked even if their own session did it. Non-blocking.
    notifyApiKeyChange({
      userId: session.user.id,
      loginEmail: session.user.email,
      action: "revoked",
      tokenName: deleted.name,
      keyPrefix: deleted.keyPrefix,
      when: new Date(),
    });

    // Durable forensic record of who revoked the key and from where.
    await recordAuditEvent({
      actor: {
        userId: session.user.id,
        organizationId: null,
        authMethod: "session",
      },
      action: "api_key.revoked",
      resourceType: "api_key",
      resourceId: deleted.id,
      before: { name: deleted.name, keyPrefix: deleted.keyPrefix },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to delete API key", error, {
      endpoint: "/api/api-keys/[keyId]",
      operation: "delete",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to delete API key",
      },
      { status: 500 }
    );
  }
}
