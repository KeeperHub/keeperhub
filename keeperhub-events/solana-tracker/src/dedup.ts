/**
 * Transaction dedup store used by EventListener to avoid forwarding the same
 * on-chain event twice (across reconnects, reorg replay, and pod restarts).
 *
 * Kept behind an interface so Phase 5 can swap the Redis-backed
 * implementation for a Postgres-backed one without touching the listener
 * code. A single dedup instance is shared across every listener in a
 * process, replacing the one-connection-per-workflow pattern from the fork
 * model.
 *
 * This semantic is best-effort by design: `markProcessed` has a 24h TTL
 * (Redis impl) and individual failures must not stop event forwarding
 * (the downstream workflow executor is the idempotency authority).
 *
 * Deliberately contains no value imports: this module is loaded by
 * registry.ts, and registry's unit tests run in environments that do not
 * have `ioredis` installed (main-app workspace). The Redis-backed
 * implementation lives in `dedup-redis.ts` and is only loaded at runtime
 * through `factory.ts`.
 */

/**
 * Concurrency note: the check-then-set shape (isProcessed + markProcessed)
 * is deliberately non-atomic. The refactor chose ordering "read -> send ->
 * mark" inside EventListener so a send failure does not leave a marked-
 * but-undelivered event. Atomic `SET NX EX` semantics would force mark-
 * before-send and trade a benign race for a lost-event risk.
 *
 * The race window only matters for a single listener receiving the same
 * txHash twice (WSS reconnect or chain reorg), since the dedup key
 * includes workflowId - two workflows on the same (address, topic0) hash
 * to different keys and do not interfere. The downstream executor is the
 * idempotency authority; the occasional duplicate is acceptable.
 */
export interface DedupStore {
  isProcessed(workflowId: string, txHash: string): Promise<boolean>;
  markProcessed(workflowId: string, txHash: string): Promise<void>;
  disconnect(): Promise<void>;
}
