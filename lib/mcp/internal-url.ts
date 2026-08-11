const TRAILING_SLASH = /\/+$/;

/**
 * Base URL for the MCP server's server-to-server calls into this app's own
 * /api/* routes (execution, workflow invocation, status polling, resources).
 *
 * This MUST stay on the in-pod loopback. The MCP route handlers and the /api
 * routes run in the same Next.js process, so routing these internal calls
 * through the public hostname (app.keeperhub.com) sends them out to the
 * Cloudflare edge — whose managed WAF challenges the pod-to-edge request and
 * 403s tool execution. Never substitute the public / OAuth base URL here;
 * that one is for metadata documents the client must reach, not for our own
 * internal fetches.
 *
 * INTERNAL_API_URL overrides the default for non-standard deployments.
 */
export function getInternalApiBaseUrl(): string {
  const override = process.env.INTERNAL_API_URL;
  if (override) {
    return override.replace(TRAILING_SLASH, "");
  }
  return `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
}
