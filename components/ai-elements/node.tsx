import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Handle, Position } from "@xyflow/react";
import type { ComponentProps } from "react";
import { AnimatedBorder } from "@/components/ui/animated-border";
import { AddStepButton } from "@/components/workflow/add-step-button";

export type SourceHandleConfig = {
  id: string;
  label: string;
  topPercent: number;
};

export type NodeProps = ComponentProps<typeof Card> & {
  handles: {
    target: boolean;
    source: boolean;
    sourceHandles?: SourceHandleConfig[];
  };
  status?: "idle" | "running" | "success" | "error";
  nodeId?: string;
};

export const Node = ({ handles, className, status, nodeId, ...props }: NodeProps) => (
  <Card
    className={cn(
      "node-container relative size-full h-auto w-sm gap-0 rounded-md bg-card p-0 transition-all duration-200",
      status === "success" && "border-green-500 border-2",
      status === "error" && "border-red-500 border-2",
      className
    )}
    {...props}
  >
    {status === "running" && <AnimatedBorder />}
    {handles.target && <Handle position={Position.Left} type="target" />}
    {handles.sourceHandles ? (
      <>
        {handles.sourceHandles.map((h) => (
          <Handle
            id={h.id}
            key={h.id}
            position={Position.Right}
            style={{ top: `${h.topPercent}%` }}
            type="source"
          />
        ))}
        {handles.sourceHandles.map((h) => (
          <span
            className="pointer-events-none absolute text-[10px] text-muted-foreground"
            key={`label-${h.id}`}
            style={{
              right: 16,
              top: `${h.topPercent}%`,
              transform: "translateY(-50%)",
            }}
          >
            {h.label}
          </span>
        ))}
        {nodeId &&
          handles.sourceHandles.map((h) => (
            <AddStepButton
              key={`btn-${h.id}`}
              offsetTopPercent={h.topPercent}
              sourceHandleId={h.id}
              sourceNodeId={nodeId}
            />
          ))}
      </>
    ) : (
      <>
        {handles.source && <Handle position={Position.Right} type="source" />}
        {handles.source && nodeId && <AddStepButton sourceNodeId={nodeId} />}
      </>
    )}
    {props.children}
  </Card>
);

export type NodeHeaderProps = ComponentProps<typeof CardHeader>;

export const NodeHeader = ({ className, ...props }: NodeHeaderProps) => (
  <CardHeader
    className={cn("gap-0.5 rounded-t-md border-b bg-secondary p-3!", className)}
    {...props}
  />
);

export type NodeTitleProps = ComponentProps<typeof CardTitle>;

export const NodeTitle = (props: NodeTitleProps) => <CardTitle {...props} />;

export type NodeDescriptionProps = ComponentProps<typeof CardDescription>;

export const NodeDescription = (props: NodeDescriptionProps) => (
  <CardDescription {...props} />
);

export type NodeActionProps = ComponentProps<typeof CardAction>;

export const NodeAction = (props: NodeActionProps) => <CardAction {...props} />;

export type NodeContentProps = ComponentProps<typeof CardContent>;

export const NodeContent = ({ className, ...props }: NodeContentProps) => (
  <CardContent className={cn("rounded-b-md bg-card p-3", className)} {...props} />
);

export type NodeFooterProps = ComponentProps<typeof CardFooter>;

export const NodeFooter = ({ className, ...props }: NodeFooterProps) => (
  <CardFooter
    className={cn("rounded-b-md border-t bg-secondary p-3!", className)}
    {...props}
  />
);
