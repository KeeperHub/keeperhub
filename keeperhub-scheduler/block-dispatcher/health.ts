/**
 * Aggregation behind `/health`, kept pure so the policy can be tested without
 * booting the dispatcher.
 */

export type MonitorLiveness = { alive: boolean };

export type HealthStatus = "ok" | "degraded" | "down";

/**
 * A stalled upstream on one chain is not a reason to kill a process still
 * serving the other seventeen.
 *
 * `/health` backs both the liveness and the readiness probe, so requiring every
 * monitor to be alive turned a single dead chain into a SIGKILL *and* an
 * endpoint removal that stopped Alloy scraping /metrics. Neither restores an
 * upstream: the restart drops the healthy subscriptions too and hands
 * leadership to a peer that inherits the same condition, which is how one stuck
 * chain became a crash loop across both replicas.
 *
 * Partial failure is therefore reported as degraded-but-serving. It stays
 * visible without kubelet intervening: the reconciler already recreates a dead
 * monitor (MONITOR_RECREATE_TIMEOUT_MS) and per-chain aliveness is exported as
 * keeperhub_block_dispatcher_is_alive. Only a total outage - monitors running,
 * none of them alive - is worth a restart.
 */
export function buildHealthStatus(monitors: readonly MonitorLiveness[]): {
  healthy: boolean;
  status: HealthStatus;
} {
  const alive = monitors.filter((m) => m.alive).length;
  if (monitors.length === 0 || alive === monitors.length) {
    return { healthy: true, status: "ok" };
  }
  if (alive > 0) {
    return { healthy: true, status: "degraded" };
  }
  return { healthy: false, status: "down" };
}
