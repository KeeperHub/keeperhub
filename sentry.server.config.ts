// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import { init } from "@sentry/nextjs";
import { scrubSentryEvent } from "@/lib/rpc/scrub-rpc-urls";

const { SENTRY_DSN, SENTRY_ENVIRONMENT } = process.env;

// Performance-trace sampling is env-driven (SENTRY_TRACES_SAMPLE_RATE) and
// defaults to 0.1 to cap cost/volume in production. This only samples
// performance traces - error events are always captured. Set the env var per
// environment (e.g. 1 in staging) to override.
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

    // captureException receives the raw SDK error, so a provider URL inlined
    // into its message (viem's HttpRequestError does this) would otherwise
    // reach Sentry with the API key intact. The Loki path already scrubs via
    // buildErrPayload; this is the equivalent for the Sentry path.
    beforeSend(event) {
      scrubSentryEvent(event);
      return event;
    },
  });
}
