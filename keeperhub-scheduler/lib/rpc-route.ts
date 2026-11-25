/**
 * Protocol values shared with the app for organization RPC routes and the
 * usage they report. Keep in sync with the app's lib/rpc/engine/types.ts.
 */

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

/** Which endpoint of a route a monitor is talking to. */
export const RpcEndpointRole = {
  PRIMARY: "primary",
  FALLBACK: "fallback",
} as const;
export type RpcEndpointRole =
  (typeof RpcEndpointRole)[keyof typeof RpcEndpointRole];

export const RpcUsageCounter = {
  REQUESTS: "requests",
  ERRORS: "errors",
  WS_CONNECTS: "wsConnects",
  WS_RECONNECTS: "wsReconnects",
  EVENTS_RECEIVED: "eventsReceived",
} as const;
export type RpcUsageCounter =
  (typeof RpcUsageCounter)[keyof typeof RpcUsageCounter];

export const RPC_USAGE_INGEST_PATH = "/api/internal/rpc-usage";
export const RPC_USAGE_FLUSH_INTERVAL_MS = 30_000;
export const RPC_USAGE_MAX_BUCKETS_PER_REQUEST = 1000;
export const RPC_USAGE_MAX_RETAINED_BUCKETS = 10_000;
