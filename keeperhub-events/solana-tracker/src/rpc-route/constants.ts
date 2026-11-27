/** Who operates an endpoint: KeeperHub, or the organization that added it. */
export const RpcOrigin = {
  PLATFORM: "platform",
  ORG: "org",
} as const;
export type RpcOrigin = (typeof RpcOrigin)[keyof typeof RpcOrigin];

export const RpcTransport = {
  HTTP: "http",
  WSS: "wss",
} as const;
export type RpcTransport = (typeof RpcTransport)[keyof typeof RpcTransport];

export const UsageCounter = {
  REQUESTS: "requests",
  ERRORS: "errors",
  WS_CONNECTS: "wsConnects",
  WS_RECONNECTS: "wsReconnects",
  EVENTS_RECEIVED: "eventsReceived",
} as const;
export type UsageCounter = (typeof UsageCounter)[keyof typeof UsageCounter];

export const RPC_USAGE_INGEST_PATH = "/api/internal/rpc-usage";
export const RPC_USAGE_FLUSH_INTERVAL_MS = 30_000;
export const RPC_USAGE_POST_TIMEOUT_MS = 10_000;
export const RPC_USAGE_MAX_BUCKETS_PER_REQUEST = 1000;
/** Cap on buckets held while the app is unreachable; the oldest go first. */
export const RPC_USAGE_MAX_RETAINED_BUCKETS = 20_000;

/** How long an organization route may take to start before it is torn down. */
export const ROUTE_START_TIMEOUT_MS = 20_000;
