import type { RpcRoutePosition } from "../types";

export const RpcErrorType = {
  TIMEOUT: "timeout",
  RATE_LIMIT: "rate_limit",
  CONNECTION: "connection",
  RPC_ERROR: "rpc_error",
} as const;
export type RpcErrorType = (typeof RpcErrorType)[keyof typeof RpcErrorType];

export const RpcOperationType = {
  READ: "read",
  WRITE: "write",
  PREFLIGHT: "preflight",
  WRITE_BROADCAST: "write-broadcast",
} as const;
export type RpcOperationType =
  (typeof RpcOperationType)[keyof typeof RpcOperationType];

export const RpcTelemetryEventType = {
  FALLBACK_FAILED: "fallback-failed",
  FAILOVER_ACTIVATED: "failover-activated",
  RECOVERED: "recovered",
  BOTH_FAILED: "both-failed",
  CREATED: "created",
} as const;
export type RpcTelemetryEventType =
  (typeof RpcTelemetryEventType)[keyof typeof RpcTelemetryEventType];

/** Lifecycle events a provider manager reports besides per-call counters. */
export type RpcTelemetryEvent =
  | { type: typeof RpcTelemetryEventType.FALLBACK_FAILED; error: string }
  | { type: typeof RpcTelemetryEventType.FAILOVER_ACTIVATED; error: string }
  | { type: typeof RpcTelemetryEventType.RECOVERED }
  | { type: typeof RpcTelemetryEventType.BOTH_FAILED; detail: string }
  | { type: typeof RpcTelemetryEventType.CREATED; hasFallback: boolean };

/**
 * Everything a provider manager reports, for one route. The manager never
 * decides where telemetry goes: the sink it was built with does. That is the
 * single gate that keeps organization endpoints out of Grafana.
 */
export type RpcTelemetrySink = {
  attempt(position: RpcRoutePosition, operation: RpcOperationType): void;
  failure(position: RpcRoutePosition, operation: RpcOperationType): void;
  success(position: RpcRoutePosition, operation: RpcOperationType): void;
  latency(
    position: RpcRoutePosition,
    durationMs: number,
    operation: RpcOperationType
  ): void;
  errorType(
    position: RpcRoutePosition,
    errorType: RpcErrorType,
    operation: RpcOperationType
  ): void;
  failover(): void;
  recovery(): void;
  bothFailed(): void;
  event(event: RpcTelemetryEvent): void;
};
