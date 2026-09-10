/**
 * @security Access control for the Prometheus scrape endpoints under
 * /api/metrics.
 *
 * The exposed series carry per-customer labels (org_slug, plan, workflow_id,
 * plugin/action names, error breakdowns), so these routes must never answer a
 * request that arrived from the public internet.
 *
 * Prometheus does not need the public edge. The ServiceMonitors in
 * deploy/keeperhub-stack/<env>/values.yaml select the app Service and scrape
 * the pod's http port directly over the cluster network, bypassing Cloudflare
 * and Traefik. Cloudflare sets cf-connecting-ip / cf-ray at its own edge and
 * strips any client-supplied copy, so their presence means the request came
 * through app.keeperhub.com and is refused.
 *
 * The x-forwarded-* set cannot be used for this and must not be added back.
 * Next.js fills in x-forwarded-for, -host, -port and -proto from the socket
 * whenever the client did not send them (next/dist/server/base-server.js), so
 * an in-cluster scrape arrives carrying them too. Matching on them refuses
 * every request, which is what took the app-pod metrics down on 2026-09-09.
 *
 * The edge check runs first and is unconditional. An in-cluster caller may
 * additionally sign with the internal service HMAC (lib/internal-service-auth.ts),
 * the same scheme the /api/internal routes use, but a signature does not buy a
 * way in from the public host: the answer there is 404 either way.
 */

import "server-only";

import { authenticateInternalService } from "@/lib/internal-service-auth";

/**
 * Headers a request only carries when it came through the public edge, and
 * that Next.js does not synthesize. Absence of all of them identifies a direct
 * in-cluster scrape.
 *
 * Exported so a test can assert this list never overlaps the headers Next.js
 * fills in on its own.
 */
export const EDGE_HEADERS: readonly string[] = [
  "cf-connecting-ip",
  "cf-ray",
  "forwarded",
];

/**
 * Set by next/dist/server/base-server.js on every request whose client did not
 * send them, so they are present on an in-cluster scrape and say nothing about
 * where a request came from. Listed here to keep EDGE_HEADERS honest.
 */
export const NEXT_SYNTHESIZED_HEADERS: readonly string[] = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
];

const HMAC_HEADERS: readonly string[] = [
  "x-kh-caller",
  "x-kh-signature",
  "x-kh-timestamp",
];

export type MetricsScrapeGuardResult =
  | { allowed: true }
  | { allowed: false; status: number; message: string };

function hasAnyHeader(request: Request, names: readonly string[]): boolean {
  return names.some((name) => request.headers.get(name) !== null);
}

/**
 * Decide whether a request may read metrics. Callers that claim the internal
 * HMAC scheme are verified; everything else must be a direct in-cluster
 * request.
 */
export async function authorizeMetricsScrape(
  request: Request
): Promise<MetricsScrapeGuardResult> {
  // Edge check first. Answering a signed request differently from an unsigned
  // one would let a prober confirm the route exists by sending a caller header
  // and reading 401 instead of 404, so nothing from the edge gets that far.
  if (hasAnyHeader(request, EDGE_HEADERS)) {
    return { allowed: false, status: 404, message: "Not Found" };
  }

  if (hasAnyHeader(request, HMAC_HEADERS)) {
    const auth = await authenticateInternalService(request);
    if (auth.authenticated) {
      return { allowed: true };
    }
    return { allowed: false, status: auth.status, message: auth.error };
  }

  return { allowed: true };
}
