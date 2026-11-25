import "server-only";

import { createRpcEngine, type RpcEngine } from "./engine";
import { createDbOrgRpcSource } from "./sources/db-org-source";
import { createDbPlatformRpcSource } from "./sources/platform-source";
import {
  getEvmMetricsCollector,
  getFailoverCallback,
  getSolanaMetricsCollector,
} from "./telemetry/platform-collectors";
import { RpcUsageAccumulator } from "./telemetry/usage";

/** KeeperHub's endpoints per chain, shared by the engine and the org checks. */
export const platformRpcSource = createDbPlatformRpcSource();

/** Organization configs and policy, shared so a write can invalidate them. */
export const orgRpcSource = createDbOrgRpcSource();

/** Organization usage recorded by this process, drained by the usage store. */
export const rpcUsageAccumulator = new RpcUsageAccumulator();

let engine: RpcEngine | undefined;

export function getRpcEngine(): RpcEngine {
  engine ??= createRpcEngine({
    platformSource: platformRpcSource,
    orgSource: orgRpcSource,
    usageRecorder: rpcUsageAccumulator,
    evmCollector: getEvmMetricsCollector,
    solanaCollector: getSolanaMetricsCollector,
    failoverCallback: getFailoverCallback,
  });
  return engine;
}
