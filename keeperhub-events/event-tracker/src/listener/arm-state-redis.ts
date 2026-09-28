import { Redis } from "ioredis";
import {
  NODE_ENV,
  REDIS_HOST,
  REDIS_PASSWORD,
  REDIS_PORT,
} from "../../lib/config/environment";
import type { ArmStateStore } from "./arm-state";
import type { ArmPhase, ArmState } from "./state-threshold";

/**
 * Redis-backed ArmStateStore. Split from `arm-state.ts` so `registry.ts` can
 * depend on the interface without pulling `ioredis` into test environments
 * that do not have it, matching the `dedup.ts` / `dedup-redis.ts` split.
 *
 * Deliberately unexpired, unlike the dedup keys' 24h TTL. A subscription can
 * sit armed for months waiting on a threshold it never crosses, and an entry
 * aged out underneath it would re-seed the generation on the next sample and
 * dispatch again for an episode already dispatched. The key space is one entry
 * per active state subscription, so it does not grow without bound; entries
 * for deleted workflows are the leak, and are small enough to sweep later.
 */

function buildArmStateKey(subscriptionId: string): string {
  return `${NODE_ENV}:keeper_state_arm:${subscriptionId}`;
}

function parseArmState(raw: string): ArmState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  const phase = candidate.phase;
  if (phase !== "ARMED" && phase !== "FIRED") {
    return null;
  }
  if (typeof candidate.armGeneration !== "number") {
    return null;
  }
  const lastFiredBlock =
    typeof candidate.lastFiredBlock === "number"
      ? candidate.lastFiredBlock
      : null;
  return {
    phase: phase as ArmPhase,
    armGeneration: candidate.armGeneration,
    lastFiredBlock,
  };
}

export class RedisArmStateStore implements ArmStateStore {
  constructor(private readonly redis: Redis) {}

  async load(subscriptionId: string): Promise<ArmState | null> {
    // A read error propagates: the listener must not mistake it for a cold
    // start. Unparseable stored data is a different matter - it cannot be
    // resumed from, so it is treated as absent and re-seeded.
    const raw = await this.redis.get(buildArmStateKey(subscriptionId));
    if (raw === null) {
      return null;
    }
    return parseArmState(raw);
  }

  async save(subscriptionId: string, state: ArmState): Promise<void> {
    await this.redis.set(
      buildArmStateKey(subscriptionId),
      JSON.stringify(state),
    );
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}

export function createRedisArmStateStore(): RedisArmStateStore {
  const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    ...(REDIS_PASSWORD && { password: REDIS_PASSWORD }),
  });
  return new RedisArmStateStore(redis);
}
