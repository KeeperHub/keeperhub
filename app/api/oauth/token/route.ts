import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { type ZodError, z } from "zod";
import { isUserDeactivated } from "@/lib/auth-deactivation-guard";
import {
  resolveRequestId,
  sanitizeDetailForEnv,
} from "@/lib/errors/api-envelope";
import { HttpStatus } from "@/lib/http-status";
import { createAccessToken } from "@/lib/mcp/oauth-auth";
import {
  deleteAuthCode,
  deleteRefreshToken,
  getAuthCode,
  getOAuthClient,
  getRefreshToken,
  type OAuthClient,
  REFRESH_TOKEN_TTL_MS,
  storeRefreshToken,
} from "@/lib/mcp/oauth-store";
import { checkIpRateLimit, getClientIp } from "@/lib/mcp/rate-limit";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import {
  oauthAuthorizationCodeSchema,
  oauthRefreshTokenSchema,
} from "@/lib/schemas/oauth";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import { isUserMemberOfOrganization } from "@/lib/workflow/access";

export const dynamic = "force-dynamic";

/**
 * Token-endpoint errors use the KEEP-489 envelope plus RFC 6749 §5.2's
 * `error_description` alias for `detail`. Client/grant failures use the
 * registered OAuth set (invalid_request, invalid_client, invalid_grant,
 * unsupported_grant_type). `rate_limited` is the only extension, used on
 * 429 only. All of these go through `routeError` (not ApiErrorCodes generics).
 */
function routeError(
  request: Request,
  detail: string,
  status: number,
  code: string
): Response {
  const requestId = resolveRequestId(request.headers);
  const sanitized = sanitizeDetailForEnv(detail) ?? detail;
  return NextResponse.json(
    {
      error: code,
      detail: sanitized,
      error_description: sanitized,
      request_id: requestId,
    },
    {
      status,
      headers: { "x-request-id": requestId },
    }
  );
}

function oauthValidationError(request: Request, zodError: ZodError): Response {
  const flattened = z.flattenError(zodError);
  const fieldMessages = Object.entries(flattened.fieldErrors).flatMap(
    ([field, messages]) => {
      if (!Array.isArray(messages)) {
        return [];
      }
      return messages.map((message) => `${field}: ${message}`);
    }
  );
  const formMessages = flattened.formErrors;
  const detail =
    [...fieldMessages, ...formMessages].join("; ") || "Validation failed";

  return routeError(request, detail, HttpStatus.BAD_REQUEST, "invalid_request");
}

function verifyPkceS256(verifier: string, challenge: string): boolean {
  const hash = createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return hash === challenge;
}

// Pull the client_secret from either the request body (client_secret_post) or
// the HTTP Basic Authorization header (client_secret_basic). Public PKCE
// clients send neither.
function extractClientSecret(
  request: Request,
  params: URLSearchParams
): string | null {
  const fromBody = params.get("client_secret");
  if (fromBody) {
    return fromBody;
  }
  const authHeader = request.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Basic ")) {
    return null;
  }
  try {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const secret = decoded.slice(decoded.indexOf(":") + 1);
    return secret || null;
  } catch {
    return null;
  }
}

