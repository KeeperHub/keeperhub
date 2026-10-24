/**
 * Gates outbound webhooks.
 *
 * Today this only controls whether execution events are written to
 * `event_outbox`; nothing reads them yet. Defaults to OFF: set
 * `OUTBOUND_WEBHOOKS_ENABLED=true` to record events.
 *
 * Dependency-free so a standalone worker can import it outside the app's
 * server-only import chain.
 */
export function isOutboundWebhooksEnabled(): boolean {
  return process.env.OUTBOUND_WEBHOOKS_ENABLED === "true";
}
