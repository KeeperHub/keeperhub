import { SQS_QUEUE_URL } from "../../lib/config/environment";
import { sqs } from "../../lib/sqs-client";
import { chainProviderManager } from "../chains/provider-manager";
import { createRedisDedupStore } from "./dedup-redis";
import { ListenerRegistry } from "./registry";

/**
 * Production wiring for ListenerRegistry. Imports the concrete
 * `RedisDedupStore` factory and the module-level singletons the registry
 * needs. Intentionally kept in a separate file from `registry.ts` so the
 * registry's test file can import the class without pulling `ioredis` into
 * the test runtime.
 */

export function createRegistry(): ListenerRegistry {
  return new ListenerRegistry({
    providerManager: chainProviderManager,
    dedup: createRedisDedupStore(),
    sqs,
    sqsQueueUrl: SQS_QUEUE_URL,
  });
}