function secretMatches(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(
    createHash("sha256").update(secret).digest("hex"),
    "utf8"
  );
  const expected = Buffer.from(expectedHash, "utf8");
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

// Only clients that registered a confidential auth method present a
// client_secret on token grants. Public PKCE clients (auth method "none", or
// rows predating the column that default to it) are identified by client_id
// alone and skip this check. Returns an error Response when verification
// fails, or null when the client is authenticated.
const CONFIDENTIAL_AUTH_METHODS = new Set([
  "client_secret_post",
  "client_secret_basic",
]);

function verifyClientAuthentication(
  client: OAuthClient,
  request: Request,
  params: URLSearchParams
): Response | null {
  if (!CONFIDENTIAL_AUTH_METHODS.has(client.tokenEndpointAuthMethod)) {
    return null;
  }
  const secret = extractClientSecret(request, params);
  if (!secret) {
    return routeError(
      request,
      "client_secret is required for this client",
      HttpStatus.UNAUTHORIZED,
      "invalid_client"
    );
  }
  if (!secretMatches(secret, client.clientSecretHash)) {
    return routeError(
      request,
      "Invalid client_secret",
      HttpStatus.UNAUTHORIZED,
      "invalid_client"
    );
  }
  return null;
}

async function handleAuthorizationCode(
  request: Request,
  params: URLSearchParams
): Promise<Response> {
  const parsed = oauthAuthorizationCodeSchema.safeParse(
    Object.fromEntries(params)
  );
  if (!parsed.success) {
    return oauthValidationError(request, parsed.error);
  }
  const {
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  } = parsed.data;

  const client = await getOAuthClient(clientId);
  if (!client) {
    return routeError(
      request,
      "Unknown client_id",
      HttpStatus.BAD_REQUEST,
      "invalid_client"
    );
  }

  const clientAuthError = verifyClientAuthentication(client, request, params);
  if (clientAuthError) {
    return clientAuthError;
  }

  const authCode = await getAuthCode(code);
  if (!authCode) {
    return routeError(
      request,
      "Invalid or expired authorization code",
      HttpStatus.BAD_REQUEST,
      "invalid_grant"
    );
  }

  if (authCode.clientId !== clientId) {
    return routeError(
      request,
      "client_id mismatch",
      HttpStatus.BAD_REQUEST,
      "invalid_grant"
    );
  }

  if (authCode.redirectUri !== redirectUri) {
    return routeError(
      request,
      "redirect_uri mismatch",
      HttpStatus.BAD_REQUEST,
      "invalid_grant"
    );
  }

  if (authCode.codeChallengeMethod !== "S256") {
    return routeError(
      request,
      "Unsupported code_challenge_method",
      HttpStatus.BAD_REQUEST,
      "invalid_grant"
    );
  }

  if (!verifyPkceS256(codeVerifier, authCode.codeChallenge)) {
    return routeError(
      request,
      "Invalid code_verifier",
      HttpStatus.BAD_REQUEST,
      "invalid_grant"
    );
  }

  // Consume the code immediately (single use)
  await deleteAuthCode(code);

  // Refuse to mint tokens if the user was deactivated between consenting
  // to the auth code and exchanging it. Without this, an auth code held
  // by an attacker would still buy a fresh access + refresh token pair.
  if (await isUserDeactivated(authCode.userId)) {
    return routeError(
      request,
      "User account is deactivated",
      HttpStatus.UNAUTHORIZED,
      "invalid_grant"
    );
  }

  const accessToken = await createAccessToken({
    sub: authCode.userId,
    org: authCode.organizationId,
    scope: authCode.scope,
    cid: clientId,
  });

  const refreshToken = randomBytes(32).toString("hex");
  await storeRefreshToken({
    token: refreshToken,
    clientId,
    userId: authCode.userId,
    organizationId: authCode.organizationId,
    scope: authCode.scope,
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
  });

  // A client completing consent is the moment a connection starts existing,
  // and the organization should be able to see that it did.
  await recordAuditEvent({
    action: "mcp_connection.created",
    actor: {
      authMethod: "oauth",
      organizationId: authCode.organizationId,
      userId: authCode.userId,
    },
    after: { clientId, scope: authCode.scope },
    metadata: { ...buildAuditMetadata(request), clientId },
    resourceId: `${clientId}::${authCode.userId}`,
    resourceType: "mcp_connection",
  }).catch(() => {
    // Never fail a token grant because the trail could not be written.
  });

  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refreshToken,
    scope: authCode.scope,
  });
}

