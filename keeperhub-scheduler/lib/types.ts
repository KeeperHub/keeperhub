/**
 * Shared type definitions for keeperhub-scheduler
 *
 * Used by schedule-dispatcher, block-dispatcher, and executor
 */

import type { RpcOrigin, RpcTransport } from "./rpc-route.js";

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

/** One endpoint of an organization route. The url carries credentials. */
export type RpcRouteEndpoint = {
  url: string;
  origin: RpcOrigin;
  configId: string | null;
};

/** Endpoints a workflow listens on when its organization's route differs from KeeperHub's. */
export type RpcRoute = {
  key: string;
  organizationId: string;
  chainId: number;
  transport: RpcTransport;
  primary: RpcRouteEndpoint;
  fallback?: RpcRouteEndpoint;
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
    rpcRoute?: RpcRoute;
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
