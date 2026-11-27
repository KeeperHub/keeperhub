import { and, eq } from "drizzle-orm";
import type { ethers } from "ethers";
import { db } from "@/lib/db";
import {
  type BundleRun,
  pendingTransactions,
} from "@/lib/db/schema-extensions";
import { DAY_MS } from "@/lib/utils/duration";
import { MAX_BUNDLE_BLOCKS } from "./settings";

/** How long a dropped bundle's signed transactions are checked: they stay valid until the nonce is used. */
export const LATE_BUNDLE_CHECK_MS = DAY_MS;

/** Most bundles kept per nonce; the oldest go first on reuse. */
export const MAX_BUNDLE_RUNS = 20;

// Bundles go to mainnet builders only, whose slots are 12 s.
const BUNDLE_BLOCK_MS = 12_000;

/**
 * Longest a bundle row may hold its nonce: a wrong latest block can never pin
 * it longer. Derived from the most blocks a step may target (settings), plus
 * one block, since the latest block a send plans from can already be a slot old.
 */
export const MAX_BUNDLE_WINDOW_MS =
  (MAX_BUNDLE_BLOCKS + 1) * BUNDLE_BLOCK_MS + 60_000;

/** A node a block or two behind can still report the last target as latest. */
export const BUNDLE_WINDOW_MARGIN_BLOCKS = 2;

/** Budget for the receipt reads of rows with bundle history at session start (lock held). */
export const SESSION_HISTORY_SCAN_MS = 10_000;

// A bundle step's work under the lock before its row is recorded: simulate, gas, sign.
const BUNDLE_PRE_SEND_MS = 30_000;

// These are budgets, not estimates: a send past BUNDLE_PRE_RECORD_MS from the lock
// is refused unsent, and reads after the row is recorded stop at its window's end.
/** Longest from taking the lock to recording the row; later, nothing is sent. */
export const BUNDLE_PRE_RECORD_MS =
  SESSION_HISTORY_SCAN_MS + BUNDLE_PRE_SEND_MS;

/** Longest a bundle step holds its wallet's lock; a sender behind it waits this long. */
export const LONGEST_BUNDLE_HOLD_MS =
  BUNDLE_PRE_RECORD_MS + MAX_BUNDLE_WINDOW_MS;

/** Room a run keeps after a bundle hold, to settle the step and write the run. */
export const BUNDLE_RUN_MARGIN_MS = 30_000;

/** A dropped row this old whose nonce passed with none of its hashes mined is closed out. */
const REPLACED_AFTER_MS = 10 * 60_000;

/**
 * The one rule for marking a bundle row `replaced` (the session and the sweep):
 * a finished receipt scan, every read answered by the node the mined count came
 * from, that count past the nonce, and the row at least REPLACED_AFTER_MS old.
 * One load-balanced URL can hide a backend whose receipts lag its state; the
 * age gives a landed bundle's receipt time to show everywhere.
 */
export function provedReplaced(check: {
  scanComplete: boolean;
  nonceEndpointOnly: boolean;
  minedCount: number | null;
  nonce: number;
  submittedAt: Date | null;
  now: number;
}): boolean {
  const sentAt = check.submittedAt?.getTime() ?? check.now;
  return (
    check.scanComplete &&
    check.nonceEndpointOnly &&
    check.minedCount !== null &&
    check.minedCount > check.nonce &&
    check.now - sentAt >= REPLACED_AFTER_MS
  );
}

// A load-balanced URL's nodes can be a block or two apart. Counts blocks, not
// time: fine for the bundle chains, whose block times are similar.
const NONCE_LAG_BLOCKS = 3;

/**
 * The wallet's mined count a few blocks behind the head: any node that then
 * answers a receipt read holds the block where that nonce was used.
 */
export async function laggedMinedCount(
  provider: ethers.Provider,
  address: string
): Promise<number> {
  const head = await provider.getBlockNumber();
  return await provider.getTransactionCount(
    address,
    Math.max(0, head - NONCE_LAG_BLOCKS)
  );
}

