import "server-only";

import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutionLogs, workflowStepClaims } from "@/lib/db/schema";
import { ErrorCategory, logInfo, logSystemWarn, logWarn } from "@/lib/logging";
import { getRedis } from "@/lib/redis";
import { stepClaimKey } from "@/lib/redis-keys";
import { pollForCompletedOutput } from "@/lib/workflow/executor/poll-for-output";

/**
 * Identifies one step within one execution.
 *
 * Steps inside a For Each body are deliberately out of scope. The executor
 * describes an iteration with a single (forEachNodeId, iterationIndex) pair
 * naming the innermost loop, so a node in a nested body carries the same pair
 * under every outer iteration. Claiming on that key would make the second
 * outer iteration reuse the first one's output, which is worse than the
 * duplicate work this module exists to remove. Deduplicating loop bodies
 * needs the executor to carry the full nesting path first.
 */
export type StepClaimScope = {
  executionId: string;
  nodeId: string;
};

/**
 * How long a claim is honoured before another replay may take it over. A pod
 * killed mid-step leaves its claim behind; without a takeover window the step
 * would never run again. Longer than any single step is expected to take.
 */
const STALE_CLAIM_MS = 10 * 60 * 1000;

/** How long a replay that lost the claim waits for the winner's output. */
const WAIT_FOR_WINNER_MS = 30_000;
const WAIT_POLL_INTERVAL_MS = 1000;

/**
 * How long a replay defers before running the step unowned. Tied to the
 * takeover window: until a claim can go stale, a caller that proceeds anyway
 * is running beside a live owner, which is the duplicate being removed. A
 * step still running past this point is duplicated exactly as it is today.
 */
const MAX_TOTAL_WAIT_MS = STALE_CLAIM_MS;

export type StepClaimResult =
  /**
   * Run the step. `owns` distinguishes holding the claim from proceeding
   * without one -- the claim backend was unreachable, or the wait was
   * exhausted. Only a holder may release, or a caller that never had the
   * claim would free the live owner's and let a third replay in.
   */
  | { outcome: "run"; owns: boolean }
  /** Another replay already produced this step's output; reuse it. */
  | { outcome: "reuse"; output: unknown };

/**
 * The claim scope for a step, or undefined when the step must not be claimed.
 *
 * Three kinds of step are deliberately left unguarded:
 *
 * - Anything without an execution and node to scope to.
 * - Steps inside a For Each body, for the reason on StepClaimScope.
 * - Direct executions. `/api/execute/node` dispatches the same step wrappers
 *   with a `_context.executionId` naming a `direct_executions` row, not a
 *   `workflow_executions` one, so the claim's foreign key would reject every
 *   one of them -- a warning per call on a paid API path, in exchange for
 *   nothing, since a direct execution runs a single step once and has no
 *   replays to deduplicate. `workflowId` is what separates them: the workflow
 *   executor sets it on every step context it builds, and the direct routes
 *   never do.
 */
export function stepClaimScope(context: {
  executionId?: string;
  nodeId?: string;
  workflowId?: string;
  forEachNodeId?: string;
  iterationIndex?: number;
}): StepClaimScope | undefined {
  if (!(context.executionId && context.nodeId && context.workflowId)) {
    return;
  }
  if (context.forEachNodeId !== undefined) {
    return;
  }
  return { executionId: context.executionId, nodeId: context.nodeId };
}

function redisKeyFor(scope: StepClaimScope): string {
  return stepClaimKey(scope.executionId, scope.nodeId);
}

/**
 * Whether Redis already knows someone holds this claim.
 *
 * Redis is a negative cache, never the authority. The overwhelming majority
 * of replays arrive long after the step was claimed, and answering those here
 * keeps one database write per step rather than one per replay. A miss, or an
 * unreachable Redis, simply falls through to the authoritative insert.
 */
async function heldAccordingToRedis(scope: StepClaimScope): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    return false;
  }
  try {
    return (await redis.exists(redisKeyFor(scope))) === 1;
  } catch {
    return false;
  }
}

