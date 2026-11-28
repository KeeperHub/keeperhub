import "server-only";

import { and, eq, isNull, like, type SQL, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { type TransactionHashEntry, workflowExecutions } from "@/lib/db/schema";
import {
  type BundleRun,
  pendingTransactions,
} from "@/lib/db/schema-extensions";
import { classifyExecutionError } from "@/lib/errors/classify";
import { logInfo } from "@/lib/logging";
import {
  recordWorkflowExecutionError,
  recordWorkflowExecutionFinished,
  recordWorkflowExecutionLateLanded,
} from "@/lib/metrics/collectors/prometheus";
import { NA_ERROR_TYPE } from "@/lib/metrics/metric-constants";
import { resolveOrgSlugForCounter } from "@/lib/metrics/org-slug.server";
import {
  NOT_LANDED_PARTLY_REASON,
  type PublicCopyEnd,
  publicCopyNotLandedReason,
} from "@/lib/workflow/executor/run-outcome-keys";
import {
  loadSuccessLogFacts,
  stepKey,
} from "@/lib/workflow/executor/success-log-facts";
import {
  type MinedHash,
  minedOf,
  type NonceKey,
  noneConfirmedSql,
  ownerOf,
  type ReceiptView,
} from "./bundle-history";

/** Reads a receipt on a chain; null when it cannot (another chain, or no answer). */
type ChainReceiptReader = (
  chainId: number,
  hash: string
) => Promise<ReceiptView>;

/** A send of the run found on chain, and the step that made it when known. */
type Landing = {
  chainId: number;
  mined: MinedHash;
  node: BundleRun["node"];
};

const fromNotLanded = (executionId: string): SQL | undefined =>
  and(
    eq(workflowExecutions.id, executionId),
    eq(workflowExecutions.status, "not_landed")
  );

// How the error of a run a late revert ended starts; later landings still add to it. Do not
// reword (older rows match on it). A step can throw it too: harmless, only the run's own rows are added.
export const LATE_REVERT_ERROR =
  "Transaction reverted: a transaction in this run was mined later and reverted";

const fromLateReverted = (executionId: string): SQL | undefined =>
  and(
    eq(workflowExecutions.id, executionId),
    eq(workflowExecutions.status, "error"),
    like(workflowExecutions.error, `${LATE_REVERT_ERROR}%`)
  );

/**
 * A bundle a run gave up on was mined later: re-settle the run that owns the
 * hash. A revert ends it `error` at once; a success goes through settleRun.
 * Call after the mined row is confirmed with the mined hash.
 */
export async function settleLateLanding(
  bundleRuns: readonly BundleRun[],
  chainId: number,
  mined: MinedHash,
  readReceipt: ChainReceiptReader
): Promise<void> {
  const owner = ownerOf(bundleRuns, mined.hash);
  if (!owner) {
    return;
  }
  if (mined.succeeded) {
    await settleRun(owner.executionId, readReceipt, { chainId, mined });
    return;
  }
  const [run] = await db
    .select({ hashes: workflowExecutions.transactionHashes })
    .from(workflowExecutions)
    .where(fromNotLanded(owner.executionId));
  if (!run) {
    await addToLateReverted(owner.executionId, readReceipt, { chainId, mined });
    return;
  }
  const reverted = { chainId, mined, node: owner.node };
  // Other steps of the run that already landed late are written too, with their fees.
  const found = await missedStepLandings(
    owner.executionId,
    (await loadSuccessLogFacts(owner.executionId, false)).notIncludedSteps,
    readReceipt,
    { known: { chainId, mined }, all: false }
  );
  const others = found.landings.filter(
    (landing) => landing.mined.hash !== mined.hash
  );
  await resettleToError(
    owner.executionId,
    run.hashes,
    [reverted, ...others],
    reverted
  );
}

/**
 * Re-settle a not landed run from its confirmed bundle rows. `success` only
 * once every not-included step (node and iteration) has a confirmed row it
 * owns with a succeeded receipt, and no step skipped behind a bundle in
 * flight; `error` when one of those reverted. Otherwise it stays not landed.
 * A run a late revert already ended only gets the landings it does not list.
 */
export async function settleRun(
  executionId: string,
  readReceipt: ChainReceiptReader,
  known?: { chainId: number; mined: MinedHash }
): Promise<void> {
  const [run] = await db
    .select({ hashes: workflowExecutions.transactionHashes })
    .from(workflowExecutions)
    .where(fromNotLanded(executionId));
  if (!run) {
    await addToLateReverted(executionId, readReceipt, known);
    return;
  }
  const facts = await loadSuccessLogFacts(executionId, false);
  // Under-claim: a skip behind a bundle in flight, or no miss to match.
  if (facts.signals.skippedInFlight) {
    logStaysNotLanded(executionId, "not every step sent");
    return;
  }
  if (facts.notIncludedSteps.length === 0) {
    logStaysNotLanded(executionId, "no missed step in its logs");
    return;
  }
  // Hashes already listed (a partial landing written before) are not read again.
  const { landings, missing } = await missedStepLandings(
    executionId,
    facts.notIncludedSteps,
    readReceipt,
    { known, all: false, listed: run.hashes }
  );
  const reverted = landings.find((landing) => !landing.mined.succeeded);
  if (reverted) {
    // A revert ends the run at once; every landing is written with its own fee.
    await resettleToError(executionId, run.hashes, landings, reverted);
    return;
  }
  if (missing) {
    // A step still missing keeps the run not landed; the ones mined late paid gas.
    await addToNotLanded(executionId, run.hashes, landings);
    logStaysNotLanded(executionId, missing);
    return;
  }
  await resettleToSuccess(executionId, run.hashes, landings);
}

/**
 * The late landings of a run's missed steps (node and iteration), from its
 * confirmed bundle rows. `missing` says why a step has none; with `all` the
 * search stops there (no receipt is read), else that step is left out, as is
 * a hash in `listed`.
 */
async function missedStepLandings(
  executionId: string,
  steps: readonly string[],
  readReceipt: ChainReceiptReader,
  options: {
    known?: { chainId: number; mined: MinedHash };
    all: boolean;
    listed?: readonly TransactionHashEntry[];
  }
): Promise<{ landings: Landing[]; missing?: string }> {
  const { known, all } = options;
  const listed = new Set(options.listed?.map((entry) => entry.hash));
  const rows = await db
    .select({
      chainId: pendingTransactions.chainId,
      txHash: pendingTransactions.txHash,
      status: pendingTransactions.status,
      bundleRuns: pendingTransactions.bundleRuns,
    })
    .from(pendingTransactions)
    .where(
      sql`${pendingTransactions.bundleRuns} @> ${JSON.stringify([{ executionId }])}::jsonb`
    );

  // Rows that landed on time name steps that were never missed, so they match no key.
  let missing: string | undefined;
  const landed = new Map<string, Omit<Landing, "mined"> & { hash: string }>();
  for (const key of steps) {
    const row = rows.find((candidate) => {
      const owner = ownerOf(candidate.bundleRuns, candidate.txHash);
      return (
        candidate.status === "confirmed" &&
        owner?.executionId === executionId &&
        owner.node !== undefined &&
        stepKey(owner.node.id, owner.node.iterationIndex) === key
      );
    });
    if (!row) {
      missing ??= "another send in it has not landed";
      if (all) {
        return { landings: [], missing };
      }
      continue;
    }
    landed.set(`${row.chainId}:${row.txHash}`, {
      chainId: row.chainId,
      hash: row.txHash,
      node: ownerOf(row.bundleRuns, row.txHash)?.node,
    });
  }

  const landings: Landing[] = [];
  for (const { hash, ...send } of landed.values()) {
    if (listed.has(hash)) {
      continue;
    }
    const isKnown =
      known?.chainId === send.chainId && known.mined.hash === hash;
    const receipt = isKnown ? null : await readReceipt(send.chainId, hash);
    const mined = isKnown ? known.mined : receipt && minedOf(hash, receipt);
    if (!mined) {
      missing ??= "a receipt could not be read";
      if (all) {
        return { landings: [], missing };
      }
      continue;
    }
    landings.push({ ...send, mined });
  }
  return { landings, ...(missing !== undefined && { missing }) };
}

/**
 * A run a late revert already ended `error`: write the landings of its missed
 * steps it does not list yet, with their fees. The status and error stay.
 */
async function addToLateReverted(
  executionId: string,
  readReceipt: ChainReceiptReader,
  known?: { chainId: number; mined: MinedHash }
): Promise<void> {
  const [run] = await db
    .select({ hashes: workflowExecutions.transactionHashes })
    .from(workflowExecutions)
    .where(fromLateReverted(executionId));
  if (!run) {
    return;
  }
  const { landings } = await missedStepLandings(
    executionId,
    (await loadSuccessLogFacts(executionId, false)).notIncludedSteps,
    readReceipt,
    { known, all: false, listed: run.hashes }
  );
  if (
    await appendLandings(
      fromLateReverted(executionId),
      landedColumns(run.hashes, landings),
      landings
    )
  ) {
    logInfo("[Bundle] A late landing was added to a run a late revert ended", {
      execution_id: executionId,
      tx_hash: landings.map((landing) => landing.mined.hash).join(","),
    });
  }
}

/**
 * A run still not landed (a missed step has no landing yet) whose other
 * steps were mined late: write their hashes and fees, keep the status, and
 * say in the reason that gas was paid.
 */
async function addToNotLanded(
  executionId: string,
  existing: readonly TransactionHashEntry[],
  landings: readonly Landing[]
): Promise<void> {
  const columns = landedColumns(existing, landings);
  if (
    await appendLandings(
      fromNotLanded(executionId),
      { ...columns, error: NOT_LANDED_PARTLY_REASON },
      landings
    )
  ) {
    logInfo("[Bundle] A late landing was added to a run still not landed", {
      execution_id: executionId,
      tx_hash: landings.map((landing) => landing.mined.hash).join(","),
    });
  }
}

/**
 * Write the landings onto the run `from` matches, guarded on none of them
 * being listed yet, so a concurrent settle adds no fee twice. False when
 * there is nothing new or the guard missed.
 */
async function appendLandings(
  from: SQL | undefined,
  set: { transactionHashes?: SQL; gasUsedWei?: SQL; error?: string },
  landings: readonly Landing[]
): Promise<boolean> {
  if (
    landings.length === 0 ||
    (set.transactionHashes === undefined && set.gasUsedWei === undefined)
  ) {
    return false;
  }
  const [updated] = await db
    .update(workflowExecutions)
    .set(set)
    .where(and(from, ...notListedYet([], landings)))
    .returning({ id: workflowExecutions.id });
  return updated !== undefined;
}

/**
 * One guard per landing the run did not list when it was read: still not
 * listed. A concurrent settle that wrote it first makes the update miss, so
 * no hash or fee is added twice; the next sweep settles from the new list.
 */
function notListedYet(
  existing: readonly TransactionHashEntry[],
  landings: readonly Landing[]
): SQL[] {
  const listed = new Set(existing.map((entry) => entry.hash));
  return landings
    .filter((landing) => !listed.has(landing.mined.hash))
    .map(
      (landing) =>
        sql`not (coalesce(${workflowExecutions.transactionHashes}, '[]'::jsonb) @> ${JSON.stringify([{ hash: landing.mined.hash }])}::jsonb)`
    );
}

function logStaysNotLanded(executionId: string, reason: string): void {
  logInfo(`[Bundle] A late landing left its run not landed: ${reason}`, {
    execution_id: executionId,
  });
}

async function resettleToError(
  executionId: string,
  existing: readonly TransactionHashEntry[],
  landings: readonly Landing[],
  reverted: Landing
): Promise<void> {
  const { mined } = reverted;
  const message = `${LATE_REVERT_ERROR} (block ${mined.blockNumber ?? "unknown"}, ${mined.hash})`;
  const { errorType, errorCategory } = classifyExecutionError(message);
  const [updated] = await db
    .update(workflowExecutions)
    .set({
      status: "error",
      error: message,
      errorType,
      errorCategory,
      ...landedColumns(existing, landings),
    })
    .where(and(fromNotLanded(executionId), ...notListedYet(existing, landings)))
    .returning({ workflowId: workflowExecutions.workflowId });
  if (!updated) {
    return;
  }
  logInfo(
    "[Bundle] A not landed run's transaction was mined later and reverted",
    {
      execution_id: executionId,
      tx_hash: mined.hash,
      block_number: String(mined.blockNumber ?? "unknown"),
    }
  );
  try {
    const orgSlug = await resolveOrgSlugForCounter(updated.workflowId);
    recordWorkflowExecutionLateLanded({ orgSlug, status: "error" });
    recordWorkflowExecutionError({ orgSlug, errorCategory, errorType });
  } catch {
    // Counter emission must never break the settle.
  }
}

async function resettleToSuccess(
  executionId: string,
  existing: readonly TransactionHashEntry[],
  landings: readonly Landing[]
): Promise<void> {
  const [updated] = await db
    .update(workflowExecutions)
    .set({
      status: "success",
      error: null,
      ...landedColumns(existing, landings),
    })
    .where(and(fromNotLanded(executionId), ...notListedYet(existing, landings)))
    .returning({ workflowId: workflowExecutions.workflowId });
  if (!updated) {
    return;
  }
  logInfo("[Bundle] A not landed run's transactions were mined later", {
    execution_id: executionId,
    tx_hash: landings.map((landing) => landing.mined.hash).join(","),
  });
  try {
    recordWorkflowExecutionLateLanded({
      orgSlug: await resolveOrgSlugForCounter(updated.workflowId),
      status: "success",
    });
  } catch {
    // Counter emission must never break the settle.
  }
}

/**
 * The late hashes the run does not list yet (named only when the step is
 * known), and their fees added to its gas: once, however often it re-settles.
 */
function landedColumns(
  existing: readonly TransactionHashEntry[],
  landings: readonly Landing[]
): { transactionHashes?: SQL; gasUsedWei?: SQL } {
  const listed = new Set(existing.map((entry) => entry.hash));
  const fresh = landings.filter((landing) => !listed.has(landing.mined.hash));
  const entries = fresh.flatMap((landing) => {
    const entry = hashEntry(
      landing,
      landing.mined.succeeded ? "success" : "reverted"
    );
    return entry ? [entry] : [];
  });
  // The fee was paid even when no entry can name its step.
  const fee = fresh.reduce(
    (total, landing) => total + (landing.mined.feeWei ?? BigInt(0)),
    BigInt(0)
  );
  return {
    ...(entries.length > 0 && {
      transactionHashes: sql`coalesce(${workflowExecutions.transactionHashes}, '[]'::jsonb) || ${JSON.stringify(entries)}::jsonb`,
    }),
    ...(fee > BigInt(0) && {
      gasUsedWei: sql`coalesce(${workflowExecutions.gasUsedWei}, 0) + ${fee.toString()}::numeric`,
    }),
  };
}

function hashEntry(
  { chainId, mined, node }: Landing,
  receiptStatus: "success" | "reverted"
): TransactionHashEntry | undefined {
  if (!node) {
    return;
  }
  return {
    hash: mined.hash,
    nodeId: node.id,
    nodeName: node.name,
    chainId,
    ...(node.iterationIndex !== undefined && {
      iterationIndex: node.iterationIndex,
    }),
    verified: true,
    receiptStatus,
    ...(mined.blockNumber !== null && { blockNumber: mined.blockNumber }),
    ...(mined.gasUnits !== null && { gasUsed: mined.gasUnits.toString() }),
    verifiedAt: new Date().toISOString(),
  };
}

/**
 * The run of a public copy that will not be mined (dropped, or its nonce used by another transaction) ends Not
 * landed (neutral), if still unconfirmed by its own steps and every other hash it lists is verified.
 * The copy's unread hash is taken off the run, so a late landing adds it with its fee (settleLateLanding).
 */
export async function settleDroppedPublicCopy(
  executionId: string,
  row: NonceKey,
  stepHashes: readonly string[],
  end: PublicCopyEnd
): Promise<boolean> {
  const unconfirmed = and(
    eq(workflowExecutions.id, executionId),
    eq(workflowExecutions.status, "unconfirmed"),
    // A run held open by its own failure stays the reconciler's.
    isNull(workflowExecutions.errorType)
  );
  const [run] = await db
    .select({ hashes: workflowExecutions.transactionHashes })
    .from(workflowExecutions)
    .where(unconfirmed);
  if (!run) {
    return false;
  }
  const dropped = new Set(stepHashes.map((hash) => hash.toLowerCase()));
  const listed = run.hashes ?? [];
  const kept = listed.filter((entry) => !dropped.has(entry.hash.toLowerCase()));
  // Another send of the run not verified yet: the reconciler settles the run once it is read.
  if (kept.some((entry) => entry.verified !== true)) {
    return false;
  }
  const error = publicCopyNotLandedReason(end);
  const [updated] = await db
    .update(workflowExecutions)
    .set({
      status: "not_landed",
      error,
      completedAt: new Date(),
      transactionHashes: kept,
    })
    .where(
      and(
        unconfirmed,
        // Unchanged since read: a hash verified meanwhile is not lost.
        sql`coalesce(${workflowExecutions.transactionHashes}, '[]'::jsonb) = ${JSON.stringify(listed)}::jsonb`,
        // Not if one of its hashes was mined (its row confirmed) meanwhile.
        noneConfirmedSql([{ row, hashes: stepHashes }])
      )
    )
    .returning({ workflowId: workflowExecutions.workflowId });
  if (!updated) {
    return false;
  }
  logInfo("[Bundle] A public copy's run ended not landed", {
    execution_id: executionId,
    reason: end,
  });
  try {
    recordWorkflowExecutionFinished({
      status: "not_landed",
      orgSlug: await resolveOrgSlugForCounter(updated.workflowId),
      errorType: NA_ERROR_TYPE,
    });
  } catch {
    // Counter emission must never break the settle.
  }
  return true;
}
