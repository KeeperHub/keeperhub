import type {
  ClaimOutcome,
  WaitForAssignmentOptions,
} from "./warm-pool-client";
import {
  assignmentToRunnerEnv,
  WARM_POOL_ENV,
  type WarmAckDecision,
  type WarmAssignment,
} from "../warm-pool-protocol";

/**
 * Warm pool mode for workflow-runner.ts (see ../warm-pool.ts): the pod was
 * started before any execution existed. Get ready for a run (DB connection
 * open, step modules loaded), wait for the owning executor to hand over
 * exactly one execution, check it against the database, and return the env a
 * per-run Job would have carried. Undefined means exit without running.
 *
 * Dependencies are injected so the whole flow is unit-tested
 * (warm-runner.test.ts) without a database, executor or Kubernetes.
 */

export type WarmRunnerDeps = {
  env: NodeJS.ProcessEnv;
  pingDb: () => Promise<void>;
  preload: () => Promise<{ loaded: number; failed: number }>;
  waitForAssignment: (
    options: WaitForAssignmentOptions
  ) => Promise<ClaimOutcome>;
  /**
   * Whether the execution exists, belongs to the workflow and is waiting to
   * run. The assignment comes over the pod network; the database is the
   * source of truth, as it is for a per-run Job.
   */
  isRunnable: (assignment: WarmAssignment) => Promise<boolean>;
  /**
   * Answer the executor's offer. True only when the pod accepted and the
   * executor confirmed; anything else means another path runs it (or nobody
   * should), so this pod must not.
   */
  acknowledge: (
    assignment: WarmAssignment,
    decision: WarmAckDecision
  ) => Promise<boolean>;
  log: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

// A transient database error is retried within the executor's ack window
// (3 s) before the pod gives the run back.
const RUNNABLE_CHECK_ATTEMPTS = 3;
const RUNNABLE_RETRY_DELAY_MS = 200;

export type PreparedWarmRun = {
  assignment: WarmAssignment;
  env: Record<string, string>;
  /** The per-run time limit, enforced by the runner from the claim. */
  runDeadlineMs: number | undefined;
};

export async function prepareWarmRun(
  deps: WarmRunnerDeps
): Promise<PreparedWarmRun | undefined> {
  const { env, log } = deps;
  const now = deps.now ?? Date.now;
  const claimUrl = env[WARM_POOL_ENV.claimUrl] ?? "";
  const token = env[WARM_POOL_ENV.token] ?? "";
  const maxIdleMs = Number(env[WARM_POOL_ENV.maxIdleMs]);
  const runDeadlineMs = Number(env[WARM_POOL_ENV.runDeadlineMs]);
  // The token only authorizes this one claim, and the executor burns it the
  // moment it answers. Remove it from the env the run's steps can read.
  delete env[WARM_POOL_ENV.token];

  if (!(claimUrl && token && Number.isFinite(maxIdleMs) && maxIdleMs > 0)) {
    log("[Runner] Warm pool env is incomplete, exiting");
    return undefined;
  }

  const bootStartedAt = now();
  try {
    await deps.pingDb();
  } catch {
    // Without a database the run would fail anyway; exiting before claiming
    // lets the pool replace this pod before anything is assigned to it.
    log("[Runner] Warm pod cannot reach the database, exiting");
    return undefined;
  }
  const preload = await deps.preload();
  log(
    `[Runner] Warm pod ready in ${now() - bootStartedAt}ms (step modules loaded=${preload.loaded} failed=${preload.failed}); waiting for an assignment`
  );

  const outcome = await deps.waitForAssignment({
    claimUrl,
    token,
    maxIdleMs,
    // postgres.js closes idle connections after 30s; a query per empty poll
    // keeps one open so the run does not start with a fresh connect.
    onIdle: deps.pingDb,
  });
  if (outcome.kind === "exit") {
    log(`[Runner] Warm pod exiting without a run: ${outcome.reason}`);
    return undefined;
  }

  const { assignment } = outcome;
  const check = await checkRunnable(deps, assignment);
  if (check !== "runnable") {
    // Handing it back makes the executor start a per-run Job right away,
    // instead of the run waiting for the reaper.
    await deps.acknowledge(assignment, "refuse");
    log(
      `[Runner] Warm pod gave execution ${assignment.executionId} back: ${check}`
    );
    return undefined;
  }

  if (!(await deps.acknowledge(assignment, "accept"))) {
    // Too late or unreachable: the executor has started (or will start) a
    // per-run Job for it, so this pod must not run it too.
    log(
      `[Runner] Warm pod did not get confirmation for execution ${assignment.executionId}, exiting without running it`
    );
    return undefined;
  }

  log(`[Runner] Warm pod claimed execution ${assignment.executionId}`);
  return {
    assignment,
    env: assignmentToRunnerEnv(assignment, "warm-pool"),
    runDeadlineMs:
      Number.isFinite(runDeadlineMs) && runDeadlineMs > 0
        ? runDeadlineMs
        : undefined,
  };
}

/**
 * Whether a database row describes a run this warm pod may start: it exists,
 * belongs to the workflow named in the assignment, and is waiting to run
 * (pending for triggered runs, running for runs the executor claimed first).
 */
export function isRunnableRow(
  row: { workflowId: string; status: string } | undefined,
  workflowId: string
): boolean {
  return (
    row?.workflowId === workflowId &&
    (row.status === "pending" || row.status === "running")
  );
}

/**
 * A per-run Job's activeDeadlineSeconds caps the run, because the pod starts
 * with the run. A warm pod started earlier, so its Job deadline also covers
 * the idle wait. Enforce the same per-run limit from the claim instead;
 * onExpire takes the same path as the SIGTERM the kubelet would send. The
 * timer does not keep the process alive on its own.
 */
export function armRunDeadline(
  runDeadlineMs: number,
  onExpire: () => void,
  schedule: (
    callback: () => void,
    ms: number
  ) => { unref?: () => void } = setTimeout
): void {
  const timer = schedule(onExpire, runDeadlineMs);
  timer.unref?.();
}

async function checkRunnable(
  deps: WarmRunnerDeps,
  assignment: WarmAssignment
): Promise<"runnable" | "not a waiting run of this workflow" | "database unavailable"> {
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  for (let attempt = 1; attempt <= RUNNABLE_CHECK_ATTEMPTS; attempt++) {
    try {
      return (await deps.isRunnable(assignment))
        ? "runnable"
        : "not a waiting run of this workflow";
    } catch {
      if (attempt < RUNNABLE_CHECK_ATTEMPTS) {
        await sleep(RUNNABLE_RETRY_DELAY_MS);
      }
    }
  }
  return "database unavailable";
}