async function rememberClaimInRedis(scope: StepClaimScope): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    return;
  }
  try {
    await redis.set(redisKeyFor(scope), "1", "PX", STALE_CLAIM_MS);
  } catch {
    // The claim still stands in Postgres; this only costs a cache miss.
  }
}

/**
 * Take the claim in Postgres, the single authority for who runs a step.
 *
 * The insert is the race: exactly one caller can hold the primary key. The DO
 * UPDATE clause is what lets a claim abandoned by a dead pod be taken over
 * once it is older than STALE_CLAIM_MS, since a plain DO NOTHING would leave
 * the step unrunnable for the rest of the run.
 */
async function claimInDb(scope: StepClaimScope): Promise<boolean> {
  // One statement, no transaction: the INSERT ... ON CONFLICT is itself the
  // race, and it is atomic alone. Wrapping it only to scope a SET LOCAL
  // statement_timeout would cost four round trips per step for a bound the
  // app pool already applies to every connection (lib/db/index.ts).
  const rows = await db
    .insert(workflowStepClaims)
    .values({ executionId: scope.executionId, nodeId: scope.nodeId })
    .onConflictDoUpdate({
      target: [workflowStepClaims.executionId, workflowStepClaims.nodeId],
      set: { claimedAt: sql`now()` },
      setWhere: sql`${workflowStepClaims.claimedAt} < now() - make_interval(secs => ${STALE_CLAIM_MS / 1000})`,
    })
    .returning({ nodeId: workflowStepClaims.nodeId });

  return rows.length > 0;
}

/**
 * The output the winning replay recorded, if it has finished successfully.
 *
 * Matches only a success row carrying output, newest first, exactly as the
 * sibling readers in get-completed-step-output.step.ts do. A node routinely
 * carries a success row alongside an orphaned error row -- releaseStepClaim
 * on failure produces that very shape -- so an unordered read that accepted
 * either status could hand back a stale failure and send this replay off to
 * run the step next to the winner.
 */
