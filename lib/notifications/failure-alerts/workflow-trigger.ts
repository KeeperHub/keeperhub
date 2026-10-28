/**
 * The trigger a workflow is configured with, read the way the editor reads it
 * (lib/workflow/store.ts getTriggerTypeFromConfig): an unrecognised value,
 * including the legacy "Scheduled" spelling the schedule service ignores,
 * means no trigger at all. That module is the client store, so the server
 * keeps this small copy of the rule instead of importing it.
 */

const AUTOMATIC_TRIGGERS: ReadonlySet<string> = new Set([
  "Schedule",
  "Webhook",
  "Event",
  "Block",
  "Transfer",
  "Pyth Price",
]);

/** The configured trigger, e.g. "Schedule", or null when there is none. */
export function workflowTriggerType(
  // biome-ignore lint/suspicious/noExplicitAny: workflow nodes are JSONB validated at application level
  nodes: any[]
): string | null {
  const trigger = nodes.find((node) => node?.data?.type === "trigger");
  const value = trigger?.data?.config?.triggerType;
  if (typeof value !== "string") {
    return null;
  }
  return value === "Manual" || AUTOMATIC_TRIGGERS.has(value) ? value : null;
}

/** Whether runs of this workflow start on their own, so failures count. */
export function runsOnItsOwn(trigger: string | null): boolean {
  return trigger !== null && AUTOMATIC_TRIGGERS.has(trigger);
}
