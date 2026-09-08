import type { WorkflowNode } from "../lib/workflow/store";

export type ScheduleMessage = {
  /**
   * Pre-created phantom execution id. When present, the executor upgrades that
   * 'phantom' row to 'pending' instead of inserting a fresh row. Optional for
   * backward compatibility with messages enqueued before phantom pre-creation.
   */
  executionId?: string;
  workflowId: string;
  scheduleId: string;
  triggerTime: string;
  triggerType: "schedule";
};

export type BlockMessage = {
  // Pre-created phantom execution id (see ScheduleMessage).
  executionId?: string;
  workflowId: string;
  userId: string;
  triggerType: "block";
  triggerData: {
    blockNumber: number;
    blockHash: string;
    blockTimestamp: number;
    parentHash: string;
  };
};

export type EventMessage = {
  // Pre-created phantom execution id (see ScheduleMessage).
  executionId?: string;
  workflowId: string;
  userId: string;
  triggerType: "event";
  triggerData: {
    contractAddress?: string;
    eventName?: string;
    transactionHash?: string;
    blockNumber?: number;
    args?: Record<string, unknown>;
    [key: string]: unknown;
  };
};

export type ManualMessage = {
  // Always present: the API pre-creates this row as 'pending' before enqueueing.
  executionId: string;
  workflowId: string;
  userId: string;
  organizationId?: string;
  triggerType: "manual" | "webhook";
  input: Record<string, unknown>;
};

export type ExecutorMessage =
  | ScheduleMessage
  | BlockMessage
  | EventMessage
  | ManualMessage;

export type DispatchTarget = "k8s-job" | "in-process" | "api";

export type WorkflowRecord = {
  id: string;
  name: string | null;
  enabled: boolean | null;
  userId: string;
  organizationId: string | null;
  nodes: WorkflowNode[];
  edges: unknown[];
};
