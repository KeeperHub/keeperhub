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
  // Normalized so a legacy "Scheduled" row draws the clock, as the sidebar
  // does, rather than falling back to Play on the canvas.
  const normalized = getTriggerTypeFromConfig({ triggerType });
  return normalized ? TRIGGER_ICONS[normalized] : Play;
}
