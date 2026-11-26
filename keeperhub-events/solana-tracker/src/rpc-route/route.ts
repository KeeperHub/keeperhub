import type { RouteEndpointSpec, RouteSpec } from "../registrations";
import { RpcOrigin, RpcTransport } from "./constants";
import { isAddressList } from "./pinned-lookup";

const ORIGINS: ReadonlySet<string> = new Set(Object.values(RpcOrigin));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function parseEndpoint(raw: unknown): RouteEndpointSpec | null {
  if (!(isRecord(raw) && isHttpUrl(raw.url))) {
    return null;
  }
  if (typeof raw.origin !== "string" || !ORIGINS.has(raw.origin)) {
    return null;
  }
  const configId = typeof raw.configId === "string" ? raw.configId : null;
  // An organization's endpoint without vetted addresses is never dialled.
  if (raw.origin === RpcOrigin.ORG && !isAddressList(raw.addresses)) {
    return null;
  }
  return {
    url: raw.url,
    origin: raw.origin as RpcOrigin,
    configId,
    ...(raw.origin === RpcOrigin.ORG
      ? { addresses: raw.addresses as string[] }
      : {}),
  };
}

/** Validates a workflow's `rpcRoute`; only HTTP routes are served, the socket derives from the URL. */
export function parseRoute(raw: unknown): RouteSpec | null {
  if (!isRecord(raw)) {
    return null;
  }
  const { key, organizationId, chainId, transport } = raw;
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    typeof organizationId !== "string" ||
    organizationId.length === 0 ||
    typeof chainId !== "number" ||
    !Number.isFinite(chainId) ||
    transport !== RpcTransport.HTTP
  ) {
    return null;
  }
  const primary = parseEndpoint(raw.primary);
  if (!primary) {
    return null;
  }
  const fallback =
    raw.fallback === undefined || raw.fallback === null
      ? undefined
      : parseEndpoint(raw.fallback);
  if (fallback === null) {
    return null;
  }
  return {
    key,
    organizationId,
    chainId,
    transport,
    primary,
    ...(fallback ? { fallback } : {}),
  };
}
