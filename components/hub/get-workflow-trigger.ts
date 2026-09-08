import type { WorkflowNode } from "@/lib/workflow/store";

export function getWorkflowTrigger(nodes: WorkflowNode[]): string | null {
  const triggerNode = nodes.find(
    (n) => n.type === "trigger" || n.data?.type === "trigger"
  );
  if (!triggerNode) {
    return null;
  }
  const triggerType = triggerNode.data?.config?.triggerType as
    | string
    | undefined;
  return triggerType ?? "Manual";
}