async function handleRefreshToken(
  request: Request,
  params: URLSearchParams
): Promise<Response> {
  const parsed = oauthRefreshTokenSchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) {
    return oauthValidationError(request, parsed.error);
  }
  const { refresh_token: refreshTokenValue, client_id: clientId } = parsed.data;

  const client = await getOAuthClient(clientId);
  if (!client) {
    return routeError(
      request,
      "Unknown client_id",
      HttpStatus.BAD_REQUEST,
      "invalid_client"
    );
  }

  const clientAuthError = verifyClientAuthentication(client, request, params);
  if (clientAuthError) {
    return clientAuthError;
  }

  const entry = await getRefreshToken(refreshTokenValue);
  if (!entry) {
    return routeError(
      request,
      "Invalid or expired refresh token",
      HttpStatus.BAD_REQUEST,
      "invalid_grant"
    );
  }

  if (entry.clientId !== clientId) {
    return routeError(
      request,
      "client_id mismatch",
      HttpStatus.BAD_REQUEST,
      "invalid_grant"
    );
  }

  // Rotate the refresh token
  await deleteRefreshToken(refreshTokenValue);

  // Refuse to mint tokens for a deactivated user. authenticateOAuthToken
  // already rejects existing access tokens on use; this closes the same
  // gap on the refresh-exchange path so a stolen refresh token cannot
  // survive deactivation by repeatedly cycling itself.
  if (await isUserDeactivated(entry.userId)) {
    return routeError(
      request,
      "User account is deactivated",
      HttpStatus.UNAUTHORIZED,
      "invalid_grant"
    );
  }

  // Re-check org membership before re-issuing. A refresh token outlives any
  // single access token, so without this a user removed from (or who left)
  // the org could keep cycling the refresh token into fresh org-scoped
  // access tokens indefinitely.
  if (!(await isUserMemberOfOrganization(entry.userId, entry.organizationId))) {
    return routeError(
      request,
      "User is no longer a member of this organization",
      HttpStatus.UNAUTHORIZED,
      "invalid_grant"
    );
  }

  const newRefreshToken = randomBytes(32).toString("hex");
  await storeRefreshToken({
    token: newRefreshToken,
    clientId,
    userId: entry.userId,
    organizationId: entry.organizationId,
    scope: entry.scope,
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    // Rotation replaces the row, so the original consent time rides along
    // rather than resetting to now on every refresh.
    connectedAt: entry.connectedAt,
  });

  const accessToken = await createAccessToken({
    sub: entry.userId,
    org: entry.organizationId,
    scope: entry.scope,
    cid: clientId,
  });

  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: newRefreshToken,
    scope: entry.scope,
  });
}

export async function POST(request: Request): Promise<Response> {
  const ip = getClientIp(request);
  const rateLimit = checkIpRateLimit(ip, 30, 60_000);
  if (!rateLimit.allowed) {
    return applyRateLimitHeaders(
      routeError(
        request,
        "Too many requests",
        HttpStatus.TOO_MANY_REQUESTS,
        "rate_limited"
      ),
      rateLimit
    );
  }

  let params: URLSearchParams;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    params = new URLSearchParams(text);
  } else {
    try {
      const body = (await request.json()) as Record<string, string>;
      params = new URLSearchParams(body);
    } catch {
      return routeError(
        request,
        "Invalid request body",
        HttpStatus.BAD_REQUEST,
        "invalid_request"
      );
    }
  }

  const grantType = params.get("grant_type");

  if (grantType === "authorization_code") {
    return applyRateLimitHeaders(
      await handleAuthorizationCode(request, params),
      rateLimit
    );
  }

  if (grantType === "refresh_token") {
    return applyRateLimitHeaders(
      await handleRefreshToken(request, params),
      rateLimit
    );
  }

  return applyRateLimitHeaders(
    routeError(
      request,
      "Unsupported grant_type. Supported: authorization_code, refresh_token",
      HttpStatus.BAD_REQUEST,
      "unsupported_grant_type"
    ),
    rateLimit
  );
}
