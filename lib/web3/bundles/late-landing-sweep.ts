import "server-only";

import { and, desc, eq, gt, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { ethers } from "ethers";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { pendingTransactions } from "@/lib/db/schema-extensions";
import { logWarn } from "@/lib/logging";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import {
  confirmRow,
  findMinedHash,
  historyHashes,
  LATE_BUNDLE_CHECK_MS,
  laggedMinedCount,
  MAX_BUNDLE_WINDOW_MS,
  ownerOf,
  REPLACED_AFTER_MS,
  type ReceiptView,
  type RowKey,
} from "./bundle-history";
import {
  LATE_REVERT_ERROR,
  settleLateLanding,
  settleRun,
} from "./late-landing";

const SWEEP_ROWS = 200;

export type LateBundleSweep = {
  examined: number;
  landed: number;
  replaced: number;
  runsChecked: number;
};

type Read = <T>(
  chainId: number,
  operation: (provider: ethers.Provider) => Promise<T>
) => Promise<{ value: T; endpoint: ethers.Provider | undefined }>;

/**
 * Receipt checks for dropped bundle rows younger than LATE_BUNDLE_CHECK_MS,
 * newest first, so a late landing settles its run even when the wallet sends
 * nothing more. Pending bundle rows whose window closed (a not-checked step,
 * a crashed send) are dropped first, as reconcile would, so they are read
 * too. Runs still not landed with a confirmed bundle row (confirmed while the
 * run was going, or a settle that threw), or ended by a late revert without
 * that row's hash, are settled again first. The deadline is checked between
 * rows and between reads.
 */
export async function sweepLateBundles(
  now: Date,
  deadline: number
): Promise<LateBundleSweep> {
  const managers = new Map<number, Promise<RpcProviderManager>>();
  const read: Read = async (chainId, operation) => {
    let manager = managers.get(chainId);
    if (!manager) {
      manager = getRpcProvider({ chainId });
      managers.set(chainId, manager);
    }
    let endpoint: ethers.Provider | undefined;
    const value = await (await manager).executeWithFailover((provider) => {
      // The provider of the attempt that resolves is the one that answered.
      endpoint = provider;
      return operation(provider);
    }, "read");
    return { value, endpoint };
  };
  const readReceipt = async (
    chainId: number,
    hash: string
  ): Promise<ReceiptView> =>
    (await read(chainId, (provider) => provider.getTransactionReceipt(hash)))
      .value;

  const summary: LateBundleSweep = {
    examined: 0,
    landed: 0,
    replaced: 0,
    runsChecked: 0,
  };
  const cutoff = new Date(now.getTime() - LATE_BUNDLE_CHECK_MS);
  await settleConfirmedRuns(cutoff, deadline, readReceipt, summary);
  await dropClosedWindows(now, cutoff);

  const rows = await db
    .select({
      walletAddress: pendingTransactions.walletAddress,
      chainId: pendingTransactions.chainId,
      nonce: pendingTransactions.nonce,
      txHash: pendingTransactions.txHash,
      executionId: pendingTransactions.executionId,
      lastTargetBlock: pendingTransactions.lastTargetBlock,
      bundleRuns: pendingTransactions.bundleRuns,
      submittedAt: pendingTransactions.submittedAt,
    })
    .from(pendingTransactions)
    .where(
      and(
        eq(pendingTransactions.status, "dropped"),
        ne(pendingTransactions.bundleRuns, sql`'[]'::jsonb`),
        gt(pendingTransactions.submittedAt, cutoff)
      )
    )
    .orderBy(desc(pendingTransactions.submittedAt))
    .limit(SWEEP_ROWS);

  for (const row of rows) {
    if (Date.now() >= deadline) {
      break;
    }
    summary.examined += 1;
    try {
      // Nothing is mined at the nonce until the wallet's nonce passes it: one read, not one per hash.
      const minedNonce = await read(row.chainId, (provider) =>
        laggedMinedCount(provider, row.walletAddress)
      );
      if (minedNonce.value <= row.nonce) {
        continue;
      }
      let oneEndpoint = true;
      const { mined, complete } = await findMinedHash(
        historyHashes(row, now.getTime()),
        async (hash) => {
          const receipt = await read(row.chainId, (provider) =>
            provider.getTransactionReceipt(hash)
          );
          oneEndpoint &&= receipt.endpoint === minedNonce.endpoint;
          return receipt.value;
        },
        deadline
      );
      if (mined) {
        // Guarded on the row being the one read: a session reusing the nonce wins.
        if (await confirmRow(row, mined.hash, "dropped")) {
          summary.landed += 1;
          await settleLateLanding(
            row.bundleRuns,
            row.chainId,
            mined,
            readReceipt
          );
        }
        continue;
      }
      const sentAt = row.submittedAt?.getTime() ?? now.getTime();
      // The nonce passed long ago and one node holding that block has none of these hashes.
      if (
        complete &&
        oneEndpoint &&
        now.getTime() - sentAt >= REPLACED_AFTER_MS &&
        (await markReplaced(row))
      ) {
        summary.replaced += 1;
      }
    } catch (error) {
      logWarn("[Bundle] Late landing check failed; retried next run", {
        chain_id: String(row.chainId),
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return summary;
}

/** Settle again each run that owns a recently confirmed bundle row it may still take. */
async function settleConfirmedRuns(
  cutoff: Date,
  deadline: number,
  readReceipt: (chainId: number, hash: string) => Promise<ReceiptView>,
  summary: LateBundleSweep
): Promise<void> {
  const rows = await db
    .select({
      txHash: pendingTransactions.txHash,
      bundleRuns: pendingTransactions.bundleRuns,
    })
    .from(pendingTransactions)
    .where(
      and(
        eq(pendingTransactions.status, "confirmed"),
        ne(pendingTransactions.bundleRuns, sql`'[]'::jsonb`),
        gt(pendingTransactions.confirmedAt, cutoff),
        // The row's owner (the oldest entry holding its hash, as ownerOf) is not
        // landed, or a late revert ended it without this row's hash.
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${pendingTransactions.bundleRuns}) WITH ORDINALITY AS entry(run, ord)
          JOIN ${workflowExecutions} ON ${workflowExecutions.id} = entry.run->>'executionId'
          WHERE (${workflowExecutions.status} = 'not_landed'
              OR (${workflowExecutions.status} = 'error'
                AND ${workflowExecutions.error} LIKE ${`${LATE_REVERT_ERROR}%`}
                AND NOT coalesce(${workflowExecutions.transactionHashes}, '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('hash', ${pendingTransactions.txHash}))))
            AND entry.run->'hashes' ? ${pendingTransactions.txHash}
            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${pendingTransactions.bundleRuns}) WITH ORDINALITY AS earlier(run, ord)
              WHERE earlier.ord < entry.ord AND earlier.run->'hashes' ? ${pendingTransactions.txHash}))`
      )
    )
    .orderBy(desc(pendingTransactions.confirmedAt))
    .limit(SWEEP_ROWS);

  const owners = new Set<string>();
  for (const row of rows) {
    const owner = ownerOf(row.bundleRuns, row.txHash);
    if (owner) {
      owners.add(owner.executionId);
    }
  }
  for (const executionId of owners) {
    if (Date.now() >= deadline) {
      return;
    }
    summary.runsChecked += 1;
    try {
      await settleRun(executionId, readReceipt);
    } catch (error) {
      logWarn(
        "[Bundle] Not landed run could not be settled; retried next run",
        {
          execution_id: executionId,
          error: error instanceof Error ? error.name : "unknown",
        }
      );
    }
  }
}

/**
 * Pending bundle rows whose window has closed, dropped as a session's
 * reconcile would. Guarded on status: a live session's confirm or drop wins.
 * By time, not block: on a stalled chain a row can drop with a target ahead,
 * which is harmless (one nonce lands once, and the dropped pass settles it).
 */
async function dropClosedWindows(now: Date, cutoff: Date): Promise<void> {
  await db
    .update(pendingTransactions)
    .set({ status: "dropped" })
    .where(
      and(
        eq(pendingTransactions.status, "pending"),
        isNotNull(pendingTransactions.lastTargetBlock),
        ne(pendingTransactions.bundleRuns, sql`'[]'::jsonb`),
        lt(
          pendingTransactions.submittedAt,
          new Date(now.getTime() - MAX_BUNDLE_WINDOW_MS)
        ),
        gt(pendingTransactions.submittedAt, cutoff)
      )
    );
}

async function markReplaced(row: RowKey): Promise<boolean> {
  const updated = await db
    .update(pendingTransactions)
    .set({ status: "replaced" })
    .where(
      and(
        eq(pendingTransactions.walletAddress, row.walletAddress),
        eq(pendingTransactions.chainId, row.chainId),
        eq(pendingTransactions.nonce, row.nonce),
        eq(pendingTransactions.txHash, row.txHash),
        eq(pendingTransactions.status, "dropped")
      )
    )
    .returning({ nonce: pendingTransactions.nonce });
  return updated.length > 0;
}