/** A hash found on chain: its block, whether the call succeeded, and the fee paid. */
export type MinedHash = {
  hash: string;
  blockNumber: number | null;
  succeeded: boolean;
  gasUnits: bigint | null;
  feeWei: bigint | null;
};

/** The receipt fields the lookup reads; null when the hash has none. */
export type ReceiptView = {
  blockNumber?: number | null;
  status?: number | null;
  gasUsed?: bigint | null;
  // The effective gas price on an ethers receipt.
  gasPrice?: bigint | null;
} | null;

/** What a receipt says about its hash. */
export function minedOf(
  hash: string,
  receipt: NonNullable<ReceiptView>
): MinedHash {
  const gasUnits = receipt.gasUsed ?? null;
  const price = receipt.gasPrice ?? null;
  return {
    hash,
    blockNumber: receipt.blockNumber ?? null,
    succeeded: receipt.status === 1,
    gasUnits,
    feeWei: gasUnits !== null && price !== null ? gasUnits * price : null,
  };
}

/** A row as read: a reused nonce has a new hash, so a write on it misses. */
export type RowKey = {
  walletAddress: string;
  chainId: number;
  nonce: number;
  txHash: string;
};

/** The oldest entry holding this hash: two runs signing the same call share it, and only one executed. */
export function ownerOf(
  bundleRuns: readonly BundleRun[],
  hash: string
): BundleRun | undefined {
  return bundleRuns.find((run) => run.hashes.includes(hash));
}

/**
 * Confirm the row at this nonce with the mined hash, only while it is still
 * the send that was read (same hash) and `fromStatus` when given.
 */
export async function confirmRow(
  key: RowKey,
  minedHash: string,
  fromStatus?: "dropped"
): Promise<boolean> {
  const updated = await db
    .update(pendingTransactions)
    .set({ status: "confirmed", confirmedAt: new Date(), txHash: minedHash })
    .where(
      and(
        eq(pendingTransactions.walletAddress, key.walletAddress),
        eq(pendingTransactions.chainId, key.chainId),
        eq(pendingTransactions.nonce, key.nonce),
        eq(pendingTransactions.txHash, key.txHash),
        fromStatus ? eq(pendingTransactions.status, fromStatus) : undefined
      )
    )
    .returning({ nonce: pendingTransactions.nonce });
  return updated.length > 0;
}

type HistoryRow = {
  txHash: string;
  executionId: string;
  lastTargetBlock: number | null;
  bundleRuns: readonly BundleRun[];
};

/** The row's current send: its bundle's hashes while it is a bundle, else its one hash. */
export function currentSendHashes(row: HistoryRow): string[] {
  const last = row.bundleRuns.at(-1);
  if (
    row.lastTargetBlock === null ||
    last?.executionId !== row.executionId ||
    !last.hashes.includes(row.txHash)
  ) {
    return [row.txHash];
  }
  return [...new Set([row.txHash, ...last.hashes])];
}

/** Every hash still worth a receipt read at this nonce, newest first. */
export function historyHashes(row: HistoryRow, now: number): string[] {
  const hashes = [row.txHash];
  for (const run of [...row.bundleRuns].reverse()) {
    if (run.signedAt > now - LATE_BUNDLE_CHECK_MS) {
      hashes.push(...run.hashes);
    }
  }
  return [...new Set(hashes)];
}

/**
 * The first hash with a receipt, in the order given, one read each.
 * `complete` is false when the deadline stopped the scan early.
 */
export async function findMinedHash(
  hashes: readonly string[],
  readReceipt: (hash: string) => Promise<ReceiptView>,
  deadline: number = Number.POSITIVE_INFINITY
): Promise<{ mined?: MinedHash; complete: boolean }> {
  for (const hash of hashes) {
    if (Date.now() >= deadline) {
      return { complete: false };
    }
    const receipt = await readReceipt(hash);
    if (receipt) {
      return { mined: minedOf(hash, receipt), complete: true };
    }
  }
  return { complete: true };
}
