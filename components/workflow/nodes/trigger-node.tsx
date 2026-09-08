"use client";

import type { NodeProps } from "@xyflow/react";
import {
  ArrowDownToLine,
  Box,
  Boxes,
  Check,
  Clock,
  Play,
  Webhook,
  XCircle,
} from "lucide-react";
import Image from "next/image";
import { type ElementType, memo } from "react";
import { Node } from "@/components/ai-elements/node";
import { NodeLabel } from "@/components/workflow/nodes/node-label";
import { cn } from "@/lib/utils";
import type {
  WorkflowNodeData,
  WorkflowTriggerType,
} from "@/lib/workflow/store";
import { WorkflowTriggerEnum } from "@/lib/workflow/store";

type TriggerNodeProps = NodeProps & {
  data?: WorkflowNodeData;
};

export const TriggerNode = memo(({ data, selected, id }: TriggerNodeProps) => {
  if (!data) {
    return null;
  }

  const triggerType = (data.config?.triggerType as string) || "Manual";
  const displayTitle = data.label || triggerType;
  const displayDescription = data.description || "Trigger";
  const status = data.status;

  // Select icon based on trigger type
  const triggerIcons: Record<WorkflowTriggerType, ElementType> = {
    [WorkflowTriggerEnum.MANUAL]: Play,
    [WorkflowTriggerEnum.SCHEDULE]: Clock,
    [WorkflowTriggerEnum.WEBHOOK]: Webhook,
    [WorkflowTriggerEnum.EVENT]: Boxes, // keeperhub custom field //
    [WorkflowTriggerEnum.BLOCK]: Box, // keeperhub custom field //
    [WorkflowTriggerEnum.TEMPO_PAYMENT]: ArrowDownToLine, // keeperhub custom field //
  };

  const TriggerIcon = triggerIcons[triggerType as WorkflowTriggerType] || Play;

  const protocolIconPath = data.config?._eventProtocolIconPath as
    | string
    | undefined;
  const hasProtocolIcon =
    triggerType === "Event" && protocolIconPath && protocolIconPath.length > 0;

  return (
    <Node
      className={cn(
        "flex h-48 w-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out",
        selected && "border-primary"
      )}
      handles={{ target: false, source: true }}
      nodeId={id}
      status={status}
    >
      {/* Status indicator badge in top right */}
      {status && status !== "idle" && status !== "running" && (
        <div
          className={cn(
            "absolute top-2 right-2 rounded-full p-1",
            status === "success" && "bg-green-500/50",
            status === "error" && "bg-red-500/50"
          )}
        >
          {status === "success" && (
            <Check className="size-3.5 text-white" strokeWidth={2.5} />
          )}
          {status === "error" && (
            <XCircle className="size-3.5 text-white" strokeWidth={2.5} />
          )}
        </div>
      )}

      <div className="flex w-full min-w-0 flex-col items-center justify-center gap-3 p-6">
        {hasProtocolIcon ? (
          <Image
            alt="Protocol"
            className="size-12"
            height={48}
            src={protocolIconPath}
            width={48}
          />
        ) : (
          <TriggerIcon className="size-12 text-blue-500" strokeWidth={1.5} />
        )}
        <NodeLabel description={displayDescription} title={displayTitle} />
      </div>
    </Node>
  );
});

TriggerNode.displayName = "TriggerNode";
