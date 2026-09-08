import { Redis } from "ioredis";
import { logWarn } from "@/lib/logging";

/**
 * Best-effort Redis for the app tier: a cross-replica coordination layer,
 * never a source of truth. Callers must tolerate a null client and rejected
 * commands. Returns null when REDIS_HOST is unset so local/self-hosted
 * environments degrade to in-process behavior instead of erroring.
 */

const globalForRedis = globalThis as unknown as {
  keeperhubRedis?: Redis | null;
};

const ERROR_LOG_INTERVAL_MS = 60_000;
let lastErrorLoggedAt = 0;

function logRedisError(err: Error): void {
  const now = Date.now();
  if (now - lastErrorLoggedAt < ERROR_LOG_INTERVAL_MS) {
    return;
  }
  lastErrorLoggedAt = now;
  logWarn(`[redis] client error (best-effort, ignoring): ${err.message}`);
}

function createClient(): Redis | null {
  const {
    REDIS_HOST: host,
    REDIS_PORT: port,
    REDIS_PASSWORD: password,
  } = process.env;

  if (!(host && password)) {
    return null;
  }

  const client = new Redis({
    host,
    port: Number(port) || 6379,
    password,
    lazyConnect: true,
    // Fail commands fast into the caller's fallback rather than stalling a
    // request while Redis is unreachable.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 1000,
    commandTimeout: 500,
    retryStrategy: (times: number): number => Math.min(times * 500, 5000),
  });

  // An unhandled 'error' would crash the process; swallow and throttle.
  client.on("error", logRedisError);
  return client;
}

export function getRedis(): Redis | null {
  if (globalForRedis.keeperhubRedis === undefined) {
    globalForRedis.keeperhubRedis = createClient();
  }
  return globalForRedis.keeperhubRedis;
}
