/**
 * Next.js instrumentation file
 * This runs once when the server starts (before any requests are handled)
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

const WORKFLOW_ENTRYPOINT_IMPORT_RE =
  /^import \{ workflowEntrypoint \} from ['"]workflow\/runtime['"];?$/m;
const WORKFLOW_ENTRYPOINT_POST_RE =
  /^export const POST = workflowEntrypoint\(workflowCode\);?$/m;

/**
 * Ensure special characters in postgres URL passwords are percent-encoded.
 * postgres.js parses connection strings via new URL() which requires encoding.
 * CNPG-generated passwords often contain +/= (base64) that break URL parsing.
 *
 * Parsing strategy (keep in sync with scripts/encode-pg-url.ts):
 * 1. The last '@' separates credentials from the host (handles passwords with '@')
 * 2. The first ':' between '://' and '@' separates username from password
 *    (handles passwords with ':', e.g. base64 a:b=)
 * 3. PostgreSQL usernames cannot contain unescaped ':'
 */
function encodePostgresPassword(url: string): string {
  try {
    new URL(url);
    return url;
  } catch {
    const schemeEnd = url.indexOf("://") + 3;
    const atIdx = url.lastIndexOf("@");
    const credentialRange = url.slice(schemeEnd, atIdx);
    const colonOffset = credentialRange.indexOf(":");
    const colonIdx = colonOffset === -1 ? -1 : schemeEnd + colonOffset;
    if (schemeEnd > 3 && atIdx > schemeEnd && colonIdx > schemeEnd) {
      const user = url.slice(schemeEnd, colonIdx);
      const pass = url.slice(colonIdx + 1, atIdx);
      const hostPart = url.slice(atIdx + 1);
      if (hostPart.includes(":") || hostPart.includes("/")) {
        return `${url.slice(0, schemeEnd)}${encodeURIComponent(user)}:${encodeURIComponent(pass)}${url.slice(atIdx)}`;
      }
    }
    return url;
  }
}

