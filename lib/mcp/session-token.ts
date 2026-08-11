import { errors, jwtVerify, SignJWT } from "jose";

export type SessionPayload = {
  org: string;
  key: string;
  scope?: string;
  iat: number;
  exp: number;
  original_iat?: number;
};

export const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours
export const MAX_RENEWAL_GRACE_SECONDS = 48 * 60 * 60; // 48 hours
export const MAX_SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60; // 30 days

let cachedSessionSecret: { raw: string; encoded: Uint8Array } | null = null;

function getSessionSecret(): Uint8Array {
  const secret = process.env.MCP_SESSION_SECRET;
  if (!secret) {
    throw new Error("MCP_SESSION_SECRET environment variable is not set");
  }
  if (cachedSessionSecret?.raw === secret) {
    return cachedSessionSecret.encoded;
  }
  const encoded = new TextEncoder().encode(secret);
  cachedSessionSecret = { raw: secret, encoded };
  return encoded;
}

export async function createSessionToken(
  payload: Omit<SessionPayload, "iat" | "exp">
): Promise<string> {
  const secret = getSessionSecret();
  const now = Math.floor(Date.now() / 1000);
  const originalIat = payload.original_iat ?? now;
  return await new SignJWT({
    org: payload.org,
    key: payload.key,
    scope: payload.scope,
    original_iat: originalIat,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_TTL_SECONDS)
    .sign(secret);
}

export type VerifyOptions = {
  allowExpired?: boolean;
};

export type VerifyResult =
  | { payload: SessionPayload; expired: false }
  | { payload: SessionPayload; expired: true }
  | {
      payload: null;
      expired: false;
      reason:
        | "invalid_signature"
        | "malformed"
        | "too_old"
        | "max_lifetime_exceeded";
    };

export async function verifySessionToken(
  token: string,
  options?: VerifyOptions
): Promise<SessionPayload | null> {
  const result = await verifySessionTokenDetailed(token);
  if (!result.payload) {
    return null;
  }
  if (result.expired && !options?.allowExpired) {
    return null;
  }
  return result.payload;
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const p = value as Record<string, unknown>;
  return (
    typeof p.org === "string" &&
    typeof p.key === "string" &&
    typeof p.iat === "number" &&
    typeof p.exp === "number" &&
    (p.scope === undefined || typeof p.scope === "string") &&
    (p.original_iat === undefined || typeof p.original_iat === "number")
  );
}

export async function verifySessionTokenDetailed(
  token: string
): Promise<VerifyResult> {
  try {
    const secret = getSessionSecret();
    // clockTolerance here is intentionally the 48h renewal grace, not the
    // usual few seconds of clock skew. Tokens past `exp` but within the
    // grace window must still verify so the slow path in app/mcp/route.ts
    // can reconstruct the session and mint a renewed token.
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      clockTolerance: MAX_RENEWAL_GRACE_SECONDS,
    });

    if (!isSessionPayload(payload)) {
      return { payload: null, expired: false, reason: "malformed" };
    }
    const claims = payload;
    const now = Math.floor(Date.now() / 1000);
    const sessionOrigin = claims.original_iat ?? claims.iat;
    if (now - sessionOrigin > MAX_SESSION_LIFETIME_SECONDS) {
      return { payload: null, expired: false, reason: "max_lifetime_exceeded" };
    }

    if (claims.exp < now) {
      return { payload: claims, expired: true };
    }
    return { payload: claims, expired: false };
  } catch (err) {
    // Note on reason priority: a token that is both past the 48h grace AND
    // past the 30d absolute lifetime will surface here as too_old (jose's
    // JWTExpired fires before our manual max_lifetime_exceeded check can
    // run). app/mcp/route.ts treats both reasons identically via
    // isExpiredBeyondRenewal, so there's no HTTP-level drift.
    if (err instanceof errors.JWTExpired) {
      return { payload: null, expired: false, reason: "too_old" };
    }
    if (err instanceof errors.JWSSignatureVerificationFailed) {
      return { payload: null, expired: false, reason: "invalid_signature" };
    }
    return { payload: null, expired: false, reason: "malformed" };
  }
}
