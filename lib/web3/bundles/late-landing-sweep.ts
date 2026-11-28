import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNotNull,
  lt,
  ne,
  not,
  type SQL,
  sql,
} from "drizzle-orm";
import type { ethers } from "ethers";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import {
  type BundleRun,
  pendingTransactions,
} from "@/lib/db/schema-extensions";
import { logInfo, logWarn } from "@/lib/logging";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { extraRpcHasTransaction } from "@/lib/web3/extra-broadcast";
import type { PublicCopyEnd } from "@/lib/workflow/executor/run-outcome-keys";
import {
  confirmRow,
  findMinedHash,
  historyHashes,
  LATE_BUNDLE_CHECK_MS,
  laggedMinedCount,
  livePublicCopy,
  livePublicCopySql,
  MAX_BUNDLE_WINDOW_MS,
  ownerOf,
  provedReplaced,
  type ReceiptView,
  type RowKey,
  rowAsRead,
} from "./bundle-history";
import {
  LATE_REVERT_ERROR,
  settleDroppedPublicCopy,
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
 * that row's hash, are settled again first. Pending rows whose public copy
 * went out are checked next (sweepPublicCopies). The deadline is checked
 * between rows and between reads.
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
  await sweepPublicCopies(now, cutoff, deadline, {
    read,
    readReceipt,
    manager: (chainId) => {
      let manager = managers.get(chainId);
      if (!manager) {
        manager = getRpcProvider({ chainId });
        managers.set(chainId, manager);
      }
      return manager;
    },
    summary,
  });
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
      // The nonce passed long ago and one node holding that block has none of these hashes.
      if (
        provedReplaced({
          scanComplete: complete,
          nonceEndpointOnly: oneEndpoint,
          minedCount: minedNonce.value,
          nonce: row.nonce,
          submittedAt: row.submittedAt,
          now: now.getTime(),
        }) &&
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

/** Sweeps in a row that find a public copy on no endpoint before its row is dropped. */
export const PUBLIC_COPY_MISSES_TO_DROP = 3;

// Sweeps in a row with no clear answer before one warning is logged; the stored count stops there.
const PUBLIC_COPY_UNCLEAR_TO_WARN = 3;

type PublicCopyReads = {
  read: Read;
  readReceipt: (chainId: number, hash: string) => Promise<ReceiptView>;
  manager: (chainId: number) => Promise<RpcProviderManager>;
  summary: LateBundleSweep;
};

type PublicRow = RowKey & {
  executionId: string;
  lastTargetBlock: number | null;
  bundleRuns: BundleRun[];
  submittedAt: Date | null;
};

/**
 * Pending public-copy rows past their window: mined is confirmed (a late run settles); a copy no endpoint
 * knows adds a miss, and PUBLIC_COPY_MISSES_TO_DROP in a row drop the row and settle its run Not landed.
 */
async function sweepPublicCopies(
  now: Date,
  cutoff: Date,
  deadline: number,
  reads: PublicCopyReads
): Promise<void> {
  const rows: PublicRow[] = await db
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
        eq(pendingTransactions.status, "pending"),
        livePublicCopySql(),
        lt(
          pendingTransactions.submittedAt,
          new Date(now.getTime() - MAX_BUNDLE_WINDOW_MS)
        ),
        gt(pendingTransactions.submittedAt, cutoff)
      )
    )
    // Round robin: least recently checked first, so copies that never drop cannot starve the rest.
    .orderBy(
      asc(
        sql`coalesce((${pendingTransactions.bundleRuns} -> -1 -> 'public' ->> 'checkedAt')::bigint, 0)`
      ),
      asc(pendingTransactions.submittedAt)
    )
    .limit(SWEEP_ROWS);
  for (const row of rows) {
    if (Date.now() >= deadline) {
      return;
    }
    reads.summary.examined += 1;
    try {
      await markChecked(row, now);
      await checkPublicCopy(row, now, deadline, reads);
    } catch (error) {
      logWarn("[Bundle] Public copy check failed; retried next run", {
        chain_id: String(row.chainId),
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

async function checkPublicCopy(
  row: PublicRow,
  now: Date,
  deadline: number,
  reads: PublicCopyReads
): Promise<void> {
  const copy = livePublicCopy(row);
  if (!copy) {
    return;
  }
  const minedNonce = await reads.read(row.chainId, (provider) =>
    laggedMinedCount(provider, row.walletAddress)
  );
  if (minedNonce.value > row.nonce) {
    await settleUsedNonce(row, now, deadline, reads, minedNonce);
    return;
  }
  // Sent through the user's own RPC: the platform's endpoints may never see it, and the sweep never reads the user's.
  if (copy.via === "user") {
    return;
  }
  const verdict = await publicCopySeen(
    await reads.manager(row.chainId),
    copy.hash
  );
  const wasUnclear = copy.unclear ?? 0;
  const unclear =
    verdict === "unclear"
      ? Math.min(wasUnclear + 1, PUBLIC_COPY_UNCLEAR_TO_WARN)
      : 0;
  if (
    unclear === PUBLIC_COPY_UNCLEAR_TO_WARN &&
    wasUnclear < PUBLIC_COPY_UNCLEAR_TO_WARN
  ) {
    logWarn("[Bundle] Public copy unclear on the RPCs for three sweeps", {
      chain_id: String(row.chainId),
      tx_hash: copy.hash,
    });
  }
  let misses = copy.misses ?? 0;
  if (verdict === "seen") {
    misses = 0;
  } else if (verdict === "missing") {
    misses += 1;
  }
  if (misses === (copy.misses ?? 0) && unclear === wasUnclear) {
    return;
  }
  await recordCounts(row, { misses, unclear });
}

/**
 * The nonce is used: confirm the mined hash, or on proof mark the row replaced and settle its run Not landed.
 * A miss count never drops it.
 */
async function settleUsedNonce(
  row: PublicRow,
  now: Date,
  deadline: number,
  reads: PublicCopyReads,
  minedNonce: { value: number; endpoint: ethers.Provider | undefined }
): Promise<void> {
  let oneEndpoint = true;
  const { mined, complete } = await findMinedHash(
    historyHashes(row, now.getTime()),
    async (hash) => {
      const receipt = await reads.read(row.chainId, (provider) =>
        provider.getTransactionReceipt(hash)
      );
      oneEndpoint &&= receipt.endpoint === minedNonce.endpoint;
      return receipt.value;
    },
    deadline
  );
  if (mined) {
    // Guarded on the row being the one read: a session reusing the nonce wins.
    if (await confirmRow(row, mined.hash)) {
      reads.summary.landed += 1;
      await settleLateLanding(
        row.bundleRuns,
        row.chainId,
        mined,
        reads.readReceipt
      );
    }
    return;
  }
  if (
    provedReplaced({
      scanComplete: complete,
      nonceEndpointOnly: oneEndpoint,
      minedCount: minedNonce.value,
      nonce: row.nonce,
      submittedAt: row.submittedAt,
      now: now.getTime(),
    }) &&
    (await markReplaced(row, "pending"))
  ) {
    reads.summary.replaced += 1;
    await settleCopyRun(row, "public-copy-replaced");
  }
}

/**
 * Seen on any endpoint; missing when the primary and the fallback (the primary alone when none is set) clearly
 * answered no; else unclear. Failed over, the primary is not asked, so a no is unclear. Extras only add "seen".
 */
async function publicCopySeen(
  manager: RpcProviderManager,
  hash: string
): Promise<"seen" | "missing" | "unclear"> {
  const current = manager.getProvider();
  const fallback = manager.getFallbackProvider();
  const failedOver =
    (typeof manager.isCurrentlyUsingFallback === "function" &&
      manager.isCurrentlyUsingFallback()) ||
    (fallback !== null && current === fallback);
  // Each endpoint once: failed over, getProvider() is the fallback.
  const providers = [...new Set([current, fallback])].filter(
    (provider): provider is ethers.JsonRpcProvider => provider !== null
  );
  const [managed, extras] = await Promise.all([
    Promise.all(
      providers.map((provider) =>
        provider
          .getTransaction(hash)
          .then((tx): boolean => tx !== null)
          .catch((): undefined => undefined)
      )
    ),
    // An extra that errors, answers non-200 or times out is left out of the verdict.
    Promise.all(
      manager
        .getBroadcastRpcUrls()
        .map((url) => extraRpcHasTransaction(url, hash))
    ),
  ]);
  if (managed.includes(true) || extras.includes(true)) {
    return "seen";
  }
  return managed.includes(undefined) || failedOver ? "unclear" : "missing";
}

const stillPending = (row: RowKey): SQL | undefined =>
  rowAsRead(row, "pending");

/** Stamp the copy as examined now, on the row read while it is still pending. */
async function markChecked(row: PublicRow, now: Date): Promise<void> {
  const runs = pendingTransactions.bundleRuns;
  const last = sql`(jsonb_array_length(${runs}) - 1)::text`;
  await db
    .update(pendingTransactions)
    .set({
      bundleRuns: sql`jsonb_set(${runs}, ARRAY[${last}, 'public', 'checkedAt'], ${String(now.getTime())}::jsonb)`,
    })
    .where(stillPending(row));
}

/** Store the miss and unclear counts; at the miss limit the row is dropped and its run settled. Guarded on the row read. */
async function recordCounts(
  row: PublicRow,
  counts: { misses: number; unclear: number }
): Promise<void> {
  const runs = pendingTransactions.bundleRuns;
  const last = sql`(jsonb_array_length(${runs}) - 1)::text`;
  const drop = counts.misses >= PUBLIC_COPY_MISSES_TO_DROP;
  const updated = await db
    .update(pendingTransactions)
    .set({
      bundleRuns: sql`jsonb_set(jsonb_set(${runs}, ARRAY[${last}, 'public', 'misses'], ${String(counts.misses)}::jsonb), ARRAY[${last}, 'public', 'unclear'], ${String(counts.unclear)}::jsonb)`,
      ...(drop && { status: "dropped" }),
    })
    .where(stillPending(row))
    .returning({ nonce: pendingTransactions.nonce });
  if (!(drop && updated.length > 0)) {
    return;
  }
  logInfo("[Bundle] Public copy found on no endpoint; nonce released", {
    chain_id: String(row.chainId),
    tx_hash: row.txHash,
  });
  // A later landing re-settles it.
  await settleCopyRun(row, "public-copy-dropped");
}

/** Settle the run of a copy whose row was just dropped or replaced; nothing retries it, so a throw is the reconciler's. */
async function settleCopyRun(
  row: PublicRow,
  end: PublicCopyEnd
): Promise<void> {
  // The row's newest entry is its run's (livePublicCopy).
  const entry = row.bundleRuns.at(-1);
  if (!entry) {
    return;
  }
  try {
    await settleDroppedPublicCopy(entry.executionId, row, entry.hashes, end);
  } catch (error) {
    logWarn("[Bundle] Public copy run not settled; left to the reconciler", {
      chain_id: String(row.chainId),
      reason: end,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * Pending bundle rows whose window has closed, dropped as a session's
 * reconcile would. Guarded on status: a live session's confirm or drop wins.
 * By time, not block: on a stalled chain a row can drop with a target ahead,
 * which is harmless (one nonce lands once, and the dropped pass settles it).
 * A row whose public copy went out is left to sweepPublicCopies.
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
        // Public copy rows are sweepPublicCopies': a pooled copy can be mined after the window.
        not(livePublicCopySql()),
        lt(
          pendingTransactions.submittedAt,
          new Date(now.getTime() - MAX_BUNDLE_WINDOW_MS)
        ),
        gt(pendingTransactions.submittedAt, cutoff)
      )
    );
}

async function markReplaced(
  row: RowKey,
  fromStatus: "dropped" | "pending" = "dropped"
): Promise<boolean> {
  const updated = await db
    .update(pendingTransactions)
    .set({ status: "replaced" })
    .where(rowAsRead(row, fromStatus))
    .returning({ nonce: pendingTransactions.nonce });
  return updated.length > 0;
}