async function findWinnerOutput(
  scope: StepClaimScope
): Promise<{ outputRaw: unknown } | null> {
  const rows = await db
    .select({ outputRaw: workflowExecutionLogs.outputRaw })
    .from(workflowExecutionLogs)
    .where(
      and(
        eq(workflowExecutionLogs.executionId, scope.executionId),
        eq(workflowExecutionLogs.nodeId, scope.nodeId),
        eq(workflowExecutionLogs.status, "success"),
        isNotNull(workflowExecutionLogs.outputRaw),
        // Only ever the node's own top-level row. A node reachable from both
        // a For Each loop handle and its done handle also has iteration
        // rows, and one of those is not this step's output.
        isNull(workflowExecutionLogs.iterationIndex),
        isNull(workflowExecutionLogs.forEachNodeId)
      )
    )
    .orderBy(desc(workflowExecutionLogs.completedAt))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Decide whether this caller runs the step or reuses another replay's output.
 *
 * A replay that loses the claim waits for the winner's success row. On
 * timeout it tries to take the claim over rather than simply proceeding:
 * every loser started its wait at the same moment, so a winner killed
 * mid-step would otherwise release the whole crowd to run the step at once,
 * which is the pile-up this module exists to prevent.
 *
 * Any failure to reach Redis or the database resolves to "run". The claim
 * reduces duplicated work; it must never be the reason a step does not
 * happen at all.
 */
export async function acquireStepClaim(
  scope: StepClaimScope,
  /** Injectable so the wait loop is deterministic under test, matching
   *  pollForCompletedOutput's own seam. */
  waitOptions?: {
    timeoutMs?: number;
    totalWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<StepClaimResult> {
  const roundMs = waitOptions?.timeoutMs ?? WAIT_FOR_WINNER_MS;
  const totalWaitMs = waitOptions?.totalWaitMs ?? MAX_TOTAL_WAIT_MS;
  const deadline = Date.now() + totalWaitMs;

  for (let round = 0; ; round++) {
    let won: boolean;
    try {
      // Skip the authoritative write only on the first pass, where Redis
      // answers the bulk of replays. A later round is a takeover attempt and
      // has to reach the row that carries the staleness check.
      const held = round === 0 && (await heldAccordingToRedis(scope));
      won = held ? false : await claimInDb(scope);
    } catch (error) {
      logSystemWarn(
        ErrorCategory.WORKFLOW_ENGINE,
        "[stepClaim] Claim unavailable, running step unguarded",
        error instanceof Error ? error : new Error(String(error)),
        { execution_id: scope.executionId, node_id: scope.nodeId }
      );
      return { outcome: "run", owns: false };
    }

    if (won) {
      await rememberClaimInRedis(scope);
      return { outcome: "run", owns: true };
    }

    let winner: { outputRaw: unknown } | null;
    try {
      winner = await pollForCompletedOutput(() => findWinnerOutput(scope), {
        timeoutMs: roundMs,
        intervalMs: WAIT_POLL_INTERVAL_MS,
        sleep: waitOptions?.sleep,
      });
    } catch (error) {
      logSystemWarn(
        ErrorCategory.WORKFLOW_ENGINE,
        "[stepClaim] Could not read the winning attempt, running step",
        error instanceof Error ? error : new Error(String(error)),
        { execution_id: scope.executionId, node_id: scope.nodeId }
      );
      return { outcome: "run", owns: false };
    }

    if (winner) {
      logInfo(
        "[stepClaim] Reusing output from the replay that owns this step",
        {
          execution_id: scope.executionId,
          node_id: scope.nodeId,
        }
      );
      return { outcome: "reuse", output: winner.outputRaw };
    }

    if (Date.now() >= deadline) {
      // The owner has had longer than the whole takeover window and still has
      // not recorded a result. Proceeding duplicates the step, which is what
      // happens today anyway; hanging the execution is worse.
      logSystemWarn(
        ErrorCategory.WORKFLOW_ENGINE,
        "[stepClaim] Gave up waiting for the owning replay, running step",
        new Error(`waited ${totalWaitMs}ms`),
        { execution_id: scope.executionId, node_id: scope.nodeId }
      );
      return { outcome: "run", owns: false };
    }
  }
}

/**
 * Give up the claim so a later attempt can run the step. Called when the step
 * failed: holding the claim after a failure would make the failure permanent
 * for the rest of the execution.
 */
export async function releaseStepClaim(scope: StepClaimScope): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(redisKeyFor(scope));
    } catch {
      // Best-effort: the claim goes stale on its own after STALE_CLAIM_MS.
    }
  }

  try {
    await db
      .delete(workflowStepClaims)
      .where(
        and(
          eq(workflowStepClaims.executionId, scope.executionId),
          eq(workflowStepClaims.nodeId, scope.nodeId)
        )
      );
  } catch {
    // Same: the row is taken over once it goes stale.
  }
}

/**
 * Drop every claim an execution took, once it can no longer run steps.
 *
 * A failure here leaves rows behind but breaks nothing: the claims cascade
 * when the execution row is eventually purged, and a stale claim is taken
 * over after STALE_CLAIM_MS anyway. Benign, so it is not raised as a system
 * warning.
 */
export async function clearStepClaims(executionId: string): Promise<void> {
  try {
    // A run is finalized while its pending tasks may still be draining -- the
    // executor's fatal catch reaches here with steps in flight, the same race
    // selfHealWorkflowAfterLateStepCommit exists for. Deleting a live step's
    // claim would let the next replay take it and run beside the owner, so
    // the clear is skipped entirely while any step is still running. Those
    // rows cascade with the execution instead.
    const [stillRunning] = await db
      .select({ nodeId: workflowExecutionLogs.nodeId })
      .from(workflowExecutionLogs)
      .where(
        and(
          eq(workflowExecutionLogs.executionId, executionId),
          eq(workflowExecutionLogs.status, "running")
        )
      )
      .limit(1);
    if (stillRunning) {
      return;
    }
    await db
      .delete(workflowStepClaims)
      .where(eq(workflowStepClaims.executionId, executionId));
  } catch {
    logWarn("[stepClaim] Could not clear claims for a finished execution", {
      execution_id: executionId,
    });
  }
}
