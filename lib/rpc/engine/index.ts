import "server-only";

import {
  createRpcEngine,
  type EvmRpcClient,
  type RouteRequest,
  type RpcEngine,
  type SolanaRpcClient,
} from "./engine";
import { emptyOrgRpcSource } from "./sources/org-source";
import { createDbPlatformRpcSource } from "./sources/platform-source";
import {
  getEvmMetricsCollector,
  getFailoverCallback,
  getSolanaMetricsCollector,
} from "./telemetry/platform-collectors";
import { RpcUsageAccumulator } from "./telemetry/usage";
import type { RpcRoute, RpcScope } from "./types";

export type {
  EvmRpcClient,
  RouteRequest,
  RpcEngine,
  RpcEngineDeps,
  SolanaRpcClient,
} from "./engine";
export { createRpcEngine } from "./engine";
export { RpcRouteError, RpcRouteErrorCode } from "./route-error";
export {
  orgScope,
  parseRpcSelection,
  platformScope,
  RPC_SELECTION_CONFIG_KEY,
  rpcScopeFromStep,
} from "./scope";
export { SecretUrl } from "./secret-url";
export {
  RpcErrorType,
  RpcOperationType,
  RpcTelemetryEventType,
} from "./telemetry/sink";
export * from "./types";

/** Organization usage recorded by this process, drained by the usage store. */
export const rpcUsageAccumulator = new RpcUsageAccumulator();

let engine: RpcEngine | undefined;

function getRpcEngine(): RpcEngine {
  engine ??= createRpcEngine({
    platformSource: createDbPlatformRpcSource(),
    orgSource: emptyOrgRpcSource,
    usageRecorder: rpcUsageAccumulator,
    evmCollector: getEvmMetricsCollector,
    solanaCollector: getSolanaMetricsCollector,
    failoverCallback: getFailoverCallback,
  });
  return engine;
}

/**
 * The single entry point for RPC access. Every call names its scope, so
 * KeeperHub's own traffic and traffic on behalf of an organization can never
 * be confused.
 */
export const rpc: RpcEngine = {
  route: (
    scope: RpcScope,
    chainId: number,
    request?: RouteRequest
  ): Promise<RpcRoute> => getRpcEngine().route(scope, chainId, request),
  evm: (
    scope: RpcScope,
    chainId: number,
    request?: RouteRequest
  ): Promise<EvmRpcClient> => getRpcEngine().evm(scope, chainId, request),
  solana: (
    scope: RpcScope,
    chainId: number,
    request?: RouteRequest
  ): Promise<SolanaRpcClient> => getRpcEngine().solana(scope, chainId, request),
};
