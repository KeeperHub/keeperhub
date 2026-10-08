import {
  ArrowDownToLine,
  Box,
  Boxes,
  Clock,
  type LucideIcon,
  Play,
  Radio,
  Webhook,
} from "lucide-react";
import {
  getTriggerTypeFromConfig,
  WorkflowTriggerEnum,
  type WorkflowTriggerType,
} from "@/lib/workflow/store";

// One icon per trigger type, shared by the canvas trigger node, the trigger
// type dropdown and the sidebar picker so the three never disagree.
export const TRIGGER_ICONS: Record<WorkflowTriggerType, LucideIcon> = {
  [WorkflowTriggerEnum.PYTH_PRICE]: Radio,
  [WorkflowTriggerEnum.MANUAL]: Play,
  [WorkflowTriggerEnum.SCHEDULE]: Clock,
  [WorkflowTriggerEnum.WEBHOOK]: Webhook,
  [WorkflowTriggerEnum.EVENT]: Boxes,
  [WorkflowTriggerEnum.BLOCK]: Box,
  [WorkflowTriggerEnum.TEMPO_PAYMENT]: ArrowDownToLine,
};

export function getTriggerIcon(
  triggerType: string | null | undefined
): LucideIcon {
  // The canvas draws the clock for the legacy "Scheduled" spelling, the type
  // its node was set to; the sidebar does not, as nothing schedules it.
  const normalized = getTriggerTypeFromConfig({
    triggerType: triggerType === "Scheduled" ? "Schedule" : triggerType,
  });
  return normalized ? TRIGGER_ICONS[normalized] : Play;
}
