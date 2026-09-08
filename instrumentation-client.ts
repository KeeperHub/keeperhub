// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import { captureRouterTransitionStart, init } from "@sentry/nextjs";
import {
  hasNoInAppFrames,
  isBrowserExtensionError,
  isEip1193ProviderRejection,
  isMonacoCancellation,
  throwsOutsideAppBundle,
} from "@/lib/sentry-filters";

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN;
const SENTRY_ENVIRONMENT = process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT;

// Env-driven performance-trace sampling; defaults to 0.1 (errors are always
// captured regardless). Override via NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
// (must be NEXT_PUBLIC_ to reach the browser bundle).
const tracesEnv = process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE;
const tracesSampleRate =
  tracesEnv && Number.isFinite(Number(tracesEnv)) ? Number(tracesEnv) : 0.1;

if (SENTRY_DSN) {
  init({
    dsn: SENTRY_DSN,
    ...(SENTRY_ENVIRONMENT && { environment: SENTRY_ENVIRONMENT }),

    tracesSampleRate,

    // Enable logs to be sent to Sentry
    enableLogs: true,

    // Enable sending user PII (Personally Identifiable Information)
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
    sendDefaultPii: true,

    beforeSend(event) {
      if (isEip1193ProviderRejection(event)) {
        return null;
      }
      if (hasNoInAppFrames(event)) {
        return null;
      }
      if (isBrowserExtensionError(event)) {
        return null;
      }
      if (throwsOutsideAppBundle(event)) {
        return null;
      }
      if (isMonacoCancellation(event)) {
        return null;
      }
      return event;
    },
  });
}

export const onRouterTransitionStart = captureRouterTransitionStart;
