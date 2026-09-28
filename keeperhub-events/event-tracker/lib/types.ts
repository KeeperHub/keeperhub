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
  createdAt: string;
  updatedAt: string;
}

export type NetworksMap = Record<number, NetworkConfig>;

/**
 * The loose shape of a workflow as returned by the KeeperHub API's
 * `/api/workflows/events?active=true` endpoint. Kept intentionally
 * permissive on every field except `id` and `nodes` - those are the
 * minimum required for any downstream code to do useful work. Other
 * fields are typed optionally so the type system does not lie: a
 * malformed API response can still compile and will be caught by the
 * defensive parsing in `workflow-mapper.ts::buildRegistration`.
 */
export interface RawWorkflowNodeConfig {
  network?: string;
  eventName?: string;
  contractABI?: string;
  triggerType?: string;
  contractAddress?: string;
  // Transfer trigger: the watched deposit address and an optional
  // memo filter, applied as post-decode predicates in the listener.
  recipientAddress?: string;
  memo?: string;
  // State-threshold trigger (issue #2240). Present only when
  // `triggerType === "stateThreshold"`; the field names mirror the existing
  // `web3/read-contract` node config so the builder does not have to invent a
  // second vocabulary for naming a view call.
  /** View function to call, by name, resolved against `contractABI`. */
  abiFunction?: string;
  /** Arguments for that function, in declaration order. */
  functionArgs?: unknown[];
  /** Which output to compare: an index into the outputs, or an output name. */
  outputPath?: string | number;
  /** "lt" | "lte" | "gt" | "gte". Validated in the mapper. */
  comparator?: string;
  /** Decimal string, scaled by `decimals` into the comparable integer. */
  threshold?: string | number;
  /** Fixed-point scale of the read value. Defaults to 0 (raw integer). */
  decimals?: number;
  /** Re-arm band width, same units as `threshold`. Defaults to 2% of it. */
  hysteresis?: string | number;
  /** Optional floor on blocks between two dispatches. */
  minBlocksBetweenFires?: number;
}

export interface RawWorkflowNode {
  id?: string;
  type?: string;
  selected?: boolean;
  data?: {
    type?: string;
    label?: string;
    config?: RawWorkflowNodeConfig;
    status?: string;
    description?: string;
  };
}

export interface RawWorkflow {
  id?: string;
  nodes?: RawWorkflowNode[];
  name?: string;
  userId?: string;
  organizationId?: string;
  enabled?: boolean;
}

export interface SyncData {
  workflows: RawWorkflow[];
  networks: NetworksMap;
}