export async function register() {
  // Patch console with LOG_LEVEL support
  // This must be imported dynamically to ensure it runs at startup
  await import("@/lib/logger");

  // Only register process handlers in Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Each secret signs a distinct cryptographic context (better-auth session
    // cookies, OAuth access tokens, MCP session tokens). They must be set
    // independently so a leak or rotation in one context does not cascade.
    const requiredSecrets = [
      "BETTER_AUTH_SECRET",
      "OAUTH_JWT_SECRET",
      "MCP_SESSION_SECRET",
    ];
    const missingSecrets = requiredSecrets.filter((name) => !process.env[name]);
    if (missingSecrets.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missingSecrets.join(", ")}`
      );
    }

    // Register AsyncLocalStorage for the workflow error context. The context
    // module avoids any static `node:async_hooks` import so it can be safely
    // pulled into the workflow runtime bundle; the storage is only available
    // in Node.js (API routes / server actions).
    const { AsyncLocalStorage } = await import("node:async_hooks");
    const { setWorkflowErrorContextStorage } = await import(
      "@/lib/workflow/executor/error-context"
    );
    setWorkflowErrorContextStorage(new AsyncLocalStorage());

    // Dynamically import Sentry to ensure it's available
    const Sentry = await import("@sentry/nextjs");

    // Initialize Prometheus metrics collector if enabled
    if (process.env.METRICS_COLLECTOR === "prometheus") {
      const { prometheusMetricsCollector } = await import(
        "@/lib/metrics/collectors/prometheus"
      );
      const { createDualWriteCollector } = await import(
        "@/lib/metrics/collectors/dual"
      );
      const { setMetricsCollector } = await import("@/lib/metrics");

      // Use dual-write to send metrics to both console and Prometheus
      const dualCollector = createDualWriteCollector(
        prometheusMetricsCollector
      );
      setMetricsCollector(dualCollector);
      console.log("[Metrics] Prometheus dual-write collector initialized");
    }

    // Periodic sweep of stale entries in the in-process MCP/IP rate-limit
    // maps. Inline cleanup on the request path can't reach keys that never
    // come back, so without this the maps grow unbounded with one-shot
    // organisations or IPs. See KEEP-419.
    const { startRateLimitCleanupInterval, warmRateLimitRedis } = await import(
      "@/lib/mcp/rate-limit"
    );
    startRateLimitCleanupInterval();

    // The shared Redis client connects lazily with its offline queue disabled,
    // so the first command on a cold client is rejected while the socket is
    // still opening. Open it here so the first MCP request reaches the
    // fleet-wide window instead of the per-pod fallback, and so a cold start
    // is never reported as an outage. Never rejects; bounded by connectTimeout.
    await warmRateLimitRedis();

    // Initialize Workflow Postgres World (pg-boss queue polling)
    if (process.env.WORKFLOW_TARGET_WORLD === "@workflow/world-postgres") {
      const rawUrl =
        process.env.WORKFLOW_POSTGRES_URL || process.env.DATABASE_URL;
      if (rawUrl) {
        const { ensureExplicitSslMode } = await import(
          "@/lib/db/connection-utils"
        );
        process.env.WORKFLOW_POSTGRES_URL = ensureExplicitSslMode(
          encodePostgresPassword(rawUrl)
        );
      }

      const { getWorld } = await import("workflow/runtime");
      const world = getWorld();
      if (world.start) {
        await world.start();
        console.log("[Workflow] Postgres World initialized");
      }
    }

    // Register the workflow executor handler directly for the local world in
    // dev mode. The generated flow/route.js (2MB bundled executor with a large
    // inline string literal) causes Turbopack to hang on first compilation,
    // leaving all workflow runs at status=pending indefinitely. By registering
    // the handler via world.registerHandler() we bypass the HTTP dispatch
    // (and thus Turbopack compilation) entirely.
    //
    // The builder-deferred plugin writes a stub at Next.js startup and then
    // overwrites with real content in the background. We watch for the file to
    // change before attempting registration, so we don't read the stub.
    if (
      process.env.NODE_ENV !== "production" &&
      process.env.WORKFLOW_TARGET_WORLD !== "@workflow/world-postgres"
    ) {
      const { readFileSync } = await import("node:fs");
      const { watch } = await import("node:fs");
      const { join } = await import("node:path");
      const { runInNewContext } = await import("node:vm");

      const routePath = join(
        process.cwd(),
        "app/.well-known/workflow/v1/flow/route.js"
      );

      const tryRegisterHandler = async (): Promise<boolean> => {
        try {
          const routeContent = readFileSync(routePath, "utf8");
          if (routeContent.includes("__workflowRouteStub")) {
            return false;
          }

          const vmScript = routeContent
            .replace(
              WORKFLOW_ENTRYPOINT_IMPORT_RE,
              "const workflowEntrypoint = (code) => code;"
            )
            .replace(
              WORKFLOW_ENTRYPOINT_POST_RE,
              "__wkfResult.code = workflowEntrypoint(workflowCode);"
            );

          const sandbox = { __wkfResult: { code: "" } };
          runInNewContext(vmScript, sandbox);

          const workflowCode = sandbox.__wkfResult.code;
          if (typeof workflowCode !== "string" || workflowCode.length === 0) {
            return false;
          }

          const { workflowEntrypoint, getWorld } = await import(
            "workflow/runtime"
          );
          const handler = workflowEntrypoint(workflowCode);
          const world = getWorld() as unknown as {
            registerHandler?: (
              prefix: "__wkf_workflow_" | "__wkf_step_",
              handler: (req: Request) => Promise<Response>
            ) => void;
          };
          if (typeof world.registerHandler === "function") {
            world.registerHandler("__wkf_workflow_", handler);
            console.log(
              "[Workflow] Local world: direct handler registered, HTTP dispatch bypassed"
            );
            return true;
          }
        } catch {
          // Ignore errors — file may not exist yet or may be partially written
        }
        return false;
      };

      // Try immediately; if the file is still a stub, watch for the real content
      if (!(await tryRegisterHandler())) {
        const watcher = watch(routePath, async () => {
          if (await tryRegisterHandler()) {
            watcher.close();
          }
        });
        watcher.on("error", () => watcher.close());
      }
    }

    // Catch unhandled promise rejections (would otherwise be silent)
    process.on("unhandledRejection", (reason) => {
      console.error(
        "Unhandled Rejection:",
        reason instanceof Error ? reason.message : reason,
        reason instanceof Error ? reason.stack : ""
      );

      // Send to Sentry
      if (reason instanceof Error) {
        Sentry.captureException(reason);
      } else {
        Sentry.captureException(
          new Error(`Unhandled Rejection: ${String(reason)}`)
        );
      }
    });

    // Catch uncaught exceptions
    process.on("uncaughtException", (error) => {
      console.error("Uncaught Exception:", error.message, error.stack);

      // Send to Sentry
      Sentry.captureException(error);
    });
  }
}
