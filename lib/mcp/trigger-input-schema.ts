import { z } from "zod";
import { WorkflowTriggerEnum } from "@/lib/workflow/store";

/**
 * Per-workflow MCP tool input schema, discriminated by trigger type.
 *
 * Four discriminants are emitted:
 *   - "manual"          empty payload, manual-fire workflow
 *   - "schedule"        empty payload, cron is workflow-level config
 *   - "webhook"         { method?, query?, body?, headers? } — matches the
 *                       Webhook trigger's outputFields in
 *                       app/api/mcp/schemas/route.ts verbatim
 *   - "on-chain-event"  { chainId, eventName?, address?, blockNumber? } —
 *                       field NAMES are `eventName` and `address`, NOT
 *                       `event` and `contract`. This matches the canonical
 *                       Event trigger outputFields shape that the
 *                       event-tracker emits at runtime; using the wrong
 *                       names breaks {{@trigger:Trigger.eventName}} template
 *                       references downstream.
 *
 * Backward compatibility: the discriminant `type` field is OPTIONAL on the
 * wire. A payload without `type` is normalized to {type: "manual", ...rest}
 * via z.preprocess BEFORE the discriminated union matches. This preserves
 * every existing flat-bag caller of call_workflow_<slug> tools.
 */

export type TriggerKind = "manual" | "schedule" | "webhook" | "on-chain-event";

type TriggerNodeShape = {
  data?: {
    type?: unknown;
    config?: {
      triggerType?: unknown;
    };
  };
};

/**
 * Map a workflow's `nodes` JSONB to its discriminant kind.
 *
 * Block triggers share the "on-chain-event" discriminant — they need
 * chainId at minimum and may carry blockNumber; the executor receives them
 * via the same trigger-input wire shape.
 *
 * Unknown / missing trigger → "manual" (safest default; flat-bag callers
 * stay backward compatible).
 */
export function detectListingTriggerType(nodes: unknown): TriggerKind {
  if (!Array.isArray(nodes)) {
    return "manual";
  }
  const triggerNode = (nodes as TriggerNodeShape[]).find(
    (n) => n && typeof n === "object" && n.data?.type === "trigger"
  );
  const raw = triggerNode?.data?.config?.triggerType;
  if (typeof raw !== "string") {
    return "manual";
  }
  switch (raw) {
    case WorkflowTriggerEnum.MANUAL:
      return "manual";
    case WorkflowTriggerEnum.SCHEDULE:
    case "Scheduled":
      return "schedule";
    case WorkflowTriggerEnum.WEBHOOK:
      return "webhook";
    case WorkflowTriggerEnum.EVENT:
    case WorkflowTriggerEnum.BLOCK:
    case WorkflowTriggerEnum.TEMPO_PAYMENT:
      return "on-chain-event";
    default:
      return "manual";
  }
}

/**
 * Normalize a raw MCP tool input so the discriminated union can match.
 *
 * Rules:
 *   null/undefined            → { type: "manual" }
 *   non-object                → throws TypeError (defensive — MCP SDK
 *                               should already have rejected non-objects)
 *   object without `type`     → { type: "manual", ...input }
 *   object with `type`        → { ...input } unchanged
 *
 * Exported standalone so the test fixture can exercise the boundary
 * directly; ALSO embedded into the schema via z.preprocess so the SDK's
 * parse-on-call applies the normalization automatically.
 */
export function normalizeTriggerInput(input: unknown): Record<string, unknown> {
  if (input === null || input === undefined) {
    return { type: "manual" };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Trigger input must be an object");
  }
  const obj = input as Record<string, unknown>;
  if (!("type" in obj)) {
    return { type: "manual", ...obj };
  }
  return { ...obj };
}

const manualBranch = z
  .object({
    type: z.literal("manual"),
  })
  .describe("Manual trigger — no caller input required.");

const scheduleBranch = z
  .object({
    type: z.literal("schedule"),
  })
  .describe(
    "Scheduled trigger — cron expression is workflow-level config, no caller input required."
  );

const webhookBranch = z
  .object({
    type: z.literal("webhook"),
    method: z
      .string()
      .optional()
      .describe(
        "HTTP method (GET, POST, etc.) — matches the webhook delivery method"
      ),
    query: z
      .record(z.string(), z.string())
      .optional()
      .describe("Query parameters as a flat string map"),
    body: z
      .unknown()
      .optional()
      .describe("Webhook request body — shape is workflow-defined"),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe("HTTP headers as a flat string map"),
  })
  .describe(
    "Webhook trigger payload — field shapes mirror the Webhook trigger outputFields in app/api/mcp/schemas/route.ts."
  );

const onChainEventBranch = z
  .object({
    type: z.literal("on-chain-event"),
    chainId: z
      .number()
      .int()
      .positive()
      .describe(
        "EVM chain ID (e.g. 1 for Ethereum, 8453 for Base, 11155111 for Sepolia)"
      ),
    eventName: z
      .string()
      .optional()
      .describe(
        "Event name as emitted on-chain (e.g. Transfer, Approval). Required for Event triggers; may be omitted for Block triggers."
      ),
    address: z
      .string()
      .optional()
      .describe(
        "Ethereum address (0x-prefixed) of the contract that emitted the event. Required for Event triggers; may be omitted for Block triggers."
      ),
    blockNumber: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Block number at which the event was emitted"),
  })
  .describe(
    "On-chain event trigger payload — field NAMES are eventName and address (NOT event and contract) to match the runtime event-tracker payload exactly."
  );

/**
 * Build the per-slug MCP tool inputSchema for a workflow with the given
 * trigger kind.
 *
 * Returns a z.preprocess wrapper around a single-branch discriminated
 * union. The preprocess step calls normalizeTriggerInput so callers that
 * omit the `type` discriminant are routed to the `manual` branch
 * automatically (backward compat for every existing flat-bag caller).
 *
 * Single-branch discriminated unions are intentional: the emitted JSON
 * Schema retains the discriminant literal, and future additions of a
 * second branch (e.g. a synthetic "test" discriminant) are a one-line
 * change.
 */
export function buildTriggerInputSchema(kind: TriggerKind): z.ZodTypeAny {
  const branch = (() => {
    switch (kind) {
      case "manual":
        return manualBranch;
      case "schedule":
        return scheduleBranch;
      case "webhook":
        return webhookBranch;
      case "on-chain-event":
        return onChainEventBranch;
      default: {
        const exhaustive: never = kind;
        throw new Error(`Unknown trigger kind: ${String(exhaustive)}`);
      }
    }
  })();

  return z.preprocess(
    (value) => normalizeTriggerInput(value),
    z.discriminatedUnion("type", [branch])
  );
}
