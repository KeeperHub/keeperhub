import "server-only";

import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
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
  ownerOf,
  REPLACED_AFTER_MS,
  type ReceiptView,
  type RowKey,
} from "./bundle-history";
import { settleLateLanding, settleRun } from "./late-landing";

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
 * nothing more. Runs still not landed with a confirmed bundle row (confirmed
 * while the run was going, or a settle that threw) are settled again first.
 * The deadline is checked between rows and between reads.
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

/** Settle again each not landed run that owns a recently confirmed bundle row. */
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
        // The row's owner (the oldest entry holding its hash, as ownerOf) is not landed.
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${pendingTransactions.bundleRuns}) WITH ORDINALITY AS entry(run, ord)
          JOIN ${workflowExecutions} ON ${workflowExecutions.id} = entry.run->>'executionId'
          WHERE ${workflowExecutions.status} = 'not_landed'
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
