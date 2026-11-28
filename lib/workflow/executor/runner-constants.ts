/**
 * Workflow Runner Constants
 *
 * These constants define the graceful shutdown behavior for the workflow runner.
 * They are designed to work within K8s pod termination lifecycle.
 */

/**
 * K8s default terminationGracePeriodSeconds
 * This is the time K8s waits after sending SIGTERM before sending SIGKILL
 */
export const K8S_GRACE_PERIOD_MS = 30_000;

/**
 * Graceful shutdown timeout for the workflow runner
 * Must be less than K8S_GRACE_PERIOD_MS to allow buffer for final cleanup
 */
export const SHUTDOWN_TIMEOUT_MS = 25_000;

/**
 * Buffer time between our shutdown timeout and K8s grace period
 * This ensures we have time for final cleanup before K8s force-kills
 */
export const SHUTDOWN_BUFFER_MS = K8S_GRACE_PERIOD_MS - SHUTDOWN_TIMEOUT_MS;

/**
 * Epoch ms at which the runner is stopped (a per-run Job's deadline, counted
 * from its creation, or a warm run's from its claim). Set only where a runner
 * has one; a step that holds a wallet for minutes checks it first.
 */
export const RUN_DEADLINE_AT_ENV = "KH_RUN_DEADLINE_AT";

/** The run's deadline, or undefined when this process has none. */
export function runDeadlineAt(
  env: NodeJS.ProcessEnv = process.env
): number | undefined {
  const at = Number(env[RUN_DEADLINE_AT_ENV]);
  return Number.isFinite(at) && at > 0 ? at : undefined;
}
