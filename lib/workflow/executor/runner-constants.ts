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
