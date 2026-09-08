import { and, eq, isNull, or } from "drizzle-orm";
import type { NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-key-auth";
import { auth } from "@/lib/auth";
import { isAnonymousUserShape } from "@/lib/auth-anonymous-guard";
import { db } from "@/lib/db";
import { member, organization } from "@/lib/db/schema";
import {
  type ApiErrorCode,
  ApiErrorCodes,
  apiError,
} from "@/lib/errors/api-envelope";
import { authenticateOAuthToken } from "@/lib/mcp/oauth-auth";
import { getOrgContext } from "@/lib/middleware/org-context";
import {
  hasSessionCookie,
  isTrustedOrigin,
  normaliseOrigin,
} from "@/lib/trusted-origins";

/**
 * An auth rejection, carrying both halves the documented error envelope needs.
 *
 * `code` is the stable value an integrator branches on; `error` stays the human
 * sentence and becomes `detail` once a route emits the envelope via `apiError`.
 * Routes not yet migrated keep returning `error` as-is, so adopting the code is
 * incremental rather than a flag day.
 */
export type AuthFailure = {
  error: string;
  // `mfa_required` sits outside the documented set on purpose: the dialog
  // branches on it to route into step-up rather than showing a dead error, and
  // the docs already allow a route to raise a more specific code.
  code: ApiErrorCode | "mfa_required";
  status: number;
};

const STATE_CHANGING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * Defence-in-depth CSRF check for session-authed routes. The root proxy
 * (`proxy.ts`) is the primary enforcement; this runs again on the small
 * set of routes that resolve auth via `getDualAuthContext`, so a misconfigured
 * matcher can't silently bypass the protection. See KEEP-240.
 *
 * Skipped for OAuth Bearer and API-key callers because those auth methods are
 * intentionally cross-origin and not vulnerable to cookie CSRF.
 */
function checkSessionOrigin(request: Request): AuthFailure | null {
  const method = request.method.toUpperCase();
  if (!STATE_CHANGING_METHODS.has(method)) {
    return null;
  }
  // Only enforce when the request actually carries the better-auth session
  // cookie. Bearer/API-key callers that traverse Cloudflare Access carry
  // CF tokens but no session token, and shouldn't be gated.
  if (!hasSessionCookie(request.headers)) {
    return null;
  }

  const raw = request.headers.get("origin") ?? request.headers.get("referer");
  const origin = normaliseOrigin(raw);
  const path = (() => {
    try {
      return new URL(request.url).pathname;
    } catch {
      return "<unparseable>";
    }
  })();

  if (!origin) {
    console.info("[csrf] blocked: missing origin (session)", { method, path });
    return {
      error: "Invalid origin",
      code: ApiErrorCodes.UNAUTHORIZED,
      status: 403,
    };
  }
  if (!isTrustedOrigin(origin)) {
    console.info("[csrf] blocked: untrusted origin (session)", {
      method,
      path,
      origin,
    });
    return {
      error: "Invalid origin",
      code: ApiErrorCodes.UNAUTHORIZED,
      status: 403,
    };
  }
  return null;
}

export type AuthMethod = "oauth" | "api-key" | "session";

const ORG_HEADER = "x-organization-id";

/**
 * KEEP-563: resolve the session-auth caller's effective organization, taking
 * an optional `X-Organization-Id` request header into account.
 *
 * The header accepts either an organization id (`UvQQ...`) or a slug
 * (`keeperhub-observability`). When set, we require the caller to be a
 * member of the target org; otherwise we return an error so the route can
 * reject the request rather than silently fall back to the session default.
 *
 * Hard org-scoping for API keys and OAuth tokens is unchanged: those callers
 * never read this header. Only session auth honors it, because only session
 * auth carries a multi-org identity.
 */
async function resolveSessionOrg(
  request: Request,
  userId: string,
  defaultOrgId: string | null
): Promise<{ organizationId: string | null } | AuthFailure> {
  const raw = request.headers.get(ORG_HEADER)?.trim();
  if (!raw) {
    if (!defaultOrgId) {
      // No active org on the session yet (e.g. a brand-new signup whose
      // session.create active-org backfill has not landed). Fall back to the
      // caller's first non-deactivated membership so their own writes are not
      // rejected with a spurious "no active organization". This only ever
      // resolves an org the user already belongs to.
      const [membership] = await db
        .select({ organizationId: member.organizationId })
        .from(member)
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(
          and(eq(member.userId, userId), isNull(organization.deactivatedAt))
        )
        .limit(1);
      return { organizationId: membership?.organizationId ?? null };
    }
    // A deactivated org (its owner was deactivated and the cascade fired) is
    // inaccessible to its members even though their session still points at
    // it. Surface it as not-found, matching the header path's enumeration-safe
    // response, so members lose access without leaking the deactivated state.
    const [defaultOrg] = await db
      .select({ deactivatedAt: organization.deactivatedAt })
      .from(organization)
      .where(eq(organization.id, defaultOrgId))
      .limit(1);
    if (!defaultOrg || defaultOrg.deactivatedAt) {
      return {
        error: "Organization not found",
        code: ApiErrorCodes.NOT_FOUND,
        status: 404,
      };
    }
    return { organizationId: defaultOrgId };
  }

  // Single query joining organization to the caller's membership row. We can't
  // branch on "org exists but you're not a member" vs "org does not exist"
  // because the difference between those two responses would let any
  // authenticated user enumerate org ids and slugs. A deactivated org is
  // excluded here too, so it reads as not-found rather than accessible.
  const match = await db
    .select({ id: organization.id })
    .from(organization)
    .innerJoin(
      member,
      and(eq(member.organizationId, organization.id), eq(member.userId, userId))
    )
    .where(
      and(
        or(eq(organization.id, raw), eq(organization.slug, raw)),
        isNull(organization.deactivatedAt)
      )
    )
    .limit(1);

  const targetOrgId = match[0]?.id;
  if (!targetOrgId) {
    return {
      error: "Organization not found",
      code: ApiErrorCodes.NOT_FOUND,
      status: 404,
    };
  }

  return { organizationId: targetOrgId };
}

export type DualAuthContext =
  | {
      userId: string | null;
      organizationId: string | null;
      authMethod: AuthMethod;
      apiKeyId: string | null;
      scope?: string;
      isAnonymous: boolean;
    }
  | AuthFailure;

export type ResolvedAuthContext = Exclude<DualAuthContext, { error: string }>;

/**
 * True when a credential resolved to a principal (user and/or organization)
 * that authorization can be evaluated against. `required: false` callers get a
 * null-principal context both when no credential was sent and when one was
 * sent but failed, so this is the check that separates "somebody" from
 * "nobody" - it is not evidence that the credential was valid.
 *
 * Note it does not exclude `isAnonymous`: a better-auth anonymous account is a
 * real principal with its own organization, and every authorization helper
 * (getWorkflowAccess) treats it as one.
 */
export function hasResolvedPrincipal(
  authContext: DualAuthContext
): authContext is ResolvedAuthContext {
  if ("error" in authContext) {
    return false;
  }
  return Boolean(authContext.userId || authContext.organizationId);
}

/**
 * Sentinel error returned by getDualAuthContext when the user holds a
 * session that login-risk detection flagged and they have TOTP enrolled.
 * The session itself is valid (and the cookie still authenticates them
 * for step-up routes), but every other route refuses the request until
 * the step-up flow at /verify-mfa flips sessions.requires_mfa back off.
 * Client code branches on `code === "mfa_required"` to redirect to the
 * verify page rather than treating it as a generic 403.
 */
export const MFA_REQUIRED_ERROR = {
  error: "MFA verification required",
  status: 403,
  code: "mfa_required",
} as const satisfies AuthFailure;

/**
 * Stable label set to attach to log entries on dual-auth routes so we can
 * answer "which credential made this call" in incident review. Routes pass
 * the spread of this into their existing logSystemError / logUserError
 * label objects.
 *
 * Two design choices worth calling out:
 *
 * - `authMethod` widens to "unknown" for the pre-auth / auth-failure case,
 *   so log entries can never falsely claim a request authenticated as a
 *   session when auth never resolved.
 * - `apiKeyId` is omitted entirely when no key authenticated the request,
 *   rather than emitting a sentinel like "none" which would be
 *   indistinguishable in structured-log indexes from a real key id
 *   literally named "none".
 *
 * Shaped as Record<string, string> so it spreads directly into label
 * argument types without further coercion.
 */
export type AuthAuditLabels = Record<string, string>;

/**
 * Default audit labels for a code path that has not yet resolved an auth
 * context (or whose context resolution failed). Routes hoist this above
 * their try block so a catch fired before auth populates the audit gets a
 * non-misleading value.
 */
export const UNAUTHENTICATED_AUDIT: AuthAuditLabels = {
  authMethod: "unknown",
};

export function auditFromAuth(
  ctx:
    | DualAuthContext
    | { authMethod: AuthMethod; apiKeyId: string | null }
    | null
    | undefined
): AuthAuditLabels {
  if (!ctx || "error" in ctx) {
    return UNAUTHENTICATED_AUDIT;
  }
  if (ctx.apiKeyId) {
    return { authMethod: ctx.authMethod, apiKeyId: ctx.apiKeyId };
  }
  return { authMethod: ctx.authMethod };
}

/**
 * Check for MCP OAuth JWT token authentication.
 * These tokens are issued by the MCP OAuth flow and forwarded
 * by the MCP server when calling downstream API endpoints.
 */
async function resolveOAuthToken(request: Request): Promise<{
  userId: string | null;
  organizationId: string | null;
  scope?: string;
} | null> {
  const result = await authenticateOAuthToken(request);
  if (!result.authenticated) {
    return null;
  }
  return {
    userId: result.userId ?? null,
    organizationId: result.organizationId ?? null,
    scope: result.scope,
  };
}

/**
 * Resolves user and organization context from OAuth token, API key, or session auth.
 * For API key auth, userId is the key creator (if available).
 * API keys are hard-scoped to their creation org (no cross-org override).
 *
 * @param required - If true (default), returns 401 when no auth method succeeds.
 *   Set to false for routes that allow unauthenticated access (e.g. public workflows).
 */
export async function getDualAuthContext(
  request: Request,
  options?: { required?: boolean }
): Promise<DualAuthContext> {
  const required = options?.required ?? true;

  const oauthAuth = await resolveOAuthToken(request);
  if (oauthAuth) {
    // Anonymous subjects are rejected inside authenticateOAuthToken, so a
    // resolved token always belongs to a real account.
    return {
      ...oauthAuth,
      authMethod: "oauth",
      apiKeyId: null,
      isAnonymous: false,
    };
  }

  const apiKeyAuth = await authenticateApiKey(request);
  if (apiKeyAuth.authenticated) {
    return resolveApiKeyContext(apiKeyAuth);
  }

  const originError = checkSessionOrigin(request);
  if (originError) {
    return originError;
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user && required) {
    return {
      error: "Unauthorized",
      code: ApiErrorCodes.UNAUTHORIZED,
      status: 401,
    };
  }
  if (!session?.user) {
    return {
      userId: null,
      organizationId: null,
      authMethod: "session",
      apiKeyId: null,
      isAnonymous: false,
    };
  }

  // Quarantined session: login risk detection flagged the sign-in and the
  // user has TOTP enrolled. Refuse the request until /verify-mfa clears
  // the flag. The session is still usable on the step-up endpoints
  // themselves; those resolve auth directly via auth.api.getSession
  // rather than getDualAuthContext.
  const sessionRow = (session as { session?: { requiresMfa?: boolean } })
    .session;
  if (sessionRow?.requiresMfa === true) {
    return MFA_REQUIRED_ERROR;
  }

  const orgContext = await getOrgContext();
  const orgResult = await resolveSessionOrg(
    request,
    session.user.id,
    orgContext.organization?.id ?? null
  );
  if ("error" in orgResult) {
    return orgResult;
  }
  return {
    userId: session.user.id,
    organizationId: orgResult.organizationId,
    authMethod: "session",
    apiKeyId: null,
    isAnonymous: isAnonymousUserShape(session.user),
  };
}

function resolveApiKeyContext(apiKeyAuth: {
  organizationId?: string;
  userId?: string;
  apiKeyId?: string;
  scope?: string;
}): DualAuthContext {
  return {
    userId: apiKeyAuth.userId ?? null,
    organizationId: apiKeyAuth.organizationId ?? null,
    authMethod: "api-key",
    apiKeyId: apiKeyAuth.apiKeyId ?? null,
    scope: apiKeyAuth.scope,
    // Anonymous creators are rejected inside authenticateApiKey.
    isAnonymous: false,
  };
}

export type OrganizationAuthContext =
  | {
      organizationId: string;
      authMethod: AuthMethod;
      apiKeyId: string | null;
      // OAuth token scope (mcp:read|write|admin). Also set for scoped API keys.
      // Undefined for session callers and unscoped keys, which scopeSatisfies()
      // treats as full access.
      scope?: string;
    }
  | AuthFailure;

/**
 * Resolves the organization ID and audit context from OAuth, API key, or
 * session. Used by routes that only need org-level authorization but still
 * want authMethod / apiKeyId for logging.
 */
export async function resolveOrganizationId(
  request: Request
): Promise<OrganizationAuthContext> {
  const oauthAuth = await resolveOAuthToken(request);
  if (oauthAuth?.organizationId) {
    return {
      organizationId: oauthAuth.organizationId,
      authMethod: "oauth",
      apiKeyId: null,
      scope: oauthAuth.scope,
    };
  }

  const apiKeyAuth = await authenticateApiKey(request);

  if (apiKeyAuth.authenticated) {
    const organizationId = apiKeyAuth.organizationId;
    if (!organizationId) {
      return {
        error: "No active organization",
        code: ApiErrorCodes.INVALID_INPUT,
        status: 400,
      };
    }
    return {
      organizationId,
      authMethod: "api-key",
      apiKeyId: apiKeyAuth.apiKeyId ?? null,
      scope: apiKeyAuth.scope,
    };
  }

  const originError = checkSessionOrigin(request);
  if (originError) {
    return originError;
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return {
      error: "Unauthorized",
      code: ApiErrorCodes.UNAUTHORIZED,
      status: 401,
    };
  }

  const orgContext = await getOrgContext();
  const orgResult = await resolveSessionOrg(
    request,
    session.user.id,
    orgContext.organization?.id ?? null
  );
  if ("error" in orgResult) {
    return orgResult;
  }
  if (!orgResult.organizationId) {
    return {
      error: "No active organization",
      code: ApiErrorCodes.INVALID_INPUT,
      status: 400,
    };
  }
  return {
    organizationId: orgResult.organizationId,
    authMethod: "session",
    apiKeyId: null,
  };
}

/**
 * Resolves both organization ID and user ID from either OAuth, API key, or session.
 * Used by POST routes that need to track the creator.
 */
export async function resolveCreatorContext(request: Request): Promise<
  | {
      organizationId: string;
      userId: string;
      authMethod: AuthMethod;
      apiKeyId: string | null;
      // OAuth token scope (mcp:read|write|admin). Also set for scoped API keys.
      // Undefined for session callers and unscoped keys, which scopeSatisfies()
      // treats as full access for backwards compatibility.
      scope?: string;
    }
  | AuthFailure
> {
  const oauthAuth = await resolveOAuthToken(request);
  if (oauthAuth) {
    return validateCreatorFields(
      oauthAuth.organizationId,
      oauthAuth.userId,
      "oauth",
      null,
      oauthAuth.scope
    );
  }

  const apiKeyAuth = await authenticateApiKey(request);
  if (apiKeyAuth.authenticated) {
    return validateCreatorFields(
      apiKeyAuth.organizationId ?? null,
      apiKeyAuth.userId ?? null,
      "api-key",
      apiKeyAuth.apiKeyId ?? null,
      apiKeyAuth.scope
    );
  }

  const originError = checkSessionOrigin(request);
  if (originError) {
    return originError;
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return {
      error: "Unauthorized",
      code: ApiErrorCodes.UNAUTHORIZED,
      status: 401,
    };
  }

  const context = await getOrgContext();
  const orgResult = await resolveSessionOrg(
    request,
    session.user.id,
    context.organization?.id ?? null
  );
  if ("error" in orgResult) {
    return orgResult;
  }
  if (!orgResult.organizationId) {
    return {
      error: "No active organization",
      code: ApiErrorCodes.INVALID_INPUT,
      status: 400,
    };
  }
  return {
    organizationId: orgResult.organizationId,
    userId: session.user.id,
    authMethod: "session",
    apiKeyId: null,
  };
}

function validateCreatorFields(
  organizationId: string | null | undefined,
  userId: string | null | undefined,
  authMethod: AuthMethod,
  apiKeyId: string | null,
  scope?: string
):
  | {
      organizationId: string;
      userId: string;
      authMethod: AuthMethod;
      apiKeyId: string | null;
      scope?: string;
    }
  | AuthFailure {
  if (!organizationId) {
    return {
      error: "No active organization",
      code: ApiErrorCodes.INVALID_INPUT,
      status: 400,
    };
  }
  if (!userId) {
    return {
      error: "Auth context missing user. Please recreate the API key.",
      code: ApiErrorCodes.UNAUTHORIZED,
      status: 400,
    };
  }
  return { organizationId, userId, authMethod, apiKeyId, scope };
}

/**
 * Render an auth rejection as the documented error envelope.
 *
 * Routes that resolve auth through this module reject in the same shape, so
 * this is the one-liner that turns that rejection into `{error, detail,
 * request_id}` plus the `x-request-id` response header. Migrating a route is
 * swapping its `NextResponse.json({ error: ctx.error }, ...)` for this.
 */
export function authFailureResponse(
  failure: AuthFailure,
  requestHeaders: Headers
): NextResponse {
  return apiError({
    status: failure.status,
    code: failure.code,
    detail: failure.error,
    requestHeaders,
  });
}
