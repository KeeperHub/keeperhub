import {
  ErrorCategory,
  logSystemError,
  logSystemWarn,
  logUserError,
} from "@/lib/logging";
import type { RpcMetricsCollector } from "../../providers";
import { RpcChainType, RpcRoutePosition } from "../types";
import {
  type RpcErrorType,
  type RpcOperationType,
  type RpcTelemetryEvent,
  RpcTelemetryEventType,
  type RpcTelemetrySink,
} from "./sink";

export type PlatformSinkOptions = {
  family: RpcChainType;
  chainName: string;
  collector: RpcMetricsCollector;
};

type LogFn = (
  category: ErrorCategory,
  message: string,
  error: unknown,
  labels: Record<string, string>
) => void;

/** The log line shapes each client family has always emitted. */
type FamilyLogSpec = {
  prefix: string;
  managerName: string;
  /** Served failover and fallback loss: not an outage yet. */
  degraded: LogFn;
  /** Both endpoints exhausted. */
  exhausted: LogFn;
  events: {
    fallbackFailed: string;
    failoverActivated: string;
    recovered: string;
    bothFailed: string;
    created: string;
  };
};

/**
 * Log functions are wrapped rather than referenced so they are looked up at
 * call time, not when this module loads.
 *
 * EVM endpoints are KeeperHub-run, so an exhausted round is a platform fault
 * (error level, system-error metric) and a served failover is a warning.
 * Solana has always reported both as user-level errors.
 */
const FAMILY_LOGS: Record<RpcChainType, FamilyLogSpec> = {
  [RpcChainType.EVM]: {
    prefix: "[RPC]",
    managerName: "RPC provider manager",
    degraded: (...args) => logSystemWarn(...args),
    exhausted: (...args) => logSystemError(...args),
    events: {
      fallbackFailed: "RPC_FALLBACK_FAILED",
      failoverActivated: "RPC_FAILOVER_ACTIVATED",
      recovered: "RPC_FAILOVER_RECOVERY",
      bothFailed: "RPC_BOTH_ENDPOINTS_FAILED",
      created: "RPC_PROVIDER_CREATED",
    },
  },
  [RpcChainType.SOLANA]: {
    prefix: "[Solana RPC]",
    managerName: "Solana RPC provider manager",
    degraded: (...args) => logUserError(...args),
    exhausted: (...args) => logUserError(...args),
    events: {
      fallbackFailed: "SOLANA_RPC_FALLBACK_FAILED",
      failoverActivated: "SOLANA_RPC_FAILOVER_ACTIVATED",
      recovered: "SOLANA_RPC_FAILOVER_RECOVERY",
      bothFailed: "SOLANA_RPC_BOTH_ENDPOINTS_FAILED",
      created: "SOLANA_RPC_PROVIDER_CREATED",
    },
  },
};

const INFO_LEVEL = "info";

function logInfoLine(fields: Record<string, string | boolean>): void {
  console.info(
    JSON.stringify({
      level: INFO_LEVEL,
      ...fields,
      timestamp: new Date().toISOString(),
    })
  );
}

function emitEvent(
  spec: FamilyLogSpec,
  chain: string,
  event: RpcTelemetryEvent
): void {
  switch (event.type) {
    case RpcTelemetryEventType.FALLBACK_FAILED:
      spec.degraded(
        ErrorCategory.NETWORK_RPC,
        `${spec.prefix} Fallback RPC failed for ${chain}, attempting primary recovery`,
        event.error,
        { event: spec.events.fallbackFailed, chain }
      );
      return;
    case RpcTelemetryEventType.FAILOVER_ACTIVATED:
      spec.degraded(
        ErrorCategory.NETWORK_RPC,
        `${spec.prefix} Primary RPC failed for ${chain}, switching to fallback`,
        event.error,
        {
          event: spec.events.failoverActivated,
          chain,
          previous_state: RpcRoutePosition.PRIMARY,
          new_state: RpcRoutePosition.FALLBACK,
        }
      );
      return;
    case RpcTelemetryEventType.RECOVERED:
      logInfoLine({
        event: spec.events.recovered,
        message: `Primary RPC recovered for ${chain}, switching back from fallback`,
        chain,
        previousState: RpcRoutePosition.FALLBACK,
        newState: RpcRoutePosition.PRIMARY,
      });
      return;
    case RpcTelemetryEventType.BOTH_FAILED:
      spec.exhausted(
        ErrorCategory.NETWORK_RPC,
        `${spec.prefix} Both primary and fallback RPC failed for ${chain}`,
        event.detail,
        { event: spec.events.bothFailed, chain }
      );
      return;
    case RpcTelemetryEventType.CREATED:
      logInfoLine({
        event: spec.events.created,
        message: `Created ${spec.managerName} for ${chain}`,
        chain,
        hasFallback: event.hasFallback,
      });
      return;
    default:
      return;
  }
}

/**
 * Telemetry for endpoints KeeperHub runs: the `keeperhub_rpc_*` series and
 * the structured logs Grafana reads. Never used for an organization endpoint.
 */
export function createPlatformSink(
  options: PlatformSinkOptions
): RpcTelemetrySink {
  const { chainName: chain, collector } = options;
  const spec = FAMILY_LOGS[options.family];
  return {
    attempt(position: RpcRoutePosition, operation: RpcOperationType): void {
      if (position === RpcRoutePosition.PRIMARY) {
        collector.recordPrimaryAttempt(chain, operation);
      } else {
        collector.recordFallbackAttempt(chain, operation);
      }
    },
    failure(position: RpcRoutePosition, operation: RpcOperationType): void {
      if (position === RpcRoutePosition.PRIMARY) {
        collector.recordPrimaryFailure(chain, operation);
      } else {
        collector.recordFallbackFailure(chain, operation);
      }
    },
    success(position: RpcRoutePosition, operation: RpcOperationType): void {
      collector.recordSuccess(chain, position, operation);
    },
    latency(
      position: RpcRoutePosition,
      durationMs: number,
      operation: RpcOperationType
    ): void {
      collector.recordLatency(chain, position, durationMs, operation);
    },
    errorType(
      position: RpcRoutePosition,
      errorType: RpcErrorType,
      operation: RpcOperationType
    ): void {
      collector.recordErrorType(chain, position, errorType, operation);
    },
    failover(): void {
      collector.recordFailoverEvent(chain);
    },
    recovery(): void {
      collector.recordRecoveryEvent(chain);
    },
    bothFailed(): void {
      collector.recordBothFailed(chain);
    },
    event(event: RpcTelemetryEvent): void {
      emitEvent(spec, chain, event);
    },
  };
}
