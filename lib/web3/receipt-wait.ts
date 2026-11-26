import "server-only";
import type { ethers } from "ethers";
import { sleep } from "@/lib/sleep";

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

type PollReceiptOptions = {
  timeoutMs: number;
  intervalMs: number;
  /** Cap on one read (a read error); every read is also cut at the deadline. */
  readTimeoutMs?: number;
};

type PollReceiptOutcome =
  | { receipt: ethers.TransactionReceipt }
  | { receipt: null; lastReadError: unknown };

const TIMED_OUT = Symbol("timed out");

/** Resolves to TIMED_OUT when the read takes longer than `ms`. */
function boundedRead<T>(
  read: () => Promise<T>,
  ms: number
): Promise<T | typeof TIMED_OUT> {
  const pending = read();
  // A read cut short may still fail later; nobody awaits it then.
  pending.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Poll a receipt by hash until one comes back or the deadline passes. Read
 * errors keep the poll going (the send is already out); the caller turns a
 * miss into its own pending error with the hash. No read or sleep runs past
 * the deadline.
 */
export async function pollReceipt(
  read: () => Promise<ethers.TransactionReceipt | null>,
  { timeoutMs, intervalMs, readTimeoutMs }: PollReceiptOptions
): Promise<PollReceiptOutcome> {
  const deadline = Date.now() + timeoutMs;
  let lastReadError: unknown;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) {
      return { receipt: null, lastReadError };
    }
    const cap =
      readTimeoutMs !== undefined && readTimeoutMs < left
        ? readTimeoutMs
        : left;
    const cutAtDeadline = cap === left;
    try {
      const result = await boundedRead(read, cap);
      if (result === TIMED_OUT) {
        // A cut at the deadline is no answer; only the per-read cap is an error.
        lastReadError = cutAtDeadline
          ? undefined
          : new Error(`receipt read timed out after ${cap} ms`);
      } else if (result) {
        return { receipt: result };
      } else {
        lastReadError = undefined;
      }
    } catch (error) {
      lastReadError = error;
    }
    if (Date.now() + intervalMs > deadline) {
      return { receipt: null, lastReadError };
    }
    await sleep(intervalMs);
  }
}
