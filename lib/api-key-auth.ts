/**
 * API Key Authentication Middleware
 *
 * Authenticates requests using organization-scoped API keys.
 * Used by the MCP server to access KeeperHub APIs.
 *
 * Usage:
 * ```typescript
 * const authResult = await authenticateApiKey(request);
 * if (!authResult.authenticated) {
 *   return NextResponse.json(
 *     { error: authResult.error },
 *     { status: authResult.statusCode }
 *   );
 * }
 * // Use authResult.organizationId for downstream operations
 * ```
 */

import { createHash } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import {
  isAnonymousUserShape,
  logAnonymousExecutionBlock,
} from "@/lib/auth-anonymous-guard";
import { db } from "@/lib/db";
import { member, organizationApiKeys, users } from "@/lib/db/schema";
import { ErrorCategory, logSecurityEvent, logSystemError } from "@/lib/logging";

export type ApiKeyAuthResult = {
  authenticated: boolean;
  organizationId?: string;
  apiKeyId?: string;
  userId?: string;
  scope?: string;
  error?: string;
  statusCode?: number;
};

/**
 * Authenticate a request using an API key from the Authorization header
 *
 * Expected format: `Authorization: Bearer kh_xxxxx`
 *
 * @param request - The incoming HTTP request
 * @returns Authentication result with organization context
 */
export async function authenticateApiKey(
  request: Request
): Promise<ApiKeyAuthResult> {
  try {
    // Extract Authorization header
    const authHeader = request.headers.get("Authorization");

    if (!authHeader) {
      return {
        authenticated: false,
        error: "Missing Authorization header",
        statusCode: 401,
      };
    }

    // Parse Bearer token
    if (!authHeader.startsWith("Bearer ")) {
      return {
        authenticated: false,
        error: "Invalid Authorization header format. Expected: Bearer kh_xxxxx",
        statusCode: 401,
      };
    }

    const key = authHeader.substring(7); // Remove "Bearer " prefix

    // Validate key format (must start with kh_)
    if (!key.startsWith("kh_")) {
      return {
        authenticated: false,
        error: "Invalid API key format. Expected key starting with kh_",
        statusCode: 401,
      };
    }

    // Hash the key to compare with stored hash
    const keyHash = createHash("sha256").update(key).digest("hex");

    const now = new Date();

    // Find the API key plus the creator's deactivation flag in a single
    // query. The leftJoin keeps legacy rows with createdBy IS NULL working
    // (their creator row is null and the deactivation guard below
    // short-circuits).
    const rows = await db
      .select({
        id: organizationApiKeys.id,
        organizationId: organizationApiKeys.organizationId,
        createdBy: organizationApiKeys.createdBy,
        scope: organizationApiKeys.scope,
        creatorDeactivatedAt: users.deactivatedAt,
        creatorIsAnonymous: users.isAnonymous,
        creatorName: users.name,
        creatorEmail: users.email,
        creatorMemberId: member.id,
      })
      .from(organizationApiKeys)
      .leftJoin(users, eq(users.id, organizationApiKeys.createdBy))
      .leftJoin(
        member,
        and(
          eq(member.userId, organizationApiKeys.createdBy),
          eq(member.organizationId, organizationApiKeys.organizationId)
        )
      )
      .where(
        and(
          eq(organizationApiKeys.keyHash, keyHash),
          isNull(organizationApiKeys.revokedAt), // Only active keys
          or(
            isNull(organizationApiKeys.expiresAt),
            gt(organizationApiKeys.expiresAt, now)
          )
        )
      )
      .limit(1);

    const apiKey = rows[0];

    if (!apiKey) {
      return {
        authenticated: false,
        error: "Invalid or revoked API key",
        statusCode: 401,
      };
    }

    // Reject keys created by an anonymous account so a key minted by one
    // cannot become a durable bypass of the anonymous-execution gate.
    if (
      apiKey.createdBy &&
      isAnonymousUserShape({
        isAnonymous: apiKey.creatorIsAnonymous,
        name: apiKey.creatorName,
        email: apiKey.creatorEmail,
      })
    ) {
      logAnonymousExecutionBlock("api_key", apiKey.createdBy, {
        apiKeyId: apiKey.id,
        organizationId: apiKey.organizationId,
      });
      return {
        authenticated: false,
        error: "Anonymous accounts cannot use API keys",
        statusCode: 403,
      };
    }

    // Reject keys whose creator's account is soft-deleted. The deactivation
    // flow (POST /api/user/delete) only stamps users.deactivatedAt and
    // deletes sessions; member rows and organizationApiKeys.revokedAt are
    // not cascaded, so without this check a leaked key from a deactivated
    // ex-owner stays usable until manually revoked. Keys with no recorded
    // creator (legacy rows where createdBy IS NULL) are passed through --
    // there is no user to be deactivated.
    if (apiKey.createdBy && apiKey.creatorDeactivatedAt) {
      // KEEP-612: signal the third deactivated-login surface (session and
      // account are handled in lib/auth.ts). Best-effort, never blocks.
      logSecurityEvent(
        "deactivated_login_attempt",
        {
          surface: "api_key",
          userId: apiKey.createdBy,
          apiKeyId: apiKey.id,
          organizationId: apiKey.organizationId,
        },
        {
          tags: {
            security: "deactivated_login_attempt",
            surface: "api_key",
          },
          user: { id: apiKey.createdBy },
          extra: { apiKeyId: apiKey.id, organizationId: apiKey.organizationId },
        }
      );
      return {
        authenticated: false,
        error: "API key creator account is deactivated",
        statusCode: 401,
      };
    }

    if (apiKey.createdBy && !apiKey.creatorMemberId) {
      return {
        authenticated: false,
        error: "API key creator is no longer a member of this organization",
        statusCode: 401,
      };
    }

    // Update last_used_at timestamp (fire and forget, don't block the request)
    // We intentionally don't await this to avoid blocking the request
    db.update(organizationApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(organizationApiKeys.id, apiKey.id))
      .catch((error) => {
        // Log error but don't fail the request
        logSystemError(
          ErrorCategory.DATABASE,
          "[API Key Auth] Failed to update lastUsedAt",
          error
        );
      });

    return {
      authenticated: true,
      organizationId: apiKey.organizationId,
      apiKeyId: apiKey.id,
      userId: apiKey.createdBy ?? undefined,
      scope: apiKey.scope ?? undefined,
    };
  } catch (error) {
    logSystemError(
      ErrorCategory.AUTH,
      "[API Key Auth] Authentication error",
      error
    );
    return {
      authenticated: false,
      error: "Internal authentication error",
      statusCode: 500,
    };
  }
}

/**
 * Helper to check if a request is authenticated via API key
 * Returns organization ID if authenticated, null otherwise
 */
export async function getApiKeyOrganization(
  request: Request
): Promise<string | null> {
  const result = await authenticateApiKey(request);
  return result.authenticated ? result.organizationId || null : null;
}
