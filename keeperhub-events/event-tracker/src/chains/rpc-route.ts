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

/** Usage counters the app's ingest endpoint accepts from this service. */
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

export interface RpcRouteEndpoint {
  url: string;
  origin: RpcOrigin;
  configId: string | null;
}

/**
 * The endpoints an organization's trigger listens on when its route differs
 * from KeeperHub's. The URLs carry credentials and never reach a log line.
 */
export interface RpcRoute {
  key: string;
  organizationId: string;
  chainId: number;
  transport: RpcTransport;
  primary: RpcRouteEndpoint;
  fallback?: RpcRouteEndpoint;
}

const ORIGINS: readonly string[] = Object.values(RpcOrigin);
const TRANSPORTS: readonly string[] = Object.values(RpcTransport);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEndpoint(value: unknown): RpcRouteEndpoint | null {
  if (!isRecord(value)) {
    return null;
  }
  const { url, origin, configId } = value;
  if (typeof url !== "string" || url.length === 0) {
    return null;
  }
  if (typeof origin !== "string" || !ORIGINS.includes(origin)) {
    return null;
  }
  if (
    configId !== null &&
    configId !== undefined &&
    typeof configId !== "string"
  ) {
    return null;
  }
  return {
    url,
    origin: origin as RpcOrigin,
    configId: typeof configId === "string" ? configId : null,
  };
}

/** Parse the API's `rpcRoute` field, returning null for any malformed shape. */
export function parseRpcRoute(value: unknown): RpcRoute | null {
  if (!isRecord(value)) {
    return null;
  }
  const { key, organizationId, chainId, transport } = value;
  if (typeof key !== "string" || key.length === 0) {
    return null;
  }
  if (typeof organizationId !== "string" || organizationId.length === 0) {
    return null;
  }
  if (typeof chainId !== "number" || !Number.isFinite(chainId)) {
    return null;
  }
  if (typeof transport !== "string" || !TRANSPORTS.includes(transport)) {
    return null;
  }
  const primary = parseEndpoint(value.primary);
  if (!primary) {
    return null;
  }
  let fallback: RpcRouteEndpoint | undefined;
  if (value.fallback !== undefined && value.fallback !== null) {
    const parsed = parseEndpoint(value.fallback);
    if (!parsed) {
      return null;
    }
    fallback = parsed;
  }
  return {
    key,
    organizationId,
    chainId,
    transport: transport as RpcTransport,
    primary,
    fallback,
  };
}

export function isWebSocketUrl(url: string): boolean {
  return url.startsWith("wss://") || url.startsWith("ws://");
}
