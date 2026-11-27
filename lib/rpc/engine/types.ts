import {
  RPC_ENDPOINT,
  type RpcEndpoint as RpcEndpointPosition,
} from "../rpc-endpoint";
import type { SecretUrl } from "./secret-url";

/** How an endpoint is reached. */
export const RpcTransport = {
  HTTP: "http",
  WSS: "wss",
} as const;
export type RpcTransport = (typeof RpcTransport)[keyof typeof RpcTransport];

/** Who operates an endpoint: KeeperHub, or the organization that added it. */
export const RpcOrigin = {
  PLATFORM: "platform",
  ORG: "org",
} as const;
export type RpcOrigin = (typeof RpcOrigin)[keyof typeof RpcOrigin];

/** The role an endpoint plays inside its config. */
export const RpcEndpointRole = {
  PRIMARY: "primary",
  FALLBACK: "fallback",
  PRIVATE: "private",
} as const;
export type RpcEndpointRole =
  (typeof RpcEndpointRole)[keyof typeof RpcEndpointRole];

/** Where an endpoint sits in a resolved route; failover goes primary to fallback. */
export const RpcRoutePosition = RPC_ENDPOINT;
export type RpcRoutePosition = RpcEndpointPosition;

export const RpcChainType = {
  EVM: "evm",
  SOLANA: "solana",
} as const;
export type RpcChainType = (typeof RpcChainType)[keyof typeof RpcChainType];

/** Which endpoints a node or request asked for. */
export const RpcSelectionMode = {
  AUTO: "auto",
  PLATFORM: "platform",
  CONFIG: "config",
} as const;
export type RpcSelectionMode =
  (typeof RpcSelectionMode)[keyof typeof RpcSelectionMode];

/**
 * KeeperHub traffic that is not done on behalf of an organization's own
 * workflow. Closed on purpose: a new platform use has to be named here.
 */
export const PlatformRpcPurpose = {
  BILLING: "billing",
  PAYMENTS: "payments",
  AGENTIC_WALLET: "agentic-wallet",
  PUBLIC_TOOL: "public-tool",
  NO_ORGANIZATION: "no-organization",
  /** Reads whose result is cached for every organization, such as an ABI. */
  SHARED_CACHE: "shared-cache",
} as const;
export type PlatformRpcPurpose =
  (typeof PlatformRpcPurpose)[keyof typeof PlatformRpcPurpose];

export const RpcScopeKind = {
  ORG: "org",
  PLATFORM: "platform",
} as const;
export type RpcScopeKind = (typeof RpcScopeKind)[keyof typeof RpcScopeKind];

/**
 * What the caller will do with the route. `SUBSCRIBE` is a long-lived
 * listener: WebSocket on EVM chains, HTTP polling on Solana.
 */
export const RpcPurpose = {
  READ: "read",
  WRITE: "write",
  SUBSCRIBE: "subscribe",
} as const;
export type RpcPurpose = (typeof RpcPurpose)[keyof typeof RpcPurpose];

export const RpcRouteNotice = {
  PRIVATE_MEMPOOL_UNSUPPORTED: "private-mempool-unsupported",
} as const;
export type RpcRouteNotice =
  (typeof RpcRouteNotice)[keyof typeof RpcRouteNotice];

export type RpcChain = {
  chainId: number;
  name: string;
  chainType: RpcChainType;
  isEnabled: boolean;
};

/** KeeperHub's endpoints for one chain. */
export type PlatformEndpoints = {
  httpPrimary: SecretUrl;
  httpFallback?: SecretUrl;
  wssPrimary?: SecretUrl;
  wssFallback?: SecretUrl;
  /** Set only when the chain routes private-mempool writes through a relay. */
  privateTx?: SecretUrl;
};

/** An organization's endpoints for one chain. */
export type OrgRpcConfig = {
  id: string;
  name: string;
  chainId: number;
  enabled: boolean;
  isDefault: boolean;
  httpPrimary: SecretUrl;
  httpFallback?: SecretUrl;
  wssPrimary?: SecretUrl;
  wssFallback?: SecretUrl;
  privateTx?: SecretUrl;
};

export type OrgRpcPolicy = {
  /** Never route this organization's traffic through KeeperHub endpoints. */
  ownRpcOnly: boolean;
};

export type OrgRpcState = {
  policy: OrgRpcPolicy;
  configs: readonly OrgRpcConfig[];
};

export type RpcSelection =
  | { mode: typeof RpcSelectionMode.AUTO }
  | { mode: typeof RpcSelectionMode.PLATFORM }
  | { mode: typeof RpcSelectionMode.CONFIG; configId: string };

export type OrgRpcScope = {
  kind: typeof RpcScopeKind.ORG;
  organizationId: string;
  workflowId?: string;
  executionId?: string;
  nodeId?: string;
  selection: RpcSelection;
};

export type PlatformRpcScope = {
  kind: typeof RpcScopeKind.PLATFORM;
  purpose: PlatformRpcPurpose;
};

export type RpcScope = OrgRpcScope | PlatformRpcScope;

export type PrivateMempoolRequest = {
  /** When true a failing private endpoint never falls back to a public one. */
  strict: boolean;
};

export type RpcEndpoint = {
  origin: RpcOrigin;
  role: RpcEndpointRole;
  transport: RpcTransport;
  url: SecretUrl;
  configId: string | null;
  configName: string | null;
};

export type RpcRoute = {
  /** Identity of this route; stable across calls, safe to log. */
  key: string;
  chain: RpcChain;
  transport: RpcTransport;
  primary: RpcEndpoint;
  fallback?: RpcEndpoint;
  /** The organization the traffic is attributed to, null for platform scopes. */
  organizationId: string | null;
  ownRpcOnly: boolean;
  notices: readonly RpcRouteNotice[];
};
