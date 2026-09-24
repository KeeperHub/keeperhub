import "server-only";

/**
 * Upper bound on how long a write waits for its receipt before it reports the
 * outcome as unknown.
 *
 * Unbounded, the wait lasts as long as the step is allowed to live. A
 * transaction that never mines pins the step until the reaper sweeps it at
 * STALE_EXECUTION_THRESHOLD_MINUTES (30 by default,
 * lib/reaper/reap-stale-executions.ts), and the reaper stamps a timeout with
 * no transaction hash -- so the broadcast never enters the reconciler's scan.
 * Bounding the wait ourselves is what turns that into an OnChainPendingError
 * carrying the hash.
 *
 * 600s, chosen between two real limits rather than to be short:
 *
 *   - Above 186s, one primary-then-fallback RPC failover round (3 attempts x
 *     30s + 1s + 2s backoff per endpoint, see lib/rpc/providers and the
 *     DEFAULT_OPTIONS note in nonce-manager.ts). A receipt read riding out a
 *     degraded primary must not be cut short by its own deadline.
 *   - Below the reaper's 30-minute default, so we record the pending row
 *     while the step is still ours to finalize.
 *
 * Deliberately far above a normal confirmation, which is a handful of blocks.
 * The asymmetry is the point: expiring early on a transaction that was going
 * to mine reports a SUCCESSFUL write as a failed run and skips every step
 * after it, while expiring late costs only a later `unconfirmed` row that the
 * reconciler settles anyway. Cheap in one direction, wrong in the other.
 *
 * This does NOT bound the nonce lock, and must not be justified by it: the
 * lock TTL is heartbeat-extended while the session lives (nonce-manager.ts),
 * so it is not sized to outlast a write and imposes no ceiling here.
 */
export const RECEIPT_WAIT_TIMEOUT_MS = 600_000;
