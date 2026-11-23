/**
 * Per-workflow start priority, stored on the trigger node config as
 * `executionPriority`. "low-latency" asks the executor to start runs on a
 * pre-started runner (keeperhub-executor/warm-pool.ts) instead of a new
 * per-run container. Absent or any other value means "standard".
 */

export const EXECUTION_PRIORITY_FIELD = "executionPriority";

export const EXECUTION_PRIORITIES = ["standard", "low-latency"] as const;

export type ExecutionPriority = (typeof EXECUTION_PRIORITIES)[number];

export const LOW_LATENCY_START_FEATURE_ID = "automation.low-latency-start";

// Trigger types (as the editor names them) that offer the setting. Matches
// LOW_LATENCY_DISPATCH_TRIGGERS below, which the executor enforces.
export const LOW_LATENCY_TRIGGER_TYPES: readonly string[] = [
  "Schedule",
  "Event",
  "Block",
  "Webhook",
];

// The same set as the executor's message trigger types. Enforced by the
// executor, not just hidden in the UI: a manual or API-started run never
// takes a warm runner, so repeated manual runs cannot drain the pool.
export const LOW_LATENCY_DISPATCH_TRIGGERS: ReadonlySet<string> = new Set([
  "schedule",
  "block",
  "event",
  "webhook",
]);

type NodeLike = {
  data?: { type?: unknown; config?: Record<string, unknown> | null };
};

/**
 * Why a trigger's executionPriority will not do what it says, for
 * validate_workflow to warn about; undefined when it is fine. Plan
 * entitlement is checked when a run starts, not here.
 */
export function executionPriorityWarning(
  config: Record<string, unknown> | null | undefined
): string | undefined {
  const value = config?.[EXECUTION_PRIORITY_FIELD];
  if (value === undefined) {
    return undefined;
  }
  if (!(EXECUTION_PRIORITIES as readonly unknown[]).includes(value)) {
    return `executionPriority ${JSON.stringify(value)} is not one of ${EXECUTION_PRIORITIES.map((p) => `"${p}"`).join(", ")}; runs start the standard way`;
  }
  const triggerType = config?.triggerType;
  if (
    value === "low-latency" &&
    !LOW_LATENCY_TRIGGER_TYPES.includes(String(triggerType ?? "Manual"))
  ) {
    return `executionPriority "low-latency" has no effect on a ${String(triggerType ?? "Manual")} trigger; it applies to ${LOW_LATENCY_TRIGGER_TYPES.join(", ")} triggers`;
  }
  return undefined;
}

export function readExecutionPriority(value: unknown): ExecutionPriority {
  return value === "low-latency" ? "low-latency" : "standard";
}

/** The start priority a workflow asks for, read from its trigger node. */
export function getWorkflowExecutionPriority(
  nodes: readonly unknown[]
): ExecutionPriority {
  for (const node of nodes) {
    const data = (node as NodeLike | null)?.data;
    if (data?.type === "trigger") {
      return readExecutionPriority(data.config?.[EXECUTION_PRIORITY_FIELD]);
    }
  }
  return "standard";
}
