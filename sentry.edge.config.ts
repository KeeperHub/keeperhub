// Sentry initialization for the Next.js edge runtime (middleware, edge routes).
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import { init } from "@sentry/nextjs";
import { scrubSentryEvent } from "@/lib/rpc/scrub-rpc-urls";

const { SENTRY_DSN, SENTRY_ENVIRONMENT } = process.env;

// Env-driven performance-trace sampling; defaults to 0.1 (errors are always
// captured regardless). Override per environment via SENTRY_TRACES_SAMPLE_RATE.
const tracesEnv = process.env.SENTRY_TRACES_SAMPLE_RATE;
const tracesSampleRate =
  tracesEnv && Number.isFinite(Number(tracesEnv)) ? Number(tracesEnv) : 0.1;

if (SENTRY_DSN) {
  init({
    dsn: SENTRY_DSN,
    environment: SENTRY_ENVIRONMENT,

    tracesSampleRate,

    // Enable logs to be sent to Sentry
    enableLogs: true,

    // Enable sending user PII (Personally Identifiable Information)
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
    sendDefaultPii: true,

    // Same reasoning as sentry.server.config.ts: strip provider keys that an
    // SDK error inlined into its message before the event leaves the process.
    beforeSend(event) {
      scrubSentryEvent(event);
      return event;
    },
  });
}
