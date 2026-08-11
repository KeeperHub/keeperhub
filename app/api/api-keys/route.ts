import { createHash, randomBytes } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiKeys } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { parseScopeInput } from "@/lib/mcp/oauth-scopes";
import { STEP_UP_ACTIONS } from "@/lib/mfa/step-up-policy";
import { authorizeAction } from "@/lib/middleware/authorize-action";
import { buildPage, parsePageRequest } from "@/lib/pagination";
import { notifyApiKeyChange } from "@/lib/security/api-key-notification";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

// Generate a secure API key
function generateApiKey(): { key: string; hash: string; prefix: string } {
  const randomPart = randomBytes(24).toString("base64url");
  const key = `wfb_${randomPart}`;
  const hash = createHash("sha256").update(key).digest("hex");
  const prefix = key.slice(0, 11); // "wfb_" + first 7 chars
  return { key, hash, prefix };
}

// GET - List all API keys for the current user
export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const req = parsePageRequest(url);
    const where = eq(apiKeys.userId, session.user.id);

    const [{ total }] = await db
      .select({ total: count() })
      .from(apiKeys)
      .where(where);

    const keys = await db.query.apiKeys.findMany({
      where,
      columns: {
        id: true,
        name: true,
        keyPrefix: true,
        createdAt: true,
        lastUsedAt: true,
        scope: true,
      },
      orderBy: (table, { desc }) => [desc(table.createdAt)],
      limit: req.pageSize,
      offset: req.offset,
    });

    return NextResponse.json(buildPage(keys, total, req, url));
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to list API keys", error, {
      endpoint: "/api/api-keys",
      operation: "get",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to list API keys",
      },
      { status: 500 }
    );
  }
}

// POST - Create a new API key
export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));

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

    const name = body.name || null;
    const scope = parseScopeInput(body.scopes);

    // Generate new API key
    const { key, hash, prefix } = generateApiKey();

    // Save to database
    const [newKey] = await db
      .insert(apiKeys)
      .values({
        userId: session.user.id,
        name,
        keyHash: hash,
        keyPrefix: prefix,
        scope,
      })
      .returning({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        createdAt: apiKeys.createdAt,
      });

    // Out-of-band alert so the owner learns a long-lived bypass credential
    // was minted, even if their own session did it. Non-blocking.
    notifyApiKeyChange({
      userId: session.user.id,
      loginEmail: session.user.email,
      action: "created",
      tokenName: newKey.name,
      keyPrefix: newKey.keyPrefix,
      when: newKey.createdAt,
    });

    // Durable forensic record of who minted the key and from where.
    await recordAuditEvent({
      actor: {
        userId: session.user.id,
        organizationId: null,
        authMethod: "session",
      },
      action: "api_key.created",
      resourceType: "api_key",
      resourceId: newKey.id,
      after: { name: newKey.name, keyPrefix: newKey.keyPrefix },
      metadata: buildAuditMetadata(request),
    });

    // Return the full key only on creation (won't be shown again)
    return NextResponse.json({
      ...newKey,
      key, // Full key - only returned once!
    });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to create API key", error, {
      endpoint: "/api/api-keys",
      operation: "post",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create API key",
      },
      { status: 500 }
    );
  }
}
