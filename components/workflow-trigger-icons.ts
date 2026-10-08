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
  WorkflowTriggerEnum,
  type WorkflowTriggerType,
} from "@/lib/workflow/store";
import { getPickerTriggerType } from "@/lib/workflow/trigger-display";

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
  // The legacy "Scheduled" spelling gets the clock, in the canvas and the
  // sidebar alike; the sidebar shows it grey, as it never runs.
  const normalized = getPickerTriggerType({ triggerType });
  return normalized ? TRIGGER_ICONS[normalized] : Play;
}
