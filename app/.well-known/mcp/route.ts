/**
 * Live MCP endpoint at the well-known path.
 *
 * `/.well-known/mcp.json` is the static server card - it *describes* the MCP
 * surface. Discovery clients and readiness scanners also probe `/.well-known/mcp`
 * expecting to complete a real handshake there, and until now that 404'd, so a
 * scanner could read the card but never confirm the server behind it was alive.
 *
 * This is an alias, not a second implementation: it delegates to the anonymous
 * marketplace surface in app/mcp/public/route.ts, so both URLs share one session
 * store, one rate limiter, one tool allowlist, and one scope. The authenticated
 * org-scoped surface stays at /mcp and is not reachable from here.
 *
 * The card at /.well-known/mcp.json continues to advertise /mcp/public as the
 * canonical endpoint. Clients should prefer it; this path exists so a probe that
 * holds no card yet can still get a handshake. A session opened here stays
 * usable here - session ids live in a shared store, not per-route state.
 */

import {
  GET as publicGet,
  OPTIONS as publicOptions,
  POST as publicPost,
} from "@/app/mcp/public/route";

// Declared literally rather than re-exported: Next.js reads route segment
// config by static analysis, and a re-export is not statically resolvable.
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return publicGet(request);
}

export function OPTIONS(): Response {
  return publicOptions();
}

export function POST(request: Request): Promise<Response> {
  return publicPost(request);
}
