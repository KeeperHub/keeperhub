/**
 * POST /api/agentic-wallet/provision
 *
 * ONBOARD-01 public entry point for agentic-wallet creation.
 *
 * - No auth headers. IP rate-limited (5 / hour / IP) via
 *   lib/agentic-wallet/rate-limit::incrementAndCheck (Postgres-backed so the
 *   limit survives pod restarts and is shared across replicas) to bound
 *   unauthenticated abuse (T-33-01, Phase 37 Wave 5 Task 21).
 * - Client IP is resolved via lib/security/trusted-proxies::resolveTrustedClientIp
 *   which only honors X-Forwarded-For when the TCP peer is a known Cloudflare
 *   IPv4 range — otherwise the header is ignored and the peer IP is used.
 *   This blocks spoofed XFF headers from dodging the per-IP bucket.
 * - Delegates the Turnkey + DB pipeline to provisionAgenticWallet()
 *   (Plan 33-01a).
 * - 200 response body: { subOrgId, walletAddress, hmacSecret }. The 10s
 *   wall-clock SLI is enforced by the integration test.
 * - Error mapping: Turnkey errors (TurnkeyRequestError /
 *   TurnkeyActivityError / TurnkeyUpstreamError) -> 502 with
 *   code="TURNKEY_UPSTREAM"; any other failure -> 500 with
 *   code="INTERNAL". Response body carries a fixed opaque string (never
 *   error.message) to avoid leaking upstream detail to unauthenticated
 *   callers (REVIEW HI-03).
 * - T-33-02 (Information Disclosure): NEVER include the request body or
 *   hmacSecret in logSystemError metadata, and NEVER forward error.message
 *   to the client.
 */
import { TurnkeyActivityError, TurnkeyRequestError } from "@turnkey/sdk-server";
import { provisionAgenticWallet } from "@/lib/agentic-wallet/provision";
import { incrementAndCheck } from "@/lib/agentic-wallet/rate-limit";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { resolveTrustedClientIp } from "@/lib/security/trusted-proxies";

export const dynamic = "force-dynamic";

const RATE_LIMIT_MAX = 5;

function getPeerIp(request: Request): string | null {
  // The ingress sets X-Real-IP to the true TCP peer.
  const ip = (request as unknown as { ip?: string }).ip;
  return ip ?? request.headers.get("x-real-ip");
}

export async function POST(request: Request): Promise<Response> {
  const peerIp = getPeerIp(request);
  const trustedIp = resolveTrustedClientIp(request, peerIp);
  const rate = await incrementAndCheck(
    `provision:${trustedIp}`,
    RATE_LIMIT_MAX
  );
  if (!rate.allowed) {
    return Response.json(
      { error: "Rate limit exceeded", retryAfter: rate.retryAfter },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfter) },
      }
    );
  }

  try {
    const result = await provisionAgenticWallet();
    return Response.json(result, { status: 200 });
  } catch (error) {
    // REVIEW HI-03: use typed error detection (instanceof) instead of regex
    // on error.message. Turnkey SDK throws TurnkeyRequestError (API-layer HTTP
    // errors) and TurnkeyActivityError (activity-level failures); both should
    // surface as TURNKEY_UPSTREAM so the npm client's retry logic kicks in.
    // A conservative name-based fallback also catches custom Turnkey-tagged
    // errors thrown from provision.ts.
    const isTurnkey =
      error instanceof TurnkeyRequestError ||
      error instanceof TurnkeyActivityError ||
      (error instanceof Error &&
        (error.name === "TurnkeyRequestError" ||
          error.name === "TurnkeyActivityError" ||
          error.name === "TurnkeyUpstreamError"));
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Agentic] /provision failed",
      error,
      {
        // T-33-02: do NOT include the request body or hmacSecret in meta.
        endpoint: "/api/agentic-wallet/provision",
        operation: "provision",
      }
    );
    // REVIEW HI-03: never forward raw error.message to unauthenticated
    // callers. Fixed strings per error class; internal detail lives in logs.
    return Response.json(
      {
        error: isTurnkey ? "Upstream signer error" : "Provision failed",
        code: isTurnkey ? "TURNKEY_UPSTREAM" : "INTERNAL",
      },
      { status: isTurnkey ? 502 : 500 }
    );
  }
}
