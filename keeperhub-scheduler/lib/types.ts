/**
 * Shared type definitions for keeperhub-scheduler
 *
 * Used by schedule-dispatcher, block-dispatcher, and executor
 */

// Schedule types
export type Schedule = {
  id: string;
  workflowId: string;
  cronExpression: string;
  timezone: string;
  // KEEP-575: when intervalSeconds is set, the dispatcher fires on
  // anchorAt + k * intervalSeconds instead of parsing cronExpression.
  // Optional so legacy cron-only payloads stay valid.
  intervalSeconds?: number | null;
  anchorAt?: string | null;
};

export type ScheduleMessage = {
  // Pre-created phantom execution id. The executor upgrades that row to
  // 'pending'; optional for messages enqueued before phantom pre-creation.
  executionId?: string;
  workflowId: string;
  scheduleId: string;
  triggerTime: string;
  triggerType: "schedule";
};

// Block types
export type BlockWorkflow = {
  id: string;
  name: string;
  userId: string;
  organizationId: string | null;
  network: string;
  blockInterval: number;
};

export type ChainConfig = {
  chainId: number;
  name: string;
  defaultPrimaryWss: string | null;
  defaultFallbackWss: string | null;
};

export type BlockMessage = {
  // Pre-created phantom execution id. The executor upgrades that row to
  // 'pending'; optional for messages enqueued before phantom pre-creation.
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

export type FetchBlockWorkflowsResponse = {
  workflows: Array<{
    id: string;
    name: string;
    userId: string;
    organizationId: string | null;
    enabled: boolean;
    nodes: Array<{
      data?: {
        config?: {
          triggerType?: string;
          network?: string;
          blockInterval?: string;
        };
      };
    }>;
  }>;
  networks: Record<
    number,
    {
      chainId: number;
      name: string;
      defaultPrimaryWss: string | null;
      defaultFallbackWss: string | null;
    }
  >;
};

// Union type for executor message routing
export type WorkflowMessage = ScheduleMessage | BlockMessage;

// Executor types
export type Workflow = {
  id: string;
  enabled: boolean;
  userId: string;
  nodes: unknown;
  edges: unknown;
};
