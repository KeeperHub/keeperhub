import { eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import {
  isAnonymousUserShape,
  logAnonymousExecutionBlock,
} from "@/lib/auth-anonymous-guard";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { logSecurityEvent } from "@/lib/logging";
import { touchConnection } from "@/lib/mcp/connections";
import {
  DEFAULT_EPOCH,
  effectiveScope,
  getScopePolicy,
  getScopePolicyForMint,
} from "@/lib/mcp/scope-policy";
import { isUserMemberOfOrganization } from "@/lib/workflow/access";

export type OAuthTokenPayload = {
  sub: string;
  org: string;
  scope: string;
  exp: number;
  iat: number;
  /**
   * The scope epoch this token was minted against. Absent on tokens issued
   * before epochs existed, which read as DEFAULT_EPOCH.
   */
  epoch?: number;
  /**
   * The client this token belongs to. Absent on tokens issued before it was
   * added, which is why liveness is skipped rather than guessed for those.
   */
  cid?: string;
};

export type OAuthAuthResult = {
  authenticated: boolean;
  userId?: string;
  organizationId?: string;
  scope?: string;
  error?: string;
  statusCode?: number;
};

let cachedJwtSecret: { raw: string; encoded: Uint8Array } | null = null;

function getJwtSecret(): Uint8Array {
  const secret = process.env.OAUTH_JWT_SECRET;
  if (!secret) {
    throw new Error("OAUTH_JWT_SECRET environment variable is not set");
  }
  if (cachedJwtSecret?.raw === secret) {
    return cachedJwtSecret.encoded;
  }
  const encoded = new TextEncoder().encode(secret);
  cachedJwtSecret = { raw: secret, encoded };
  return encoded;
}

export async function createAccessToken(payload: {
  sub: string;
  org: string;
  scope: string;
  /** The client this token was issued to, so a call can be attributed to the
   * connection that made it rather than to everything the person has. */
  cid?: string;
}): Promise<string> {
  const secret = getJwtSecret();
  const now = Math.floor(Date.now() / 1000);
  // Stamped at mint time so the verifier can tell this token apart from one
  // issued before the last revoke or scope change.
  const { epoch } = await getScopePolicyForMint(payload.sub, payload.org);
  return await new SignJWT({
    sub: payload.sub,
    org: payload.org,
    scope: payload.scope,
    epoch,
    cid: payload.cid,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600) // 1 hour
    .sign(secret);
}

function isOAuthTokenPayload(value: unknown): value is OAuthTokenPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const p = value as Record<string, unknown>;
  return (
    typeof p.sub === "string" &&
    typeof p.org === "string" &&
    // Load-bearing for REST scope enforcement (A-03): rejecting a token whose
    // `scope` claim is absent or non-string guarantees an authenticated OAuth
    // caller ALWAYS carries a string scope. The requireScope() guards at every
    // /api mutation sink treat scope=undefined as full access (api-key/session
    // callers); if a scope-less OAuth token were accepted here, ctx.scope would
    // be undefined at those sinks and silently regain write access. Do not relax
    // without also re-deriving the REST scope model (see oauth-auth-scope-required.test.ts).
    typeof p.scope === "string" &&
    typeof p.iat === "number" &&
    typeof p.exp === "number"
  );
}

export async function verifyAccessToken(
  token: string
): Promise<OAuthTokenPayload | null> {
  try {
    const secret = getJwtSecret();
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });
    if (!isOAuthTokenPayload(payload)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export async function authenticateOAuthToken(
  request: Request
): Promise<OAuthAuthResult> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return {
      authenticated: false,
      error: "Missing Authorization header",
      statusCode: 401,
    };
  }

  if (!authHeader.startsWith("Bearer ")) {
    return {
      authenticated: false,
      error: "Invalid Authorization header format",
      statusCode: 401,
    };
  }

  const token = authHeader.substring(7);

  // kh_ tokens are handled by the API key auth, not here
  if (token.startsWith("kh_")) {
    return {
      authenticated: false,
      error: "Use API key authentication for kh_ tokens",
      statusCode: 401,
    };
  }

  const payload = await verifyAccessToken(token);
  if (!payload) {
    return {
      authenticated: false,
      error: "Invalid or expired OAuth token",
      statusCode: 401,
    };
  }

  if (!payload.org) {
    return {
      authenticated: false,
      error: "OAuth token missing organization claim",
      statusCode: 401,
    };
  }

  // Both downstream checks key off the subject, so reject a subject-less token
  // up front; this lets the deactivation and membership lookups treat
  // payload.sub as a present value rather than re-guarding it.
  if (!payload.sub) {
    return {
      authenticated: false,
      error: "OAuth token missing subject claim",
      statusCode: 401,
    };
  }

  // Reject tokens minted before the last revoke or scope change. The same
  // one-hour window that the deactivation check below closes applies to what a
  // connection is allowed to do: without this, narrowing a scope or cutting a
  // connection off would not take hold until the token expired on its own.
  const policy = await getScopePolicy(payload.sub, payload.org);
  if ((payload.epoch ?? DEFAULT_EPOCH) !== policy.epoch) {
    return {
      authenticated: false,
      // Standard 401 handling applies: the refresh token still works unless
      // the connection was revoked, so a client that renews on 401 comes back
      // at the new level without anyone touching it.
      error:
        "Access for this connection changed. Refresh the token to continue.",
      statusCode: 401,
    };
  }

  // Liveness for the connections list, recorded only for a token that was
  // actually accepted. Awaited rather than left floating so it cannot be cut
  // short when the handler returns; the throttle inside means all but one call
  // a minute returns without touching the database, and it swallows its own
  // failures so it can never turn a working call into a failed one.
  await touchConnection(payload.sub, payload.org, payload.cid);

  // Reject tokens issued to a now-deactivated user. JWTs are valid for 1
  // hour after creation; without this check, a user deactivated within that
  // window could keep authenticating against MCP endpoints until the token
  // organically expired. This mirrors the deactivation guard in
  // authenticateApiKey -- both auth paths must close the same gap.
  const user = await db.query.users.findFirst({
    where: eq(users.id, payload.sub),
    columns: {
      deactivatedAt: true,
      isAnonymous: true,
      name: true,
      email: true,
    },
  });

  // Anonymous accounts must never hold a usable mcp token: the consent screen
  // refuses to mint one for them, so reject any token that reaches this far.
  if (user && isAnonymousUserShape(user)) {
    logAnonymousExecutionBlock("mcp_oauth", payload.sub, {
      organizationId: payload.org,
    });
    return {
      authenticated: false,
      error: "Anonymous accounts cannot use API access tokens",
      statusCode: 403,
    };
  }

  if (user?.deactivatedAt) {
    // KEEP-612: fourth deactivated-login surface (alongside better-auth
    // session/account hooks and api-key auth). A deactivated user with a
    // still-valid MCP OAuth JWT hitting MCP endpoints is exactly the
    // anomaly the detection layer wants surfaced. Best-effort; never
    // blocks the 401.
    logSecurityEvent(
      "deactivated_login_attempt",
      {
        surface: "mcp_oauth",
        userId: payload.sub,
        organizationId: payload.org,
      },
      {
        tags: {
          security: "deactivated_login_attempt",
          surface: "mcp_oauth",
        },
        user: { id: payload.sub },
        extra: { organizationId: payload.org },
      }
    );
    return {
      authenticated: false,
      error: "User account is deactivated",
      statusCode: 401,
    };
  }

  // A long-lived access token only proves who the user was when it was
  // minted, not that they still belong to the org it is scoped to. Re-check
  // current membership on every use so a token keeps no authority after the
  // user is removed from (or leaves) the organization.
  //
  // Note: isUserMemberOfOrganization joins on users.deactivatedAt IS NULL, so
  // this check also rejects a deactivated user. The explicit deactivation
  // guard above is therefore retained for its security telemetry (the Sentry
  // captureMessage / console.warn), not for access control - it surfaces the
  // anomaly that this membership check would otherwise reject silently.
  const isMember = await isUserMemberOfOrganization(payload.sub, payload.org);
  if (!isMember) {
    return {
      authenticated: false,
      error: "User is no longer a member of this organization",
      statusCode: 401,
    };
  }

  // What the token says it may do is what the person consented to for
  // themselves. What it may actually do is that, bounded by the ceilings the
  // organization's owners and admins set. Applying them here rather than
  // trusting the minted scope is what stops a person handing themselves a wider
  // token by reconnecting, and it takes effect without waiting for the old
  // token to expire.
  return {
    authenticated: true,
    userId: payload.sub,
    organizationId: payload.org,
    scope: effectiveScope(payload.scope, policy),
  };
}
