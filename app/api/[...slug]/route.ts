/**
 * Catch-all 404 handler for unmatched /api/* paths.
 *
 * Next.js's default 404 returns an HTML page, which makes a wrong URL
 * look identical to a 401 when a builder is probing an API. This handler
 * returns the canonical {error, detail, request_id} envelope so unknown
 * routes are unambiguous and machine-parseable.
 *
 * Precedence: more specific route segments win over [...slug] in the
 * Next.js App Router, so existing catch-alls at deeper paths
 * (app/api/auth/[...all], app/api/execute/[...slug]) keep their own
 * behavior. This file only fires when no other route matches.
 *
 * Cache-Control: no-store so a transient prod misconfig (route file not
 * shipped, missing env var, etc.) does not get cached at the edge as a
 * permanent 404.
 */
import { type NextRequest, NextResponse } from "next/server";
import { ApiErrorCodes, apiError } from "@/lib/errors/api-envelope";
import { ErrorCategory, logUserError } from "@/lib/logging";

// Per-route code, kept here rather than in ApiErrorCodes because only this
// handler raises it.
const DOUBLED_API_PREFIX = "doubled_api_prefix";

// Every documented path already carries the /api prefix, so a client whose
// base URL also ends in /api produces /api/api/... . A bare not_found reads
// as a wrong path or a deleted resource, which sends people looking in the
// wrong place, so name the cause instead.
function doubledPrefixResponse(request: NextRequest, pathname: string) {
  const corrected = pathname.replace("/api/api/", "/api/");
  logUserError(
    ErrorCategory.VALIDATION,
    `[api-doubled-prefix] ${request.method} ${pathname}`,
    undefined,
    { method: request.method }
  );
  return apiError({
    status: 404,
    code: DOUBLED_API_PREFIX,
    detail: `Route ${request.method} ${pathname} not found. The path is doubled: it contains /api twice.`,
    hint: `Your base URL already includes /api. Drop it from the base URL, or call ${corrected} instead.`,
    requestHeaders: request.headers,
    headers: { "Cache-Control": "no-store" },
  });
}

function notFoundResponse(request: NextRequest) {
  const { pathname } = new URL(request.url);

  // Matches the bare /api/api too, which is what a base-URL misconfiguration
  // produces when the caller asks for the API root.
  if (pathname === "/api/api" || pathname.startsWith("/api/api/")) {
    return doubledPrefixResponse(request, pathname);
  }
  // Emit a structured Loki line so frequently-probed unknown routes stay
  // diagnosable. This is a public surface that bots hammer with random
  // paths; a miss is a client error, not a system fault, so it must not
  // page on-call or burn a Sentry event per request. logUserError with no
  // error argument logs to console/Loki and bumps a bounded Prometheus
  // counter but skips captureException entirely. The unbounded path lives
  // in the message (extractContext keeps only the "[api-catch-all]"
  // prefix as the metric context), never in a metric label, so Prometheus
  // cardinality stays flat.
  logUserError(
    ErrorCategory.VALIDATION,
    `[api-catch-all] unknown route ${request.method} ${pathname}`,
    undefined,
    { method: request.method }
  );
  return apiError({
    status: 404,
    code: ApiErrorCodes.NOT_FOUND,
    detail: `Route ${request.method} ${pathname} not found`,
    requestHeaders: request.headers,
    headers: { "Cache-Control": "no-store" },
  });
}

export function GET(request: NextRequest) {
  return notFoundResponse(request);
}

export function POST(request: NextRequest) {
  return notFoundResponse(request);
}

export function PUT(request: NextRequest) {
  return notFoundResponse(request);
}

export function PATCH(request: NextRequest) {
  return notFoundResponse(request);
}

export function DELETE(request: NextRequest) {
  return notFoundResponse(request);
}

export function HEAD(request: NextRequest) {
  // HEAD must not carry a response body (RFC 9110 9.3.2). Reuse the GET
  // 404 so the status, correlation id, and cache headers stay identical,
  // then return a body-less response with the same headers.
  const response = notFoundResponse(request);
  return new NextResponse(null, {
    status: response.status,
    headers: response.headers,
  });
}

export function OPTIONS(request: NextRequest) {
  return notFoundResponse(request);
}
