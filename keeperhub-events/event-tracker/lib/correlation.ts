import { randomBytes } from "node:crypto";

/**
 * End-to-end latency correlation (issue #2289).
 *
 * Minted at the moment an event is first observed, carried on the SQS message,
 * and reused by the executor (which falls back to minting its own when the id
 * is absent, e.g. legacy messages or non-event triggers). Same format as the
 * executor's generateCorrelationId so a single run traces across both systems.
 *
 * Deliberately duplicated rather than imported: keeperhub-events is a separate
 * pnpm workspace and cannot import the app's root lib/ (same convention as
 * this package's phantom.ts and sqs-message-auth.ts).
 */
export function generateCorrelationId(): string {
  return randomBytes(8).toString("hex");
}
