import type { RpcMetricsCollector } from "../../providers";
import { RpcRoutePosition } from "../types";
import { RpcOperationType, type RpcTelemetrySink } from "./sink";

/**
 * Present a route's sink through the older collector shape, for code that
 * records metrics around a manager by hand. The chain argument is ignored:
 * the sink is already bound to its route, so the gate still applies.
 */
export function collectorFromSink(sink: RpcTelemetrySink): RpcMetricsCollector {
  return {
    recordPrimaryAttempt: (_chain: string, operation?: RpcOperationType) =>
      sink.attempt(
        RpcRoutePosition.PRIMARY,
        operation ?? RpcOperationType.READ
      ),
    recordPrimaryFailure: (_chain: string, operation?: RpcOperationType) =>
      sink.failure(
        RpcRoutePosition.PRIMARY,
        operation ?? RpcOperationType.READ
      ),
    recordFallbackAttempt: (_chain: string, operation?: RpcOperationType) =>
      sink.attempt(
        RpcRoutePosition.FALLBACK,
        operation ?? RpcOperationType.READ
      ),
    recordFallbackFailure: (_chain: string, operation?: RpcOperationType) =>
      sink.failure(
        RpcRoutePosition.FALLBACK,
        operation ?? RpcOperationType.READ
      ),
    recordFailoverEvent: () => sink.failover(),
    recordRecoveryEvent: () => sink.recovery(),
    recordBothFailed: () => sink.bothFailed(),
    recordSuccess: (_chain, provider, operation) =>
      sink.success(provider, operation ?? RpcOperationType.READ),
    recordLatency: (_chain, provider, durationMs, operation) =>
      sink.latency(provider, durationMs, operation ?? RpcOperationType.READ),
    recordErrorType: (_chain, provider, errorType, operation) =>
      sink.errorType(provider, errorType, operation ?? RpcOperationType.READ),
  };
}
