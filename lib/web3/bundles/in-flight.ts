import "server-only";

import { and, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import {
  type BundleMiss,
  type BundleRun,
  pendingTransactions,
} from "@/lib/db/schema-extensions";
import {
  BUNDLE_WINDOW_MARGIN_BLOCKS,
  LATE_BUNDLE_CHECK_MS,
  livePublicCopy,
  MAX_BUNDLE_WINDOW_MS,
} from "./bundle-history";

type InFlightRow = {
  executionId: string;
  nonce: number;
  txHash: string;
  lastTargetBlock: number | null;
  bundleRuns: BundleRun[];
  submittedAt: Date | null;
};

/** The step sending now: its run, and the node and loop iteration in it. */
type BundleStep = {
  executionId: string;
  nodeId: string;
  iterationIndex?: number;
};

/** Another run's bundle may land (skip), or this very step sent one already (a replay). */
export type InFlight =
  | { kind: "none" }
  // Behind a public copy: no last block, its hash instead.
  | { kind: "other"; untilBlock: number }
  | { kind: "other"; publicHash: string }
  // landedHash: mined with it; missed: the step decided the miss; publicHash: a public copy went out; else it may still land.
  | {
      kind: "replay";
      nonce: number;
      landedHash?: string;
      missed?: BundleMiss;
      publicHash?: string;
    };

function isStep(run: BundleRun | undefined, step: BundleStep): boolean {
  return (
    run?.executionId === step.executionId &&
    run.node?.id === step.nodeId &&
    run.node.iterationIndex === step.iterationIndex
  );
}

// Pod clocks differ: a row recorded by this run is never this much older than its start.
const CLOCK_SLACK_MS = 60_000;

/** When the run started, less the clock slack; undefined (no floor) when unknown. */
async function runStartFloor(executionId: string): Promise<Date | undefined> {
  const [run] = await db
    .select({ startedAt: workflowExecutions.startedAt })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId));
  return run ? new Date(run.startedAt.getTime() - CLOCK_SLACK_MS) : undefined;
}

/**
 * This step's own bundle, at any age: a confirmed row mined with one of its
 * hashes, the row's current send while pending, a miss the step decided, or
 * (under the lock, with the session nonce known) a row dropped at a nonce
 * already used. A replay (a crash, a retry) must never sign again: the first
 * bundle may have landed. A dropped row whose nonce is still unused signs
 * again at that same nonce. A row another send took over is not this step's.
 */
async function replayOf(options: {
  walletAddress: string;
  chainId: number;
  step: BundleStep;
  sessionNonce?: number;
}): Promise<InFlight | undefined> {
  const floor = await runStartFloor(options.step.executionId);
  const rows = await db
    .select({
      status: pendingTransactions.status,
      nonce: pendingTransactions.nonce,
      txHash: pendingTransactions.txHash,
      executionId: pendingTransactions.executionId,
      lastTargetBlock: pendingTransactions.lastTargetBlock,
      bundleRuns: pendingTransactions.bundleRuns,
    })
    .from(pendingTransactions)
    .where(
      and(
        eq(pendingTransactions.walletAddress, options.walletAddress),
        eq(pendingTransactions.chainId, options.chainId),
        inArray(pendingTransactions.status, [
          "pending",
          "confirmed",
          "dropped",
        ]),
        ne(pendingTransactions.bundleRuns, sql`'[]'::jsonb`),
        sql`${pendingTransactions.bundleRuns} @> ${JSON.stringify([{ executionId: options.step.executionId }])}::jsonb`,
        floor ? gt(pendingTransactions.submittedAt, floor) : undefined
      )
    );
  for (const row of rows) {
    if (row.status === "confirmed") {
      // Two runs signing the same call share a hash: any entry of this step counts.
      const mine = row.bundleRuns.some(
        (run) => run.hashes.includes(row.txHash) && isStep(run, options.step)
      );
      if (mine) {
        return { kind: "replay", nonce: row.nonce, landedHash: row.txHash };
      }
      continue;
    }
    const current = row.bundleRuns.at(-1);
    const isCurrentSend =
      row.lastTargetBlock !== null &&
      current?.executionId === row.executionId &&
      isStep(current, options.step);
    if (!isCurrentSend) {
      continue;
    }
    const copy = livePublicCopy(row);
    if (row.status === "pending") {
      return {
        kind: "replay",
        nonce: row.nonce,
        ...(copy && { publicHash: copy.hash }),
      };
    }
    if (current?.missed) {
      return { kind: "replay", nonce: row.nonce, missed: current.missed };
    }
    // A dropped row whose copy went public: that copy may still be mined.
    if (copy) {
      return { kind: "replay", nonce: row.nonce, publicHash: copy.hash };
    }
    // Dropped: decided under the lock only, where the session nonce is known.
    if (
      options.sessionNonce !== undefined &&
      row.nonce < options.sessionNonce
    ) {
      return { kind: "replay", nonce: row.nonce };
    }
  }
  return;
}

