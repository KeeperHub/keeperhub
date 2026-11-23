// Shared by the sidebar picker and the refetch after a save, so both read a
// workflow's trigger the same way. Kept free of imports so the API client can
// use it without an import cycle.

export type TriggerNodeLike = {
  data?: { type?: string; config?: Record<string, unknown> | null };
};

const NO_CONFIG: Record<string, unknown> = Object.freeze({});

/**
 * The trigger node's config, or undefined when there is no trigger node. A
 * trigger node saved without a config gets one shared empty object, so it
 * still counts as "has a trigger" (a Manual one) and compares equal from
 * call to call.
 */
export function getTriggerConfig(
  nodes: TriggerNodeLike[]
): Record<string, unknown> | undefined {
  const triggerNode = nodes.find((node) => node.data?.type === "trigger");
  if (!triggerNode) {
    return;
  }
  return triggerNode.data?.config ?? NO_CONFIG;
}

// The trigger config fields a sidebar row shows (icon, label, tooltip).
const DISPLAYED_CONFIG_KEYS = [
  "triggerType",
  "scheduleCron",
  "scheduleIntervalSeconds",
  "scheduleTimezone",
  "eventName",
  "blockInterval",
] as const;

/**
 * A string that changes only when what a sidebar row shows for this trigger
 * config changes. No trigger node at all reads differently from an empty one.
 */
export function triggerDisplayKey(
  config: Record<string, unknown> | undefined
): string {
  if (config === undefined) {
    return "none";
  }
  return JSON.stringify(
    DISPLAYED_CONFIG_KEYS.map((key) => config[key] ?? null)
  );
}
