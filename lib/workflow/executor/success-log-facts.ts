import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { logOutputField } from "@/lib/db/execution-log-fields";
import {
  type TransactionHashEntry,
  workflowExecutionLogs,
} from "@/lib/db/schema";
import {
  mergeSignals,
  NO_RUN_OUTCOME_SIGNALS,
  otherWorkSql,
  type RunOutcomeSignals,
  runOutcomeLogSql,
  runOutcomeSignalSql,
  signalsOfStep,
} from "./run-outcome";
import { isPublicPendingStep } from "./run-outcome-keys";
import { isRecordableTransactionHash } from "./step-success-tracker";

/**
 * Cross-pod fallback for TransactionHashEntry reconstruction.
 *
 * The in-memory tracker in step-success-tracker.ts is local to the Node
 * process that ran each step. When the SDK resumes a workflow on a different
 * pod, the tracker on the finalizing pod is empty. Reconstruct entries from
 * the durable workflow_execution_logs rows so success terminations can still
 * persist the full list.
 *
 * Ordered by started_at ASC so the array matches submission order even when
 * an SDK fan-out completes out of submit order. Deduped by hash string so SDK
 * retries that re-broadcast (same logical step, two distinct hashes) keep the
 * first-seen entry. nodeId-keyed dedupe would incorrectly collapse legitimate
 * For-Each iterations that share a nodeId.
 *
 * Optional fields are omitted from the entry when not present in output_raw
 * (or, for iterationIndex, when the log row is for a non-loop node), matching
 * the in-process harvester's shape so consumers see a uniform JSON regardless
 * of which path populated the column.
 *
 * Success rows only: this list feeds the KEEP-966 reconciliation gate, which
 * re-verifies every entry as an expected SUCCESSFUL receipt. A failing run's
 * broadcasts are harvested separately by loadFailureBroadcasts, which must not
 * feed that gate.
 *
 * The transactionHash IS NOT NULL filter is pushed into Postgres so a workflow
 * that runs a non-tx step many times (e.g. a For-Each over hundreds of HTTP
 * calls) does not stream every row back to Node just to discard it in JS.
 * The JS-side type guard below stays as the authoritative check: SQL only
 * confirms the key exists in output_raw, not that the value is shaped like a
 * hash for the chain the step reported. That shape check is shared with the
 * in-memory tracker (isRecordableTransactionHash) so the two reconstructions
 * of the same list cannot drift apart.
 */
type HashLogRow = {
  nodeId: string;
  nodeName: string;
  iterationIndex: number | null;
  outputRaw: unknown;
};

/** Shared so both harvests build identically shaped entries. */
export function toHashEntry(row: HashLogRow): TransactionHashEntry | null {
  const o = row.outputRaw as {
    transactionHash?: unknown;
    chainId?: unknown;
    network?: unknown;
  } | null;
  if (
    o === null ||
    typeof o !== "object" ||
    typeof o.transactionHash !== "string" ||
    !isRecordableTransactionHash(o.transactionHash, o.chainId)
  ) {
    return null;
  }
  return {
    hash: o.transactionHash,
    nodeId: row.nodeId,
    nodeName: row.nodeName,
    ...(typeof o.chainId === "number" && { chainId: o.chainId }),
    ...(typeof o.network === "string" && { network: o.network }),
    ...(row.iterationIndex !== null && {
      iterationIndex: row.iterationIndex,
    }),
  };
}

export type SuccessLogFacts = {
  hashes: TransactionHashEntry[];
  signals: RunOutcomeSignals;
  /** Steps that reported a not-included send or a public copy not mined yet, as stepKey values. */
  notIncludedSteps: string[];
};

/** One step of a run: its node and, inside a loop, its iteration. */
export function stepKey(
  nodeId: string,
  iterationIndex: number | null | undefined
): string {
  return `${nodeId}:${iterationIndex ?? ""}`;
}

/**
 * One scan of a run's success logs: transaction hashes (when asked) and Write
 * Contract run-outcome signals. Throws on a query failure; callers decide.
 */
