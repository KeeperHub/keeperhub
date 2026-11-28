import { and, eq, type SQL, sql } from "drizzle-orm";
import type { ethers } from "ethers";
import { db } from "@/lib/db";
import {
  type BundlePublicCopy,
  type BundleRun,
  pendingTransactions,
} from "@/lib/db/schema-extensions";
import { DAY_MS } from "@/lib/utils/duration";
import { MAX_BUNDLE_BLOCKS } from "./settings";

/** How long a dropped bundle's signed transactions are checked: they stay valid until the nonce is used. */
export const LATE_BUNDLE_CHECK_MS = DAY_MS;

/** Most bundles kept per nonce; the oldest go first on reuse. */
export const MAX_BUNDLE_RUNS = 20;

/** Bundles go to mainnet builders only, whose slots are 12 s. */
export const BUNDLE_BLOCK_MS = 12_000;

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

/** A row's primary key: one nonce of one wallet on one chain. */
export type NonceKey = Pick<RowKey, "walletAddress" | "chainId" | "nonce">;

/** The row read, while it still holds its hash (and this status, when given). */
export function rowAsRead(
  row: RowKey,
  status?: "dropped" | "pending"
): SQL | undefined {
  return and(
    eq(pendingTransactions.walletAddress, row.walletAddress),
    eq(pendingTransactions.chainId, row.chainId),
    eq(pendingTransactions.nonce, row.nonce),
    eq(pendingTransactions.txHash, row.txHash),
    status ? eq(pendingTransactions.status, status) : undefined
  );
}

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
    .where(rowAsRead(key, fromStatus))
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

/** The row's live public copy: its current send went out publicly (not marked never sent); pending until mined or found nowhere. */
export function livePublicCopy(row: HistoryRow): BundlePublicCopy | undefined {
  const last = row.bundleRuns.at(-1);
  if (
    row.lastTargetBlock === null ||
    last?.executionId !== row.executionId ||
    !last.public ||
    last.public.accepted === false
  ) {
    return;
  }
  return last.public;
}

/** livePublicCopy in SQL, on pending_transactions. */
export function livePublicCopySql(): SQL {
  const last = sql`(${pendingTransactions.bundleRuns} -> -1)`;
  // Never NULL, so NOT() of it is safe.
  return sql`coalesce((${pendingTransactions.lastTargetBlock} IS NOT NULL
    AND ${last} ->> 'executionId' = ${pendingTransactions.executionId}
    AND ${last} ? 'public'
    AND coalesce(${last} -> 'public' ->> 'accepted', '') <> 'false'), false)`;
}

/** The other hash of this run's signed ones its bundle row was confirmed with (a reorg can mine another), if any. */
export async function minedBundleHashFor(
  executionId: string,
  chainId: number,
  hash: string
): Promise<string | undefined> {
  const rows = await db
    .select({
      txHash: pendingTransactions.txHash,
      bundleRuns: pendingTransactions.bundleRuns,
    })
    .from(pendingTransactions)
    .where(
      and(
        eq(pendingTransactions.chainId, chainId),
        eq(pendingTransactions.status, "confirmed"),
        sql`${pendingTransactions.bundleRuns} @> ${JSON.stringify([{ executionId, hashes: [hash] }])}::jsonb`
      )
    );
  for (const row of rows) {
    const ours = row.bundleRuns.some(
      (run) =>
        run.executionId === executionId &&
        run.hashes.includes(hash) &&
        run.hashes.includes(row.txHash)
    );
    if (ours && row.txHash !== hash) {
      return row.txHash;
    }
  }
  return;
}

/** A copy's signed hashes, at the row (primary key) that holds them. */
export type CopyHashes = { row: NonceKey; hashes: readonly string[] };

/** How a run's public copy ended, with its row's key and the entry's signed hashes. */
export type EndedPublicCopy = CopyHashes & { end: "dropped" | "replaced" };

/** How this run's public copy with this hash ended: its row dropped or replaced, or its nonce used by another send; else undefined. */
export async function endedPublicCopyFor(
  executionId: string,
  chainId: number,
  hash: string
): Promise<EndedPublicCopy | undefined> {
  const rows = await db
    .select({
      walletAddress: pendingTransactions.walletAddress,
      nonce: pendingTransactions.nonce,
      status: pendingTransactions.status,
      txHash: pendingTransactions.txHash,
      executionId: pendingTransactions.executionId,
      bundleRuns: pendingTransactions.bundleRuns,
    })
    .from(pendingTransactions)
    .where(
      and(
        eq(pendingTransactions.chainId, chainId),
        sql`${pendingTransactions.bundleRuns} @> ${JSON.stringify([{ executionId, public: { hash } }])}::jsonb`
      )
    );
  for (const row of rows) {
    // A copy that never went out (accepted false) was never the run's to wait on.
    const entry = row.bundleRuns.find(
      (run) =>
        run.executionId === executionId &&
        run.public?.hash === hash &&
        run.public.accepted !== false
    );
    if (!entry) {
      continue;
    }
    const ended = (end: "dropped" | "replaced"): EndedPublicCopy => ({
      end,
      row: { walletAddress: row.walletAddress, chainId, nonce: row.nonce },
      hashes: entry.hashes,
    });
    if (row.status === "dropped" || row.status === "replaced") {
      return ended(row.status);
    }
    const ours = entry.hashes.some(
      (signed) => signed.toLowerCase() === row.txHash.toLowerCase()
    );
    // Mined with a hash the entry never signed (any run's re-send): the copy cannot be mined.
    if (row.status === "confirmed" && !ours) {
      return ended("replaced");
    }
    // Another run's send now holds the nonce (a reuse merged into the dropped row).
    if (row.executionId !== executionId && !ours) {
      return ended("dropped");
    }
  }
  return;
}

/** True unless a copy's row (by primary key) is confirmed with one of its hashes, i.e. mined after it was read as ended. */
export function noneConfirmedSql(copies: readonly CopyHashes[]): SQL {
  const checks: SQL[] = [];
  for (const { row, hashes } of copies) {
    const lowered = [...new Set(hashes.map((hash) => hash.toLowerCase()))];
    if (lowered.length === 0) {
      continue;
    }
    // Aliased, so it reads the same inside an UPDATE of another table.
    checks.push(sql`NOT EXISTS (SELECT 1 FROM pending_transactions confirmed_tx
      WHERE confirmed_tx.wallet_address = ${row.walletAddress}
      AND confirmed_tx.chain_id = ${row.chainId}
      AND confirmed_tx.nonce = ${row.nonce}
      AND confirmed_tx.status = 'confirmed'
      AND lower(confirmed_tx.tx_hash) IN (${sql.join(
        lowered.map((hash) => sql`${hash}`),
        sql`, `
      )}))`);
  }
  return checks.length === 0
    ? sql`true`
    : sql`(${sql.join(checks, sql` AND `)})`;
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
