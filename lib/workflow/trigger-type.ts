import type { TriggerType } from "@/lib/metrics/types";

/**
 * What started a run, as one word, or nothing when it cannot be told.
 *
 * This was written twice, once for metrics and once for the executor, and
 * neither listed every trigger the editor offers. Both ended with a bare
 * `return "manual"`, so a Block trigger, a Transfer trigger and anything added
 * later all reported themselves as a person clicking Run.
 *
 * A wrong metric label is a reporting problem. The same value reaches policy,
 * where "only manual runs" is a rule an organization writes to keep automation
 * out, and reading every unrecognised trigger as manual granted exactly what
 * the rule existed to refuse. So an unknown trigger returns undefined here
 * rather than a guess, which leaves the fact absent, and an absent fact cannot
 * satisfy an allow.
 *
 * Callers that need a value for a label supply their own fallback. Nothing
 * downstream should invent one for an authorization decision.
 */

const BY_CONFIG_VALUE: Readonly<Record<string, TriggerType>> = {
  manual: "manual",
  webhook: "webhook",
  // The editor writes "Schedule"; older rows carry "Scheduled". Both mean the
  // same thing, and the canonical spelling stays as the metric already emits
  // it so an existing series is not split in two.
  schedule: "scheduled",
  scheduled: "scheduled",
  event: "event",
  block: "block",
  transfer: "transfer",
};

type TriggerNode = {
  data: { type: string; config?: Record<string, unknown> };
};

/** The trigger a workflow's own nodes declare. */
export function triggerTypeOf(
  nodes: readonly TriggerNode[]
): TriggerType | undefined {
  const trigger = nodes.find((node) => node.data.type === "trigger");
  const declared = trigger?.data.config?.triggerType;
  if (typeof declared !== "string") {
    return undefined;
  }
  return BY_CONFIG_VALUE[declared.trim().toLowerCase()];
}