export async function loadSuccessLogFacts(
  executionId: string,
  withHashes: boolean
): Promise<SuccessLogFacts> {
  const outcomeRows = runOutcomeLogSql(workflowExecutionLogs);
  const rows = await db.query.workflowExecutionLogs.findMany({
    where: and(
      eq(workflowExecutionLogs.executionId, executionId),
      eq(workflowExecutionLogs.status, "success"),
      withHashes
        ? sql`(${workflowExecutionLogs.outputRaw}->>'transactionHash' IS NOT NULL OR ${outcomeRows})`
        : outcomeRows
    ),
    columns: {
      nodeId: true,
      nodeName: true,
      nodeType: true,
      iterationIndex: true,
      outputRaw: true,
    },
    orderBy: [asc(workflowExecutionLogs.startedAt)],
  });

  const seen = new Set<string>();
  const hashes: TransactionHashEntry[] = [];
  const notIncluded = new Set<string>();
  let signals: RunOutcomeSignals = NO_RUN_OUTCOME_SIGNALS;
  for (const row of rows) {
    const step = signalsOfStep(row.nodeType, row.outputRaw);
    signals = mergeSignals(signals, step);
    // A public copy not mined in time can still land late, as a miss can.
    if (step.notIncluded || isPublicPendingStep(row.nodeType, row.outputRaw)) {
      notIncluded.add(stepKey(row.nodeId, row.iterationIndex));
    }
    const entry = withHashes ? toHashEntry(row) : null;
    if (!entry || seen.has(entry.hash)) {
      continue;
    }
    seen.add(entry.hash);
    hashes.push(entry);
  }
  // Other work only matters to a waiting run; any status, as a failed step may have called out.
  if (signals.waiting) {
    const [work] = await db
      .select({
        otherWork: sql<
          boolean | null
        >`bool_or(${otherWorkSql(workflowExecutionLogs)})`,
      })
      .from(workflowExecutionLogs)
      .where(eq(workflowExecutionLogs.executionId, executionId));
    signals = {
      ...signals,
      otherWork: signals.otherWork || work?.otherWork === true,
    };
  }
  return { hashes, signals, notIncludedSteps: [...notIncluded] };
}

export type FinishLogFacts = {
  gasUsedWei: string | null;
  signals: RunOutcomeSignals;
};

/**
 * One aggregate over a run's logs at finalize: run-total gas (the extraction
 * the analytics reads and the backfill use) and the outcome signals of its
 * successful steps. The logs are written by whichever pod ran each step, so
 * the outcome holds across pods and deploys. Throws on a query failure.
 */
export async function loadFinishLogFacts(
  executionId: string
): Promise<FinishLogFacts> {
  const gasUsed = logOutputField("gasUsed");
  const signal = runOutcomeSignalSql(workflowExecutionLogs);
  const succeeded = sql`${workflowExecutionLogs.status} = 'success'`;
  const [row] = await db
    .select({
      gasUsedWei: sql<string | null>`SUM(CAST(${gasUsed} AS NUMERIC))`,
      skippedInFlight: sql<
        boolean | null
      >`bool_or(${succeeded} AND ${signal.skippedInFlight})`,
      skippedPublicCopy: sql<
        boolean | null
      >`bool_or(${succeeded} AND ${signal.skippedPublicCopy})`,
      notIncluded: sql<
        boolean | null
      >`bool_or(${succeeded} AND ${signal.notIncluded})`,
      waiting: sql<boolean | null>`bool_or(${succeeded} AND ${signal.waiting})`,
      bundleSent: sql<
        boolean | null
      >`bool_or(${succeeded} AND ${signal.bundleSent})`,
      // Any status, as in loadSuccessLogFacts.
      otherWork: sql<boolean | null>`bool_or(${signal.otherWork})`,
    })
    .from(workflowExecutionLogs)
    .where(
      and(
        eq(workflowExecutionLogs.executionId, executionId),
        sql`(${gasUsed} IS NOT NULL OR ${runOutcomeLogSql(workflowExecutionLogs)} OR ${signal.otherWork})`
      )
    );
  return {
    gasUsedWei: row?.gasUsedWei ?? null,
    signals: {
      skippedInFlight: row?.skippedInFlight === true,
      ...(row?.skippedPublicCopy === true && { skippedPublicCopy: true }),
      notIncluded: row?.notIncluded === true,
      waiting: row?.waiting === true,
      bundleSent: row?.bundleSent === true,
      otherWork: row?.otherWork === true,
    },
  };
}
