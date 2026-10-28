import {
  getTriggerTypeFromConfig,
  WorkflowTriggerEnum,
  type WorkflowTriggerType,
} from "@/lib/workflow/store";
import {
  getTriggerConfig,
  type TriggerNodeLike,
} from "@/lib/workflow/trigger-display-key";

/**
 * The configured trigger, read the way the editor reads it, or null when there
 * is none (an unrecognised value counts as none).
 */
export function workflowTriggerType(
  nodes: TriggerNodeLike[]
): WorkflowTriggerType | null {
  return getTriggerTypeFromConfig(getTriggerConfig(nodes)) ?? null;
}

/** Every trigger whose runs start on their own: all but Manual. */
export const AUTOMATIC_TRIGGERS: readonly string[] = Object.values(
  WorkflowTriggerEnum
).filter((trigger) => trigger !== WorkflowTriggerEnum.MANUAL);

/**
 * Whether runs of this workflow start on their own, so failures count. Every
 * trigger but Manual does, including any trigger added to the enum later.
 */
export function runsOnItsOwn(trigger: string | null): boolean {
  return trigger !== null && trigger !== WorkflowTriggerEnum.MANUAL;
}
