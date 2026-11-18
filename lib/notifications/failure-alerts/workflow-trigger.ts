import {
  getTriggerTypeFromConfig,
  WorkflowTriggerEnum,
  type WorkflowTriggerType,
} from "@/lib/workflow/store";
import {
  getTriggerConfig,
  type TriggerNodeLike,
} from "@/lib/workflow/trigger-display-key";

/** The trigger as the editor reads it; null when missing or unrecognised. */
export function workflowTriggerType(
  nodes: TriggerNodeLike[]
): WorkflowTriggerType | null {
  return getTriggerTypeFromConfig(getTriggerConfig(nodes)) ?? null;
}

/** Every trigger whose runs start on their own: all but Manual. */
export const AUTOMATIC_TRIGGERS: readonly string[] = Object.values(
  WorkflowTriggerEnum
).filter((trigger) => trigger !== WorkflowTriggerEnum.MANUAL);

/** Every trigger but Manual runs on its own, including ones added later. */
export function runsOnItsOwn(trigger: string | null): boolean {
  return trigger !== null && trigger !== WorkflowTriggerEnum.MANUAL;
}
