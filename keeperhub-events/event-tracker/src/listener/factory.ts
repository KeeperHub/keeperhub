import { SQS_QUEUE_URL } from "../../lib/config/environment";
import { sqs } from "../../lib/sqs-client";
import { chainProviderManager } from "../chains/provider-manager";
import { RouteProviderPool } from "../chains/route-provider-pool";
import { RpcUsageReporter } from "../usage/rpc-usage-reporter";
import { createRedisArmStateStore } from "./arm-state-redis";
import { createRedisDedupStore } from "./dedup-redis";
import { ListenerRegistry } from "./registry";

/**
 * Production wiring for ListenerRegistry. Imports the concrete
 * `RedisDedupStore` factory and the module-level singletons the registry
 * needs. Intentionally kept in a separate file from `registry.ts` so the
 * registry's test file can import the class without pulling `ioredis` into
 * the test runtime.
 */

export interface RouteRuntime {
  pool: RouteProviderPool;
  usage: RpcUsageReporter;
}

export function createRouteRuntime(): RouteRuntime {
  const usage = new RpcUsageReporter();
  return { pool: new RouteProviderPool({ usage }), usage };
}

export function createRegistry(
  routePool?: RouteProviderPool,
): ListenerRegistry {
  return new ListenerRegistry({
    providerManager: chainProviderManager,
    routePool,
    dedup: createRedisDedupStore(),
    armStore: createRedisArmStateStore(),
    sqs,
    sqsQueueUrl: SQS_QUEUE_URL,
  });
}
