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

/**
 * Editor trigger types that offer a low-latency start, and the executor
 * message trigger types their runs arrive as. The executor honours the
 * setting only when both match, so what the editor offers and what the
 * executor does cannot drift apart. Manual runs and webhooks (which run in
 * the app, not the executor) never take a warm runner, so repeated manual
 * runs cannot drain the pool either.
 */
export const LOW_LATENCY_TRIGGERS: Readonly<Record<string, readonly string[]>> =
  {
    Schedule: ["schedule"],
    Event: ["event"],
    Block: ["block"],
    Transfer: ["event"],
    "Pyth Price": ["event", "upstream"],
  };

export const LOW_LATENCY_TRIGGER_TYPES: readonly string[] =
  Object.keys(LOW_LATENCY_TRIGGERS);

type NodeLike = {
  data?: { type?: unknown; config?: Record<string, unknown> | null };
};

function listWithAnd(items: readonly string[]): string {
  return items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

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
    return `executionPriority "low-latency" has no effect on a ${String(triggerType ?? "Manual")} trigger; it applies to ${listWithAnd(LOW_LATENCY_TRIGGER_TYPES)} triggers`;
  }
  return undefined;
}

export function readExecutionPriority(value: unknown): ExecutionPriority {
  return value === "low-latency" ? "low-latency" : "standard";
}

function triggerConfig(
  nodes: readonly unknown[]
): Record<string, unknown> | undefined {
  for (const node of nodes) {
    const data = (node as NodeLike | null)?.data;
    if (data?.type === "trigger") {
      return data.config ?? undefined;
    }
  }
  return undefined;
}

/**
 * Whether a run of this workflow, arriving as this message trigger type, may
 * take a warm runner: the workflow's own trigger must offer the setting and
 * the run must have come from it.
 */
export function lowLatencyAppliesTo(
  nodes: readonly unknown[],
  messageTriggerType: string
): boolean {
  const editorType = triggerConfig(nodes)?.triggerType;
  return (
    typeof editorType === "string" &&
    (LOW_LATENCY_TRIGGERS[editorType] ?? []).includes(messageTriggerType)
  );
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
