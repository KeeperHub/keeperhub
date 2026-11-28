import {
  BUNDLE_BLOCK_MS,
  BUNDLE_WINDOW_MARGIN_BLOCKS,
  findMinedHash,
  type MinedHash,
  type ReceiptView,
} from "./bundle-history";

const POLL_MS = 1000;

/** Test hooks for a send's timing; production leaves them unset. */
type SendTiming = { timing?: { pollMs?: number; slotMs?: number } };

export function pollMsOf(input: SendTiming): number {
  return input.timing?.pollMs ?? POLL_MS;
}

export function slotMsOf(input: SendTiming): number {
  return input.timing?.slotMs ?? BUNDLE_BLOCK_MS;
}

export function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Reads the watcher needs; each may throw on an RPC failure. */
export type InclusionReads = {
  latestBlock: () => Promise<number>;
  // The wallet's mined transaction count as of `block`, so both reads agree.
  minedCountAt: (block: number) => Promise<number>;
  receipt: (hash: string) => Promise<ReceiptView>;
};

export type InclusionResult =
  | { kind: "included"; mined: MinedHash }
  // The nonce was used, but by none of our hashes, for several blocks.
  | { kind: "used-elsewhere" }
  | { kind: "not-included" }
  // The window passed before the chain decided it (or could be read).
  | { kind: "undecided"; error?: unknown };

/** A read was still out at its deadline: its answer is ignored. */
export class DeadlinePassedError extends Error {
  override readonly name = "DeadlinePassedError" as const;
}

/**
 * `work`, or a DeadlinePassedError once `deadline` (epoch ms) passes first.
 * Past the deadline, only an answer already settled gets through.
 */
export async function beforeDeadline<T>(
  work: Promise<T>,
  deadline: number
): Promise<T> {
  // A read still out at the deadline must not surface as an unhandled rejection.
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DeadlinePassedError("Deadline passed")),
      Math.max(0, deadline - Date.now())
    );
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

// Blocks a receipt index may lag the nonce before the nonce counts as used elsewhere.
const RECEIPT_LAG_BLOCKS = 2;

type WatchState = { passedAt?: number };

type PollOptions = {
  nonce: number;
  hashes: readonly string[];
  lastTarget: number;
  // A public copy is out: the pool can mine it after the targets, so never not-included.
  publicOut?: boolean;
};

// One poll: a block, the nonce at that block, then receipts once it passed.
async function poll(
  options: PollOptions,
  reads: InclusionReads,
  state: WatchState
): Promise<InclusionResult | undefined> {
  const block = await reads.latestBlock();
  const count = await reads.minedCountAt(block);
  if (count > options.nonce) {
    const { mined } = await findMinedHash(options.hashes, reads.receipt);
    if (mined) {
      return { kind: "included", mined };
    }
    state.passedAt ??= block;
    return block >= state.passedAt + RECEIPT_LAG_BLOCKS
      ? { kind: "used-elsewhere" }
      : undefined;
  }
  // Decided by blocks only, with the same margin the nonce manager keeps.
  return !options.publicOut &&
    block > options.lastTarget + BUNDLE_WINDOW_MARGIN_BLOCKS
    ? { kind: "not-included" }
    : undefined;
}

/**
 * Watch for one of a bundle's hashes to be mined at `nonce`, polling every
 * `pollMs` until the chain decides it or `windowEnd` (epoch ms) passes.
 * Read errors keep it polling; wall time alone never says "not included".
 * With `publicOut` it ends only included, used elsewhere or undecided.
 */
export async function watchInclusion(
  options: PollOptions & { pollMs: number; windowEnd: number },
  reads: InclusionReads,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<InclusionResult> {
  const state: WatchState = {};
  let lastError: unknown;
  for (;;) {
    try {
      // A read stuck in RPC failover must not hold the lock past the window.
      const result = await beforeDeadline(
        poll(options, reads, state),
        options.windowEnd
      );
      if (result) {
        return result;
      }
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= options.windowEnd) {
      return { kind: "undecided", error: lastError };
    }
    await sleep(Math.min(options.pollMs, options.windowEnd - Date.now()));
    if (Date.now() >= options.windowEnd) {
      return { kind: "undecided", error: lastError };
    }
  }
}
