/**
 * Shapes returned by the KeeperHub discovery endpoints, kept intentionally
 * permissive: the API responses are not runtime-validated, so the defensive
 * per-field checks in the workflow mappers are load-bearing. Both the event
 * (`/api/workflows/events`) and block (`/api/internal/block-workflows`)
 * endpoints return the same envelope: a list of workflows (each reduced to its
 * trigger node) plus a `networks` map keyed by chainId.
 */

export interface NetworkConfig {
  id: string;
  chainId: number;
  name: string;
  symbol: string;
  chainType: string;
  defaultPrimaryRpc: string;
  defaultFallbackRpc: string;
  defaultPrimaryWss: string;
  defaultFallbackWss: string;
  isTestnet: boolean;
  isEnabled: boolean;
}

export type NetworksMap = Record<number, NetworkConfig>;

export interface RawTriggerConfig {
  triggerType?: string;
  network?: string;
  // Solana event trigger
  programId?: string;
  idl?: string;
  eventName?: string;
  commitment?: string;
  // Block trigger
  blockInterval?: string;
}

export interface RawWorkflowNode {
  id?: string;
  type?: string;
  data?: {
    type?: string;
    label?: string;
    config?: RawTriggerConfig;
  };
}

export interface RawWorkflow {
  id?: string;
  name?: string;
  userId?: string;
  organizationId?: string;
  enabled?: boolean;
  nodes?: RawWorkflowNode[];
}

/** Raw envelope from either discovery endpoint. */
export interface DiscoveryResponse {
  workflows: RawWorkflow[];
  networks: NetworksMap;
}

/** Combined Solana discovery payload consumed by the reconciler. */
export interface DiscoveryData {
  eventWorkflows: RawWorkflow[];
  blockWorkflows: RawWorkflow[];
  networks: NetworksMap;
}
