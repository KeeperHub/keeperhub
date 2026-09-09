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
 * the pod's http port directly over the cluster network, so a scrape reaches
 * the handler with none of the headers the edge adds. Cloudflare sets
 * cf-connecting-ip / cf-ray at its own edge and strips any client-supplied
 * copy, and Traefik adds the x-forwarded-* set to every request it routes.
 * Presence of any of them therefore means the request came through
 * app.keeperhub.com and is refused.
 *
 * A caller that must read metrics from outside the cluster signs the request
 * with the internal service HMAC (lib/internal-service-auth.ts), the same
 * scheme the /api/internal routes use.
 */

import "server-only";

import { authenticateInternalService } from "@/lib/internal-service-auth";

/**
 * Headers only a proxied request carries. Absence of all of them is what
 * identifies a direct in-cluster scrape.
 */
const EDGE_FORWARDED_HEADERS: readonly string[] = [
  "cf-connecting-ip",
  "cf-ray",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
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
  if (hasAnyHeader(request, HMAC_HEADERS)) {
    const auth = await authenticateInternalService(request);
    if (auth.authenticated) {
      return { allowed: true };
    }
    return { allowed: false, status: auth.status, message: auth.error };
  }

  if (hasAnyHeader(request, EDGE_FORWARDED_HEADERS)) {
    // Indistinguishable from a route that does not exist, so the endpoint does
    // not confirm itself to an unauthenticated prober.
    return { allowed: false, status: 404, message: "Not Found" };
  }

  return { allowed: true };
}
