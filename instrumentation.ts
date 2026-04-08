/**
 * Next.js instrumentation file
 * This runs once when the server starts (before any requests are handled)
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

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
    // Register AsyncLocalStorage for the workflow error context. The context
    // module avoids any static `node:async_hooks` import so it can be safely
    // pulled into the workflow runtime bundle; the storage is only available
    // in Node.js (API routes / server actions).
    const { AsyncLocalStorage } = await import("node:async_hooks");
    const { setWorkflowErrorContextStorage } = await import(
      "@/lib/workflow-error-context"
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
