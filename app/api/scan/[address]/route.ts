/**
 * GET /api/scan/[address]
 *
 * FUNNEL-01 public, unauthenticated entry point for the scan-to-automate
 * onboarding funnel. No authentication guard — public by App Router default.
 *
 * Abuse-control order (SCAN-14):
 *   1. Validate ethers.isAddress — 400 on malformed (no rate-limit/RPC work).
 *   2. Resolve canonical client IP via getRequestSourceIp (cf-connecting-ip,
 *      set authoritatively by Cloudflare and unforgeable by clients; trusted-
 *      proxy XFF fallback). Never raw x-real-ip / X-Forwarded-For.
 *   3. Postgres-backed rate limit via incrementAndCheckWithBackoff: 6 free
 *      scans per hour per IP, then an exponential backoff tail (30s, 60s,
 *      120s, ... between scans) until the hour bucket rolls over. Blocked
 *      requests return 429 BEFORE scanAddress is called.
 *   4. scanAddress handles the 5-min cache short-circuit (SCAN-13) and fans
 *      out to N-chain RPC calls only on a cache miss.
 *
 * T-51-08-06: no @/lib/auth import and no auth call; asserting this in
 * tests keeps the FUNNEL-01 invariant from regressing silently.
 */

import "server-only";

import { ethers } from "ethers";
import { logAnonymousExecutionBlock } from "@/lib/auth-anonymous-guard";
import { HttpStatus } from "@/lib/http-status";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { createTimer, getMetricsCollector } from "@/lib/metrics";
import { recordScanRequest } from "@/lib/metrics/collectors/prometheus";
import { MetricNames } from "@/lib/metrics/types";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import {
  buildApyContext,
  fetchDefillamaYieldPools,
} from "@/lib/scan/price/defillama-yields";
import { incrementAndCheckWithBackoff } from "@/lib/scan/rate-limit";
import { ENS_NAME_REGEX, resolveEnsName } from "@/lib/scan/resolve-ens";
import { scanAddress } from "@/lib/scan/scanner";
import {
  type ApyContext,
  buildSuggestions,
} from "@/lib/scan/suggestions/engine";
import { getRequestSourceIp } from "@/lib/security/request-attribution";

export const dynamic = "force-dynamic";

/** Scans that pass with no wait within one hour bucket. */
// 30/hour: generous enough that a real user exploring several addresses (and
// re-scans, which also consume budget) never hits it, while the backoff tail
// below still throttles scripted abuse of the anonymous endpoint.
const FREE_SCAN_LIMIT = 30;
/** First backoff step; doubles per additional scan (30s, 60s, 120s, ...). */
const BACKOFF_BASE_SECONDS = 30;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> }
): Promise<Response> {
  const { address: rawQuery } = await params;

  // Accept a raw EVM address or a name-shaped ENS query. Reject anything that
  // is neither BEFORE any rate-limit or RPC work (no cost on garbage input).
  // Annotated as boolean (not the inferred `value is string` predicate) so the
  // ENS branch below keeps rawQuery typed as string rather than narrowing it
  // to `never`.
  const isRawAddress: boolean = ethers.isAddress(rawQuery);
  if (!(isRawAddress || ENS_NAME_REGEX.test(rawQuery))) {
    recordScanRequest("invalid_query");
    return Response.json(
      { error: "Invalid address" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  // Canonical client IP via cf-connecting-ip (Cloudflare-authoritative,
  // unforgeable). Raw x-real-ip / X-Forwarded-For is client-controllable and
  // would let a caller spoof the rate-limit key to bypass the limit.
  // Unattributable requests share one "unknown" bucket so they cannot escape
  // the limit by withholding the header.
  const trustedIp = getRequestSourceIp(request) ?? "unknown";
  const rate = await incrementAndCheckWithBackoff(
    `scan:${trustedIp}`,
    FREE_SCAN_LIMIT,
    BACKOFF_BASE_SECONDS
  );

  if (!rate.allowed) {
    // HARDEN-01: emit abuse telemetry BEFORE returning 429 so the Sentry
    // event fires even if the response pipeline has an edge-case failure.
    // extra values must all be strings (Record<string, string>).
    logAnonymousExecutionBlock("scan", null, {
      ip: trustedIp,
      rateLimitCount: String(rate.count),
      address: rawQuery,
    });
    recordScanRequest("rate_limited");
    return applyRateLimitHeaders(
      Response.json(
        { error: "Rate limit exceeded", retryAfter: rate.retryAfter },
        { status: HttpStatus.TOO_MANY_REQUESTS }
      ),
      rate
    );
  }

  // Resolve an ENS query to its address now that the request has passed the
  // rate limit (ENS resolution is one RPC call, so it must be gated). Raw
  // addresses skip this. An unresolvable name is a 400 — the rate-limit slot
  // is already spent, which is acceptable for a well-formed but dead name.
  let address = rawQuery;
  let ensName: string | undefined;
  if (!isRawAddress) {
    const resolved = await resolveEnsName(rawQuery);
    if (!resolved) {
      recordScanRequest("ens_unresolved");
      return applyRateLimitHeaders(
        Response.json(
          { error: "Could not resolve ENS name" },
          { status: HttpStatus.BAD_REQUEST }
        ),
        rate
      );
    }
    address = resolved;
    ensName = rawQuery.toLowerCase();
  }

  const metricsCollector = getMetricsCollector();
  const scanTimer = createTimer();

  try {
    const result = await scanAddress(address);
    metricsCollector.recordLatency(
      MetricNames.SCAN_ADDRESS_DURATION,
      scanTimer(),
      { status: "success" }
    );
    // T-57-05: Pre-fetch the DefiLlama yield pools snapshot once and build the
    // apyContext before calling buildSuggestions. Any failure (timeout, parse
    // error, etc.) leaves apyContext undefined so the engine degrades all yield
    // suggestions to generic copy (YIELD-03) without blocking the 200 response.
    let apyContext: ApyContext | undefined;
    try {
      const yieldPools = await fetchDefillamaYieldPools();
      apyContext = buildApyContext(yieldPools, result.stablecoins);
    } catch {
      // Yields fetch or context build failed — degrade to generic copy.
    }

    // T-52-12: buildSuggestions is pure and bounded (<10ms), but any engine
    // error degrades gracefully to [] rather than failing the 200 response.
    let suggestions: ReturnType<typeof buildSuggestions> = [];
    try {
      suggestions = buildSuggestions(result, apyContext);
    } catch {
      // Engine error — return empty suggestions, do not fail the scan response.
    }
    recordScanRequest(suggestions.length > 0 ? "success" : "empty");
    return applyRateLimitHeaders(
      Response.json({ ...result, ensName, suggestions }),
      rate
    );
  } catch (error) {
    recordScanRequest("failure");
    metricsCollector.recordLatency(
      MetricNames.SCAN_ADDRESS_DURATION,
      scanTimer(),
      { status: "failure" }
    );
    // Server-side observability: log the real cause (never returned to the
    // client). Without this the public "Scan failed" response hides the error.
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[scan] scanAddress failed",
      error,
      {
        endpoint: "/api/scan/[address]",
      }
    );
    // Never leak internal/RPC error detail on the public surface.
    return applyRateLimitHeaders(
      Response.json(
        { error: "Scan failed" },
        { status: HttpStatus.INTERNAL_SERVER_ERROR }
      ),
      rate
    );
  }
}
