import {
  type RpcEndpoint,
  RpcOrigin,
  type RpcRoute,
  RpcRoutePosition,
} from "../types";
import {
  RpcErrorType,
  type RpcOperationType,
  type RpcTelemetryEvent,
  RpcTelemetryEventType,
  type RpcTelemetrySink,
} from "./sink";
import type { RpcUsageDelta, RpcUsageRecorder } from "./usage";

export type RouteSinkDeps = {
  /** KeeperHub telemetry for this route's chain (Prometheus and logs). */
  platformSink: RpcTelemetrySink;
  /** Organization usage store. */
  recorder: RpcUsageRecorder;
};

const BOTH_POSITIONS: readonly RpcRoutePosition[] = [
  RpcRoutePosition.PRIMARY,
  RpcRoutePosition.FALLBACK,
];

const EVENT_POSITIONS: Record<
  RpcTelemetryEvent["type"],
  readonly RpcRoutePosition[]
> = {
  [RpcTelemetryEventType.FALLBACK_FAILED]: [RpcRoutePosition.FALLBACK],
  [RpcTelemetryEventType.FAILOVER_ACTIVATED]: [RpcRoutePosition.PRIMARY],
  [RpcTelemetryEventType.RECOVERED]: [RpcRoutePosition.PRIMARY],
  [RpcTelemetryEventType.BOTH_FAILED]: BOTH_POSITIONS,
  [RpcTelemetryEventType.CREATED]: BOTH_POSITIONS,
};

/** True when every endpoint in the route is run by KeeperHub. */
export function isPlatformOnlyRoute(route: RpcRoute): boolean {
  return (
    route.primary.origin === RpcOrigin.PLATFORM &&
    (route.fallback?.origin ?? RpcOrigin.PLATFORM) === RpcOrigin.PLATFORM
  );
}

/**
 * Split one route's telemetry by who runs each endpoint.
 *
 * KeeperHub endpoints report to the platform sink. Organization endpoints
 * report nothing there, not a counter and not a log line; their numbers go
 * to the organization's usage store only. When the route is attributed to an
 * organization, KeeperHub endpoints are also counted in that store so the
 * organization sees every call made on its behalf.
 */
export function createRouteSink(
  route: RpcRoute,
  deps: RouteSinkDeps
): RpcTelemetrySink {
  const { platformSink, recorder } = deps;
  const { organizationId } = route;

  if (organizationId === null && isPlatformOnlyRoute(route)) {
    return platformSink;
  }

  const endpointAt = (position: RpcRoutePosition): RpcEndpoint =>
    position === RpcRoutePosition.FALLBACK && route.fallback
      ? route.fallback
      : route.primary;

  const onPlatform = (position: RpcRoutePosition): boolean =>
    endpointAt(position).origin === RpcOrigin.PLATFORM;

  const allOnPlatform = (positions: readonly RpcRoutePosition[]): boolean =>
    positions.every(onPlatform);

  const usage = (position: RpcRoutePosition, delta: RpcUsageDelta): void => {
    if (organizationId === null) {
      return;
    }
    const endpoint = endpointAt(position);
    recorder.record(
      {
        organizationId,
        configId: endpoint.configId,
        origin: endpoint.origin,
        chainId: route.chain.chainId,
        transport: endpoint.transport,
      },
      delta
    );
  };

  return {
    attempt(position: RpcRoutePosition, operation: RpcOperationType): void {
      if (onPlatform(position)) {
        platformSink.attempt(position, operation);
      }
      usage(position, { requests: 1 });
    },
    failure(position: RpcRoutePosition, operation: RpcOperationType): void {
      if (onPlatform(position)) {
        platformSink.failure(position, operation);
      }
      usage(position, { errors: 1 });
    },
    success(position: RpcRoutePosition, operation: RpcOperationType): void {
      if (onPlatform(position)) {
        platformSink.success(position, operation);
      }
    },
    latency(
      position: RpcRoutePosition,
      durationMs: number,
      operation: RpcOperationType
    ): void {
      if (onPlatform(position)) {
        platformSink.latency(position, durationMs, operation);
      }
      usage(position, { latencyMsSum: durationMs, latencyMsMax: durationMs });
    },
    errorType(
      position: RpcRoutePosition,
      errorType: RpcErrorType,
      operation: RpcOperationType
    ): void {
      if (onPlatform(position)) {
        platformSink.errorType(position, errorType, operation);
      }
      if (errorType === RpcErrorType.TIMEOUT) {
        usage(position, { timeouts: 1 });
      } else if (errorType === RpcErrorType.RATE_LIMIT) {
        usage(position, { rateLimited: 1 });
      }
    },
    failover(): void {
      if (onPlatform(RpcRoutePosition.PRIMARY)) {
        platformSink.failover();
      }
      usage(RpcRoutePosition.PRIMARY, { failovers: 1 });
    },
    recovery(): void {
      if (onPlatform(RpcRoutePosition.PRIMARY)) {
        platformSink.recovery();
      }
    },
    bothFailed(): void {
      if (allOnPlatform(BOTH_POSITIONS)) {
        platformSink.bothFailed();
      }
    },
    event(event: RpcTelemetryEvent): void {
      if (allOnPlatform(EVENT_POSITIONS[event.type])) {
        platformSink.event(event);
      }
    },
  };
}
