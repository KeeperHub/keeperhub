import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { member, organizationApiKeys, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { parseScopeInput } from "@/lib/mcp/oauth-scopes";
import { STEP_UP_ACTIONS } from "@/lib/mfa/step-up-policy";
import {
  authFailureResponse,
  resolveOrganizationId,
} from "@/lib/middleware/auth-helpers";
import { authorizeAction } from "@/lib/middleware/authorize-action";
import { getOrgContext } from "@/lib/middleware/org-context";
import { generateOrganizationApiKey } from "@/lib/organization-api-key";
import { buildPage, parsePageRequest } from "@/lib/pagination";
import { notifyApiKeyChange } from "@/lib/security/api-key-notification";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

// Key generation lives in lib/organization-api-key.ts so the device-login
// path mints byte-identical credentials; api-key-auth validates the shared
// `kh_` prefix and SHA-256 hash, which a second implementation could drift from.
const generateApiKey = generateOrganizationApiKey;

// GET - List all API keys for the current organization
export async function GET(request: Request) {
  try {
    const authCtx = await resolveOrganizationId(request);
    if ("error" in authCtx) {
      return authFailureResponse(authCtx, request.headers);
    }
    const { organizationId: activeOrgId } = authCtx;

    const url = new URL(request.url);
    const req = parsePageRequest(url);
    const where = and(
      eq(organizationApiKeys.organizationId, activeOrgId),
      isNull(organizationApiKeys.revokedAt)
    );

    const [{ total }] = await db
      .select({ total: count() })
      .from(organizationApiKeys)
      .where(where);

    const keys = await db.query.organizationApiKeys.findMany({
      where,
      columns: {
        id: true,
        name: true,
        keyPrefix: true,
        createdBy: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        scope: true,
      },
      orderBy: (table, { desc }) => [desc(table.createdAt)],
      limit: req.pageSize,
      offset: req.offset,
    });

    // Enrich creators with name + email + org role so the key-activity
    // fallback can identify them as fully as a real audit event.
    const creatorIds = [
      ...new Set(keys.map((k) => k.createdBy).filter(Boolean)),
    ] as string[];
    const creators =
      creatorIds.length > 0
        ? await db
            .select({
              id: users.id,
              name: users.name,
              email: users.email,
              role: member.role,
            })
            .from(users)
            .leftJoin(
              member,
              and(
                eq(member.userId, users.id),
                eq(member.organizationId, activeOrgId)
              )
            )
            .where(inArray(users.id, creatorIds))
        : [];
    const creatorMap = new Map(creators.map((u) => [u.id, u]));

    const items = keys.map((key) => {
      const creator = key.createdBy ? creatorMap.get(key.createdBy) : undefined;
      return {
        ...key,
        createdByName: creator?.name ?? null,
        createdByEmail: creator?.email ?? null,
        createdByRole: creator?.role ?? null,
        createdBy: undefined,
      };
    });

    return NextResponse.json(buildPage(items, total, req, url));
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[API Keys] Failed to list API keys",
      error,
      { endpoint: "/api/keys", operation: "list" }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to list API keys",
      },
      { status: 500 }
    );
  }
}

// POST - Create a new API key for the current organization
export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const orgContext = await getOrgContext();
    const activeOrgId = orgContext.organization?.id;

    if (!activeOrgId) {
      return NextResponse.json(
        { error: "No active organization" },
        { status: 400 }
      );
    }

    // Parse the body once: step-up codes plus the key fields used below.
    const body = await request.json().catch(() => ({}));

    // Minting an org API key creates a long-lived credential that bypasses
    // session MFA forever, so gate it with admin role + a fresh step-up
    // (dual-factor for email/OAuth, a wallet signature for wallet accounts).
    const authorized = await authorizeAction({
      session,
      action: STEP_UP_ACTIONS.orgApiKeyManage,
      roleFloor: "admin",
      organizationId: activeOrgId,
      body,
      headers: request.headers,
    });
    if (!authorized.ok) {
      return authorized.response;
    }
    const name = body.name || null;
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    const scope = parseScopeInput(body.scopes);

    // Generate new API key
    const { key, hash, prefix } = generateApiKey();

    // Save to database
    const [newKey] = await db
      .insert(organizationApiKeys)
      .values({
        organizationId: activeOrgId,
        name,
        keyHash: hash,
        keyPrefix: prefix,
        createdBy: session.user.id,
        expiresAt,
        scope,
      })
      .returning({
        id: organizationApiKeys.id,
        name: organizationApiKeys.name,
        keyPrefix: organizationApiKeys.keyPrefix,
        createdAt: organizationApiKeys.createdAt,
        expiresAt: organizationApiKeys.expiresAt,
      });

    // Out-of-band alert + durable audit record, symmetric with user keys.
    notifyApiKeyChange({
      userId: session.user.id,
      loginEmail: session.user.email,
      action: "created",
      tokenName: newKey.name,
      keyPrefix: newKey.keyPrefix,
      when: newKey.createdAt,
    });
    await recordAuditEvent({
      actor: {
        userId: session.user.id,
        organizationId: activeOrgId,
        authMethod: "session",
      },
      action: "org_api_key.created",
      resourceType: "org_api_key",
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
    logSystemError(
      ErrorCategory.DATABASE,
      "[API Keys] Failed to create API key",
      error,
      { endpoint: "/api/keys", operation: "create" }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create API key",
      },
      { status: 500 }
    );
  }
}
