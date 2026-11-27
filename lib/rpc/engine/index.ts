import "server-only";

import type {
  EvmRpcClient,
  RouteRequest,
  RpcEngine,
  SolanaRpcClient,
} from "./engine";
import { getRpcEngine } from "./runtime";
import { type RpcRoute, type RpcScope, RpcScopeKind } from "./types";

export type {
  EvmRpcClient,
  RouteRequest,
  RpcClientTuning,
  RpcEngine,
  RpcEngineDeps,
  SolanaRpcClient,
} from "./engine";
export { createRpcEngine } from "./engine";
export {
  isOrgSettingRouteError,
  RpcRouteError,
  RpcRouteErrorCode,
} from "./route-error";
export { orgRpcSource, rpcUsageAccumulator } from "./runtime";
export {
  orgScope,
  parseRpcSelection,
  platformScope,
  RPC_SELECTION_CONFIG_KEY,
  type RpcStepInput,
  rpcScopeForOrganization,
  rpcScopeFromStep,
  rpcSelectionValue,
  scopeForManyChains,
} from "./scope";
export { SecretUrl } from "./secret-url";
export { builderRpcUrlsFor } from "./sources/platform-source";
export { isPlatformOnlyRoute } from "./telemetry/route-sink";
export {
  RpcErrorType,
  RpcOperationType,
  RpcTelemetryEventType,
} from "./telemetry/sink";
export * from "./types";

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

/**
 * The organization's scope when its calls on this chain must stay on its own
 * endpoints, or null when a caller may use a shared read on KeeperHub's.
 */
export async function ownEndpointsScope(
  scope: RpcScope | undefined,
  chainId: number
): Promise<RpcScope | null> {
  if (scope?.kind !== RpcScopeKind.ORG) {
    return null;
  }
  const route = await getRpcEngine().route(scope, chainId);
  return route.ownRpcOnly ? scope : null;
}
