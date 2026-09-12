import type { ArmState } from "./state-threshold";

/**
 * Durable home for a state-threshold subscription's arming state.
 *
 * Only one thing needs to survive a process bounce: which arming episode a
 * subscription is in. Everything else about a subscription is rebuilt from the
 * workflow API on the next reconcile pass. A listener therefore reads this
 * once at start and holds the state in memory afterwards, writing through on
 * each transition - the read is a crash-resume, not a per-sample round trip.
 *
 * Kept behind an interface, and value-import-free, for the same reason
 * `dedup.ts` is: `registry.ts` imports it and the registry's unit tests run
 * without `ioredis` installed. The Redis implementation lives in
 * `arm-state-redis.ts` and is loaded only through `factory.ts`.
 *
 * `load` distinguishes a miss from a failure. A miss is a cold start and the
 * listener seeds a fresh generation. A failure must not be read as a cold
 * start: re-seeding on a transient store error would open a new generation
 * for a subscription that is already armed, and manufacture a duplicate
 * dispatch out of a blip. Implementations throw instead, and the listener
 * skips the sample.
 */
export interface ArmStateStore {
  /** The stored state, or null when nothing is stored. Throws on failure. */
  load(subscriptionId: string): Promise<ArmState | null>;
  save(subscriptionId: string, state: ArmState): Promise<void>;
  disconnect(): Promise<void>;
}
