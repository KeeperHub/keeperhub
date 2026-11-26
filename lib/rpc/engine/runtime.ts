import "server-only";

import { createRpcEngine, type RpcEngine } from "./engine";
import { processSingleton } from "./process-singleton";
import { createDbOrgRpcSource } from "./sources/db-org-source";
import { createDbPlatformRpcSource } from "./sources/platform-source";
import {
  getEvmMetricsCollector,
  getFailoverCallback,
  getSolanaMetricsCollector,
} from "./telemetry/platform-collectors";
import { RpcUsageAccumulator } from "./telemetry/usage";

/** KeeperHub's endpoints per chain, shared by the engine and the org checks. */
export const platformRpcSource = processSingleton(
  "platformRpcSource",
  createDbPlatformRpcSource
);

/** Organization configs and policy, shared so a write can invalidate them. */
export const orgRpcSource = processSingleton(
  "orgRpcSource",
  createDbOrgRpcSource
);

/** Organization usage recorded by this process, drained by the usage store. */
export const rpcUsageAccumulator = processSingleton(
  "rpcUsageAccumulator",
  () => new RpcUsageAccumulator()
);

export function getRpcEngine(): RpcEngine {
  return processSingleton("engine", () =>
    createRpcEngine({
      platformSource: platformRpcSource,
      orgSource: orgRpcSource,
      usageRecorder: rpcUsageAccumulator,
      evmCollector: getEvmMetricsCollector,
      solanaCollector: getSolanaMetricsCollector,
      failoverCallback: getFailoverCallback,
    })
  );
}
