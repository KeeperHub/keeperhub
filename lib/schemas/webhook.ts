import { z } from "zod";

/**
 * Webhook trigger payload for POST /api/workflows/[workflowId]/webhook.
 *
 * The contents are intentionally freeform: the payload is forwarded verbatim
 * to the workflow as its trigger input, so callers send whatever their
 * integration produces. The only structural requirement is a JSON object
 * envelope (not an array or primitive) so the workflow's template references
 * resolve against named fields. An empty request body is allowed and triggers
 * the workflow with no input.
 */
export const webhookPayloadSchema = z.record(z.string(), z.unknown());

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