/**
 * Whether this step already sent a bundle (a replay), else whether an earlier
 * bundle of this workflow on this chain may still land: a pending row of
 * another run whose window is open by the nonce manager's rule (latest within
 * BUNDLE_WINDOW_MARGIN_BLOCKS of its last target), or whose public copy is not
 * mined yet (the wallet's mined count not past its nonce), for up to a day.
 * An unreadable read counts as in flight, so a second bundle is never signed blind.
 */
export async function bundleInFlight(options: {
  workflowId: string;
  chainId: number;
  walletAddress: string;
  step: BundleStep;
  readLatestBlock: () => Promise<number>;
  // The wallet's mined transaction count, read once when a public copy row blocks.
  readMinedCount?: () => Promise<number>;
  // The session's next nonce, under the lock: a dropped row below it may have landed.
  sessionNonce?: number;
}): Promise<InFlight> {
  const replay = await replayOf({
    walletAddress: options.walletAddress.toLowerCase(),
    chainId: options.chainId,
    step: options.step,
    sessionNonce: options.sessionNonce,
  });
  if (replay) {
    return replay;
  }
  const now = Date.now();
  const rows: InFlightRow[] = await db
    .select({
      executionId: pendingTransactions.executionId,
      nonce: pendingTransactions.nonce,
      txHash: pendingTransactions.txHash,
      lastTargetBlock: pendingTransactions.lastTargetBlock,
      bundleRuns: pendingTransactions.bundleRuns,
      submittedAt: pendingTransactions.submittedAt,
    })
    .from(pendingTransactions)
    .where(
      and(
        eq(pendingTransactions.workflowId, options.workflowId),
        eq(pendingTransactions.chainId, options.chainId),
        eq(pendingTransactions.status, "pending"),
        isNotNull(pendingTransactions.lastTargetBlock),
        gt(
          pendingTransactions.submittedAt,
          new Date(now - LATE_BUNDLE_CHECK_MS)
        )
      )
    );
  // Another step of the same run waits for its own bundle under the lock instead.
  const others = rows.filter(
    (row) => row.executionId !== options.step.executionId
  );
  const publicHash = await publicCopyBlocking(others, options.readMinedCount);
  if (publicHash) {
    return { kind: "other", publicHash };
  }
  const blocking = others.filter(
    (row) =>
      !livePublicCopy(row) &&
      (row.submittedAt?.getTime() ?? 0) > now - MAX_BUNDLE_WINDOW_MS
  );
  if (blocking.length === 0) {
    return { kind: "none" };
  }
  let latest: number | undefined;
  try {
    latest = await options.readLatestBlock();
  } catch {
    // Unreadable: every blocking row counts as open.
  }
  const open = blocking.filter(
    (row) =>
      latest === undefined ||
      latest <= (row.lastTargetBlock ?? 0) + BUNDLE_WINDOW_MARGIN_BLOCKS
  );
  if (open.length === 0) {
    return { kind: "none" };
  }
  return {
    kind: "other",
    untilBlock:
      Math.max(...open.map((row) => row.lastTargetBlock ?? 0)) +
      BUNDLE_WINDOW_MARGIN_BLOCKS,
  };
}

/** The hash of a public copy whose nonce the wallet has not mined yet; an unreadable count blocks. */
async function publicCopyBlocking(
  rows: readonly InFlightRow[],
  readMinedCount: (() => Promise<number>) | undefined
): Promise<string | undefined> {
  const copies = rows.flatMap((row) => {
    const copy = livePublicCopy(row);
    return copy ? [{ nonce: row.nonce, hash: copy.hash }] : [];
  });
  if (copies.length === 0) {
    return;
  }
  let mined: number | undefined;
  try {
    mined = await readMinedCount?.();
  } catch {
    // Unreadable: every copy counts as in flight.
  }
  // A mined nonce is not in flight: the next session confirms its row.
  return copies.find((copy) => mined === undefined || copy.nonce >= mined)
    ?.hash;
}
